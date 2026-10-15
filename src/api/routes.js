/**
 * 模块：api/routes —— 管理接口（config / memory / comeback / sessions）
 * 层级：api L4（对外接口）
 * 职责：提供 /api/config、/api/memory、/api/comeback、/api/sessions 的读写路由，是前端设置面板与记忆面板的后端。
 * 依赖：infra/config、infra/memory、infra/sessions、infra/llm、infra/comeback
 * 被依赖：server.js（app.use 四个 router）
 * 改动风险：🔴 高 —— node --check + node tests/run.js（42/42 + 9/9）+ 启动冒烟
 * 契约：configRouter / memoryRouter / comebackRouter / sessionsRouter 的导出名与各端点的响应形状
 * 不要做什么：
 *   1) 不要改响应字段名（前端 public/app.js 的 fetch 形状与之双边绑定，要改必须两边同步）
 *   2) 不要在响应里返回未脱敏的 API Key
 */
/**
 * 守岸人 · 管理接口
 * - /api/config    本地模型配置（DeepSeek Key、模型、温度）读写与连通性自检
 * - /api/memory    长期记忆的查看 / 新增 / 编辑 / 删除 / 清空 / 开关
 * - /api/comeback  「回来」上下文（情感连续性；不调用模型）
 * - /api/sessions  会话转写（本机 data/sessions.json）的清空
 *
 * 安全：API Key 只落本地 data/config.json，对外一律脱敏；绝不写日志。
 */

const express = require('express');
const config = require('../infra/config');
const memory = require('../infra/memory');
const sessions = require('../infra/sessions');
const { testConnection, listModels } = require('../infra/llm');
const { getComeback } = require('../infra/comeback');

// ── 配置 ────────────────────────────────────────────────────────
const configRouter = express.Router();

configRouter.get('/', (req, res) => {
  res.json({ ok: true, data: config.getPublicConfig() });
});

configRouter.post('/', (req, res) => {
  try {
    const data = config.saveConfig(req.body || {});
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || '配置保存失败' });
  }
});

// 使用未保存的地址/Key 检测，成功后由用户选择模型再保存。
configRouter.post('/models', async (req, res) => {
  try {
    res.json({ ok: true, data: await listModels(req.body || {}) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.code && e.code.startsWith('invalid_') ? e.message : '获取模型列表失败，请检查设置。' });
  }
});

configRouter.post('/test', async (req, res) => {
  try {
    const result = await testConnection();
    res.json({ ok: true, data: result });
  } catch (e) {
    res.json({ ok: true, data: { ok: false, code: 'model_unknown', message: '自检失败，请稍后重试' } });
  }
});

configRouter.delete('/key', (req, res) => {
  try {
    res.json({ ok: true, data: config.clearApiKey() });
  } catch (e) {
    res.status(400).json({ ok: false, error: '清除失败' });
  }
});

// ── 长期记忆 ────────────────────────────────────────────────────
const memoryRouter = express.Router();

memoryRouter.get('/', (req, res) => {
  const status = memory.getStatus();
  res.json({
    ok: true,
    data: {
      enabled: status.enabled,
      count: status.count,
      updatedAt: status.updatedAt,
      categories: status.categories,
      items: memory.listMemories()
    }
  });
});

memoryRouter.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.text || !String(body.text).trim()) {
    return res.status(400).json({ ok: false, error: '内容不能为空' });
  }
  const r = memory.addMemory({
    text: body.text,
    category: body.category,
    source: 'manual',
    pinned: body.pinned === true
  });
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error || '保存失败' });
  return res.json({ ok: true, data: r.item });
});

memoryRouter.post('/enabled', (req, res) => {
  const enabled = !(req.body && req.body.enabled === false);
  memory.setEnabled(enabled);
  res.json({ ok: true, data: { enabled } });
});

memoryRouter.patch('/:id', (req, res) => {
  const r = memory.updateMemory(req.params.id, req.body || {});
  if (!r.ok) return res.status(404).json({ ok: false, error: r.error || '未找到该记忆' });
  return res.json({ ok: true, data: r.item });
});

memoryRouter.delete('/:id', (req, res) => {
  const r = memory.removeMemory(req.params.id);
  if (!r.ok) return res.status(404).json({ ok: false, error: r.error || '未找到该记忆' });
  return res.json({ ok: true, data: { removed: r.removed || null } });
});

memoryRouter.delete('/', (req, res) => {
  memory.clearMemories();
  res.json({ ok: true, data: { cleared: true } });
});

// ── 「回来」：情感连续性上下文（零模型调用，失败也要有兜底结构）──
const comebackRouter = express.Router();

comebackRouter.get('/', (req, res) => {
  let data;
  try {
    data = getComeback();
  } catch (e) {
    // 极端情况下也不让接口 500：返回最小可用结构
    data = {
      firstVisit: true,
      lastSeenAt: null,
      hoursSince: null,
      timeOfDay: 'afternoon',
      greeting: '我是守岸人。你可以先坐一会儿，不用急着说什么。',
      memoryHighlights: [],
      suggestions: ['今天状态还行', '想说点别的', '不知道从哪儿开始'],
      visitCount: 1
    };
  }
  res.json({ ok: true, data });
});

// ── 会话转写：清空（本机 data/sessions.json）────────────────────
// 对话原文属敏感数据，必须给用户一个「一键清空」的入口：只清前端 localStorage
// 是不够的，服务端落盘的转写也要一起清掉。
const sessionsRouter = express.Router();

sessionsRouter.delete('/', (req, res) => {
  try {
    sessions.clearAllSessions();
    res.json({ ok: true, data: { cleared: true } });
  } catch (e) {
    res.status(500).json({ ok: false, error: '清空会话记录失败' });
  }
});

module.exports = { configRouter, memoryRouter, comebackRouter, sessionsRouter };
