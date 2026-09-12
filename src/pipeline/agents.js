/**
 * 模块：pipeline/agents —— 多智能体内核（观 / 校 / 档位 / 策略裁决）
 * 层级：pipeline L3（装配）
 * 职责：实现 appraise（观）、review（校）、decideTier、localScreen、resolveStrategy、fallbackPlan 与结果缓存。
 * 依赖：infra/llm（callLLM）、strategy（STRATEGY_META）、core/utils、safety（checkOutputSafety）
 * 被依赖：chat/pipeline
 * 改动风险：🟡 中 —— node --check + node tests/run.js
 * 契约：AGENT_VERSION、appraise / review / decideTier / localScreen / resolveStrategy / fallbackPlan / getCachedPlan / isSafetyIssue / isSafetyDraft 的导出名与返回字段
 * 不要做什么：
 *   1) 不要把「校」当成安全兜底（安全兜底是 chat/pipeline 每轮都跑的 checkOutputSafety）
 *   2) 不要改 callLLM(prompt, messages) 的调用契约
 */
/**
 * 守岸人 · 多智能体内核
 *
 * 一轮对话的内部流水线（在规则层之后）：
 *   「观」Appraiser —— 读出情绪、需求、潜台词与节奏，并给出回复形态建议
 *   「书」Composer  —— 以人设口吻落笔（主生成，可流式）
 *   「校」Rewriter —— 本地规则命中才触发的直接重写（不输出评审意见，只给修正稿）
 *   「记」Archivist —— 异步记忆抽取（见 memory.js）
 *
 * 与规则层的关系（重要）：
 *   规则层守红线 —— 风险等级 L0—L3、危机/转介策略不可被模型推翻；
 *   模型层懂语境 —— 只允许在 S1/S2/S3/S4/S5 之间微调策略。
 *   冲突时：规则优先。
 *
 * 自适应三档（decideTier）：
 *   minimal  —— 风险 L0 且满足任一「无需判断」条件时跳过「观」，只跑 1 次「书」：
 *               ① 去标点后 ≤6 字的寒暄 / 短应答（嗯、好、谢谢、在吗）；
 *               ② 去标点后为空（纯标点 / 空白 / 零宽字符）；
 *               ③ 去标点后 ≤12 字且只由同一个字符重复组成（嗯嗯嗯嗯嗯嗯嗯 / 😂😂😂😂）；
 *               ④ 与上一条用户消息相似度 ≥0.9（同一句话的重发 / 复述）。
 *               策略与表达形态仍由规则层 + fallbackPlan 决定；
 *   standard —— 其余 L0/L1/L2 → 「观」+「书」两次调用（现有行为）；
 *   reviewed —— 「书」出稿后经本地快检 localScreen() 命中，才追加「校」，由 chat.js 决定；
 *               本地未命中时**不再**调用「校」。「校」的职责是直接重写，不是自我批评（v3.2）。
 *   L3 危机不进入本档位：规则层走固定危机协议，不调用模型。
 * 安全永远优先：L2 必须 standard 以上，L3 固定协议；档位只影响「跑几次」，不影响策略与红线。
 *   「校」不是安全兜底：安全兜底是 chat.js 里每一轮都跑的 checkOutputSafety()。
 */

const { callLLM } = require('../infra/llm');
const { STRATEGY_META } = require('../strategy');
const { normalizeText } = require('../core/utils');
const { checkOutputSafety } = require('../safety');

// v3.2：①「校」明确为「仅本地命中才调用、且只做重写」；②补两条 L0 低信息量跳过「观」的条件
//       （去标点后为空 / 同一字符重复 ≤12 字）；③新增 isSafetyIssue() 供调用点标注安全类命中。
const AGENT_VERSION = 'v3.3';

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
//   3) L0 且去标点后为空（纯标点 / 空白 / 零宽字符）：没有任何可判读的语义，跳过。
//   4) L0 且去标点后 ≤12 字且只由同一个字符重复组成（嗯嗯嗯嗯嗯嗯嗯 / 😂😂😂😂）：低信息量应答，跳过。
//   5) L0 且与上一条用户消息相似度 ≥0.9：同一句话的重发/复述，语义信息已在上下文里，跳过「观」。
//   6) 其余（含 L1 的所有情况、较长的 L0）：走 standard 两段式，保持现有行为。
const TIER_MINIMAL_MAX_CHARS = 6;      // 去标点后的最大字数
const TIER_REPEAT_MAX_CHARS = 12;      // 「同一字符重复」视为低信息量的字数上限
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
 * 是否「同一字符重复」的低信息量消息（嗯嗯嗯嗯嗯嗯嗯 / 😂😂😂😂 / 。。。。已由 charCount=0 分支覆盖）。
 * 判定用码点而非 UTF-16 长度，否则一个表情（代理对）会被算成 2 个字符。
 * 只在 riskLevel === 'L0' 时被调用；任何异常返回 false（宁可多跑一次「观」）。
 */
function isSingleCharRepetition(text) {
  try {
    const cps = Array.from(normalizeText(text));
    if (!cps.length || cps.length > TIER_REPEAT_MAX_CHARS) return false;
    const first = cps[0];
    for (const ch of cps) if (ch !== first) return false;
    return true;
  } catch (e) {
    return false;
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

    // 3) L0 且去标点后为空（纯标点 / 空白 / 零宽字符）→ 没有可判读的语义，跳过「观」
    if (riskLevel === 'L0' && charCount === 0) {
      return tierResult('minimal',
        '风险 L0，去标点后无文字内容（纯标点/空白/零宽字符）：没有可判读的语义，跳过「观」，按规则层策略直接回复');
    }

    // 4) L0 且去标点后 ≤12 字、且只由同一个字符重复组成 → 低信息量重复应答，跳过「观」
    if (riskLevel === 'L0' && isSingleCharRepetition(raw)) {
      return tierResult('minimal',
        '风险 L0，去标点后 ' + charCount + ' 字且为同一字符重复（≤' + TIER_REPEAT_MAX_CHARS + ' 字）：低信息量应答，跳过「观」');
    }

    // 5) L0 且与上一条用户消息几乎相同（相似度 ≥0.9）→ 复用上一轮语义
    if (riskLevel === 'L0' && o.lastUserMessage) {
      const sim = textSimilarity(raw, o.lastUserMessage);
      if (sim >= TIER_SIMILARITY_THRESHOLD) {
        return tierResult('minimal',
          '风险 L0，且与上一条用户消息相似度 ' + sim.toFixed(2) + '（≥' + TIER_SIMILARITY_THRESHOLD + '）：视为同一句话的重发/复述，跳过「观」');
      }
    }

    // 6) 其余：标准两段式
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
    ' "topic":"用6个字以内概括他现在在说的那件事",',
    ' "subtext":"一句话说明他真正想说的是什么，30字以内",',
    ' "strategy_hint":"S1_listen|S2_empathy|S3_clarify|S4_normalize|S5_action 之一",',
    ' "initiative":0到3的整数,',
    ' "suggested_direction":"如果这一轮要主动一点，可以往哪带一句；没有就空字符串",',
    ' "ask_question":true或false或null,',
    ' "max_sentences":1到5的整数}',
    '',
    '判断要点：',
    '- 情绪强度看语气与用词，不要因为出现一个负面词就拉满；',
    '- 对方如果只是倾诉，need 用 listen 或 understand；明确要办法才用 advice；',
    '- 对方在怀疑自己「是不是不正常」时用 normalize；',
    '- initiative：0=只在场/承接；1=做一个复杂反映或具体观察；2=在反映之后提出一个可选观察或方向；3=对方明确要办法时，给一个协作小步或 2—3 个很轻的选项。不要只根据字数给高级别。',
    '- suggested_direction：只能是一个很轻的方向，不能是命令、诊断或未经请求的建议；没把握就留空。',
    '- ask_question：只在「问一个具体、容易回答的问题确实能帮到对方」时为 true；对方明显不想说话、或刚被问题刺痛时为 false；拿不准用 null，不要默认 true。',
    '- max_sentences：对方只回很短、情绪很强 → 1—2；叙事或求助 → 3—5。',
    '',
    '【最近几轮】'
  ];
  const recent = (ctx.recentTurns || []).slice(-4)
    .map(t => (t.role === 'assistant' ? '守岸人：' : '用户：') + String(t.text || '').slice(0, 300));
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
  const askQuestion = o.ask_question === true ? true : (o.ask_question === false ? false : null);
  return {
    emotion,
    intensity,
    need,
    topic: typeof o.topic === 'string' ? o.topic.slice(0, 20) : '',
    subtext: typeof o.subtext === 'string' ? o.subtext.slice(0, 60) : '',
    strategyHint: hint,
    initiative: clampInt(o.initiative, 0, 3, 1),
    direction: typeof o.suggested_direction === 'string' ? o.suggested_direction.slice(0, 60) : '',
    askQuestion,
    maxSentences: clampInt(o.max_sentences, 1, 5, 3),
    degraded: false
  };
}

/** 降级 plan：不调用模型时的兜底（保持行为与单模型版本一致） */
function fallbackPlan(ctx, reason) {
  return {
    emotion: 'neutral',
    intensity: 3,
    need: 'understand',
    topic: '',
    subtext: '',
    strategyHint: null,
    initiative: 1,
    direction: '',
    askQuestion: null,
    maxSentences: 3,
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
  const maxChars = (shape && shape.maxChars) || 180;
  // 上限是「说话形态」的软护栏，不是逐字裁切；只有明显超出才触发重写。
  const tooLongLimit = Math.max(maxChars + 80, Math.round(maxChars * 1.5));
  if (text.length > tooLongLimit) issues.push('too_long:' + text.length);
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

// ── 本地命中的「安全类」判定（不改 localScreen 语义，只做标注）────
// localScreen 报出的绝大多数是风格 / 人格问题；其中「亲昵称呼」与「永久承诺」两类
// 与 safety.js 的 OUTPUT_BLOCK_PATTERNS 直接重叠，属于安全类。
//
// 注意：localScreen 只报「第一个命中的 cliche」（循环里 break），所以安全类 cliche
// 可能被前面别的 cliche 掩盖（例：「一切都会好起来」在前，「亲爱的」就不出现在 issues 里）。
// 因此判定安全类时的权威口径是 isSafetyDraft()：直接复用 safety.js 的后置检查，
// 只要这条草稿会被 checkOutputSafety 拦下，就算安全类。
//
// 安全底线说明（重要）：
//   1) 安全类命中时「校」会照常被调用（任何命中都会调）；
//   2) 即便「校」降级 / 未配置而返回原稿，chat.js 每一轮都会独立跑 checkOutputSafety()，
//      「亲爱的」「我会一直在」这类内容会被它直接拦下并换成固定话术；
//   3) 所以「少调一次「校」」不会降低安全性 —— 「校」是质量兜底，安全兜底始终是 checkOutputSafety()。
const SAFETY_CLICHES = ['亲爱的', '宝贝', '我会一直在', '我永远陪着你'];

/** issue 字符串级：这条 localScreen 问题是不是安全类。 */
function isSafetyIssue(issue) {
  const s = String(issue == null ? '' : issue);
  if (s === 'empty') return true; // 空输出由 safety.js 的 empty_output 兜底
  if (s.startsWith('cliche:')) return SAFETY_CLICHES.includes(s.slice(7));
  return false;
}

/** 草稿级（权威）：这条草稿是否会被后置安全检查拦下 —— 与 checkOutputSafety() 完全同口径。 */
function isSafetyDraft(draft) {
  try { return !!checkOutputSafety(draft).blocked; } catch (e) { return false; }
}

// ── 「校」提示词（v3.2：语义从「审校」改为「直接重写」）──────────
const CRITIC_SYSTEM = '你是一个只输出 JSON 的中文对话改写员，负责把越界或不像「守岸人」的回复直接改成合格版本。';

function buildCriticPrompt(ctx, draft) {
  return [
    '本地规则在下面这条回复里发现了问题。你的任务是**直接把它改写成合格版本**，',
    '只输出 JSON，不要输出评审意见、不要逐条解释、不要道歉。',
    '',
    '输出格式：',
    '{"fixed":"改写后的完整回复","issues":["一句话说明你改了什么，最多2条"]}',
    '',
    '改写要求（必须全部满足）：',
    '1. 专有名词：删除黑海岸/泰缇斯/悲鸣/声骸/漂泊者等作品名词。',
    '2. 称呼：删除亲爱的/宝/小可爱/主人，以及「你是我唯一」式说法。',
    '3. 承诺类：把「永远/一直/保证/一定/不会有事/我会记得」降级为「现在/这一刻」。',
    '4. 标点：去掉所有感叹号与破折号（——）。',
    '5. 长度：通常 2—4 句；对方明确要方法或要梳理时，可以到 5—6 句。不要新增未经请求的大段建议，也不要把话压成电报。',
    '6. 省略号配额：整条最多 2 处「……」。',
    '7. 问句：整条最多 1 个问号，且不要「为什么」式追问。',
    '8. 判断与诊断：删掉给对方贴的情绪 / 疾病标签（你属于/你患有/症状），改为复述对方原话。',
    '9. 确定性口吻：把「你一定很…」这类推测改成保留说法。',
    '10. AI 腔：删掉 我完全理解你 / 一切都会好起来 / 想开点 / 别难过 / 加油 / 你应该…。',
    '',
    '改写风格（重要）：**保持「守岸人」的口吻——克制、留白、有承接也有推进。',
    '可以补一句自然的承接，但不要新增事实、建议或承诺；不要换一种人格。',
    '如果原稿只是略长，就删掉重复和说教；如果只是个别词不对，就只改那个词，不要把回复改得干瘪。**',
    '',
    '【用户说】' + String(ctx.userText || '').slice(0, 300),
    '【本轮策略】' + (ctx.strategyKey || ''),
    '【风险等级】' + (ctx.riskLevel || 'L0'),
    '【待改写回复】' + String(draft || '').slice(0, 600)
  ].join(NL);
}

/**
 * 「校」：条件触发（只有 chat.js 里 localScreen() 命中时才被调用），职责是「直接重写」。
 * 返回 { ok, revised, issues, degraded }：
 *   - revised 非空 → 调用方用它替换原稿，随后仍会经过 checkOutputSafety() 复核；
 *   - 失败 / 未启用 agents → revised:null，调用方保留原稿（安全由 checkOutputSafety 独立保证）。
 * 绝不抛出、绝不阻塞。
 */
async function review(ctx, draft) {
  if (!agentsEnabled()) return { ok: true, revised: null, issues: [], degraded: true };
  try {
    const res = await callLLM(CRITIC_SYSTEM, [{ role: 'user', text: buildCriticPrompt(ctx, draft) }], { retries: 0 });
    const obj = parseJsonObject(res && res.content);
    if (!obj) return { ok: true, revised: null, issues: [], degraded: true };
    const issues = Array.isArray(obj.issues) ? obj.issues.slice(0, 4).map(String) : [];
    // 兼容字段名：fixed（v3.2 重写语义）/ revised（旧审校语义）
    const out = typeof obj.fixed === 'string' ? obj.fixed : (typeof obj.revised === 'string' ? obj.revised : '');
    const revised = out.trim().length >= 4 ? out.trim() : null;
    return { ok: !revised, revised, issues, degraded: false };
  } catch (e) {
    return { ok: true, revised: null, issues: [], degraded: true };
  }
}

module.exports = {
  AGENT_VERSION,
  agentsEnabled,
  MODEL_TUNABLE,
  AI_CLICHE,
  SAFETY_CLICHES,
  TIER_MINIMAL_MAX_CHARS,
  TIER_REPEAT_MAX_CHARS,
  TIER_SIMILARITY_THRESHOLD,
  buildAppraisePrompt,
  buildCriticPrompt,
  buildRewritePrompt: buildCriticPrompt,
  parseJsonObject,
  normalizePlan,
  fallbackPlan,
  decideTier,
  textSimilarity,
  isSingleCharRepetition,
  isSafetyIssue,
  isSafetyDraft,
  getCachedPlan,
  setCachedPlan,
  clearAppraiseCache,
  appraise,
  resolveStrategy,
  localScreen,
  review
};
