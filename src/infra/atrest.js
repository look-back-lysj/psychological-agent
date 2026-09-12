/**
 * 模块：infra/atrest —— 本地数据静态加密（会话转写 / 长期记忆）
 * 层级：infra L2（有状态 / 外部 IO）
 * 职责：为 data/sessions.json、data/memory.json 提供「透明加解密」：AES-256-GCM + 本机密钥文件 data/.key。
 *      默认开启（XINYU_ENCRYPT_DATA=0 关闭）；读到历史明文文件时原样兼容，下次写入即自动加密。
 * 依赖：core/paths（dataDir / hardenPath）、Node 内置 crypto / fs / path
 * 被依赖：infra/sessions、infra/memory
 * 改动风险：🟡 中 —— node --check + 往返自测探针 + npm test
 * 契约：isEnabled / encode / decode / readTextFile / keyPath 的导出名与语义
 * 不要做什么：
 *   1) 不要把密钥写进日志、响应或任何返回值（只允许存在于 data/.key 与本进程内存）
 *   2) 解密失败时**不许静默丢数据** —— readTextFile 会先留档 .unreadable-<时间戳> 再抛错
 *   3) 不要改 data/*.json 的字段名（只改文件表示，不动结构）
 *
 * ⚠️ 诚实标注防护边界：密钥与数据同机存放，目标是「防同机其它用户 / 防误拷贝到公共目录 / 防云盘同步」，
 *    不是「对抗管理员权限或已提权进程」。丢了 data/.key 就解不开历史数据（会留档不删除）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir, hardenPath } = require('../core/paths');

const ENVELOPE_KEY = '__xinyu_enc';
const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedKey = null;

/** 是否启用静态加密：默认开启，XINYU_ENCRYPT_DATA=0 显式关闭。 */
function isEnabled() {
  return String(process.env.XINYU_ENCRYPT_DATA === undefined ? '1' : process.env.XINYU_ENCRYPT_DATA) !== '0';
}

/** 密钥文件路径：data/.key（data/ 已 gitignore，且目录本身已收紧 ACL）。 */
function keyPath() {
  return path.join(dataDir(), '.key');
}

/** 读取或生成密钥（32 字节，base64 存盘）。写盘后立即收紧 ACL。 */
function loadKey() {
  if (cachedKey) return cachedKey;
  const file = keyPath();
  try {
    if (fs.existsSync(file)) {
      const buf = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
      if (buf.length === KEY_BYTES) {
        cachedKey = buf;
        return cachedKey;
      }
    }
  } catch (e) { /* 读不到就重新生成，下面统一处理 */ }
  const key = crypto.randomBytes(KEY_BYTES);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('base64') + NL, { encoding: 'utf8', mode: 0o600 });
    hardenPath(file, false);
  } catch (e) { /* 写不进去时只在内存里生效，本进程仍可读写（下次启动会换新密钥） */ }
  cachedKey = key;
  return key;
}

const NL = String.fromCharCode(10);

/** 明文文本 -> 落盘文本（开启加密时返回信封 JSON；任何异常都退回明文，绝不阻断落盘）。 */
function encode(text) {
  const plain = String(text === null || text === undefined ? '' : text);
  if (!isEnabled()) return plain;
  try {
    const key = loadKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const env = {};
    env[ENVELOPE_KEY] = ENVELOPE_VERSION;
    env.iv = iv.toString('base64');
    env.tag = tag.toString('base64');
    env.data = data.toString('base64');
    return JSON.stringify(env) + NL;
  } catch (e) {
    return plain;
  }
}

/** 判断文本是否是本模块的信封格式。 */
function isEnvelope(text) {
  return /"__xinyu_enc"\s*:/.test(String(text).slice(0, 120));
}

/** 落盘文本 -> 明文文本（历史明文原样返回；信封解密失败会抛错）。 */
function decode(text) {
  const raw = String(text === null || text === undefined ? '' : text);
  if (!isEnvelope(raw)) return raw;
  const env = JSON.parse(raw);
  const key = loadKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(env.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

/**
 * 读文件并自动解密。解密失败时先把原文件**留档**（*.unreadable-<时间戳>），再抛错，
 * 让上层按「损坏」走既有降级路径（sessions 回落默认值 / memory 回落空库），绝不静默删数据。
 */
function readTextFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return decode(raw);
  } catch (e) {
    try {
      const bak = file + '.unreadable-' + Date.now();
      fs.copyFileSync(file, bak);
      console.error('[加密] 数据解密失败，原文件已留档：' + path.basename(bak));
    } catch (e2) { /* 留档失败也不阻断降级 */ }
    throw e;
  }
}

module.exports = { isEnabled, keyPath, encode, decode, readTextFile, isEnvelope };
