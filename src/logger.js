const fs = require('fs');
const path = require('path');
const { hmacSessionId } = require('./utils');

// 打包成 exe 后，快照目录只读，日志写到 exe 旁边的 logs/
const LOG_DIR = typeof process.pkg !== 'undefined'
  ? path.join(path.dirname(process.execPath), 'logs')
  : process.env.LOG_DIR || path.join(__dirname, '..', 'logs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendLog(entry) {
  try {
    ensureDir(LOG_DIR);
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `calls-${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('日志写入失败（不中断服务）：', e.message);
  }
}

function logCall({ requestId, sessionId, strategy, riskLevel, event, model, inputLength, latencyMs, ok, error, meta }) {
  appendLog({
    ts: new Date().toISOString(),
    requestId,
    sessionIdHash: sessionId ? hmacSessionId(sessionId) : null,
    strategy,
    riskLevel,
    event,
    model: model || process.env.LLM_MODEL,
    inputLength,
    latencyMs,
    ok,
    error: error || null,
    meta: meta || null
  });
}

module.exports = { appendLog, logCall };
