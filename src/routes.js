/**
 * 心屿 · 管理接口
 * - /api/config    本地模型配置（DeepSeek Key、模型、温度）读写与连通性自检
 * - /api/memory    长期记忆的查看 / 新增 / 编辑 / 删除 / 清空 / 开关
 * - /api/comeback  「回来」上下文（情感连续性；不调用模型）
 * - /api/demo      免 Key 演示模式开关（GET 查询 / POST 设置）
 *
 * 安全：API Key 只落本地 data/config.json，对外一律脱敏；绝不写日志。
 */

const express = require('express');
const config = require('./config');
const memory = require('./memory');
const { testConnection } = require('./llm');
const { getComeback } = require('./comeback');
const { isDemoEnabled, setDemoEnabled } = require('./demo');

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
      greeting: '我是心屿。你可以先坐一会儿，不用急着说什么。',
      memoryHighlights: [],
      suggestions: ['今天状态还行', '想说点别的', '不知道从哪儿开始'],
      visitCount: 1
    };
  }
  // demoAvailable 让前端知道可以引导没有 Key 的用户试演示模式
  res.json({ ok: true, data: Object.assign({}, data, { demoAvailable: true }) });
});

module.exports = { configRouter, memoryRouter, comebackRouter };
