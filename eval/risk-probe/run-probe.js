/**
 * 守岸人 · 风险判定探针评测（L1 自动）
 *
 * 与 tests/run.js 的分工：
 *  - tests/run.js：守**冻结契约**（导出名 / 返回结构 / 42+9 条业务用例），回归用；
 *  - 本脚本：守**判定质量**（准确率 / 误判率 / 漏判率），量化改动收益用。
 *    tests/run.js 全绿并不代表判定正确——它只有 5 条 L3 用例，
 *    对本用例集里的边界情形（夸张、否定、委婉、筹备手段）零覆盖。
 *
 * 用法：
 *   node eval/risk-probe/run-probe.js                 # 打当前实现
 *   node eval/risk-probe/run-probe.js --old <path>    # 打基线实现（输出对比表）
 *
 * 例：
 *   git show HEAD:src/safety.js > _tmp/safety-baseline.js
 *   node eval/risk-probe/run-probe.js --old _tmp/safety-baseline.js
 *
 * ⚠️ 标签说明（诚实标注，不要当成临床金标准）：
 * cases.jsonl 的 expected_risk 是**本脚本作者依据通用自杀风险评估常识给出的专家标签**，
 * 不是临床诊断结论，也没有经过真人被试标注或临床医师复核。样本量 48 条，
 * 结论只能用于「相对比较（改前 vs 改后）」，不能外推到真实用户的准确率。
 * 若要外推，需要 L2/L3 层人工标注集（见 eval/human/、eval/redteam/）。
 */

const fs = require('fs');
const path = require('path');

const RANK = { L0: 0, L1: 1, L2: 2, L3: 3 };
const ARGV = process.argv.slice(2);

function arg(name, def) {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : def;
}

const CASE_FILE = path.join(__dirname, 'cases.jsonl');
const OLD_PATH = arg('--old', null);

function loadModule(p) {
  if (!p) return require(path.join(__dirname, '../../src/safety.js'));
  const abs = path.resolve(process.cwd(), p);
  const code = fs.readFileSync(abs, 'utf8');
  const tmp = path.join(__dirname, '../../_tmp', 'probe-old-safety.js');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  // 基线文件里的 require('./core/utils') 是相对 src/ 的，搬到 _tmp 后要改指
  const patched = code.replace(/require\('\.\/core\/utils'\)/, "require('../src/core/utils')");
  fs.writeFileSync(tmp, patched);
  return require(tmp);
}

function loadCases() {
  return fs.readFileSync(CASE_FILE, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    const o = JSON.parse(l);
    if (!o.expected_risk) throw new Error('用例 ' + (o.id || i) + ' 缺少 expected_risk');
    return o;
  });
}

function run(mod, cases) {
  return cases.map(c => {
    let level = null;
    let err = '';
    try {
      level = mod.checkInputSafety(c.input, { riskHistory: [] }).riskLevel;
    } catch (e) {
      err = e && e.message ? e.message : String(e);
    }
    const exp = c.expected_risk;
    const [lo, hi] = String(exp).split('/').map(x => x.trim());
    const loR = RANK[lo], hiR = RANK[hi || lo];
    const cur = RANK[level];
    let verdict = 'OK';
    if (level == null) verdict = 'ERROR';
    else if (cur > hiR) verdict = 'FP';   // 判得比期望更高 = 误判（过度报警）
    else if (cur < loR) verdict = 'FN';   // 判得比期望更低 = 漏判（漏报）
    return { ...c, actual: level, verdict, err };
  });
}

function stats(rows) {
  const n = rows.length;
  const ok = rows.filter(r => r.verdict === 'OK').length;
  const fp = rows.filter(r => r.verdict === 'FP').length;
  const fn = rows.filter(r => r.verdict === 'FN').length;
  const err = rows.filter(r => r.verdict === 'ERROR').length;
  const expectedPos = rows.filter(r => RANK[r.expected_risk.split('/')[0]] > 0).length;
  return {
    n, ok, fp, fn, err,
    accuracy: n ? ok / n : 0,
    fpRate: n ? fp / n : 0,
    fnRate: n ? fn / n : 0,
    // 召回：只看真阳样本（期望 ≥L1）中漏掉的比例；用「低于期望下界」计漏判
    recall: expectedPos ? (expectedPos - rows.filter(r => r.verdict === 'FN' && +RANK[r.expected_risk.split('/')[0]] > 0).length) / expectedPos : 0,
    expectedPos
  };
}

function pct(v) { return (v * 100).toFixed(1) + '%'; }

function report(title, mod, cases, compareTo) {
  const rows = run(mod, cases);
  const s = stats(rows);
  console.log('='.repeat(78));
  console.log(' 守岸人 · 风险判定探针  ' + title);
  console.log(' 用例：eval/risk-probe/cases.jsonl（' + s.n + ' 条，作者专家标签，非临床金标准）');
  console.log('='.repeat(78));
  if (compareTo) {
    console.log('\n【失败清单】');
    const bad = rows.filter(r => r.verdict !== 'OK');
    if (!bad.length) console.log('  无。');
    for (const r of bad) {
      console.log(`  ${r.verdict.padEnd(5)} ${r.id} [${r.category}] 期望 ${r.expected_risk} 实际 ${r.actual ?? 'ERROR'} ${r.err}`);
      console.log(`       输入：${r.input}`);
      console.log(`       理由：${r.rationale}`);
    }
  }
  console.log('\n【关键指标】');
  console.log(`  准确率             ${s.ok}/${s.n} = ${pct(s.accuracy)}`);
  console.log(`  误判率(FP, 判高了) ${s.fp}/${s.n} = ${pct(s.fpRate)}   期望 L0 组中被判 ≥L1 的条数`);
  console.log(`  漏判率(FN, 判低了) ${s.fn}/${s.n} = ${pct(s.fnRate)}   期望 ≥L1 组中被判低于下界的条数`);
  console.log(`  异常崩溃           ${s.err}`);
  const byCat = {};
  for (const r of rows) {
    byCat[r.category] = byCat[r.category] || { OK: 0, FP: 0, FN: 0, total: 0 };
    byCat[r.category][r.verdict] += 1;
    byCat[r.category].total += 1;
  }
  console.log('\n【分类别】');
  for (const k of Object.keys(byCat)) {
    const c = byCat[k];
    console.log(`  ${k.padEnd(12)} ${c.total} 条  正确 ${c.OK}  误判 ${c.FP}  漏判 ${c.FN}`);
  }
  return { rows, s };
}

const cases = loadCases();
if (OLD_PATH) {
  const old = loadModule(OLD_PATH);
  const now = require(path.join(__dirname, '../../src/safety.js'));
  const a = report('（改前 · 基线 ' + OLD_PATH + '）', old, cases, false);
  const b = report('（改后 · 当前 src/safety.js）', now, cases, true);
  console.log('\n' + '='.repeat(78));
  console.log(' 优化前后对比（同一份标签，同一台机器）');
  console.log('='.repeat(78));
  const row = (name, f) => {
    const va = String(f(a.s)), vb = String(f(b.s));
    const d = Number(vb) - Number(va);
    const sign = d > 0 ? '+' : '';
    const delta = Number.isFinite(d) ? `  ${sign}${Math.abs(d)}` : '';
    return `  ${name.padEnd(22)} ${va.padEnd(18)} → ${vb.padEnd(18)}${delta}`;
  };
  console.log(row('准确率', s => (s.accuracy * 100).toFixed(1) + '% (' + s.ok + '/' + s.n + ')'));
  console.log(row('误判率 FP', s => (s.fpRate * 100).toFixed(1) + '% (' + s.fp + '条)'));
  console.log(row('漏判率 FN', s => (s.fnRate * 100).toFixed(1) + '% (' + s.fn + '条)'));
  console.log(row('崩溃', s => s.err));
  const deltaOk = b.s.ok - a.s.ok;
  const deltaFp = b.s.fp - a.s.fp;   // >0 表示误判变多
  const deltaFn = b.s.fn - a.s.fn;   // >0 表示漏判变多
  console.log('\n  净变化：正确 ' + (deltaOk >= 0 ? '+' : '') + deltaOk +
    ' 条 | 误判 ' + (deltaFp > 0 ? '+' : '') + deltaFp + ' 条 | 漏判 ' + (deltaFn > 0 ? '+' : '') + deltaFn + ' 条');

  // 坏交换检查：两个方向同时变差 = 纯退步
  if (deltaFp > 0 && deltaFn > 0) {
    console.log('  ⚠️ 警告：误判与漏判同时变多，属纯退步，需回查。');
  } else if (deltaFp === 0 && deltaFn === 0 && deltaOk === 0) {
    console.log('  ⚠️ 注意：本用例集上无变化，换更难的用例集再验。');
  } else if (deltaFp > 0 && deltaFn < 0) {
    console.log('  ⚠️ 注意：误判变多但漏判减少 —— 可能是在拿召回换精度，需人工确认每条 FP。');
  } else {
    console.log('  ✓ 未出现「两个方向同时退化」的坏交换。');
  }
  process.exitCode = 0;
} else {
  report('（当前实现）', require(path.join(__dirname, '../../src/safety.js')), cases, true);
  console.log('\n  提示：加 --old <baseline.js> 可输出改前 / 改后对比表。');
  console.log('  例：git show HEAD:src/safety.js > _tmp/safety-baseline.js');
  console.log('      node eval/risk-probe/run-probe.js --old _tmp/safety-baseline.js');
}
