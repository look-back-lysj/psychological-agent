#!/usr/bin/env node
/**
 * 守岸人 · Gitee Release 发布脚本
 *
 * 用法（令牌只从环境变量读，绝不写进仓库、绝不落盘）：
 *   GITEE_TOKEN=xxxxxxxx node scripts/publish-release.js
 *   GITEE_TOKEN=xxxxxxxx node scripts/publish-release.js --tag v3.0.0
 *
 * 做三件事：
 *   1. 把 dist/守岸人/ 打成 zip（免安装 Node 版）
 *   2. 在 Gitee 创建/复用 Release
 *   3. 上传附件 —— ⚠️ 一律用 ASCII 文件名，中文名在 multipart 上传时会被服务端
 *      转码成乱码（这是本项目踩过的坑，所以这里强制改名）
 *
 * 安全：本脚本不接收、不存储任何令牌；只读 process.env.GITEE_TOKEN。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPO = 'flowing-shadows-like-scenes/psychological-agent';
const API = 'https://gitee.com/api/v5';

// ── 参数 ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const TOKEN = process.env.GITEE_TOKEN || process.env.GITEE_ACCESS_TOKEN || '';
const VERSION = argOf('--version', '3.0.0');
const TAG = argOf('--tag', 'v' + VERSION);
const NOTES_FILE = argOf('--notes', path.join(ROOT, '_tmp', 'release-v' + VERSION + '.md'));
const DRY = args.includes('--dry-run');

if (!TOKEN && !DRY) {
  console.error('❌ 未找到令牌。请这样运行：\n   GITEE_TOKEN=你的令牌 node scripts/publish-release.js\n');
  console.error('   （令牌只从环境变量读取，本脚本不会写入任何文件）');
  process.exit(1);
}

// ── 待上传产物：中文名 → ASCII 名 ────────────────────────────────
const SETUP_SRC = path.join(ROOT, 'dist', `守岸人_${VERSION}_x64-setup.exe`);
const SETUP_NAME = `shouanren-${VERSION}-x64-setup.exe`;
// 第二个产物用「免安装绿色版」（Tauri 便携版），而不是 Node 源码包：
// 便携版自带后端可执行文件，**不需要本机装 Node.js**，解压双击即用。
// （早先叫 "-node.zip" 且指向 dist/守岸人/，但那个目录里是 pkg 打好的 56MB exe，
//   既不需要 Node、又白白多 10MB 的 docs/devlog/tests，说明与内容自相矛盾。）
const ZIP_NAME = `shouanren-${VERSION}-portable.zip`;
const ZIP_PATH = path.join(ROOT, 'dist', ZIP_NAME);
const PORTABLE_DIR = path.join(ROOT, 'dist', '守岸人桌面版');

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

// ── 1. 打 zip（免安装绿色版）─────────────────────────────────────
function makeZip() {
  if (!fs.existsSync(PORTABLE_DIR)) {
    fail('找不到 ' + PORTABLE_DIR + '，请先运行：node scripts/build-desktop.js');
  }
  if (fs.existsSync(ZIP_PATH)) fs.rmSync(ZIP_PATH, { force: true });
  console.log('① 打包免安装绿色版…');
  if (process.platform === 'win32') {
    // 用 PowerShell 压缩；-Path 指向目录内容而非目录本身，避免多一层父目录
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${PORTABLE_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force`
    ], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-r', '-q', ZIP_PATH, '.'], { cwd: PORTABLE_DIR, stdio: 'inherit' });
  }
  const size = (fs.statSync(ZIP_PATH).size / 1048576).toFixed(2);
  console.log('   -> ' + path.relative(ROOT, ZIP_PATH) + '  (' + size + ' MB)');
}

// ── 2. Gitee API ────────────────────────────────────────────────
async function api(method, url, { json, form } = {}) {
  const opts = { method, headers: {} };
  if (json) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;   // FormData：交给 fetch 自己设置 boundary
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    const detail = data ? JSON.stringify(data) : text.slice(0, 300);
    throw new Error(`${method} ${url} -> HTTP ${res.status}: ${detail}`);
  }
  return data;
}

async function findRelease() {
  try {
    const list = await api('GET', `${API}/repos/${REPO}/releases?access_token=${encodeURIComponent(TOKEN)}&per_page=100`);
    return Array.isArray(list) ? list.find(r => r.tag_name === TAG) : null;
  } catch (e) {
    console.warn('   （查询已有 Release 失败，将直接尝试创建：' + e.message + '）');
    return null;
  }
}

async function createOrReuseRelease() {
  console.log('② 创建/复用 Release ' + TAG + ' …');
  const existing = await findRelease();
  if (existing) {
    console.log('   已存在（id=' + existing.id + '），复用并补充附件');
    return existing;
  }
  const body = fs.existsSync(NOTES_FILE) ? fs.readFileSync(NOTES_FILE, 'utf8') : ('守岸人 ' + TAG);
  const created = await api('POST', `${API}/repos/${REPO}/releases`, {
    json: {
      access_token: TOKEN,
      tag_name: TAG,
      name: '守岸人 ' + TAG,
      body,
      target_commitish: 'master',
      prerelease: false
    }
  });
  console.log('   已创建（id=' + created.id + '）');
  return created;
}

async function uploadAsset(release, filePath, asciiName) {
  if (!fs.existsSync(filePath)) fail('找不到待上传文件：' + filePath);
  const size = (fs.statSync(filePath).size / 1048576).toFixed(2);
  // 已存在同名附件时先删掉，避免重复堆积
  try {
    const list = await api('GET', `${API}/repos/${REPO}/releases/${release.id}/attach_files?access_token=${encodeURIComponent(TOKEN)}`);
    const dup = Array.isArray(list) ? list.find(a => a.title === asciiName || a.title === path.basename(filePath)) : null;
    if (dup) {
      await api('DELETE', `${API}/repos/${REPO}/releases/${release.id}/attach_files/${dup.id}?access_token=${encodeURIComponent(TOKEN)}`);
      console.log('   已删除同名旧附件：' + asciiName);
    }
  } catch (e) { /* 列表失败不阻塞上传 */ }

  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('access_token', TOKEN);
  form.append('file', new Blob([buf]), asciiName);
  const uploaded = await api('POST', `${API}/repos/${REPO}/releases/${release.id}/attach_files`, { form });
  console.log('   ⬆ ' + asciiName + '  (' + size + ' MB)  ->  ' + (uploaded && uploaded.browser_download_url ? uploaded.browser_download_url : 'ok'));
}

(async function main() {
  console.log('\n守岸人 · Gitee Release 发布  (' + TAG + ')\n' + '─'.repeat(48));
  if (!fs.existsSync(SETUP_SRC)) {
    fail('找不到安装包：' + SETUP_SRC + '\n   请先运行：node scripts/build-desktop.js');
  }
  if (DRY) {
    console.log('（--dry-run：只检查产物，不调用 API）');
    console.log('安装包  : ' + path.relative(ROOT, SETUP_SRC));
    console.log('将被改名: ' + SETUP_NAME);
    console.log('将打 zip(绿色版): ' + ZIP_NAME);
    console.log('说明文件: ' + NOTES_FILE + (fs.existsSync(NOTES_FILE) ? '（存在）' : '（不存在，将用默认说明）'));
    return;
  }

  makeZip();
  const release = await createOrReuseRelease();
  console.log('③ 上传附件（ASCII 文件名，避免中文被转码成乱码）…');
  await uploadAsset(release, SETUP_SRC, SETUP_NAME);
  await uploadAsset(release, ZIP_PATH, ZIP_NAME);
  console.log('\n✅ 发布完成：https://gitee.com/' + REPO + '/releases/tag/' + TAG + '\n');
})().catch(err => {
  console.error('\n❌ 发布失败：' + err.message);
  process.exit(1);
});
