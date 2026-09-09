// 启动器：打包成 exe 后，双击即可运行
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// 自动找 .env（打包后在 exe 旁边）
const envPath = path.join(path.dirname(process.execPath), '.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else {
  const localEnv = path.join(__dirname, '.env');
  if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv });
}

const express = require('express');
const chatRoute = require('./src/chat');

const app = express();
const PORT = process.env.PORT || 3000;

// public 目录：优先 exe 旁边，否则项目目录
let publicDir = path.join(path.dirname(process.execPath), 'public');
if (!fs.existsSync(publicDir)) publicDir = path.join(__dirname, 'public');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));
app.use('/api/chat', chatRoute);
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), model: process.env.LLM_MODEL || '未配置' });
});

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  心屿 · 大学生情绪陪伴助手\n  服务已启动：${url}\n`);
  // 自动打开浏览器
  try {
    const { exec } = require('child_process');
    exec(`start "" "${url}"`);
  } catch (e) { /* 手动打开也行 */ }
});
