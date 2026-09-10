/**
 * 心屿 · 长期记忆（本地、可控、可清除）
 *
 * 设计原则：
 * - 只存在本机 data/memory.json（已 gitignore），不上传、不入库；
 * - 用户可查看 / 编辑 / 删除 / 一键清空 / 关闭记忆；
 * - 只记「对陪伴有用」的稳定事实，不记身份信息、不记诊断、不记隐私细节；
 * - 召回按「置顶 + 相关度 + 新近度」排序，并限制条数与字数，控制 token 成本。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeText, truncate } = require('./utils');
const { dataDir } = require('./paths');

const NL = String.fromCharCode(10);
// 数据目录：exe 旁边优先，不可写时回退用户目录（见 paths.js）
const DATA_DIR = dataDir();
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');

const MEMORY_VERSION = 1;
const MAX_ITEMS = 200;
const MAX_TEXT_LEN = 60;

// 分类：只保留对陪伴有用的类型
const CATEGORIES = ['profile', 'stressor', 'preference', 'relationship', 'goal', 'state', 'other'];
const CATEGORY_LABELS = {
  profile: '基本情况',
  stressor: '压力来源',
  preference: '偏好',
  relationship: '人际关系',
  goal: '目标',
  state: '近期状态',
  other: '其它'
};

function now() { return Date.now(); }

function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }
}

function emptyStore() {
  return { version: MEMORY_VERSION, enabled: true, updatedAt: now(), items: [], tombstones: [] };
}

/**
 * 读取记忆库。任何异常都降级为空库，绝不让服务崩。
 */
function loadStore() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return emptyStore();
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    const items = Array.isArray(parsed.items) ? parsed.items.filter(isValidItem).map(normalizeItem) : [];
    return {
      version: MEMORY_VERSION,
      enabled: parsed.enabled !== false,
      updatedAt: Number(parsed.updatedAt) || now(),
      items,
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones.map(String).slice(-200) : []
    };
  } catch (e) {
    return emptyStore();
  }
}

function isValidItem(it) {
  return it && typeof it === 'object' && typeof it.text === 'string' && it.text.trim().length > 0;
}

function normalizeItem(it) {
  return {
    id: String(it.id || ('m_' + crypto.randomUUID().slice(0, 8))),
    text: truncate(String(it.text).trim(), MAX_TEXT_LEN),
    category: CATEGORIES.includes(it.category) ? it.category : 'other',
    confidence: typeof it.confidence === 'number' ? Math.max(0, Math.min(1, it.confidence)) : 0.6,
    source: it.source === 'manual' ? 'manual' : 'auto',
    pinned: it.pinned === true,
    hits: Number(it.hits) || 0,
    importance: typeof it.importance === 'number' ? Math.max(0, Math.min(1, it.importance)) : 0.5,
    sensitivity: it.sensitivity === 'high' ? 'high' : 'normal',
    status: it.status === 'superseded' ? 'superseded' : 'active',
    supersededBy: it.supersededBy || null,
    validFrom: Number(it.validFrom) || Number(it.createdAt) || now(),
    createdAt: Number(it.createdAt) || now(),
    lastUsedAt: Number(it.lastUsedAt) || 0
  };
}

function saveStore(store) {
  try {
    ensureDataDir();
    const payload = {
      version: MEMORY_VERSION,
      enabled: store.enabled !== false,
      updatedAt: now(),
      items: (store.items || []).slice(-MAX_ITEMS),
      tombstones: (store.tombstones || []).slice(-200)
    };
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

// ── 相似度与去重 ────────────────────────────────────────────────
function bigrams(s) {
  const n = normalizeText(s);
  const out = new Set();
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
  if (n.length === 1) out.add(n);
  return out;
}

function similarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const sa = bigrams(a);
  const sb = bigrams(b);
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

function findSimilar(store, text) {
  let best = null;
  let bestScore = 0;
  for (const it of store.items) {
    const s = similarity(it.text, text);
    if (s > bestScore) { bestScore = s; best = it; }
  }
  return bestScore >= 0.72 ? best : null;
}

function hasNegationFlip(a, b) {
  const neg = t => /[不没无别]/.test(t);
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (neg(na) === neg(nb)) return false;
  const sa = na.replace(/[不没无别]/g, '');
  const sb = nb.replace(/[不没无别]/g, '');
  return similarity(sa, sb) >= 0.4;
}

// ── 增删改查 ────────────────────────────────────────────────────
function listMemories() {
  const store = loadStore();
  return store.items.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastUsedAt || b.createdAt) - (a.lastUsedAt || a.createdAt);
  });
}

function getStatus() {
  const store = loadStore();
  return {
    enabled: store.enabled !== false,
    count: store.items.length,
    updatedAt: store.updatedAt,
    categories: CATEGORY_LABELS
  };
}

/**
 * 新增一条记忆；若与已有条目高度相似则合并（保留更长的文本，提升可信度）。
 */
function addMemory({ text, category, source, confidence, pinned }) {
  const clean = truncate(String(text == null ? '' : text).trim(), MAX_TEXT_LEN);
  if (!clean) return { ok: false, error: '内容为空' };
  const store = loadStore();
  const key = normalizeText(clean);
  if ((store.tombstones || []).some(t => t === key)) return { ok: false, error: '该内容已被用户遗忘' };
  // 语义相近但结论相反（如「喜欢安静」→「不喜欢安静」）：旧条目置为失效，保留可回溯
  const cat = CATEGORIES.includes(category) ? category : 'other';
  let near = null;
  let nearScore = 0;
  for (const it of store.items) {
    if (it.status === 'superseded') continue;
    const sc = similarity(it.text, clean);
    if (sc >= 0.45 && sc < 0.72 && it.category === cat && sc > nearScore) { near = it; nearScore = sc; }
  }
  if (near && hasNegationFlip(near.text, clean)) {
    near.status = 'superseded';
    near.supersededBy = 'new';
    store.items = store.items.map(it => (it.id === near.id ? near : it));
  }
  const similar = findSimilar(store, clean);
  if (similar) {
    if (clean.length > similar.text.length) similar.text = clean;
    similar.hits = (similar.hits || 0) + 1;
    if (source === 'manual') { similar.source = 'manual'; similar.confidence = 1; }
    if (pinned) similar.pinned = true;
    store.items = store.items.map(it => (it.id === similar.id ? similar : it));
    saveStore(store);
    return { ok: true, item: similar, merged: true };
  }
  const item = normalizeItem({
    id: 'm_' + crypto.randomUUID().slice(0, 8),
    text: clean,
    category: CATEGORIES.includes(category) ? category : 'other',
    confidence: typeof confidence === 'number' ? confidence : (source === 'manual' ? 1 : 0.6),
    source: source === 'manual' ? 'manual' : 'auto',
    pinned: pinned === true,
    hits: 0,
    createdAt: now(),
    lastUsedAt: 0
  });
  store.items.push(item);
  saveStore(store);
  return { ok: true, item, merged: false };
}

function updateMemory(id, patch) {
  const store = loadStore();
  const idx = store.items.findIndex(it => it.id === id);
  if (idx === -1) return { ok: false, error: '未找到该记忆' };
  const it = store.items[idx];
  if (patch && typeof patch.text === 'string' && patch.text.trim()) it.text = truncate(patch.text.trim(), MAX_TEXT_LEN);
  if (patch && CATEGORIES.includes(patch.category)) it.category = patch.category;
  if (patch && typeof patch.pinned === 'boolean') it.pinned = patch.pinned;
  store.items[idx] = it;
  saveStore(store);
  return { ok: true, item: it };
}

function removeMemory(id) {
  const store = loadStore();
  const target = store.items.find(it => it.id === id);
  if (!target) return { ok: false, error: '未找到该记忆' };
  store.items = store.items.filter(it => it.id !== id);
  store.tombstones = (store.tombstones || []).concat(normalizeText(target.text)).slice(-200);
  saveStore(store);
  return { ok: true, removed: target.text };
}

function clearMemories() {
  const store = loadStore();
  store.tombstones = (store.tombstones || [])
    .concat(store.items.map(it => normalizeText(it.text)))
    .slice(-200);
  store.items = [];
  saveStore(store);
  return { ok: true };
}

function setEnabled(enabled) {
  const store = loadStore();
  store.enabled = enabled !== false;
  saveStore(store);
  return { ok: true, enabled: store.enabled };
}

/**
 * 召回：置顶优先 + 与当前话题相关 + 新近使用过。
 */
function retrieveMemories(query, options) {
  const opts = options || {};
  const limit = Math.max(0, Math.min(12, opts.limit || 6));
  const store = loadStore();
  if (store.enabled === false || !store.items.length || limit === 0) return [];
  const q = normalizeText(query || '');
  const active = store.items.filter(it => it.status !== 'superseded' && it.sensitivity !== 'high');
  const scored = active.map(it => {
    let score = 0;
    if (it.pinned) score += 100;
    const nText = normalizeText(it.text);
    if (q) {
      let overlap = 0;
      for (let i = 0; i < nText.length - 1; i++) {
        if (q.includes(nText.slice(i, i + 2))) overlap += 1;
      }
      score += Math.min(40, overlap * 4);
    }
    score += (it.importance || 0.5) * 20;
    // 刚用过 24 小时内轻微降权，避免同一记忆被反复复读
    if (it.lastUsedAt && (now() - it.lastUsedAt) < 86400000) score -= 15;
    return { item: it, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // 每个分类最多 2 条（置顶条目不受限）
  const perCategory = {};
  const picked = [];
  for (const s of scored) {
    const it = s.item;
    if (!it.pinned) {
      const c = it.category || 'other';
      if ((perCategory[c] || 0) >= 2) continue;
      perCategory[c] = (perCategory[c] || 0) + 1;
    }
    picked.push(it);
    if (picked.length >= limit) break;
  }
  // 记录使用，便于后续排序（不阻塞主流程）
  if (picked.length) {
    const ids = new Set(picked.map(p => p.id));
    const st = loadStore();
    let changed = false;
    for (const it of st.items) {
      if (ids.has(it.id)) { it.lastUsedAt = now(); it.hits = (it.hits || 0) + 1; changed = true; }
    }
    if (changed) saveStore(st);
  }
  return picked;
}

// ── 显式记忆指令（「记住……」）──────────────────────────────────
const REMEMBER_RE = /^(记住|请记住|帮我记住|记一下|记下)[：:，,\s]*(.+)$/;

function handleExplicitRemember(text) {
  const m = String(text || '').match(REMEMBER_RE);
  if (!m) return null;
  const content = m[2].trim();
  if (content.length < 2) return null;
  const category = /压力|考试|作业|论文|实习|ddl/i.test(content) ? 'stressor'
    : /喜欢|讨厌|习惯|偏好/.test(content) ? 'preference'
    : /室友|朋友|家里|妈妈|爸爸|同学|老师/.test(content) ? 'relationship'
    : /想|打算|目标|希望/.test(content) ? 'goal'
    : 'other';
  const r = addMemory({ text: content, category, source: 'manual' });
  return r.ok ? r.item : null;
}

// ── 自然语言遗忘指令（「忘掉……」「别记……」）────────────────────
const FORGET_RE = /^(忘掉|忘记|别记|不要记|删除记忆|清空记忆|不用记)[：:，,\s]*(.*)$/;

function handleForget(text) {
  const m = String(text || '').match(FORGET_RE);
  if (!m) return null;
  const what = (m[2] || '').trim();
  const store = loadStore();
  if (!what || /全部|所有|一切/.test(what)) {
    const n = store.items.length;
    clearMemories();
    return { ok: true, removed: n, all: true };
  }
  let best = null;
  let bestScore = 0;
  for (const it of store.items) {
    const sc = similarity(it.text, what);
    if (sc > bestScore) { bestScore = sc; best = it; }
  }
  if (best && bestScore >= 0.3) {
    removeMemory(best.id);
    return { ok: true, removed: 1, text: best.text };
  }
  // 没匹配到具体条目也要记住「不要再提这件事」
  store.tombstones = (store.tombstones || []).concat(normalizeText(what)).slice(-200);
  saveStore(store);
  return { ok: true, removed: 0, ignored: what };
}

// ── LLM 自动抽取 ────────────────────────────────────────────────
const EXTRACT_PROMPT_HEAD = [
  '你是一个信息抽取器。请从下面这段对话里，提取「值得长期记住的、关于用户的稳定事实」。',
  '',
  '只提取这些类别：',
  '- profile：稳定的基本情况（专业、年级、作息习惯等，不含姓名/学号/电话）',
  '- stressor：长期压力来源（如某门课、论文、实习、家庭期待）',
  '- preference：明确的偏好或不喜欢（如不喜欢被追问、喜欢具体建议）',
  '- relationship：重要的人际情况（如和室友关系紧张）',
  '- goal：用户表达过的目标或想改变的事',
  '- state：持续多轮的近期状态（如最近一直失眠）',
  '',
  '严格规则：',
  '1. 只提取用户自己说的、且可能在未来对话中还有用的信息；',
  '2. 不要提取一次性情绪、不要提取隐私身份信息（姓名、学校、学号、电话、住址）、不要提取任何诊断或病名；',
  '3. 每条不超过 30 个字，用第三人称陈述（例如「最近因为毕业论文焦虑」）；',
  '4. 最多 2 条；如果没有值得记的，返回空数组。',
  '',
  '只输出 JSON，不要任何解释：',
  '{"facts":[{"text":"...","category":"stressor"}]}'
].join(NL);

function buildExtractPrompt(userText, assistantText) {
  return EXTRACT_PROMPT_HEAD + NL + NL +
    '【用户说】' + NL + String(userText || '').slice(0, 500) + NL + NL +
    '【助手回】' + NL + String(assistantText || '').slice(0, 500);
}

function parseFacts(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (e) { return []; }
  const facts = obj && Array.isArray(obj.facts) ? obj.facts : [];
  return facts
    .filter(f => f && typeof f.text === 'string' && f.text.trim().length >= 2)
    .slice(0, 2)
    .map(f => ({
      text: truncate(f.text.trim(), MAX_TEXT_LEN),
      category: CATEGORIES.includes(f.category) ? f.category : 'other'
    }));
}

/**
 * 从一轮对话里抽取长期记忆。
 * @param {object} opts { userText, assistantText, callModel }
 *   callModel: async (prompt) => string，由上层注入（避免与 llm.js 循环依赖）
 */
async function extractFromTurn(opts) {
  const o = opts || {};
  const store = loadStore();
  if (store.enabled === false) return { ok: false, reason: 'disabled', added: [] };
  if (typeof o.callModel !== 'function') return { ok: false, reason: 'no_model', added: [] };
  let raw = '';
  try {
    raw = await o.callModel(buildExtractPrompt(o.userText, o.assistantText));
  } catch (e) {
    return { ok: false, reason: 'model_error', error: e.message, added: [] };
  }
  const facts = parseFacts(raw);
  const added = [];
  for (const f of facts) {
    const r = addMemory({ text: f.text, category: f.category, source: 'auto', confidence: 0.6 });
    if (r.ok) added.push(r.item);
  }
  return { ok: true, added, count: added.length };
}

module.exports = {
  MEMORY_FILE,
  CATEGORIES,
  CATEGORY_LABELS,
  loadStore,
  saveStore,
  listMemories,
  getStatus,
  addMemory,
  updateMemory,
  removeMemory,
  clearMemories,
  setEnabled,
  retrieveMemories,
  handleExplicitRemember,
  handleForget,
  extractFromTurn,
  buildExtractPrompt,
  parseFacts,
  similarity
};
