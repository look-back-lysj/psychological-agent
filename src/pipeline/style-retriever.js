/**
 * 模块：pipeline/style-retriever —— 风格检索层（StyleRetriever）
 * 层级：pipeline L3（装配）
 * 职责：用纯规则（0 次 LLM 调用、<50ms）从两份本地 JSON 清单里，各检索出
 *      本轮最该给模型看的条目：① 风格语料 3~5 条（让人"照着说"），
 *      ② AI 味禁用提醒 2~3 条（让人"别踩已知的坑"）。
 *      这是 v4.0「规则:语料 ≈ 1:1」里"语料"那一半的实现，对应架构方案公理 1 与公理 2。
 * 依赖：data/style-corpus.json（54 条）、data/ai-slop-list.json（19 条）、pipeline/strategy-cards（corpusTechniques）
 * 被依赖：pipeline/prompts-v4（第 3 段 / 第 4 段）、pipeline/output-guard（历史去重的共享状态）
 * 改动风险：🟢 低 —— node --check + node tests/run.js（本模块不被旧链路调用，改动不影响 42/42）
 * 契约：retrieveExamples(opts) / retrieveSlopWarnings(opts) / resetSeen() / getSeenCount()
 *      opts = { userMessage, strategy, riskLevel, count, exclude, sceneBias }
 * 不要做什么：
 *   1) 不要引入向量库 / embedding / 任何网络调用 —— 架构方案明写"保证 <50ms、0 次 LLM 调用"，
 *      且打包成 exe 后没有模型文件可加载；关键词重合度足够。
 *   2) 不要用 fs 每次读文件 —— 用 require()，Node 会缓存 JSON 模块。
 *   3) 不要在这里判定安全或决定策略 —— 策略路由与风险分级属于 strategy.js / safety.js，
 *      本模块只做"检索"，误以为自己能改路线就会导致不可回归的漂移。
 *   4) 本模块任何异常都必须被吞掉并返回空数组：检索失败只是少几条示例，
 *      绝不能让主链路 500。
 */
/**
 * 守岸人 · 风格检索层
 *
 * 检索打分（权重从高到低）：
 *   1) 心理学技术匹配（corpusTechniques 命中）——  +60
 *   2) 场景关键词与用户消息的语义重叠（中文 2-gram 重合度）——  +0~30
 *   3) 风格标签命中当前意图词（简单 / 短句 / 二选一…）——  +0~10
 *   4) 未被本会话最近两轮用过的条目 ——  +8（保证不连续重复同一条例句）
 *   5) 最近轮次里出现过的示例 ——  −40（硬去重，Set 去重）
 *
 * 连续两轮返回相同示例是最典型的"AI 复读机"来源：模型会直接照抄上一轮，
 * 于是同一句"听着挺累的"在整段对话里出现三次。Set 去重就是防这个。
 */

const CORPUS = require('../../data/style-corpus.json');
const SLOP_LIST = require('../../data/ai-slop-list.json');
const { getStrategyCard } = require('./strategy-cards');

// 中文停用字：出现在这里面的字不参与 2-gram 重合度计算，否则"我今天很累了"
// 和"我今天也很累"会因为共享大量"的/很/我"而假性高分。
const STOP_CHARS = new Set(
  ('的了是我你他她它们在有和就都而及与也很不没要会能对吧啊呢吗吧呀哦嗯把被让从向给再还只又这么那么好像似般如若呢啊呀之其而且并却则即更最太非常真的挺有点有些这那些哪什么怎样如何为什么但是所以因为如果虽然然后接着最后于是不过只是真的确实').split('')
);

// —— 本进程内的"已用示例"记忆（跨轮去重）——
// 只保存最近 40 条 id 的环形缓冲；服务是长驻进程，Set 必须有上界，否则会无限增长。
const SEEN_MAX = 40;
// 每一份清单各维护一个"最近 40 条"的环形缓冲：
//   seenCorpusSet / seenSlopSet  —— O(1) 查"这条用过没有"
//   seenCorpusList / seenSlopList —— 保序，淘汰时才知道该删哪个 id
const seenCorpusSet = new Set();
const seenCorpusList = [];
const seenSlopSet = new Set();
const seenSlopList = [];

/** 重置去重记忆（A/B 实验换会话、测试用）。 */
function resetSeen() {
  seenCorpusSet.clear();
  seenCorpusList.length = 0;
  seenSlopSet.clear();
  seenSlopList.length = 0;
}

function getSeenCount() {
  return { corpus: seenCorpusSet.size, slop: seenSlopSet.size };
}

function rememberSeen(set, list, id) {
  set.add(id);
  list.push(id);
  while (list.length > SEEN_MAX) {
    const old = list.shift();
    if (list.indexOf(old) === -1) set.delete(old);
  }
}

function rememberSeen(set, list, id) {
  set.add(id);
  list.push(id);
  while (list.length > SEEN_MAX) {
    const old = list.shift();
    // 只在 set 里已经因环回而被别的窗口淘汰时才删；这里做保守清理：
    // 若该 id 在剩余窗口里还出现，就不删。
    if (!list.includes(old)) set.delete(old);
  }
}

/** 取 2-gram 集合（去掉停用字），用于轻量语义重叠。 */
function bigrams(text) {
  const clean = String(text || '').replace(/[^一-龥A-Za-z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) {
    const g = clean.slice(i, i + 2);
    if (STOP_CHARS.has(g[0]) && STOP_CHARS.has(g[1])) continue;
    out.add(g);
  }
  return out;
}

/** 两集合的 Jaccard 式重合度，返回 0~1。 */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  a.forEach(g => { if (b.has(g)) hit += 1; });
  return hit / Math.min(a.size, b.size);
}

/**
 * 判断语料条目的 psych_technique / style_tags 是否命中目标技术关键词。
 * 语料里技术字段混了中英（如 "simple reflection（简单反映）+ coming alongside（并肩同行）"），
 * 所以按"子串包含"判断，英文关键词转小写后比对。
 */
function matchesTechnique(item, techniques) {
  if (!techniques || !techniques.length) return false;
  if (item.psych_technique === 'none') {
    // 'none' 是"这条语料没有特定技术标注"的占位，只有在目标技术里显式写了 none 时才算命中。
    return techniques.some(t => String(t).toLowerCase() === 'none');
  }
  const hay = (String(item.psych_technique || '') + '|' + (item.style_tags || []).join('|')).toLowerCase();
  return techniques.some(t => {
    const key = String(t).toLowerCase();
    if (!key || key === 'none') return false;
    return hay.indexOf(key) !== -1;
  });
}

/** 从用户消息里抽取少量"意图提示词"，用来给风格标签加一点分。 */
function intentHints(userMessage) {
  const text = String(userMessage || '');
  const hints = [];
  if (/[？?]|怎么办|要不要|该不该|怎么/.test(text)) hints.push('open question', 'closed question', '二选一', '具体化');
  if (/办法|建议|怎么做|帮我|计划|搞定/.test(text)) hints.push('permission', '缩小问题', '给退路');
  if (/不想说|算了|没什么|别问|不想聊/.test(text)) hints.push('coming alongside', '留白', '不追问', '续段式');
  if (/丢人|羞|别人怎么看|只有我|不敢说|承认不了/.test(text)) hints.push('normalizing', 'affirming', '不贴标签');
  if (/值不值得|要不要坚持|纠结|摇摆|两边/.test(text)) hints.push('double-sided reflection', '双侧', '两边都给空间');
  if (/说不清|讲不清|不知道怎么形容|乱/.test(text)) hints.push('uncertain', '软化词', '允许被否定', '不确定');
  if (/谢|谢谢/.test(text)) hints.push('affirming', '接住');
  if (/拜拜|再见|先这样|睡了|走了/.test(text)) hints.push('收尾松', '短句');
  return hints;
}

/**
 * 检索最贴切当前场景的风格示例。
 * @param {object} opts
 * @param {string} opts.userMessage  用户当前消息
 * @param {string} opts.strategy     策略标签（如 S2_empathy）
 * @param {string} opts.riskLevel    风险等级（L0/L1/L2/L3）
 * @param {number} [opts.count=4]    返回条数（3~5）
 * @param {Array<string>} [opts.exclude]  额外要排除的语料 id（调用点可传上一轮结果）
 * @returns {Array<{id, user_says, shorekeeper_says, psych_technique, source}>} 长度 0~count
 */
function retrieveExamples(opts) {
  const o = opts || {};
  try {
    const count = Math.min(Math.max(parseInt(o.count, 10) || 4, 3), 5);
    const strategy = o.strategy || 'S1_listen';
    const riskLevel = o.riskLevel || 'L0';

    // L3 危机不走语料检索（策略卡已声明 corpusTechniques=['none']）：
    // 危机协议是固定话术，任何"风格示例"都是在稀释安全流程。
    if (riskLevel === 'L3') return [];

    const card = getStrategyCard(strategy);
    const techniques = card.corpusTechniques || [];
    const msgGrams = bigrams(o.userMessage);
    const hints = intentHints(o.userMessage).map(h => h.toLowerCase());
    const exclude = new Set([].concat(o.exclude || [], Array.from(seenCorpusSet)));

    const scored = CORPUS.map(item => {
      let score = 0;
      if (matchesTechnique(item, techniques)) score += 60;
      score += overlap(msgGrams, bigrams(item.scene + ' ' + item.user_says)) * 30;
      const tagHay = (item.style_tags || []).join('|').toLowerCase();
      for (const h of hints) if (h && tagHay.indexOf(h) !== -1) score += 5;
      if (exclude.has(item.id)) score -= 40;
      return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    const usedScenes = new Set();
    for (const s of scored) {
      if (picked.length >= count) break;
      if (exclude.has(s.item.id)) continue;
      // 同 scene 最多取 1 条，避免四条示例全在演同一个场景
      if (usedScenes.has(s.item.scene)) continue;
      if (s.score <= 0) continue;
      usedScenes.add(s.item.scene);
      picked.push(s.item);
    }
    // 语料被连续几轮用完（极端情况）→ 放宽：允许已被用过的条目补位，保证不返回空
    if (picked.length < count) {
      for (const s of scored) {
        if (picked.length >= count) break;
        if (picked.indexOf(s.item) !== -1) continue;
        if (s.score <= -20) continue;
        if (usedScenes.has(s.item.scene)) continue;
        usedScenes.add(s.item.scene);
        picked.push(s.item);
      }
    }

    picked.forEach(it => rememberSeen(seenCorpusSet, seenCorpusList, it.id));
    return picked.map(it => ({
      id: it.id,
      user_says: it.user_says,
      shorekeeper_says: it.shorekeeper_says,
      psych_technique: it.psych_technique,
      source: it.source
    }));
  } catch (e) {
    return [];
  }
}


/**
 * 检索本场最可能踩的 AI 味条目。
 * @param {object} opts 同 retrieveExamples（count 默认 3，范围 2~3）
 * @returns {Array<{id, name, wrong, right}>} 长度 0~count
 */
function retrieveSlopWarnings(opts) {
  const o = opts || {};
  try {
    const raw = parseInt(o.count, 10);
    const count = Math.min(Math.max(isNaN(raw) ? 3 : raw, 2), 3);
    const strategy = o.strategy || 'S1_listen';
    const riskLevel = o.riskLevel || 'L0';

    // 策略 → 该策略最容易踩的坑（按架构方案 §3.2 的严重度 + 触发场景归纳）
    const strategyBias = {
      S0_crisis: ['SL-015', 'SL-018', 'SL-009'],
      S1_listen: ['SL-004', 'SL-015', 'SL-006'],
      S2_empathy: ['SL-002', 'SL-001', 'SL-004'],
      S3_clarify: ['SL-004', 'SL-052', 'SL-006'],
      S4_normalize: ['SL-012', 'SL-007', 'SL-015'],
      S5_action: ['SL-005', 'SL-009', 'SL-017'],
      S6_referral: ['SL-018', 'SL-019', 'SL-015']
    }[strategy] || [];

    const msg = String(o.userMessage || '');
    const hintIds = [];
    if (/会好|好起来|怎么办|有用吗/.test(msg)) hintIds.push('SL-009');
    if (/帮我|替我|联系|能不能/.test(msg)) hintIds.push('SL-018');
    if (/为什么是我|只有我|别人都/.test(msg)) hintIds.push('SL-012');
    if (/累|好烦|不想动|撑不住|emo|难受/.test(msg)) hintIds.push('SL-001', 'SL-017');
    if (/(累|难受|难过|烦)/.test(msg)) hintIds.push('SL-011', 'SL-004');

    const exclude = new Set([].concat(o.exclude || [], Array.from(seenSlopSet)));
    const scored = SLOP_LIST.map(item => {
      let score = 0;
      // 只在高危项里优先挑 —— 中低危由 output-guard 静默记录，不占提示词预算
      if (item.severity === 'high') score += 10;
      else score += 2;
      if (strategyBias.indexOf(item.id) !== -1) score += 8;
      if (hintIds.indexOf(item.id) !== -1) score += 6;
      if (riskLevel === 'L2' && item.id === 'SL-015') score += 3;
      if (riskLevel === 'L3' && (item.id === 'SL-015' || item.id === 'SL-018')) score += 3;
      if (exclude.has(item.id)) score -= 30;
      return { item, score };
    });
    scored.sort((a, b) => b.score - a.score);

    const picked = [];
    for (const s of scored) {
      if (picked.length >= count) break;
      if (exclude.has(s.item.id)) continue;
      if (s.score <= 0) continue;
      picked.push(s.item);
    }
    // 全部用完（长会话里连续开新轮）→ 允许复用，放宽到不看 exclude
    if (picked.length < 2) {
      for (const s of scored) {
        if (picked.length >= count) break;
        if (picked.indexOf(s.item) !== -1) continue;
        if (s.score < 0) continue;
        picked.push(s.item);
      }
    }
    picked.forEach(it => rememberSeen(seenSlopSet, seenSlopList, it.id));
    return picked.map(it => ({ id: it.id, name: it.name, wrong: it.wrong, right: it.right }));
  } catch (e) {
    return [];
  }
}

/** 给提示词用：把语料渲染成「对方说「…」→ 你说「…」」的示例行。 */
function renderExampleLines(examples) {
  return (examples || []).map(it => '对方说「' + it.user_says + '」→ 你说「' + it.shorekeeper_says + '」');
}

/** 给提示词用：把 AI 味条目渲染成「❌「…」→ ✅「…」」的提醒行。 */
function renderSlopLines(warnings) {
  return (warnings || []).map(it => {
    const w = (it.wrong && it.wrong[0]) || '';
    const r = (it.right && it.right[0]) || '';
    return '❌「' + w + '」→ ✅「' + r + '」';
  });
}

module.exports = {
  retrieveExamples,
  retrieveSlopWarnings,
  resetSeen,
  getSeenCount,
  renderExampleLines,
  renderSlopLines
};



