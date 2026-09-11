/**
 * 守岸人 · 长期记忆（本地、可控、可清除）
 *
 * 设计原则：
 * - 只存在本机 data/memory.json（已 gitignore），不上传、不入库；
 * - 用户可查看 / 编辑 / 删除 / 一键清空 / 关闭记忆；
 * - 只记「对陪伴有用」的稳定事实，不记身份信息、不记诊断、不记隐私细节；
 * - 召回按「归一化后加权合并」打分（相关度 + 重要性 + 新近度 + 置顶 − 重复惩罚）；
 * - 高敏感条目（sensitivity === 'high'）永不自动注入提示词（硬性隐私保证）。
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
const MAX_SUBJECT_LEN = 12;
const MAX_SLOT_LEN = 20;

// 分类：只保留对陪伴有用的类型
const CATEGORIES = ['profile', 'stressor', 'preference', 'relationship', 'goal', 'state', 'other'];
// 条目状态：active 在用 / superseded 被取代 / expired 已过期 / dormant 休眠
const ITEM_STATUSES = ['active', 'superseded', 'expired', 'dormant'];
const CATEGORY_LABELS = {
  profile: '基本情况',
  stressor: '压力来源',
  preference: '偏好',
  relationship: '人际关系',
  goal: '目标',
  state: '近期状态',
  other: '其它'
};

// slot 默认由 category 派生（抽取时可由模型给出更细的槽位名，如「毕业论文」「城市」）
const SLOT_BY_CATEGORY = {
  profile: 'profile',
  stressor: 'stressor',
  preference: 'preference',
  relationship: 'relationship',
  goal: 'goal',
  state: 'state',
  other: 'other'
};

// ── 时间 / 衰减参数 ────────────────────────────────────────────
// ⚠️ 90 / 365 天阈值都是本项目自定的工程选择，非文献阈值（文献里没有可直接引用的统一数值）。
//
// 关于「dormant 再 90 天 → expired」：若严格按「active 90d → dormant，再 90d → expired」
// 用同一个 lastUsedAt 锚点实现，会破坏 applyDecay 的幂等性——同一 (store, now) 调用两次，
// 第一次把 200 天的 active 变 dormant，第二次就会把它变 expired，结果不一致；
// 而且与验收里的「active 200 天 → dormant / 400 天 → expired」冲突（180 天阈值会让 200 天直接 expired）。
// 因此这里退化为「单一空闲阈值、只按 lastUsedAt/validFrom/createdAt 的绝对空闲时长判定」：
//   idle >= 90  → dormant（仅 active 且 importance<=0.4）
//   idle >= 365 → expired（仅 importance<=0.4）
// 这样既幂等、又同时满足验收的两个数据点；代价是第二阶段的「再 90 天」不再单独体现。
const DAY_MS = 86400000;
const DECAY_DORMANT_DAYS = 90;   // importance <= 0.4 且 90 天未命中 → dormant
const DECAY_EXPIRED_DAYS = 365;  // importance <= 0.4 且 365 天未命中 → expired（幂等的单一空闲阈值）
const DECAY_EXEMPT_IMPORTANCE = 0.8;      // importance >= 0.8 永不衰减
const DECAY_DORMANT_MAX_IMPORTANCE = 0.4; // 只有低重要性条目才允许休眠 / 过期

// ── 召回打分权重（便于日后做消融实验）──────────────────────────
// 出处：Mem0 官方开源实现 mem0/utils/scoring.py 采用「先把各路分数归一化、再加权合并」
//       （combined = (semantic + bm25 + entity_boost) / max_possible）。
// ⚠️ 这只是其开源实现的思路，Mem0 论文正文并未给出召回公式，不要在文档里写成「论文公式」。
const REL_HITS_NORM = 8;        // 相关度归一化：bigram 命中数 / 8 截断到 1
const TIME_DECAY_DAYS = 30;     // 新近度时间常数：exp(-Δ天 / 30)
const REPEAT_WINDOW_MS = DAY_MS; // 24h 内已注入过 → 去重惩罚
const RECALL_MAX_SCORE = 100;   // 统一量纲系数
const W_REL = 0.45;             // 相关度权重：与当前话题的贴合程度
const W_IMP = 0.25;             // 重要性权重：条目自身的重要程度
const W_TIME = 0.20;            // 新近度权重：越久没用越靠后
const W_PIN = 0.10;             // 置顶权重：用户显式置顶
const W_REP = 0.15;             // 重复惩罚：24h 内刚用过，降低复读
const RECALL_MIN_SCORE = 20;    // 硬门槛：归一化得分低于 20 直接不召回
const PINNED_GUARANTEE_MAX = 3; // 置顶硬保底条数（不参与打分竞争）
const PER_CATEGORY_MAX = 2;     // 每分类配额
const RECALL_TOTAL_MAX = 6;     // 单次召回总量上限

// 冲突候选的相似度下限（低于此值视为「不同的事」，都保留）。
// 取 0.3：像「住北京 / 住上海」这种「同槽位、换取值」的句子相似度约 0.33，
// 规则无法可靠判定互斥还是并存，因此放宽到能进入规则 4 的 LLM 兜底；同步路径仍保守「都保留」。
const CONFLICT_CANDIDATE_MIN = 0.3;

function now() { return Date.now(); }

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }
}

function emptyStore() {
  // ⚠️ 默认 **false**（关闭）。依《个人信息保护法》第 29 条，处理敏感个人信息
  // 需要「单独同意」。所以新装用户的记忆默认关闭，必须先在首启向导里明确勾选同意，
  // 前端才会调 POST /api/memory/enabled {enabled:true} 打开。
  // 这样就不存在「用户拒绝同意、后端却仍在抽取并写入记忆」的合规缺口。
  return { version: MEMORY_VERSION, enabled: false, updatedAt: now(), items: [], tombstones: [] };
}

/**
 * 读取记忆库。任何异常都降级为空库，绝不让服务崩。
 * 读取时会顺带跑一次幂等衰减（只改内存、不写盘，避免读操作产生副作用）。
 */
function loadStore() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return emptyStore();
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    const items = Array.isArray(parsed.items) ? parsed.items.filter(isValidItem).map(normalizeItem) : [];
    const store = {
      version: MEMORY_VERSION,
      // enabled 必须**显式**为 true 才算开启（默认关闭，需用户单独同意后才打开）；
      // 老文件里已有显式 true 的用户不受影响，会保持开启。
      enabled: parsed.enabled === true,
      updatedAt: Number(parsed.updatedAt) || now(),
      items,
      // tombstones 是「用户显式遗忘」，永久生效：不做截断，避免旧记录被挤掉后遗忘失效
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones.map(String).filter(Boolean) : []
    };
    applyDecay(store, now());
    return store;
  } catch (e) {
    return emptyStore();
  }
}

function isValidItem(it) {
  return it && typeof it === 'object' && typeof it.text === 'string' && it.text.trim().length > 0;
}

// subject 默认「用户」；slot 未给出时由 category 派生
function normSubject(s) {
  const v = String(s == null ? '' : s).trim();
  return v ? v.slice(0, MAX_SUBJECT_LEN) : '用户';
}

function deriveSlot(category, slot) {
  if (typeof slot === 'string' && slot.trim()) return slot.trim().slice(0, MAX_SLOT_LEN);
  const cat = CATEGORIES.includes(category) ? category : 'other';
  return SLOT_BY_CATEGORY[cat] || cat;
}

function normalizeValidTo(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

function normalizeItem(it) {
  const category = CATEGORIES.includes(it.category) ? it.category : 'other';
  const createdAt = Number(it.createdAt) || now();
  return {
    id: String(it.id || ('m_' + crypto.randomUUID().slice(0, 8))),
    text: truncate(String(it.text).trim(), MAX_TEXT_LEN),
    category,
    confidence: typeof it.confidence === 'number' ? Math.max(0, Math.min(1, it.confidence)) : 0.6,
    source: it.source === 'manual' ? 'manual' : 'auto',
    pinned: it.pinned === true,
    hits: Number(it.hits) || 0,
    importance: typeof it.importance === 'number' ? Math.max(0, Math.min(1, it.importance)) : 0.5,
    // 旧数据没有 sensitivity 时回落到 'normal'，兼容不报错
    sensitivity: it.sensitivity === 'high' ? 'high' : 'normal',
    subject: normSubject(it.subject),
    slot: deriveSlot(category, it.slot),
    valueType: it.valueType === 'multi' ? 'multi' : 'single',
    status: ITEM_STATUSES.includes(it.status) ? it.status : 'active',
    supersededBy: it.supersededBy ? String(it.supersededBy) : null,
    supersedes: Array.isArray(it.supersedes) ? it.supersedes.map(String).filter(Boolean) : [],
    // 双时间轴：validFrom 缺省回落到 createdAt（兼容旧数据），validTo=null 表示「仍成立」
    validFrom: Number(it.validFrom) || createdAt,
    validTo: normalizeValidTo(it.validTo),
    createdAt,
    lastUsedAt: Number(it.lastUsedAt) || 0
  };
}

// ── 记忆衰减（幂等、无需定时器）─────────────────────────────────
/**
 * 按当前时间推进衰减状态，只改状态、绝不删除条目。
 * - importance >= 0.8：永不衰减；
 * - importance <= 0.4 且 90 天未命中：dormant；
 * - importance <= 0.4 且 365 天未命中：expired 且 validTo = now（仅首次写入）；
 * - validTo 已过：expired（硬时序边界，优先级最高，任何 importance 都适用）。
 * 幂等性：同一 (store, now) 重复调用结果一致。为此「空闲时长」统一以
 *   max(createdAt, validFrom, lastUsedAt) 为锚点，且 active→dormant 与 dormant→expired
 *   使用互不重叠的阈值区间，已 superseded/expired 的条目不再改动。
 */
function applyDecay(store, nowTs) {
  const t = Number.isFinite(Number(nowTs)) ? Number(nowTs) : now();
  const items = (store && Array.isArray(store.items)) ? store.items : [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    // 已被取代 / 已过期：保持原样，保证 supersededBy 等可回溯信息不被覆盖
    if (it.status === 'superseded' || it.status === 'expired') continue;
    // 硬时序边界：validTo 已过 → expired
    if (it.validTo != null && it.validTo <= t) { it.status = 'expired'; continue; }
    // importance >= 0.8 永不衰减
    const imp = clamp01(it.importance);
    if (imp >= DECAY_EXEMPT_IMPORTANCE) continue;
    // 只有低重要性条目才参与衰减（0.4 ~ 0.8 的重要条目保持 active）
    if (imp > DECAY_DORMANT_MAX_IMPORTANCE) continue;
    // 「未命中」的锚点：取 createdAt / validFrom / lastUsedAt 中最晚的一次
    const anchor = Math.max(Number(it.createdAt) || 0, Number(it.validFrom) || 0, Number(it.lastUsedAt) || 0);
    const idleDays = (t - anchor) / DAY_MS;
    if (idleDays >= DECAY_EXPIRED_DAYS) {
      it.status = 'expired';
      if (it.validTo == null) it.validTo = t; // 只在首次写入，保证幂等
    } else if (it.status === 'active' && idleDays >= DECAY_DORMANT_DAYS) {
      it.status = 'dormant';
    }
  }
  return store;
}

// ── tombstones 合并（去重、不截断）─────────────────────────────────
function mergeTombstones(existing, texts) {
  const out = Array.isArray(existing) ? existing.map(String).filter(Boolean) : [];
  const seen = new Set(out);
  const list = Array.isArray(texts) ? texts : [texts];
  for (const t of list) {
    const s = String(t == null ? '' : t);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// ── 淘汰策略（按优先级，稳定、可重复）──────────────────────────────
// 越靠前越该丢：0=已失效(superseded/expired) 1=休眠(dormant) 2=正常
function dropRank(it) {
  if (!it) return 2;
  if (it.status === 'superseded' || it.status === 'expired') return 0;
  if (it.status === 'dormant') return 1;
  return 2;
}

function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// 淘汰比较器：状态 > 久未命中(lastUsedAt 最早，0/缺失=从未用过) > importance 最低 > createdAt 最早
// 末尾用 id 兜底，保证同样输入永远得到同样输出。
function compareDroppable(a, b) {
  const ra = dropRank(a);
  const rb = dropRank(b);
  if (ra !== rb) return ra - rb;
  const la = numOr(a && a.lastUsedAt, 0);
  const lb = numOr(b && b.lastUsedAt, 0);
  if (la !== lb) return la - lb;
  const ia = numOr(a && a.importance, 0.5);
  const ib = numOr(b && b.importance, 0.5);
  if (ia !== ib) return ia - ib;
  const ca = numOr(a && a.createdAt, 0);
  const cb = numOr(b && b.createdAt, 0);
  if (ca !== cb) return ca - cb;
  return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
}

/**
 * 按优先级淘汰超出上限的记忆，返回新的 items 数组（不修改入参）。
 * - pinned === true 的条目任何情况下都豁免；
 * - 其余按 compareDroppable 从最该丢的开始丢弃；
 * - 同样输入产生同样输出（稳定，无随机）。
 */
function pruneItems(items, max) {
  const list = Array.isArray(items) ? items : [];
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : MAX_ITEMS;
  if (list.length <= limit) return list.slice();
  const pinned = list.filter(it => it && it.pinned === true);
  const rest = list.filter(it => !(it && it.pinned === true));
  const room = Math.max(0, limit - pinned.length);
  const dropCount = Math.max(0, rest.length - room);
  const ordered = rest.slice().sort(compareDroppable);
  const doomed = new Set(ordered.slice(0, dropCount));
  return list.filter(it => !doomed.has(it));
}

// 把「旧条目被新条目取代」双向串起来：旧 → supersededBy=新 id；新 → supersedes 数组含旧 id
function linkSupersede(oldItem, newItem) {
  if (!oldItem || !newItem) return;
  oldItem.status = 'superseded';
  oldItem.supersededBy = newItem.id;
  if (!Array.isArray(newItem.supersedes)) newItem.supersedes = [];
  if (oldItem.id && !newItem.supersedes.includes(oldItem.id)) newItem.supersedes.push(oldItem.id);
}

function saveStore(store) {
  try {
    ensureDataDir();
    const payload = {
      version: MEMORY_VERSION,
      enabled: store.enabled !== false,
      updatedAt: now(),
      items: pruneItems(store.items || [], MAX_ITEMS),
      tombstones: mergeTombstones(store.tombstones, [])
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

/**
 * 二元组命中数：沿用原有相似度口径（逐位置判断 item 文本的相邻二字是否出现在 query 里）。
 * 用于召回公式的 Rel = min(1, bigramHits / 8)。
 */
function bigramHits(q, text) {
  const nText = normalizeText(text);
  let hits = 0;
  for (let i = 0; i < nText.length - 1; i++) {
    if (q.includes(nText.slice(i, i + 2))) hits += 1;
  }
  if (nText.length === 1 && q.includes(nText)) hits += 1;
  return hits;
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

// 常见反义极性对（「喜欢/讨厌」这类没有否定字的相反取值）
const ANTONYM_PAIRS = [
  ['喜欢', '讨厌'], ['想', '不想'], ['想要', '不想要'], ['愿意', '不愿意'],
  ['是', '不是'], ['会', '不会'], ['能', '不能'], ['有', '没有'],
  ['爱', '恨'], ['赞成', '反对'], ['接受', '拒绝'], ['同意', '不同意']
];

/**
 * 判断两条同槽位单值事实是否「互斥/相反」（规则可判定的那一类）。
 * ⚠️ 注意顺序：必须先于「等价合并」判断，因为 similarity('喜欢猫','不喜欢猫') 会因
 *    includes 快捷路径得到 0.9，若先做合并会把否定当成同义，造成结论反转丢失。
 */
function isMutuallyExclusive(a, b) {
  if (hasNegationFlip(a, b)) return true;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  for (const pair of ANTONYM_PAIRS) {
    const p = normalizeText(pair[0]);
    const n = normalizeText(pair[1]);
    const aP = na.includes(p), aN = na.includes(n);
    const bP = nb.includes(p), bN = nb.includes(n);
    if ((aP && bN) || (aN && bP)) {
      const strip = s => s.split(p).join('').split(n).join('');
      const sa = strip(na);
      const sb = strip(nb);
      if (sa && sb && similarity(sa, sb) >= 0.4) return true;
    }
  }
  return false;
}

// ── 冲突判定（先规则，后 LLM）──────────────────────────────────
function sameSubjectSlot(a, b) {
  if (!a || !b) return false;
  const sa = normSubject(a.subject);
  const sb = normSubject(b.subject);
  if (sa !== sb) return false;
  return deriveSlot(a.category, a.slot) === deriveSlot(b.category, b.slot);
}

// 时间区间是否重叠（null 表示「至今」/开区间）
function rangesOverlap(oldItem, newItem) {
  const oStart = numOr(oldItem.validFrom, numOr(oldItem.createdAt, 0));
  const oEnd = oldItem.validTo == null ? Infinity : numOr(oldItem.validTo, Infinity);
  const nStart = numOr(newItem.validFrom, numOr(newItem.createdAt, 0));
  const nEnd = newItem.validTo == null ? Infinity : numOr(newItem.validTo, Infinity);
  return oStart < nEnd && nStart < oEnd;
}

/**
 * 规则 3-互斥：同 subject + slot、都为单值、时间重叠或新条为 present、且取值互斥/相反。
 * 命中则用「旧条 validTo = 新条 validFrom」的失效语义（Graphiti：始终新信息优先）。
 */
function findExclusiveCandidate(store, incoming) {
  let best = null;
  let bestScore = -1;
  for (const it of (store.items || [])) {
    if (!it || it.status === 'superseded' || it.status === 'expired') continue;
    if (!sameSubjectSlot(it, incoming)) continue;
    // 单值槽位才谈得上互斥；多值槽位直接并存
    if (it.valueType === 'multi' || incoming.valueType === 'multi') continue;
    if (!isMutuallyExclusive(it.text, incoming.text)) continue;
    // 时间区间不重叠、且新条不是 present → 两条都保留
    if (!rangesOverlap(it, incoming) && incoming.validTo != null) continue;
    const sc = similarity(it.text, incoming.text);
    if (sc > bestScore) { bestScore = sc; best = it; }
  }
  return best;
}

/**
 * 规则 4 前置：同 subject + slot、单值、时间重叠/present、相似度达到可能「同一事实不同取值」，
 * 但规则无法判定互斥还是等价 → 交给异步链路用 LLM 判定（同步路径保守「都保留」，绝不丢数据）。
 */
function findVagueCandidate(store, incoming) {
  let best = null;
  let bestScore = 0;
  for (const it of (store.items || [])) {
    if (!it || it.status === 'superseded' || it.status === 'expired') continue;
    if (!sameSubjectSlot(it, incoming)) continue;
    if (it.valueType === 'multi' || incoming.valueType === 'multi') continue;
    if (!(rangesOverlap(it, incoming) || incoming.validTo == null)) continue;
    if (isMutuallyExclusive(it.text, incoming.text)) continue; // 互斥已在上一步处理
    const sc = similarity(it.text, incoming.text);
    if (sc >= CONFLICT_CANDIDATE_MIN && sc > bestScore) { bestScore = sc; best = it; }
  }
  return best;
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
 * 新增一条记忆。
 * 冲突处理按「先规则、后 LLM」短路：互斥 → 更新；等价 → NOOP；规则拿不准 → 保留新条并标记待 LLM。
 * 只改旧条状态/时间（不物理删除），保证可回溯。
 *
 * 兼容性：可选字段 sensitivity / importance / subject / slot / valueType / validFrom / validTo
 * 不传时按默认值处理；返回结构在原有 {ok, item, merged} 基础上只做「新增字段」，不改变旧字段。
 */
function addMemory(opts) {
  const o = opts || {};
  const clean = truncate(String(o.text == null ? '' : o.text).trim(), MAX_TEXT_LEN);
  if (!clean) return { ok: false, error: '内容为空' };

  const source = o.source === 'manual' ? 'manual' : 'auto';
  const category = CATEGORIES.includes(o.category) ? o.category : 'other';
  const confidence = typeof o.confidence === 'number' ? o.confidence : (source === 'manual' ? 1 : 0.6);
  // 校验：sensitivity 只允许 normal|high（其它值一律归 normal）
  const sensitivity = o.sensitivity === 'high' ? 'high' : 'normal';
  // 校验：importance 必须是 0..1 的数字，非法则默认 0.5
  const importance = (typeof o.importance === 'number' && Number.isFinite(o.importance))
    ? Math.max(0, Math.min(1, o.importance)) : 0.5;
  const validFrom = (typeof o.validFrom === 'number' && Number.isFinite(o.validFrom)) ? o.validFrom : now();
  const validTo = normalizeValidTo(o.validTo);

  const store = loadStore();
  const key = normalizeText(clean);
  if ((store.tombstones || []).some(t => t === key)) return { ok: false, error: '该内容已被用户遗忘' };

  const incoming = normalizeItem({
    id: 'm_' + crypto.randomUUID().slice(0, 8),
    text: clean,
    category,
    confidence,
    source,
    pinned: o.pinned === true,
    hits: 0,
    importance,
    sensitivity,
    subject: o.subject,
    slot: o.slot,
    valueType: o.valueType,
    validFrom,
    validTo,
    createdAt: now(),
    lastUsedAt: 0
  });

  // ── 规则 3-互斥（必须先于等价合并，避免把否定当同义）→ 更新 ──
  const exclusive = findExclusiveCandidate(store, incoming);
  if (exclusive) {
    exclusive.validTo = incoming.validFrom; // 旧边失效时间 = 使新边生效的时间
    linkSupersede(exclusive, incoming);     // status / supersededBy(真实 id) / supersedes 回填
    store.items = store.items.map(it => (it.id === exclusive.id ? exclusive : it));
    store.items.push(incoming);
    saveStore(store);
    return { ok: true, item: incoming, merged: false, resolution: 'superseded' };
  }

  // ── 规则 3-等价：同槽位近似同义 → NOOP（只累加 hits、刷新 confidence，不改文本）──
  const similar = findSimilar(store, clean);
  if (similar && sameSubjectSlot(similar, incoming)) {
    similar.hits = numOr(similar.hits, 0) + 1;
    if (source === 'manual') { similar.source = 'manual'; similar.confidence = 1; }
    else { similar.confidence = Math.max(numOr(similar.confidence, 0.6), confidence); }
    if (o.pinned === true) similar.pinned = true;
    if (sensitivity === 'high') similar.sensitivity = 'high'; // 敏感度只升不降，避免隐私降级
    similar.importance = Math.max(numOr(similar.importance, 0.5), importance);
    if (similar.status === 'dormant') similar.status = 'active'; // 再次被提到 → 复活
    store.items = store.items.map(it => (it.id === similar.id ? similar : it));
    saveStore(store);
    return { ok: true, item: similar, merged: true, resolution: 'equivalent' };
  }

  // ── 规则 1：subject+slot 不同 → 两件不同的事，都保留 ──
  // ── 规则 2：valueType='multi' → 都保留 ──
  // 上面两条由 findExclusiveCandidate / findVagueCandidate 内部短路。
  const vague = findVagueCandidate(store, incoming);
  store.items.push(incoming);
  saveStore(store);
  if (vague) {
    // ── 规则 4：规则拿不准 → 保留新条（不丢数据），交异步链路用 LLM 判定 ──
    return {
      ok: true, item: incoming, merged: false, resolution: 'pending-llm',
      conflict: {
        pending: true,
        oldId: vague.id, oldText: vague.text,
        newId: incoming.id, newText: clean,
        category, subject: incoming.subject, slot: incoming.slot
      }
    };
  }
  return { ok: true, item: incoming, merged: false, resolution: 'new' };
}

function updateMemory(id, patch) {
  const store = loadStore();
  const idx = store.items.findIndex(it => it.id === id);
  if (idx === -1) return { ok: false, error: '未找到该记忆' };
  const it = store.items[idx];
  if (patch && typeof patch.text === 'string' && patch.text.trim()) it.text = truncate(patch.text.trim(), MAX_TEXT_LEN);
  if (patch && CATEGORIES.includes(patch.category)) it.category = patch.category;
  if (patch && typeof patch.pinned === 'boolean') it.pinned = patch.pinned;
  if (patch && typeof patch.importance === 'number' && Number.isFinite(patch.importance)) it.importance = clamp01(patch.importance);
  if (patch && (patch.sensitivity === 'high' || patch.sensitivity === 'normal')) it.sensitivity = patch.sensitivity;
  if (patch && typeof patch.subject === 'string' && patch.subject.trim()) it.subject = normSubject(patch.subject);
  if (patch && typeof patch.slot === 'string' && patch.slot.trim()) it.slot = deriveSlot(it.category, patch.slot);
  if (patch && (patch.valueType === 'single' || patch.valueType === 'multi')) it.valueType = patch.valueType;
  if (patch && 'validTo' in patch) it.validTo = normalizeValidTo(patch.validTo);
  store.items[idx] = it;
  saveStore(store);
  return { ok: true, item: it };
}

function removeMemory(id) {
  const store = loadStore();
  const target = store.items.find(it => it.id === id);
  if (!target) return { ok: false, error: '未找到该记忆' };
  store.items = store.items.filter(it => it.id !== id);
  store.tombstones = mergeTombstones(store.tombstones, [normalizeText(target.text)]);
  saveStore(store);
  return { ok: true, removed: target.text };
}

function clearMemories() {
  const store = loadStore();
  store.tombstones = mergeTombstones(store.tombstones, store.items.map(it => normalizeText(it.text)));
  store.items = [];
  saveStore(store);
  return { ok: true };
}

/**
 * 记忆开关。
 * ⚠️ 破坏性操作：《个人信息保护法》第 47 条要求「处理目的不再必要时应主动删除」，
 *    因此 setEnabled(false) 会同时清空所有条目并真正写空文件（不是只把 enabled 置 false）。
 *    这里不写 tombstones —— tombstones 语义是「用户显式遗忘某内容」，与「关闭记忆」不同。
 *    再次 setEnabled(true) 是干净起点。前端「关闭开关」必须加二次确认！
 */
function setEnabled(enabled) {
  const store = loadStore();
  store.enabled = enabled !== false;
  if (store.enabled === false) store.items = []; // 关闭即清空（破坏性）
  saveStore(store);
  return { ok: true, enabled: store.enabled };
}

// ── 召回 ────────────────────────────────────────────────────────
/**
 * 归一化加权打分（Mem0 开源实现思路，非论文公式）：
 *   Rel  = min(1, bigramHits(q, m.text) / 8)
 *   Imp  = m.importance
 *   Time = exp(-Δ天 / 30)，Δ天 = (t - max(lastUsedAt, validFrom)) / 86400000
 *   Pin  = pinned ? 1 : 0
 *   Rep  = (t - lastUsedAt) < 24h ? 1 : 0
 *   score = 100 × (0.45·Rel + 0.25·Imp + 0.20·Time + 0.10·Pin − 0.15·Rep)
 *
 * 硬门槛（不满足直接不召回）：status==='active'、validTo 未过、sensitivity!=='high'、score>=20。
 * 置顶硬保底（最多 3 条，不参与打分竞争）；沿用每分类 ≤2、总量 ≤6 的配额。
 *
 * 🔒 隐私硬性保证：sensitivity==='high' 的条目永不自动注入提示词。
 *    这是依《个人信息保护法》对「敏感个人信息」从严处理的硬边界：
 *    高敏感内容（身心健康、创伤、性取向、家庭暴力、自伤念头等）只在用户主动查看时可见，
 *    绝不随提示词自动送给模型。任何后续修改都不得移除此过滤！
 */
function retrieveMemories(query, options) {
  const opts = options || {};
  const rawLimit = Number.isFinite(Number(opts.limit)) ? Math.floor(Number(opts.limit)) : RECALL_TOTAL_MAX;
  const limit = Math.max(0, Math.min(RECALL_TOTAL_MAX, rawLimit));
  const store = loadStore();
  applyDecay(store, now()); // 幂等：读取后、召回前再推一次衰减
  if (store.enabled === false || !store.items.length || limit === 0) return [];
  const t = now();
  const q = normalizeText(query || '');

  const scored = [];
  const pinnedPool = [];
  for (const it of store.items) {
    // ── 硬门槛 1/2/3 ──
    if (it.status !== 'active') continue;                                   // 1. 只用 active
    if (!(it.validTo === null || it.validTo > t)) continue;                 // 2. validTo 未过
    if (it.sensitivity === 'high') continue;                                // 3. 🔒 高敏感永不注入
    // ── 硬门槛 5：置顶硬保底，不参与打分竞争 ──
    if (it.pinned) { pinnedPool.push(it); continue; }

    const rel = q ? Math.min(1, bigramHits(q, it.text) / REL_HITS_NORM) : 0;
    const imp = clamp01(it.importance);
    const anchor = Math.max(numOr(it.lastUsedAt, 0), numOr(it.validFrom, it.createdAt));
    const deltaDays = (t - anchor) / DAY_MS;
    const time = Math.exp(-deltaDays / TIME_DECAY_DAYS);
    const pin = 0; // 非置顶
    const rep = (it.lastUsedAt && (t - it.lastUsedAt) < REPEAT_WINDOW_MS) ? 1 : 0;
    const score = RECALL_MAX_SCORE * (W_REL * rel + W_IMP * imp + W_TIME * time + W_PIN * pin - W_REP * rep);
    // ── 硬门槛 4：归一化得分门槛 ──
    if (score < RECALL_MIN_SCORE) continue;
    scored.push({ item: it, score });
  }
  scored.sort((a, b) => (b.score - a.score) || String(a.item.id).localeCompare(String(b.item.id)));

  // 置顶最近使用的优先（最多 3 条）
  pinnedPool.sort((a, b) =>
    (numOr(b.lastUsedAt, 0) || numOr(b.createdAt, 0)) - (numOr(a.lastUsedAt, 0) || numOr(a.createdAt, 0)));

  // ── 硬门槛 6：配额（置顶豁免分类配额）──
  const picked = [];
  for (const it of pinnedPool) {
    if (picked.length >= limit || picked.length >= PINNED_GUARANTEE_MAX) break;
    picked.push(it);
  }
  const perCategory = {};
  for (const s of scored) {
    if (picked.length >= limit) break;
    const it = s.item;
    const c = it.category || 'other';
    if ((perCategory[c] || 0) >= PER_CATEGORY_MAX) continue;
    perCategory[c] = (perCategory[c] || 0) + 1;
    picked.push(it);
  }

  // 记录使用：lastUsedAt/hits 更新；dormant 被注入 → 复活为 active
  if (picked.length) {
    const ids = new Set(picked.map(p => p.id));
    const st = loadStore();
    let changed = false;
    for (const it of st.items) {
      if (ids.has(it.id)) {
        it.lastUsedAt = t;
        it.hits = (it.hits || 0) + 1;
        if (it.status === 'dormant') it.status = 'active';
        changed = true;
      }
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
  store.tombstones = mergeTombstones(store.tombstones, [normalizeText(what)]);
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
  '每条事实请附带下面的字段（不确定就留空或省略）：',
  '- subject：事实的主体，一般是「用户」；涉及他人时填对方称呼（如「室友」）；',
  '- slot：该事实所属的细分槽位（如「专业」「毕业论文」「对追问的偏好」）。同一 subject + slot 的新说法会覆盖旧说法；',
  '- valueType：只会有一个取值的填 "single"（如专业、年级）；可以并存多条同槽位事实的填 "multi"（如喜欢的食物）；默认 "single"；',
  '- sensitivity：涉及身心健康、创伤、隐私、性取向、家庭暴力、自伤念头等敏感内容填 "high"，普通偏好/计划填 "normal"；',
  '- importance：0 到 1 的数字，越重要越高（长期压力约 0.8，随口偏好约 0.4）；',
  '- validFrom / validTo：事实成立/失效的毫秒时间戳，不确定就填 null。',
  '',
  '只输出 JSON，不要任何解释：',
  '{"facts":[{"text":"最近因为毕业论文焦虑","category":"stressor","subject":"用户","slot":"毕业论文","valueType":"single","sensitivity":"normal","importance":0.8,"validFrom":null,"validTo":null}]}'
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
      category: CATEGORIES.includes(f.category) ? f.category : 'other',
      // 类型校验：非法值一律回落到安全默认
      subject: (typeof f.subject === 'string' && f.subject.trim()) ? f.subject.trim().slice(0, MAX_SUBJECT_LEN) : '用户',
      slot: (typeof f.slot === 'string' && f.slot.trim()) ? f.slot.trim().slice(0, MAX_SLOT_LEN) : null,
      valueType: f.valueType === 'multi' ? 'multi' : 'single',
      sensitivity: f.sensitivity === 'high' ? 'high' : 'normal',
      importance: (typeof f.importance === 'number' && Number.isFinite(f.importance)) ? clamp01(f.importance) : 0.5,
      validFrom: (typeof f.validFrom === 'number' && Number.isFinite(f.validFrom)) ? f.validFrom : null,
      validTo: (typeof f.validTo === 'number' && Number.isFinite(f.validTo)) ? f.validTo : null
    }));
}

// ── 冲突判定的 LLM 兜底（只有规则拿不准时才走这里）──────────────
const CONFLICT_PROMPT_HEAD = [
  '你是记忆冲突判定器。下面两条事实来自同一主体、同一记忆槽位。',
  '请判断新事实是否与旧事实互相矛盾（同一时间只能成立一个）。',
  '只输出 JSON，不要解释：',
  '- 矛盾、应让新事实取代旧事实：{"verdict":"update"}',
  '- 并不矛盾、两条都应保留：{"verdict":"keep"}'
].join(NL);

function buildConflictPrompt(oldText, newText) {
  return CONFLICT_PROMPT_HEAD + NL + NL +
    '【旧事实】' + NL + String(oldText || '').slice(0, 120) + NL + NL +
    '【新事实】' + NL + String(newText || '').slice(0, 120);
}

function parseConflictVerdict(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/"verdict"\s*:\s*"(update|keep)"/i);
  if (m) return m[1].toLowerCase();
  if (raw.includes('update') || raw.includes('取代')) return 'update';
  if (raw.includes('keep') || raw.includes('保留')) return 'keep';
  return null;
}

/**
 * 规则拿不准的冲突 → 交 LLM 判定。只可能把旧条置为 superseded，绝不物理删除。
 * @param {object} pending addMemory 返回的 conflict 信息
 * @param {function} callModel async (prompt) => string
 */
async function resolveConflict(pending, callModel) {
  try {
    if (!pending || !pending.oldId || !pending.newId) return { ok: false, reason: 'bad_input' };
    if (typeof callModel !== 'function') return { ok: false, reason: 'no_model' };
    const raw = await callModel(buildConflictPrompt(pending.oldText, pending.newText));
    const verdict = parseConflictVerdict(raw);
    if (!verdict) return { ok: false, reason: 'unparsed' };
    if (verdict !== 'update') return { ok: true, action: 'keep' };
    const store = loadStore();
    const oldItem = store.items.find(it => it.id === pending.oldId);
    const newItem = store.items.find(it => it.id === pending.newId);
    if (!oldItem || !newItem) return { ok: false, reason: 'missing' };
    oldItem.validTo = numOr(newItem.validFrom, now());
    linkSupersede(oldItem, newItem);
    saveStore(store);
    return { ok: true, action: 'update' };
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message };
  }
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
  const conflicts = [];
  for (const f of facts) {
    // 把 LLM 抽取出的 sensitivity / importance / 时序 / 槽位字段一并落库
    const r = addMemory({
      text: f.text,
      category: f.category,
      source: 'auto',
      confidence: 0.6,
      sensitivity: f.sensitivity,
      importance: f.importance,
      subject: f.subject,
      slot: f.slot,
      valueType: f.valueType,
      validFrom: f.validFrom,
      validTo: f.validTo
    });
    if (r.ok) {
      added.push(r.item);
      if (r.conflict && r.conflict.pending) conflicts.push(r.conflict);
    }
  }
  // 规则拿不准的冲突 → 才调 LLM 判定（每条最多一次，省钱且更稳）
  const resolved = [];
  for (const c of conflicts) {
    const rr = await resolveConflict(c, o.callModel);
    if (rr && rr.ok) resolved.push({ id: c.newId, action: rr.action });
  }
  return { ok: true, added, count: added.length, conflicts: resolved };
}

module.exports = {
  MEMORY_FILE,
  MAX_ITEMS,
  CATEGORIES,
  CATEGORY_LABELS,
  loadStore,
  saveStore,
  pruneItems,
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
  similarity,
  // 新增导出（不改动既有导出）
  applyDecay,
  isMutuallyExclusive,
  buildConflictPrompt,
  resolveConflict,
  bigramHits
};
