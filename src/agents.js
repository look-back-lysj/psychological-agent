/**
 * 心屿 · 多智能体内核
 *
 * 一轮对话的内部流水线（在规则层之后）：
 *   「观」Appraiser —— 读出情绪、需求、潜台词与节奏，并给出回复形态建议
 *   「书」Composer  —— 以人设口吻落笔（主生成，可流式）
 *   「校」Critic    —— 条件触发的自检与改写（像不像人、越没越界）
 *   「记」Archivist —— 异步记忆抽取（见 memory.js）
 *
 * 与规则层的关系（重要）：
 *   规则层守红线 —— 风险等级 L0—L3、危机/转介策略不可被模型推翻；
 *   模型层懂语境 —— 只允许在 S1/S2/S3/S4/S5 之间微调策略。
 *   冲突时：规则优先。
 *
 * 自适应三档（decideTier）：
 *   minimal  —— 风险 L0 且（去标点后 ≤6 字的寒暄/短应答，或与上一条用户消息相似度 ≥0.9）
 *               → 跳过「观」，只跑 1 次「书」；策略与表达形态仍由规则层 + fallbackPlan 决定；
 *   standard —— 其余 L0/L1/L2 → 「观」+「书」两次调用（现有行为）；
 *   reviewed —— 本地快检 localScreen() 发现问题后追加「校」，共 3 次（现有行为，由 chat.js 决定）。
 *   L3 危机不进入本档位：规则层走固定危机协议，不调用模型。
 * 安全永远优先：L2 必须 standard 以上，L3 固定协议；档位只影响「跑几次」，不影响策略与红线。
 */

const { callLLM } = require('./llm');
const { STRATEGY_META } = require('./strategy');
const { normalizeText } = require('./utils');

const AGENT_VERSION = 'v3.1'; // v3.1：新增自适应三档（minimal/standard/reviewed）与「观」结果缓存

/**
 * 是否启用多智能体流水线。
 * 设 XINYU_AGENTS=off 可退回单模型路径——用于 A/B 对照实验（证明「更像真人」）。
 */
function agentsEnabled() {
  return String(process.env.XINYU_AGENTS || '').toLowerCase() !== 'off';
}
const NL = String.fromCharCode(10);

// 允许模型微调的策略集合（S0 危机 / S6 转介 由规则层独占）
const MODEL_TUNABLE = ['S1_listen', 'S2_empathy', 'S3_clarify', 'S4_normalize', 'S5_action'];
const ALL_STRATEGIES = ['S0_crisis', 'S1_listen', 'S2_empathy', 'S3_clarify', 'S4_normalize', 'S5_action', 'S6_referral'];
const EMOTIONS = ['sad', 'anxious', 'angry', 'tired', 'lonely', 'calm', 'neutral', 'relieved', 'hopeful', 'happy', 'grateful'];
const NEEDS = ['listen', 'understand', 'advice', 'normalize', 'support', 'companionship'];

// ── 自适应档位判定 ─────────────────────────────────────────────
// 判定依据（只决定「跑几档」，不改变任何安全判定）：
//   1) L2 / L3：安全第一，必须 standard 以上；L3 更是直接走规则层固定危机协议。
//   2) L0 且去标点后 ≤6 字：典型寒暄/短应答（嗯、好、谢谢、在吗），信息量不足以支撑
//      一次「观」的收益，跳过；策略仍由规则层 chooseStrategy 给出，回复形态由 fallbackPlan + shape 提供。
//   3) L0 且与上一条用户消息相似度 ≥0.9：同一句话的重发/复述，语义信息已在上下文里，跳过「观」。
//   4) 其余（含 L1 的所有情况、较长的 L0）：走 standard 两段式，保持现有行为。
const TIER_MINIMAL_MAX_CHARS = 6;      // 去标点后的最大字数
const TIER_SIMILARITY_THRESHOLD = 0.9; // 与上一条用户消息的相似度阈值

/**
 * 文本相似度（0—1）：归一化后相等 / 互相包含 / 二元组 Jaccard。
 * 与记忆模块的口径保持一致（normalizeText 去掉空白、标点与零宽字符）。
 */
function textSimilarity(a, b) {
  try {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.includes(nb) || nb.includes(na)) return 0.9;
    const grams = (s) => {
      const set = new Set();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      if (s.length === 1) set.add(s);
      return set;
    };
    const sa = grams(na);
    const sb = grams(nb);
    let inter = 0;
    for (const g of sa) if (sb.has(g)) inter += 1;
    const union = sa.size + sb.size - inter;
    return union > 0 ? inter / union : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 组装档位结果 { tier, reason }。
 * 额外挂上非枚举的 toString / valueOf（值 = tier），便于日志与模板字符串直接插值，
 * 同时不影响 JSON.stringify / 深比较的结果。
 */
function tierResult(tier, reason) {
  const out = { tier, reason };
  try {
    Object.defineProperty(out, 'toString', { value: () => tier, enumerable: false });
    Object.defineProperty(out, 'valueOf', { value: () => tier, enumerable: false });
  } catch (e) { /* 忽略 */ }
  return out;
}

/**
 * 档位判定：返回 { tier: 'minimal' | 'standard', reason: 可直接展示的中文说明 }。
 * reviewed 不在本函数决定：它由生成后的本地快检 localScreen() 命中与否决定。
 * 该函数只读入参、不调用模型、不抛异常；任何异常都退回 standard（现有行为）。
 */
function decideTier(input) {
  try {
    const o = input || {};
    const riskLevel = String(o.riskLevel || 'L0');
    const raw = o.message == null ? '' : String(o.message);
    const normalized = normalizeText(raw);
    const charCount = normalized.length;

    // 1) 安全红线：L2 需要完整两段（避免漏掉转介线索），L3 走固定危机协议
    if (riskLevel === 'L3') {
      return tierResult('standard', '风险 L3：走规则层固定危机协议，档位不参与（不调用模型）');
    }
    if (riskLevel === 'L2') {
      return tierResult('standard', '风险 L2：需要完整「观」+「书」两段，避免漏掉转介线索');
    }

    // 2) minimal 的前提是 L0：L1 有持续身心信号，保留「观」以免漏读情绪
    if (riskLevel === 'L0' && charCount > 0 && charCount <= TIER_MINIMAL_MAX_CHARS) {
      return tierResult('minimal',
        '风险 L0，去标点后仅 ' + charCount + ' 字（≤' + TIER_MINIMAL_MAX_CHARS + '），属于寒暄/短应答：跳过「观」，按规则层策略直接回复');
    }

    // 3) L0 且与上一条用户消息几乎相同（相似度 ≥0.9）→ 复用上一轮语义
    if (riskLevel === 'L0' && o.lastUserMessage) {
      const sim = textSimilarity(raw, o.lastUserMessage);
      if (sim >= TIER_SIMILARITY_THRESHOLD) {
        return tierResult('minimal',
          '风险 L0，且与上一条用户消息相似度 ' + sim.toFixed(2) + '（≥' + TIER_SIMILARITY_THRESHOLD + '）：视为同一句话的重发/复述，跳过「观」');
      }
    }

    // 4) 其余：标准两段式
    if (riskLevel === 'L1') {
      return tierResult('standard', '风险 L1：需要「观」先读出情绪与需求，再落笔');
    }
    return tierResult('standard',
      '风险 L0，去标点后 ' + charCount + ' 字且与上一条不相似：需要「观」先定情绪与回复形态');
  } catch (e) {
    return tierResult('standard', '档位判定异常，退回标准「观」+「书」两段式');
  }
}

// ── 「观」提示词 ────────────────────────────────────────────────
const APPRAISE_SYSTEM = '你是一个只输出 JSON 的对话分析师，服务于一个面向大学生的情绪陪伴智能体。';

function buildAppraisePrompt(ctx) {
  const lines = [
    '请分析下面这句用户的话，只输出 JSON，不要任何解释。',
    '',
    '输出格式：',
    '{"emotion":"sad|anxious|angry|tired|lonely|calm|neutral|relieved|hopeful|happy|grateful",',
    ' "intensity":1到5的整数,',
    ' "need":"listen|understand|advice|normalize|support|companionship",',
    ' "subtext":"一句话说明他真正想说的是什么，20字以内",',
    ' "strategy_hint":"S1_listen|S2_empathy|S3_clarify|S4_normalize|S5_action 之一",',
    ' "ask_question":true或false,',
    ' "max_sentences":1到3的整数}',
    '',
    '判断要点：',
    '- 情绪强度看语气与用词，不要因为出现一个负面词就拉满；',
    '- 对方如果只是倾诉，need 用 listen 或 understand；明确要办法才用 advice；',
    '- 对方在怀疑自己「是不是不正常」时用 normalize；',
    '- ask_question：只在「问一个容易回答的小问题能帮到对方」时为 true，对方明显不想说时为 false。',
    '',
    '【最近几轮】'
  ];
  const recent = (ctx.recentTurns || []).slice(-3)
    .map(t => (t.role === 'assistant' ? '心屿：' : '用户：') + String(t.text || '').slice(0, 120));
  lines.push(recent.length ? recent.join(NL) : '（这是第一轮）');
  lines.push('');
  lines.push('【规则层已判定的风险等级】' + (ctx.riskLevel || 'L0'));
  lines.push('【规则层建议的策略】' + (ctx.strategyKey || 'S1_listen'));
  if (ctx.memories && ctx.memories.length) {
    lines.push('【与对方有关的长期记忆】' + ctx.memories.slice(0, 6).join('；'));
  }
  if (ctx.innerStateHint) lines.push('【内在状态】' + ctx.innerStateHint.replace(/\n/g, ' '));
  lines.push('');
  lines.push('【用户这句话】');
  lines.push(String(ctx.userText || '').slice(0, 600));
  return lines.join(NL);
}

/** 容错 JSON 抽取 */
function parseJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (e) { return null; }
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** 把模型输出归一化成可靠的 plan */
function normalizePlan(obj, ctx) {
  const o = obj || {};
  const emotion = EMOTIONS.includes(o.emotion) ? o.emotion : 'neutral';
  const intensity = clampInt(o.intensity, 1, 5, 3);
  const need = NEEDS.includes(o.need) ? o.need : 'understand';
  let hint = ALL_STRATEGIES.includes(o.strategy_hint) ? o.strategy_hint : null;
  // 规则层独占 S0 / S6：模型不得把普通轮次改成这两个
  if (hint && !MODEL_TUNABLE.includes(hint)) hint = null;
  if (hint && ctx && ctx.strategyKey === 'S6_referral') hint = null;
  return {
    emotion,
    intensity,
    need,
    subtext: typeof o.subtext === 'string' ? o.subtext.slice(0, 40) : '',
    strategyHint: hint,
    askQuestion: o.ask_question === true,
    maxSentences: clampInt(o.max_sentences, 1, 3, 2),
    degraded: false
  };
}

/** 降级 plan：不调用模型时的兜底（保持行为与单模型版本一致） */
function fallbackPlan(ctx, reason) {
  return {
    emotion: 'neutral',
    intensity: 3,
    need: 'understand',
    subtext: '',
    strategyHint: null,
    askQuestion: false,
    maxSentences: 2,
    degraded: true,
    degradeReason: reason || 'unknown'
  };
}

// ── 「观」结果缓存（同会话内复用，避免重复调用）────────────────
// 键为 normalizeText(message)，同一会话上限 20 条（超出按插入顺序淘汰最旧的），
// 会话数也设上限，避免长时间运行时无界增长。
const APPRAISE_CACHE_LIMIT = 20;      // 每个会话最多缓存 20 条「观」结果
const APPRAISE_CACHE_SESSIONS = 50;   // 最多跟踪 50 个会话
const appraiseCache = new Map();      // sessionId -> Map<normKey, { riskLevel, plan }>

function appraiseCacheKey(message) {
  try { return normalizeText(message) || String(message == null ? '' : message); } catch (e) { return String(message == null ? '' : message); }
}

/**
 * 读取缓存的「观」结果；未命中 / 风险等级不同 / 任何异常都返回 null（调用方自然回退到真实调用）。
 * 风险等级参与校验：风险变了（如 L0 → L2）不允许复用旧判断。
 */
function getCachedPlan(sessionId, message, riskLevel) {
  try {
    if (!sessionId) return null;
    const bucket = appraiseCache.get(sessionId);
    if (!bucket) return null;
    const key = appraiseCacheKey(message);
    const hit = bucket.get(key);
    if (!hit || !hit.plan) return null;
    if (hit.riskLevel !== String(riskLevel || 'L0')) return null;
    // 命中后移到队尾（简单 LRU）
    bucket.delete(key);
    bucket.set(key, hit);
    return Object.assign({}, hit.plan, { cached: true });
  } catch (e) {
    return null;
  }
}

/**
 * 写入缓存的「观」结果。只缓存成功的（degraded=false）结果：
 * 失败降级往往来自网络抖动，缓存它会让后续同样的话一直降级。
 */
function setCachedPlan(sessionId, message, riskLevel, plan) {
  try {
    if (!sessionId || !plan || plan.degraded) return;
    const key = appraiseCacheKey(message);
    if (!key) return;
    let bucket = appraiseCache.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      if (appraiseCache.size >= APPRAISE_CACHE_SESSIONS) {
        const oldest = appraiseCache.keys().next().value;
        appraiseCache.delete(oldest);
      }
      appraiseCache.set(sessionId, bucket);
    }
    if (bucket.has(key)) bucket.delete(key);
    bucket.set(key, { riskLevel: String(riskLevel || 'L0'), plan });
    while (bucket.size > APPRAISE_CACHE_LIMIT) {
      const oldestKey = bucket.keys().next().value;
      bucket.delete(oldestKey);
    }
  } catch (e) { /* 缓存失败不影响主流程 */ }
}

/** 清空缓存（测试 / 排查用） */
function clearAppraiseCache(sessionId) {
  try {
    if (sessionId) appraiseCache.delete(sessionId);
    else appraiseCache.clear();
  } catch (e) { /* 忽略 */ }
}

/**
 * 「观」：感知 + 定调。失败时返回降级 plan，绝不抛出。
 * 同会话内相同 message（normalizeText 后）且风险等级相同 → 直接复用缓存，不再调用模型。
 */
async function appraise(ctx) {
  const c = ctx || {};
  const cached = getCachedPlan(c.sessionId, c.userText, c.riskLevel);
  if (cached) return cached;
  if (!agentsEnabled()) return fallbackPlan(c, 'agents_off');
  try {
    const res = await callLLM(APPRAISE_SYSTEM, [{ role: 'user', text: buildAppraisePrompt(c) }], { retries: 0 });
    const obj = parseJsonObject(res && res.content);
    if (!obj) return fallbackPlan(c, 'bad_json');
    const plan = normalizePlan(obj, c);
    setCachedPlan(c.sessionId, c.userText, c.riskLevel, plan);
    return plan;
  } catch (e) {
    return fallbackPlan(c, (e && e.code) || (e && e.message) || 'error');
  }
}

/**
 * 策略裁决：规则层定风险，模型只在允许范围内微调策略。
 */
function resolveStrategy(ruleStrategy, plan) {
  if (!plan || !plan.strategyHint) return { key: ruleStrategy, changed: false, from: ruleStrategy };
  if (['S0_crisis', 'S6_referral'].includes(ruleStrategy)) return { key: ruleStrategy, changed: false, from: ruleStrategy };
  if (!MODEL_TUNABLE.includes(plan.strategyHint)) return { key: ruleStrategy, changed: false, from: ruleStrategy };
  // 只有当规则给出的也是可微调策略时才允许覆盖
  if (!MODEL_TUNABLE.includes(ruleStrategy)) return { key: ruleStrategy, changed: false, from: ruleStrategy };
  return { key: plan.strategyHint, changed: plan.strategyHint !== ruleStrategy, from: ruleStrategy };
}

// ── 本地快检：不花钱的第一道「校」──────────────────────────────
const AI_CLICHE = [
  '我完全理解', '我理解你的感受', '我懂你的感受', '一切都会好起来', '一切都会好的',
  '想开点', '别难过了', '你应该', '你必须', '加油', '你一定可以', '抱抱',
  '亲爱的', '宝贝', '作为ai', '作为一个ai', '我是ai', '我会一直在', '我永远陪着你',
  '往好处想', '这没什么大不了', '至少你还有'
];

/**
 * 快速本地筛查：返回问题列表（空数组 = 通过）。
 */
function localScreen(draft, plan, shape) {
  const text = String(draft || '').trim();
  const issues = [];
  if (!text) return ['empty'];
  const n = normalizeText(text);
  const maxChars = (shape && shape.maxChars) || 140;
  if (text.length > maxChars * 1.4) issues.push('too_long:' + text.length);
  const questionMarks = (text.match(/[?？]/g) || []).length;
  if (questionMarks > 1) issues.push('too_many_questions:' + questionMarks);
  for (const c of AI_CLICHE) {
    if (n.includes(normalizeText(c))) { issues.push('cliche:' + c); break; }
  }
  if (plan && plan.askQuestion === false && /[?？]\s*$/.test(text)) issues.push('asked_when_should_not');
  // 说话指纹硬约束（来自 106 条真实台词统计）
  if (/[!！]/.test(text)) issues.push('exclamation');
  if (text.indexOf('——') !== -1) issues.push('dash');
  const ellipsis = (text.match(/……/g) || []).length;
  if (ellipsis > 2) issues.push('too_many_ellipsis:' + ellipsis);
  if (text.indexOf('为什么') !== -1) issues.push('why_question');
  // 复述对方原话过多（超过 24 字连续重复）会显得机械
  return issues;
}

// ── 「校」提示词 ────────────────────────────────────────────────
const CRITIC_SYSTEM = '你是一个只输出 JSON 的中文对话审校员，负责检查回复是否像「心屿」且不越界。';

function buildCriticPrompt(ctx, draft) {
  return [
    '请审校下面这条回复，只输出 JSON，不要解释。',
    '',
    '输出格式：',
    '{"ok":true或false,"issues":["问题1","问题2"],"revised":"改写后的回复（ok 为 true 时可省略）"}',
    '',
    '检查清单（任一不通过就 ok=false）：',
    '1. 专有名词：出现黑海岸/泰缇斯/悲鸣/声骸/漂泊者等作品名词？改写。',
    '2. 称呼：出现亲爱的/宝/小可爱/主人，或「你是我唯一」式？删。',
    '3. 承诺类：出现「永远/一直/保证/一定/不会有事/我会记得」？降级为「现在/这一刻」。',
    '4. 标点：出现感叹号或破折号？归零。',
    '5. 长度：比用户上一条还长，或超过 3 句？砍短。',
    '6. 省略号配额：出现 3 处以上？压到 0—2 处。',
    '7. 问句：出现 2 个以上问号，或「为什么」式追问？只留 1 个是否型/选择型问句。',
    '8. 判断与诊断：给对方贴情绪或疾病标签，出现「你属于/你患有/症状」？删掉，改为复述对方原话。',
    '9. 确定性口吻：把推测说成事实（「你一定很…」）？改成保留说法。',
    '10. AI 腔：我完全理解你 / 一切都会好起来 / 想开点 / 别难过 / 加油 / 你应该…？删。',
    '',
    '改写原则（重要）：**只允许删减或做最小替换，不要重写风格、不要换一种人格**。',
    '如果原稿只是略长，就砍短；如果只是个别词不对，就只改那个词。宁可少改，不要把回复改得平淡。',
    '不要道歉，不要解释自己，不要添加新的安慰句。',
    '',
    '【用户说】' + String(ctx.userText || '').slice(0, 300),
    '【本轮策略】' + (ctx.strategyKey || ''),
    '【风险等级】' + (ctx.riskLevel || 'L0'),
    '【待审回复】' + String(draft || '').slice(0, 600)
  ].join(NL);
}

/**
 * 「校」：条件触发。失败时返回原稿，绝不阻塞。
 */
async function review(ctx, draft) {
  if (!agentsEnabled()) return { ok: true, revised: null, issues: [], degraded: true };
  try {
    const res = await callLLM(CRITIC_SYSTEM, [{ role: 'user', text: buildCriticPrompt(ctx, draft) }], { retries: 0 });
    const obj = parseJsonObject(res && res.content);
    if (!obj) return { ok: true, revised: null, issues: [], degraded: true };
    const issues = Array.isArray(obj.issues) ? obj.issues.slice(0, 4).map(String) : [];
    const revised = typeof obj.revised === 'string' && obj.revised.trim().length >= 4 ? obj.revised.trim() : null;
    return { ok: obj.ok !== false && !revised, revised, issues, degraded: false };
  } catch (e) {
    return { ok: true, revised: null, issues: [], degraded: true };
  }
}

module.exports = {
  AGENT_VERSION,
  agentsEnabled,
  MODEL_TUNABLE,
  AI_CLICHE,
  TIER_MINIMAL_MAX_CHARS,
  TIER_SIMILARITY_THRESHOLD,
  buildAppraisePrompt,
  buildCriticPrompt,
  parseJsonObject,
  normalizePlan,
  fallbackPlan,
  decideTier,
  textSimilarity,
  getCachedPlan,
  setCachedPlan,
  clearAppraiseCache,
  appraise,
  resolveStrategy,
  localScreen,
  review
};
