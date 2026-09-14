/**
 * 模块：chat/pipeline —— 对话业务编排
 * 层级：chat L4（编排）
 * 职责：把一次请求走完「输入清洗 → 前置安全分级 → 策略路由 → 组装提示词 → 调模型 →
 *      输出后置检查 → 收尾落库」全链路；并负责记忆召回、显式记忆指令、档位判定、
 *      retry 标注、日志与抽取排程。不含任何 HTTP / SSE 细节（那些在 chat/http.js）。
 * 依赖：core/utils、core/logger、domain/persona、domain/innerstate、infra/sessions、
 *      infra/llm、infra/memory、pipeline/prompts、pipeline/agents、chat/retry、
 *      chat/extractor，以及顶层冻结契约 safety / strategy
 * 被依赖：chat/index.js（两个路由处理器调用）、chat/http.js（复用 friendlyMessage 等）
 * 改动风险：🔴 高 —— 改完要跑 node tests/run.js（期望 42/42 + 9/9）+ 启动冒烟
 * 契约：successPayload() 的响应字段名，以及 generateReply() 的返回结构
 *      {reply, usedModel, usage, blocked, agent, memoriesUsed, reason?} 不得改。
 * 不要做什么：
 *   1) 不要为了「更实时」把流式改成边收边发（会让违规文本到达前端）—— 本文件只负责
 *      「先完整取回、再经 checkOutputSafety」，下发节奏由 chat/http.js 的 onDelta 空函数保证；
 *   2) 不要把 L3 危机拦截移到 decideTier 之后 —— 「L3 不走模型」是结构性保证，不是巧合。
 */

const crypto = require('crypto');
const { sanitizeText } = require('../core/utils');
const {
  ensureSession, addTurn, getHistory, getState, getRiskHistory, getInnerState,
  pushPendingTurn
} = require('../infra/sessions');
const { checkInputSafety, checkOutputSafety } = require('../safety');
const { parseImage } = require('./image');
const { chooseStrategy, updateSessionState, buildRoute, updateEngageLadder } = require('../strategy');
const { buildSystemPrompt, PROMPT_VERSION } = require('../pipeline/prompts');
const { PERSONA_VERSION } = require('../domain/persona');
const { callLLM, callLLMStream, getConfig } = require('../infra/llm');
const memory = require('../infra/memory');
const { AGENT_VERSION, appraise, resolveStrategy, localScreen, review, isSafetyIssue, isSafetyDraft,
  decideTier, fallbackPlan, getCachedPlan } = require('../pipeline/agents');
const { describeInnerState, updateInnerState, replyShape } = require('../domain/innerstate');
const { logCall } = require('../core/logger');
const { dedupeRetryTurns } = require('./retry');
const { scheduleMemoryExtraction, noteActiveSession } = require('./extractor');

const FAKE_SESSION_PREFIX = 's_';

const ERROR_FALLBACK = '我这边刚才没有接上，但你的话我已经听到了。可以点「重试」再来一次；如果想继续，也可以先慢慢说说现在最想聊的那件事。';
const CRISIS_FALLBACK = '我很在意你现在的状态。请先远离身边可能伤害到自己的东西，然后联系一个此刻能陪着你的人；如果情况紧急，请直接联系当地紧急服务。';

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
  // 图片 ↔ 危机分级的接入点（2026-09-14 建立）：图片功能尚未落地，此处恒为 false，
  // 一旦接口层透传 body.image / body.imageSignals，分级自动生效（铁律见 safety.js：只升不降）。
  // 图片：白名单 + 大小校验（不通过就回中文错误，不进模型）
  const img = parseImage(body);
  if (!img.ok) return { error: img.error };
  const inputSafety = checkInputSafety(fullMessage, {
    riskHistory,
    hasImage: !!img.image,
    // 视觉安全信号由 HTTP 层预计算（packages/pipeline/vision）后回填；缺失即按「含图 → L1」处理
    imageSignals: (body && body.imageSignals) || null
  });
  const state = getState(sessionId);
  // 先根据这句话推进/退回「开口引导阶梯」，再选策略：
  // 阶梯进行中会固定走 S1_listen，把邀请一轮一轮递下去，而不是撤回邀请。
  updateEngageLadder(state, fullMessage, inputSafety.riskLevel);
  const decision = chooseStrategy(fullMessage, inputSafety, state);
  const route = buildRoute(inputSafety.riskLevel, decision, state);
  const explicit = handleExplicitMemory(fullMessage);

  return {
    message, fullMessage, sessionId, inputSafety, decision, route, state, explicit, retry, retryDedup,
    image: img.image, imageMeta: { mime: img.mime, bytes: img.bytes }
  };
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
    userMessage: message,
    engageLevel: ctx.state ? (ctx.state.engageLevel || 0) : 0
  });
  // 关键：当前这句话还没写进会话（在 finalizeTurn 才落库），必须显式追加，
  // 否则模型看不到用户最新的一条消息。
  const history = buildMessages(getHistory(sessionId));
  history.push(ctx.image
    ? { role: 'user', text: message, image: ctx.image }   // 图片只进本轮请求，不写会话
    : { role: 'user', text: message });

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
    addTurn(sessionId, 'user', message, { riskLevel: inputSafety.riskLevel, strategy: decision.key, hasImage: !!ctx.image });
  }
  addTurn(sessionId, 'assistant', result.reply, {
    riskLevel: inputSafety.riskLevel,
    strategy: decision.key,
    blocked: result.blocked,
    hasImage: !!ctx.image
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


module.exports = {
  ERROR_FALLBACK,
  CRISIS_FALLBACK,
  collectMemories,
  memoryTexts,
  handleExplicitMemory,
  prepareTurn,
  buildMessages,
  decideTierSafe,
  attachRetryMeta,
  generateReply,
  finalizeTurn,
  collectMemoryCountSafe,
  successPayload,
  friendlyMessage
};
