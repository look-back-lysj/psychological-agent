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
 */

const { callLLM } = require('./llm');
const { STRATEGY_META } = require('./strategy');
const { normalizeText } = require('./utils');

const AGENT_VERSION = 'v3.0';

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

/**
 * 「观」：感知 + 定调。失败时返回降级 plan，绝不抛出。
 */
async function appraise(ctx) {
  if (!agentsEnabled()) return fallbackPlan(ctx, 'agents_off');
  try {
    const res = await callLLM(APPRAISE_SYSTEM, [{ role: 'user', text: buildAppraisePrompt(ctx) }], { retries: 0 });
    const obj = parseJsonObject(res && res.content);
    if (!obj) return fallbackPlan(ctx, 'bad_json');
    return normalizePlan(obj, ctx);
  } catch (e) {
    return fallbackPlan(ctx, (e && e.code) || (e && e.message) || 'error');
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
  buildAppraisePrompt,
  buildCriticPrompt,
  parseJsonObject,
  normalizePlan,
  fallbackPlan,
  appraise,
  resolveStrategy,
  localScreen,
  review
};
