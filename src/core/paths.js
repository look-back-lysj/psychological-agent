/**
 * 模块：core/paths —— 路径解析（data / logs 目录）
 * 层级：core L0
 * 职责：解析可写数据目录与日志目录：exe 旁边优先、不可写回退用户目录；支持 XINYU_DATA_DIR / LOG_DIR 覆盖。
 * 依赖：无（只用 Node 内置 fs / os / path）
 * 被依赖：core/logger（logDir）、infra/config、infra/memory、infra/sessions、infra/comeback（dataDir / logDir）
 * 改动风险：🟢 低 —— node --check + 起一次短命服务确认能启动
 * 契约：appRoot / dataDir / logDir / canWrite / isPkg 的导出名与语义
 * 不要做什么：
 *   1) 不要改动 XINYU_DATA_DIR 的优先级（测试与多用户部署依赖它）
 *   2) 不要把 data/ 与 logs/ 的默认位置从「项目/exe 旁边」挪走
 */
/**
 * 守岸人 · 路径解析
 *
 * 打包成 exe（pkg / Tauri sidecar）后，__dirname 指向只读快照，
 * 数据必须写在可写目录。优先 exe 旁边，不可写时回退到用户目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const isPkg = typeof process.pkg !== 'undefined';

function appRoot() {
  // 本文件位于 src/core/，距项目根是**两级**（原 src/paths.js 只有一级）。
  // 打包成 exe 后仍未 process.execPath 旁边，这一路径不受影响。
  return isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 可写数据目录：exe 旁边 data/ 优先，不可写时退到用户目录。
 * 可用环境变量 XINYU_DATA_DIR 强制指定（测试/多用户部署用）。
 */
function dataDir() {
  const forced = process.env.XINYU_DATA_DIR;
  if (forced) {
    try { fs.mkdirSync(forced, { recursive: true }); } catch (e) { /* 忽略 */ }
    return forced;
  }
  const primary = path.join(appRoot(), 'data');
  if (canWrite(primary)) return primary;
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  const fallback = path.join(base, 'xinyu', 'data');
  try { fs.mkdirSync(fallback, { recursive: true }); } catch (e) { /* 忽略 */ }
  return fallback;
}

/** 日志目录：同样优先项目/exe 旁边，失败回退用户目录。 */
function logDir() {
  const primary = path.join(appRoot(), 'logs');
  if (canWrite(primary)) return primary;
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  const fallback = path.join(base, 'xinyu', 'logs');
  try { fs.mkdirSync(fallback, { recursive: true }); } catch (e) { /* 忽略 */ }
  return fallback;
}

module.exports = { isPkg, appRoot, dataDir, logDir, canWrite };
