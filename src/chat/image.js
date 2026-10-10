/**
 * 模块：chat/image —— 图片入参的解析与校验（纯函数，无 IO）
 * 层级：chat L0（纯工具；不依赖任何内部模块）
 * 职责：把请求体里的图片（data URL）解析成白名单内的 { image, mime, bytes }，或给出中文错误。
 *      同时提供图片侧的**安全信号预计算**入口（调用 pipeline/vision，失败一律 fail-safe）。
 * 契约：parseImage(body) -> { ok, image, mime, bytes, error }
 * 改动风险：🟢 低
 * 不要做什么：
 *   1) 不要把图片写进日志或返回值给前端（只回元信息）
 *   2) 不要放宽白名单与大小上限（见 MAX_IMAGE_CHARS）
 */

// base64 字符数上限：express.json 的 limit 是 1mb，base64 比原图大 33%，
// 因此这里卡在 900k 字符（约 675 KB 原图），给文本与信封留出余量。
const MAX_IMAGE_CHARS = 900000;
const MIME_WHITELIST = ['png', 'jpeg', 'jpg', 'webp'];

function parseImage(body) {
  const raw = body && (body.image || body.imageData);
  if (raw === undefined || raw === null || raw === '') return { ok: true, image: '', mime: '', bytes: 0, error: '' };
  if (typeof raw !== 'string') return { ok: false, image: '', mime: '', bytes: 0, error: '图片格式不正确（应为 base64 data URL 字符串）。' };
  if (raw.length > MAX_IMAGE_CHARS) {
    return { ok: false, image: '', mime: '', bytes: 0,
      error: '图片太大了（约 ' + Math.round(raw.length / 1365) + ' KB，上限约 660 KB）。请压缩后再发。' };
  }
  const head = 'data:image/';
  if (raw.indexOf(head) !== 0) return { ok: false, image: '', mime: '', bytes: 0, error: '图片格式不正确（只接受 data:image/...;base64,...）。' };
  const sep = raw.indexOf(';base64,');
  if (sep < 0) return { ok: false, image: '', mime: '', bytes: 0, error: '图片格式不正确（缺少 base64 标记）。' };
  const mime = raw.slice(head.length, sep).toLowerCase();
  if (MIME_WHITELIST.indexOf(mime) < 0) {
    return { ok: false, image: '', mime: '', bytes: 0, error: '只支持 png / jpeg / jpg / webp 四种图片格式。' };
  }
  const b64 = raw.slice(sep + 8);
  if (!b64 || b64.length < 16) return { ok: false, image: '', mime: '', bytes: 0, error: '图片内容为空。' };
  return { ok: true, image: raw, mime: mime, bytes: Math.round(b64.length * 0.75), error: '' };
}

module.exports = { parseImage, MAX_IMAGE_CHARS, MIME_WHITELIST };
