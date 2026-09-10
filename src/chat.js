const express = require('express');
const crypto = require('crypto');
const { sanitizeText } = require('./utils');
const { ensureSession, addTurn, getHistory } = require('./sessions');
const { checkInputSafety, checkOutputSafety, SAFE_DIRECT, SAFE_COVERT } = require('./safety');
const { chooseStrategy } = require('./strategy');
const { buildSystemPrompt } = require('./prompts');
const { callLLM, callLLMStream, getConfig } = require('./llm');
const { logCall } = require('./logger');

const router = express.Router();
const FAKE_SESSION_PREFIX = 's_';
const SAFETY_FALLBACK = '我听到你的话了，也很在意你的状态。无论现在是不是紧急情况，我都建议你优先联系身边能陪着你的、可信任的人，并尽快联系学校心理中心或当地紧急服务。';

router.post('/', async (req, res) => {
  const requestId = crypto.randomUUID();
  const t0 = Date.now();
  let sessionId = '';
  try {
    const fullMessage = sanitizeText(req.body && req.body.message, { maxLength: 8000 });
    if (!fullMessage) return res.status(400).json({ ok: false, error: '消息不能为空。' });
    // 安全判定看完整文本，模型上下文只用前 2000 字（避免危机词落在截断之外）
    const message = fullMessage.slice(0, 2000);

    sessionId = sanitizeText(req.body && req.body.sessionId, { maxLength: 100 });
    if (!sessionId) sessionId = FAKE_SESSION_PREFIX + crypto.randomUUID();
    ensureSession(sessionId);

    const inputSafety = checkInputSafety(fullMessage);
    const chosen = chooseStrategy(fullMessage, inputSafety);
    addTurn(sessionId, 'user', message, { riskLevel: inputSafety.riskLevel, strategy: chosen.key });

    if (inputSafety.action === 'static_reply') {
      const reply = inputSafety.meta ? inputSafety.meta.reply : SAFETY_FALLBACK;
      addTurn(sessionId, 'assistant', reply, { riskLevel: inputSafety.riskLevel, strategy: chosen.key });
      logCall({ requestId, sessionId, strategy: chosen.key, riskLevel: inputSafety.riskLevel, event: 'crisis_shortcut', model: getConfig().model, inputLength: message.length, latencyMs: Date.now() - t0, ok: true });
      return res.json({ ok: true, data: { reply, strategy: chosen.key, riskLevel: inputSafety.riskLevel, sessionId, requestId } });
    }

    if (inputSafety.action === 'safe_followup') {
      const reply = inputSafety.meta ? inputSafety.meta.reply : SAFE_COVERT.reply;
      addTurn(sessionId, 'assistant', reply, { riskLevel: inputSafety.riskLevel, strategy: chosen.key });
      logCall({ requestId, sessionId, strategy: chosen.key, riskLevel: inputSafety.riskLevel, event: 'safety_followup', model: getConfig().model, inputLength: message.length, latencyMs: Date.now() - t0, ok: true });
      return res.json({ ok: true, data: { reply, strategy: chosen.key, riskLevel: inputSafety.riskLevel, sessionId, requestId } });
    }

    const history = getHistory(sessionId);
    const systemPrompt = buildSystemPrompt(chosen.key);
    const llmResult = await callLLM(systemPrompt, history);
    const outputCheck = checkOutputSafety(llmResult.content);
    const finalReply = outputCheck.blocked ? outputCheck.fallback : llmResult.content;
    const finalEvent = outputCheck.blocked ? 'output_blocked' : 'llm_call';

    addTurn(sessionId, 'assistant', finalReply, { riskLevel: inputSafety.riskLevel, strategy: chosen.key, blocked: outputCheck.blocked, blockReason: outputCheck.reason });
    logCall({ requestId, sessionId, strategy: chosen.key, riskLevel: inputSafety.riskLevel, event: finalEvent, model: getConfig().model, inputLength: message.length, latencyMs: Date.now() - t0, ok: true, meta: { blocked: outputCheck.blocked || false, reason: outputCheck.blocked ? outputCheck.reason : undefined, usage: llmResult.usage } });

    return res.json({ ok: true, data: { reply: finalReply, strategy: chosen.key, riskLevel: inputSafety.riskLevel, sessionId, requestId } });
  } catch (e) {
    logCall({ requestId, sessionId: sessionId || (req.body && req.body.sessionId) || '', strategy: 'unknown', riskLevel: 'unknown', event: 'error', model: getConfig().model, inputLength: ((req.body && req.body.message) || '').length, latencyMs: Date.now() - t0, ok: false, error: e.message });
    const fallback = '我现在这边出了点问题，但你的话我已经听到了。如果方便，我们可以稍后再聊；如果有更紧急的情况，请优先联系身边可信任的人或学校心理中心。';
    return res.status(200).json({ ok: true, data: { reply: fallback, strategy: 'error_fallback', riskLevel: 'unknown', sessionId: sessionId || (req.body && req.body.sessionId), requestId } });
  }
});

// —— 流式（SSE）聊天接口：复用 / 路由的安全、策略、会话与日志逻辑 ——
function sleepMs(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 把异常转成简短中文原因
function friendlyError(e) {
  const msg = String((e && e.message) || '');
  if (msg.includes('model_not_configured')) return '模型尚未配置，请检查 .env 中的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。';
  const m = msg.match(/model_(\d{3})/);
  if (m) return `模型服务返回 ${m[1]}，请稍后再试。`;
  if (e && e.name === 'AbortError') return '模型响应超时或被中断，请稍后再试。';
  return '模型调用失败，请稍后再试。';
}

router.post('/stream', async (req, res) => {
  const requestId = crypto.randomUUID();
  const t0 = Date.now();
  let sessionId = '';
  let inputSafety = null;
  let chosen = null;

  const fullMessage = sanitizeText(req.body && req.body.message, { maxLength: 8000 });
  if (!fullMessage) return res.status(400).json({ ok: false, error: '消息不能为空。' });
  // 安全判定看完整文本，模型上下文只用前 2000 字（避免危机词落在截断之外）
  const message = fullMessage.slice(0, 2000);

  sessionId = sanitizeText(req.body && req.body.sessionId, { maxLength: 100 });
  if (!sessionId) sessionId = FAKE_SESSION_PREFIX + crypto.randomUUID();
  ensureSession(sessionId);

  // SSE 响应头
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let finished = false;   // done 已发出
  let clientGone = false; // 客户端已断开
  const upstreamController = new AbortController();
  const abortUpstream = () => { try { upstreamController.abort(); } catch (e) { /* 忽略 */ } };

  const send = (event, data) => {
    if (finished || clientGone || res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (e) {
      clientGone = true;
      abortUpstream();
      return false;
    }
  };

  const finish = (data) => {
    if (!finished && !clientGone) send('done', data);
    finished = true;
    if (!res.writableEnded) { try { res.end(); } catch (e) { /* 忽略 */ } }
  };

  const onClose = () => {
    if (finished || res.writableEnded) return;
    clientGone = true;
    abortUpstream();
  };
  // 注意：不要监听 req 的 'close'。Node 16+ 在请求体读完时就会触发它，
  // 会被误判为「客户端断开」，导致响应永不结束。只监听 res 的 'close'。
  res.on('close', onClose);

  // 固定文案按 2~4 字分片、每片间隔约 10~15ms 推送
  const streamFixed = async (text) => {
    // 长文本用更大分片，避免打字动画过久（短文本仍是 2~4 字）
    const baseSize = Math.max(2, Math.ceil(text.length / 120));
    let i = 0;
    while (i < text.length) {
      const size = baseSize + Math.floor(Math.random() * 3);
      const piece = text.slice(i, i + size);
      i += size;
      if (!send('delta', { text: piece })) return false;
      await sleepMs(10 + Math.random() * 5);
    }
    return true;
  };

  try {
    inputSafety = checkInputSafety(fullMessage);
    chosen = chooseStrategy(fullMessage, inputSafety);
    addTurn(sessionId, 'user', message, { riskLevel: inputSafety.riskLevel, strategy: chosen.key });

    send('meta', { sessionId, requestId, strategy: chosen.key, riskLevel: inputSafety.riskLevel });

    if (inputSafety.action === 'static_reply') {
      const reply = inputSafety.meta ? inputSafety.meta.reply : SAFETY_FALLBACK;
      await streamFixed(reply);
      addTurn(sessionId, 'assistant', reply, { riskLevel: inputSafety.riskLevel, strategy: chosen.key });
      logCall({ requestId, sessionId, strategy: chosen.key, riskLevel: inputSafety.riskLevel, event: 'crisis_shortcut', model: getConfig().model, inputLength: message.length, latencyMs: Date.now() - t0, ok: true });
      return finish({ reply, strategy: chosen.key, riskLevel: inputSafety.riskLevel, sessionId, blocked: false });
    }

    if (inputSafety.action === 'safe_followup') {
      const reply = inputSafety.meta ? inputSafety.meta.reply : SAFE_COVERT.reply;
      await streamFixed(reply);
      addTurn(sessionId, 'assistant', reply, { riskLevel: inputSafety.riskLevel, strategy: chosen.key });
      logCall({ requestId, sessionId, strategy: chosen.key, riskLevel: inputSafety.riskLevel, event: 'safety_followup', model: getConfig().model, inputLength: message.length, latencyMs: Date.now() - t0, ok: true });
      return finish({ reply, strategy: chosen.key, riskLevel: inputSafety.riskLevel, sessionId, blocked: false });
    }

    // 普通输入：先完整取回模型输出并做安全检查，确认安全后再以流式方式下发。
    // 安全优先于「边收边发」——这样长拦截模式（如 吃.*片）也无法被拆分绕过、不会闪现。
    const history = getHistory(sessionId);
    const systemPrompt = buildSystemPrompt(chosen.key);
    let acc = '';
    let usage = null;

    const result = await callLLMStream(systemPrompt, history, {
      signal: upstreamController.signal,
      onDelta: async (text) => { acc += text; } // 仅累积，先不转发
    });
    usage = result ? result.usage : null;

    if (clientGone) return; // 客户端已断开，停止写入

    const outputCheck = checkOutputSafety(acc);

    if (outputCheck.blocked) {
      const fallback = outputCheck.fallback || '我们换个方式聊，好吗？';
      send('replace', { reply: fallback, blocked: true, reason: outputCheck.reason });
      addTurn(sessionId, 'assistant', fallback, { riskLevel: inputSafety.riskLevel, strategy: chosen.key, blocked: true, blockReason: outputCheck.reason });
      logCall({ requestId, sessionId, strategy: chosen.key, riskLevel: inputSafety.riskLevel, event: 'output_blocked', model: getConfig().model, inputLength: message.length, latencyMs: Date.now() - t0, ok: true, meta: { blocked: true, reason: outputCheck.reason, usage } });
      return finish({ reply: fallback, strategy: chosen.key, riskLevel: inputSafety.riskLevel, sessionId, blocked: true });
    }

    // 通过安全检查后，再以分段方式流式下发
    await streamFixed(acc);
    addTurn(sessionId, 'assistant', acc, { riskLevel: inputSafety.riskLevel, strategy: chosen.key, blocked: false });
    logCall({ requestId, sessionId, strategy: chosen.key, riskLevel: inputSafety.riskLevel, event: 'llm_call', model: getConfig().model, inputLength: message.length, latencyMs: Date.now() - t0, ok: true, meta: { blocked: false, reason: undefined, usage } });
    return finish({ reply: acc, strategy: chosen.key, riskLevel: inputSafety.riskLevel, sessionId, blocked: false });
  } catch (e) {
    if (clientGone || finished) return;
    const fallback = '我现在这边出了点问题，但你的话我已经听到了。如果方便，我们可以稍后再聊；如果有更紧急的情况，请优先联系身边可信任的人或学校心理中心。';
    logCall({ requestId, sessionId: sessionId || (req.body && req.body.sessionId) || '', strategy: 'unknown', riskLevel: 'unknown', event: 'error', model: getConfig().model, inputLength: ((req.body && req.body.message) || '').length, latencyMs: Date.now() - t0, ok: false, error: e.message });
    send('error', { message: friendlyError(e) });
    await streamFixed(fallback);
    return finish({ reply: fallback, strategy: 'error_fallback', riskLevel: 'unknown', sessionId: sessionId || (req.body && req.body.sessionId), blocked: false });
  }
});

module.exports = router;
