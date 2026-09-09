const API_TIMEOUT_MS = 20000;

function getConfig() {
  const base = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || 'deepseek-v4.1-flash-expires-on-0910';
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (res.status === 429) {
        clearTimeout(timer);
        await sleep(900 + Math.random() * 400);
        continue;
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`model_${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      clearTimeout(timer);
      return { content, usage: data?.usage || null };
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      if (attempt < retries) await sleep(700 + Math.random() * 400);
    }
  }
  throw lastError || new Error('call_llm_failed');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { callLLM, getConfig };
