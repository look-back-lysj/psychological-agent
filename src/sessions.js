const MAX_TURNS = 8;
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

function ensureSession(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created = { turns: [], riskHistory: [], strategyHistory: [], createdAt: Date.now(), updatedAt: Date.now() };
  if (sessionId) sessions.set(sessionId, created);
  return created;
}

function addTurn(sessionId, role, text, meta = {}) {
  const s = ensureSession(sessionId);
  s.turns.push({ role, text, ...meta, time: Date.now() });
  if (s.turns.length > MAX_TURNS * 2) s.turns = s.turns.slice(-MAX_TURNS * 2);
  s.updatedAt = Date.now();
  return s;
}

function getHistory(sessionId) {
  const s = ensureSession(sessionId);
  return s.turns.slice(-MAX_TURNS * 2);
}

module.exports = { ensureSession, addTurn, getHistory, sessions };
