const fs = require('fs');
const path = require('path');

// 配置文件固定为 data/config.json（data/ 已在 .gitignore，绝不入库）
// 打包成 exe 后快照目录只读，与 main.js / logger.js 保持一致，写到 exe 旁边
const isPkg = typeof process.pkg !== 'undefined';
const APP_ROOT = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const CONFIG_DIR = path.join(APP_ROOT, 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// 默认值：DeepSeek 官方（api-docs.deepseek.com，2026-09-10 核实）
const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: '',
  thinking: 'disabled',
  temperature: 0.8,
  maxTokens: 512,
  timeoutMs: 30000
};

// 允许写入本地文件的字段（timeoutMs 不落盘，只认环境变量/默认值）
const WRITABLE_FIELDS = ['apiKey', 'baseUrl', 'model', 'thinking', 'temperature', 'maxTokens'];

// 环境变量名沿用旧约定
const ENV_NAMES = {
  baseUrl: 'LLM_BASE_URL',
  model: 'LLM_MODEL',
  apiKey: 'LLM_API_KEY',
  thinking: 'LLM_THINKING',
  temperature: 'LLM_TEMPERATURE',
  maxTokens: 'LLM_MAX_TOKENS',
  timeoutMs: 'LLM_TIMEOUT_MS'
};

const MAX_KEY_LENGTH = 512;
const MAX_MODEL_LENGTH = 100;
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 600000;

// 数字字段允许「数字」或「可转成数字的字符串」（表单传参常是字符串），其余一律视为非法
function toNumber(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw);
  return NaN;
}

function parseApiKey(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'API Key 必须是字符串。' };
  const value = raw.trim(); // 空字符串表示清除
  if (value.length > MAX_KEY_LENGTH) return { ok: false, message: 'API Key 长度异常，请检查是否粘贴了多余内容。' };
  return { ok: true, value };
}

function parseBaseUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'API 地址必须是字符串。' };
  const value = raw.trim().replace(/\/+$/, ''); // 去掉结尾斜杠，避免拼出 //chat/completions
  if (!value) return { ok: false, message: 'API 地址不能为空。' };
  let url = null;
  try { url = new URL(value); } catch (e) { return { ok: false, message: 'API 地址不是合法的网址。' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'API 地址必须以 http:// 或 https:// 开头。' };
  }
  return { ok: true, value };
}

function parseModel(raw) {
  if (typeof raw !== 'string') return { ok: false, message: '模型名称必须是字符串。' };
  const value = raw.trim();
  if (!value) return { ok: false, message: '模型名称不能为空。' };
  if (value.length > MAX_MODEL_LENGTH) return { ok: false, message: '模型名称过长。' };
  return { ok: true, value };
}

function parseThinking(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : (typeof raw === 'boolean' ? String(raw) : '');
  let normalized = '';
  if (['enabled', 'true', '1', 'on'].includes(value)) normalized = 'enabled';
  else if (['disabled', 'false', '0', 'off'].includes(value)) normalized = 'disabled';
  if (!normalized) return { ok: false, message: 'thinking 只能是 enabled 或 disabled。' };
  return { ok: true, value: normalized };
}

function parseTemperature(raw) {
  const num = toNumber(raw);
  if (!Number.isFinite(num)) return { ok: false, message: 'temperature 必须是 0–2 之间的数字。' };
  if (num < 0 || num > 2) return { ok: false, message: 'temperature 需要在 0–2 之间。' };
  return { ok: true, value: num };
}

function parseMaxTokens(raw) {
  const num = toNumber(raw);
  if (!Number.isInteger(num)) return { ok: false, message: 'maxTokens 必须是 64–8192 之间的整数。' };
  if (num < 64 || num > 8192) return { ok: false, message: 'maxTokens 需要在 64–8192 之间。' };
  return { ok: true, value: num };
}

function parseTimeoutMs(raw) {
  const num = toNumber(raw);
  if (!Number.isInteger(num)) return { ok: false, message: `timeoutMs 必须是 ${TIMEOUT_MIN_MS}–${TIMEOUT_MAX_MS} 之间的整数。` };
  if (num < TIMEOUT_MIN_MS || num > TIMEOUT_MAX_MS) return { ok: false, message: `timeoutMs 需要在 ${TIMEOUT_MIN_MS}–${TIMEOUT_MAX_MS} 毫秒之间。` };
  return { ok: true, value: num };
}

const PARSERS = {
  apiKey: parseApiKey,
  baseUrl: parseBaseUrl,
  model: parseModel,
  thinking: parseThinking,
  temperature: parseTemperature,
  maxTokens: parseMaxTokens,
  timeoutMs: parseTimeoutMs
};

// 读本地文件：不存在 / 损坏 / 无权限都静默降级为空对象，绝不抛异常影响服务启动
function readStoredConfig() {
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''); // 容忍 BOM
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const field of Object.keys(PARSERS)) {
      if (!Object.prototype.hasOwnProperty.call(parsed, field)) continue;
      const result = PARSERS[field](parsed[field]);
      if (result.ok) out[field] = result.value; // 单个坏字段直接丢弃，不影响其它字段
    }
    return out;
  } catch (e) {
    return {};
  }
}

// 读环境变量：未设置或空值当作没配；非法值忽略，继续走默认值
function readEnvConfig() {
  const out = {};
  for (const field of Object.keys(ENV_NAMES)) {
    const raw = process.env[ENV_NAMES[field]];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const result = PARSERS[field](raw);
    if (result.ok) out[field] = result.value;
  }
  return out;
}

// 优先级：本地文件 data/config.json > 环境变量 > 默认值
function getConfig() {
  const fileCfg = readStoredConfig();
  const envCfg = readEnvConfig();
  const source = Object.keys(fileCfg).length ? 'file' : (Object.keys(envCfg).length ? 'env' : 'default');
  const cfg = { ...DEFAULTS };

  for (const field of Object.keys(DEFAULTS)) {
    // apiKey 以「文件里出现过该字段」为准：写空串代表用户在网页上主动清除，不再回落到环境变量
    if (field === 'apiKey' && Object.prototype.hasOwnProperty.call(fileCfg, 'apiKey')) { cfg.apiKey = fileCfg.apiKey; continue; }
    if (fileCfg[field] !== undefined) { cfg[field] = fileCfg[field]; continue; }
    if (envCfg[field] !== undefined) cfg[field] = envCfg[field];
  }

  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    thinking: cfg.thinking,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    source
  };
}

// 对外输出一律脱敏：保留前 6 位与后 4 位，中间用 **** 代替
function maskKey(key) {
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) return '';
  if (value.length <= 10) return '****'; // 太短就不展示任何片段，避免暴露完整 Key
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

function getPublicConfig() {
  const cfg = getConfig();
  return {
    configured: !!cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    keyMasked: maskKey(cfg.apiKey),
    thinking: cfg.thinking,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    source: cfg.source
  };
}

function writeStoredConfig(data) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    // 先写临时文件再改名，避免写到一半崩溃导致配置文件损坏；mode 600 限制本机其它用户读取
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    // 只带错误码，不带任何配置内容，避免 Key 进日志
    const err = new Error(`config_write_failed: 配置保存失败（${e && e.code ? e.code : 'IOError'}）。`);
    err.code = 'config_write_failed';
    throw err;
  }
}

// 合并写入本地文件；只接受白名单字段，非法值抛错（带 code，便于上层转成 400 提示）
function saveConfig(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const err = new Error('invalid_patch: 配置内容必须是对象。');
    err.code = 'invalid_patch';
    throw err;
  }

  const stored = readStoredConfig();
  const next = {};
  for (const field of WRITABLE_FIELDS) {
    if (stored[field] !== undefined) next[field] = stored[field]; // 只保留白名单字段
  }

  for (const field of Object.keys(patch)) {
    if (!WRITABLE_FIELDS.includes(field)) continue; // 白名单外的字段静默忽略
    const result = PARSERS[field](patch[field]);
    if (!result.ok) {
      const err = new Error(`invalid_${field}: ${result.message}`);
      err.code = `invalid_${field}`;
      throw err;
    }
    next[field] = result.value; // apiKey 为 '' 即清除
  }

  writeStoredConfig(next);
  return getPublicConfig();
}

function clearApiKey() {
  return saveConfig({ apiKey: '' });
}

module.exports = { getConfig, getPublicConfig, saveConfig, clearApiKey, maskKey };
