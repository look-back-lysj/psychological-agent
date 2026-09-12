/**
 * 模块：core/logger —— 脱敏调用日志（JSONL）
 * 层级：core L0
 * 职责：把每次调用写成 logs/calls-YYYY-MM-DD.jsonl；sessionId 只写 HMAC 前 12 位，永不写对话原文。
 * 依赖：core/utils（hmacSessionId）、core/paths（logDir）
 * 被依赖：chat/pipeline.js（finalizeTurn）、chat/index.js（两个错误分支）
 * 改动风险：🟢 低 —— node --check + node tests/run.js
 * 契约：logCall / appendLog 的导出名与日志字段集合（ARCHITECTURE §7 有记载）
 * 不要做什么：
 *   1) 绝对不许往日志里加 message / reply 原文
 *   2) 不要改字段名（sessionIdHash、riskLevel、event 等）—— 交付日志与统计依赖它们
 */
const fs = require('fs');
const path = require('path');
const { hmacSessionId } = require('./utils');

// 日志目录：支持 LOG_DIR 覆盖；打包后自动回退到可写目录（见 paths.js）
const { logDir } = require('./paths');
const LOG_DIR = process.env.LOG_DIR || logDir();

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
