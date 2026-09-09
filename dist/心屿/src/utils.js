const { createHmac } = require('crypto');

function sanitizeText(value, { maxLength = 2000 } = {}) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function redactBasic(text) {
  return String(text)
    .replace(/1[3-9]\d{9}/g, '[手机号]')
    .replace(/\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, '[身份证]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱]');
}

function hmacSessionId(sessionId) {
  const salt = process.env.LOG_SALT || 'local-dev-salt';
  return createHmac('sha256', salt).update(String(sessionId)).digest('hex').slice(0, 12);
}

module.exports = {
  sanitizeText,
  redactBasic,
  hmacSessionId
};
