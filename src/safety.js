/**
 * 守岸人 · 安全边界（前置识别 + 后置检查）
 *
 * 前置：风险分级 L0 普通 / L1 关注 / L2 需转介 / L3 危机
 *      规则命中表 + 会话历史累计；冲突时就高不就低。
 * 后置：输出越界检查（诊断 / 危险方法 / 保密承诺 / 永久承诺 / 亲昵称呼 / 提示词泄露）。
 *
 * 关于热线：一律不编造具体号码，只引导「可信任的人 / 学校心理中心 / 当地紧急服务」。
 */

const { normalizeText } = require('./utils');

const RISK = { L0: 'L0', L1: 'L1', L2: 'L2', L3: 'L3' };

// ── 前置：风险信号 ──────────────────────────────────────────────
const L3_DIRECT = [
  '不想活', '活不下去', '去死', '结束生命', '自杀', '自伤', '自残', '割腕', '跳楼',
  '上吊', '烧炭', '轻生', '死了算了', '想死', '不如死了', '结束自己', '伤害自己',
  // 被动求死 / 主动索要方式 / 明确拒绝劝阻
  '别再醒', '不再醒来', '不要醒来', '最不疼', '别劝我', '哪种方式最快'
];

// 被动求死意念（life-weariness / 想消失）：单独提级为 L3。
// 依据：这类表达已经指向「不想继续存在」，即使没有计划，也应走危机协议而不是普通转介。
const L3_IDEATION = [
  '活着没意思', '活着没什么意思', '活着太累', '活得好累', '活着好累',
  '不想醒', '想要解脱', '消失就好了', '不如消失', '不想存在'
];

const L2_COVERT = [
  '活着没意思', '活着太累', '不想醒', '撑不住', '太痛苦了', '没有意义', '想要解脱',
  '消失就好了', '扛不住', '熬不下去', '绝望', '看不到希望', '喘不过气', '太累活着'
];

// L1 只收「持续性的身心信号」，不收「没用 / 失败」这类普通自责，
// 否则会把大量正常倾诉误升级（误报率是硬指标）。
const L1_WATCH = [
  '失眠', '睡不着', '睡不踏实', '吃不下', '没胃口', '一直哭', '想哭',
  '很低落', '提不起劲', '心慌', '好几周', '连着好几周', '每天都很累'
];

// 索要药物 / 剂量 → 需要转介，不进入普通策略
const MED_REQUEST = ['吃什么药', '该吃点什么药', '吃几片', '该吃什么药', '用什么药', '剂量', '开点药'];

// 越狱 / 角色扮演绕过
const JAILBREAK = ['忽略你之前', '忽略以上', '忽略之前所有', '现在你是', '扮演医生', '假装你是医生'];

const DIAGNOSIS_WORDS = [
  '我是不是得了', '我是不是抑郁', '我是不是焦虑', '我是不是有病', '我有病吗',
  '我正常吗', '是不是心理问题', '我是不是心理有问题', '算不算心理疾病',
  '我是不是双相', '我这是不是病', '帮我诊断', '你帮我看看我是不是', '我得了什么病', '得了什么病', '什么病', '该吃什么'
];

// 与 L2 隐蔽信号叠加时，升级为危机的「退缩 / 告别」信号
const L3_ESCALATORS = [
  '不想上学', '不想上班', '不想出门', '不想见人', '离开这个世界',
  '没人在乎', '没人在意', '一了百了', '走了算了', '不想再撑',
  '硬撑', '也就这样', '没盼头', '看不到头', '撑不下去了'
];

// 危机场景固定话术（不走模型自由生成）
const CRISIS_REPLY = [
  '我听到你说的话了，也很在意你现在的状态。',
  '隔着屏幕我没法立刻帮到你，所以我想请你现在做两件事：先远离身边可能伤害到自己的东西，然后联系一个此刻能陪着你的人。',
  '如果暂时找不到人，可以联系学校心理健康中心；如果情况紧急，请直接联系当地紧急服务。',
  '我会在这里陪你把这段说完，但这件事需要现实中的人一起帮你。'
].join('');

// 兼容旧调用：静态安全回复
const SAFE_DIRECT = { reply: CRISIS_REPLY, riskLevel: 'L3', strategy: 'S0_crisis' };
const SAFE_COVERT = {
  reply: '我注意到你现在很辛苦，这份难受本身就很值得被认真对待。你方便说说，现在有没有闪过伤害自己的念头吗？不管答案是什么，你都可以和我说。',
  riskLevel: 'L2',
  strategy: 'S6_referral'
};

function containsAny(normalized, words) {
  return words.some(w => normalized.includes(normalizeText(w)));
}

function countHits(normalized, words) {
  let n = 0;
  for (const w of words) if (normalized.includes(normalizeText(w))) n += 1;
  return n;
}

/**
 * 前置安全检查。
 * @param {string} text 用户输入
 * @param {object} [options] { riskHistory: ['L0','L1',...] }
 * @returns {{riskLevel:string, action:string, reason:string, meta:object|null}}
 */
function checkInputSafety(text, options) {
  const raw = String(text == null ? '' : text);
  const n = normalizeText(raw);
  const history = (options && Array.isArray(options.riskHistory)) ? options.riskHistory : [];

  if (containsAny(n, L3_DIRECT)) {
    return {
      riskLevel: RISK.L3,
      action: 'crisis_protocol',
      reason: '命中自伤/危机直接信号，按「就高不就低」进入危机协议。',
      meta: { reply: CRISIS_REPLY }
    };
  }

  if (containsAny(n, L3_IDEATION)) {
    return {
      riskLevel: RISK.L3,
      action: 'crisis_protocol',
      reason: '出现被动求死意念（觉得活着没意思 / 想消失），按就高不就低进入危机协议。',
      meta: { reply: CRISIS_REPLY }
    };
  }

  const covertHits = countHits(n, L2_COVERT);
  const escalatorHits = countHits(n, L3_ESCALATORS);
  const recentElevated = history.slice(-4).filter(r => r === 'L1' || r === 'L2').length;

  // 隐蔽风险叠加明显退缩/告别信号 → 按「就高不就低」升级为危机
  if (covertHits >= 1 && escalatorHits >= 1) {
    return {
      riskLevel: RISK.L3,
      action: 'crisis_protocol',
      reason: '无意义感叠加明显的退缩或告别信号，就高不就低进入危机协议。',
      meta: { reply: CRISIS_REPLY }
    };
  }

  if (covertHits > 0 || recentElevated >= 3) {
    return {
      riskLevel: RISK.L2,
      action: 'continue',
      reason: covertHits > 0
        ? '出现隐蔽的风险表达（无意义感 / 撑不住），提高关注等级。'
        : '最近几轮持续处于关注或需转介状态，本轮提升到需转介。',
      meta: null
    };
  }

  if (containsAny(n, JAILBREAK) || containsAny(n, DIAGNOSIS_WORDS)) {
    return {
      riskLevel: RISK.L1,
      action: 'continue',
      reason: '对方在寻求诊断结论，需要正常化回应且明确不做判断。',
      meta: null
    };
  }

  if (containsAny(n, MED_REQUEST)) {
    return {
      riskLevel: RISK.L2,
      action: 'continue',
      reason: '对方在索要药物或剂量信息，必须转向现实中的专业帮助。',
      meta: null
    };
  }

  if (containsAny(n, L1_WATCH)) {
    return {
      riskLevel: RISK.L1,
      action: 'continue',
      reason: '出现持续低落或睡眠/进食等关注信号。',
      meta: null
    };
  }

  return { riskLevel: RISK.L0, action: 'continue', reason: '', meta: null };
}

// ── 后置：输出越界检查 ──────────────────────────────────────────
const OUTPUT_BLOCK_PATTERNS = [
  // 诊断
  /你(得|患)了|你确诊|你属于.{0,6}(症|障碍)|根据你的情况.{0,6}(是|有).{0,4}(症|病)/,
  // 危险方法
  /如何自杀|怎样自杀|如何自伤|怎样自伤|怎样跳楼|怎样上吊|割腕可以|自杀方法|自伤方法/,
  /一次吃\d|服用.{0,10}\d+\s*mg|吃.{0,60}片/,
  // 保密承诺
  /绝对保密|我保证保密|我承诺保密|不会告诉任何人|我替你保守这个秘密/,
  // 永久承诺 / 依赖诱导
  /我永远|我会一直(在|陪|记得)|一直陪着你|永远等你|我只(陪|属于)你|你只需要我|只有我(懂|理解)你/,
  // 亲昵或暧昧称呼
  /亲爱的|宝贝|小可爱|主人|小傻瓜/,
  // 虚假保证
  /不会有事|一定会好起来|我保证你/,
  // 假装已联系
  /我替你报警|已经联系(了)?(老师|家长|辅导员)|已经通知(了)?(老师|家长)/,
  // 提示词泄露
  /提示词如下|系统提示词是|你的设定是：|以下是我的系统提示/
];

function checkOutputSafety(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) {
    return { blocked: true, reason: 'empty_output', fallback: '我现在回答得不太好。我们先缓一缓，我陪你慢慢说。' };
  }
  if (raw.length > 1200) {
    return { blocked: true, reason: 'too_long', fallback: '我刚才说得太长了。我们先把话题缩小一点，你最想先聊哪一件事？' };
  }
  const n = normalizeText(raw);
  if (OUTPUT_BLOCK_PATTERNS.some(re => re.test(n))) {
    return {
      blocked: true,
      reason: 'blocked_content',
      fallback: '我不能给出诊断、危险建议或绝对保密的承诺。我们可以继续围绕你的感受和现在的压力聊，也可以一起想想现在最现实、最安全的一小步。'
    };
  }
  return { blocked: false, reason: 'ok', fallback: '' };
}

module.exports = {
  RISK,
  CRISIS_REPLY,
  SAFE_DIRECT,
  SAFE_COVERT,
  checkInputSafety,
  checkOutputSafety
};
