#!/usr/bin/env node
/**
 * 心屿 · 桌面版（Tauri）构建脚本
 *
 * 做三件事：
 *   ① 复用 build.js 产出后端可执行文件 dist/心屿/心屿.exe
 *   ② 把它按目标三元组命名，放到 src-tauri/binaries/ 作为 Tauri sidecar
 *   ③ 调用 tauri build / tauri dev
 *
 * 用法：
 *   node scripts/build-desktop.js                 # 打包（默认 GNU 目标）
 *   node scripts/build-desktop.js --dev           # 开发模式
 *   node scripts/build-desktop.js --target x86_64-pc-windows-msvc
 *
 * 前置条件（只需装一次，见 README「桌面版」）：
 *   - Rust 工具链（建议安装在纯 ASCII 路径）
 *   - MinGW-w64（GNU 目标）或 Visual Studio C++ 生成工具（MSVC 目标）
 *   - 建议把 CARGO_TARGET_DIR / TEMP 也指向纯 ASCII 路径（中文路径会让 GNU 链接器失败）
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const isDev = args.includes('--dev');
const tIdx = args.indexOf('--target');
const TARGET = tIdx !== -1 ? args[tIdx + 1] : 'x86_64-pc-windows-gnu';

const BACKEND_EXE = path.join(ROOT, 'dist', '心屿', '心屿.exe');
const BIN_DIR = path.join(ROOT, 'src-tauri', 'binaries');

function run(command, commandArgs) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : command;
  const finalArgs = isWin ? ['/d', '/s', '/c', [command].concat(commandArgs).join(' ')] : commandArgs;
  const r = spawnSync(cmd, finalArgs, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) process.exit(r.status || 1);
}

console.log('① 构建后端可执行文件（pkg）…');
run('node', ['build.js']);
if (!fs.existsSync(BACKEND_EXE)) {
  console.error('未找到后端产物：' + BACKEND_EXE);
  process.exit(1);
}

console.log('② 准备 Tauri sidecar…');
fs.mkdirSync(BIN_DIR, { recursive: true });
const sidecar = path.join(BIN_DIR, 'xinyu-backend-' + TARGET + '.exe');
fs.copyFileSync(BACKEND_EXE, sidecar);
console.log('   -> ' + path.relative(ROOT, sidecar));

console.log('③ 构建桌面应用（' + TARGET + '）…');
run('npx', ['tauri', isDev ? 'dev' : 'build', '--target', TARGET]);

console.log('完成。');
