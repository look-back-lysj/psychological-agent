# 性能优化报告：`src/safety.js` 风险判定热路径

> 范围：`src/safety.js`（前置 `checkInputSafety` + 后置 `checkOutputSafety`）
> 性质：**纯性能优化，零行为变更**。导出接口、调用流程、判定结果全字段不变。
> 基线快照：`_tmp/safety-perf-base.js`（优化前的 879 行版本）

---

## 一、问题定位

### 1.1 范围与调用位置

`checkInputSafety` 在 `src/chat/pipeline.js:101` **每轮对话调用一次**（`riskLevel==='L3'` 时直接返回固定危机话术，不进模型）。
`checkOutputSafety` 在 `src/pipeline/agents` 侧对每条模型回复调用一次。

### 1.2 基准数据（优化前，Node 22.22.2 managed）

`_tmp/bench-safety.js`，语料 = tests 42 条 + 探针 52 条 + 红队/AB 全部 turns + 产品样例，共 163 条真实输入。

| 场景 | 字符数(中位) | 每次耗时 | 每秒次数 |
|---|---|---|---|
| 真实用例（短句为主） | 20 | **127.9 µs** | 7,816 |
| 长段落 | 1461 | **4,735.7 µs** | 211 |
| 超长 | 5788 | **18,147.2 µs** | 55 |
| `checkOutputSafety` | 24 | 1.1 µs | 888,484 |

**后置检查不是瓶颈（1.1 µs），全部热点在前置 `checkInputSafety`。**

### 1.3 CPU 采样（`--cpu-prof`，权威归因）

| 函数 | 自身耗时 | 占比 |
|---|---|---|
| `normalizeText` @utils.js | 14326.8 ms | **35.3%** |
| （模块级匿名，含各 replace/test 回调） | 10828.0 ms | 26.7% |
| `RegExp: [，。！？…]` | 3464.5 ms | 8.5% |
| `RegExp: [\s\u3000\u200b-\u200f\ufeff]+` | 2597.0 ms | 6.4% |
| `collectRiskEvidence` | 2108.9 ms | 5.2% |
| `splitRiskClauses` | 1565.3 ms | 3.9% |
| `clauseSubject` | 906.0 ms | 2.2% |
| `containsAny` | 580.6 ms | 1.4% |
| `repairRiskFragments` | 292.8 ms | 0.7% |
| `affirmativeMatch` | 126.5 ms | 0.3% |

**`normalizeText` + 它内部两条正则 = 50.2%。**

### 1.4 根因：不是算法慢，是**重复计算**

`_tmp/count-calls.js` 统计单次 `checkInputSafety` 的调用次数：

| 输入 | `normalizeText` 调用 | 不同参数个数 | 重复率 | 运行时 `new RegExp` |
|---|---|---|---|---|
| 短句（11 字） | 345 | 171 | 50.4% | 95 |
| 长段落（约 500 字） | **6469** | **174** | **97.3%** | **1070** |

三处低效：

| # | 问题 | 位置 | 复杂度 |
|---|---|---|---|
| **P1** | **词表归一化被重算**：`containsAny` 里 `words.some(w => normalized.includes(normalizeText(w)))`，而 13 个调用点传的全是模块级常量词表 → 每个分句都把整个词表重新归一化一遍 | `containsAny` | O(分句数 × 词表长度) |
| **P2** | **整句被重复归一化**：`splitRiskClauses.flush` 对同一个 buffer 归一化 **3 次**（判空/存 text/存 previous）；`checkInputSafety`、`collectRiskEvidence`、`eventsAreDiscussion` 各再算一次 `normalizeText(raw)` | `flush` / 三处 raw | 3~4 × O(len) |
| **P3** | **正则反复构造**：<br>① `repairRiskFragments` 对**每个词**现拼 `new RegExp(词拆字+gap+后缀,'g')`，~60 次/调用，且每个都对全文扫一遍<br>② `clauseSubject` 每次调用现拼 `new RegExp('(?:'+THIRD_SUBJECT.source+')…')`<br>③ `affirmativeMatch` 每次调用把静态 pattern 重编译成 `g` 版本<br>④ 18 处函数内正则**字面量**（`splitRiskClauses` 的 3 条切分 + 2 条单字符判据、`discussionSource` 的 3 条、`collectRiskEvidence` 的 10 条、`evaluateRiskGroup` 的 3 条）——JS 里正则字面量每次求值都新建 RegExp | 多处 | O(词表数 × len) 扫描 + 60 次编译 |

**复杂度小结**：判定本身是 O(len)，但预处理（分词修复 + 切分）实际是 **O(词表数 × len)**，且常数因子来自 60 次正则编译/扫描与数千次归一化。

### 1.5 生产影响（如实说明，不夸大）

单轮对话里 LLM 调用按 2 s 计，`checkInputSafety` 优化前 128 µs ≈ **0.006%**。所以：

- **对线上单轮延迟几乎无影响**，本次优化的直接价值在于 **离线评测/红队吞吐**（一遍评测数千次调用）以及 **超长输入下的尾部延迟**（18 ms → 4.4 ms）。
- 真正的价值是**消除算法层面的浪费**，而不是救线上 P95。
- 已识别但**未做**的更大瓶颈：LLM 调用本身、每轮会话的 session 落盘 I/O。范围外，见第六节。

---

## 二、优化改动

| # | 改动 | 文件位置 | 预期收益 | 副作用 / 风险 |
|---|---|---|---|---|
| **1** | **词表整体预归一化**：新增 `normWords(words)`，用 `WeakMap` 以「词表数组本身」为键缓存归一化结果；`containsAny` 改为朴素循环遍历已归一化数组 | `containsAny` 附近 | 消除 P1：每词一次哈希查找 → 每次调用一次 WeakMap 查找；归一化从 O(分句×词表) 降到 O(词表) 一次 | 依赖「调用点只传常量词表」这一前提（已核对全部 13 处）。若将来传动态词表需改回逐词缓存 |
| **2** | **动态文本归一化缓存**：新增 `normText(text)`（有界 Map，上限 1024，超限整体清空） | 同上 | 消除 P2 的 3~4 倍重复 | 缓存持有长字符串；上限 1024 条即自动清空，实测 2 万次长输入后堆增长仅 +53 KB |
| **3** | **`flush()` 归一化 3 次 → 1 次** | `splitRiskClauses` | 分句数越多收益越大 | 无。`previous` 仍存归一化串，`discussionSource(previous)` 依赖不变 |
| **4** | **整句归一化去重**：`eventsAreDiscussion` / `collectRiskEvidence` / `checkInputSafety` 三处 `normalizeText(raw)` 改走 `normText` | 3 处 | O(len) × 3 → × 1 | 无 |
| **5** | **`repairRiskFragments` 预编译 + 首字剪枝**：`RISK_FRAGMENT_FIXERS` 在模块加载时构造一次；循环内先 `text.indexOf(fixer.first) < 0` 则跳过 | `repairRiskFragments` | 消除 60 次/调用的正则编译；首字剪枝把大部分词表项的**整趟正则扫描**换成原生 `indexOf` 扫描 | 首字剪枝**可证明等价**：该词正则完全由词字符构成，原文缺首字则必然不匹配。`String.replace` 对 `/g` 会重置 `lastIndex`，复用实例安全 |
| **6** | **`clauseSubject` 动态正则 → 模块级 `THIRD_SUBJECT_TAIL`**，另 2 个判据提常量 | `clauseSubject` | 消除每分句 1 次字符串拼接 + 编译 | 无（无 g 标志，`exec` 无状态残留） |
| **7** | **`affirmativeMatch` 编译缓存**：`_globalReCache`（WeakMap）缓存 `g` 版本，用前显式 `re.lastIndex = 0` | `affirmativeMatch` | 长文本运行时 RegExp 构造 984 → **0** | `lastIndex` 归零是唯一契约，已在代码注释标注；带 `g` 标志不可改成 sticky |
| **8** | **18 处函数内正则字面量提升为模块级常量** + 2 条 `strip` 用到的 `/g` 字面量 | `discussionSource` / `splitRiskClauses` / `collectRiskEvidence` / `evaluateRiskGroup` | 消除每分句重建 RegExp | 全部无 `g/y` 标志（`.test()` 无状态）或仅用于 `.replace()`（自动重置 `lastIndex`） |
| **9** | `RISK_TERMS` 派生量、`THIRD_SUBJECT_TAIL` 等共 **30 个模块级预编译常量** | 全文件 | — | 模块加载时一次性成本，可忽略（实测加载 < 1 ms） |

**未改动**：`src/core/utils.js`（`normalizeText` 口径是跨 8 个模块的共享契约，**只加缓存不改口径**这件事留在 safety.js 内部做，避免影响记忆去重等下游）、`checkOutputSafety`（1.1 µs，无优化必要，最小化 diff）。

---

## 三、代码

核心三处（完整实现见 `src/safety.js`）：

```js
// ① 词表整体预归一化 + 动态文本缓存（P1 / P2）
const NORM_CACHE_MAX = 1024;
const _normWordsCache = new WeakMap();
function normWords(words) {
  let arr = _normWordsCache.get(words);
  if (arr === undefined) {
    arr = words.map(w => normalizeText(w));
    _normWordsCache.set(words, arr);
  }
  return arr;
}
const _textNormCache = new Map();
function normText(text) {
  const k = text == null ? '' : String(text);
  let v = _textNormCache.get(k);
  if (v === undefined) {
    v = normalizeText(k);
    if (_textNormCache.size >= NORM_CACHE_MAX) _textNormCache.clear();
    _textNormCache.set(k, v);
  }
  return v;
}

function containsAny(normalized, words) {
  const list = normWords(words);
  for (let i = 0; i < list.length; i++) {
    if (normalized.includes(list[i])) return true;
  }
  return false;
}
```

```js
// ② 分词修复：预编译 + 首字剪枝（P3-①）
const FRAGMENT_GAP = String.raw`[\s\u200b-\u200f\ufeff，,。.!！?？;；、:_-]{0,3}`;
const RISK_FRAGMENT_FIXERS = RISK_TERMS.map(word => ({
  word, first: word[0],
  re: new RegExp(
    Array.from(word).join(FRAGMENT_GAP) +
    (word.endsWith('杀') ? '(?!菌|虫|价|青)' : word.endsWith('死') ? '(?!皮|海)' : ''),
    'g'
  )
}));

function repairRiskFragments(raw) {
  let text = String(raw);
  for (const fixer of RISK_FRAGMENT_FIXERS) {
    // 首字剪枝：该词的正则完全由词字符构成，原文里连首字都没有时**必然**不匹配。
    if (text.indexOf(fixer.first) < 0) continue;
    text = text.replace(fixer.re, () => fixer.word);
  }
  return text;
}
```

```js
// ③ 编译缓存 + lastIndex 归零（P3-③）
const _globalReCache = new WeakMap();
function toGlobalRe(pattern) {
  let re = _globalReCache.get(pattern);
  if (re === undefined) {
    re = new RegExp(pattern.source, 'g');
    _globalReCache.set(pattern, re);
  }
  re.lastIndex = 0;   // ⚠️ 唯一契约：旧实现每次 new，lastIndex 恒为 0
  return re;
}
```

---

## 四、复杂度对比

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| 短句（20 字）单次耗时 | 127.9 µs | **32.9 µs** | **3.89×** |
| 长段落（1461 字）单次耗时 | 4735.7 µs | **1105.6 µs** | **4.28×** |
| 超长（5788 字）单次耗时 | 18147.2 µs | **4415.3 µs** | **4.11×** |
| 长文本运行时 `new RegExp` | 1070 | **0** | 消除 |
| 单次 `normalizeText` 调用（500 字输入） | 6469 | **127** | −98.0% |
| `normalizeText` 占 CPU | 35.3% | 已跌出热点前 8 | — |
| 采样总时长（同工作量） | 40615 ms | 12010 ms | 3.38× |
| **2 万次不同长输入总耗时** | 25801 ms | **6679 ms** | **3.86×** |
| 堆增长（同上，GC 后） | 771 KB | 824 KB | **+53 KB（有界）** |
| 文件规模 | 879 行 / 57.9 KB | 1007 行 / 64.2 KB | +128 行（其中约 90 行是注释） |
| 导出接口 | 7 项 | 7 项 | **不变** |

渐进复杂度：判定主干仍是 **O(len)**；预处理的"词表数 × len"因子被**首字剪枝 + 预编译**削弱为常数因子（不再有编译成本，多数词项退化为原生 `indexOf` 快扫）。

---

## 五、验证方式（可复现）

### 5.1 等价性护栏（最重要）

`_tmp/equiv-check.js` —— 并排加载「基线模块」与「当前模块」，对 `checkInputSafety` / `checkOutputSafety` 的**完整返回对象**（`riskLevel / action / reason / meta`）做 `JSON.stringify` 逐字段比对，外加 `riskHistory` 5 种组合与边界输入。

```bash
cd "E:/ds_work/ai pyschological agent/psychological-agent"
node _tmp/equiv-check.js _tmp/safety-perf-base.js src/safety.js
```

样本构成：真实用例 + 探针 + 红队/AB 全部 turns + 产品样例 + 对抗输入（零宽字符、空标点、引号、纯空白、重复风险词、非字符串入参 `null/undefined/0/123/{}/[]`、2000 字符超长）× 5 种 `riskHistory` + 输出侧 12 条。

**实测结果：1213 条对比，`riskLevel / action / reason / meta` 全字段零差异。** 不一致则退出码 1。

### 5.2 判定质量未退化

```bash
node tests/run.js                              # 42/42 + 9/9，退出码 0
node eval/risk-probe/run-probe.js              # 52/52，FP 0，FN 0
node _tmp/regress-check.js                     # 82 条跨语料：等级上升 0 / 下降 0
node -e "…RT-19 三轮带真实 riskHistory…"        # L0→L0→L1→L3，末轮 L3（红队要求）
```

### 5.3 性能复现

```bash
node _tmp/bench-safety.js                                  # 逐项耗时表
node _tmp/count-calls.js                                   # 重复计算与 new RegExp 计数
node --cpu-prof --cpu-prof-dir=_tmp/prof _tmp/bench-safety.js   # 采样归因
node --expose-gc -e "…2 万次不同长输入，测耗时与堆增长…"      # 吞吐 + 内存
```

> 基准脚本默认 `BENCH_ITERS=4000`，每档含 200 次预热；同一台机器、同一语料、同一 Node 版本下与本报告数字可直接对比。

---

## 六、明确未做 / 风险与取舍

| 项 | 状态 | 理由与取舍 |
|---|---|---|
| 把 60 条词表正则**合并成一条大正则**（彻底去掉 O(词表数 × len)） | ❌ **不做** | 会改变匹配语义：合并后无法保证「长词优先」「`死` 的负向后瞻」「`割腕` 与 `割` 的优先级」与逐条替换完全一致。冻结契约的判定结果必须逐字段不变，**收益（再快 ~1.5×）远小于语义漂移风险**。若将来要动，必须先补一套「原始文本 → 期望判定」的快照回归，而不是靠现有 52 条探针兜底。 |
| 改 `src/core/utils.js` 的 `normalizeText` 本身 | ❌ **不做** | 它是跨 8 个模块的共享契约，注释明确写「改口径会同时影响安全判定与记忆去重」。本次只加缓存、口径与实现零改动。 |
| 优化 `checkOutputSafety` | ❌ **不做** | 实测 1.1 µs，占比可忽略；优化会扩大 diff 与风险面。 |
| **真正的线上瓶颈：LLM 调用（~2 s）与每轮 session 落盘 I/O** | ⚠️ **超出本次范围** | `checkInputSafety` 只占单轮 0.006%，继续压它对线上 P95 无意义。真正的收益要靠：LLM 调用复用/流式、session 写入合并或异步化。**建议下一轮从 `src/infra/sessions.js` 与 `src/pipeline/agents.js` 入手**，且这两处涉及持久化与超时重试，风险等级与本次完全不同，需要独立基准。 |
| 缓存容量 `NORM_CACHE_MAX = 1024` | ⚠️ 保守取值 | 实测 2 万次不同长输入堆增长仅 +53 KB（超限即整体清空，不做 LRU）。若后续实测单条消息显著变长，可下调；**不建议上调**，因为词表类缓存已恒定占用，动态文本缓存的收益递减而内存线性增长。 |
| `toGlobalRe` 的 `lastIndex` 归零 | ⚠️ 关键不变量 | 若将来有人给缓存实例加 `sticky`/`unicode` 或去掉归零，**会静默产生漏判**。已在代码注释用 ⚠️ 标注。`equiv-check.js` 能第一时间发现。 |
| 未提交 | — | `src/safety.js` 仍是未提交工作区改动（HEAD `e598d56` 只有 353 行）。**提交前请先手工快照**，否则又会重演「无法构造可信基线」的问题。 |
