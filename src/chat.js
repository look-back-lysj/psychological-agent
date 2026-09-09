const express = require('express');
const crypto = require('crypto');
const { sanitizeText } = require('./utils');
const { ensureSession, addTurn, getHistory } = require('./sessions');
const { checkInputSafety, checkOutputSafety } = require('./safety');
const { chooseStrategy } = require('./strategy');
const { buildSystemPrompt } = require('./prompts');
const { callLLM, getConfig } = require('./llm');
const { logCall } = require('./logger');

const router = express.Router();
const FAKE_SESSION_PREFIX = 's_';

router.post('/', async (req, res) => {
  const requestId = crypto.randomUUID();
  const t0 = Date.now();
  try {
    const message = sanitizeText(req.body && req.body.message);
    if (!message) return res.status(400).json({ ok: false, error: '消息不能为空。' });

    let sessionId = sanitizeText(req.body && req.body.sessionId, { maxLength: 100 });
    if (!sessionId) sessionId = FAKE_SESSION_PREFIX + crypto.randomUUID();
    ensureSession(sessionId);

    const inputSafety = checkInputSafety(message);
    const chosen = chooseStrategy(message, inputSafety);
    addTurn(sessionId, 'user', message, { riskLevel: inputSafety.riskLevel, strategy: chosen.key });

    if (inputSafety.action === 'static_reply' && inputSafety.meta) {
      addTurn(sessionId, 'assistant', inputSafety.meta.reply, { riskLevel: inputSafety.riskLevel, strategy: chosen.key });
      logCall({ requestId, sessionId, strategy: chosen.key, riskLevel: inputSafety.riskLevel, event: 'crisis_shortcut', model: getConfig().model, inputLength: message.length, latencyMs: Date.now() - t0, ok: true });
      return res.json({ ok: true, data: { reply: inputSafety.meta.reply, strategy: chosen.key, riskLevel: inputSafety.riskLevel, sessionId, requestId } });
    }

    const history = getHistory(sessionId);
    const systemPrompt = buildSystemPrompt(chosen.key);
    const llmResult = await callLLM(systemPrompt, history);
    const outputCheck = checkOutputSafety(llmResult.content);
    const finalReply = outputCheck.blocked ? outputCheck.fallback : llmResult.content;
    const finalEvent = outputCheck.blocked ? 'output_blocked' : 'llm_call';

    addTurn(sessionId, 'assistant', finalReply, { riskLevel: inputSafety.riskLevel, strategy: chosen.key, blocked: outputCheck.blocked, blockReason: outputCheck.reason });
    logCall({ requestId, sessionId, strategy: chosen.key, riskLevel: inputSafety.riskLevel, event: finalEvent, model: getConfig().model, inputLength: message.length, latencyMs: Date.now() - t0, ok: true, meta: { blocked: outputCheck.blocked || false, reason: outputCheck.blocked ? outputCheck.reason : undefined, usage: llmResult.usage } });

    return res.json({ ok: true, data: { reply: finalReply, strategy: chosen.key, riskLevel: inputSafety.riskLevel, sessionId, requestId } });
  } catch (e) {
    logCall({ requestId, sessionId: (req.body && req.body.sessionId) || '', strategy: 'unknown', riskLevel: 'unknown', event: 'error', model: getConfig().model, inputLength: ((req.body && req.body.message) || '').length, latencyMs: Date.now() - t0, ok: false, error: e.message });
    const fallback = '我现在这边出了点问题，但你的话我已经听到了。如果方便，我们可以稍后再聊；如果有更紧急的情况，请优先联系身边可信任的人或学校心理中心。';
    return res.status(200).json({ ok: true, data: { reply: fallback, strategy: 'error_fallback', riskLevel: 'unknown', sessionId: req.body && req.body.sessionId, requestId } });
  }
});

module.exports = router;
