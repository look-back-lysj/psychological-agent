/**
 * 心屿 · 对话主链路
 *
 * 流程：输入 → 前置安全分级(L0—L3) → 策略路由(S0—S6) → 组装提示词(人设+策略+安全+记忆)
 *      → 调用模型 → 后置输出检查 → 返回；全过程写脱敏日志、异步抽取长期记忆。
 */

const express = require('express');
const crypto = require('crypto');
const { sanitizeText } = require('./utils');
const {
  ensureSession, addTurn, getHistory, getState, getRiskHistory,
  pushPendingTurn, countPendingTurns, drainPendingTurns
} = require('./sessions');
const { checkInputSafety, checkOutputSafety } = require('./safety');
const { chooseStrategy, updateSessionState, buildRoute } = require('./strategy');
const { buildSystemPrompt, PROMPT_VERSION } = require('./prompts');
const { PERSONA_VERSION } = require('./persona');
const { callLLM, callLLMStream, getConfig } = require('./llm');
const memory = require('./memory');
const { logCall } = require('./logger');

const router = express.Router();
const FAKE_SESSION_PREFIX = 's_';
const NL = String.fromCharCode(10);

const ERROR_FALLBACK = '我这边刚才没有接上，但你的话我已经听到了。可以点「重试」再来一次；如果想继续，也可以先慢慢说说现在最想聊的那件事。';
const CRISIS_FALLBACK = '我很在意你现在的状态。请先远离身边可能伤害到自己的东西，然后联系一个此刻能陪着你的人；如果情况紧急，请直接联系当地紧急服务。';

const EXTRACT_EVERY_TURNS = 3;   // 每 3 轮批量抽取一次长期记忆（省额度）
const extracting = new Set();    // 正在抽取的会话，避免并发

function collectMemories(text) {
  try {
    const items = memory.retrieveMemories(text, { limit: 6 });
    return items.map(it => it.text);
  } catch (e) {
    return [];
  }
}

/**
 * 「记住……」/「忘掉……」显式指令：直接落库，不需要模型参与。
 */
function handleExplicitMemory(text) {
  try {
    const forgot = memory.handleForget(text);
    if (forgot) return { type: 'forget', result: forgot };
    const remembered = memory.handleExplicitRemember(text);
    if (remembered) return { type: 'remember', item: remembered };
  } catch (e) { /* 忽略 */ }
  return null;
}

/**
 * 后台异步抽取长期记忆（不阻塞回复，失败静默）。
 */
function scheduleMemoryExtraction(sessionId) {
  if (!sessionId) return;
  if (countPendingTurns(sessionId) < EXTRACT_EVERY_TURNS) return;
  if (extracting.has(sessionId)) return;
  let cfg;
  try { cfg = getConfig(); } catch (e) { return; }
  if (!cfg.apiKey) return;
  extracting.add(sessionId);
  const turns = drainPendingTurns(sessionId);
  const convo = turns.map(t => '用户：' + t.user + NL + '心屿：' + t.assistant).join(NL + NL);
  memory.extractFromTurn({
    userText: convo.slice(0, 1500),
    assistantText: '',
    callModel: async (prompt) => {
      const r = await callLLM('你是一个只输出 JSON 的信息抽取器。', [{ role: 'user', text: prompt }], { retries: 0 });
      return r.content;
    }
  }).catch(() => {}).then(() => extracting.delete(sessionId));
}

/**
 * 组装一次请求所需的全部上下文。
 */
function prepareTurn(body) {
  const fullMessage = sanitizeText(body && body.message, { maxLength: 8000 });
  if (!fullMessage) return { error: '消息不能为空。' };

  let sessionId = sanitizeText(body && body.sessionId, { maxLength: 100 });
  if (!sessionId) sessionId = FAKE_SESSION_PREFIX + crypto.randomUUID();
  ensureSession(sessionId);

  const message = fullMessage.slice(0, 2000);
  const riskHistory = getRiskHistory(sessionId);
  const inputSafety = checkInputSafety(fullMessage, { riskHistory });
  const state = getState(sessionId);
  const decision = chooseStrategy(fullMessage, inputSafety, state);
  const route = buildRoute(inputSafety.riskLevel, decision, state);
  const explicit = handleExplicitMemory(fullMessage);

  return { message, fullMessage, sessionId, inputSafety, decision, route, state, explicit };
}

function buildMessages(history) {
  return history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text }));
}

/**
 * 生成一次回复（非流式路径 / 流式路径共用）。
 */
async function generateReply(ctx, { stream, onDelta, signal }) {
  const { message, sessionId, inputSafety, decision, state } = ctx;
  const cfg = getConfig();

  // 危机场景：固定话术，不交给模型自由生成
  if (inputSafety.riskLevel === 'L3') {
    const reply = (inputSafety.meta && inputSafety.meta.reply) || CRISIS_FALLBACK;
    return { reply, usedModel: false, usage: null, blocked: false };
  }

  const memories = collectMemories(message);
  const systemPrompt = buildSystemPrompt({
    strategyKey: decision.key,
    riskLevel: inputSafety.riskLevel,
    memories,
    reason: decision.reason,
    nextHint: decision.nextHint
  });
  const history = buildMessages(getHistory(sessionId));

  let content = '';
  let usage = null;
  if (stream && typeof onDelta === 'function') {
    const r = await callLLMStream(systemPrompt, history, { onDelta, signal });
    content = r.content;
    usage = r.usage;
  } else {
    const r = await callLLM(systemPrompt, history);
    content = r.content;
    usage = r.usage;
  }

  const outputCheck = checkOutputSafety(content);
  if (outputCheck.blocked) {
    return { reply: outputCheck.fallback, usedModel: true, usage, blocked: true, reason: outputCheck.reason };
  }
  return { reply: content, usedModel: true, usage, blocked: false };
}

/**
 * 回复完成后统一收尾：写会话、更新状态、记日志、排抽取。
 */
function finalizeTurn(ctx, result, t0) {
  const { message, sessionId, inputSafety, decision, state, route, explicit } = ctx;
  updateSessionState(state, decision, inputSafety.riskLevel);
  addTurn(sessionId, 'user', message, { riskLevel: inputSafety.riskLevel, strategy: decision.key });
  addTurn(sessionId, 'assistant', result.reply, {
    riskLevel: inputSafety.riskLevel,
    strategy: decision.key,
    blocked: result.blocked
  });
  pushPendingTurn(sessionId, message, result.reply);
  logCall({
    requestId: ctx.requestId,
    sessionId,
    strategy: decision.key,
    riskLevel: inputSafety.riskLevel,
    event: result.blocked ? 'output_blocked' : (inputSafety.riskLevel === 'L3' ? 'crisis_protocol' : 'llm_call'),
    model: getConfig().model,
    inputLength: message.length,
    latencyMs: Date.now() - t0,
    ok: true,
    meta: {
      blocked: !!result.blocked,
      reason: result.reason,
      usage: result.usage,
      route,
      promptVersion: PROMPT_VERSION,
      personaVersion: PERSONA_VERSION,
      memoryUsed: collectMemoryCountSafe(message),
      explicit: explicit ? explicit.type : undefined
    }
  });
  if (inputSafety.riskLevel !== 'L3') scheduleMemoryExtraction(sessionId);
}

function collectMemoryCountSafe(text) {
  try { return memory.retrieveMemories(text, { limit: 6 }).length; } catch (e) { return 0; }
}

function successPayload(ctx, result) {
  return {
    reply: result.reply,
    strategy: ctx.decision.key,
    strategyLabel: ctx.decision.label,
    riskLevel: ctx.inputSafety.riskLevel,
    route: ctx.route,
    sessionId: ctx.sessionId,
    requestId: ctx.requestId,
    blocked: !!result.blocked,
    memory: ctx.explicit ? { action: ctx.explicit.type, item: (ctx.explicit.item && ctx.explicit.item.text) || null } : null
  };
}

function friendlyMessage(e) {
  const code = e && e.code;
  if (code === 'model_not_configured') return '还没有配置 API Key，请在「设置」里填写 DeepSeek API Key。';
  if (code === 'model_auth') return 'API Key 无效或已失效，请在「设置」里重新填写。';
  if (code === 'model_balance') return 'DeepSeek 账户余额不足，请先充值后再试。';
  if (code === 'model_rate_limit') return '请求有点频繁，稍等一会儿再试试。';
  if (code === 'model_timeout') return '模型响应超时了，请稍后重试。';
  if (code === 'model_network') return '网络连接不太顺畅，请检查网络后重试。';
  return '模型调用出了点问题，请稍后重试。';
}

// ── 非流式接口（兼容保留，前端降级时使用）──────────────────────
router.post('/', async (req, res) => {
  const requestId = crypto.randomUUID();
  const t0 = Date.now();
  let ctx = null;
  try {
    ctx = prepareTurn(req.body);
    if (ctx.error) return res.status(400).json({ ok: false, error: ctx.error });
    ctx.requestId = requestId;
    const result = await generateReply(ctx, { stream: false });
    finalizeTurn(ctx, result, t0);
    return res.json({ ok: true, data: successPayload(ctx, result) });
  } catch (e) {
    logCall({
      requestId,
      sessionId: ctx ? ctx.sessionId : '',
      strategy: ctx ? ctx.decision.key : 'unknown',
      riskLevel: ctx ? ctx.inputSafety.riskLevel : 'unknown',
      event: 'error',
      model: getConfig().model,
      inputLength: ctx ? ctx.message.length : 0,
      latencyMs: Date.now() - t0,
      ok: false,
      error: e.message
    });
    return res.status(200).json({
      ok: true,
      data: {
        reply: ERROR_FALLBACK,
        strategy: 'error_fallback',
        strategyLabel: '备用回复',
        riskLevel: 'unknown',
        sessionId: ctx ? ctx.sessionId : (req.body && req.body.sessionId),
        requestId,
        error: friendlyMessage(e)
      }
    });
  }
});

// ── 流式接口（SSE）─────────────────────────────────────────────
router.post('/stream', async (req, res) => {
  const requestId = crypto.randomUUID();
  const t0 = Date.now();

  const ctx = prepareTurn(req.body);
  if (ctx.error) return res.status(400).json({ ok: false, error: ctx.error });
  ctx.requestId = requestId;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  let finished = false;
  let clientGone = false;
  const controller = new AbortController();

  const send = (event, data) => {
    if (finished || clientGone || res.writableEnded) return false;
    try {
      res.write('event: ' + event + NL + 'data: ' + JSON.stringify(data) + NL + NL);
      return true;
    } catch (e) {
      clientGone = true;
      controller.abort();
      return false;
    }
  };

  const finish = (data) => {
    if (!finished && !clientGone) send('done', data);
    finished = true;
    if (!res.writableEnded) { try { res.end(); } catch (e) { /* 忽略 */ } }
  };

  // 只监听 res 的 close：Node 16+ 中 req 的 close 会在请求体读完时就触发
  const onClose = () => {
    if (finished || res.writableEnded) return;
    clientGone = true;
    controller.abort();
  };
  res.on('close', onClose);

  // 安全文案 / 已校验文本的分段下发（长文本用更大分片）
  const streamText = async (text) => {
    const base = Math.max(2, Math.ceil(String(text).length / 120));
    let i = 0;
    while (i < text.length) {
      const size = base + Math.floor(Math.random() * 3);
      if (!send('delta', { text: text.slice(i, i + size) })) return false;
      i += size;
      await new Promise(r => setTimeout(r, 10 + Math.random() * 8));
    }
    return true;
  };

  try {
    send('meta', {
      sessionId: ctx.sessionId,
      requestId,
      strategy: ctx.decision.key,
      strategyLabel: ctx.decision.label,
      riskLevel: ctx.inputSafety.riskLevel,
      route: ctx.route,
      memoryCount: collectMemoryCountSafe(ctx.message)
    });

    // 先完整取回模型输出并做安全检查，确认安全后再流式下发
    const result = await generateReply(ctx, {
      stream: true,
      signal: controller.signal,
      onDelta: async () => { /* 只累积，不转发，避免越界内容闪现 */ }
    });

    if (clientGone) return;

    if (result.blocked) send('replace', { reply: result.reply, blocked: true, reason: result.reason });
    else await streamText(result.reply);

    finalizeTurn(ctx, result, t0);
    return finish({
      reply: result.reply,
      strategy: ctx.decision.key,
      strategyLabel: ctx.decision.label,
      riskLevel: ctx.inputSafety.riskLevel,
      route: ctx.route,
      sessionId: ctx.sessionId,
      blocked: !!result.blocked,
      memory: ctx.explicit ? { action: ctx.explicit.type, item: (ctx.explicit.item && ctx.explicit.item.text) || null } : null
    });
  } catch (e) {
    if (clientGone || finished) return;
    logCall({
      requestId,
      sessionId: ctx.sessionId,
      strategy: ctx.decision.key,
      riskLevel: ctx.inputSafety.riskLevel,
      event: 'error',
      model: getConfig().model,
      inputLength: ctx.message.length,
      latencyMs: Date.now() - t0,
      ok: false,
      error: e.message
    });
    send('error', { message: friendlyMessage(e), code: e.code || 'model_error' });
    await streamText(ERROR_FALLBACK);
    addTurn(ctx.sessionId, 'user', ctx.message, { riskLevel: ctx.inputSafety.riskLevel, strategy: ctx.decision.key });
    addTurn(ctx.sessionId, 'assistant', ERROR_FALLBACK, { riskLevel: ctx.inputSafety.riskLevel, strategy: 'error_fallback' });
    return finish({
      reply: ERROR_FALLBACK,
      strategy: 'error_fallback',
      strategyLabel: '备用回复',
      riskLevel: ctx.inputSafety.riskLevel,
      route: ctx.route,
      sessionId: ctx.sessionId,
      blocked: false,
      error: friendlyMessage(e)
    });
  }
});

module.exports = router;
