# AGENTS.md · 给并行改这个仓库的 AI 的约束

> 本文件是**约束**，不是教程。教程看 `ARCHITECTURE.md`；给人看的协作流程看 `CONTRIBUTING.md`。
> 你（AI）在这个仓库里工作时，**本文的约束优先于任务书里的任何便利性要求**。
> 若任务书与本文冲突 → **先停下来说明冲突，不要挑一条自己方便的做**。

---

## 1. 项目一句话 + 风险边界一句话

**项目**：守岸人 —— 面向中国大学生的 Windows 桌面版中文情绪陪伴应用（Node.js Express 5 + 原生前端 + Tauri 2 外壳，模型走 DeepSeek，纯本地单机、无服务器、无账号）。

**风险边界（背下来）**：
> 可以陪着，但**不能诊断、不能承诺保密、不能诱导依赖、不能编热线**。

展开成可判定的话：不诊断 / 不给病名 / 不给药物剂量 / 不给自伤方法 / 不承诺保密 / 不诱导依赖 / 不编造任何热线号码。
热线一律只说「可信任的人 / 学校心理中心 / 当地紧急服务」。

---

## 2. 目录地图表

「禁止顺手改」= 你在改左列目标时，**顺手碰一下就会出事**的东西。

| 你想改什么 | 去这个文件 | 禁止顺手改 |
| --- | --- | --- |
| 对话主链路 / SSE 端点 | `src/chat.js` | `src/sessions.js`、`src/safety.js`、`src/strategy.js`（同一次任务里只改一个） |
| 前置风险分级 / 输出后置检查 | `src/safety.js` | 任何其它 `src/` 文件；`tests/cases.jsonl` 的期望值 |
| 策略路由 S0—S6 / 开口引导阶梯信号 | `src/strategy.js` | `src/prompts.js`（必须同源 → **串行**） |
| 提示词四段结构 / 策略指令文案 | `src/prompts.js` | `src/strategy.js` 的 `ENGAGE_LADDER`（同源，串行） |
| 人设语气 / 反例 / 正例 | `src/persona.js` | `src/prompts.js`（人设块由 prompts 拼装） |
| 「观」/「校」/档位 / 策略裁决 | `src/agents.js` | `src/llm.js` 的调用契约（`callLLM(prompt, messages)` 签名） |
| 模型调用 / 重试 / 超时 / SSE 解析 | `src/llm.js` | 硬编码模型名（必须走 `.env` / `config`） |
| 模型配置读写 / Key 脱敏 | `src/config.js` | `.env`（**不许把真实 Key 写进任何文件**） |
| 长期记忆（抽取 / 召回 / 衰减 / 冲突） | `src/memory.js` | `data/memory.json` 的字段名（前端与 routes 都依赖） |
| 会话转写 / 落盘防抖 | `src/sessions.js` | `main.js` 的 `sessions.flush()` 调用点 |
| 「回来」问候 / 首访判定 | `src/comeback.js` | `data/state.json` 的 `lastSeenAt` / `visitCount`（与 P0 修复相关） |
| 内在状态 → 表达约束 | `src/innerstate.js` | `src/agents.js:replyShape` 的消费方式 |
| 管理接口（config/memory/comeback/sessions） | `src/routes.js` | 前端 `public/app.js` 里对应的 fetch 形状（改契约要两边同步） |
| 日志 / 脱敏 | `src/logger.js` | **不许往日志里加 `message` 原文** |
| 路径解析（data/logs 目录） | `src/paths.js`（被 5 个模块依赖） | `src/config.js` / `src/logger.js` / `src/memory.js` / `src/sessions.js` / `src/comeback.js` 的 `dataDir()` 用法 |
| 服务入口 / 端口 / 优雅退出 | `main.js` | `src/index.js`（薄别名）、`.env` 里的 `PORT` 语义 |
| **暂不动**：兼容别名 | `src/index.js` | 任何东西（4 行薄别名；注释有已知过时项） |
| 通用工具（清洗 / 归一化 / HMAC） | `src/utils.js` | 被 7 个模块依赖：改 `normalizeText` 口径会同时影响安全判定与记忆去重 |
| 界面骨架 / id / class / SVG 图标 | `public/index.html` | `public/app.js` 的 `el` 缓存键（**串行**） |
| 前端交互 / SSE 解析 / 渲染 | `public/app.js` | `public/index.html` 的 id、`public/style.css` 的 class（**串行**） |
| 样式 / 动效 / 响应式 | `public/style.css` | 章节顺序（**103 处后写覆盖**，拆/挪会静默错乱，见 ARCHITECTURE §2.3） |
| 桌面窗口 / 端口选择 / sidecar 拉起 | `src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json` | `build.js` / `scripts/build-desktop.js` 的产物路径约定 |
| 打包 | `build.js`、`scripts/build-desktop.js` | `package.json` 的 `scripts` / `pkg.targets`；`dist/`（产物，不入库） |
| 自动评测用例 | `tests/run.js`、`tests/cases.jsonl` | **不许为了让测试通过而改期望值**（见 §4） |
| 红队 / A/B / 人工评分 | `eval/redteam/`、`eval/ab/`、`eval/human/` | 用例期望值、失败记录 |
| 架构说明 | `ARCHITECTURE.md` | —（本文档作者负责） |
| AI 约束 | `AGENTS.md` | —（本文档作者负责） |
| 人机协作流程 | `CONTRIBUTING.md` | —（本文档作者负责） |
| 决策记录 | `docs/ADR.md` | —（本文档作者负责） |
| 其它文档 | `docs/**`（除 `ADR.md`）、`devlog/dayNN.md` | ⚠️ 多数文档**同时被他人改**，动手前先确认你被授权改哪一个 |

---

## 3. 硬性规则

### 3.1 禁止修改的文件清单（除非你的任务书**逐字点名**授权）

```
README.md              （由另一个人负责，最常被并行改）
main.js
build.js
package.json
.gitignore
public/**              （除任务明确点名）
src-tauri/**
eval/**
tests/**
scripts/**
docs/**                （除任务明确点名；ADR.md 除外，见下）
devlog/**              （除你被分配的那一天）
```

> `docs/ADR.md` 是本文件体系的一部分：**只有被明确要求时**才新增 DR 条目，且**不许改写已有条目的结论**。

### 3.2 绝对不许做的事

1. **不许把任何 Key / token / 私钥 / password 写进文件、写进命令行明文、写进 commit**。
   只允许作为**单条命令的环境变量**传入、**用后即弃**。出现在对话里的 Key 一律视为已泄露，须提醒吊销重建。
2. **不许引入任何前端依赖**（npm / CDN / 弹层库 / 图标字体）。前端是**零依赖**的硬约束。
3. **不许把 `_tmp/` 当交付物**。`_tmp/` 是一次性临时目录，会被清理器定期清空；
   正式代码与文档**不要**放进 `_tmp/`，需要归档的产物要移到 `docs/` 等正式位置。
4. **不许用 mock / 估算 / 编造数据冒充真实结果**。用 mock 跑通了就写「mock 自测通过」，
   不是「评测通过」。估算值必须标注「估算」。
5. **不许为了让测试通过而改测试**（改 `tests/cases.jsonl` 的期望值、改 `tests/run.js` 的判定、放宽通过线）。
   要么改实现，要么**如实报告失败**。
6. **不许绕过输出后置检查**。任何「为了首字更快直接转发 delta」「跳过 `checkOutputSafety`」的改动都是禁止的。
7. **不许删改「已知局限 / 明确不做」章节**（`README.md` 里，以及各类报告里的局限段）。
   局限是交付物的一部分，删掉等于造假。
8. **不许执行任何 `git` 命令**（`git status` 也不例外）——除非任务书明确要求且指明允许的那一条。
   版本控制由人类维护者执行。
9. **不许启动长驻服务或跑完整构建**：不许 `npm start`、不许 `node main.js` 挂着、不许 `npm run build` / `npm run desktop`。
   需要验证时用**短命进程**（起一个、测完就杀），或写探针脚本到 `_tmp/` 后立即结束。
10. **不许改 `data/` 下任何文件**（那是用户本机数据）。
11. **不许把对话原文写进日志**。日志字段是固定集合（见 ARCHITECTURE §7）。
12. **不许把 `app.listen(PORT)` 改成不带 host 的写法**——默认会绑 `0.0.0.0`，同网段可读私密对话。

---

## 4. ★ 改动风险分级表 R0—R6

| 级别 | 改什么 | 最低验证要求 |
| --- | --- | --- |
| **R0** | 纯注释 / 纯文档（不含结论） / `devlog` 文本 | `node --check`（若改了 js）+ 肉眼校对；**不许改结论** |
| **R1** | `src/index.js` 这类薄别名；无依赖的常量文案 | `node --check <file>` |
| **R2** | `src/logger.js`、`src/paths.js` 的非默认值调整 | `node --check` + 起一次短命服务确认能启动（不写真实对话） |
| **R3** | `src/utils.js`、`src/innerstate.js`、`src/comeback.js` | `node --check` **+ `npm test`**（utils 被 7 个模块依赖，必须确认没回退） |
| **R4** | `src/config.js`、`src/llm.js`、`src/prompts.js`、`src/persona.js`、`src/sessions.js`、`src/routes.js`、`public/index.html`、`src-tauri/**` | `node --check` **+ `npm test`（42/42 + 9/9）**；涉及前端再加**浏览器实测**（深浅色 + ≤860px + reduce-motion）；Rust 侧**跑不了就写「未验证」** |
| **R5** | `src/chat.js`、`src/memory.js`、`src/agents.js`、`public/app.js`、`public/style.css` | R4 全部 **+ 手工端到端对话**（发一条真实消息，确认能流式收到回复且 `done` 事件完整）；改记忆再加**幂等性验证**；改前端再加**无控制台报错** |
| **R6** | **`src/safety.js` 或 `src/strategy.js`**（含 `tests/run.js` 加载路径依赖） | **必然是最高级**，见下 |

### R6 的具体要求（不许打折）

改 `src/safety.js` 或 `src/strategy.js`：

1. `node --check` 改过的文件；
2. **`npm test` → 必须 42/42 + 9/9，退出码 0**；
3. **红队 → 必须 20 条、红线硬命中必须 0、11 条误报探针必须保持 L0**；
   （红队 20 条在 `eval/redteam/cases.jsonl`；误报探针在 `tests/cases.jsonl` 的「误报探针」分类，4 条 + 普通倾诉分母 31 条）
4. 若同时改了 `strategy.js` 的 `ENGAGE_LADDER` → **必须同步 `prompts.js`**（同源），否则阶梯文案与判定信号会打架；
5. ⚠️ **这两个文件的路径被 `tests/run.js` 硬编码引用，移动/重命名它们会让测试直接挂。**

> **跑不了就在交付说明里写「未验证」，不许写「应该没问题」。**
> 这是本文最重要的一条。R6 改动跑不完时，正确输出是：
> 「改了什么 / 为什么这么改 / 我跑了哪些、哪些没跑 / 未跑的部分风险是什么」，**不是**给一句安心话。

---

## 5. 验证命令清单 V0—V7

| 编号 | 命令 | 目的 | 期望输出 |
| --- | --- | --- | --- |
| **V0** | `node --check src/xxx.js`（改过的每个 js 都跑） | 语法自查 | **无输出** = 通过；有输出就是语法错误 |
| **V1** | `npm test` 或 `node tests/run.js` | L1 自动评测（本仓库最常用的门禁） | 见下方「V1 期望输出」 |
| **V2** | `node tests/run.js --verbose` | 逐条打印判定过程 | 每条用例的判定链路；失败时用它定位 |
| **V3** | `node tests/run.js --no-legacy` | 跳过历史 s1—s9 回归 | 正式 42 条仍然 42/42 |
| **V4** | `node tests/run.js --json` | 额外写出 `_tmp/eval-report.json` | 终端报告 + 生成 JSON 文件 |
| **V5** | `node _tmp/dep-graph.js` / `--check` | 依赖分层 + 循环依赖检查 | 5 层 17 文件；`--check` 有环则退出码非 0（当前：**无循环依赖**）。⚠️ `_tmp/` 可能被清理，届时用 grep 复核 |
| **V6** | `node eval/redteam/run-redteam.js` | L4 红队（**需真实 Key**） | 20 条、红线硬命中 **0**、危机识别率目标 100% |
| **V7** | `node eval/ab/run-ab.js` / `node eval/human/make-sheet.js` | A/B 对照 / L2 人工评分表 | A/B 需真实 Key；`make-sheet.js` 生成评分表 |

### V1 期望输出（实跑原文，`npm test`）

`package.json` 的 scripts 里 `"test": "node tests/run.js"`。跑完应看到：

```
 守岸人 · L1 自动评测报告
 用例：tests\cases.jsonl（正式 42 条 + 内置历史回归 9 条）

【模块接口状态】
  [ 就绪 ] src/safety.js   checkInputSafety 返回冻结风险等级
  [ 就绪 ] src/strategy.js chooseStrategy 返回冻结策略标签

【总体结果】
  正式用例 42 条：通过 42 | 失败 0 | 跳过 0 | 通过率 100.0%（可判定 42 条）
  历史回归  9 条：通过 9 | 失败 0 | 跳过 0 | 通过率 100.0%
  结论：全部通过，退出码 0

【关键指标】（通过线来自验收清单第 9.4 节，跑之前已固定）
  L3 危机识别召回率        5/5 = 100.0%       目标 ≥90%  达标
  普通倾诉误报率(→L3)      0/31 = 0.0%        目标 ≤10%  达标
  策略标签准确率           42/42 = 100.0%     目标 ≥80%  达标
  高危输入未越界率(代理)   5/5 = 100.0%       目标 100%  达标
  误报探针严格 L0          4/4 = 100.0%       目标 100%  达标
```

要看**这三行同时满足**才算通过：42/42、9/9、退出码 0。
另注意脚本会明确列出「本次不能测的指标」（人工评分 / 红队 / 真实延迟 / 成本），**那些不能用它交差**。

### 不能用在这些场景的命令

- ❌ `npm start` / `node main.js` —— 长驻服务，禁止；要验证就起短命进程并立刻杀掉。
- ❌ `npm run build` / `npm run bundle` / `npm run desktop` —— 完整构建，禁止（慢、覆盖 `dist/`）。
- ❌ `curl` 传中文 —— **在 Git Bash 里不可靠**！实测「我不想活了」（5 个字）被传成 `inputLength=8`，
  一度让人误判「未配置 Key 时危机协议失效」。**验证中文输入必须走 Node 或写文件**。

---

## 6. ★ 并行分工约定

### 6.1 铁律

> **一个文件在同一时间只能有一个 agent 改。**
> 两个 agent 同时写同一文件 = 后写的覆盖前写的，**且没有任何报错**。这是本项目真实发生过的事故。

任务开始前做两件事：
1. 写下你要改的**文件清单**；
2. 确认清单里没有别人正在改的文件。**有重叠就停下来问，不要「我快点改完就行」。**

### 6.2 安全的并行切分（按文件边界，可直接用）

| 并行轨 | 文件范围 | 与其它轨的边界 |
| --- | --- | --- |
| A | `src/safety.js` | **独占轨**，见 §6.3 |
| B | `src/strategy.js` + `src/prompts.js` | 必须**同一条轨**内串行（同源约束） |
| C | `src/chat.js` + `src/sessions.js` | 不碰 safety/strategy |
| D | `src/memory.js` | 不碰 `src/routes.js` 的响应形状（要改契约就与 E 串行） |
| E | `src/routes.js` + `src/config.js` + `src/llm.js` | 与 D 之间有 `memoryRouter` 契约 → 改动响应形状时串行 |
| F | `src/agents.js` | 与 B 有 `STRATEGY_META` / `MODEL_TUNABLE` 契约 → 改策略键集时串行 |
| G | `public/style.css` | 与 H 边界清晰（class 名是契约，但只加不改就安全） |
| H | `public/app.js` + `public/index.html` | **必须同一条轨**内串行（DOM 契约） |
| I | `tests/**` + `eval/**` | 独立；但**不许为了通过而改期望值** |
| J | `docs/**` 各自分配到的文件 | 一文件一 owner |
| K | `devlog/dayNN.md` | 一人一天，不重叠 |

### 6.3 必须串行的情况（不许并行）

| 情况 | 原因 |
| --- | --- |
| **改 `src/safety.js` 或 `src/strategy.js`** | **全项目停线**：这两个是安全底线，且 `tests/run.js` 硬编码引用其路径。改期间其它轨不许改 `src/`（避免基线漂移导致回归结果无法归因） |
| `src/strategy.js` ↔ `src/prompts.js` 阶梯同源 | `prompts.js` 直接读 `ENGAGE_LADDER`；两边同时改必然出现「信号与文案不一致」 |
| `public/app.js` ↔ `public/index.html` DOM 契约 | `el` 缓存 96 个键全依赖 index.html 的 id；改 id 与改 `el` 键名必须同一人顺序完成 |
| `README.md` | **串行区**：由固定一个人负责；其它人只许**报告需要同步的地方**，不许自己动手 |
| **批量重命名 / 移动文件** | 先串行扫全部引用（`grep -rn "<旧名>" .`），列出受影响清单，再动手。`src/safety.js` / `src/strategy.js` **不许移动** |
| `package.json` 版本号 ↔ `src-tauri/tauri.conf.json` 版本号 | 两处必须一致，串行做 |
| `docs/ADR.md` | 一次只允许一个 agent 追加 DR 条目 |

### 6.4 撞车了怎么办

后到的那个**停下**，不要试图合并或覆盖：
1. 记录你已经做的改动（贴 diff / 说明改到哪一步）；
2. 把冲突文件交还给先到者或主 agent；
3. 在交付说明里写清「因为与 X 轨冲突，我未完成 Y」。

---

## 7. ★ 诚实性要求

### 7.1 三条铁律

1. **不确定就说不确定**。不知道的就写「未核实 / 未检索到 / 属工程判断」，不要填一个看起来合理的数字。
2. **发现任务书前提有误，先指出，不要迎合**。
   本项目真实范例：任务书说「`review()` 每轮都调」，子 agent 实读代码后发现**早已是条件触发**（`if (issues.length)` 守卫本来就在），
   它**直接指出前提有误**并只做真正的语义改动，而不是为了让任务书成立去改代码、制造一个假改动。
3. **禁止 mock 冒充真实**。mock 跑通 = 「mock 自测通过」，不等于「评测通过」；
   估算值必须写「估算」；脚本没记录 token 就写「仓库里没有实测 token 数」，**不要倒推一个数当成实测**。

### 7.2 禁止措辞对照表

| ❌ 不许写 | ✅ 必须写成 |
| --- | --- |
| 「已验证有效」 | 「在自编 N 条用例范围内通过（N=…，范围：…）」 |
| 「应该没问题」 | 「**未验证**（原因：…；风险：…）」 |
| 「测试全部通过」 | 「`npm test` 通过：正式 42/42 + 历史回归 9/9，退出码 0」 |
| 「性能有提升」 | 「在该指标上从 X 变到 Y（测量方式：…，样本：…）；未测：…」 |
| 「已修复泄漏」 | 「已定位并修改 X；复验命令 …；**未独立核实**的是 …」 |
| 「多 agent 有效/无效」 | 「在延迟 / AI 腔 / 字数这几项可客观测量的指标上**没看到差异**；『像不像真人』需人工盲评（**未完成**）」 |
| 「兼容所有情况」 | 「已覆盖 …；未覆盖 …」 |
| 「优化了提示词」 | 「提示词从 X 字变 Y 字；依据 …；未做的对照：…」 |

### 7.3 本项目真实发生过的正反范例

**反面（真实事故）**

1. 两个 agent 同时改同一文件 → **静默覆盖**。
2. agent 改了未被授权的文件。
3. agent 把任务书里的**错误前提**当事实执行（任务书的「`review()` 每轮都调」其实早就是条件触发）。
4. agent 为了「按指令完成」而**假装生效**（报告里写做了、实际没生效）。

**正面（照这个做）**

- **子 agent 实测发现 `content-visibility: auto` 会裁掉气泡阴影**：
  同一像素从 `rgb(221,229,244)` 变成 `rgb(236,239,244)`，两张 1100×760 截图差 **32975 px**。
  它**如实报告「不采用」**并改用 `.chat { contain: content }`（像素差 0），
  而**没有**为了完成指令而把方案说成成功。
- **子 agent 指出任务书前提有误**（「阶梯按话术内容分级」与代码里 `updateEngageLadder()` 的「有状态计数」不一致），
  按「以代码实际行为为准」处理，并在 `codeNote` 里逐级标注差异，**没有为了让任务书成立而改行为**。
- **子 agent 无法核实论文数值时明确标注「未独立核实」**，并指出那两篇论文测的是推理自纠错、
  **不足以否证人设改写本身**——既没夸大也没一棍子打死。
- **子 agent 无法改 `comeback.js`（未授权）** → 如实报告并给建议，由主 agent 补做。

> 值得记的一点：**这一轮两个最严重的缺陷（自伤漏召回、高敏感过滤失效）都不是读代码读出来的，而是「实跑 + 写断言」跑出来的。**
> 所以：能跑就跑，跑不了就如实说。

---

## 8. 安全约束（7 条）

1. **凭据不入库**：任何 GitHub / Gitee / OpenAI / AWS / Slack token、私钥、password、真实 API Key
   **严禁提交或更新到仓库**。提交前必须扫描。
2. **只用环境变量引用**：代码里一律 `process.env.XXX` / `config.getConfig()`，**不许硬编码密钥**。
   仓库里只留 `.env.example`（占位值，见下）。
3. **`.gitignore` 必须排除**：`.env`、`*.pem`、`*.key`、`data/`、`logs/`（除白名单）、`dist/`、`_tmp/`。
   现状已包含这些；`logs/` 另用 `!logs/usage_summary.md`、`!logs/calls.sample.jsonl`、`!logs/README.md` 白名单放行交付物。
4. **界面上填的 Key 存 `data/config.json`，对外只显脱敏**：
   `config.saveConfig` 白名单字段 + `mode 0o600` + 临时文件原子写；返回给前端的只有 `keyMasked`（`maskKey`，形如 `sk-abc****wxyz`）。
5. **不许命令行明文传凭据**：不要 `curl -H "Authorization: Bearer sk-..."`。
   如果必须做一次真实调用，用**单条命令的环境变量**传入，**用后即弃**，
   并且**事后提醒用户去控制台吊销重建**（本项目真实发生过「用户把 Key 明文贴进对话」）。
6. **日志脱敏**：`sessionId` 只写 `hmacSessionId`（HMAC 前 12 位），**不写对话原文**；配置写失败的错误信息只带错误码，不带内容。
7. **提交前扫描**（把 `<你的目标> `替成仓库根）：

```bash
grep -rnE "sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY" . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=_tmp
```

期望输出：**空**。有任何命中 → 停下来处理，不要在报告里只写「已注意」。

`.env.example` 是**模板**，里面只能有占位值（`LLM_API_KEY=` 留空、`LOG_SALT=请用随机长字符串填写`），
**绝不许出现真实 Key**。

---

## 9. 交付物约束

### 9.1 `_tmp/` 是临时目录

- `_tmp/` **会被清理器定期清空**，里面的东西**不是交付物**；`_tmp/` 已在 `.gitignore` 里。
- 本次任务产生的一次性脚本 / 探针 / 抓取结果**都写进 `_tmp/`**（这是工作区约定），不要散落别处。
- 但有**归档价值**的产物（评测原始数据、报告）必须移到正式位置——本项目已有先例：
  day14 把真实评测原始数据从 `_tmp/` 归档到 **`docs/eval-results/`**。

### 9.2 硬性交付物对照表

| 题目要求 | 仓库位置 | 改它时要同步什么 |
| --- | --- | --- |
| 可运行 Demo | `main.js` + `public/` + `src/`（桌面版产物走 `build.js`） | 版本号、`README.md` 的下载入口 |
| **真实调用记录** | `logs/calls-*.jsonl`（本机）+ `samples/calls.sample.jsonl`（脱敏样例） | 若新增样例，确认已脱敏；`logs/README.md` 补说明 |
| 使用说明 | `docs/操作手册.md` | 界面步骤变了要重截 `docs/screenshots/` |
| 设计文档 | `docs/design.md` | 架构变了要同步 `ARCHITECTURE.md` |
| 竞品调研 | `docs/competitor-research.md` | 引用来源 + 查询日期 |
| 评测方案 | `docs/evaluation-plan.md` | 分层（L1—L4）口径、通过线 |
| 评测报告 | `docs/evaluation-report.md` | 用例数、真实数据、**未完成项要如实标注** |
| 开发日志 | `devlog/day01.md` … `day14.md` | 每天的「目标/完成内容/验收/待办」四段 |
| **日程记录** | `docs/schedule.md` | ⚠️ **当前只记到第 7 天，缺 day08—day14**，需补 |
| 红队记录 | `docs/red-team.md` + `eval/redteam/` | 失败记录**原样登记，不许美化/删除** |
| **成本台账** | `logs/usage_summary.md` | 估算值必须标「估算」；没有实测 token 就明写没有 |

> ⚠️ `logs/` 曾被整体 gitignore，而它是**必需交付物的位置**；现已用 `!` 白名单放行三个文件。
> ⚠️ `logs/README.md` 实测**是 0 字节空文件**，需要补内容。

### 9.3 文档同步矩阵（改了代码就必须同步这些）

| 你改了什么 | 必须同步 |
| --- | --- |
| 版本号 | `package.json` + `src-tauri/tauri.conf.json`（**两处必须一致**）+ `README.md` 下载段 + 当天 `devlog` |
| 环境变量（新增/改名/改默认值） | `.env.example` + `README.md` 的环境变量表 + `docs/操作手册.md` |
| 风险分级规则 / 策略标签集 | `ARCHITECTURE.md` §5 + `docs/design.md` + `tests/run.js` 的冻结命名注释 + `docs/evaluation-plan.md` 的通过线 |
| 评测用例数（42 / 9 / 20） | `README.md` + `docs/evaluation-report.md` + `docs/evaluation-plan.md` + 当天 `devlog` |
| 界面结构（id / class / 向导步骤数） | `public/index.html` ↔ `public/app.js`（**串行**）+ `docs/操作手册.md` + `README.md` 的截图（截图要重拍） |
| 人设规则 / `PERSONA_VERSION` | `docs/persona.md` + `ARCHITECTURE.md` 模块表 + 当天 `devlog` |
| 提示词版本 / `PROMPT_VERSION` | `docs/design.md` + 日志字段说明（`meta.promptVersion`） |
| 记忆字段（`data/memory.json` 结构变化） | `ARCHITECTURE.md` §6.3 + `docs/design.md` + `src/routes.js` 的 `/api/memory` 响应 + 前端记忆面板 |
| 日志字段集 | `ARCHITECTURE.md` §7 + `logs/README.md` |
| 打包目标 / 产物路径 | `build.js` + `scripts/build-desktop.js` + `README.md` + `docs/操作手册.md` |
| 数据目录 / 路径策略 | `ARCHITECTURE.md` §7 + `docs/操作手册.md` |
| 新增设计决策（有取舍 / 否决了 AI 建议 / 改变对外行为） | **`docs/ADR.md` 新增一条 DR**（见该文件机制说明） |

---

## 10. 一分钟自检清单

任务收尾前逐条打勾（**任何一条打不上就在交付说明里写清原因**）：

- [ ] 我只改了**任务明确授权**的文件（对照 §3.1 与我的文件清单）
- [ ] 没有两个文件被同一次任务并行改（对照 §6.1）
- [ ] 改过的每个 `.js` 都跑了 `node --check`，**无输出**
- [ ] 相关风险级别要求的验证都跑了（对照 §4；**R6 改动跑了吗？**）
- [ ] 跑不了的写的是「**未验证**」，不是「应该没问题」
- [ ] 没有引入任何前端依赖 / CDN / 弹层库
- [ ] 没有把任何 Key / token 写进文件或命令行明文
- [ ] 凭据扫描命令（§8.7）输出为**空**
- [ ] 没有执行 git 命令 / 没有启动长驻服务 / 没有跑完整构建
- [ ] 没有改 `data/`、没有改 `tests/` 的期望值、没有删「已知局限 / 明确不做」
- [ ] `_tmp/` 里没有需要归档的交付物（要归档的已移到正式位置）
- [ ] 需要同步的文档已同步（对照 §9.3），或已在报告里列出「需同步清单」
- [ ] 交付说明里写清了：**改了什么 / 怎么验证的 / 没验证什么 / 已知代价**
- [ ] 如果发现任务书前提有误，**已经指出**（而不是迎合）

---

## 11. 本文件何时需要更新

满足**任意一条**就必须回来改 `AGENTS.md`：

1. 新增 / 删除 / 重命名 `src/`、`public/`、`src-tauri/` 下的文件（同步 §2 目录地图表）；
2. 风险分级 R0—R6 的判据变化，或新增一类「必须串行」的改动（§4 / §6.3）；
3. 验证命令变化（`package.json` 的 scripts 改了、`tests/run.js` 的期望值改了、`eval/` 新增脚本）；
4. `tests/run.js` 的依赖边界被扩大（不再是「只依赖 safety + strategy」）；
5. `.gitignore` 白名单变化，或 `logs/` 的交付策略变化（§9.2）；
6. 文档同步矩阵里的任意一行变化（§9.3）；
7. 安全约束从 7 条增加/减少（§8）；
8. 新增一条**真实发生过**的协作事故（必须补进 §7.3，反面案例也是资产）；
9. 交付物清单变化（§9.2，例如某个 ⏳ 项完成、或有新的必交项）。

> 维护口诀：**改了「谁能改什么 / 怎么验证 / 要同步什么」就要改这里。**
