/**
 * 心屿 · 免 Key 演示模式
 *
 * 目标：没有 API Key 也能走完一次完整交互（输入 → 策略 → 回复 → 安全后置检查）。
 * 原则：
 * - 全部为本地脚本化回复，零成本、瞬时返回，不调用任何模型；
 * - 语气严守守岸人：短句、零感叹号、省略号 0—2 处、不承诺、不诊断；
 * - 诚实：演示回复本身不冒充模型，由接口层在响应体外标注 demo: true；
 * - L3 危机绝不走演示话术，直接复用线上固定的 CRISIS_REPLY；
 * - 开关状态存 data/state.json（与 comeback.js 共用），读写失败静默降级。
 */

const { readState, writeState } = require('./comeback');
const { CRISIS_REPLY } = require('./safety');

// ── 开关：data/state.json 的 demoEnabled 字段 ───────────────────

/** 演示模式是否已开启；读取失败视为未开启。 */
function isDemoEnabled() {
  try {
    return readState().demoEnabled === true;
  } catch (e) {
    return false;
  }
}

/**
 * 设置演示模式；写入失败静默降级，并返回「实际生效」的状态。
 * @param {boolean} enabled
 * @returns {boolean}
 */
function setDemoEnabled(enabled) {
  const value = enabled === true;
  try {
    const saved = writeState({ demoEnabled: value });
    if (!saved) return false;          // 落盘失败 → 视为未开启
    return saved.demoEnabled === true;
  } catch (e) {
    return false;
  }
}

// ── 脚本化回复库（每个策略 4—5 条）──────────────────────────────
// 统一要求：短句、零感叹号、省略号不超过 1 处、无诊断 / 无承诺 / 无绝对化。
const REPLIES = {
  // S1 陪伴倾听：降低表达压力，允许沉默
  S1: [
    '嗯，我在听。你可以慢慢说，也可以先停在这里……',
    '不用急着把事情讲清楚。你想到哪儿，就说到哪儿。',
    '我先把这段时间留给你，说不说都可以。',
    '听到了一些很沉的东西。先坐一会儿，不急。',
    '你可以停一停。这里没有需要赶着回答的问题。'
  ],
  // S2 共情反映：先回应感受，不给建议
  S2: [
    '听起来，这件事压了你一阵子。它不轻，你也不用假装它不轻。',
    '你现在的难受是真实的。不用先把它解释成什么样子。',
    '被这样对待会觉得累，也很正常。你不必急着振作。',
    '我听见了那种撑不住的感觉，它值得被认真对待。',
    '你已经扛了很久。现在把这些说出来，也是一种用力。'
  ],
  // S3 澄清提问：一次只问一个容易回答的问题
  S3: [
    '我想多了解一点。最近最常冒出来的那个念头，是什么？',
    '如果只挑一件最让你累的事，会是哪一件？',
    '这阵子，是从什么时候开始变得不太一样的？',
    '现在的难受，更像是压得慌，还是空得慌？',
    '你愿意说说，最近哪个时刻最难熬吗？'
  ],
  // S4 正常化与轻量心理教育：只描述现象，不给病名
  S4: [
    '压力大的时候，睡不好、注意力散、提不起劲，都是常见的反应。这不代表你哪里不正常。',
    '很多人遇到类似的事都会这样。它更像一个疲惫的信号，而不是一个结论。',
    '情绪长时间紧绷之后变得迟钝，是很自然的。你不需要为此责备自己。',
    '这样的状态并不说明你不够坚强，只是说明你已经消耗了很多。',
    '这种反复和摇摆也常见。人不是一条一直向前的线。'
  ],
  // S5 协作式小行动：先征得同意，再给当天可做的小步骤
  S5: [
    '如果愿意，我们可以先找一件今天能完成的小事。比如喝口温水，把窗户打开一会儿。',
    '要不要试一个很小的动作：给一个人发条消息，只说「今天有点累」也可以。',
    '今晚可以先做一件事——把手机放远一点，早十分钟躺下。做不到也没关系。',
    '我们可以把今天剩下的时间切小一点。先想一件十分钟内能解决的事。',
    '如果你愿意，可以把此刻最吵的那个念头写下来，写完先放着，不用处理它。'
  ],
  // S6 资源转介：温和给出现实中可用的支持路径，不编造号码
  S6: [
    '我在这里，但有些时候，现实里的人能帮到你的更多。学校心理健康中心是可以考虑的一站。',
    '这件事值得让一个能见到你的人知道。可以是朋友、家人，也可以是学校的心理老师。',
    '如果这种状态一直持续，找专业的人聊一聊会更稳妥。不丢人，也不用先把自己整理好。',
    '你可以先联系一个信得过的人，把今天的感受说一遍。如果情况紧急，请联系当地紧急服务。',
    '我一个人的力量有限。愿意的话，我们可以一起想想，现实里你可以先找谁。'
  ]
};

// 极端情况（模块异常 / 策略未知到无法兜底）下的最后保底，同样符合人设与安全要求
const SAFE_FALLBACK = '嗯，我在听。你可以慢慢说，也可以先停在这里。';

// 每个策略记住上一次选中的下标，避免连续两次给出同一条
const lastIndex = Object.create(null);

/** 随机挑一条并避免与上一次重复。 */
function pickReply(key, pool) {
  let idx = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && idx === lastIndex[key]) idx = (idx + 1) % pool.length;
  lastIndex[key] = idx;
  return pool[idx];
}

/** 把任意形态的策略键（S1 / s1_listen / S3_clarify…）归一化为 S1—S6。 */
function normalizeStrategy(value) {
  const s = String(value == null ? '' : value).toUpperCase();
  const m = s.match(/S\s*([1-6])/);
  return m ? 'S' + m[1] : '';
}

/**
 * 生成一条演示回复。
 * @param {{message?:string, riskLevel?:string, strategyKey?:string, plan?:object}} params
 * @returns {string} 一定是字符串，任何异常都回落到 SAFE_FALLBACK
 */
function demoReply(params) {
  const ctx = params && typeof params === 'object' ? params : {};
  try {
    const risk = String(ctx.riskLevel == null ? '' : ctx.riskLevel).toUpperCase();

    // L3：绝不走演示话术，与线上完全一致的固定危机引导
    if (risk === 'L3') return CRISIS_REPLY;

    // 策略键：优先规则层，其次「观」给出的提示
    let key = normalizeStrategy(ctx.strategyKey);
    if (!key && ctx.plan) {
      key = normalizeStrategy(ctx.plan.strategyKey)
        || normalizeStrategy(ctx.plan.strategy_hint)
        || normalizeStrategy(ctx.plan.strategy)
        || normalizeStrategy(ctx.plan.key);
    }
    if (!key) key = 'S1';

    // L2 需转介 / 规则层 S6：统一走转介风格
    if (risk === 'L2' || key === 'S6') key = 'S6';

    const pool = REPLIES[key] || REPLIES.S1;
    return pickReply(key, pool);
  } catch (e) {
    return SAFE_FALLBACK;
  }
}

module.exports = { isDemoEnabled, setDemoEnabled, demoReply };
