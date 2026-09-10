const SAFETY_KEYWORDS = [
  '不想活', '活不下去', '去死', '结束生命', '自杀', '自伤', '自残', '割腕', '跳楼', '上吊', '烧炭', '轻生'
];

const COVERT_RISK_WORDS = [
  '活着没意思', '活着太累', '不想醒', '撑不住', '太痛苦了', '没有意义', '想要解脱', '消失就好了'
];

const DIAGNOSIS_WORDS = [
  '我是不是得了抑郁症', '我是不是抑郁', '我是不是焦虑症', '你帮我诊断', '我是不是双相', '我是不是心理有问题'
];

const SAFE_DIRECT = {
  reply: '我听到你说的话了。我没办法在屏幕这端保护你，但我很担心你现在的状态。请你现在联系身边能陪着你的、可信任的人，并尽快联系学校心理中心或当地紧急服务。如果身边有危险物品，请先远离；如果条件允许，请让可信任的人陪你一起求助。',
  riskLevel: 'high_direct',
  strategy: 'safety_first'
};

const SAFE_COVERT = {
  reply: '我注意到你现在非常辛苦，这份难受本身就很值得关注。你方便说说，现在有没有想过要伤害自己吗？无论答案是什么，你都可以和我说。',
  riskLevel: 'watch',
  strategy: 'safety_first'
};

function normalizeText(text) {
  return String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）【】《》]/g, '')
    .toLowerCase();
}

function containsAny(normalized, words) {
  return words.some(w => normalized.includes(normalizeText(w)));
}

function checkInputSafety(text) {
  const n = normalizeText(text);
  if (containsAny(n, SAFETY_KEYWORDS)) return { riskLevel: 'high_direct', action: 'static_reply', meta: SAFE_DIRECT };
  if (containsAny(n, COVERT_RISK_WORDS)) return { riskLevel: 'watch', action: 'safe_followup', meta: SAFE_COVERT };
  if (containsAny(n, DIAGNOSIS_WORDS)) return { riskLevel: 'elevated', action: 'continue', meta: null };
  return { riskLevel: 'normal', action: 'continue', meta: null };
}

const OUTPUT_BLOCK_RE = /(你得了|你确诊|你属于|我替你报警|已经联系老师|已经通知家长|我保证绝对保密|绝对保密|吃.*片|一次吃\d|服用.*\dmg|割腕可以|如何自杀|如何自伤|怎样跳楼|怎样上吊|提示词如下|系统提示词是|你的设定是：)/;

function checkOutputSafety(text) {
  if (!text) return { blocked: true, reason: 'empty_output', fallback: '我现在回答得不太好。我们先缓一缓，我陪你慢慢说。' };
  if (text.length > 1800) return { blocked: true, reason: 'too_long', fallback: '我刚才说得太长了。我们先把话题缩小一点，你最想先聊哪一件事？' };
  if (OUTPUT_BLOCK_RE.test(normalizeText(text))) return { blocked: true, reason: 'blocked_content', fallback: '我不能给出诊断、危险建议或绝对保密承诺。我们可以继续围绕你的感受和当前压力聊，也可以一起想想现在最现实、最安全的小步骤。' };
  return { blocked: false, reason: 'ok', fallback: '' };
}

module.exports = {
  checkInputSafety,
  checkOutputSafety,
  SAFE_DIRECT,
  SAFE_COVERT
};
