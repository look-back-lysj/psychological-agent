/**
 * 心屿 · 会话内存（单机、进程内）
 *
 * 每个会话保存：最近若干轮对话、策略状态机状态、风险历史、抽取计数。
 * 新增 TTL 与容量淘汰，避免长时间运行后内存无界增长。
 */

const { createSessionState } = require('./strategy');
const { createInnerState } = require('./innerstate');

const MAX_TURNS = 8;                       // 送入模型的历史轮数上限（用户轮）
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时未活动即回收
const MAX_SESSIONS = 500;                  // 容量上限
const sessions = new Map();

function now() { return Date.now(); }

/**
 * 淘汰过期与超量会话。
 */
function pruneSessions() {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.updatedAt < cutoff) sessions.delete(id);
  }
  if (sessions.size > MAX_SESSIONS) {
    const ordered = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const overflow = sessions.size - MAX_SESSIONS;
    for (let i = 0; i < overflow; i++) sessions.delete(ordered[i][0]);
  }
}

function ensureSession(sessionId) {
  if (!sessionId) return null;
  pruneSessions();
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created = {
    turns: [],
    state: createSessionState(),
    innerState: createInnerState(),
    riskHistory: [],
    summary: '',
    pendingTurns: [],   // 待抽取长期记忆的对话缓冲
    createdAt: now(),
    updatedAt: now()
  };
  sessions.set(sessionId, created);
  return created;
}

function addTurn(sessionId, role, text, meta = {}) {
  const s = ensureSession(sessionId);
  if (!s) return null;
  const turn = { role, text, ...meta, time: now() };
  s.turns.push(turn);
  if (s.turns.length > MAX_TURNS * 2) s.turns = s.turns.slice(-MAX_TURNS * 2);
  s.updatedAt = now();
  if (role === 'user' && meta.riskLevel) {
    s.riskHistory.push(meta.riskLevel);
    if (s.riskHistory.length > 12) s.riskHistory = s.riskHistory.slice(-12);
  }
  return s;
}

function getHistory(sessionId) {
  const s = ensureSession(sessionId);
  if (!s) return [];
  return s.turns.slice(-MAX_TURNS * 2);
}

function getState(sessionId) {
  const s = ensureSession(sessionId);
  return s ? s.state : createSessionState();
}

function getInnerState(sessionId) {
  const s = ensureSession(sessionId);
  return s ? s.innerState : createInnerState();
}

function getRiskHistory(sessionId) {
  const s = ensureSession(sessionId);
  return s ? s.riskHistory : [];
}

/**
 * 累积待抽取的对话（用于后台批量抽取长期记忆）。
 */
function pushPendingTurn(sessionId, userText, assistantText) {
  const s = ensureSession(sessionId);
  if (!s) return;
  s.pendingTurns.push({ user: userText, assistant: assistantText, time: now() });
  if (s.pendingTurns.length > 12) s.pendingTurns = s.pendingTurns.slice(-12);
}

function countPendingTurns(sessionId) {
  const s = ensureSession(sessionId);
  return s ? s.pendingTurns.length : 0;
}

function drainPendingTurns(sessionId) {
  const s = ensureSession(sessionId);
  if (!s) return [];
  const out = s.pendingTurns.slice();
  s.pendingTurns = [];
  return out;
}

function getStats() {
  pruneSessions();
  return { sessions: sessions.size, maxSessions: MAX_SESSIONS, ttlMs: SESSION_TTL_MS };
}

module.exports = {
  MAX_TURNS,
  SESSION_TTL_MS,
  sessions,
  pruneSessions,
  ensureSession,
  addTurn,
  getHistory,
  getState,
  getInnerState,
  getRiskHistory,
  pushPendingTurn,
  countPendingTurns,
  drainPendingTurns,
  getStats
};
