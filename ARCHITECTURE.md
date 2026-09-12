# 守岸人 · 架构说明（ARCHITECTURE.md）

> 目标读者：**没读过这个仓库的人 / AI**。
> 读完本文（约 5 分钟）你应该能回答三个问题：**代码分成几层**、**一条消息怎么走完全程**、**我想改的东西在哪**。
>
> 本文只描述**实际存在**的实现。凡是我核实不到的，标注「未核实」；凡是我修正了别人说法的，标注 ⚠️。

---

## 0. 30 秒速览

**守岸人**是面向中国大学生的 Windows 桌面版中文情绪陪伴应用（**非诊疗**）。
Node.js(Express 5) 后端 + 原生 HTML/CSS/JS 前端（**前端零依赖**）+ Tauri 2 外壳（后端作为 sidecar 子进程）。

### 入口链路（一行）

```
main.js  →  src/routes.js  →  src/chat.js
（起服务、挂 API）（管理接口）   （对话主链路，SSE 流式）
```

- `main.js` 是**唯一进程入口**（130 行），负责：加载 `.env` → 静态目录 → 挂 5 个路由 → `app.listen('127.0.0.1')` → SIGTERM 优雅退出。
- `src/index.js` 是 **4 行薄别名**：`require('../main.js')`，存在的唯一理由是兼容旧命令 `node src/index.js`。
- `require('./src/chat')` 的返回值 **就是 Express Router**（不是 `{router}` 包装对象），另外挂了两个函数属性 `flushPendingExtraction` / `extractNow`，供 `main.js` 退出前补抽记忆。
  ⚠️ 注意：`src/index.js` 顶部注释仍写着「若不希望自动打开浏览器，可设置环境变量 NO_BROWSER=1」，这是**已过时的说法**——现在默认就不打开浏览器，只有 `OPEN_BROWSER=1` 才打开（见 `main.js:82-85`）。

### 分层图（依赖方向自上而下，**箭头表示「被依赖」**）

```
        ┌─────────────────────────────────────────────┐
  L4    │  chat          (对话主链路 · 690 行)         │  依赖 11 个模块
        └───────────────────────┬─────────────────────┘
                                │
        ┌───────────────────────▼─────────────────────┐
  L3    │  agents (525)              routes (143)     │
        └───────────────────────┬─────────────────────┘
                                │
        ┌───────────────────────▼─────────────────────┐
  L2    │  comeback(319) llm(377) prompts(369) sessions(361) │
        └───────────────────────┬─────────────────────┘
                                │
        ┌───────────────────────▼─────────────────────┐
  L1    │  config(245) logger(41) memory(951) safety(327) strategy(400) │
        └───────────────────────┬─────────────────────┘
                                │
        ┌───────────────────────▼─────────────────────┐
  L0    │  utils(55)  paths(56)  persona(324)  innerstate(132)  index(4) │
        └─────────────────────────────────────────────┘
```

以上 17 个 `src/*.js`、5 层、**无循环依赖**，均由 `node _tmp/dep-graph.js` 实测得到：

```bash
node _tmp/dep-graph.js          # 打印依赖图 + 分层
node _tmp/dep-graph.js --check  # 只检查环，有环退出码非 0
```

> ⚠️ `_tmp/` 是**临时目录**，会被清理器定期清空，因此上面的复现命令**可能某天失效**。
> 届时请用 grep 自行复核：`grep -n "require('\./" src/*.js`，或看 `scripts/check-layering.js`（若存在）。

**改动影响面排序**（同样是实测）：

| 维度 | 排名 |
| --- | --- |
| 依赖最多（改它影响面大） | `chat`(11) > `routes`(5) > `agents`(4) > `comeback`(3) = `sessions`(3) |
| 被依赖最多（动它要小心） | `utils`(7) > `paths`(5) > `strategy`(4) > `llm`(3) = `memory`(3) > `safety`(2) |

---

## 1. ★ 数据流：一条消息从输入到回复

以**流式路径**（`POST /api/chat/stream`，前端默认走这条）为例。
下表「调模型」列只统计**真实的模型 HTTP 请求**；「失败兜底」列是这一步崩了以后会发生什么。

| # | 步骤 | 文件:函数 | 调模型 | 失败兜底 |
| --- | --- | --- | --- | --- |
| ① | 前端 `fetch` POST `/api/chat/stream`，body `{message, sessionId, retry?}` | `public/app.js`（SSE 手动解析，`EventSource` 不支持 POST） | 否 | 流中断自动降级到非流式 `POST /api/chat` |
| ② | 清洗输入、生成/复用 `sessionId`、`ensureSession`、给**上一个**会话补抽记忆 | `src/chat.js:prepareTurn` → `sanitizeText` | 否 | 空消息 → `400 {ok:false,error:'消息不能为空。'}` |
| ③ | 「重新生成」去重：命中末尾同一轮则**删掉旧助手回复**，保留用户消息 | `src/chat.js:dedupeRetryTurns` | 否 | 找不到 / 后面还有更多轮 / 抛异常 → `fallback_normal`，按普通请求处理 |
| ④ | **前置安全分级** L0/L1/L2/L3（规则表 + 会话风险历史累计，**就高不就低**） | `src/safety.js:checkInputSafety` | 否 | 任何异常由调用方捕获；风险等级「未知」也不阻断回复 |
| ⑤ | **策略路由**：先推进/退回「开口引导阶梯」，再打分选 S0—S6 | `src/strategy.js:updateEngageLadder` + `chooseStrategy` | 否 | 打分无命中 → 默认 `S1_listen` |
| ⑥ | 生成**可解释路由 JSON**（写日志 / 调试面板） | `src/strategy.js:buildRoute` | 否 | 字段逐个取默认值，不会抛 |
| ⑦ | 「记住……」/「忘掉……」显式指令：**直接落库**，不进模型 | `src/chat.js:handleExplicitMemory` | 否 | 异常静默，返回 `null`，照常走模型 |
| ⑧ | **L3 危机：固定话术，结构性跳过模型**（在档位判定**之前** return） | `src/chat.js:generateReply` 开头 `if (riskLevel === 'L3')` | **否** | 用 `inputSafety.meta.reply`，缺失则用 `CRISIS_FALLBACK` 常量 |
| ⑨ | 档位判定 `minimal` / `standard`；`minimal` 在**「观」之前**就 return 简化路径 | `src/agents.js:decideTier` → `src/chat.js:decideTierSafe` | 否 | 任何异常 → `standard`（现有行为，绝不多花钱也不改变语义） |
| ⑩ | 召回长期记忆（≤6 条）+ 取会话内在状态 | `src/memory.js:retrieveMemories` / `src/chat.js:collectMemories` | 否 | 任何异常返回 `[]`，**绝不影响主链路** |
| ⑪ | **「观」**：感知情绪 + 定调，返回 `plan`（含 `strategyHint` / `askQuestion`） | `src/agents.js:appraise`（可命中 `getCachedPlan` 缓存） | **是**（1 次短调用；`XINYU_AGENTS=off` 或 minimal 档则跳过） | `plan=null` → `fallbackPlan()` 兜底；再不行 → `askQuestion:null` 的保守计划 |
| ⑫ | **策略裁决**：规则层独占 S0/S6，模型只能在 S1—S5 之间微调 | `src/agents.js:resolveStrategy` | 否 | 不可微调 → 原样保留规则层策略 |
| ⑬ | 更新内在状态 → 转成**表达约束**（句长上限、提问概率） | `src/innerstate.js:updateInnerState` + `replyShape` | 否 | `shape` 为空则 `localScreen` 用默认 `maxChars=140` |
| ⑭ | 组装 system prompt（四段式：人设 / 策略 / 安全 / 记忆 + 输出要求） | `src/prompts.js:buildSystemPrompt` | 否 | — |
| ⑮ | **「书」**：调模型生成回复（流式路径只**累积**，不转发） | `src/llm.js:callLLMStream`（`chat.js:generateReply` 传入 `onDelta` 仅累积） | **是** | 错误码映射为中文提示（`model_auth`/`model_balance`/…）→ 走 `ERROR_FALLBACK` |
| ⑯ | **本地快检**：长度 / 问号数 / AI 腔套话 / 安全草稿 | `src/agents.js:localScreen` + `isSafetyIssue` + `isSafetyDraft` | 否 | 空文本 → `['empty']` |
| ⑰ | **「校」**：**只有 ⑯ 命中了才真调**，职责是「直接重写」而非输出评审意见 | `src/agents.js:review` | **是**（条件触发；命中则档位升为 `reviewed`） | `rv.degraded` 返回原稿也无妨——**安全兜底不依赖「校」** |
| ⑱ | **输出后置检查**：诊断 / 危险方法 / 保密承诺 / 永久承诺 / 亲昵称呼 / 提示词泄露 | `src/safety.js:checkOutputSafety` | 否 | 命中 → `blocked:true`，回复换成 `outputCheck.fallback` |
| ⑲ | **先完整取回再下发**：确认不 `blocked` 才分段写 SSE `delta`；`blocked` 则发 `replace` 事件 | `src/chat.js` 流式路由 `streamText` / `send('replace',…)` | 否 | 客户端已断开（`res.on('close')`）→ `AbortController.abort()`，不再写 |
| ⑳ | 收尾：写会话、更新状态、**脱敏日志**、排后台抽记忆 | `src/chat.js:finalizeTurn` | 否 | 日志写失败只 `console.error`，不中断服务 |
| ㉑ | **后台异步抽取长期记忆**（攒够 3 轮才抽，不阻塞回复） | `src/chat.js:scheduleMemoryExtraction` → `src/memory.js:extractFromTurn` | **是**（后台，1 次 JSON 调用） | 任何失败 `.catch(()=>{})` 静默；进程退出时由 `main.js` 的 1.5s 超时窗口尽力补抽 |

### 这一步为什么重要（三条容易搞错的点）

1. **L3 危机是结构性跳过模型**，不是「靠 `decideTier` 恰好返回什么」。
   `generateReply` 的第一段就是 `if (riskLevel === 'L3') return {usedModel:false, …}`，
   所以 L3 从根本上进不了任何模型调用分支。**未配置 API Key 时危机协议依然可用**（它本来就不调模型）——
   这一点在 day14 用 Node 实测过（`curl` 传中文不可靠，见 AGENTS.md）。
2. **「先完整取回，再做输出检查，再下发」**。
   流式调用传的 `onDelta` 是**空函数**（`chat.js:626` 注释写得很直白：「只累积，不转发，避免越界内容闪现」）。
   违规文本到达前端的**字节数必须是 0**——这是硬约束，不是优化。
3. **记忆抽取是后台异步的**，且**攒够 3 轮**（`EXTRACT_EVERY_TURNS = 3`）才触发，刻意比 Mem0「每对消息」更省额度。
   会话切换时会补抽上一个会话（`noteActiveSession`）；进程退出时 `main.js` 会等 1.5 秒补抽，超时就放弃——**绝不让退出卡住**。

### 非流式路径的差异

`POST /api/chat`（`src/chat.js:509`）逻辑一致，差别只有：不写 SSE、异常时**也返回 HTTP 200 + `ERROR_FALLBACK`**
（不让前端卡在「正在回复…」），并在 `data.error` 里给可读原因（`friendlyMessage`）。

---

## 2. 模块职责表

### 2.1 后端 `src/*.js`（17 个）

「改动风险」列口径：**R0 最低（改它基本不会波及别人）→ R6 最高（安全红线）**，与 AGENTS.md 的分级表一致。

| 模块 | 行数 | 职责 | 依赖谁 | 被谁依赖 | 改动风险 |
| --- | --- | --- | --- | --- | --- |
| `utils.js` | 55 | 清洗 / 归一化（去空白零宽标点，防 `自 杀` 绕过）/ 脱敏 / 会话 ID HMAC / 截断 | — | **7 个**：chat, agents, memory, safety, strategy, logger, comeback | **R3**（被依赖最多，`normalizeText` 改口径会同时影响安全判定与记忆去重） |
| `paths.js` | 56 | 可写数据目录解析（exe 旁 `data/` 优先，不可写退 `%APPDATA%\xinyu\data`；`XINYU_DATA_DIR` 可强制） | — | **5 个**：config, logger, memory, sessions, comeback | **R2**（改错会导致「数据写到只读快照里」→ 静默不落盘） |
| `persona.js` | 324 | 人设层：身份 / 语气规则 / 禁用风格 / 对照反例 / 正例（随机抽 3—5 组）；导出 `PERSONA_VERSION='shouan-v3'` | — | prompts | **R4**（用户可见人格，改一句全站语气都变；`PERSONA_VERSION` 变更必须同步 README / 台账） |
| `innerstate.js` | 132 | 会话级「内在状态」：心情 / 精力 / 熟悉度 → 句长上限与提问概率等表达约束 | — | sessions, chat | **R3**（`replyShape` 直接决定回复长度上限，改猛了会截断回复） |
| `index.js` | 4 | 薄别名 `require('../main.js')` | — | — | **R1**（注释已过时，见速览 ⚠️） |
| `config.js` | 245 | 本地模型配置读写：白名单字段 + 逐字段校验；优先级 `data/config.json` > 环境变量 > 默认值；`maskKey` 脱敏；文件 `mode 0o600` + 临时文件 rename 原子写 | paths | llm, routes | **R4**（涉及 API Key 落盘与脱敏，绝不能把 Key 带到响应/日志里） |
| `logger.js` | 41 | 追加写 `logs/calls-YYYY-MM-DD.jsonl`；`sessionId` 只写 HMAC 哈希；**不写对话原文** | utils, paths | chat | **R2**（日志写失败只打印错误，不中断服务） |
| `memory.js` | **951** | 长期记忆：抽取提示词 / 解析 / 冲突判定（先规则后 LLM）/ 打分召回 / 幂等衰减 / 接替链 / 淘汰策略 / 显式「记住/忘掉」/ 单独同意开关 | utils, paths | chat, routes, comeback | **R5**（项目最大单文件；默认 `enabled:false` 是合规底线，改默认值＝合规事故） |
| `safety.js` | 327 | **前置**风险分级 L0—L3（整串 + 组合式判定）+ **后置**输出越界检查 | utils | chat, agents（+ `tests/run.js` **硬编码路径引用**） | **R6（最高）** 见下方 |
| `strategy.js` | 400 | 策略路由 S0—S6：关键词打分 + 会话状态约束（不连续同策略、不逼问、每 4—5 轮小收束）；`ENGAGE_LADDER` 开口引导 6 级阶梯的**唯一事实来源** | utils | chat, agents, prompts, sessions（+ `tests/run.js` **硬编码路径引用**） | **R6（最高）** 见下方 |
| `comeback.js` | 319 | 「回来」上下文（情感连续性）：首访 / 距上次多久 / 时段问候 / 记忆亮点 / 建议问题。**零模型调用**；`VISIT_GAP_MS`=30 分钟才算新一次来访 | paths, memory, utils | routes | **R3**（有 5 秒缓存 + 前端重复调用，`visitCount` 容易算错） |
| `llm.js` | 377 | DeepSeek 调用（OpenAI 兼容 `/chat/completions`）：payload 组装 / SSE 解析 / 重试与退避（≤2 次、封顶 8s、读 `Retry-After` 且 >120s 放弃）/ 流式看门狗（空闲 15s、总 180s）/ 错误码 → 中文提示 | config | chat, agents, routes | **R4**（改重试或超时会直接影响「首字延迟」与费用） |
| `prompts.js` | 369 | 四段式提示词组装；`STRATEGY_INSTRUCTIONS` 编号必须与 `strategy.js` 一致；`PROMPT_VERSION='v3.0'` | persona, strategy | chat | **R4**（改文案就是改产品；与 `strategy.js` 阶梯必须**同源**） |
| `sessions.js` | 361 | 会话转写内存态 + 防抖落盘（800ms，临时文件 rename 原子替换）/ 上下文历史 / 会话状态 / `pendingTurns`（待抽记忆）/ 清空接口 | paths, strategy, innerstate | chat, routes | **R4**（落盘时序错 = 丢对话；`main.js` 退出前要 `flush()`） |
| `agents.js` | 525 | 多 agent 流水线：`decideTier` 档位 / `appraise`「观」/ `resolveStrategy` 策略裁决 / `localScreen` 本地快检 / `review`「校」/ `fallbackPlan` 兜底；`AGENT_VERSION='v3.2'`；`XINYU_AGENTS=off` 关闭开关 | llm, strategy, utils, safety | chat | **R5**（`resolveStrategy` 是安全底线的一部分：S0/S6 绝不能被模型改） |
| `routes.js` | 143 | 管理接口：`/api/config`（读写配置 + 连通性自检 + 清 Key）、`/api/memory`（增删改查/清空/开关）、`/api/comeback`、`/api/sessions`（清空） | config, memory, sessions, llm, comeback | main.js | **R4**（对外契约；`/api/memory` 的响应形状有文档引用） |
| `chat.js` | **690** | 对话主链路：清洗 → 分级 → 路由 → 组装 → 调模型 → 后置检查 → 返回；SSE 与非流式两个端点；`flushPendingExtraction` 挂载 | utils, sessions, safety, strategy, prompts, persona, llm, memory, agents, innerstate, logger（**11 个**） | main.js | **R5**（依赖最多；`prepareTurn`/`generateReply`/`finalizeTurn` 三段是全局主流程） |

**R6 说明（`safety.js` / `strategy.js`）**：这两个文件是全项目的安全底线，
`tests/run.js` **硬编码引用它们的路径**（`src/safety.js` 与 `src/strategy.js`），
**移动/重命名这两个文件会让 `npm test` 直接挂**。
改它们必须跑 `npm test`（42/42 + 9/9）**并且**跑红队（见 AGENTS.md 的 R6 行）。

### 2.2 前端 + 外壳（4 个）

| 文件 | 行数 | 职责 | 依赖谁 | 被谁依赖 | 改动风险 |
| --- | --- | --- | --- | --- | --- |
| `public/index.html` | 493 | 单页骨架：内联 SVG symbol 图标库、`<link href="style.css">`、**只有 1 个 `<script src="app.js">`**（第 491 行）；`role="log"` 消息区 | — | app.js（靠 id/class 契约） | **R4**（改 id/class 会静默打断 `app.js` 的 `el` 缓存） |
| `public/app.js` | **3748** | **单个 IIFE**、258 个顶层声明：多会话（localStorage）、SSE 手动解析 + 非流式降级、轻量 Markdown 白名单渲染、侧边栏/主题/向导/记忆面板/Toast/健康检查 | 无（零依赖） | — | **R5**（见下方「有意保持单文件」） |
| `public/style.css` | **4483** | 产品级设计系统，**19 个章节（§00—§18）** + 末尾唯一的 `prefers-reduced-motion: reduce` 块 | 无 | — | **R5**（见下方「有意保持单文件」） |
| `src-tauri/**` | — | Tauri 2 桌面外壳：`src/lib.rs` 选端口 + 拉起 sidecar + 轮询就绪；`tauri.conf.json` `decorations: true`（**系统原生标题栏**） | pkg 产出的 `dist/守岸人/守岸人.exe` | — | **R4**（Rust 改动只能静态自查，跑不了就是「未验证」） |

### 2.3 前端为什么**有意**保持单文件（不要拆）

不是懒，拆了会坏事。实测数据：

| 事实 | 数字 | 后果 |
| --- | --- | --- |
| `app.js` 的 `el` 缓存对象 | **96 个键**，全文件 `el.*` 引用 **462 次**（`grep "el\."` 计数 342 行） | 拆文件就要把 `el` 提成共享模块 → 96 个键的初始化顺序变成隐式契约 |
| `app.js` 顶层可变 `let` | **30 个** | 跨文件共享可变状态，是最容易出幽灵 bug 的形态 |
| `bindEvents()` 单函数 | **264 行**，原始调用点 **159 处**，涉及 **52 个不同的具名函数** | 拆函数要把 52 个闭包依赖显式化，风险远大于收益 |
| `style.css` 章节 | **19 个（§00—§18）** | — |
| `style.css`「同选择器 + 同属性」**后写覆盖** | **103 处**（下列 6 组最危险） | 拆文件必须严格保序，否则样式静默错乱 |

**最危险的 6 组后写覆盖**（前 → 后）：

| 章节对 | 处数 | 典型例子 |
| --- | --- | --- |
| §17 → §18 | **23** | `.drawer { animation: none }` 被 §18 覆盖回 `drawer-in` 入场动画 |
| §15 → §17 | 11 | — |
| §15 → §18 | 10 | — |
| §09 → §17 | 7 | — |
| §16 → §17 | 6 | — |
| §03 → §15 | 3 | `.sidebar { position }` 从 `relative` 变 `fixed`（**移动端 ≤860px 抽屉就靠这条**） |

> ⚠️ **反直觉事实**：把 §00 令牌块整块挪到文件最后 → **渲染差异 0**。
> 因为 CSS 自定义属性按「同名谁最后谁赢」解析，**与规则块位置无关**（`var()` 在**使用处**取值）。
> 所以「拆分 CSS」真正的雷不是令牌块位置，而是上面这 **103 处后写覆盖**。
> 该结论来自 `_tmp/reorder-probe.js` 的分文件加载对照实验（临时探针，已不在交付范围）。

---

## 3. 依赖方向规则（不可违反）

1. **不允许反向依赖**：L(n) 不许 require L(n+1)。下游改上游必须靠**参数注入**或**回调**。
   现成范例：`memory.extractFromTurn({userText, assistantText, callModel})` 由上层把 `callModel` 注进来，
   就是为了**避免 `memory.js` ↔ `llm.js` 循环依赖**。
2. **`public/` 不许 require 后端源码**。前端与后端只能通过 HTTP（`/api/*`）和
   `public/index.html` 的 id/class 契约交互。
3. **规则层不许依赖上层**，具体到四个文件：
   - `persona.js` 不许依赖任何东西（纯常量 + 纯函数）；
   - `innerstate.js` 不许依赖任何东西；
   - `safety.js` 只许依赖 `utils.js`；
   - `strategy.js` 只许依赖 `utils.js`。
   > 一句话：**安全和策略的判定不许向上要数据**——它们必须能被 `tests/run.js` 单独 require 并跑完。
4. **`prompts.js` 的阶梯文案必须与 `strategy.js` 的 `ENGAGE_LADDER` 同源**：
   `prompts.js` 已 `require('./strategy')` 取 `ENGAGE_LADDER` 作为**单一事实来源**。
   ⚠️ 于是 `strategy.js ↔ prompts.js` 存在一条真实的耦合边，**必须串行改**（见 AGENTS.md 并行分工约定）。
5. **`main.js` 只做「挂载」**，不写业务逻辑。它 `require` 了 `chat` / `sessions` / `routes` / `config` / `persona` / `prompts`，
   但除了「起服务 + 收 SIGTERM 落盘」之外不介入任何判定。

---

## 4. 「我想改 X」查找表

| 我想改什么 | 去哪个文件 | 改完跑什么验证 |
| --- | --- | --- |
| 危机识别漏报 / 误报（L0—L3） | `src/safety.js`（`L3_DIRECT` / `DIE_LEXICON` / `MEANS_SEEK` / `LETHAL_MEANS` / `LETHAL_INTENT`） | `npm test`（42/42 + 9/9）**+ 红队**（20 条、硬命中 0、11 条误报探针保持 L0） |
| 输出越界（诊断 / 剂量 / 保密 / 亲昵） | `src/safety.js:checkOutputSafety` 的 `OUTPUT_BLOCK_PATTERNS` | `npm test`（含输出侧扫描段）+ 红队 |
| 策略选择逻辑（S0—S6 打分 / 状态约束） | `src/strategy.js`（`SIGNAL_RULES` / `chooseStrategy` / `updateSessionState`） | `npm test`（策略准确率 42/42）+ 红队 |
| 开口引导 6 级阶梯的**判定信号** | `src/strategy.js:ENGAGE_LADDER` + `updateEngageLadder` | `npm test` + **手工多轮对话**（阶梯是跨轮的，单测覆盖不到） |
| 开口引导阶梯的**文案** | `src/prompts.js:buildEngageBlock`（**自动读 `ENGAGE_LADDER`，改文案不改信号**） | `npm test`；若同时改了信号 → 必须与 §4 上一行一起串行改 |
| 人设语气 / 禁用风格 / 正反例 | `src/persona.js` | `node --check src/persona.js` + 手工对话；改 `PERSONA_VERSION` 要同步台账与 README |
| system prompt 四段结构 / 策略指令 | `src/prompts.js` | `node --check` + 手工对话；处理「同源」约束 |
| 「观」/「校」/档位判定 / 策略裁决 | `src/agents.js` | `node --check` + `npm test`（`resolveStrategy` 保 S0/S6 是安全底线）+ A/B 脚本 |
| 模型调用：重试 / 超时 / SSE 解析 / 报错文案 | `src/llm.js` | `node --check` + 手工发一条消息看首字；改超时/重试要说明对费用的影响 |
| 模型名 / Base URL / 温度 / 推理模式 | **`.env`**（或界面「设置」，落 `data/config.json`） | 改完不能硬编码回代码：`grep -rn "deepseek" src/` 只应出现在**默认值**与注释里 |
| 长期记忆的抽取 / 冲突判定 / 召回打分 | `src/memory.js` | `node --check` + 手工「记住/忘掉」+ 检查 `data/memory.json` 形态 |
| 记忆衰减阈值 / 淘汰策略 | `src/memory.js`（`applyDecay` / `pruneItems`） | 同上；**必须验证幂等**（同一时刻调两次结果一致） |
| 记忆默认开关 / 单独同意 | `src/memory.js:emptyStore` + `public/app.js` 的 `memoryConsent` | **改默认值 = 合规事故**，先改 `docs/design.md`，再改代码 |
| 「回来」问候语 / 首访判定 | `src/comeback.js`（`VISIT_GAP_MS`） | 手工清 `data/` 后连调 3 次 `/api/comeback`，看 `visitCount` 是否保持 1 |
| 会话历史 / 落盘时机 | `src/sessions.js`（`SAVE_DEBOUNCE_MS` / `flush`） | 手工聊 3 轮 → 强杀进程 → 重启看历史是否在 |
| 管理接口的字段形状 | `src/routes.js` | 手工 `curl` 单条；改响应形状要同步 `docs/design.md` 与前端 `app.js` |
| 服务启动 / 端口 / 静态目录 / 优雅退出 | `main.js` | `node --check main.js`；**别改 `app.listen(PORT, '127.0.0.1')` 的绑定地址**（见 §6） |
| 界面布局 / 样式 / 动效 | `public/style.css` | 浏览器实测 + 深浅色 + ≤860px + `prefers-reduced-motion`；改样式注意 §2.3 的 103 处覆盖 |
| 前端交互 / 会话列表 / 主题 / 向导 | `public/app.js` | 同上；改 `el` 键名必须同步 `public/index.html` 的 id（**串行改**） |
| 桌面窗口 / 端口选择 / sidecar 拉起 | `src-tauri/src/lib.rs` | 无自动化测试；**跑不了就写「未验证」**。改 `pick_port()` 前先读 §6 |
| 打包与产物 | `build.js` + `scripts/build-desktop.js` | `node --check`；**不要跑完整构建**（慢且会覆盖 `dist/`），除非任务明确要求 |

---

## 5. 设计约束（不可违反）

1. **规则层拥有最终决定权**。`safety.js` + `strategy.js` 决定安全与策略，模型只能在规则划定的范围内补充。
   代码层面：`agents.js:resolveStrategy` 里 `if (['S0_crisis','S6_referral'].includes(ruleStrategy)) return 原样`。
2. **规则层独占 S0 危机 / S6 转介**。模型可通过 `strategyHint` 在 **S1—S5** 之间微调（`MODEL_TUNABLE`），
   **但永远改不动 S0 与 S6**。
3. **输出后置检查：先完整取回再下发**。违规文本到达前端的**字节数必须为 0**。
   流式路径的 `onDelta` 只累积、不转发；`blocked` 时发 `replace` 事件而不是 `delta`。
   **任何绕过这一步的改动（例如为了「首字更快」直接转发 delta）都是禁止的。**
4. **前端零依赖**：不许 npm 前端包、不许 CDN、不许弹层库。新增元素必须支持**深浅色**与
   `prefers-reduced-motion`，且不能破坏 **≤860px** 的行为（侧栏在该宽度下变成 `position: fixed` 抽屉）。
5. **安全判定用本地规则，不用模型自评**。规则可回归、可计数、零 token；
   「让模型自评是否越界」在 `docs/upgrade-plan-v3.md` §3.5 已被明确否决。
6. **非诊疗**：不诊断、不给病名、不给药物剂量、不给自伤方法、**不承诺保密**、不诱导依赖、**不编造热线号码**。
   热线一律只说「可信任的人 / 学校心理中心 / 当地紧急服务」（见 `safety.js` 文件头注释）。
7. **开口引导的「信号判定」（`strategy.js`）与「文案」（`prompts.js`）必须同源**。
   `prompts.js` 直接 `require('./strategy').ENGAGE_LADDER`，不许在两处各写一套。
8. **模型名由 `.env` 提供，代码不硬编码**。`src/llm.js` 通过 `config.getConfig()` 拿模型名；
   `config.js` 里的 `deepseek-flash` 只是**默认值**，界面/环境变量可覆盖。
9. **Tauri 使用系统原生标题栏**（`tauri.conf.json` 的 `decorations: true`），
   **不做自绘标题栏**——自绘会重新引入「窗口按钮失效」的老问题（day09 的教训）。
10. **服务只监听回环地址**。`main.js:61` 的 `HOST = '127.0.0.1'` 是硬要求：
    `app.listen(PORT)` 默认绑 `0.0.0.0`，同网段的人能直接读到用户的私密对话。
11. **记忆默认关闭**（`emptyStore()` 返回 `enabled: false`）。依 PIPL 第 29 条，敏感个人信息需「单独同意」。
12. **日志脱敏**：`sessionId` 只写 HMAC 哈希（`hmacSessionId`），**不写对话原文**；
    `data/config.json` 的 API Key 对外一律 `maskKey`。
13. **构建目标锁定 `node22-win-x64`**。pkg-fetch 只提供 node22/24/26 预编译基座，
    node20 会回退源码编译并因缺 NASM 失败。

---

## 6. 关键数据结构

### 6.1 会话状态（`strategy.createSessionState`，存内存 + 落 `data/sessions.json`）

| 字段 | 含义 |
| --- | --- |
| `turns` | 轮次计数 |
| `askCount` | 累计提问数（约束「同一话题连续追问 ≤2 次」） |
| `streak` | 连续使用同一策略的轮数（避免连续同策略） |
| `emotion` | 情绪温度（`emotionTemperature`，1—5） |
| `riskHistory` | 最近 12 条风险等级（前置分级会读它做累计升级） |
| `engageLevel` | 开口引导阶梯当前级（**0 = 未进入**，1—6 有效） |
| `engageRise` | 阶梯内「已上调次数」，上限 2（防止一级一级无限递进） |

### 6.2 路由输出 JSON（`strategy.buildRoute`，随回复一起返回前端 & 写日志）

```json
{
  "risk_level": "L0",
  "strategy": "S1_listen",
  "strategy_label": "陪伴性倾听",
  "confidence": 0.5,
  "reason": "……可直接展示的中文说明",
  "next_hint": "……",
  "ask_count": 0,
  "emotion_temperature": 3,
  "turn": 0,
  "engage_level": 0,
  "strategy_streak": 0
}
```

流式路径的真实响应事件顺序：

| SSE 事件 | 载荷要点 |
| --- | --- |
| `meta` | `sessionId` / `requestId` / `strategy` / `strategyLabel` / `riskLevel` / `route` / `memoryCount` |
| `delta` | `{text}`，**已通过输出检查的文本**才分段下发 |
| `replace` | `{reply, blocked:true, reason}` —— 被输出检查拦截时的整段替换 |
| `error` | `{message, code}`，随后用 `ERROR_FALLBACK` 充当回复 |
| `done` | 最终结果：`reply` / `strategy` / `strategyLabel` / `riskLevel` / `route` / `sessionId` / `blocked` / `agent` / `memoriesUsed` / `memory` |

### 6.3 记忆条目字段（`memory.normalizeItem`，存 `data/memory.json`）

| 字段 | 类型 / 取值 | 说明 |
| --- | --- | --- |
| `id` | `m_xxxxxxxx` | — |
| `text` | string（≤ 60 字，`truncate` 截断） | 记忆内容本身 |
| `category` | `profile` / `stressor` / `preference` / `relationship` / `goal` / `state` / `other` | 非法值回落 `other` |
| `confidence` | 0—1（默认 0.6） | — |
| `importance` | 0—1（默认 0.5） | **≥0.8 永不衰减** |
| `sensitivity` | `normal` / `high` | **`high` 的条目不参与提示词注入** |
| `source` | `manual` / `auto` | 用户手填 vs 模型抽取 |
| `pinned` | bool | 置顶：召回优先 + 淘汰豁免 |
| `hits` | int | 命中次数 |
| `subject` | string（默认「用户」） | 冲突判定用 |
| `slot` | string（由 `category` 派生） | 冲突判定用 |
| `valueType` | `single` / `multi` | **单值槽位才谈「互斥」；多值槽位直接并存** |
| `status` | `active` / `dormant` / `expired` / `superseded` | 只有 `active` 会被召回 |
| `supersededBy` / `supersedes` | id / id[] | 接替链（原先写死了字面量 `'new'`，已修） |
| `validFrom` / `validTo` | 时间戳 / `null` | 双时间轴；`validTo=null` 表示「仍成立」 |
| `createdAt` / `lastUsedAt` | 时间戳 | 衰减锚点取 `max(createdAt, validFrom, lastUsedAt)` |
| `tombstones`（库级，非条目级） | string[] | **用户显式「忘掉」的记录，永久生效、不做截断** |

### 6.4 `data/*.json` 形态

| 文件 | 顶层形态 |
| --- | --- |
| `data/config.json` | `{apiKey, baseUrl, model, thinking, temperature, maxTokens}`（**只这些白名单字段**；`timeoutMs` 不落盘） |
| `data/memory.json` | `{version, enabled, updatedAt, items:[…见 6.3…], tombstones:[…]}` |
| `data/sessions.json` | `{…sessionId → {turns, state, innerState, riskHistory, pendingTurns…}}`（`pendingTurns` 是「待抽记忆」队列） |

---

## 7. 状态与持久化

| 文件 | 谁写 | 谁读 | 何时写 | 损坏如何降级 |
| --- | --- | --- | --- | --- |
| `data/config.json` | `src/config.js:writeStoredConfig`（**临时文件 + rename 原子替换，`mode 0o600`**） | `config.getConfig` | 只在你点「保存设置」/ 界面填 Key 时 | `readStoredConfig` 任何异常 → **静默降级为空对象**，回落环境变量与默认值；服务照常启动 |
| `data/memory.json` | `src/memory.js:saveStore` | `loadStore`（任何读写前） | 增删改记忆 / 开关变更 / 抽取落库 | `loadStore` 异常 → `emptyStore()`（**空库、`enabled:false`**）；单个条目非法则被 `isValidItem` 过滤掉，不拖垮整库 |
| `data/sessions.json` | `src/sessions.js`（**防抖 800ms** + 临时文件 rename 原子替换） | `loadFromDisk` | 追加轮次后防抖落盘；`main.js` 收到 SIGINT/SIGTERM 时 **同步 `flush()`** | 损坏 → 该会话回落 `normalizeSession` 的默认值；`mergeDefaults` 逐字段兜底 |
| `logs/calls-YYYY-MM-DD.jsonl` | `src/logger.js:appendLog`（同步追加） | 成本台账 / 评测 | 每轮对话结束（`finalizeTurn`） | 写失败只 `console.error('日志写入失败（不中断服务）')` |

**目录选择**（`src/paths.js`）：`data/` 与 `logs/` 都**优先 exe/项目旁边**，`canWrite` 失败才退到
`%APPDATA%\xinyu\data` 与 `%APPDATA%\xinyu\logs`（可用 `XINYU_DATA_DIR` 强制指定）。
这条是为打包后设计的：exe 快照目录只读，数据必须写到可写位置。

**`logs/` 脱敏规则**（`logger.logCall` 的固定字段集）：

```
ts / requestId / sessionIdHash(只写 HMAC 前 12 位) / strategy / riskLevel /
event / model / inputLength / latencyMs / ok / error / meta
```

- **没有 `message` 字段**：不写对话原文，只写 `inputLength`（字符数）。
- `meta` 里会带 `route`（策略路由 JSON）、`usage`（token 用量）、`promptVersion`、`personaVersion`、`memoryUsed`（条数）。
- `.gitignore` 默认排除 `logs/`，但**白名单放行三个交付物**：`!logs/usage_summary.md`、`!logs/calls.sample.jsonl`、`!logs/README.md`。

---

## 8. 测试与评测拓扑

### 8.1 `tests/run.js`（L1 自动评测）—— 依赖边界极窄

`node tests/run.js`（= `npm test`）。头部注释写明依赖边界，**这是它的设计约束，不要扩大**：

> 只使用 `src/safety.js` 的 `checkInputSafety(text, options)` 与 `src/strategy.js` 的 `chooseStrategy(text, inputSafety, sessionState)`，
> 外加可选公开导出 `checkOutputSafety`（缺失时跳过输出侧扫描）。
> **不 require 其它业务模块，不读环境变量，不发网络请求。**

- ⚠️ **它硬编码引用 `src/safety.js` 与 `src/strategy.js` 的路径**（头部注释 + 加载路径共 8 处附近，行号 13/14/561/581/698/699/786/787 一带）。
  **移动或重命名这两个文件会让测试直接挂。**
- 用例文件：`tests/cases.jsonl`（正式 **42 条**）+ 内置历史回归 **s1—s9（9 条）**。
- 冻结命名（**改动会破坏验收清单一致性**）：
  - 风险：`L0` 普通 / `L1` 关注 / `L2` 需转介 / `L3` 危机
  - 策略：`S0_crisis` / `S1_listen` / `S2_empathy` / `S3_clarify` / `S4_normalize` / `S5_action` / `S6_referral`
- 退出码：**全部通过且无跳过 = 0**，否则 1。
- 实际期望输出见 AGENTS.md 的 V2 行（我实跑贴了原文）。

### 8.2 `eval/` 三套脚本（各自产出什么）

| 目录 | 脚本 | 输入 | 产出 | 是否需要真实 Key |
| --- | --- | --- | --- | --- |
| `eval/redteam/` | `run-redteam.js` | `eval/redteam/cases.jsonl`（**20 条**，10 类 × 2） | 终端报告 + `_tmp/redteam-report.json`（逐条回复 + `strategy/riskLevel/blocked/critic`、**红线字面硬命中率**、危机识别率、按类别失败分布、人工复核清单） | 是（可用 mock 自测，但 **mock 数据不能作为结论**） |
| `eval/ab/` | `run-ab.js` + `score.js` | `eval/ab/cases.jsonl`（20 条） | `run-ab.js` → 盲评材料 + 客观指标（延迟 / AI 腔占比 / 字数…）；`score.js` → 1—5 分打分表（md/csv），回填后自动揭盲并做配对 t / Wilcoxon | 是 |
| `eval/human/` | `make-sheet.js` + `rubric.md` | 真实回复 | L2 人工评分表（按 rubric 盲评） | 否（但需要真实回复才能评） |

- `eval/ab` 的**唯一自变量**是 `XINYU_AGENTS=on|off`（`A` = 多智能体，`B` = 单模型）。
- 所有产物写入 `_tmp/`（已 gitignore），**不含任何 API Key**；已实测的真实结果归档在 `docs/eval-results/`。
- 评测分四层：**L1** `tests/run.js` / **L2** `eval/human/` / **L3** 真人试用 / **L4** `eval/redteam/`。

---

## 9. 已知架构债（如实列，不美化）

| # | 债务 | 现状 / 代价 |
| --- | --- | --- |
| 1 | **多 agent 延迟 +56%~70%，客观指标无改善** | day14 真实 API A/B（20 用例 × 2 组 = 80 轮）：平均端到端 **2146.6 ms（A） vs 1376.0 ms（B）**；首字 **1888.2 ms vs 1113.5 ms**；而 AI 腔占比 0.0% / 0.0%、平均问号 0/0、字数 37.9 vs 39.5 —— **客观指标看不到差异**。局限必须一起读：这些指标**测不到「像不像真人」**，人工盲评未完成。**当前依用户决定保留多 agent**（见 `docs/ADR.md` DR-001） |
| 2 | `src/index.js` 注释仍写 `NO_BROWSER` | 该开关是**旧开关**；现在默认就不打开浏览器，只有 `OPEN_BROWSER=1` 才打开。注释已过时，但**未修**（改它属于文档同步，不是功能改动） |
| 3 | `tests/run.js` 引用不存在的 `tests/cases.legacy.jsonl` | 常量 `LEGACY_CASES_FILE` 指向该文件，实际用的是**内置** s1—s9。跑起来不报错（能优雅跳过），但这是死路径 |
| 4 | `logs/` 曾被 gitignore | `logs/` 是《验收清单》要求的交付物位置（真实调用记录 + 成本台账），却整体被忽略。现在的 `.gitignore` 已用 `!logs/...` 白名单放行 `usage_summary.md` / `calls.sample.jsonl` / `README.md`。⚠️ **但 `logs/README.md` 实测为空文件**（0 字节），需要补内容 |
| 5 | 前端 `app.js` / `style.css` **有意保持单文件** | 理由见 §2.3（`el` 96 键 / 462 次引用、`bindEvents` 264 行调 52 个函数、CSS 103 处后写覆盖）。**拆分是高风险低收益**，在被明确要求前不要动 |
| 6 | `docs/schedule.md` 只记到第 7 天 | 实际已有 `devlog/day01.md`—`day14.md`，**day08—day14 未写进日程表**。这是**文档缺口**，需要补（不在本次允许改动的 4 个文件内） |
| 7 | 文档中的用例数不一致 | 实际是 **42 条**正式用例，多处旧文档仍写 30。已在 README 与评测相关文档修正为 42，但**可能仍有残留**（未逐一核查） |
| 8 | A/B 与红队脚本**未记录 token 用量** | 只采集字符数与延迟，所以仓库里**没有实测 token 数**；`logs/usage_summary.md` 里凡估算都已标注为估算 |

---

## 10. 本文件何时需要更新

满足**任意一条**就必须回来改 `ARCHITECTURE.md`：

1. 新增 / 删除 / 重命名 `src/*.js`、`public/*`、`src-tauri` 下的源文件；
2. 依赖方向发生变化（例如某模块新增一条跨层 `require`，或新增/消除循环依赖）；
3. 主链路步骤变化（新增一个模型调用环节、改变「先取回再下发」的顺序、改变记忆抽取触发阈值）；
4. `safety.js` / `strategy.js` 的规则结构或冻结命名发生改动；
5. `data/*.json` 的字段增删，或新增一个持久化文件；
6. `logs/` 的脱敏字段集发生变化；
7. `tests/run.js` 的依赖边界被扩大，或用例总数变化（42 / 9）；
8. `eval/` 新增评测层或新增脚本；
9. §5 的「设计约束」有任何一条被修改、废除或新增；
10. §9 的架构债被修掉或新增一条（**修掉也要改**，否则文档会撒谎）。

> 维护口诀：**改了「结构」就要改这里；改了「行为」只要改代码与 devlog。**
