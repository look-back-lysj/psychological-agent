#!/usr/bin/env node
/**
 * 守岸人 · 分层依赖检查器
 *
 * 作用：验证 `src/` 的依赖方向没有违规、没有循环依赖。
 * 为什么需要它：重构后目录会分层（core → domain → infra → pipeline → chat/api），
 * 但 JS 的 require 不会阻止你反向依赖。这个脚本把「架构约定」变成可机检的规则，
 * 否则几个月后没人记得哪层能依赖哪层。
 *
 * 用法：
 *   node scripts/check-layering.js           # 打印依赖图 + 分层，并做违规/环检查
 *   node scripts/check-layering.js --check   # 静默模式：只在有问题时输出，退出码非 0 表示失败
 *
 * 退出码：0 = 通过；1 = 存在违规或循环依赖
 *
 * 说明：本脚本刻意**不引入任何依赖**，只用 Node 内置模块，且用逐字符扫描
 *      而不是正则（避免转义问题，也避免把注释里的 require 示例误判为真依赖）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CHECK_ONLY = process.argv.slice(2).includes('--check');

/**
 * 分层规则：key 是目录（或文件名），value 是它**允许**依赖的层级序号（可依赖 <= 自己的层）。
 * 数字越大越靠上层；**上层可以依赖下层，下层绝不能依赖上层**。
 *
 * 目录规划（见 ARCHITECTURE.md）：
 *   core      L0  基础设施（utils / paths / logger）—— 不许依赖任何业务层
 *   domain    L1  纯规则（persona / innerstate）—— 不许有 fs / fetch
 *   rules     L2  安全与策略（safety / strategy）—— 冻结契约文件，留顶层语义
 *   infra     L2  有状态或外部调用（config / llm / memory / sessions / comeback）
 *   pipeline  L3  装配（prompts / agents）
 *   chat      L4  编排
 *   api       L4  对外接口
 *
 * ⚠️ 迁移期兼容：文件还在 `src/` 顶层平铺时，用 FLAT_LAYER 给出该文件的层级，
 *    这样脚本在重构前后都能跑，可用作「重构前后行为一致」的守卫。
 */
const DIR_LAYER = {
  core: 0,
  domain: 1,
  // rules 与 infra 同层，但语义不同：rules 是纯函数、infra 有副作用
  rules: 2,
  infra: 2,
  pipeline: 3,
  chat: 4,
  api: 4,
};

/** 迁移期：`src/` 顶层平铺文件 → 层级（数字同 DIR_LAYER） */
const FLAT_LAYER = {
  utils: 0,
  paths: 0,
  logger: 0,
  persona: 1,
  innerstate: 1,
  safety: 2,
  strategy: 2,
  config: 2,
  llm: 2,
  memory: 2,
  sessions: 2,
  comeback: 2,
  prompts: 3,
  agents: 3,
  chat: 4,
  routes: 4,
};

/** 冻结契约文件：允许存在于任何层，但不许被下层依赖（额外规则，见文件头注释） */
const FROZEN = new Set(['safety', 'strategy']);

/** 逐行扫描 require 的字面量路径，跳过注释行 */
function scanRequires(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    let idx = 0;
    while ((idx = line.indexOf('require(', idx)) !== -1) {
      const prev = idx > 0 ? line[idx - 1] : ' ';
      if (/[A-Za-z0-9_$.]/.test(prev)) { idx += 8; continue; }
      const rest = line.slice(idx + 8).trimStart();
      const q = rest[0];
      if (q !== "'" && q !== '"') { idx += 8; continue; }
      const end = rest.indexOf(q, 1);
      if (end === -1) { idx += 8; continue; }
      out.push(rest.slice(1, end));
      idx += 8;
    }
  }
  return out;
}

function listJs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 模块标识：相对 src 的路径，去掉 .js；子目录用 / 分隔 */
const rel = f => path.relative(SRC, f).split(path.sep).join('/').replace(/\.js$/, '');

/** 取某模块的层级；目录形式优先，其次迁移期表 */
function layerOf(id) {
  const seg = id.split('/');
  if (seg.length > 1 && DIR_LAYER[seg[0]] !== undefined) return DIR_LAYER[seg[0]];
  const base = seg[seg.length - 1];
  if (FLAT_LAYER[base] !== undefined) return FLAT_LAYER[base];
  return null;
}

/** 规范化模块名，用于判断「谁依赖谁」（把 chat/index 归一成 chat） */
function norm(id) {
  const parts = id.split('/');
  if (parts.length > 1 && parts[parts.length - 1] === 'index') return parts[0];
  return parts.join('/');
}

const files = listJs(SRC);
const ids = files.map(rel);
const idSet = new Set(ids.map(norm));

const deps = {};
for (const f of files) {
  const id = rel(f);
  const set = new Set();
  for (const r of scanRequires(fs.readFileSync(f, 'utf8'))) {
    if (!r.startsWith('.')) continue;
    const target = path.normalize(path.join(path.dirname(f), r));
    const tid = rel(target);
    if (idSet.has(norm(tid))) set.add(norm(tid));
    else if (idSet.has(norm(tid + '/index'))) set.add(norm(tid + '/index'));
  }
  deps[norm(id)] = [...set];
}

// ── 违规检查：下层不许依赖上层 ────────────────────────────────
const violations = [];
for (const [from, tos] of Object.entries(deps)) {
  const lf = layerOf(from);
  for (const to of tos) {
    const lt = layerOf(to);
    if (lf === null || lt === null) continue;
    if (lt > lf) {
      violations.push(`${from} (L${lf}) → ${to} (L${lt})  ❌ 下层依赖了上层`);
    }
  }
}

// ── 额外规则：domain 层不许有 fs / fetch / http ────────────────
const domainImpure = [];
for (const f of files) {
  const id = norm(rel(f));
  if (layerOf(id) !== 1) continue;
  const text = fs.readFileSync(f, 'utf8');
  for (const bad of ["require('fs')", 'require("fs")', "require('http')", 'require("http")', "require('https')", 'require("https")', 'fetch(']) {
    if (text.includes(bad)) domainImpure.push(`${id} 含 ${bad}`);
  }
}

// ── 循环依赖（Kahn）──────────────────────────────────────────
const layer = {};
const remaining = new Set(Object.keys(deps));
const cycles = [];
let depth = 0;
while (remaining.size) {
  const bottom = [...remaining].filter(n => !(deps[n] || []).some(d => remaining.has(d)));
  if (!bottom.length) { cycles.push(...remaining); break; }
  bottom.forEach(n => { layer[n] = depth; remaining.delete(n); });
  depth++;
}

const fail = violations.length > 0 || domainImpure.length > 0 || cycles.length > 0;

if (!CHECK_ONLY) {
  console.log('=== 依赖图（-> 表示依赖）===');
  Object.keys(deps).sort().forEach(n => {
    const L = layer[n] !== undefined ? layer[n] : '?';
    console.log(`  ${n.padEnd(22)} (L${L}) -> ${deps[n].length ? deps[n].join(', ') : '（无内部依赖）'}`);
  });
  const byLayer = {};
  Object.entries(layer).forEach(([n, d]) => { (byLayer[d] = byLayer[d] || []).push(n); });
  console.log('\n=== 按层分组（层号越小越底层）===');
  Object.keys(byLayer).sort((a, b) => a - b).forEach(d => {
    console.log(`  L${d}: ${byLayer[d].sort().join(', ')}`);
  });
  console.log('');
}

if (fail || !CHECK_ONLY) {
  console.log('=== 分层规则检查 ===');
  console.log(violations.length ? '  ❌ 反向依赖：\n    ' + violations.join('\n    ') : '  ✅ 无反向依赖（下层未依赖上层）');
  console.log(domainImpure.length ? '  ❌ domain 层不纯：\n    ' + domainImpure.join('\n    ') : '  ✅ domain 层无 fs / http / fetch');
  console.log(cycles.length ? '  ❌ 循环依赖: ' + cycles.join(', ') : '  ✅ 无循环依赖');
  console.log('');
  console.log(fail ? '结论：❌ 未通过（退出码 1）' : '结论：✅ 全部通过');
}

process.exit(fail ? 1 : 0);
