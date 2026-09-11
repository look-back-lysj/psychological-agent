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

// 只监听回环地址：这个服务承载的是用户的私密对话，绝不能暴露到局域网。
// 注意 app.listen(PORT) 默认绑定 0.0.0.0（所有网卡），同网段的人可以直接访问，
// 因此必须显式绑定 127.0.0.1。
const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
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
  console.log(`  后端服务已就绪：${url}`);
  console.log(`  模型：${process.env.LLM_MODEL || '未配置'}`);
  console.log('');
  console.log('  本产品是桌面应用：界面由桌面外壳（守岸人.exe）的 WebView 加载；');
  console.log('  此控制台只显示后端日志，关闭它即停止服务。');
  console.log('');

  // 默认不打开浏览器：本产品是桌面应用，界面由桌面外壳的 WebView 加载，
  // 浏览器只是「排查问题时」的调试通道。仅当显式设置 OPEN_BROWSER=1 时才打开。
  // （Tauri 外壳会传 NO_BROWSER=1，那是旧开关，现在默认即不打开，留着无害。）
  if (process.env.OPEN_BROWSER !== '1') return;
  console.log('  [调试] OPEN_BROWSER=1：正在打开调试页面...');
  try {
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd);
  } catch (e) { /* 打不开就算了，可手动复制上面的地址 */ }
});

// 优雅退出：会话转写是防抖落盘的（800ms 窗口），退出前必须同步刷一次，
// 否则最后几轮对话会丢。Tauri 关闭窗口时会给 sidecar 发 SIGTERM。
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  // 1) 先把会话转写同步落盘（这一步是同步的，必成）
  try { sessions.flush(); } catch (e) { /* 静默 */ }

  // 2) 再尽力补抽一次「待抽取的长期记忆」。
  //    注意：它是**异步网络请求**，所以不能直接 process.exit（那样请求发不完）。
  //    给它一个 1.5 秒的窗口，超时就放弃——绝不能让退出卡住。
  let pending = [];
  try {
    const chat = require('./src/chat');
    if (chat && typeof chat.flushPendingExtraction === 'function') {
      pending = [...sessions.sessions.keys()].map((id) => {
        try { return Promise.resolve(chat.flushPendingExtraction(id)).catch(() => {}); }
        catch (e) { return Promise.resolve(); }
      });
    }
  } catch (e) { /* 静默：抽不出来也不能影响退出 */ }

  const done = pending.length ? Promise.all(pending) : Promise.resolve();
  Promise.race([done, new Promise((r) => setTimeout(r, 1500))])
    .catch(() => {})
    .then(() => {
      // 补抽可能又写了新记忆/新转写，最后再刷一次盘
      try { sessions.flush(); } catch (e) { /* 静默 */ }
      process.exit(0);
    });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
