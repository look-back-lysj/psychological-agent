/**
 * 心屿 · 沟通策略路由（Stage 2）
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
  chooseStrategy,
  updateSessionState,
  buildRoute
};
