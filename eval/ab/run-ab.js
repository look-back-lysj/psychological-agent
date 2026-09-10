#!/usr/bin/env node
/**
 * 心屿 · A/B 对照实验采集脚本（纯 Node，无第三方依赖）
 *
 * 唯一变量：环境变量 XINYU_AGENTS
 *   A 组 XINYU_AGENTS=on  —— 多智能体流水线（观 → 策略裁决 → 书 → 校）
 *   B 组 XINYU_AGENTS=off —— 单模型路径（不跑「观」与「校」）
 * 其余（人设 / 策略层 / 安全层 / 模型与参数 / 用例）全部一致。
 *
 * 用法：
 *   node eval/ab/run-ab.js                     # 真实采集，需要 LLM_API_KEY 等环境变量
 *   node eval/ab/run-ab.js --count 2           # 只跑前 2 条用例
 *   node eval/ab/run-ab.js --mock http://localhost:4010/v1 --count 2
 *                                              # 用本地 OpenAI 兼容 mock 自测流程
 *   node eval/ab/run-ab.js --out-dir _tmp/ab-output --port-a 3411 --port-b 3412
 *
 * 产物（默认写入 _tmp/ab-output/）：
 *   blind-<runId>.json    盲评材料（A/B 已随机左右打乱为「候选一/候选二」）
 *   key-<runId>.json      揭盲映射（评分完成前请勿查看）
 *   metrics-<runId>.json  逐轮客观指标与聚合差值
 *
 * 不会把 API Key 写入任何产物；mock 模式下会在产物里显式标注 mode=mock。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT_DIR = path.join(ROOT, '_tmp', 'ab-output');
const DEFAULT_CASES = path.join(__dirname, 'cases.jsonl');
const DEFAULT_TIMEOUT_MS = 180000;
const AI_CLICHE = ['我完全理解', '一切都会好起来', '加油', '想开点'];

class FatalError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'FatalError';
    this.exitCode = exitCode || 1;
  }
}

// ── 小工具 ──────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function round1(v) { return Math.round(Number(v) * 10) / 10; }
function round2(v) { return Math.round(Number(v) * 100) / 100; }
function round3(v) { return Math.round(Number(v) * 1000) / 1000; }
function meanOf(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function pad2(n) { return String(n).padStart(2, '0'); }

function makeTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function uniqueRunId(outDir) {
  const base = makeTimestamp();
  let id = base;
  let i = 1;
  while (fs.existsSync(path.join(outDir, `blind-${id}.json`)) ||
         fs.existsSync(path.join(outDir, `key-${id}.json`)) ||
         fs.existsSync(path.join(outDir, `metrics-${id}.json`))) {
    i += 1;
    id = `${base}-${i}`;
  }
  return id;
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function tailFile(file, lines) {
  try {
    const arr = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return arr.slice(-(lines || 15)).join('\n');
  } catch (e) {
    return '';
  }
}

function printHelp() {
  console.log([
    '心屿 A/B 对照采集脚本',
    '',
    '用法：node eval/ab/run-ab.js [选项]',
    '',
    '选项：',
    '  --mock <baseUrl>   OpenAI 兼容的本地 mock 地址（自测用，无需真实 Key）',
    '                     例：--mock http://localhost:4010/v1',
    '  --count <N>        只跑前 N 条用例（默认全部 20 条）',
    '  --out-dir <dir>    产物目录（默认 _tmp/ab-output）',
    '  --cases <file>     用例文件（默认 eval/ab/cases.jsonl）',
    '  --port-a <port>    A 组端口（默认自动挑空闲端口）',
    '  --port-b <port>    B 组端口（默认自动挑空闲端口）',
    '  --timeout <ms>     单轮请求超时（默认 180000）',
    '  -h, --help         显示本帮助',
    '',
    '真实采集需要环境变量 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY（也支持项目根目录 .env）。',
    '没有 Key 时脚本会明确报错退出，不会静默产出假数据。',
    '只想验证流程：先启动 node _tmp/mock-llm.js，再运行 --mock。'
  ].join('\n'));
}

// ── 参数解析 ────────────────────────────────────────────────────
function parsePositiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new FatalError(`${flag} 需要是正整数，收到：${raw}`, 2);
  return n;
}

function parseArgs(argv) {
  const opts = {
    mock: null,
    count: null,
    outDir: DEFAULT_OUT_DIR,
    cases: DEFAULT_CASES,
    portA: null,
    portB: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let key = arg;
    let inline = null;
    if (arg.startsWith('--') && arg.includes('=')) {
      key = arg.slice(0, arg.indexOf('='));
      inline = arg.slice(arg.indexOf('=') + 1);
    }
    const takeValue = () => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new FatalError(`${key} 缺少参数值`, 2);
      return argv[i];
    };
    switch (key) {
      case '--mock': opts.mock = takeValue(); break;
      case '--count': opts.count = parsePositiveInt(takeValue(), '--count'); break;
      case '--out-dir': opts.outDir = path.resolve(ROOT, takeValue()); break;
      case '--cases': opts.cases = path.resolve(ROOT, takeValue()); break;
      case '--port-a': opts.portA = parsePositiveInt(takeValue(), '--port-a'); break;
      case '--port-b': opts.portB = parsePositiveInt(takeValue(), '--port-b'); break;
      case '--timeout': opts.timeoutMs = parsePositiveInt(takeValue(), '--timeout'); break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        throw new FatalError(`未知参数：${arg}（用 --help 查看用法）`, 2);
    }
  }
  if (opts.portA && opts.portB && opts.portA === opts.portB) {
    throw new FatalError('A 组与 B 组端口不能相同', 2);
  }
  return opts;
}

// ── 环境与用例 ──────────────────────────────────────────────────
/** 极简 .env 读取（不引第三方依赖）；不打印任何值。 */
function loadDotEnv(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch (e) { /* 没有 .env 很正常 */ }
  return out;
}

function loadCases(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    throw new FatalError(`读不到用例文件：${file}\n${e.message}`);
  }
  const cases = [];
  const seen = new Set();
  raw.split(/\r?\n/).forEach((line, idx) => {
    const text = line.trim();
    if (!text) return;
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new FatalError(`用例文件第 ${idx + 1} 行不是合法 JSON：${e.message}`);
    }
    if (!obj || !obj.id || !Array.isArray(obj.turns) || obj.turns.length < 2) {
      throw new FatalError(`用例文件第 ${idx + 1} 行缺少 id 或 turns（每条至少 2 轮）`);
    }
    if (seen.has(obj.id)) throw new FatalError(`用例 id 重复：${obj.id}`);
    seen.add(obj.id);
    cases.push({
      id: String(obj.id),
      scene: String(obj.scene || '未标注'),
      focus: String(obj.focus || '未标注'),
      turns: obj.turns.map(t => String(t))
    });
  });
  if (!cases.length) throw new FatalError(`用例文件为空：${file}`);
  return cases;
}

function normalizeMockBase(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) throw new FatalError('--mock 需要传入 baseUrl，例：http://localhost:4010/v1', 2);
  let url = null;
  try { url = new URL(value); } catch (e) { throw new FatalError(`--mock 地址不是合法 URL：${raw}`, 2); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FatalError('--mock 地址必须以 http:// 或 https:// 开头', 2);
  }
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/v1';
  }
  return url.toString().replace(/\/+$/, '');
}

// ── HTTP 工具 ───────────────────────────────────────────────────
function getFreePort(exclude) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port === exclude ? getFreePort(exclude).then(resolve, reject) : port));
    });
  });
}

function httpGetJson(port, urlPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      headers: { Accept: 'application/json' }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('返回不是合法 JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 向任意 URL POST JSON（只用于 mock 预检）。 */
function postJsonUrl(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url = null;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error(`URL 不合法：${urlStr}`)); }
    const mod = url.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── 后端实例管理 ────────────────────────────────────────────────
async function preflightMock(baseUrl, timeoutMs) {
  const url = `${baseUrl}/chat/completions`;
  let result = null;
  try {
    result = await postJsonUrl(url, {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      max_tokens: 8
    }, timeoutMs);
  } catch (e) {
    throw new FatalError([
      `无法连接 mock 模型服务：${url}`,
      `原因：${e.message}`,
      '',
      '请先在另一个终端启动仓库里的 mock：',
      '  node _tmp/mock-llm.js',
      '再重试：',
      '  node eval/ab/run-ab.js --mock http://localhost:4010/v1 --count 2'
    ].join('\n'), 2);
  }
  if (result.status !== 200) {
    let detail = String(result.body || '').replace(/\s+/g, ' ').slice(0, 160);
    throw new FatalError([
      `mock 返回了 HTTP ${result.status}：${url}`,
      detail ? `响应片段：${detail}` : '',
      result.status === 404 ? '路径可能缺 /v1，baseUrl 应形如 http://localhost:4010/v1' : ''
    ].filter(Boolean).join('\n'), 2);
  }
  let parsed = null;
  try { parsed = JSON.parse(result.body); } catch (e) { /* 下面统一报错 */ }
  if (!parsed || !Array.isArray(parsed.choices) || !parsed.choices.length) {
    throw new FatalError(`mock 响应不像 OpenAI 兼容格式：${url}`);
  }
}

function startBackend({ group, port, baseUrl, model, apiKey, runDir, timeoutMs, mode }) {
  const dataDir = path.join(runDir, `data-${group.toLowerCase()}`);
  const logDir = path.join(runDir, `logs-${group.toLowerCase()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(runDir, `backend-${group}.log`);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'main.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      NO_BROWSER: '1',
      XINYU_AGENTS: group === 'A' ? 'on' : 'off',
      XINYU_DATA_DIR: dataDir,
      LOG_DIR: logDir,
      LLM_BASE_URL: baseUrl,
      LLM_MODEL: model,
      LLM_API_KEY: apiKey,
      LLM_THINKING: process.env.LLM_THINKING || 'disabled',
      LLM_TEMPERATURE: process.env.LLM_TEMPERATURE || '0.8',
      LLM_MAX_TOKENS: process.env.LLM_MAX_TOKENS || '512',
      LOG_SALT: process.env.LOG_SALT || `xinyu-ab-${crypto.randomBytes(8).toString('hex')}`
    }),
    stdio: ['ignore', fd, fd]
  });
  const backend = { group, port, child, logFile, fd, exited: false, exitCode: null, mode };
  child.on('exit', (code) => { backend.exited = true; backend.exitCode = code; });
  child.on('error', () => { backend.exited = true; });
  runningBackends.push(backend);
  return backend;
}

async function waitForHealth(backend, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backend.exited) {
      throw new FatalError([
        `${backend.group} 组后端进程提前退出（退出码 ${backend.exitCode}）`,
        `启动日志：${backend.logFile}`,
        tailFile(backend.logFile, 12)
      ].filter(Boolean).join('\n'));
    }
    try {
      const health = await httpGetJson(backend.port, '/api/health', 2000);
      if (health && health.ok) return health;
    } catch (e) { /* 继续等 */ }
    await sleep(250);
  }
  throw new FatalError([
    `等待 ${backend.group} 组后端就绪超时（${timeoutMs}ms）`,
    `启动日志：${backend.logFile}`,
    tailFile(backend.logFile, 12)
  ].filter(Boolean).join('\n'));
}

async function stopBackend(backend) {
  if (!backend) return;
  if (!backend.exited && backend.child) {
    try { backend.child.kill('SIGTERM'); } catch (e) { /* 忽略 */ }
    const deadline = Date.now() + 3000;
    while (!backend.exited && Date.now() < deadline) await sleep(100);
    if (!backend.exited) {
      try { backend.child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
      await sleep(300);
    }
  }
  if (backend.fd != null) {
    try { fs.closeSync(backend.fd); } catch (e) { /* 忽略 */ }
    backend.fd = null;
  }
  const at = runningBackends.indexOf(backend);
  if (at !== -1) runningBackends.splice(at, 1);
}

// ── 单轮 SSE 采集 ───────────────────────────────────────────────
function analyzeReply(reply) {
  const text = String(reply || '');
  const compact = text.replace(/\s+/g, '');
  return {
    chars: compact.length,
    questionMarks: (text.match(/[?？]/g) || []).length,
    exclamationMarks: (text.match(/[!！]/g) || []).length,
    ellipsisRuns: (text.match(/…+/g) || []).length,
    aiClicheHits: AI_CLICHE.filter(w => compact.includes(w))
  };
}

function runTurn({ port, sessionId, message, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let firstByteMs = null;
    let firstDeltaMs = null;
    let buffer = '';
    let deltaText = '';
    let metaPayload = null;
    let donePayload = null;
    let replacePayload = null;
    let sseError = null;
    let endMs = null;

    const settle = (transportError) => {
      if (settled) return;
      settled = true;
      const source = donePayload || {};
      const agent = source.agent || null;
      const critic = agent && agent.critic ? agent.critic : null;
      const reply = (donePayload && typeof donePayload.reply === 'string') ? donePayload.reply : deltaText;
      const stats = analyzeReply(reply);
      resolve({
        reply: reply || '',
        latencyMs: Math.max(0, (endMs || Date.now()) - t0),
        firstByteMs: firstByteMs == null ? null : Math.round(firstByteMs),
        firstDeltaMs: firstDeltaMs == null ? null : Math.round(firstDeltaMs),
        strategy: source.strategy || (metaPayload && metaPayload.strategy) || '',
        strategyLabel: source.strategyLabel || (metaPayload && metaPayload.strategyLabel) || '',
        riskLevel: source.riskLevel || (metaPayload && metaPayload.riskLevel) || '',
        blocked: !!(source.blocked || (replacePayload && replacePayload.blocked)),
        replaced: !!replacePayload,
        criticTriggered: !!(critic && critic.triggered),
        criticRevised: !!(critic && critic.revised),
        criticDegraded: !!(critic && critic.degraded),
        agentMode: agent ? String(agent.mode || '') : '',
        planEmotion: agent && agent.plan ? String(agent.plan.emotion || '') : '',
        planNeed: agent && agent.plan ? String(agent.plan.need || '') : '',
        crisisFixed: !!(agent && agent.mode === 'crisis_fixed'),
        sseError: sseError ? String(sseError.message || sseError.code || '模型调用失败') : null,
        transportError: transportError || null,
        incomplete: !donePayload,
        chars: stats.chars,
        questionMarks: stats.questionMarks,
        exclamationMarks: stats.exclamationMarks,
        ellipsisRuns: stats.ellipsisRuns,
        aiClicheHits: stats.aiClicheHits
      });
    };

    const body = JSON.stringify({ message, sessionId });
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/chat/stream',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'text/event-stream'
      }
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const now = Date.now();
        if (firstByteMs == null) firstByteMs = now - t0;
        buffer += chunk;
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');
          let eventName = 'message';
          const dataLines = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          let payload = null;
          try { payload = JSON.parse(dataLines.join('\n')); } catch (e) { continue; }
          if (eventName === 'meta') metaPayload = payload;
          else if (eventName === 'delta') {
            if (firstDeltaMs == null) firstDeltaMs = Date.now() - t0;
            deltaText += String(payload.text || '');
          } else if (eventName === 'replace') replacePayload = payload;
          else if (eventName === 'error') sseError = payload;
          else if (eventName === 'done') { donePayload = payload; endMs = Date.now(); }
        }
      });
      res.on('end', () => settle(null));
      res.on('aborted', () => settle('连接被中断'));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`单轮请求超时（${timeoutMs}ms）`));
    });
    req.on('error', (e) => settle(e && e.message ? e.message : '请求失败'));
    req.write(body);
    req.end();
  });
}

async function collectCase(backend, testCase, sessionId, timeoutMs) {
  const turns = [];
  for (let i = 0; i < testCase.turns.length; i += 1) {
    const user = testCase.turns[i];
    const result = await runTurn({ port: backend.port, sessionId, message: user, timeoutMs });
    turns.push(Object.assign({ turn: i + 1, user, group: backend.group }, result));
    if (i < testCase.turns.length - 1) await sleep(150); // 轮间留一点真实节奏
  }
  return turns;
}

// ── 产物构建 ────────────────────────────────────────────────────
function buildBlindAndKey(selected, results, runId, mode) {
  const blindCases = [];
  const keyCases = {};
  let turnCount = 0;

  selected.forEach((testCase) => {
    const aTurns = results[testCase.id].A;
    const bTurns = results[testCase.id].B;
    const aIsFirst = crypto.randomInt(2) === 0;
    const candidateOne = aIsFirst ? aTurns.map(t => t.reply) : bTurns.map(t => t.reply);
    const candidateTwo = aIsFirst ? bTurns.map(t => t.reply) : aTurns.map(t => t.reply);
    turnCount += testCase.turns.length;
    blindCases.push({
      id: testCase.id,
      scene: testCase.scene,
      focus: testCase.focus,
      turns: testCase.turns.map((user, i) => ({ index: i + 1, user })),
      candidates: { '候选一': candidateOne, '候选二': candidateTwo }
    });
    keyCases[testCase.id] = {
      '候选一': aIsFirst ? 'A' : 'B',
      '候选二': aIsFirst ? 'B' : 'A'
    };
  });

  const blind = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    mode,
    warning: mode === 'mock'
      ? '本次为 mock 流程自测数据（mode=mock），不是真实模型输出，禁止用于任何结论。'
      : '真实采集数据；请遵守盲评协议，评分前不要查看 key 文件。',
    protocol: {
      candidate_order: '每个用例的左右位置独立随机打乱；候选一 / 候选二 与 A/B 的对应关系见 key 文件。',
      scale: '每条用例每侧五个维度各 1—5 分：共情准确性 / 不评价 / 像不像真人（自然度与节奏）/ 推进性 / 安全边界。',
      raters: '建议 2 位评分者独立完成，至少 1 位非开发者；评分前不被告知分组。',
      turn_count: turnCount,
      case_count: blindCases.length
    },
    cases: blindCases
  };

  const key = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    blind_file: `blind-${runId}.json`,
    warning: '揭盲映射。评分完成前请勿查看；统计请使用 score.js --score <filled.csv>。',
    mapping: keyCases
  };

  return { blind, key };
}

function summarizeTurns(turns) {
  const n = turns.length || 1;
  const metric = (key) => turns.map(t => Number(t[key]) || 0);
  const rate = (fn) => turns.filter(fn).length / n;
  return {
    turn_count: turns.length,
    avg_latency_ms: round1(meanOf(metric('latencyMs'))),
    avg_first_byte_ms: round1(meanOf(metric('firstByteMs'))),
    avg_first_delta_ms: round1(meanOf(metric('firstDeltaMs'))),
    avg_chars: round1(meanOf(metric('chars'))),
    avg_question_marks: round2(meanOf(metric('questionMarks'))),
    avg_exclamation_marks: round2(meanOf(metric('exclamationMarks'))),
    avg_ellipsis_runs: round2(meanOf(metric('ellipsisRuns'))),
    ai_cliche_turn_rate: round3(rate(t => t.aiClicheHits && t.aiClicheHits.length > 0)),
    critic_trigger_rate: round3(rate(t => t.criticTriggered)),
    critic_actual_rate: round3(rate(t => t.criticTriggered && !t.criticDegraded)),
    critic_revised_rate: round3(rate(t => t.criticRevised)),
    blocked_rate: round3(rate(t => t.blocked)),
    crisis_protocol_turns: turns.filter(t => t.riskLevel === 'L3').length,
    transport_error_turns: turns.filter(t => t.transportError).length,
    model_error_turns: turns.filter(t => t.sseError).length
  };
}

function buildMetrics({ selected, results, runId, mode, model, baseUrlHost, ports }) {
  const flatTurns = [];
  const perCase = [];

  selected.forEach((testCase) => {
    const caseEntry = { case_id: testCase.id, scene: testCase.scene, groups: {}, diff: {} };
    ['A', 'B'].forEach((group) => {
      results[testCase.id][group].forEach((t) => {
        flatTurns.push({
          case_id: testCase.id,
          scene: testCase.scene,
          group,
          turn: t.turn,
          user: t.user,
          reply: t.reply,
          latency_ms: t.latencyMs,
          first_byte_ms: t.firstByteMs,
          first_delta_ms: t.firstDeltaMs,
          chars: t.chars,
          question_marks: t.questionMarks,
          exclamation_marks: t.exclamationMarks,
          ellipsis_runs: t.ellipsisRuns,
          ai_cliche_hits: t.aiClicheHits,
          critic_triggered: t.criticTriggered,
          critic_revised: t.criticRevised,
          critic_degraded: t.criticDegraded,
          blocked: t.blocked,
          replaced: t.replaced,
          risk_level: t.riskLevel,
          strategy: t.strategy,
          agent_mode: t.agentMode,
          plan_emotion: t.planEmotion,
          crisis_fixed: t.crisisFixed,
          sse_error: t.sseError,
          transport_error: t.transportError,
          incomplete: t.incomplete
        });
      });
      caseEntry.groups[group] = summarizeTurns(results[testCase.id][group]);
    });
    caseEntry.diff.avg_chars = round1(caseEntry.groups.A.avg_chars - caseEntry.groups.B.avg_chars);
    caseEntry.diff.avg_question_marks = round2(caseEntry.groups.A.avg_question_marks - caseEntry.groups.B.avg_question_marks);
    caseEntry.diff.avg_latency_ms = round1(caseEntry.groups.A.avg_latency_ms - caseEntry.groups.B.avg_latency_ms);
    perCase.push(caseEntry);
  });

  const allTurnsA = [];
  const allTurnsB = [];
  selected.forEach((testCase) => {
    allTurnsA.push(...results[testCase.id].A);
    allTurnsB.push(...results[testCase.id].B);
  });
  const groupSummary = { A: summarizeTurns(allTurnsA), B: summarizeTurns(allTurnsB) };
  const diff = {};
  ['avg_chars', 'avg_question_marks', 'avg_exclamation_marks', 'avg_ellipsis_runs',
    'avg_latency_ms', 'avg_first_byte_ms', 'avg_first_delta_ms',
    'ai_cliche_turn_rate', 'critic_trigger_rate', 'critic_actual_rate', 'blocked_rate'].forEach((key) => {
    diff[key] = round3(groupSummary.A[key] - groupSummary.B[key]);
  });

  return {
    run_id: runId,
    generated_at: new Date().toISOString(),
    mode,
    model,
    base_url_host: baseUrlHost,
    agents: { A: 'on', B: 'off' },
    ports,
    definitions: {
      chars: '回复去掉空白后的字符数',
      question_marks: '半角 ? 与全角 ？ 的总数',
      exclamation_marks: '半角 ! 与全角 ！ 的总数',
      ellipsis_runs: '连续省略号算一处（…… 记 1 处）',
      ai_cliche: `命中以下任一即计入：${AI_CLICHE.join(' / ')}`,
      first_byte_ms: '从发起请求到收到 SSE 首个字节（通常是 meta 事件）',
      first_delta_ms: '从发起请求到收到首个 delta 文本块',
      latency_ms: '从发起请求到收到 done 事件',
      critic_triggered: 'done.agent.critic.triggered。注意：XINYU_AGENTS=off 时本地快检若发现问题也会置 true，但 review 直接降级返回（见 critic_degraded），并不会真的调用审校模型。',
      critic_actual_rate: '真正调用了审校模型且未降级的轮次占比（triggered=true 且 critic_degraded=false）',
      blocked: 'done.blocked / replace 事件，即输出被安全层拦截并替换',
      crisis_protocol_turns: 'risk_level=L3 的轮次（固定安全话术，不经过生成）'
    },
    turns: flatTurns,
    per_case: perCase,
    aggregate: {
      groups: groupSummary,
      diff_A_minus_B: diff,
      headline: {
        avg_chars: `A 组平均字数 ${groupSummary.A.avg_chars}，B 组 ${groupSummary.B.avg_chars}，A-B = ${diff.avg_chars}`,
        avg_question_marks: `A 组平均问号 ${groupSummary.A.avg_question_marks}，B 组 ${groupSummary.B.avg_question_marks}，A-B = ${diff.avg_question_marks}`
      }
    }
  };
}

// ── 主流程 ──────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  心屿 A/B 对照采集 · 多智能体 vs 单模型      ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  项目根目录：${ROOT}`);

  const dotenv = loadDotEnv(path.join(ROOT, '.env'));
  const readEnv = (name) => {
    const fromProcess = process.env[name];
    if (fromProcess && String(fromProcess).trim()) return String(fromProcess).trim();
    const fromFile = dotenv[name];
    return fromFile && String(fromFile).trim() ? String(fromFile).trim() : '';
  };

  let mode = 'real';
  let baseUrl = '';
  let model = '';
  let apiKey = '';
  let baseUrlHost = '';

  if (opts.mock) {
    mode = 'mock';
    baseUrl = normalizeMockBase(opts.mock);
    apiKey = 'mock-local-key';
    model = readEnv('LLM_MODEL') || 'mock-model';
    baseUrlHost = new URL(baseUrl).hostname;
    console.log(`  模式：mock 流程自测（不产生真实结论）`);
    console.log(`  mock 地址：${baseUrl}`);
    await preflightMock(baseUrl, Math.min(opts.timeoutMs, 15000));
    console.log('  mock 预检通过 ✓');
  } else {
    apiKey = readEnv('LLM_API_KEY');
    if (!apiKey) {
      throw new FatalError([
        '未检测到 LLM_API_KEY，已停止，不会产出任何假数据。',
        '',
        '真实采集请先设置环境变量（或在项目根目录 .env 中填写）：',
        '  LLM_BASE_URL=https://api.deepseek.com',
        '  LLM_MODEL=deepseek-flash',
        '  LLM_API_KEY=sk-你的密钥',
        '',
        '只想验证流程（不需要真实 Key）：',
        '  终端 1：node _tmp/mock-llm.js',
        '  终端 2：node eval/ab/run-ab.js --mock http://localhost:4010/v1 --count 2'
      ].join('\n'), 2);
    }
    baseUrl = readEnv('LLM_BASE_URL') || 'https://api.deepseek.com';
    model = readEnv('LLM_MODEL') || 'deepseek-flash';
    if (!readEnv('LLM_BASE_URL')) console.log('[提示] 未设置 LLM_BASE_URL，使用默认 https://api.deepseek.com');
    if (!readEnv('LLM_MODEL')) console.log('[提示] 未设置 LLM_MODEL，使用默认 deepseek-flash');
    baseUrlHost = (() => { try { return new URL(baseUrl).hostname; } catch (e) { return 'invalid-url'; } })();
    console.log(`  模式：真实采集（model=${model}，base=${baseUrlHost}）`);
  }

  const allCases = loadCases(opts.cases);
  const selected = opts.count ? allCases.slice(0, opts.count) : allCases;
  if (opts.count && opts.count > allCases.length) {
    console.log(`[提示] --count ${opts.count} 超过用例总数 ${allCases.length}，按 ${allCases.length} 条执行`);
  }
  console.log(`  用例：${selected.length} 条（共 ${selected.reduce((s, c) => s + c.turns.length, 0)} 轮对话），来自 ${opts.cases}`);

  fs.mkdirSync(opts.outDir, { recursive: true });
  const runId = uniqueRunId(opts.outDir);
  const runDir = path.join(opts.outDir, '.runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  let portA = opts.portA || await getFreePort(null);
  let portB = opts.portB || await getFreePort(portA);
  if (portA === portB) portB = await getFreePort(portA);

  const backends = [];
  const backendByGroup = {};
  let fatal = null;

  try {
    console.log('');
    console.log('[2/4] 拉起两个后端实例...');
    backends.push(startBackend({ group: 'A', port: portA, baseUrl, model, apiKey, runDir, timeoutMs: opts.timeoutMs, mode }));
    backends.push(startBackend({ group: 'B', port: portB, baseUrl, model, apiKey, runDir, timeoutMs: opts.timeoutMs, mode }));
    backends.forEach(b => { backendByGroup[b.group] = b; });
    const healthList = await Promise.all(backends.map(b => waitForHealth(b, 30000)));
    backends.forEach((b, i) => {
      const agents = b.group === 'A' ? 'on' : 'off';
      console.log(`   ${b.group} 组 XINYU_AGENTS=${agents} → http://127.0.0.1:${b.port}（健康检查 ok，模型 ${healthList[i].model}）`);
    });
    console.log(`   实例日志：${runDir}`);

    console.log('');
    console.log(`[3/4] 采集 ${selected.length} 条用例（每条用例内随机决定 A/B 先跑）...`);
    const results = {};
    let transportErrors = 0;
    let modelErrors = 0;

    for (let i = 0; i < selected.length; i += 1) {
      const testCase = selected[i];
      results[testCase.id] = {};
      const order = crypto.randomInt(2) === 0 ? ['A', 'B'] : ['B', 'A'];
      for (const group of order) {
        const sessionId = `ab-${runId}-${testCase.id}-${group}`.slice(0, 90);
        results[testCase.id][group] = await collectCase(backendByGroup[group], testCase, sessionId, opts.timeoutMs);
      }
      const a = results[testCase.id].A;
      const b = results[testCase.id].B;
      transportErrors += a.concat(b).filter(t => t.transportError).length;
      modelErrors += a.concat(b).filter(t => t.sseError).length;
      const bad = a.concat(b).some(t => t.transportError || t.incomplete);
      console.log(`   ${bad ? '!' : '✓'} [${i + 1}/${selected.length}] ${testCase.id} ${testCase.scene} · A ${a.length} 轮 / B ${b.length} 轮${bad ? '（有中断，已记录在 metrics）' : ''}`);
      if (i < selected.length - 1) await sleep(120);
    }

    console.log('');
    console.log('[4/4] 生成盲评材料与客观指标...');
    const { blind, key } = buildBlindAndKey(selected, results, runId, mode);
    const metrics = buildMetrics({ selected, results, runId, mode, model, baseUrlHost, ports: { A: portA, B: portB } });

    const blindFile = path.join(opts.outDir, `blind-${runId}.json`);
    const keyFile = path.join(opts.outDir, `key-${runId}.json`);
    const metricsFile = path.join(opts.outDir, `metrics-${runId}.json`);
    writeJson(blindFile, blind);
    writeJson(keyFile, key);
    writeJson(metricsFile, metrics);

    const agg = metrics.aggregate;
    console.log('');
    console.log('  产物已写出：');
    console.log(`   盲评材料：${blindFile}`);
    console.log(`   揭盲映射：${keyFile}   ← 评分完成前请勿查看`);
    console.log(`   客观指标：${metricsFile}`);
    console.log('');
    console.log('  客观指标速览（A=多智能体，B=单模型）：');
    console.log(`   平均字数：A ${agg.groups.A.avg_chars} / B ${agg.groups.B.avg_chars}（A-B = ${agg.diff_A_minus_B.avg_chars}）`);
    console.log(`   平均问号：A ${agg.groups.A.avg_question_marks} / B ${agg.groups.B.avg_question_marks}（A-B = ${agg.diff_A_minus_B.avg_question_marks}）`);
    console.log(`   平均感叹号：A ${agg.groups.A.avg_exclamation_marks} / B ${agg.groups.B.avg_exclamation_marks}`);
    console.log(`   平均省略号处数：A ${agg.groups.A.avg_ellipsis_runs} / B ${agg.groups.B.avg_ellipsis_runs}`);
    console.log(`   AI 腔轮次占比：A ${(agg.groups.A.ai_cliche_turn_rate * 100).toFixed(1)}% / B ${(agg.groups.B.ai_cliche_turn_rate * 100).toFixed(1)}%`);
    console.log(`   平均端到端延迟：A ${agg.groups.A.avg_latency_ms}ms / B ${agg.groups.B.avg_latency_ms}ms（A 组内部多两次「观/校」调用，延迟不作为真人感指标）`);
    console.log(`   安全拦截轮次：A ${(agg.groups.A.blocked_rate * 100).toFixed(1)}% / B ${(agg.groups.B.blocked_rate * 100).toFixed(1)}%；危机协议轮次：A ${agg.groups.A.crisis_protocol_turns} / B ${agg.groups.B.crisis_protocol_turns}`);
    if (mode === 'mock') {
      console.log('');
      console.log('  ⚠ 本次是 mock 自测数据，只能用于验证流程，不能用于任何结论。');
    }
    if (transportErrors || modelErrors) {
      console.log('');
      console.log(`[提示] 采集期间有 ${transportErrors} 轮传输中断、${modelErrors} 轮模型侧报错，明细见 metrics 文件的 transport_error / sse_error 字段。`);
    }

    console.log('');
    console.log('下一步：');
    console.log(`  node eval/ab/score.js --format md --out-dir ${path.relative(ROOT, opts.outDir) || '.'}`);
    console.log(`  node eval/ab/score.js --score <回填后的 CSV> --out-dir ${path.relative(ROOT, opts.outDir) || '.'}`);
    console.log('');

    if (transportErrors > 0) process.exitCode = 1;
  } catch (e) {
    fatal = e;
  } finally {
    await Promise.all(backends.map(stopBackend));
  }

  if (fatal) throw fatal;
}

const runningBackends = [];
process.on('SIGINT', () => {
  runningBackends.forEach(b => { try { b.child.kill('SIGKILL'); } catch (e) { /* 忽略 */ } });
  console.error('\n[中断] 已尝试停止后端实例。');
  process.exit(130);
});

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  console.error('');
  console.error(`[错误] ${message}`);
  const code = err && err.exitCode ? err.exitCode : 1;
  process.exit(code);
});
