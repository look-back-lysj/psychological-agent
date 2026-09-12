/**
 * 模块：chat/extractor —— 长期记忆抽取调度
 * 层级：chat L4（编排）
 * 职责：把「攒够 3 轮批量抽取」与「会话结束补抽」两条路径收敛到同一个 runExtraction；
 *      维护 extracting 并发保护 Set 与 lastActiveSessionId，避免重复抽取、阻塞回复。
 * 依赖：infra/memory、infra/sessions、infra/llm（经 runExtraction 的 callModel 注入）、
 *      chat/retry（noteActiveSession 用于会话切换兜底，本身不调用）
 * 被依赖：chat/index.js（挂到 router 上）、chat/pipeline.js（排抽取 / 记活跃会话）
 * 改动风险：🔴 高 —— 改完要跑 node tests/run.js（期望 42/42 + 9/9）+ 启动冒烟
 * 契约：flushPendingExtraction(sessionId) 永不 reject，返回 Promise<{ok:boolean, reason:string}>
 *      且必须能通过 require('../chat').flushPendingExtraction 取到（server.js 的优雅退出依赖它）。
 * 不要做什么：
 *   1) 不要把 EXTRACT_EVERY_TURNS 从 3 改成 1 —— 那是明文记录的「省额度」设计决策；
 *   2) 不要在抽取失败时抛错或阻塞本轮回复（失败一律静默）。
 */

const { countPendingTurns, drainPendingTurns } = require('../infra/sessions');
const { callLLM, getConfig } = require('../infra/llm');
const memory = require('../infra/memory');

const NL = String.fromCharCode(10);

const EXTRACT_EVERY_TURNS = 3;   // 每 3 轮批量抽取一次长期记忆（省额度）
const extracting = new Set();    // 正在抽取的会话，避免并发

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
 *    网络请求 —— server.js 的 shutdown 会同步 process.exit(0)。所以这里提供两个可用入口：
 *    ① server.js 在 shutdown 里 await 本函数（需要 server.js 补接线，见报告），或
 *    ② 本模块内建的兜底：noteActiveSession() 在「用户切到另一个会话」时补抽上一个会话。
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

module.exports = {
  EXTRACT_EVERY_TURNS,
  runExtraction,
  extractionBlockReason,
  scheduleMemoryExtraction,
  flushPendingExtraction,
  noteActiveSession
};
