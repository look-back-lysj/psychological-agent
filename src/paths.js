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
  return isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
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
