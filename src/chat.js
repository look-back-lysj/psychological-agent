/**
 * 守岸人 · 对话主链路
 *
 * 流程：输入 → 前置安全分级(L0—L3) → 策略路由(S0—S6) → 组装提示词(人设+策略+安全+记忆)
 *      → 调用模型 → 后置输出检查 → 返回；全过程写脱敏日志、异步抽取长期记忆。
 */

const express = require('express');
const crypto = require('crypto');
const { sanitizeText, normalizeText } = require('./utils');
const {
  ensureSession, addTurn, getHistory, getState, getRiskHistory, getInnerState,
  pushPendingTurn, countPendingTurns, drainPendingTurns
} = require('./sessions');
const { checkInputSafety, checkOutputSafety } = require('./safety');
const { chooseStrategy, updateSessionState, buildRoute, updateEngageLadder } = require('./strategy');
const { buildSystemPrompt, PROMPT_VERSION } = require('./prompts');
const { PERSONA_VERSION } = require('./persona');
const { callLLM, callLLMStream, getConfig } = require('./llm');
const memory = require('./memory');
const { AGENT_VERSION, appraise, resolveStrategy, localScreen, review, isSafetyIssue, isSafetyDraft,
  decideTier, fallbackPlan, getCachedPlan } = require('./agents');
const { describeInnerState, updateInnerState, replyShape } = require('./innerstate');
const { logCall } = require('./logger');

const router = express.Router();
const FAKE_SESSION_PREFIX = 's_';
const NL = String.fromCharCode(10);

const ERROR_FALLBACK = '我这边刚才没有接上，但你的话我已经听到了。可以点「重试」再来一次；如果想继续，也可以先慢慢说说现在最想聊的那件事。';
const CRISIS_FALLBACK = '我很在意你现在的状态。请先远离身边可能伤害到自己的东西，然后联系一个此刻能陪着你的人；如果情况紧急，请直接联系当地紧急服务。';

const EXTRACT_EVERY_TURNS = 3;   // 每 3 轮批量抽取一次长期记忆（省额度）
const extracting = new Set();    // 正在抽取的会话，避免并发

/**
 * 召回本轮要用的长期记忆：返回完整条目（保留 text 等字段，便于前端展示「用到了哪条记忆」）。
 * 上限 6 条，顺序即注入顺序；任何异常都返回空数组，绝不影响主链路。
 */
function collectMemories(text) {
  try {
    const items = memory.retrieveMemories(text, { limit: 6 });
    if (!Array.isArray(items)) return [];
    return items.slice(0, 6).filter(it => it && typeof it.text === 'string' && it.text);
  } catch (e) {
    return [];
  }
}

/** 从记忆条目里取出真正要写进提示词的文本（最多 6 条，按注入顺序）。 */
function memoryTexts(items) {
  try {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 6).map(it => String((it && it.text) || '')).filter(Boolean);
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

/** 一次真实的抽取调用（「攒够 3 轮」与「会话结束补抽」两条路径共用，保证语义一致）。 */
function runExtraction(turns) {
  const convo = turns.map(t => '用户：' + t.user + NL + '守岸人：' + t.assistant).join(NL + NL);
  return memory.extractFromTurn({
    userText: convo.slice(0, 1500),
    assistantText: '',
    callModel: async (prompt) => {
      const r = await callLLM('你是一个只输出 JSON 的信息抽取器。', [{ role: 'user', text: prompt }], { retries: 0 });
      return r.content;
    }
  });
}

/** 抽取前置条件：有 pending、没在抽取中、配了 Key。不满足时返回原因字符串（'' = 可以抽）。 */
function extractionBlockReason(sessionId) {
  if (!sessionId) return 'no_session';
  if (extracting.has(sessionId)) return 'in_flight';
  if (countPendingTurns(sessionId) < 1) return 'nothing_pending';
  let cfg;
  try { cfg = getConfig(); } catch (e) { return 'no_config'; }
  if (!cfg.apiKey) return 'no_api_key';
  return '';
}

/**
 * 后台异步抽取长期记忆（不阻塞回复，失败静默）。
 * 频率保持 EXTRACT_EVERY_TURNS = 3：攒够 3 轮才抽（与 Mem0「每对消息」、Zep「带最近 4 条上下文」
 * 相比，这是更省额度的中位选择），本函数不改这个阈值。
 */
function scheduleMemoryExtraction(sessionId) {
  if (!sessionId) return;
  if (countPendingTurns(sessionId) < EXTRACT_EVERY_TURNS) return;
  if (extractionBlockReason(sessionId)) return;
  extracting.add(sessionId);
  const turns = drainPendingTurns(sessionId);
  runExtraction(turns).catch(() => {}).then(() => extracting.delete(sessionId));
}

/**
 * 「会话结束」补抽：把 pending 里还没凑满 3 轮的对话立刻抽一次。
 *
 * 解决的问题：用户只聊了 1—2 轮就离开时，这些轮次会一直挂在 pendingTurns 里（或随进程退出丢失），
 * 永远进不了长期记忆。本函数把阈值从「≥3 轮」放宽为「≥1 轮」，其余与 scheduleMemoryExtraction
 * 完全一致（同一段 runExtraction、同一个 extracting 并发保护、同一个 Key 检查）。
 *
 * @param {string} sessionId
 * @returns {Promise<{ok:boolean, reason:string, count?:number, added?:number}>} 永不 reject。
 *
 * ⚠️ 局限（如实说明）：真正的「进程退出」（Tauri 关闭窗口 → sidecar SIGTERM）来不及等这里发起
 *    网络请求 —— main.js 的 shutdown 会同步 process.exit(0)。所以这里提供两个可用入口：
 *    ① main.js 在 shutdown 里 await 本函数（需要 main.js 补接线，见报告），或
 *    ② chat.js 内建的兜底：noteActiveSession() 在「用户切到另一个会话」时补抽上一个会话。
 */
function flushPendingExtraction(sessionId) {
  try {
    const blocked = extractionBlockReason(sessionId);
    if (blocked) return Promise.resolve({ ok: false, reason: blocked });
    extracting.add(sessionId);
    const turns = drainPendingTurns(sessionId);
    return runExtraction(turns)
      .catch(() => ({ ok: false, reason: 'model_error', added: [] }))
      .then((r) => {
        extracting.delete(sessionId);
        return r && typeof r === 'object' ? r : { ok: false, reason: 'unknown' };
      });
  } catch (e) {
    return Promise.resolve({ ok: false, reason: 'error' });
  }
}

// ── 会话切换兜底：切走时补抽上一个会话 ──────────────────────────
// 前端「切换会话」= 换一个 sessionId 发请求。这里记住上一个活跃会话，换会话时给它补抽一次。
// 单会话用户不受影响（prev === sessionId，不触发）；多会话交错时每切一次只补抽「刚离开的那个」，
// pending 为空 / 正在抽取中都会直接跳过，不会重复抽取，也不阻塞本轮回复。
let lastActiveSessionId = '';
function noteActiveSession(sessionId) {
  try {
    const prev = lastActiveSessionId;
    lastActiveSessionId = sessionId || '';
    if (prev && prev !== sessionId) flushPendingExtraction(prev).catch(() => {});
  } catch (e) { /* 静默，绝不影响对话 */ }
}

/**
 * 「重新生成」去重（只允许改 chat.js：本函数只读使用 sessions 的现有导出）。
 *
 * 前端点「重新生成」会把同一条消息再发一次；若不处理，addTurn(user) 会追加一条
 * 重复的用户消息，多轮上下文被污染。这里在会话内定位「这条用户消息 + 紧随其后的
 * 助手回复」，删掉助手回复并保留用户消息，返回实际行为供 agent.retry_dedup 标注。
 *
 * 防御性约束（宁可少做，也不破坏会话）：
 *   - 找不到对应消息 → 按普通请求处理（返回 ok=false，调用方会正常 addTurn）；
 *   - 命中的用户消息后面还有更多轮次（说明用户在重试很久之前的一条）→ 不动会话，
 *     按普通请求处理，避免误删后续对话；
 *   - 任何异常 → 按普通请求处理，绝不报错。
 *
 * @returns {{ ok: boolean, status: string, removedAssistants: number }}
 */
function dedupeRetryTurns(sessionId, message) {
  try {
    const s = ensureSession(sessionId);
    if (!s || !Array.isArray(s.turns) || !s.turns.length) {
      return { ok: false, status: 'fallback_normal', removedAssistants: 0 };
    }
    const key = normalizeText(message);
    if (!key) return { ok: false, status: 'fallback_normal', removedAssistants: 0 };

    // 从末尾往前找最近一条内容相同的用户消息
    let idx = -1;
    for (let i = s.turns.length - 1; i >= 0; i -= 1) {
      const t = s.turns[i];
      if (t && t.role === 'user' && normalizeText(t.text) === key) { idx = i; break; }
    }
    if (idx === -1) return { ok: false, status: 'fallback_normal', removedAssistants: 0 };

    const tail = s.turns.slice(idx + 1);
    const onlyAssistantTail = tail.length <= 1 && tail.every(t => t && t.role === 'assistant');
    if (!onlyAssistantTail) {
      // 重试的是更早的一轮：不动会话，退回普通请求
      return { ok: false, status: 'fallback_normal', removedAssistants: 0 };
    }

    // 命中末尾这一轮：保留用户消息，移除其后已存在的助手回复
    s.turns = s.turns.slice(0, idx + 1);
    s.updatedAt = Date.now();
    const removedAssistants = tail.length;
    return {
      ok: true,
      status: removedAssistants > 0 ? 'deduped' : 'user_reused',
      removedAssistants
    };
  } catch (e) {
    return { ok: false, status: 'fallback_normal', removedAssistants: 0 };
  }
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
  // 会话结束补抽的兜底：如果这次请求换了一个 sessionId（用户切换了会话），
  // 给上一个会话补抽一次长期记忆（不阻塞本轮回复）。
  noteActiveSession(sessionId);

  // 可选字段 retry=true：前端「重新生成」重发同一条消息时，避免重复写入会话
  const retry = !!(body && body.retry === true);
  const retryDedup = retry ? dedupeRetryTurns(sessionId, fullMessage.slice(0, 2000)) : null;

  const message = fullMessage.slice(0, 2000);
  const riskHistory = getRiskHistory(sessionId);
  const inputSafety = checkInputSafety(fullMessage, { riskHistory });
  const state = getState(sessionId);
  // 先根据这句话推进/退回「开口引导阶梯」，再选策略：
  // 阶梯进行中会固定走 S1_listen，把邀请一轮一轮递下去，而不是撤回邀请。
  updateEngageLadder(state, fullMessage, inputSafety.riskLevel);
  const decision = chooseStrategy(fullMessage, inputSafety, state);
  const route = buildRoute(inputSafety.riskLevel, decision, state);
  const explicit = handleExplicitMemory(fullMessage);

  return { message, fullMessage, sessionId, inputSafety, decision, route, state, explicit, retry, retryDedup };
}

function buildMessages(history) {
  return history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text }));
}

/**
 * 档位判定（安全兜底）：任何异常都退回 standard（现有行为）。
 * 说明：重试请求里会话末尾就是本轮这条用户消息，判定「与上一条是否相同」时必须跳过它，
 * 否则会把「重发同一条」误判成「复述上一条」，从而用 fallbackPlan 顶掉上一次的「观」结果。
 */
function decideTierSafe(ctx) {
  try {
    const history = getHistory(ctx.sessionId);
    const skipTail = !!(ctx.retry && ctx.retryDedup && ctx.retryDedup.ok);
    let lastUserMessage = '';
    for (let i = history.length - 1 - (skipTail ? 1 : 0); i >= 0; i -= 1) {
      if (history[i] && history[i].role === 'user') { lastUserMessage = history[i].text; break; }
    }
    const r = decideTier({
      message: ctx.message,
      riskLevel: ctx.inputSafety.riskLevel,
      lastUserMessage
    });
    if (r && r.tier) return { tier: r.tier, reason: r.reason || '' };
  } catch (e) { /* 落回 standard */ }
  return { tier: 'standard', reason: '档位判定异常，退回标准「观」+「书」两段式' };
}

/** retry 请求的 agent 标注：如实写明实际做了什么（deduped / user_reused / fallback_normal）。 */
function attachRetryMeta(agent, ctx) {
  try {
    if (ctx && ctx.retry) {
      agent.retry_dedup = (ctx.retryDedup && ctx.retryDedup.status) || 'fallback_normal';
      agent.retry_removed_assistants = (ctx.retryDedup && ctx.retryDedup.removedAssistants) || 0;
    }
  } catch (e) { /* 忽略 */ }
  return agent;
}

/**
 * 生成一次回复（非流式路径 / 流式路径共用）。
 */
async function generateReply(ctx, { stream, onDelta, signal }) {
  const { message, sessionId, inputSafety, decision } = ctx;
  const riskLevel = inputSafety.riskLevel;

  // 危机场景：固定话术，不交给模型自由生成（也不走演示话术）。
  // 放在档位判定之前：L3 从根本上进不了 decideTier 之后的任何模型调用分支，
  // 所以「L3 不走模型」是结构性保证，而不是依赖 decideTier 恰好返回什么。
  if (riskLevel === 'L3') {
    const reply = (inputSafety.meta && inputSafety.meta.reply) || CRISIS_FALLBACK;
    return {
      reply,
      usedModel: false,
      usage: null,
      blocked: false,
      memoriesUsed: [],
      agent: attachRetryMeta({
        version: AGENT_VERSION,
        mode: 'crisis_fixed',
        tier: 'crisis',
        tier_reason: 'L3 危机：走规则层固定协议（在档位判定之前拦截），不调用模型'
      }, ctx)
    };
  }

  const tierInfo = decideTierSafe(ctx);

  // 免 Key 演示模式：在「观」等任何模型调用之前拦截，返回本地脚本回复。
  // 仍走完整的输出后置检查；失败一律静默，绝不阻塞回复。
  // 本轮要注入的长期记忆（真正用到哪几条会随回复一起返回给前端）
  const memories = collectMemories(message);
  const memoriesUsed = memories.map(m => (typeof m === 'string' ? m : (m && m.text) || '')).filter(Boolean);
  // 会话级内在状态：心情 / 精力 / 熟悉度 → 转成句长与提问概率等表达约束
  const innerState = getInnerState(sessionId);

  let tier = tierInfo.tier;
  let tierReason = tierInfo.reason;
  let plan = null;
  try {
    if (tier === 'minimal') {
      // 同理心底线：策略仍由规则层 chooseStrategy 决定（resolveStrategy 会保留它），
      // fallbackPlan 只提供「不调用模型」的默认表达形态，不做无脑回复。
      plan = getCachedPlan(sessionId, message, riskLevel);
      if (plan) {
        tierReason = tierReason + '；命中本会话「观」结果缓存，直接复用';
      } else {
        // 没跑「观」就没有「对方要不要被提问」的观察，askQuestion 置为 null（未知）：
        // 避免本地快检把「规则层没信号」误判成「对方不想被问」，进而多跑一次「校」。
        plan = Object.assign(fallbackPlan({}, 'tier_minimal_skip_appraise'), { askQuestion: null });
      }
    } else {
      // 「观」：感知 + 定调（一次短调用；失败自动降级，不阻塞回复）
      plan = await appraise({
        sessionId,
        userText: message,
        recentTurns: getHistory(sessionId).slice(-3),
        strategyKey: decision.key,
        riskLevel,
        memories,
        innerStateHint: describeInnerState(innerState)
      });
    }
  } catch (e) {
    plan = null;
  }
  // 兜底：档位相关逻辑任何一步失败都不能让用户收不到回复
  if (!plan) plan = Object.assign(fallbackPlan({}, 'tier_plan_error_fallback'), { askQuestion: null });

  // 策略裁决：规则层独占 S0/S6，模型只在 S1—S5 之间微调
  const resolved = resolveStrategy(decision.key, plan);
  const strategyKey = resolved.key;

  // 内在状态更新 → 转成表达约束
  updateInnerState(innerState, {
    userEmotion: plan.emotion,
    intensity: plan.intensity,
    userText: message,
    riskLevel
  });
  const shape = replyShape(innerState);

  const systemPrompt = buildSystemPrompt({
    strategyKey,
    riskLevel,
    memories,
    reason: decision.reason,
    nextHint: decision.nextHint,
    plan,
    shape,
    engageLevel: ctx.state ? (ctx.state.engageLevel || 0) : 0
  });
  // 关键：当前这句话还没写进会话（在 finalizeTurn 才落库），必须显式追加，
  // 否则模型看不到用户最新的一条消息。
  const history = buildMessages(getHistory(sessionId));
  history.push({ role: 'user', text: message });

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

  // 「校」的调用条件（v3.2 起收敛为唯一一个）：本地规则 localScreen() 命中。
  // 未命中（issues 为空）→ 这里**不会**调用 review()，本轮只跑「观」+「书」（minimal 档只跑「书」）。
  // 命中时 review() 的职责是「直接重写」，不是输出评审意见。
  const issues = localScreen(content, plan, shape);
  let critic = { triggered: false, issues, revised: false, safety: false };
  if (issues.length) {
    // 安全类命中（亲昵称呼 / 永久承诺等，与 safety.js 的 OUTPUT_BLOCK_PATTERNS 重叠）照常调「校」；
    // 即便「校」降级返回原稿，后面的 checkOutputSafety() 仍会独立拦截 —— 安全兜底不依赖「校」。
    // isSafetyDraft 直接复用 checkOutputSafety 的口径，避免被 localScreen「只报第一个 cliche」掩盖。
    const safety = issues.some(isSafetyIssue) || isSafetyDraft(content);
    const rv = await review({ userText: message, strategyKey, riskLevel }, content);
    critic = {
      triggered: true,
      issues: issues.concat(rv.issues || []),
      revised: false,
      degraded: !!rv.degraded,
      safety
    };
    if (rv.revised) { content = rv.revised; critic.revised = true; }
    // 触发「校」后档位升级为 reviewed（共 3 次调用）
    tier = 'reviewed';
    tierReason = tierReason + '；本地快检命中（' + issues.slice(0, 2).join('、') + '），追加「校」重写';
  }

  const agent = attachRetryMeta({
    version: AGENT_VERSION,
    mode: 'multi_agent',
    tier,
    tier_reason: tierReason,
    plan,
    strategy_from: resolved.from,
    strategy_resolved: strategyKey,
    strategy_changed: resolved.changed,
    shape,
    critic
  }, ctx);

  const outputCheck = checkOutputSafety(content);
  if (outputCheck.blocked) {
    return { reply: outputCheck.fallback, usedModel: true, usage, blocked: true, reason: outputCheck.reason, agent, memoriesUsed };
  }
  return { reply: content, usedModel: true, usage, blocked: false, agent, memoriesUsed };
}

/**
 * 回复完成后统一收尾：写会话、更新状态、记日志、排抽取。
 */
function finalizeTurn(ctx, result, t0) {
  const { message, sessionId, inputSafety, decision, state, route, explicit } = ctx;
  updateSessionState(state, decision, inputSafety.riskLevel);
  if (result.agent && ctx.route) ctx.route.agent = result.agent;
  // retry 命中末尾这一轮时，会话里已存在同一条用户消息，不能再追加（避免上下文重复污染）；
  // 未命中（retryDedup.ok === false）时按普通请求处理，照常追加。
  const reusedUserTurn = !!(ctx.retry && ctx.retryDedup && ctx.retryDedup.ok);
  if (!reusedUserTurn) {
    addTurn(sessionId, 'user', message, { riskLevel: inputSafety.riskLevel, strategy: decision.key });
  }
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
    agent: result.agent || null,
    // 本轮真正注入提示词的记忆文本（最多 6 条，按注入顺序）；无记忆时为空数组
    memoriesUsed: Array.isArray(result.memoriesUsed) ? result.memoriesUsed : [],
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
        // 本轮没有成功注入任何记忆
        memoriesUsed: [],
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
  // SSE 要在写事件之前尽早把响应头刷给客户端：不调用 flushHeaders() 时首字节可能被缓冲，
  // 前端迟迟收不到任何数据，表现为「首字延迟」变长。
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
      agent: result.agent || null,
      // 本轮真正注入提示词的记忆文本（最多 6 条，按注入顺序）
      memoriesUsed: Array.isArray(result.memoriesUsed) ? result.memoriesUsed : [],
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
    // retry 且已复用会话里的用户消息时，不能再追加一条用户消息
    const errorReusedUserTurn = !!(ctx.retry && ctx.retryDedup && ctx.retryDedup.ok);
    if (!errorReusedUserTurn) {
      addTurn(ctx.sessionId, 'user', ctx.message, { riskLevel: ctx.inputSafety.riskLevel, strategy: ctx.decision.key });
    }
    addTurn(ctx.sessionId, 'assistant', ERROR_FALLBACK, { riskLevel: ctx.inputSafety.riskLevel, strategy: 'error_fallback' });
    return finish({
      reply: ERROR_FALLBACK,
      strategy: 'error_fallback',
      strategyLabel: '备用回复',
      riskLevel: ctx.inputSafety.riskLevel,
      route: ctx.route,
      sessionId: ctx.sessionId,
      blocked: false,
      error: friendlyMessage(e),
      memoriesUsed: []
    });
  }
});

// 供外部在「会话结束」时调用：把 pending 里没凑满 3 轮的对话补抽一次。
// 本模块默认导出仍是 Express Router（对外 HTTP 结构不变），函数挂在 Router 上，
// 因此 main.js 可以：const chat = require('./src/chat'); await chat.flushPendingExtraction(id);
router.flushPendingExtraction = flushPendingExtraction;
router.extractNow = flushPendingExtraction; // 别名，语义相同

module.exports = router;
