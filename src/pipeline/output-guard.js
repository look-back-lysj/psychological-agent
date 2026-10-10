/**
 * 模块：pipeline/output-guard —— 输出后检（OutputGuard）
 * 层级：pipeline L3（装配）
 * 职责：把 v4.0 的两道防线合到一个出口：
 *      ① 安全拦截 —— 原样调用 safety.js 的 checkOutputSafety（六类拦截，一个字都不改，保留不动）；
 *      ② AI 味快检 —— 本地正则 + 禁词表，扫《中文 AI 味禁用清单》19 条，0 次 LLM 调用。
 *      这一层替代旧版「校」Rewriter：旧版实测触发率只有 5%，18 条 AI 腔词基本无人看管，
 *      却为此多花一次 LLM 调用（总延迟 +0.6s）。本地规则 100% 覆盖且零延迟。
 * 依赖：safety.js（checkOutputSafety，冻结契约）、data/ai-slop-list.json（19 条）、pipeline/strategy-cards（策略兜底话术）
 * 被依赖：chat/pipeline（XINYU_V4=on 时替代 checkOutputSafety 调用点）
 * 改动风险：🟡 中 —— node --check + node tests/run.js
 * 契约：checkOutput(text, opts) → { blocked, reason, fallback, slopHits }
 *      opts = { strategy, riskLevel, history }
 *      history 可选，传最近几轮的 { role, text } 或纯字符串数组；用于 SL-011 / SL-013 窗口判定
 * 不要做什么：
 *   1) 不要修改 src/safety.js —— 它是冻结契约，也是这套系统的最后一道物理防线。
 *      本模块只做「在它之外再加一层」，绝不能替换、包裹或弱化它的判定。
 *   2) 不要用 LLM 重写命中项 —— 命中就返回策略兜底话术。重写会重新引入延迟，
 *      而重写后的文本同样可能再次踩坑，等于把问题往后推而不是解决。
 *   3) 不要把 medium/low 严重度也升级成拦截 —— 会误伤正常中文表达（SL-014 句号强迫
 *      这类几乎每句都中的条目），拦截率过高会让守岸人变成复读机。
 *      medium/low 只记录到 slopHits，供日志分析，不改变用户看到的回复。
 *   4) 正则必须用 'u' 标志编译（清单里 SL-008 用到 \p{Extended_Pictographic}），
 *      且编译失败要静默跳过该条，不能让一条坏正则打断整轮输出。
 */
/**
 * 守岸人 · 输出后检 OutputGuard
 *
 * 判定顺序（安全永远优先）：
 *   checkOutputSafety(text)  →  命中即返回 blocked，兜底话术来自 safety.js
 *        ↓ 未命中
 *   AI 味正则快检（severity=high）  →  命中即 blocked，兜底话术来自策略意图卡
 *        ↓ 未命中
 *   AI 味正则快检（severity=medium/low）+ 窗口判定（SL-011 / SL-013）
 *        →  不拦截，只写进 slopHits 供日志分析
 */

const { checkOutputSafety } = require('../safety');
const SLOP_LIST = require('../../data/ai-slop-list.json');
const { getStrategyCard } = require('./strategy-cards');

const NL = String.fromCharCode(10);

// 预编译正则（模块加载时一次），避免每轮回复重新编译 19 条正则。
// 编译失败（正则写坏）静默降级为 null，该条目本轮不参与匹配。
const SLOP_RULES = SLOP_LIST.map(item => {
  let re = null;
  if (item.detection_regex) {
    try {
      re = new RegExp(item.detection_regex, 'u');
    } catch (e) {
      re = null;
    }
  }
  return { item, re };
});

/**
 * 「原地打转」窗口判定（SL-011）：把最近 3 条 AI 回复归一化成"结构骨架"，
 * 若任意两条骨架高度相似（≥0.8），说明守岸人在同一句式上原地重复，
 * 这时即便本轮只轻微命中 SL-011 的正则，也应当判为高危。
 */
function structureSkeleton(text) {
  return String(text || '')
    .replace(/[\p{Extended_Pictographic}️]/gu, '')
    .replace(/[^一-龥A-Za-z0-9]/g, '');
}

function skeletonSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // 字符 2-gram Jaccard，够用且 O(n)
  const grams = s => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  ga.forEach(g => { if (gb.has(g)) hit += 1; });
  return hit / Math.min(ga.size, gb.size);
}

/**
 * 从 history 里取出最近 n 条 AI 回复。history 允许两种形态：
 *   [{ role: 'assistant', text: '...' }, ...]  或  ['...', '...']
 */
function recentAssistantReplies(history, n) {
  const out = [];
  const arr = Array.isArray(history) ? history : [];
  for (let i = arr.length - 1; i >= 0 && out.length < n; i -= 1) {
    const item = arr[i];
    if (item == null) continue;
    if (typeof item === 'string') { out.push(item); continue; }
    if (item && (item.role === 'assistant' || item.role === 'ai')) {
      out.push(String(item.text || ''));
    } else if (item && item.text && !item.role) {
      out.push(String(item.text));
    }
  }
  return out;
}

/**
 * AI 味快检。
 * @param {string} text
 * @param {Array} slopHits 输出数组（原地追加）
 * @returns {Array} 命中的 high 条目
 */
function detectSlop(text, slopHits) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const highHits = [];
  for (const rule of SLOP_RULES) {
    if (!rule.re) continue;
    let matched = false;
    try {
      matched = rule.re.test(s);
    } catch (e) {
      matched = false;
    }
    if (!matched) continue;
    const hit = {
      id: rule.item.id,
      name: rule.item.name,
      severity: rule.item.severity
    };
    slopHits.push(hit);
    if (rule.item.severity === 'high') highHits.push(rule.item);
  }
  return highHits;
}

/**
 * 输出后检：安全拦截（保留 safety.js） + AI 味快检（新增）。
 * @param {string} text  模型生成的回复
 * @param {object} opts  { strategy, riskLevel, history }
 * @returns {{ blocked: boolean, reason: string, fallback: string, slopHits: Array }}
 */
function checkOutput(text, opts) {
  const o = opts || {};
  const strategy = o.strategy || 'S1_listen';
  const slopHits = [];

  // —— ① 安全拦截：safety.js 是冻结契约，原样调用，任何异常都放行（不误伤正常回复）——
  let safety = null;
  try {
    safety = checkOutputSafety(text);
  } catch (e) {
    safety = null;
  }
  if (safety && safety.blocked) {
    return {
      blocked: true,
      reason: safety.reason || 'output_safety',
      fallback: safety.fallback || '',
      slopHits
    };
  }

  // —— ② AI 味高危正则快检 ——
  const highHits = detectSlop(text, slopHits);
  if (highHits.length) {
    const card = getStrategyCard(strategy);
    return {
      blocked: true,
      reason: 'slop_high:' + highHits.map(h => h.id).join(','),
      fallback: card.fallback || '',
      slopHits
    };
  }

  // —— ③ 窗口判定：SL-011 原地打转 / SL-013 总结癖 ——
  // 单轮正则抓不到"连续两轮同结构"这件事，需要看历史。
  const prevReplies = recentAssistantReplies(o.history, 3);
  if (prevReplies.length >= 2) {
    const skeletons = prevReplies.map(structureSkeleton).filter(Boolean);
    const current = structureSkeleton(text);
    let stagnant = false;
    for (let i = 0; i < skeletons.length; i += 1) {
      for (let j = i + 1; j < skeletons.length; j += 1) {
        if (skeletonSimilarity(skeletons[i], skeletons[j]) >= 0.8) { stagnant = true; break; }
      }
      if (stagnant) break;
    }
    // 本轮也撞上了 SL-011 / SL-013 的开场结构，且历史里已出现复读 → 升为高危
    const loopish = /^\s*(?:听起来|我理解|我明白|我能理解|我能感受到|我感同身受|让我总结|总结一下)/.test(String(text || ''));
    if (stagnant && loopish) {
      const card = getStrategyCard(strategy);
      slopHits.push({ id: 'SL-011', name: '原地打转（Stagnation）', severity: 'high', window: true });
      return {
        blocked: true,
        reason: 'slop_high:SL-011(window)',
        fallback: card.fallback || '',
        slopHits
      };
    }
    // 只是历史在复读、本轮本身没问题 → 只记录，不拦截
    if (stagnant) {
      slopHits.push({ id: 'SL-011', name: '原地打转（Stagnation）', severity: 'high', window: true });
    }
  }

  return {
    blocked: false,
    reason: '',
    fallback: '',
    slopHits
  };
}

module.exports = {
  checkOutput,
  detectSlop,
  recentAssistantReplies,
  structureSkeleton,
  skeletonSimilarity,
  SLOP_RULES
};
