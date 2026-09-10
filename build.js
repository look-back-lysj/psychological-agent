const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist', '守岸人');
const PUBLIC = path.join(__dirname, 'public');
const SRC = path.join(__dirname, 'src');
const TESTS = path.join(__dirname, 'tests');
const DOCS = path.join(__dirname, 'docs');
const DEVLOG = path.join(__dirname, 'devlog');
const SAMPLES = path.join(__dirname, 'samples');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function copy(src, dest) { fs.copyFileSync(src, dest); }
function copyDir(from, to) {
  mkdirp(to);
  for (const f of fs.readdirSync(from)) {
    const s = path.join(from, f), d = path.join(to, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else copy(s, d);
  }
}

// 只清理 dist/守岸人，保留 dist/ 下的其它产物（例如 exe）
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
mkdirp(DIST);

// 复制核心文件
for (const f of ['package.json', 'package-lock.json', 'README.md', '.env.example', '.gitignore', 'main.js']) {
  if (fs.existsSync(path.join(__dirname, f))) copy(path.join(__dirname, f), path.join(DIST, f));
}
copyDir(PUBLIC, path.join(DIST, 'public'));
copyDir(SRC, path.join(DIST, 'src'));
copyDir(TESTS, path.join(DIST, 'tests'));
if (fs.existsSync(DOCS)) copyDir(DOCS, path.join(DIST, 'docs'));
if (fs.existsSync(DEVLOG)) copyDir(DEVLOG, path.join(DIST, 'devlog'));
if (fs.existsSync(SAMPLES)) copyDir(SAMPLES, path.join(DIST, 'samples'));

// 只附带脱敏样例日志，绝不打包真实运行日志
const sampleLog = path.join(SAMPLES, 'calls.sample.jsonl');
if (fs.existsSync(sampleLog)) {
  mkdirp(path.join(DIST, 'logs'));
  copy(sampleLog, path.join(DIST, 'logs', 'calls.jsonl'));
}

// 复制提交清单等
for (const f of ['submit-checklist.md']) {
  if (fs.existsSync(path.join(__dirname, f))) copy(path.join(__dirname, f), path.join(DIST, f));
}

// 写启动脚本
const bat = `@echo off
chcp 65001 >nul 2>&1
title 守岸人 · 情绪陪伴

echo.
echo   ========================================
echo   守岸人 · 情绪陪伴
echo   ========================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo 请先安装 Node.js：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

:: 首次运行安装依赖
if not exist "node_modules" (
  echo [1/2] 首次运行，正在安装依赖...
  npm install --production
  echo.
)

:: 检查 .env
if not exist ".env" (
  echo [提示] 未检测到 .env 文件
  echo 已从 .env.example 复制模板，请编辑 .env 填入 API Key
  echo.
  copy .env.example .env >nul 2>&1
  echo 正在打开 .env 文件...
  start notepad .env
  echo 填写完毕后，请关闭记事本，本窗口会自动继续。
  echo.
  pause
)

echo [2/2] 正在启动服务...
echo.
node main.js
pause
`;

fs.writeFileSync(path.join(DIST, '启动守岸人.bat'), bat, 'utf8');

// 写测试脚本
const testBat = `@echo off
chcp 65001 >nul 2>&1
title 守岸人 - 运行测试
echo.
echo 正在运行测试...
echo.
node tests/run.js
echo.
pause
`;
fs.writeFileSync(path.join(DIST, '运行测试.bat'), testBat, 'utf8');

// 复制 .env.example 为 .env 模板（确保存在）
if (!fs.existsSync(path.join(DIST, '.env.example'))) {
  fs.writeFileSync(path.join(DIST, '.env.example'), 'LLM_BASE_URL=\nLLM_MODEL=\nLLM_API_KEY=your_api_key_here\nPORT=3000\nLOG_SALT=\n', 'utf8');
}

// 安装生产依赖到发布目录，使发布包可离线运行（失败不致命，.bat 仍会联网安装）
installProdDeps();

function installProdDeps() {
  const { spawnSync } = require('child_process');
  const isWin = process.platform === 'win32';
  const npmArgs = ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'];
  // Windows 下 npm 是 .cmd，通过 cmd.exe /c 调用，避免 shell:true 的安全告警
  const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = isWin ? ['/d', '/s', '/c', 'npm ' + npmArgs.join(' ')] : npmArgs;
  console.log('正在安装生产依赖到发布目录（仅 dotenv/express，可离线运行）...');
  const r = spawnSync(cmd, args, { cwd: DIST, stdio: 'pipe', encoding: 'utf8' });
  if (r.status === 0) {
    console.log('生产依赖安装完成。');
    return;
  }
  console.warn('[警告] 生产依赖安装失败，发布包首次运行需联网执行 npm install。');
  if (r.error) console.warn('[原因]', r.error.message);
  if (r.stderr) console.warn(String(r.stderr).trim().split('\n').slice(-3).join('\n'));
}

console.log(`打包完成：${DIST}`);
console.log(`文件数量：${countFiles(DIST)}`);

function countFiles(dir) {
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const s = path.join(dir, f);
    if (fs.statSync(s).isDirectory()) n += countFiles(s);
    else n++;
  }
  return n;
}
