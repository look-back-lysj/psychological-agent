const API_TIMEOUT_MS = 20000;

function getConfig() {
  const base = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || '';
  return { base, key, model };
}

async function callLLM(systemPrompt, messages, { retries = 1 } = {}) {
  const { base, key, model } = getConfig();
  const url = `${base}/chat/completions`;
  const payload = {
    model,
    temperature: 0.35,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }))
    ]
  };

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (res.status === 429) { clearTimeout(timer); await sleep(900 + Math.random() * 400); continue; }
      if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`model_${res.status}: ${t.slice(0, 200)}`); }
      const data = await res.json();
      clearTimeout(timer);
      return { content: data?.choices?.[0]?.message?.content || '', usage: data?.usage || null };
    } catch (e) { clearTimeout(timer); lastError = e; if (attempt < retries) await sleep(700 + Math.random() * 400); }
  }
  throw lastError || new Error('call_llm_failed');
}

// 流式调用的看门狗：首个数据块 / 两次数据块之间的最长等待，以及单次调用总上限
const STREAM_IDLE_TIMEOUT_MS = 15000;
const STREAM_TOTAL_TIMEOUT_MS = 120000;

// 流式调用：解析 OpenAI 兼容 SSE（按空行分事件、支持多行 data），边收边通过 onDelta 回调
async function callLLMStream(systemPrompt, messages, { onDelta, signal, retries = 1 } = {}) {
  const { base, key, model } = getConfig();
  if (!base || !key) throw new Error('model_not_configured');
  const url = `${base}/chat/completions`;
  const payload = {
    model,
    temperature: 0.35,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }))
    ]
  };

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
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
      if (!totalTimer) totalTimer = setTimeout(() => controller.abort(), STREAM_TOTAL_TIMEOUT_MS);
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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (res.status === 429) {
        clearTimers();
        if (attempt < retries) { await sleep(900 + Math.random() * 400); continue; }
        throw new Error('model_429');
      }
      if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`model_${res.status}: ${t.slice(0, 200)}`); }

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
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        return false; // 其它字段（event:/id:/retry:/注释）忽略
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
      lastError = e;
      if (attempt < retries) await sleep(700 + Math.random() * 400);
    } finally {
      clearTimers();
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }
  throw lastError || new Error('call_llm_failed');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
module.exports = { callLLM, callLLMStream, getConfig };
