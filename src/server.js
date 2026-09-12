/**
 * 模块：server —— HTTP 服务入口（Express 装配 + 优雅退出）
 * 层级：入口（src/ 顶层，由根目录 main.js 转发进入）
 * 职责：加载 .env、定位 public/ 静态目录、挂 /api/chat 与四个管理 router、暴露 /api/health、
 *      监听 127.0.0.1，并在 SIGINT/SIGTERM 时同步落盘会话、尽力补抽长期记忆后退出。
 * 依赖：chat（./chat）、infra/sessions、api/routes、infra/config、domain/persona、pipeline/prompts
 * 被依赖：根目录 main.js（薄转发）、src/index.js、tests 之外的冒烟脚本
 * 改动风险：🔴 高 —— 改完要跑 node --check + 启动冒烟（curl /api/health、curl / 找 id="messages"）
 * 契约：默认端口（process.env.PORT || 3000）、必须显式绑 127.0.0.1、/api/health 的响应字段，
 *      以及 appRoot 指向项目根（public/ 找不到会让静态资源 404）。
 * 不要做什么：
 *   1) 不要把 app.listen(PORT, HOST) 改成不带 host 的 app.listen(PORT)（默认绑 0.0.0.0，同网段可读私密对话）；
 *   2) 不要移除 shutdown 里的 sessions.flush()（否则最后几轮对话会丢）。
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const express = require('express');

// 打包后 __dirname 指向临时解压目录，但 exe 旁边的文件才是真正的根目录
const isPkg = typeof process.pkg !== 'undefined';
const appRoot = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

// 加载 .env：优先 exe 旁边的 .env
const envPath = path.join(appRoot, '.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

// 找 public 目录（按优先级）：
//   ① appRoot/public         —— 非打包时是项目根；打包后是 exe 旁边
//   ② appRoot/../public      —— package.json 的 pkg.assets 把 public 收进快照后，
//                              快照根即 appRoot 的上级（pkg 的 __dirname 语义）
//   ③ __dirname/../public    —— 本文件在 src/ 下时的回退（pkg 快照内）
// ⚠️ 注意：本文件位于 src/server.js，__dirname 是 src/ 而不是项目根，
//    因此**不能**再用 path.join(__dirname, 'public')——那会指向不存在的 src/public，
//    并让 pkg 打出 `Cannot stat ENOENT src/public` 的警告。
let publicDir = path.join(appRoot, 'public');
if (!fs.existsSync(publicDir)) publicDir = path.join(appRoot, '..', 'public');
if (!fs.existsSync(publicDir)) publicDir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(publicDir)) {
  console.error('[警告] 未找到 public 目录，页面可能无法加载。');
}

// 静态 require，便于 pkg 在打包时自动收集依赖
const chatRoute = require('./chat');
const sessions = require('./infra/sessions');
const { configRouter, memoryRouter, comebackRouter, sessionsRouter } = require('./api/routes');

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
  try { cfg = require('./infra/config').getPublicConfig(); } catch (e) { /* 忽略 */ }
  const persona = require('./domain/persona');
  const prompts = require('./pipeline/prompts');
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
    const chat = require('./chat');
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
