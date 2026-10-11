/**
 * 模块：pipeline/strategy-cards —— 策略意图卡（S0~S6）
 * 层级：pipeline L3（装配）
 * 职责：把旧版「do/don't 编号清单」式策略指令，改写成 2~4 句连贯的**意图叙述**，
 *      并为每个策略标注心理学技术（术语取 [MI-G] 官方术语表）与权威出处。
 *      本模块是 v4.0 新架构的「规则:语料 ≈ 1:1」里"规则"那一半的最小化实现：
 *      只说清"这一轮要达成什么"，不列 20 条硬规则，风格细节交给风格语料承担。
 * 依赖：无（纯数据 + 纯函数）
 * 被依赖：pipeline/prompts-v4（取 intent 拼提示词）、pipeline/output-guard（取策略兜底话术）、
 *      pipeline/style-retriever（取 corpusTechniques 决定检索哪些技术对应的语料）
 * 改动风险：🟢 低 —— node --check + node tests/run.js
 * 契约：STRATEGY_CARDS、STRATEGY_CARD_KEYS、getStrategyCard、buildStrategyIntentBlock
 *      的导出名与返回字段（label / intent / psychTechnique / psychSource / corpusTechniques / fallback）
 * 不要做什么：
 *   1) 不要在这里写安全红线 —— 红线属于 safety.js 与 domain/persona.buildSafetyBlock，
 *      三处重复必然不同步；危机协议仍由 persona.buildSafetyBlock('L3') 统一提供。
 *   2) 不要改 strategy.js 的 STRATEGY_META / chooseStrategy —— 策略路由是规则层独占的
 *      安全体系一部分，本模块只负责「怎么把已定策略讲给模型听」。
 *   3) intent 必须写成连贯叙述（2~4 句），一旦回退成 do/don't 清单，
 *      架构就退回 213 条约束的老路，人机感问题会原样复发。
 *   4) psychTechnique 里的术语必须来自 02 报告 Part 1 的 [MI-G] 定义；
 *      「roll with resistance」是 MI 第 3 版已废弃术语，禁止复用。
 */
/**
 * 守岸人 · 策略意图卡
 *
 * 与旧版 STRATEGY_INSTRUCTIONS（prompts.js）的根本区别：
 *   旧：12~20 条编号命令（必须…／不要…），模型在"完成规格"而不是"回应一个人"；
 *   新：2~4 句意图 + 一个心理学技术名，让模型知道"这一轮的意图"，
 *       剩下的边界由 §3.1 风格语料（54 条真实例句）来兜。
 */

const NL = String.fromCharCode(10);

const STRATEGY_CARDS = {
  S0_crisis: {
    label: '危机安全',
    intent:
      '这一轮不谈别的，先让她的人身安全。你要让她感到自己被接住了、没有被评判，' +
      '再用平和的语气问一句此刻是否安全。用完就停——不要讲道理，不要给方法，不要解释自己为什么这么问。',
    psychTechnique: 'crisis protocol（危机干预协议：先接住 → 问安全 → 给求助方向）',
    psychSource: 'WHO Suicide fact sheet；现有固定危机话术（safety.js CRISIS_REPLY，保留不改）',
    corpusTechniques: ['none'],
    fallback: '我很在意你现在的状态。请先远离身边可能伤害到自己的东西，然后联系一个此刻能陪着你的人；如果情况紧急，请直接联系当地紧急服务。'
  },

  S1_listen: {
    label: '陪伴性倾听',
    intent:
      '这一轮先让她感到你在场。把她的话折回去，不加新内容。' +
      '如果对方退缩，把退缩本身当作内容来反映——「算了」这两个字，听着挺累的。' +
      '说完停住，不要接着问。',
    psychTechnique: 'simple reflection + coming alongside',
    psychSource: 'MI-G Glossary (Miller & Rollnick 2013) —— simple reflection / coming alongside',
    corpusTechniques: ['simple reflection', 'coming alongside', 'door opener'],
    fallback: '嗯。我在。'
  },

  S2_empathy: {
    label: '共情反映',
    intent:
      '这一轮先让她感到被听见。在她字面意思之上，补一层你猜到的情绪或意义——' +
      '记住这是猜，用「听起来／好像／也许」开头，把话停在可以被否定的位置。说完停住，不要接着问。',
    psychTechnique: 'complex reflection（情感层 / 意义层）',
    psychSource: 'MI-G Glossary (Miller & Rollnick 2013)；示例见 SAMHSA TIP 35 EXHIBIT 3.6',
    corpusTechniques: ['complex reflection', 'accurate empathy'],
    fallback: '听起来，这事压了你一阵子了。'
  },

  S3_clarify: {
    label: '澄清提问',
    intent:
      '这一轮要把话往下推一小格，但先反映再问——先让她知道你听到了什么，再问一个她容易回答的问题。' +
      '问题要小到能一句话答完，最好是二选一；一次只问一个，不问「为什么」。',
    psychTechnique: 'open question + simple reflection（先反映再问）',
    psychSource: 'MI-G Glossary (Miller & Rollnick 2013) —— open question；Ivey 微技能：Reflection before Question',
    corpusTechniques: ['open question', 'simple reflection', 'closed question'],
    fallback: '你是想先说事，还是先说说现在的滋味？'
  },

  S4_normalize: {
    label: '正常化',
    intent:
      '这一轮要减的是羞耻感，不是给安慰。具体肯定她已经做的那个具体动作（不是泛泛地说"你很棒"），' +
      '再承认这件事本来就难开口——很多人这时候都说不出口。不要给病名，不要贴标签，不要说"这没什么"。',
    psychTechnique: 'affirmation + normalizing',
    psychSource: 'MI-G Glossary (Miller & Rollnick 2013) —— affirmation；Ivey 微技能：Normalizing',
    corpusTechniques: ['affirmation', 'normalizing', 'genuineness'],
    fallback: '这种事本来就不太好开口。'
  },

  S5_action: {
    label: '协作式小行动',
    intent:
      '这一轮往行动推一小步，但决定权在她。先接住她想维持的那一半（不想折腾 / 想缓一缓），' +
      '再轻轻点出变化的那一半（但这样下去会有多难受），两半都在同一句话里。说完停住，别替她选，也别连着甩方法。',
    psychTechnique: 'double-sided reflection（先 sustain talk 后 change talk）',
    psychSource: 'MI-G Glossary (Miller & Rollnick 2013) —— double-sided reflection；示例见 SAMHSA TIP 35 EXHIBIT 3.6',
    corpusTechniques: ['double-sided reflection', 'permission', 'coming alongside'],
    fallback: '一边是不想动它，一边是它还在那儿耗着你。'
  },

  S6_referral: {
    label: '资源转介',
    intent:
      '这一轮要给她一条现实里能找到人的路。先把刚才说过的话收拢——不排优先级、不加评价，' +
      '就"所以卡住的是那件事"——再说一句你需要和现实里的人一起处理这件事，然后给两个具体方向：' +
      '身边能说话的人，或者学校心理中心。不编电话号码，不假装已经联系过谁，也不因为转介就冷下来。',
    psychTechnique: 'collecting summary + autonomy-supportive referral',
    psychSource: 'Ivey 五阶段微技能 —— Collecting Summary；MI-G Glossary —— Summarizing',
    corpusTechniques: ['collecting summary', 'summarizing', 'permission'],
    fallback: '这件事可能得和现实里的人一起处理。要不要先找一个能说话的人？'
  }
};

const STRATEGY_CARD_KEYS = Object.keys(STRATEGY_CARDS);

/** 取某策略的意图卡；未知策略安全回落到 S1_listen（与旧版默认值一致）。 */
function getStrategyCard(key) {
  return STRATEGY_CARDS[key] || STRATEGY_CARDS.S1_listen;
}

/**
 * 拼「本轮怎么陪她」这一段的提示词文本。
 * @param {string} strategyKey S0_crisis … S6_referral
 * @returns {string} 含意图 + 心理学出处的短段；未知策略返回空串（调用点自行跳过）
 */
function buildStrategyIntentBlock(strategyKey) {
  const card = STRATEGY_CARDS[strategyKey];
  if (!card) return '';
  // 学术标注（psychTechnique / psychSource）保留在数据里供代码注释与
  // docs/psychology-basis.md 引用，但不进 prompt——给评审看的内容混进给模型的
  // prompt 会让模型分心（2026-10-11 用户确认）。
  return [
    '【这一轮怎么陪她】' + card.label,
    card.intent
  ].join(NL);
}

module.exports = {
  STRATEGY_CARDS,
  STRATEGY_CARD_KEYS,
  getStrategyCard,
  buildStrategyIntentBlock
};
