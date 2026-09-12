#!/usr/bin/env node
/**
 * 守岸人 · 前端分区规范校验器（public/app.js）
 *
 * 作用：验证 public/app.js 里每个顶层 function 都归属于某个「分区标记」之下，
 *       没有函数被写到「第一个分区之前」或「两个分区之间的注释夹缝」里。
 *
 * 为什么需要它：public/app.js 有 3700+ 行、190+ 个顶层函数，有意保持单文件（不拆模块，
 * 理由见该文件头的 §0 目录）。单文件靠的是一套「分区注释」当导航；一旦有人把新函数随手
 * 插在文件末尾、或插在某个分区注释块的上方，导航就失效了 —— 而 JS 语法检查
 * （node --check）不会报错，code review 也容易漏。这个脚本把「分区约定」变成可机检的规则。
 *
 * 用法：
 *   node scripts/check-frontend-sections.js           # 打印每个分区的函数数 + 未归属函数
 *   node scripts/check-frontend-sections.js --check   # 静默模式：只在有问题时输出（CI 门禁用）
 *
 * 退出码：
 *   0 = 通过（所有顶层函数都有明确分区归属）
 *   1 = 存在「未归属任何分区的顶层函数」，或文件读不到 / 没有解析到分区标记
 *
 * 判定规则（无依赖、纯 Node 内置模块，逐字符扫描而非正则）：
 *   1) 分区标记是一段块注释：开栏行是注释起始符后面接一串等号；中间是标题（可能还有
 *      若干以星号开头的说明行）；收尾行是「星号 + 一串等号 + 块注释结束符」。
 *   2) 顶层函数 = 恰好缩进 2 个空格、以 function / async function 开头的定义行
 *      （IIFE 内部的顶层；更深缩进的嵌套函数 / 箭头函数不计入）。
 *   3) 归属：某函数归属于「在其行号之前、行号最大的那个分区标记」。第一个分区标记之前
 *      的函数视为未归属。分区名里的中文、行号漂移都不影响判定（按行号比较，不按固定数字）。
 *
 * 何时该跑它（When to run）：
 *   - 任何向 public/app.js 新增 / 移动 / 删除顶层函数的改动之后；
 *   - 新增一个分区标记之后（确认没有函数落在新分区上方的夹缝里）；
 *   - CI 门禁：node scripts/check-frontend-sections.js --check，退出码非 0 即失败。
 *   期望状态：25 个分区标记、192 个顶层函数、未归属 0。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 允许把目标文件当第一个位置参数传进来（默认 public/app.js）。
// 这个口子主要用于「验证脚本本身能检出未归属函数」：拿一个假文件喂给它。
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const fileArg = argv.find((a) => !a.startsWith('--'));
const APP = fileArg ? path.resolve(fileArg) : path.join(ROOT, 'public', 'app.js');

/** 读取文件并按行切开（兼容 CRLF / LF，保存时统一按原换行风格回写由编辑器负责，本脚本只读）。 */
function readLines(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // 去掉可能的 BOM
  return raw.split(/\r?\n/);
}

/** 判断一行是否是分区标记的「开栏行」：块注释起始符后面全是等号。 */
function isMarkerOpen(line) {
  const t = line.trim();
  if (!t.startsWith('/*')) return false;
  const rest = t.slice(2).trim();
  if (!rest) return false;
  // 允许结尾出现块注释结束符，但开栏行一般没有
  const body = rest.replace(/\*\/\s*$/, '').trim();
  return body.length > 0 && /^=+$/.test(body);
}

/** 判断一行是否是分区标记的「收尾行」：星号 + 一串等号 + 块注释结束符。 */
function isMarkerClose(line) {
  const t = line.trim();
  if (!t.includes('*/')) return false;
  // 去掉结尾的块注释结束符，再去掉前导的星号，剩下的应该全是等号
  const body = t.replace(/\*\/\s*$/, '').replace(/^\*/, '').trim();
  return body.length > 0 && /^=+$/.test(body);
}

/** 从一个分区标记的标题行里抽出标题文本（去掉前导的星号和空白）。 */
function markerTitle(line) {
  return line.replace(/^\s*\*\s*/, '').trim();
}

/**
 * 解析所有分区标记。
 * 返回 [{ openLine, closeLine, title }]，行号从 1 开始。
 * 用逐字符扫描「'/* ' 后面是不是清一色 = 号」来判定开栏，
 * 再向下最多找 16 行，遇到「星号 + 等号 + 块注释结束符」收尾，中间是标题 + 说明。
 */
function parseSections(lines) {
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isMarkerOpen(lines[i])) continue;
    let close = -1;
    for (let j = i + 1; j < Math.min(i + 17, lines.length); j++) {
      if (isMarkerClose(lines[j])) {
        close = j;
        break;
      }
    }
    if (close < 0) continue; // 不是分区标记（可能只是普通长注释），跳过
    // 标题 = 开栏行之后、收尾行之前，第一个非空且以 `*` 开头的行
    let title = '';
    for (let j = i + 1; j < close; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (!t.startsWith('*')) continue;
      const candidate = markerTitle(lines[j]);
      if (candidate) {
        title = candidate;
        break;
      }
    }
    sections.push({
      openLine: i + 1,
      closeLine: close + 1,
      title: title || '(未命名分区)',
    });
  }
  return sections;
}

/** 解析顶层函数：恰好 2 个空格缩进 + function / async function。 */
function parseTopLevelFunctions(lines) {
  const fns = [];
  const re = /^ {2}(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) fns.push({ line: i + 1, name: m[1] });
  }
  return fns;
}

/** 把函数归属到「在其之前、行号最大的分区」。 */
function assign(fns, sections) {
  const buckets = sections.map(() => []);
  const unassigned = [];
  for (const fn of fns) {
    let idx = -1;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].openLine < fn.line) idx = i;
      else break;
    }
    if (idx < 0) unassigned.push(fn);
    else buckets[idx].push(fn);
  }
  return { buckets, unassigned };
}

function main() {
  let lines;
  try {
    lines = readLines(APP);
  } catch (err) {
    console.error('[分区校验] 读不到 ' + APP + '：' + err.message);
    process.exit(1);
  }

  const sections = parseSections(lines);
  const fns = parseTopLevelFunctions(lines);

  if (sections.length === 0) {
    console.error('[分区校验] 未解析到任何分区标记（形如：块注释起始符 + 等号线 / 星号 + 分区名 / 等号线 + 注释结束符）。');
    process.exit(1);
  }

  const { buckets, unassigned } = assign(fns, sections);
  const total = buckets.reduce((a, b) => a + b.length, 0);

  if (CHECK_ONLY && unassigned.length === 0) {
    process.exit(0);
  }

  console.log('守岸人 · app.js 分区校验（' + path.relative(ROOT, APP) + '）');
  console.log('文件行数：' + lines.length + ' | 分区标记：' + sections.length + ' | 顶层函数：' + fns.length);
  console.log('');
  console.log('【分区归属】');
  sections.forEach((s, i) => {
    const n = String(buckets[i].length).padStart(3, ' ');
    console.log('  ' + n + '  ' + s.title + '  @L' + s.openLine);
  });
  console.log('');
  console.log('  合计已归属 ' + total + ' / ' + fns.length + ' 个顶层函数');

  if (unassigned.length > 0) {
    console.log('');
    console.log('【❌ 未归属任何分区的顶层函数】共 ' + unassigned.length + ' 个：');
    unassigned.forEach((f) => console.log('  L' + f.line + '  ' + f.name + '()'));
    console.log('');
    console.log('提示：请把这些函数移动到某个分区标记之下，或在其上方补一个分区标记。');
    process.exit(1);
  }

  console.log('');
  console.log('✅ 通过：所有顶层函数都有明确分区归属。');
  process.exit(0);
}

main();
