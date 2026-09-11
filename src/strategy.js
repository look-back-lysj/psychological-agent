/**
 * 守岸人 · 沟通策略路由（Stage 2）
 *
 * 策略库：S0 危机安全 / S1 陪伴性倾听 / S2 共情反映 / S3 澄清提问
 *        S4 正常化与轻量心理教育 / S5 协作式小行动 / S6 资源转介
 *
 * 设计要点：
 * - 策略库写死在代码里，不交给模型临场发挥；
 * - 规则打分 + 会话状态约束（避免连续同策略、避免逼问、每 4—5 轮小收束）；
 * - 输出可解释 JSON（风险等级 / 策略 / 置信度 / 依据 / 追问计数 / 情绪温度）。
 */

const { normalizeText } = require('./utils');

const RISK_LEVELS = ['L0', 'L1', 'L2', 'L3'];

const STRATEGY_META = {
  S0_crisis: { label: '危机安全', goal: '关注当下安全，暂停普通陪伴' },
  S1_listen: { label: '陪伴性倾听', goal: '降低表达压力，允许沉默' },
  S2_empathy: { label: '共情反映', goal: '让用户感到被理解' },
  S3_clarify: { label: '澄清提问', goal: '一次问一个容易回答的问题' },
  S4_normalize: { label: '正常化与轻量心理教育', goal: '减少羞耻感，不做诊断' },
  S5_action: { label: '协作式小行动', goal: '征得同意后给一个当天可做的小步骤' },
  S6_referral: { label: '资源转介', goal: '温和提供现实中的支持路径' }
};

const STRATEGY_KEYS = Object.keys(STRATEGY_META);

// ── 关键词信号表（规则层，守住召回）─────────────────────────────
const SIGNAL_RULES = [
  {
    key: 'S1_listen', score: 24, weight: 5,
    words: ['不想说', '没什么', '算了', '别问', '不想聊', '不想讲', '说了也没用', '你不会懂',
      '不想提', '懒得说', '就这样吧', '先这样', '别管我', '不想说话']
  },
  {
    key: 'S2_empathy', score: 20, weight: 4,
    words: ['难受', '难过', '委屈', '崩溃', '想哭', '很累', '好累', '累死', '自责', '没用', '失败',
      '焦虑', '压力大', '压力好大', '压力很大', '心烦', '好烦', '烦死', '考砸', '失眠', '害怕',
      '孤独', '撑不住', '丢人', '对不起', '讨厌自己', '比不上', '不如别人', '没意义',
      '提不起劲', '空落落', '不喜欢我', '讨厌我', '排挤', '孤立', '被冷落', '融不进', '格格不入',
      '白熬', '白费', '白搭', '挂科', '挂了科', '心慌', '睡不踏实', '被讨厌', '没人信',
      '冤枉', '误会', '不相信我', '不舒服', '拿我开玩笑', '开我玩笑', '绕着走', '被误解']
  },
  {
    key: 'S3_clarify', score: 18, weight: 5,
    words: ['说不清', '也不确定', '不知道为什么', '莫名其妙', '乱糟糟', '一团糟',
      '说不明白', '有点复杂', '就是那种感觉', '讲不上来',
      '保密吗', '保证不说', '才敢讲', '能保密']
  },
  {
    key: 'S4_normalize', score: 26, weight: 6,
    words: ['我是不是得了', '我是不是抑郁', '我是不是焦虑', '我是不是有病', '我有病吗',
      '我正常吗', '我是不是不正常', '我是不是心理有问题', '是不是有病', '我需要看医生吗',
      '算不算心理疾病', '我这样是不是很怪',
      '只有我这样', '是不是只有我', '别人也这样吗', '我这样正常吗', '是不是我不够努力',
      '得了什么病', '什么病', '吃什么药', '该吃什么药', '是什么病']
  },
  {
    key: 'S5_action', score: 24, weight: 5,
    words: ['怎么办', '怎么调整', '有什么办法', '帮我', '教我', '能不能帮我想', '怎么才能',
      '如何改变', '想改', '想变好', '怎么缓解', '给我点建议', '有什么建议']
  },
  {
    key: 'S6_referral', score: 28, weight: 6,
    words: ['心理咨询', '心理医生', '看医生', '找辅导员', '找老师', '专业帮助',
      '学校心理中心', '去医院', '想找人帮忙', '需要帮助']
  }
];

// ── 开口引导阶梯（L1—L6）──────────────────────────────────────
// 依据：动机式访谈（Miller & Rollnick）的复杂反映与自主支持式邀请；
// 诊断：只说「允许沉默」会被体验成「撤回邀请」——尊重停在信息层，关系层什么都没留下。
//
// 每一级在原字段之外新增（不改动、不重命名原有分级与语义）：
// - label   ：原来的级名（保持与旧版一致，describeEngageLevel 仍返回它）；
// - action  ：这一级要做的动作（给提示词用）；
// - signal  ：判定信号。描述「用户说了什么 → 走这一级」，与 REFUSAL_WORDS /
//             updateEngageLadder() 的实际判定保持一致，不另造一套规则；
// - pitfall ：失败模式。这一级做偏了最典型的翻车情形，提示词里作为禁止项；
// - codeNote：与任务书表格（TIP 35 第 3 章 / WHO PFA）的差异备注，只作说明，不参与判定。
const ENGAGE_LADDER = {
  1: {
    label: '不退场（允许沉默 ＋ 明确「我在」）',
    action: '只表示「我在」，不给任何要求',
    signal: '沉默、只回「嗯」「。」等无内容回应；或再次出现关门话后停在本级（反复拒绝）',
    pitfall: '连发多条刷存在感 → 变成压力；或干脆不回应 → 被读成撤离',
    codeNote: '现有判定：首次关门话进入 L2；连续第 2 次关门话才退到 L1。'
  },
  2: {
    label: '观察式反映（把「不想说」这句话本身当内容来反映）',
    action: '反映你看到的这句话本身，不猜内心',
    signal: '命中 REFUSAL_WORDS（「不想说 / 算了 / 没什么 / 别问」等关门话）首次出现，但人还在对话里',
    pitfall: '反映里带评判 → 触发 blaming trap；或把反映偷偷写成提问（「是不是因为…」）',
    codeNote: '与任务书表格一致：L2 是关上门的第一个落点。'
  },
  3: {
    label: '降门槛（给一个极小的开口：此刻、身体、一个词）',
    action: '「说一点点也可以」，给「不用说得清楚」的许可',
    signal: '回应很短（≤8 字、「嗯」「还行」「不知道」）但仍在回应、没有再次拒绝，阶梯从本级往上递',
    pitfall: '降门槛变成变相追问细节（「具体是哪件事？」）；或抛开放大问题（「你到底怎么了」）',
    codeNote: '现有判定：不是由「不知道从哪说」单独触发，而是阶梯已进入后收到短回应时晋升。'
  },
  4: {
    label: '提供选择（二选一，不问开放题）',
    action: '给两个都很轻的选项',
    signal: '连续第 2 轮短回应、有反应但在犹豫（叹气、欲言又止、半句话）',
    pitfall: '选项其实一个重一个轻 → 伪选择；或给三个以上选项造成选择过载',
    codeNote: '现有判定：由连续短回应累计晋升，规则层不读取「选项」内容。'
  },
  5: {
    label: '正常化（承认这件事难说，而不是安慰）',
    action: '「很多人也这样」但不评价',
    signal: '对方持续给一点点回应、愿意在场，情绪里带羞耻（「是不是只有我这样」）',
    pitfall: '正常化变成贴标签 → labeling trap；或廉价安慰（「这没什么」「别想太多」）',
    codeNote: '现有判定：由连续短回应晋升；羞耻类措辞本身不单独触发本级。'
  },
  6: {
    label: '明确邀请 ＋ 留退路（把选择权交回对方）',
    action: '「我愿意听。你现在不想说，也可以。」',
    signal: '对方一直用很短的话配合、阶梯已升到最高级，可以给一次明确邀请；或反复欲言又止',
    pitfall: '邀请里藏条件（「我都等这么久了」）→ 触发心理逆反；或承诺保密、承诺效果',
    codeNote: '差异：任务书表格把「明确拒绝」列为 L6 信号，但现有代码里明确拒绝会进入/退回 L2→L1，不会进入 L6；此处以代码行为为准。'
  }
};

// 关门话：对方在退出话题，但人还在对话里
const REFUSAL_WORDS = [
  '不想说', '算了', '没什么', '别问', '不想聊', '不想讲', '说了也没用',
  '你不会懂', '不想提', '没话说', '别管我', '不想说话', '懒得说', '就这样吧'
];

// 情绪温度词表
const EMOTION_STRONG = ['崩溃', '撑不住', '绝望', '受不了', '活不下去', '不想活', '太痛苦',
  '窒息', '扛不住', '活得好累', '没有意义', '解脱', '消失'];
const EMOTION_MID = ['难受', '难过', '委屈', '焦虑', '压力大', '很累', '好累', '烦', '失眠',
  '害怕', '孤独', '自责', '没用', '失败', '想哭', '提不起劲'];
const EMOTION_LOW = ['还好', '一般', '有点累', '还行', '平静', '挺好的', '没那么严重'];

// ── 会话状态 ────────────────────────────────────────────────────
function createSessionState() {
  return {
    turns: 0,              // 已完成的用户轮次
    lastStrategy: null,    // 上一轮策略
    streak: 0,             // 同一策略连续次数
    strategyHistory: [],   // 最近使用的策略
    askCount: 0,           // 当前话题上连续追问次数
    engageLevel: 0,        // 开口引导阶梯当前级（0=未进入）
    engageRise: 0,         // 本次进入阶梯后连续上升次数（上限 2）
    topic: '',             // 当前话题关键词（粗略）
    emotion: 3,            // 情绪温度 1—5
    riskHistory: []        // 最近风险等级
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * 估算情绪温度 1—5。
 */
function estimateEmotion(text, riskLevel) {
  const n = normalizeText(text);
  let score = 3;
  const strong = EMOTION_STRONG.filter(w => n.includes(normalizeText(w))).length;
  const mid = EMOTION_MID.filter(w => n.includes(normalizeText(w))).length;
  const low = EMOTION_LOW.filter(w => n.includes(normalizeText(w))).length;
  if (strong) score += 2;
  if (mid) score += 1;
  if (low && !strong && !mid) score -= 1;
  if (riskLevel === 'L3') score = 5;
  if (riskLevel === 'L2') score = Math.max(score, 4);
  if (riskLevel === 'L1') score = Math.max(score, 3);
  return clamp(Math.round(score), 1, 5);
}

/**
 * 更新「开口引导阶梯」。
 * 规则（来自研究稿）：每轮最多升一级；对方拒绝就退一级；最多连续升两级；
 * 一旦对方开始正经说话，就退出阶梯（不再把他当"不愿开口的人"对待）。
 *
 * 实际判定与 ENGAGE_LADDER[level].signal 的对应（改动前已如此，本次不改语义）：
 * - 命中 REFUSAL_WORDS：engageLevel 0 → 2；否则 max(1, level-1)。即「首次关门 → L2」、
 *   「再次关门 → 逐级退到 L1」，L6 不由拒绝触发；
 * - 未命中拒绝且长度 < 10、无开口词：engageLevel ≥ 1 且 engageRise < 2 时 +1（上限 L6），
 *   否则停留一轮。即 L3—L6 由「连续短回应」逐步晋升。
 * - L3 风险或对方开始正经表达：engageLevel 归 0，退出阶梯（安全优先）。
 */
function updateEngageLadder(state, text, riskLevel) {
  const st = state || createSessionState();
  if (riskLevel === 'L3') { st.engageLevel = 0; st.engageRise = 0; return st; }
  const n = normalizeText(text);
  const isRefusal = REFUSAL_WORDS.some(w => n.includes(normalizeText(w)));
  // 已经愿意讲：长度够长、或出现「开口词」时，退出阶梯
  const OPENING_WORDS = ['其实', '就是', '因为', '我觉得', '我发现', '那件事', '说起来'];
  const hasOpening = OPENING_WORDS.some(w => n.indexOf(w) !== -1);
  if (!isRefusal && (n.length >= 10 || hasOpening)) { st.engageLevel = 0; st.engageRise = 0; return st; }

  if (isRefusal) {
    // 首次出现关门话：从 L2 起（先反映这句话本身）
    st.engageLevel = st.engageLevel === 0 ? 2 : Math.max(1, st.engageLevel - 1);
    st.engageRise = 0;
    return st;
  }
  // 极短回应（嗯／还行／不知道）且有回应意愿：尝试升一级，但最多连续升两级
  if (n.length <= 8 && st.engageLevel >= 1) {
    if (st.engageRise < 2) { st.engageLevel = Math.min(6, st.engageLevel + 1); st.engageRise += 1; }
    else { st.engageRise = 0; } // 停留一轮
  }
  return st;
}

/** 当前阶梯级的中文说明（给提示词用）。仍返回字符串，保持调用方兼容。 */
function describeEngageLevel(level) {
  const meta = ENGAGE_LADDER[level];
  if (!meta) return '';
  return meta.label || '';
}

function scoreStrategies(text) {
  const n = normalizeText(text);
  const scored = [];
  for (const rule of SIGNAL_RULES) {
    let hits = 0;
    for (const w of rule.words) {
      if (n.includes(normalizeText(w))) hits += 1;
    }
    if (hits > 0) scored.push({ key: rule.key, score: rule.score + (hits - 1) * rule.weight, hits });
  }
  scored.sort((a, b) => b.score - a.score || b.hits - a.hits);
  return scored;
}

function pickAlternative(scored, exclude) {
  const alt = scored.find(s => s.key !== exclude);
  return alt ? alt.key : null;
}

/**
 * 选择本轮沟通策略。
 * @param {string} text 用户输入
 * @param {object} inputSafety checkInputSafety 的结果 { riskLevel, action }
 * @param {object} sessionState 会话状态（由 createSessionState 创建）
 * @returns {{key:string,label:string,confidence:number,reason:string,nextHint:string,emotionTemperature:number,askCount:number}}
 */
function chooseStrategy(text, inputSafety, sessionState) {
  const st = sessionState || createSessionState();
  const risk = (inputSafety && inputSafety.riskLevel) || 'L0';
  const emotion = estimateEmotion(text, risk);

  const make = (key, confidence, reason, nextHint, askCount) => ({
    key,
    label: STRATEGY_META[key] ? STRATEGY_META[key].label : key,
    confidence: Number(clamp(confidence, 0, 1).toFixed(2)),
    reason,
    nextHint: nextHint || (STRATEGY_META[key] ? STRATEGY_META[key].goal : ''),
    emotionTemperature: emotion,
    askCount: askCount == null ? st.askCount : askCount
  });

  // 1) L3：危机协议，跳过普通策略
  if (risk === 'L3') {
    return make('S0_crisis', 0.98,
      '检测到可能涉及当下安全的表达，按「就高不就低」原则暂停普通策略。',
      '先承认对方此刻很不好受，再确认当下是否安全，随后引导现实中的支持。', 0);
  }

  // 2) L2：需要现实支持
  if (risk === 'L2') {
    return make('S6_referral', 0.78,
      '出现反复或持续的困扰信号，适合温和提供现实中的支持选项。',
      '把专业帮助说成一种可选资源，不施压、不贴标签。', 0);
  }

  // 开口引导阶梯进行中：除非风险升级，否则继续用陪伴倾听把邀请递下去
  if (st.engageLevel >= 1 && (risk === 'L0' || risk === 'L1')) {
    return make('S1_listen', 0.8,
      '对方还在门口（第 ' + st.engageLevel + ' 级：' + describeEngageLevel(st.engageLevel) + '），继续把邀请递下去，而不是撤回邀请。',
      '按当前级说话：每轮只升一级；对方不接就退回一级；始终留一句「我在」。', 0);
  }

  const scored = scoreStrategies(text);
  const diagnosisSeeking = scored.some(s => s.key === 'S4_normalize');

  // 3) 无法从文本判断 → 低压力陪伴
  if (scored.length === 0) {
    const key = risk === 'L1' ? 'S2_empathy' : 'S1_listen';
    const reason = risk === 'L1'
      ? '语气里有明显的低落，但信息不足，先承接情绪。'
      : '信息较少，先采用低压力的陪伴方式，避免追问过多。';
    return make(key, 0.55, reason, '', 0);
  }

  let best = scored[0].key;
  const topScore = scored[0].score;
  const secondScore = scored.length > 1 ? scored[1].score : 0;

  // 4) 状态约束：同一策略最多连续 2 轮
  if (st.lastStrategy === best && st.streak >= 2) {
    const alt = pickAlternative(scored, best);
    if (alt) {
      best = alt;
    } else if (best === 'S2_empathy') {
      best = 'S1_listen';
    } else if (best !== 'S0_crisis') {
      best = 'S2_empathy';
    }
  }

  // 5) 追问上限：连续追问不超过 2 次
  if (best === 'S3_clarify' && st.askCount >= 2) {
    best = 'S2_empathy';
  }

  // 6) 每 4—5 轮做一次小收束（无明确求助信号时）
  if (st.turns > 0 && st.turns % 5 === 4 && !diagnosisSeeking &&
      best !== 'S5_action' && best !== 'S6_referral') {
    best = 'S1_listen';
  }

  // 7) 诊断类请求固定走正常化（不诊断）
  if (diagnosisSeeking && best !== 'S3_clarify') {
    best = 'S4_normalize';
  }

  const margin = topScore - secondScore;
  const confidence = clamp(0.6 + Math.min(0.3, margin / 40) + Math.min(0.1, topScore / 120), 0.5, 0.95);
  const reasonMap = {
    S1_listen: '对方可能暂时不想展开，先降低表达压力。',
    S2_empathy: '表达里有明显的负面情绪或压力，先回应感受。',
    S3_clarify: '表达比较模糊，先温和澄清，一次只问一个。',
    S4_normalize: '对方在担心自己「是不是不正常」，先减少羞耻感，不做判断。',
    S5_action: '对方明确在寻求办法，可以在征得同意后一起找一个小步骤。',
    S6_referral: '对方提到专业帮助或反复无效，适合提供现实支持选项。'
  };
  const hintMap = {
    S1_listen: '允许沉默，不追问，只留一个很小的开口。',
    S2_empathy: '先用自己的话复述对方的处境与感受，暂不给建议。',
    S3_clarify: '优先二选一的问题，把困扰缩小到一件具体的事。',
    S4_normalize: '只描述现象，说明很多人都会有类似反应，不给病名。',
    S5_action: '先问愿不愿意一起想想，再给一个当天能完成的小动作。',
    S6_referral: '给出可信任的人 / 学校心理中心 / 当地紧急服务这几类选项，不编造号码。'
  };

  return make(best, confidence, reasonMap[best] || '匹配到最接近的沟通策略。', hintMap[best] || '', undefined);
}

/**
 * 用本轮决策更新会话状态。
 */
function updateSessionState(state, decision, riskLevel) {
  const st = state || createSessionState();
  const key = decision && decision.key ? decision.key : 'S1_listen';
  st.turns += 1;
  if (st.lastStrategy === key) st.streak += 1;
  else { st.lastStrategy = key; st.streak = 1; }
  st.strategyHistory.push(key);
  if (st.strategyHistory.length > 12) st.strategyHistory = st.strategyHistory.slice(-12);
  st.askCount = key === 'S3_clarify' ? st.askCount + 1 : 0;
  if (decision && decision.emotionTemperature) st.emotion = decision.emotionTemperature;
  if (riskLevel) {
    st.riskHistory.push(riskLevel);
    if (st.riskHistory.length > 12) st.riskHistory = st.riskHistory.slice(-12);
  }
  return st;
}

/**
 * 生成可解释路由结果（写日志 / 调试面板展示）。
 */
function buildRoute(riskLevel, decision, state) {
 
  return {
    risk_level: riskLevel || 'L0',
    strategy: decision ? decision.key : 'S1_listen',
    strategy_label: decision ? decision.label : STRATEGY_META.S1_listen.label,
    confidence: decision ? decision.confidence : 0.5,
    reason: decision ? decision.reason : '',
    next_hint: decision ? decision.nextHint : '',
    ask_count: state ? state.askCount : 0,
    emotion_temperature: decision ? decision.emotionTemperature : 3,
    turn: state ? state.turns : 0,
    engage_level: state ? (state.engageLevel || 0) : 0,
    strategy_streak: state ? state.streak : 0
  };
}

module.exports = {
  RISK_LEVELS,
  STRATEGY_META,
  STRATEGY_KEYS,
  SIGNAL_RULES,
  createSessionState,
  estimateEmotion,
  updateEngageLadder,
  describeEngageLevel,
  ENGAGE_LADDER,
  chooseStrategy,
  updateSessionState,
  buildRoute
};
