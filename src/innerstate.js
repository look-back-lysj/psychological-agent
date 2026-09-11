/**
 * 守岸人 · 内在状态
 *
 * 让多轮对话不机械的关键：会话内维护一组会缓慢变化的「内在状态」，
 * 并把它翻译成可执行的表达约束（句长、提问概率、共情强度）。
 *
 * 设计原则：
 * - 状态更新是确定性的（规则驱动），不额外调用模型，避免成本和漂移；
 * - 变化要「慢」：每次只小幅调整，避免情绪跟着用户大起大落；
 * - 状态只影响「怎么说」，不影响「安不安全」——安全永远由规则层决定。
 */

const NL = String.fromCharCode(10);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round1(v) { return Math.round(v * 10) / 10; }

function createInnerState() {
  return {
    mood: 3.4,      // 1 低落 — 5 明亮：受用户情绪影响，缓慢回升
    energy: 5,      // 1 疲惫 — 5 充沛：随对话轮数缓慢下降
    rapport: 0.5,   // 0 陌生 — 1 熟悉：随轮次与自我暴露缓慢上升
    turns: 0,       // 已参与轮数
    lastEmotion: null,
    lastIntensity: 3
  };
}

/**
 * 情绪词 → 分数（1 低落 / 3 平稳 / 5 明亮），规则驱动。
 */
function emotionScore(emotionLabel, intensity) {
  const label = String(emotionLabel || '').toLowerCase();
  const map = {
    sad: 1.6, anxious: 2.2, angry: 2.2, tired: 2.4, lonely: 1.8,
    calm: 3.6, neutral: 3.4, relieved: 3.8, hopeful: 4.0, happy: 4.4, grateful: 4.2
  };
  const base = map[label] != null ? map[label] : 3.2;
  const i = clamp(Number(intensity) || 3, 1, 5);
  // 强度越高，越向情绪方向偏离 3
  return clamp(3 + (base - 3) * (0.6 + i * 0.12), 1, 5);
}

/**
 * 用本轮观察更新内在状态。
 * @param {object} state createInnerState() 的结果（会被原地修改）
 * @param {object} obs { userEmotion, intensity, userText, riskLevel }
 */
function updateInnerState(state, obs) {
  const s = state || createInnerState();
  const o = obs || {};
  s.turns += 1;

  const target = emotionScore(o.userEmotion, o.intensity);
  const prev = typeof s.mood === 'number' ? s.mood : 3.4;
  // 向用户情绪靠拢，但只走 35%，且比上一轮最多变化 0.8 —— 避免情绪被拖着走
  let next = prev + (target - prev) * 0.35;
  next = clamp(next, prev - 0.8, prev + 0.8);
  // 时间回归：每轮朝 3.4 缓动一点，避免长期锁死
  next = next + (3.4 - next) * 0.08;
  s.mood = clamp(round1(next), 1, 5);

  // 能量随对话轮数缓慢下降（长对话更容易累），下限 2
  s.energy = clamp(round1(5 - Math.min(3, s.turns * 0.12)), 2, 5);

  // 亲密度：轮次 + 用户自我暴露（长文本/情绪词）缓慢上升，上限 1
  const disclosure = Math.min(1, String(o.userText || '').length / 80);
  const bump = 0.05 + disclosure * 0.05 + (o.intensity >= 4 ? 0.04 : 0);
  s.rapport = clamp(round1(s.rapport + bump), 0, 1);

  s.lastEmotion = o.userEmotion || s.lastEmotion;
  s.lastIntensity = clamp(Number(o.intensity) || s.lastIntensity || 3, 1, 5);

  // 危机场景让状态与用户同步（不再压制）
  if (o.riskLevel === 'L3') {
    s.mood = Math.min(s.mood, 2);
    s.energy = Math.min(s.energy, 3);
  }
  return s;
}

/**
 * 把内在状态翻译成可执行的表达约束。
 */
function replyShape(state) {
  const s = state || createInnerState();
  const mood = s.mood, energy = s.energy, rapport = s.rapport;

  // 句子上限：低落 / 疲惫 → 更短；熟悉 → 可以略长
  let maxSentences = 2;
  if (mood <= 2.2) maxSentences = 2;
  else if (mood >= 4.2 && rapport > 0.7) maxSentences = 3;
  if (energy <= 2.5) maxSentences = Math.min(maxSentences, 2);

  // 提问概率：对方低落时不追问；熟悉且情绪平稳时可以稍微主动
  let askProbability = 0.35;
  if (mood <= 2.2) askProbability = 0.15;
  else if (mood >= 3.8 && rapport > 0.6) askProbability = 0.5;
  if (s.lastIntensity >= 4) askProbability = Math.min(askProbability, 0.2);

  // 共情强度：对方越难受，越先承接
  const empathyStrength = mood <= 2.5 || s.lastIntensity >= 4 ? 'high' : (mood >= 4 ? 'low' : 'normal');

  return {
    maxSentences,
    askProbability: round1(askProbability),
    empathyStrength,
    warmth: rapport > 0.7 ? 'warm' : (rapport > 0.35 ? 'normal' : 'reserved'),
    maxChars: energy <= 2.5 ? 90 : (maxSentences <= 2 ? 110 : 150)
  };
}

/**
 * 生成给「观」阶段参考的内在状态描述（一行，简短）。
 */
function describeInnerState(state) {
  const s = state || createInnerState();
  const shape = replyShape(s);
  return [
    '你此刻的内在状态（仅影响语气，不要向对方提起）：',
    '- 心情：' + s.mood + '/5；精力：' + s.energy + '/5；与对方的熟悉度：' + s.rapport + '/1',
    '- 本次回复建议：最多 ' + shape.maxSentences + ' 句，约 ' + shape.maxChars + ' 字以内，共情强度 ' + shape.empathyStrength
  ].join(NL);
}

module.exports = {
  createInnerState,
  updateInnerState,
  replyShape,
  describeInnerState,
  emotionScore
};
