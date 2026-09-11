const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const express = require('express');

// 打包后 __dirname 指向临时解压目录，但 exe 旁边的文件才是真正的根目录
const isPkg = typeof process.pkg !== 'undefined';
const appRoot = isPkg ? path.dirname(process.execPath) : __dirname;

// 加载 .env：优先 exe 旁边的 .env
const envPath = path.join(appRoot, '.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

// 找 public 目录：优先 exe/项目旁边的目录，其次打包快照内
let publicDir = path.join(appRoot, 'public');
if (!fs.existsSync(publicDir)) publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  console.error('[警告] 未找到 public 目录，页面可能无法加载。');
}

// 静态 require，便于 pkg 在打包时自动收集依赖
const chatRoute = require('./src/chat');
const sessions = require('./src/sessions');
const { configRouter, memoryRouter, comebackRouter, sessionsRouter } = require('./src/routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));
app.use('/api/chat', chatRoute);
app.use('/api/config', configRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/comeback', comebackRouter);
app.use('/api/sessions', sessionsRouter);

app.get('/api/health', (req, res) => {
  let cfg = { model: '', configured: false };
  try { cfg = require('./src/config').getPublicConfig(); } catch (e) { /* 忽略 */ }
  const persona = require('./src/persona');
  const prompts = require('./src/prompts');
  res.json({
    ok: true,
    time: new Date().toISOString(),
    model: cfg.model || '未配置',
    configured: !!cfg.configured,
    personaVersion: persona.PERSONA_VERSION,
    promptVersion: prompts.PROMPT_VERSION
  });
});

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err.message);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  // 横幅用「显示宽度」对齐（中文按 2 列算），否则「守岸人」三字会把右边框顶歪
  const BOX_INNER = 36;
  const title = '守岸人 · 情绪陪伴';
  const displayWidth = title.replace(/[\u4e00-\u9fa5]/g, 'xx').length + 2; // 前后各留 1 空格
  const pad = ' '.repeat(Math.max(0, BOX_INNER - displayWidth));
  console.log('');
  console.log('  ╔' + '═'.repeat(BOX_INNER) + '╗');
  console.log('  ║ ' + title + pad + ' ║');
  console.log('  ╚' + '═'.repeat(BOX_INNER) + '╝');
  console.log('');
  console.log(`  服务已启动：${url}`);
  console.log(`  模型：${process.env.LLM_MODEL || '未配置'}`);
  console.log('');
  console.log('  关闭此窗口即停止服务');
  console.log('');

  // 自动打开浏览器（设置 NO_BROWSER=1 可禁用，便于服务器/测试环境）
  if (process.env.NO_BROWSER === '1') return;
  console.log('  正在打开浏览器...');
  try {
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd);
  } catch (e) { /* 手动打开 */ }
});

// 优雅退出：会话转写是防抖落盘的（800ms 窗口），退出前必须同步刷一次，
// 否则最后几轮对话会丢。Tauri 关闭窗口时会给 sidecar 发 SIGTERM。
function shutdown() {
  try { sessions.flush(); } catch (e) { /* 静默 */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
