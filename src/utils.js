const { createHmac } = require('crypto');

/**
 * 基础清洗：压空白、去首尾、截断。
 */
function sanitizeText(value, { maxLength = 2000 } = {}) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * 归一化：去掉所有空白、零宽字符与常见中英文标点，并转小写。
 * 用于安全判定与关键词匹配，避免「自 杀」「割\u200b腕」这类绕过。
 */
function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/[\s\u3000\u200b-\u200f\ufeff]+/g, '')
    .replace(/[，。！？、；：""''（）【】《》〈〉「」『』〔〕…—－\-_,.!?;:'"()\[\]{}<>~`@#$%^&*+=|\/]/g, '')
    .toLowerCase();
}

/**
 * 脱敏：手机号、身份证号、邮箱。
 */
function redactBasic(text) {
  return String(text)
    .replace(/1[3-9]\d{9}/g, '[手机号]')
    .replace(/\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, '[身份证]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱]');
}

/**
 * 会话 ID 哈希（日志脱敏用）。
 */
function hmacSessionId(sessionId) {
  const salt = process.env.LOG_SALT || 'local-dev-salt';
  return createHmac('sha256', salt).update(String(sessionId)).digest('hex').slice(0, 12);
}

/**
 * 截断文本到指定长度（按字符，不切断代理对）。
 */
function truncate(text, max) {
  const chars = Array.from(String(text == null ? '' : text));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('') + '…';
}

module.exports = {
  sanitizeText,
  normalizeText,
  redactBasic,
  hmacSessionId,
  truncate
};
