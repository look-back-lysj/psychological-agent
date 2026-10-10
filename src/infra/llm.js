/**
 * 模块：infra/llm —— 模型调用（OpenAI 兼容 /chat/completions + SSE）
 * 层级：infra L2（外部调用）
 * 职责：负责 callLLM / callLLMStream / testConnection：重试、超时看门狗、SSE 解析与错误码归类。
 * 依赖：infra/config（getConfig）
 * 被依赖：pipeline/agents、chat/pipeline、api/routes
 * 改动风险：🟡 中 —— node --check + node tests/run.js
 * 契约：callLLM(prompt, messages, opts) / callLLMStream(prompt, messages, {onDelta, signal}) 的签名与返回 {content, usage}
 * 不要做什么：
 *   1) 不要硬编码模型名（模型统一由 .env / config 提供）
 *   2) 不要去掉超时看门狗与 AbortSignal 支持
 */
const { getConfig } = require('./config');

// 流式调用的看门狗：首个数据块 / 两次数据块之间的最长等待，以及单次调用总上限
const STREAM_IDLE_TIMEOUT_MS = 15000;
const STREAM_TOTAL_TIMEOUT_MS = 180000;
// 连通性自检的超时（不重试，要快）
const TEST_TIMEOUT_MS = 20000;
// 对齐官方 OpenAI / Anthropic SDK 默认值：408 / 409 / 429 及所有 ≥500 可重试，最多 2 次；超时（AbortError）最多补 1 次
const MAX_RETRIES = 2;
// 官方 SDK 的 MAX_RETRY_DELAY = 8.0：指数退避封顶 8 秒
const MAX_RETRY_DELAY_MS = 8000;
// 官方 SDK 的 MAX_RETRY_AFTER_DELAY = 120（秒）：Retry-After 超过 120s 就放弃重试
const MAX_RETRY_AFTER_DELAY_MS = 120000;

// 统一错误前缀 + 对用户友好的中文说明（DeepSeek 错误码页，2026-09-10 核实）
const STATUS_ERRORS = {
  401: ['model_auth', 'API Key 无效或已失效，请在设置里重新填写。'],
  402: ['model_balance', 'DeepSeek 账户余额不足，请先充值后再试。'],
  429: ['model_rate_limit', '请求过于频繁，请稍后再试。'],
  500: ['model_server', '模型服务暂时不可用，请稍后重试。'],
  503: ['model_server', '模型服务暂时不可用，请稍后重试。']
};

// 仅 DeepSeek 官方域名才加专有参数，避免污染其它 OpenAI 兼容服务
function isDeepSeek(baseUrl) {
  return typeof baseUrl === 'string' && baseUrl.toLowerCase().includes('deepseek');
}

// 含图轮次的 max_tokens 下限：视觉任务的思考 token 实测占 151~463，
// 预算不足会导致 content 为空（实测踩过）→ 含图时至少给到这里。可用 XINYU_IMAGE_MAX_TOKENS 覆盖。
const IMAGE_MAX_TOKENS_FLOOR = Number(process.env.XINYU_IMAGE_MAX_TOKENS || 1024);

/**
 * 单条消息 -> content。
 * 兼容原则：**可选**字段 image（data URL）存在时才改用多模态 content 数组；
 * 纯文本消息仍返回字符串，buildPayload 的既有行为与改动前逐字节一致。
 */
function toMessageContent(m) {
  const text = String(m && m.text == null ? '' : (m && m.text));
  const image = m && typeof m.image === 'string' ? m.image : '';
  if (!image) return text;
  const parts = [];
  if (text) parts.push({ type: 'text', text: text });
  parts.push({ type: 'image_url', image_url: { url: image } });
  return parts;
}

// 组装 payload：只带通用字段，不传 frequency_penalty / presence_penalty / n / seed（DeepSeek 已废弃或不支持）
function buildPayload(cfg, systemPrompt, messages, stream) {
  const list = (messages || []).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: toMessageContent(m)
  }));
  const hasImage = list.some(m => Array.isArray(m.content));
  const payload = {
    model: cfg.model,
    messages: [{ role: 'system', content: systemPrompt }].concat(list)
  };
  if (stream) payload.stream = true;
  // 思考模式下 temperature 不生效，干脆不传
  if (cfg.thinking !== 'enabled') payload.temperature = cfg.temperature;
  payload.max_tokens = hasImage ? Math.max(cfg.maxTokens, IMAGE_MAX_TOKENS_FLOOR) : cfg.maxTokens;
  if (cfg.thinking === 'disabled' && isDeepSeek(cfg.baseUrl)) payload.thinking = { type: 'disabled' };
  return payload;
}

function requireKey(cfg) {
  if (!cfg.apiKey) {
    const err = new Error('model_not_configured: 尚未填写 API Key，请在设置里填写后重试。');
    err.code = 'model_not_configured';
    err.userMessage = '尚未填写 API Key，请在设置里填写后重试。';
    throw err;
  }
}

function makeHttpError(status, bodyText) {
  const mapped = STATUS_ERRORS[status];
  const code = mapped ? mapped[0] : `model_${status}`;
  const userMessage = mapped ? mapped[1] : `模型服务返回错误（${status}），请稍后再试。`;
  const err = new Error(`${code}: ${userMessage}`); // 统一前缀，方便上层按 code 给提示
  err.code = code;
  err.status = status;
  err.userMessage = userMessage;
  // 服务端原始说明只留在 detail（抹掉可能的 sk- 串、截断），不写日志、不回前端
  const detail = String(bodyText || '').trim();
  if (detail) err.detail = detail.replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-***').slice(0, 200);
  return err;
}

function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
}

function normalizeError(e) {
  if (e && typeof e.code === 'string' && e.code.startsWith('model_')) return e; // 已是业务错误
  if (isAbortError(e)) {
    const err = new Error('model_timeout: 模型响应超时，请稍后重试。');
    err.code = 'model_timeout';
    err.userMessage = '模型响应超时，请稍后重试。';
    return err;
  }
  const err = new Error('model_network: 无法连接模型服务，请检查网络或 API 地址后重试。');
  err.code = 'model_network';
  err.userMessage = '无法连接模型服务，请检查网络或 API 地址后重试。';
  return err;
}

// 非流式调用：正常返回 { content, usage }，失败抛出带 code 的 Error
async function callLLM(systemPrompt, messages, { retries = MAX_RETRIES } = {}) {
  const cfg = getConfig();
  requireKey(cfg);
  const url = `${cfg.baseUrl}/chat/completions`;
  const payload = buildPayload(cfg, systemPrompt, messages, false);
  const maxRetries = clampRetries(retries);
  let lastError = null;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        const err = makeHttpError(res.status, t);
        const retryAfterMs = parseRetryAfterMs(res.headers);
        if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
        throw err;
      }
      const data = await res.json();
      return { content: data?.choices?.[0]?.message?.content || '', usage: data?.usage || null };
    } catch (e) {
      lastError = normalizeError(e);
      // 对齐官方 SDK：408/409/429 与所有 ≥500 指数退避重试；超时最多补 1 次；400/401/402/422 等立即失败
      const timedOut = isAbortError(e);
      const allowed = isRetryableStatus(lastError.status) ? maxRetries : (timedOut ? Math.min(maxRetries, 1) : 0);
      if (!allowed || attempt >= allowed) break;
      // 服务端给了 Retry-After 就按它等待；等待时长超过 120s 直接放弃重试
      const retryAfterMs = lastError.retryAfterMs;
      if (retryAfterMs != null && retryAfterMs > MAX_RETRY_AFTER_DELAY_MS) break;
      await sleep(retryAfterMs != null ? retryAfterMs : backoffDelay(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('call_llm_failed');
}

// 流式调用：解析 OpenAI 兼容 SSE（按空行分事件、支持多行 data），边收边通过 onDelta 回调
async function callLLMStream(systemPrompt, messages, { onDelta, signal, retries = MAX_RETRIES } = {}) {
  const cfg = getConfig();
  requireKey(cfg);
  const url = `${cfg.baseUrl}/chat/completions`;
  const payload = buildPayload(cfg, systemPrompt, messages, true);
  const maxRetries = clampRetries(retries);
  // 总超时至少 180s：配置里的 30s 默认值是给非流式用的，不该用来掐断长回复（显式设更大值时才以配置为准）
  const totalTimeoutMs = Number(cfg.timeoutMs) > STREAM_TOTAL_TIMEOUT_MS ? Number(cfg.timeoutMs) : STREAM_TOTAL_TIMEOUT_MS;

  let lastError = null;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort);
    }

    let idleTimer = null;
    let totalTimer = null;
    const armTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
      if (!totalTimer) totalTimer = setTimeout(() => controller.abort(), totalTimeoutMs);
    };
    const clearTimers = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
    };
    armTimers();

    let content = '';
    let usage = null;
    let emitted = false;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        const err = makeHttpError(res.status, t);
        const retryAfterMs = parseRetryAfterMs(res.headers);
        if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
        throw err;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let dataLines = [];
      let streamDone = false;

      // 一个 SSE 事件（由空行分隔）可能有多行 data，需先合并再解析
      const flushEvent = async () => {
        if (!dataLines.length) return false;
        const raw = dataLines.join('\n');
        dataLines = [];
        if (raw === '[DONE]') return true;
        let chunk;
        try { chunk = JSON.parse(raw); } catch (e) { return false; }
        if (chunk && chunk.usage) usage = chunk.usage;
        const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (delta) {
          content += delta;
          emitted = true;
          if (onDelta) await onDelta(delta);
        }
        return false;
      };

      const absorbLine = async (line) => {
        if (line === '') return flushEvent();
        // 只认 data: 行，: keep-alive 等注释行、event:/id:/retry: 字段一律忽略
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        return false;
      };

      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        armTimers(); // 收到数据即重置空闲计时
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (await absorbLine(line)) { streamDone = true; break; }
        }
      }

      buffer += decoder.decode(); // 冲刷解码器，避免尾部多字节被截断
      if (!streamDone) {
        if (buffer) {
          const line = buffer.replace(/\r$/, '');
          buffer = '';
          if (await absorbLine(line)) streamDone = true;
        }
        if (!streamDone && await flushEvent()) streamDone = true;
      }
      if (streamDone) { try { await reader.cancel(); } catch (e) { /* 忽略取消异常 */ } }
      clearTimers();
      return { content, usage };
    } catch (e) {
      clearTimers();
      // 外部中止或已开始输出时不重试，避免重复内容
      if ((signal && signal.aborted) || emitted) throw e;
      lastError = normalizeError(e);
      const timedOut = isAbortError(e);
      const allowed = isRetryableStatus(lastError.status) ? maxRetries : (timedOut ? Math.min(maxRetries, 1) : 0);
      if (!allowed || attempt >= allowed) break;
      // 服务端给了 Retry-After 就按它等待；等待时长超过 120s 直接放弃重试
      const retryAfterMs = lastError.retryAfterMs;
      if (retryAfterMs != null && retryAfterMs > MAX_RETRY_AFTER_DELAY_MS) break;
      await sleep(retryAfterMs != null ? retryAfterMs : backoffDelay(attempt));
    } finally {
      clearTimers();
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }
  throw lastError || new Error('call_llm_failed');
}

/**
 * 零 token 探针：GET {baseUrl}/models（OpenAI 兼容接口，只校验鉴权，不产生计费 token）。
 * 返回 { ok:true } 表示连通；{ ok:false, fallback:true } 表示该服务没有 /models，需回退 chat 探测。
 */
async function probeModels(cfg) {
  const url = `${cfg.baseUrl}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal
    });
    if (res.ok) return { ok: true }; // 2xx：鉴权通过，连通
    // 401/403：Key 无效或没有权限，直接判定鉴权失败，不再花一次 chat 请求
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'model_auth', message: STATUS_ERRORS[401][1] };
    }
    // 404（部分兼容服务没有 /models 端点）与其它非 2xx：回退到 chat 探测
    return { ok: false, fallback: true };
  } catch (e) {
    // 网络错误 / 超时：回退到 chat 探测
    return { ok: false, fallback: true };
  } finally {
    clearTimeout(timer);
  }
}

// 连通性自检：优先 GET /models 零 token 探针，必要时回退到一条极小的 chat 请求。
// 成功/失败都返回 { ok, code?, message?, model?, latencyMs, sample? }，不抛异常。
async function testConnection() {
  const cfg = getConfig();
  if (!cfg.apiKey) return { ok: false, code: 'no_key', message: '尚未填写 API Key' };

  const startedAt = Date.now();

  // 先用 /models 探针（零 token 成本）
  const probe = await probeModels(cfg);
  if (probe.ok) {
    return { ok: true, model: cfg.model, latencyMs: Date.now() - startedAt, sample: '' };
  }
  if (!probe.fallback) {
    return { ok: false, code: probe.code, message: probe.message, latencyMs: Date.now() - startedAt };
  }

  // 回退：原来的极小 chat 请求（部分兼容服务没有 /models 端点，或 /models 网络不可达）
  const url = `${cfg.baseUrl}/chat/completions`;
  const payload = buildPayload(cfg, '你是一个连通性测试助手，请用一句话回应。', [{ role: 'user', text: '你好' }], false);
  payload.max_tokens = 8; // 极小请求，尽量少花额度

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const err = makeHttpError(res.status, t);
      return { ok: false, code: err.code, message: err.userMessage, latencyMs: Date.now() - startedAt };
    }
    const data = await res.json();
    const choice = (data && data.choices && data.choices[0]) || null;
    const sample = String((choice && choice.message && choice.message.content) || '').trim().slice(0, 60);
    return { ok: true, model: data?.model || cfg.model, latencyMs: Date.now() - startedAt, sample };
  } catch (e) {
    const err = normalizeError(e);
    return { ok: false, code: err.code || 'model_unknown', message: err.userMessage || err.message, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function clampRetries(retries) {
  const n = Number.isInteger(retries) ? retries : MAX_RETRIES;
  return Math.min(Math.max(n, 0), MAX_RETRIES);
}

// 对齐官方 SDK：408、409、429 以及所有 ≥500 都视为可重试
function isRetryableStatus(status) {
  const s = Number(status);
  if (!Number.isFinite(s)) return false;
  return s === 408 || s === 409 || s === 429 || s >= 500;
}

/**
 * 解析服务端 Retry-After：优先 retry-after-ms（毫秒），其次 retry-after（秒 / HTTP 日期）。
 * 返回毫秒数；拿不到或无法解析时返回 null，由指数退避兜底。
 */
function parseRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const msRaw = headers.get('retry-after-ms');
  if (msRaw != null && msRaw !== '') {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  }
  const secRaw = headers.get('retry-after');
  if (secRaw != null && secRaw !== '') {
    const sec = Number(secRaw);
    if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
    const at = Date.parse(secRaw); // 兼容 HTTP-date 形式
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return null;
}

// 指数退避 1s→2s→4s，叠加 ±20% 抖动，并整体封顶 8s，避免同时重试打爆服务
function backoffDelay(attempt) {
  const base = Math.min(1000 * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(base * 0.8 + Math.random() * base * 0.4));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { callLLM, callLLMStream, testConnection, getConfig };
