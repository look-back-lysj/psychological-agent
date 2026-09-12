/**
 * 模块：infra/sessions —— 会话内存 + 本地持久化（防抖落盘）
 * 层级：infra L2（有状态 / 外部 IO）
 * 职责：维护会话轮次、会话状态、风险历史与内在状态；800ms 防抖写 data/sessions.json，退出前可同步 flush。
 * 依赖：core/paths（dataDir）、strategy（createSessionState）、domain/innerstate（createInnerState）
 * 被依赖：server.js、chat/pipeline、chat/retry、chat/index、api/routes
 * 改动风险：🟡 中 —— node --check + node tests/run.js
 * 契约：ensureSession / addTurn / getHistory / getState / getRiskHistory / getInnerState / pushPendingTurn / countPendingTurns / drainPendingTurns / flush / sessions 的导出名
 * 不要做什么：
 *   1) 不要去掉 flush()（server.js 优雅退出依赖它同步落盘，否则最后几轮对话会丢）
 *   2) 不要动 data/sessions.json 的字段名
 */
/**
 * 守岸人 · 会话内存 + 本地持久化（单机）
 *
 * 每个会话保存：最近若干轮对话转写、策略状态机状态、内在状态、风险历史、待抽取缓冲。
 *
 * 持久化到 data/sessions.json（路径由 paths.js 的 dataDir() 解析，打包后自动回退可写目录）：
 *   - 该文件包含对话原文，属敏感数据：仅存本机，用户可在设置里清空（见 clearAllSessions()）；
 *   - 写入前做防抖合并（默认 800ms），同步写临时文件 + rename 原子替换，避免写一半损坏；
 *   - 读取全程 try/catch 静默降级：不存在 / JSON 损坏 / 字段类型不对 → 空状态，绝不阻塞启动；
 *   - 淘汰只作用于本文件，绝不触碰长期记忆 data/memory.json。
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../core/paths');
const { createSessionState } = require('../strategy');
const { createInnerState } = require('../domain/innerstate');

const MAX_TURNS = 8;                       // 送入模型的历史轮数上限（用户轮）
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时未活动即回收
const MAX_SESSIONS = 500;                  // 会话总数上限
const MAX_TRANSCRIPT_TURNS = 200;          // 每个会话内存 / 磁盘保留的转写条数上限
const MAX_PENDING_TURNS = 12;              // 待抽取长期记忆的缓冲上限（与原逻辑一致）
const MAX_RISK_HISTORY = 12;               // 风险历史保留条数（与原逻辑一致）
const SAVE_DEBOUNCE_MS = 800;              // 转写落盘防抖窗口（500ms—2s）
const SESSION_FILE_NAME = 'sessions.json';
const STORE_VERSION = 1;

const sessions = new Map();
let saveTimer = null;

function now() { return Date.now(); }

/**
 * 淘汰过期与超量会话（按 updatedAt 最旧优先）。
 * 返回本次淘汰的会话数（调用方据此决定是否落盘）。
 */
function pruneSessions() {
  let removed = 0;
  const cutoff = now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.updatedAt < cutoff) { sessions.delete(id); removed += 1; }
  }
  if (sessions.size > MAX_SESSIONS) {
    const ordered = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const overflow = sessions.size - MAX_SESSIONS;
    for (let i = 0; i < overflow; i++) { sessions.delete(ordered[i][0]); removed += 1; }
  }
  return removed;
}

function ensureSession(sessionId) {
  if (!sessionId) return null;
  if (pruneSessions() > 0) scheduleFlush();
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
  if (sessions.size > MAX_SESSIONS) pruneSessions(); // 严格保证容量上限，不残留 MAX+1
  scheduleFlush();
  return created;
}

function addTurn(sessionId, role, text, meta = {}) {
  const s = ensureSession(sessionId);
  if (!s) return null;
  const turn = { role, text, ...meta, time: now() };
  s.turns.push(turn);
  if (s.turns.length > MAX_TRANSCRIPT_TURNS) s.turns = s.turns.slice(-MAX_TRANSCRIPT_TURNS);
  s.updatedAt = now();
  if (role === 'user' && meta.riskLevel) {
    s.riskHistory.push(meta.riskLevel);
    if (s.riskHistory.length > MAX_RISK_HISTORY) s.riskHistory = s.riskHistory.slice(-MAX_RISK_HISTORY);
  }
  scheduleFlush();
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
  if (s.pendingTurns.length > MAX_PENDING_TURNS) s.pendingTurns = s.pendingTurns.slice(-MAX_PENDING_TURNS);
  scheduleFlush();
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
  scheduleFlush();
  return out;
}

function getStats() {
  if (pruneSessions() > 0) scheduleFlush();
  return { sessions: sessions.size, maxSessions: MAX_SESSIONS, ttlMs: SESSION_TTL_MS };
}

// ── 本地持久化：data/sessions.json ─────────────────────────────
// 该文件包含对话原文，属敏感数据：仅存本机，用户可在设置里清空（clearAllSessions()）。

/** sessions.json 绝对路径；dataDir() 不可用时返回 null。 */
function sessionFilePath() {
  try {
    return path.join(dataDir(), SESSION_FILE_NAME);
  } catch (e) {
    return null;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 有限正数才接受，否则用 fallback（防御损坏数据里的字符串 / NaN / 负数）。 */
function toTimestamp(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 只保留默认结构里存在的字段，且类型必须一致；不一致就走默认值。 */
function mergeDefaults(defaults, raw) {
  if (!isPlainObject(raw)) return defaults;
  const out = {};
  for (const key of Object.keys(defaults)) {
    const def = defaults[key];
    const val = raw[key];
    if (Array.isArray(def)) out[key] = Array.isArray(val) ? val.slice() : [];
    else if (def === null) out[key] = (val === null || typeof val === 'string') ? val : null;
    else if (isPlainObject(def)) out[key] = mergeDefaults(def, val);
    else if (typeof val === typeof def && (typeof def !== 'number' || Number.isFinite(val))) out[key] = val;
    else out[key] = def;
  }
  return out;
}

/** 一轮转写：role 必须是 user/assistant，text 必须是字符串，time 必须是正数。 */
function normalizeTurn(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.role !== 'user' && raw.role !== 'assistant') return null;
  if (typeof raw.text !== 'string') return null;
  const turn = {};
  for (const key of Object.keys(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    turn[key] = raw[key]; // 复用内存结构，保留 riskLevel / strategy / blocked 等元数据
  }
  turn.role = raw.role;
  turn.text = raw.text;
  turn.time = toTimestamp(raw.time, now());
  return turn;
}

function normalizeRiskHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(x => typeof x === 'string').slice(-MAX_RISK_HISTORY);
}

function normalizePendingTurns(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    if (typeof item.user !== 'string' || typeof item.assistant !== 'string') continue;
    out.push({ user: item.user, assistant: item.assistant, time: toTimestamp(item.time, now()) });
  }
  return out.slice(-MAX_PENDING_TURNS);
}

/** 把任意解析结果规整成安全会话对象；无法规整时返回 null（丢弃该会话）。 */
function normalizeSession(raw) {
  if (!isPlainObject(raw)) return null;
  const createdAt = toTimestamp(raw.createdAt, now());
  const updatedAt = toTimestamp(raw.updatedAt, createdAt);
  const turns = Array.isArray(raw.turns)
    ? raw.turns.map(normalizeTurn).filter(Boolean).slice(-MAX_TRANSCRIPT_TURNS)
    : [];
  const state = mergeDefaults(createSessionState(), raw.state);
  state.strategyHistory = Array.isArray(state.strategyHistory)
    ? state.strategyHistory.filter(x => typeof x === 'string').slice(-MAX_RISK_HISTORY) : [];
  state.riskHistory = Array.isArray(state.riskHistory)
    ? state.riskHistory.filter(x => typeof x === 'string').slice(-MAX_RISK_HISTORY) : [];
  return {
    turns,
    state,
    innerState: mergeDefaults(createInnerState(), raw.innerState),
    riskHistory: normalizeRiskHistory(raw.riskHistory),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    pendingTurns: normalizePendingTurns(raw.pendingTurns),
    createdAt,
    updatedAt
  };
}

/**
 * 启动时读回磁盘。文件缺失 / 无权限 / JSON 损坏 / 结构不对 都静默返回空状态。
 * 兼容两种外层结构：{ version, sessions: {...} } 或直接的 { id: {...} }。
 */
function loadFromDisk() {
  try {
    const file = sessionFilePath();
    if (!file) return;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return; // 不存在 / 无权限
    }
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')); // 容忍 BOM
    if (!isPlainObject(parsed)) return;
    const container = isPlainObject(parsed.sessions) ? parsed.sessions : parsed;
    for (const id of Object.keys(container)) {
      if (!id || id === 'version' || id === 'updatedAt') continue;
      const s = normalizeSession(container[id]);
      if (s) sessions.set(id, s);
    }
    pruneSessions(); // 过期 / 超量的历史记录在加载时就地淘汰
  } catch (e) {
    // 损坏文件不阻塞启动；保留已成功加载的部分
  }
}

/** 序列化成落盘结构（按会话 id 分组 + 版本号）。 */
function serialize() {
  const out = {};
  for (const [id, s] of sessions) {
    out[id] = {
      turns: Array.isArray(s.turns) ? s.turns.slice(-MAX_TRANSCRIPT_TURNS) : [],
      state: s.state,
      innerState: s.innerState,
      riskHistory: Array.isArray(s.riskHistory) ? s.riskHistory.slice(-MAX_RISK_HISTORY) : [],
      summary: typeof s.summary === 'string' ? s.summary : '',
      pendingTurns: Array.isArray(s.pendingTurns) ? s.pendingTurns.slice(-MAX_PENDING_TURNS) : [],
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    };
  }
  return { version: STORE_VERSION, updatedAt: now(), sessions: out };
}

/**
 * 同步原子落盘：先写 sessions.json.tmp，再 rename 覆盖；失败静默。
 * 文件含对话原文，mode 600 限制本机其它用户读取。
 */
function writeNow() {
  try {
    const file = sessionFilePath();
    if (!file) return false;
    const payload = `${JSON.stringify(serialize(), null, 2)}\n`;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* 交给写入失败处理 */ }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 }); // 某些文件系统不允许 rename
    }
    return true;
  } catch (e) {
    return false;
  }
}

/** 防抖调度：窗口内多次变更只落盘一次；定时器 unref，不阻塞进程退出。 */
function scheduleFlush() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, SAVE_DEBOUNCE_MS);
  if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
}

/** 立即落盘（取消待执行的防抖定时器）。测试 / 关停前可显式调用。 */
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return writeNow();
}

/** 清空全部会话：内存 + data/sessions.json（供「设置 → 清空会话」调用）。 */
function clearAllSessions() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  sessions.clear();
  if (!writeNow()) {
    // 写空文件失败时，至少移除旧文件，避免「清空后一重启又复活」
    try {
      const file = sessionFilePath();
      if (file) fs.unlinkSync(file);
    } catch (e) { /* 静默 */ }
  }
  return true;
}

// 进程启动即从磁盘读回（失败静默，不影响服务启动）
loadFromDisk();

module.exports = {
  MAX_TURNS,
  MAX_TRANSCRIPT_TURNS,
  SESSION_TTL_MS,
  SESSION_FILE_NAME,
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
  getStats,
  flush,
  clearAllSessions
};
