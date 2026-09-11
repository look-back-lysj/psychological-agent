/**
 * 守岸人 · 「回来」体验（情感连续性）
 *
 * 目标：用户每次打开页面，都能感到「它记得我」。
 * 做法：完全不调用大模型 —— 用本地状态（上次打开时间 / 来访次数）
 *       + 长期记忆（listMemories）+ 时段，模板拼装出问候语与动态建议。
 *
 * 状态文件：data/state.json
 *   { lastSeenAt, visitCount, firstSeenAt }
 * 读写一律 try/catch 静默降级：任何失败都不能让服务起不来。
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');
const memory = require('./memory');
const { truncate } = require('./utils');

// ── 常量 ────────────────────────────────────────────────────────
const STATE_FILE_NAME = 'state.json';
const MEMORY_TAG_LIMIT = 3;   // 浮起标签最多 3 条
const MEMORY_TAG_LEN = 16;    // 每条标签截断到 16 字
const LONG_GAP_HOURS = 72;    // 超过 72 小时视为「有一阵子没见」
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// ── 本地状态：读 / 写（失败一律静默）────────────────────────────

function emptyState() {
  return { lastSeenAt: null, visitCount: 0, firstSeenAt: null };
}

/** state.json 的绝对路径；dataDir() 不可用时返回 null。 */
function stateFilePath() {
  try {
    return path.join(dataDir(), STATE_FILE_NAME);
  } catch (e) {
    return null;
  }
}

/** 把任意解析结果规整成安全的状态对象（字段类型不对就走默认值）。 */
function normalizeState(raw) {
  const out = emptyState();
  if (!raw || typeof raw !== 'object') return out;
  const lastSeen = Number(raw.lastSeenAt);
  const firstSeen = Number(raw.firstSeenAt);
  const visits = Number(raw.visitCount);
  out.lastSeenAt = Number.isFinite(lastSeen) && lastSeen > 0 ? lastSeen : null;
  out.firstSeenAt = Number.isFinite(firstSeen) && firstSeen > 0 ? firstSeen : null;
  out.visitCount = Number.isFinite(visits) && visits > 0 ? Math.floor(visits) : 0;
  return out;
}

/**
 * 读取本地状态。文件缺失 / 损坏 / 无权限 都返回默认状态，不抛异常。
 */
function readState() {
  try {
    const file = stateFilePath();
    if (!file || !fs.existsSync(file)) return emptyState();
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return emptyState();
  }
}

/**
 * 读改写本地状态（先写临时文件再改名，避免写一半损坏）。
 * 成功返回合并后的状态，失败返回 null（调用方自行决定降级行为）。
 */
function writeState(patch) {
  try {
    const next = Object.assign(readState(), patch && typeof patch === 'object' ? patch : {});
    const file = stateFilePath();
    if (!file) return null;
    const payload = JSON.stringify(next, null, 2);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (e) { /* 目录已存在或无权限，交给下面的写入失败处理 */ }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      // 某些文件系统不允许改名：退回直接写
      fs.writeFileSync(file, payload, 'utf8');
    }
    return next;
  } catch (e) {
    return null;
  }
}

// ── 时段 / 记忆 ─────────────────────────────────────────────────

/** 5—11 点早晨，12—17 点下午，18—22 点晚上，其余深夜。 */
function pickTimeOfDay(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 23) return 'evening';
  return 'lateNight';
}

/**
 * 从长期记忆里挑 1—3 条作为「我记得」的标签。
 * 排序沿用 listMemories（置顶 / 最近使用优先），过滤已失效与高敏感条目。
 */
function pickMemoryHighlights() {
  try {
    const items = memory.listMemories() || [];
    const active = items.filter(it => it
      && typeof it.text === 'string' && it.text.trim()
      && it.status !== 'superseded'
      && it.sensitivity !== 'high');
    return active.slice(0, MEMORY_TAG_LIMIT)
      .map(it => truncate(it.text.trim(), MEMORY_TAG_LEN))
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ── 问候语模板（守岸人语气：平静、克制、零感叹号、省略号克制）──
// 共 30 条，按「首次 / 时段 / 间隔长短 / 有无记忆」组合；{memory} 为记忆占位符。
const GREETING = {
  first: [
    '我是守岸人。你可以先坐一会儿，不用急着说什么。',
    '我是守岸人。这里没有要完成的事，慢慢来就好。',
    '我是守岸人。不用先想好第一句话，停一会儿也可以。',
    '我是守岸人。你想说多少都可以，不用有负担。'
  ],
  lateNight: [
    '这么晚还醒着。先说说你现在是什么状态就好。',
    '这个点还没睡。不用把事情理清楚，想到哪儿说到哪儿。',
    '深夜容易把情绪放得更大。你先说说，现在最吵的是哪个念头。',
    '这么晚还醒着。上次说的「{memory}」，是不是还在心里转。',
    '夜里安静下来，有些事反而更清楚。比如「{memory}」。'
  ],
  longGap: [
    '有一阵子没见了。不用解释什么，想从哪儿说起都可以。',
    '隔了些日子。这里还是原样，你不用先补上中间那段。',
    '你回来了。空着的那段时间，不说也没关系。',
    '有一阵子没见了。上次的「{memory}」，后来怎么样了。',
    '隔了几天。我还记得「{memory}」，你愿意说就说。'
  ],
  memory: [
    '又见面了。上次你提到「{memory}」，今天还好吗？',
    '又见面了。「{memory}」那件事，现在到哪一步了。',
    '我还记得「{memory}」。今天想接着它说，还是先说点别的。',
    '你之前说过「{memory}」。不用接着上次，也可以从这里开始。',
    '「{memory}」……不知道今天再想起来，是什么感觉。'
  ],
  morning: [
    '早上好。新的一天刚开始，你可以先说一句现在最直接的感觉。',
    '早。不用急着进入状态，先说说昨晚睡得怎么样。',
    '天亮了。今天有什么在等着你，也可以先放下几分钟。'
  ],
  afternoon: [
    '下午了。这个时候容易累，先说是身体累，还是心里累。',
    '午后的时间有点长。你现在最想放下的是哪一件事。',
    '下午好。不用挑重点，随便说说也行。'
  ],
  evening: [
    '晚上了。今天发生过的事，有没有哪一件还堵在心里。',
    '这时候安静下来，情绪常常会浮上来。你先说说，现在是什么感觉。',
    '晚上了。要是今天没能顾上自己，现在可以慢一点。'
  ],
  returning: [
    '又见面了。今天想从哪件小事说起都可以。',
    '你回来了。不用先总结，随便从哪里开始。',
    '我在。你今天的状态，和昨天比有变化吗？',
    '又见面了。先说说现在最占地方的那件事。'
  ]
};

/** 稳定但会随来访次数变化的选择，避免每次落到同一条。 */
function pick(list, seed) {
  if (!list || !list.length) return '';
  const n = Math.abs(Math.floor(seed || 0));
  return list[n % list.length];
}

/** 填充 {memory} 占位符；无记忆时不该选到带占位符的模板。 */
function fillTemplate(tpl, memoryText) {
  return String(tpl || '').replace(/\{memory\}/g, memoryText || '');
}

/**
 * 按优先级组合问候语：
 * 首次 > 深夜 > 久未到访 > 有记忆 > 时段 > 通用兜底。
 */
function buildGreeting(ctx) {
  const mem = ctx.memoryHighlights[0] || '';
  const seed = ctx.visitCount + Math.floor(Date.now() / DAY_MS);

  if (ctx.firstVisit) return fillTemplate(pick(GREETING.first, seed), mem);

  if (ctx.timeOfDay === 'lateNight') {
    const pool = GREETING.lateNight.filter(t => mem ? t.indexOf('{memory}') !== -1 : t.indexOf('{memory}') === -1);
    return fillTemplate(pick(pool.length ? pool : GREETING.lateNight, seed), mem);
  }

  if (ctx.hoursSince !== null && ctx.hoursSince > LONG_GAP_HOURS) {
    const pool = GREETING.longGap.filter(t => mem ? t.indexOf('{memory}') !== -1 : t.indexOf('{memory}') === -1);
    return fillTemplate(pick(pool.length ? pool : GREETING.longGap, seed), mem);
  }

  if (mem) return fillTemplate(pick(GREETING.memory, seed), mem);

  const pool = GREETING[ctx.timeOfDay] || GREETING.returning;
  return fillTemplate(pick(pool, seed), mem);
}

// ── 动态建议 ───────────────────────────────────────────────────

// 记忆关键词 → 贴合当前处境的短建议（每条记忆只取第一个命中的规则）
const SUGGESTION_RULES = [
  { re: /(论文|毕业|答辩|导师|课题组|科研)/, tips: ['还是论文的事', '论文卡在哪里了'] },
  { re: /(考试|挂科|成绩|绩点|保研|考研|复习)/, tips: ['考试的事有点压', '最近复习得怎么样'] },
  { re: /(实习|求职|找工作|面试|简历|offer)/i, tips: ['还在想工作的事', '面试准备得如何'] },
  { re: /(室友|宿舍|朋友|人际|同学|同门)/, tips: ['和ta之间的事', '宿舍里还好吗'] },
  { re: /(家人|父母|爸妈|家里|亲人)/, tips: ['家里的事还在心里', '想说说家里的事'] },
  { re: /(恋爱|感情|分手|前任|喜欢的人)/, tips: ['感情上的事', '还想说ta的事'] },
  { re: /(失眠|睡不着|熬夜|睡不好|睡眠)/, tips: ['最近还是睡不好', '昨晚又失眠了'] },
  { re: /(焦虑|压力|紧张|烦躁|很累|撑不住|难受|低落|emo)/i, tips: ['最近一直很累', '压力好像没散'] }
];

const GENERIC_SUGGESTIONS = ['今天状态还行', '想说点别的', '不知道从哪儿开始', '先随便聊聊'];

/**
 * 生成 3—4 条不重复的动态建议：优先从记忆生成，再补至少 2 条通用兜底。
 */
function buildSuggestions(highlights, seed) {
  const out = [];
  const push = (text) => {
    const t = String(text == null ? '' : text).trim();
    if (t && out.indexOf(t) === -1 && out.length < 4) out.push(t);
  };

  // 最多从 2 条记忆里生成 2 条个性化建议
  for (const h of highlights.slice(0, 2)) {
    let matched = false;
    for (const rule of SUGGESTION_RULES) {
      if (rule.re.test(h)) {
        rule.tips.forEach(push);
        matched = true;
        break;
      }
    }
    if (!matched) push('还想说「' + h + '」');
    if (out.length >= 2) break;
  }

  // 通用兜底至少 2 条：个性化 0 条时给 3 条，保证总数 3—4 条
  const need = out.length >= 2 ? 2 : (out.length === 1 ? 2 : 3);
  const n = Math.abs(Math.floor(seed || 0)) % GENERIC_SUGGESTIONS.length;
  const rotated = GENERIC_SUGGESTIONS.slice(n).concat(GENERIC_SUGGESTIONS.slice(0, n));
  for (const g of rotated) {
    if (out.length >= 2 && out.filter(x => GENERIC_SUGGESTIONS.indexOf(x) !== -1).length >= need) break;
    push(g);
  }
  return out.slice(0, 4);
}

// ── 对外主入口 ─────────────────────────────────────────────────

/**
 * 组装「回来」上下文；同时把本次打开写进 state.json（失败静默）。
 * @returns {{firstVisit:boolean,lastSeenAt:number|null,hoursSince:number|null,timeOfDay:string,greeting:string,memoryHighlights:string[],suggestions:string[],visitCount:number}}
 */
function getComeback() {
  const now = Date.now();
  const prev = readState();

  const firstVisit = !prev.lastSeenAt;
  const hoursSince = prev.lastSeenAt ? Math.max(0, (now - prev.lastSeenAt) / HOUR_MS) : null;
  const visitCount = (prev.visitCount || 0) + 1;
  const timeOfDay = pickTimeOfDay(now);
  const memoryHighlights = pickMemoryHighlights();
  const seed = visitCount + Math.floor(now / DAY_MS);

  const greeting = buildGreeting({ firstVisit, hoursSince, timeOfDay, memoryHighlights, visitCount });
  const suggestions = buildSuggestions(memoryHighlights, seed);

  // 落盘：无论成功与否都返回本次上下文
  writeState({ lastSeenAt: now, visitCount, firstSeenAt: prev.firstSeenAt || now });

  return {
    firstVisit,
    lastSeenAt: prev.lastSeenAt || null,
    hoursSince: hoursSince === null ? null : Math.round(hoursSince * 10) / 10,
    timeOfDay,
    greeting,
    memoryHighlights,
    suggestions,
    visitCount
  };
}

module.exports = {
  getComeback,
  // 导出状态读写工具：供外部按需读写同一份 state.json（各自读改写、失败静默）
  readState,
  writeState,
  stateFilePath
};
