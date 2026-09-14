/**
 * 模块：chat/index —— 对话 HTTP 路由装配
 * 层级：chat L4（编排）
 * 职责：建 express.Router()，挂 POST /（非流式）与 POST /stream（SSE），把业务编排
 *      （chat/pipeline.js）与 SSE 写出（chat/http.js）接起来，并把
 *      flushPendingExtraction / extractNow 挂到 router 上供 server.js 优雅退出调用。
 * 依赖：express（外部）、crypto、core/logger、chat/pipeline、chat/http、chat/extractor
 * 被依赖：server.js（app.use('/api/chat', chatRoute)；shutdown 里调 flushPendingExtraction）
 * 改动风险：🔴 高 —— 改完要跑 node tests/run.js（期望 42/42 + 9/9）+ 启动冒烟
 * 契约（三条都不能动）：
 *   1) 默认导出必须仍是 Express Router（typeof === 'function' 且 Array.isArray(router.stack)）；
 *   2) router.flushPendingExtraction 与 router.extractNow 必须是 function，语义相同；
 *   3) 流式路径的 onDelta 必须是空函数（只累积不转发）—— 保证违规文本零字节到达前端。
 * 不要做什么：
 *   1) 不要把 onDelta 改成转发 delta 的写法（哪怕只为「首字更快」）—— 会绕过输出后置检查；
 *   2) 不要改端点路径与事件名（/、/stream、meta/delta/replace/error/done）。
 */

const express = require('express');
const crypto = require('crypto');
const { addTurn } = require('../infra/sessions');
const { getConfig } = require('../infra/llm');
const { logCall } = require('../core/logger');
const {
  prepareTurn, generateReply, finalizeTurn, successPayload,
  friendlyMessage, collectMemoryCountSafe, ERROR_FALLBACK
} = require('./pipeline');
const { startSSE, createWriter } = require('./http');
const { flushPendingExtraction } = require('./extractor');
const { parseImage } = require('./image');
const { screenImage } = require('../pipeline/vision');

const router = express.Router();


/**
 * 图片侧安全信号预计算（fail-safe）：任何异常都不影响主流程。
 * 设计：筛查只产出「可升级」的信号，交给 safety.js 的 applyImageFloor 做「就高不就低」；
 * 筛查失败/超时 → 不设置 imageSignals → 含图轮仍由 L1 地板兜住。
 */
async function attachImageSignals(body) {
  try {
    const img = parseImage(body);
    if (!img.ok || !img.image) return;
    const signals = await screenImage({ image: img.image });
    if (signals) body.imageSignals = signals;
  } catch (e) { /* fail-safe：筛查失败不阻断 */ }
}

// ── 非流式接口（兼容保留，前端降级时使用）──────────────────────
router.post('/', async (req, res) => {
  const requestId = crypto.randomUUID();
  const t0 = Date.now();
  let ctx = null;
  try {
    await attachImageSignals(req.body);
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

  await attachImageSignals(req.body);
  const ctx = prepareTurn(req.body);
  if (ctx.error) return res.status(400).json({ ok: false, error: ctx.error });
  ctx.requestId = requestId;

  startSSE(res);

  const controller = new AbortController();
  const { send, finish, streamText, state, onClose } = createWriter(res, controller);
  res.on('close', onClose);

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

    if (state.clientGone) return;

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
    if (state.clientGone || state.finished) return;
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
// 因此 server.js 可以：const chat = require('./chat'); await chat.flushPendingExtraction(id);
router.flushPendingExtraction = flushPendingExtraction;
router.extractNow = flushPendingExtraction; // 别名，语义相同

module.exports = router;
