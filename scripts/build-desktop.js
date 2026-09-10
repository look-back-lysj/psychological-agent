#!/usr/bin/env node
/**
 * 心屿 · 桌面版（Tauri）一键构建脚本
 *
 * 设计目标：让「在含中文的路径 + 没有管理员权限」的普通 Windows 机器上也能跑通。
 * 它会自动处理四个已知的坑：
 *   ① 源码路径含中文时 windres 读不了图标       → 在纯 ASCII 目录做构建
 *   ② dlltool 无法在中文路径创建 .lib          → 强制 CARGO_TARGET_DIR / TEMP 为 ASCII
 *   ③ Rust 工具链装在中文用户目录下链接失败     → 检测并给出明确指引
 *   ④ 打包器按目标三元组找 sidecar             → 显式传 --target
 *
 * 用法：
 *   node scripts/build-desktop.js               # 打包安装包（NSIS，当前用户安装）
 *   node scripts/build-desktop.js --dev         # 开发模式
 *   node scripts/build-desktop.js --no-bundle   # 只编译 exe，不打安装包（更快）
 *   node scripts/build-desktop.js --target x86_64-pc-windows-msvc
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const isDev = args.includes('--dev');
const noBundle = args.includes('--no-bundle');
const checkOnly = args.includes('--check');
const tIdx = args.indexOf('--target');
const TARGET = tIdx !== -1 ? args[tIdx + 1] : 'x86_64-pc-windows-gnu';

const BACKEND_EXE = path.join(ROOT, 'dist', '心屿', '心屿.exe');
const PRODUCT_NAME = '守岸人';
const OUT_PORTABLE = path.join(ROOT, 'dist', PRODUCT_NAME + '桌面版');

/** 路径里是否有非 ASCII 字符（含中文） */
function hasNonAscii(p) {
  return /[^\x00-\x7F]/.test(p);
}

/** 找一个纯 ASCII 的暂存目录 */
function asciiStagingDir() {
  const candidates = [
    process.env.XINYU_DESKTOP_BUILD_DIR,
    path.join(path.parse(process.cwd()).root, 'xinyu-build'),
    path.join(os.homedir(), 'xinyu-build')
  ].filter(Boolean);
  for (const c of candidates) {
    if (!hasNonAscii(c)) return c;
  }
  return null;
}

function run(command, commandArgs, cwd) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : command;
  const finalArgs = isWin ? ['/d', '/s', '/c', [command].concat(commandArgs).join(' ')] : commandArgs;
  const r = spawnSync(cmd, finalArgs, { stdio: 'inherit', cwd: cwd || ROOT });
  if (r.status !== 0) process.exit(r.status || 1);
}

function hasCargo() {
  const r = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (r.status === 0) return true;
  // 常见的手动安装位置
  const guess = path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe');
  return fs.existsSync(guess);
}

// ── 前置检查 ──────────────────────────────────────────────────
if (!hasCargo()) {
  console.error('\n[缺少 Rust 工具链] 请先安装（不需要管理员权限）：');
  console.error('  1) 下载 https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe');
  console.error('  2) 运行：rustup-init.exe -y --default-toolchain stable-x86_64-pc-windows-gnu --profile minimal');
  console.error('  3) 如果用户名含中文，建议先设置（否则链接器读不了 .rlib）：');
  console.error('     set RUSTUP_HOME=C:/xinyu-rust/rustup');
  console.error('     set CARGO_HOME=C:/xinyu-rust/cargo');
  console.error('  4) GNU 目标还需要 MinGW-w64：https://github.com/brechtsanders/winlibs_mingw/releases\n');
  process.exit(2);
}

// ── ① 后端可执行文件 ──────────────────────────────────────────
console.log('\n① 构建后端可执行文件（pkg）…');
run('npm', ['run', 'build']);
if (!fs.existsSync(BACKEND_EXE)) {
  console.error('未找到后端产物：' + BACKEND_EXE);
  process.exit(1);
}

// ── ② 决定构建目录（中文路径就换到 ASCII 暂存目录）──────────────
let buildRoot = ROOT;
const staging = asciiStagingDir();
if (hasNonAscii(ROOT)) {
  if (!staging) {
    console.error('[错误] 当前路径含中文，且找不到可用的 ASCII 暂存目录。请设置 XINYU_DESKTOP_BUILD_DIR 环境变量。');
    process.exit(2);
  }
  buildRoot = path.join(staging, 'src');
  console.log('② 检测到中文路径，改用 ASCII 构建目录：' + buildRoot);
  fs.mkdirSync(buildRoot, { recursive: true });
  // 只同步构建真正需要的部分（不含 node_modules / target / binaries）
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (['node_modules', 'target', 'binaries', 'gen'].includes(name)) continue;
      const s = path.join(from, name), d = path.join(to, name);
      const st = fs.statSync(s);
      if (st.isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  copyDir(path.join(ROOT, 'src-tauri'), path.join(buildRoot, 'src-tauri'));

  // 暂存目录没有 node_modules 的话，npx 找不到 tauri CLI。
  // 优先用目录联接（junction，免管理员），失败则退化为复制 @tauri-apps。
  const stageNm = path.join(buildRoot, 'node_modules');
  const realNm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(stageNm) && fs.existsSync(realNm)) {
    const link = spawnSync('cmd.exe', ['/d', '/s', '/c', `mklink /J "${stageNm}" "${realNm}"`], { stdio: 'ignore' });
    if (link.status === 0) {
      console.log('   已用目录联接共享 node_modules');
    } else {
      const tauriPkg = path.join(realNm, '@tauri-apps');
      if (fs.existsSync(tauriPkg)) {
        copyDir(tauriPkg, path.join(stageNm, '@tauri-apps'));
        console.log('   已复制 @tauri-apps 到暂存目录');
      }
    }
  }
  // 暂存目录也需要一个 package.json，npx 才能定位本地 CLI
  const stagePkg = path.join(buildRoot, 'package.json');
  if (!fs.existsSync(stagePkg)) {
    fs.writeFileSync(stagePkg, JSON.stringify({ name: 'xinyu-desktop-stage', private: true, version: '1.0.0' }, null, 2));
  }
} else {
  console.log('② 路径为纯 ASCII，直接在当前目录构建');
}

const SRC_TAURI = path.join(buildRoot, 'src-tauri');
if (!fs.existsSync(SRC_TAURI)) {
  console.error('未找到 src-tauri 目录：' + SRC_TAURI);
  process.exit(1);
}

// ── ③ sidecar ─────────────────────────────────────────────────
console.log('③ 准备 Tauri sidecar…');
const binDir = path.join(SRC_TAURI, 'binaries');
fs.mkdirSync(binDir, { recursive: true });
const sidecar = path.join(binDir, `xinyu-backend-${TARGET}.exe`);
fs.copyFileSync(BACKEND_EXE, sidecar);
console.log('   -> ' + sidecar);

// ── ④ 环境变量：把 target / 临时目录固定到 ASCII ────────────────
const env = { ...process.env };
if (hasNonAscii(ROOT) && staging) {
  env.CARGO_TARGET_DIR = env.CARGO_TARGET_DIR || path.join(staging, 'target');
  const tmp = path.join(staging, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  env.TEMP = tmp;
  env.TMP = tmp;
}
// 如果之前按 README 把工具链装在 ASCII 路径，自动启用（避免中文路径链接失败）
const ASCII_RUST_HOME = process.env.XINYU_RUST_HOME || 'C:/xinyu-rust/rustup';
const ASCII_CARGO_HOME = process.env.XINYU_CARGO_HOME || 'C:/xinyu-rust/cargo';
if (!hasNonAscii(ASCII_RUST_HOME) && fs.existsSync(ASCII_RUST_HOME) && fs.existsSync(ASCII_CARGO_HOME)) {
  if (!env.RUSTUP_HOME) env.RUSTUP_HOME = ASCII_RUST_HOME;
  if (!env.CARGO_HOME) env.CARGO_HOME = ASCII_CARGO_HOME;
  const cargoBin = path.join(ASCII_CARGO_HOME, 'bin');
  if (fs.existsSync(cargoBin)) env.PATH = cargoBin + path.delimiter + env.PATH;
  console.log('   自动启用 ASCII 路径的 Rust 工具链：' + ASCII_CARGO_HOME);
}

// GNU 目标需要 MinGW-w64 的 gcc / dlltool / ld 在 PATH 里
if (TARGET.indexOf('gnu') !== -1) {
  const mingwGuess = process.env.XINYU_MINGW_BIN
    || path.join(os.homedir(), 'AppData', 'Local', 'xinyu-tools', 'mingw64', 'bin');
  if (fs.existsSync(mingwGuess)) {
    env.PATH = mingwGuess + path.delimiter + env.PATH;
    console.log('   自动启用 MinGW：' + mingwGuess);
  } else {
    const whereCmd = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'which';
    const whereArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'where dlltool'] : ['dlltool'];
    const probe = spawnSync(whereCmd, whereArgs, { stdio: 'ignore' });
    if (probe.status !== 0) {
      console.warn('[提醒] GNU 目标需要 MinGW-w64（提供 gcc / dlltool / ld）。');
      console.warn('       下载：https://github.com/brechtsanders/winlibs_mingw/releases');
      console.warn('       解压后设 XINYU_MINGW_BIN=<解压目录>/mingw64/bin，或把它加入 PATH。');
    }
  }
}

// 如果 rustup 装在中文目录，提醒但不阻断
const rustupHome = env.RUSTUP_HOME || path.join(os.homedir(), '.rustup');
if (hasNonAscii(rustupHome)) {
  console.warn('\n[提醒] RUSTUP_HOME 位于含中文的路径，GNU 链接器可能失败：' + rustupHome);
  console.warn('       建议把 RUSTUP_HOME / CARGO_HOME 指到 ASCII 路径后重装工具链。\n');
}

if (checkOnly) {
  console.log('');
  console.log('[--check] 环境与暂存准备就绪：');
  console.log('   构建目录   : ' + buildRoot);
  console.log('   目标三元组 : ' + TARGET);
  console.log('   sidecar    : ' + sidecar);
  console.log('   CARGO_TARGET_DIR : ' + (env.CARGO_TARGET_DIR || '(使用默认 src-tauri/target)'));
  console.log('   TEMP       : ' + (env.TEMP || '(使用系统默认)'));
  console.log('');
  console.log('   去掉 --check 即可开始真正的构建。');
  process.exit(0);
}

// ── ⑤ 调用 tauri ──────────────────────────────────────────────
const mode = isDev ? 'dev' : 'build';
const extra = (noBundle && !isDev) ? ['--no-bundle'] : [];
console.log('④ 构建桌面应用（' + TARGET + '）…');

// 优先直接用 node 调用 CLI 入口（比 npx 可靠：暂存目录里可能没有 .bin 软链）
const cliJs = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
let r;
if (fs.existsSync(cliJs)) {
  r = spawnSync(process.execPath, [cliJs, mode, '--target', TARGET].concat(extra), {
    stdio: 'inherit', cwd: buildRoot, env
  });
} else {
  const win = process.platform === 'win32';
  const cmd = win ? (env.ComSpec || 'cmd.exe') : 'npx';
  const argv = win
    ? ['/d', '/s', '/c', ['npx', 'tauri', mode, '--target', TARGET].concat(extra).join(' ')]
    : ['tauri', mode, '--target', TARGET].concat(extra);
  r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: buildRoot, env });
}
if (r.status !== 0) process.exit(r.status || 1);

// ── ⑥ 回收产物到 dist/ ────────────────────────────────────────
if (!isDev) {
  const targetRoot = env.CARGO_TARGET_DIR
    ? path.join(env.CARGO_TARGET_DIR, TARGET, 'release')
    : path.join(SRC_TAURI, 'target', TARGET, 'release');
  const plainRoot = env.CARGO_TARGET_DIR
    ? path.join(env.CARGO_TARGET_DIR, 'release')
    : path.join(SRC_TAURI, 'target', 'release');
  const pick = (name) => {
    for (const base of [targetRoot, plainRoot]) {
      const p = path.join(base, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };
  console.log('⑤ 回收产物到 dist/ …');
  fs.mkdirSync(OUT_PORTABLE, { recursive: true });
  const copies = [
    [pick('xinyu.exe'), path.join(OUT_PORTABLE, PRODUCT_NAME + '.exe')],
    [pick('xinyu-backend.exe'), path.join(OUT_PORTABLE, 'xinyu-backend.exe')],
    [pick('WebView2Loader.dll'), path.join(OUT_PORTABLE, 'WebView2Loader.dll')]
  ];
  for (const [from, to] of copies) {
    if (from && fs.existsSync(from)) {
      fs.copyFileSync(from, to);
      console.log('   -> ' + path.relative(ROOT, to));
    }
  }
  // 安装包
  for (const base of [targetRoot, plainRoot]) {
    const nsisDir = path.join(base, 'bundle', 'nsis');
    if (fs.existsSync(nsisDir)) {
      const setup = fs.readdirSync(nsisDir).find(f => f.endsWith('.exe'));
      if (setup) {
        const dest = path.join(ROOT, 'dist', setup);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(nsisDir, setup), dest);
        console.log('   -> ' + path.relative(ROOT, dest));
        break;
      }
    }
  }
}

console.log('\n✅ 完成。');
