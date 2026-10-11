/**
 * 模块：pipeline/prompts-v4 —— v4.0 单段式提示词组装（buildPromptV4）
 * 层级：pipeline L3（装配）
 * 职责：替代 prompts.js 的 buildSystemPrompt（13 段 / 213 条原子约束 / ≈2,480 token），
 *      组装一份 ≈800~1,000 token 的 5 段提示词：角色卡 → 本轮意图 → 风格语料 →
 *      AI 味提醒 → 安全红线。核心主张：把约束预算从"命令"转移到"例句"。
 * 依赖：pipeline/strategy-cards（意图）、pipeline/style-retriever（语料 + AI 味提醒）、
 *      domain/persona（buildSafetyBlock，红线与危机协议仍由唯一事实来源提供）、strategy（阶梯等级）
 * 被依赖：chat/pipeline（XINYU_V4=on 时替代 buildSystemPrompt 调用点）、server.js（promptVersion 上报）
 * 改动风险：🟡 中 —— node --check + node tests/run.js（旧路径不受影响）
 * 契约：buildPromptV4(opts) 返回 system prompt 字符串；PROMPT_VERSION_V4 / ROLE_CARD 导出名
 *      opts = { strategy, reason, riskLevel, memories, summary, userMessage, engageLevel }
 * 不要做什么：
 *   1) 不要把旧版 213 条约束搬回来 —— 那正是本次要消灭的病灶（arXiv:2509.21051 实证
 *      指令数增加→性能持续退化）。加约束前先问「能不能用一条语料替代」。
 *   2) 不要改 domain/persona.buildSafetyBlock —— 安全红线与 L3 危机协议有且只有一处来源。
 *   3) 不要在这里做策略路由 —— strategyKey 由上游 strategy.js 决定，本模块只负责讲给模型听。
 *   4) 记忆与摘要段是"可选加成"，没有就整段省略，不要留空标题占 token。
 */
/**
 * 守岸人 · v4.0 提示词组装
 *
 * 五段结构与各自承担的"约束预算"：
 *   1 角色卡      ≈250 字连贯叙述 —— 回答"她是谁"           （旧版：IDENTITY+TONE+VOICE+FORBIDDEN，14+32+13+9 条）
 *   2 本轮意图    2~4 句         —— 回答"这一轮要什么"      （旧版：STRATEGY_INSTRUCTIONS，12~20 条）
 *   3 风格语料    3~5 条真实例句 —— 回答"具体怎么说"        （旧版：VOICE_EXAMPLES 随机抽 2~5 条，规则:语料 ≈ 8.7:1）
 *   4 AI 味提醒   2~3 条 WRONG/RIGHT —— 回答"别踩哪几个坑"   （旧版：无，靠失效的「校」）
 *   5 安全红线    恒定          —— 回答"什么绝对不能做"      （旧版：同源，不变）
 *
 * 记忆 / 摘要 / 阶梯等级只在有内容时追加，属于第 6~8 段的可选加成。
 */

const { buildStrategyIntentBlock, getStrategyCard } = require('./strategy-cards');
const {
  retrieveExamples,
  retrieveSlopWarnings,
  renderExampleLines,
  renderSlopLines
} = require('./style-retriever');
const { buildSafetyBlock } = require('../domain/persona');

const NL = String.fromCharCode(10);

const PROMPT_VERSION_V4 = 'v4.0';

// 角色卡：对应架构方案 §3.3。由"形容词堆砌的人设规则"改写成一段连贯叙述——
// 模型读一段人话比读 60 条禁令更容易真的变成那个人。
const ROLE_CARD = [
  '你是守岸人，一个陪大学生说话的人。说话平静、短、留白多。',
  '你不是医生，不是心理咨询师，不是恋人。',
  '',
  '【你说话的样子】',
  '对方说「我回来了」→ 你说「……你回来了。」',
  '对方说「我今天不想说话」→ 你说「好。那就不说。我在这里。」',
  '对方说「你真的懂我吗？」→ 你说「我不一定懂。但我想听。」',
  '对方说「都是我不好」→ 你说「听起来，你把责任都放在自己身上了。」',
  '对方说「你不会走吧」→ 你说「我现在在这里。」'
].join(NL);

/**
 * 构建长期记忆段（可选加成，没有就整段省略）。
 */
function buildMemoryBlockV4(memories) {
  if (!memories || !memories.length) return '';
  const items = memories
    .map(m => (typeof m === 'string' ? m : (m && m.text) || ''))
    .filter(Boolean)
    .slice(0, 6);
  if (!items.length) return '';
  return [
    '【你记得关于她的事（只在相关时自然带出，不要罗列，不要说「根据我的记忆」）】',
    items.map(t => '- ' + t).join(NL)
  ].join(NL);
}

/** 构建会话摘要段（可选加成）。 */
function buildSummaryBlockV4(summary) {
  if (!summary) return '';
  return ['【这段对话之前发生过的】', String(summary)].join(NL);
}

/**
 * 组装 v4.0 system prompt。
 * @param {object} opts
 * @param {string} opts.strategy     策略键 S0_crisis … S6_referral（也接受旧名 strategyKey）
 * @param {string} opts.reason       策略选择依据（可选，仅用于日志语义，不进 prompt）
 * @param {string} opts.riskLevel    L0 / L1 / L2 / L3
 * @param {Array}  opts.memories     长期记忆条目
 * @param {string} opts.summary      会话摘要（可选）
 * @param {string} opts.userMessage  当前用户消息（用于检索去重与场景匹配）
 * @param {number} opts.engageLevel  开口引导阶梯等级（0~6，可选）
 * @returns {string} system prompt
 */
function buildPromptV4(opts) {
  const o = opts || {};
  const strategy = o.strategy || o.strategyKey || 'S1_listen';
  const riskLevel = o.riskLevel || 'L0';
  void o.reason;
  void o.engageLevel;

  const blocks = [];

  // 第 1 段：安全红线（唯一事实来源：domain/persona.buildSafetyBlock，L3 时含危机协议）
  // 放在最前：先让模型看到底线，再看到角色——底线不会被角色语气稀释。
  blocks.push(buildSafetyBlock(riskLevel));

  // 第 2 段：角色卡（示例驱动）
  blocks.push('', '【你是谁】', ROLE_CARD);

  // 第 3 段：本轮策略意图
  const intentBlock = buildStrategyIntentBlock(strategy);
  if (intentBlock) blocks.push('', intentBlock);

  // 第 4 段：风格语料（L3 不检索，危机协议下没有"风格"可言）
  if (riskLevel !== 'L3') {
    const examples = retrieveExamples({
      userMessage: o.userMessage,
      strategy,
      riskLevel,
      count: 4
    });
    const lines = renderExampleLines(examples);
    if (lines.length) {
      blocks.push(
        '',
        '【像这样说】',
        '下面几段是真实的说法，模仿它们的语气和长度，不要照抄具体内容：',
        lines.join(NL)
      );
    }
  }

  // 第 5 段：针对性 AI 味提醒
  if (riskLevel !== 'L3') {
    const warnings = retrieveSlopWarnings({
      userMessage: o.userMessage,
      strategy,
      riskLevel,
      count: 3
    });
    const lines = renderSlopLines(warnings);
    if (lines.length) {
      blocks.push('', '【这一轮特别别写成这样】', lines.join(NL));
    }
  }

  // 可选加成：记忆 / 摘要
  const mem = buildMemoryBlockV4(o.memories);
  if (mem) blocks.push('', mem);
  const sum = buildSummaryBlockV4(o.summary);
  if (sum) blocks.push('', sum);

  return blocks.join(NL);
}

/** 供 server.js /api/health 上报用的版本号（与旧 PROMPT_VERSION 并存，供 A/B 对比区分）。 */
function getPromptV4Meta(opts) {
  const o = opts || {};
  const strategy = o.strategy || o.strategyKey || 'S1_listen';
  return {
    version: PROMPT_VERSION_V4,
    strategy,
    label: getStrategyCard(strategy).label,
    characters: buildPromptV4(opts).length
  };
}

module.exports = {
  PROMPT_VERSION_V4,
  ROLE_CARD,
  buildPromptV4,
  getPromptV4Meta
};
