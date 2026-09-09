const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist', '心屿');
const PUBLIC = path.join(__dirname, 'public');
const SRC = path.join(__dirname, 'src');
const TESTS = path.join(__dirname, 'tests');
const DOCS = path.join(__dirname, 'docs');
const DEVLOG = path.join(__dirname, 'devlog');
const LOGS = path.join(__dirname, 'logs');

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

// 清理
if (fs.existsSync(path.join(__dirname, 'dist'))) fs.rmSync(path.join(__dirname, 'dist'), { recursive: true });
mkdirp(DIST);

// 复制核心文件
for (const f of ['package.json', 'package-lock.json', 'README.md', '.env.example', '.gitignore', 'launcher.js']) {
  if (fs.existsSync(path.join(__dirname, f))) copy(path.join(__dirname, f), path.join(DIST, f));
}
copyDir(PUBLIC, path.join(DIST, 'public'));
copyDir(SRC, path.join(DIST, 'src'));
copyDir(TESTS, path.join(DIST, 'tests'));
if (fs.existsSync(DOCS)) copyDir(DOCS, path.join(DIST, 'docs'));
if (fs.existsSync(DEVLOG)) copyDir(DEVLOG, path.join(DIST, 'devlog'));
if (fs.existsSync(LOGS)) copyDir(LOGS, path.join(DIST, 'logs'));

// 复制提交清单等
for (const f of ['submit-checklist.md']) {
  if (fs.existsSync(path.join(__dirname, f))) copy(path.join(__dirname, f), path.join(DIST, f));
}

// 写启动脚本
const bat = `@echo off
chcp 65001 >nul 2>&1
title 心屿 · 大学生情绪陪伴助手

echo.
echo   ========================================
echo   心屿 · 大学生情绪陪伴助手
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
node src/index.js
pause
`;

fs.writeFileSync(path.join(DIST, '启动心屿.bat'), bat, 'utf8');

// 写测试脚本
const testBat = `@echo off
chcp 65001 >nul 2>&1
title 心屿 - 运行测试
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
