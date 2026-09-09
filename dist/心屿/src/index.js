const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const chatRoute = require('./chat');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));
app.use('/api/chat', chatRoute);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), model: process.env.LLM_MODEL || '未配置' });
});

app.listen(PORT, () => {
  console.log(`心屿服务已启动：http://localhost:${PORT}`);
});
