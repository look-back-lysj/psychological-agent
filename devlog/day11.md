# day11 · 批次 A 执行：修「灵魂」（记忆连续性 + 身份 + 死代码清理）

> 日期：2026-09-11
> 本轮目标：执行升级计划的批次 A，共 15 项 P0 修复。**不动 UI 外观**，只修「为什么她不像她、为什么她记不住你」。

## 一、执行方式：5 路并行（团队模式）

按**文件不重叠**切分，5 个子 agent 并行开工，最后由我统一验证与接线：

| 工作流 | 负责范围 |
| --- | --- |
| W1 | Rust 端口修复 + 安装标识符 + 移除原生依赖 |
| W2 | 后端身份修正 + 演示模式死代码清理 + 重试加固 |
| W3 | 前端身份修正 + 演示模式死代码清理 + 诚实告知文案 |
| W4 | 记忆模块两个 bug 修复 |
| W5 | 会话转写持久化到后端 |

## 二、修了什么（对照计划批次 A）

### 🔴 最致命：随机端口 → 每次启动失忆

`src-tauri/src/lib.rs` 的 `pick_port()` 原本 `bind("127.0.0.1:0")` **让系统随机分配端口**，而前端把对话记录存在 `localStorage` 里——**localStorage 按 origin（协议+主机+端口）隔离，端口一换就等于换了一个网站，记录全部清零**。

**改为**：从 **34117** 起依次尝试（最多 20 个），绑定成功即 `drop()` 释放交给后端；全失败才回退随机。

### 🔴 模型被告诉它叫「心屿」

4 处**进入模型上下文**的位置全部改为「守岸人」：
- `src/agents.js`（「观」读到的历史 + `CRITIC_SYSTEM`）
- `src/chat.js`（记忆抽取 agent 读到的历史）
- `src/routes.js`（兜底欢迎语）

> 修完 `grep -rn "心屿：" src/` = **0**。这是「她不像守岸人」的直接技术原因。

### 🔴 界面上 5 处用户可见的「屿」

英雄区徽标、向导标记、**每条 AI 消息的头像**、读屏文案、记忆空态文案 → 全部改为「守」。

### 🔴 演示模式会「复活」

`src/routes.js` 仍在返回 `demoAvailable: true`，前端收到就会把演示入口显示出来。**已删除注入 + 前端响应分支 + `#demo-entry` 按钮**。相关死代码（`src/demo.js` 175 行 + 前端 5 个函数 + 4 个变量 + CSS 整块）全部清除。

> 另修一处残留：`#model-warn` 的 `title` 原写「当前为演示模式：回复由本地脚本生成」，与产品决策矛盾。

### 🔴 记忆模块两个逻辑错误

1. **接替链断了**：`supersededBy = 'new'`（字面量字符串）→ 改为**真正的新条目 id**，并新增 `supersedes[]` 双向可回溯；
2. **淘汰误杀重要记忆**：`slice(-MAX_ITEMS)` 按插入序丢最旧 → 改为按优先级「**失效 → 休眠 → 久未命中 → 低重要性 → 最早创建**」，`pinned` 全豁免；
3. **顺手修**：`tombstones` 的 `slice(-200)` 会让用户早期的「忘掉 X」失效 → 改为**不截断**（永久生效）+ 去重合并。

> agent 诚实报告了一点：用户原以为「我大二了→我大三了」会触发接替，实测相似度只有 0.2、不落在触发区间——**这是相似度规则的覆盖范围问题，与本次 bug 无关**。它改用真正会触发的用例验证。

### 🟠 会话转写持久化（新增能力）

新增 `data/sessions.json`：按会话 id 分组，保存 `turns` / `state` / `innerState` / `riskHistory` / `pendingTurns` / `summary`。
- **800ms 防抖**合并写入 + `.tmp → rename` 原子替换；
- 启动时读回，**非法 JSON / 字段类型错都静默降级**（逐字段防御式规整）；
- 容量：单会话 200 条转写、500 个会话、6 小时 TTL；
- 权限 `0o600`，文件头注明「仅存本机」。

### 🟠 重试策略对齐官方 SDK

- 可重试状态码 `[429,500,503]` → **408 / 409 / 429 / 所有 ≥500**；
- 退避**封顶 8s**；新增 **`Retry-After` 处理**（>120s 直接放弃）。

### 🟠 其他

| 项 | 改动 |
| --- | --- |
| 连通性自检 | 改走 `GET /models`（**零 token 成本**），404/网络错误才回退 chat 探测 |
| 安装标识符 | `com.xinyu.companion` → `com.shouanren.companion`（趁无真实用户，零成本） |
| 原生依赖 | 移除未使用的 `better-sqlite3`（原生模块会让 pkg 打包失败）；`package-lock.json` 已同步，`node_modules` 已 prune |
| 诚实告知 | 向导第 1 步补充数据流向：记忆只存本机 / 但对话仍会经你的 Key 发给 DeepSeek / 可随时删除 |
| SSE | 确认 `res.flushHeaders()` 已存在，补注释说明原因 |

## 三、我（主 agent）补做的接线

子 agent 按约束没碰跨文件的部分，我统一接上：

1. `src/routes.js` 新增 `sessionsRouter`（`DELETE /api/sessions`，清空转写——**只清前端 localStorage 是不够的**）；
2. `main.js` 注册 `/api/sessions`；新增 **SIGINT/SIGTERM 优雅退出时 `sessions.flush()`**（防抖窗口内的最后一轮不能丢）；
3. 修正启动横幅：`守岸人`三字使盒子顶歪 → 改为按**显示宽度**计算内边距，三行均为 38 列；
4. 清理 7 个文件残留的 `心屿 · xxx` 头部注释；
5. 修正评测脚本 / `package.json` / `tests/` / `src-tauri/` 等**用户可见**的「心屿」（共 31 处），并把两个盒子横幅按显示宽度重新对齐。

## 四、验证（全部真实执行）

| 检查 | 结果 |
| --- | --- |
| `node --check`（main/src/tests/eval/scripts 全部 JS） | 全通过 |
| `node tests/run.js` | **30/30 + 9/9 通过**，P95 无回归 |
| JSON 合法性（package / tauri.conf / capabilities） | 全部合法 |
| 端点冒烟 | `/api/health` `/api/config` `/api/memory` `/api/comeback` 均 200 |
| `/api/demo` | **404**（演示模式确认移除） |
| `DELETE /api/sessions` | `{"ok":true,"data":{"cleared":true}}` |
| 未配置 Key 对话 | 返回友好中文提示「还没有配置 API Key，请在「设置」里填写 DeepSeek API Key。」**不白屏、不崩溃** |
| 持久化往返 | `sessions.json` 正确生成（含 state/innerState/pendingTurns） |
| 真实 `data/` | **未被测试污染**（测试全程用 `XINYU_DATA_DIR` 指向 `_tmp/`） |
| 残留扫描 | `src/` `public/` 的 `demo` = 0；`public/` 的 `屿` = 0；模型上下文里的「心屿」 = 0 |

## 五、诚实记录：本轮遇到的问题

| 问题 | 处理 |
| --- | --- |
| 子 agent 因文件约束无法清零全部「心屿」 | 它**如实报告**而不是越权修改；由我补做 |
| `pruneSessions()` 原实现会让会话数瞬态到 501 | 子 agent 在测试中**发现并修复**（新建后若超上限再 prune 一次） |
| 「我大二了→我大三了」不触发接替分支 | 子 agent **没有假装通过**，明确说明这是相似度覆盖问题，换用例验证真实代码路径 |
| 5 路并行改同一仓库 | 按文件边界切分；但 `dist/` 里仍有**旧构建产物**含 `demo.js`，下次打包前必须重新构建 |

## 六、仍未做（不属批次 A）

- **批次 B**：人格与开口引导（MI 四陷阱、阶梯补判定信号、示例改随机抽样、规则前置）
- **批次 C**：UI/动效/无障碍（role=log + aria-busy、行长 640px、字体栈修正、动效收拢）
- **批次 D**：证据采集（**必须你填真实 Key**）
- **桌面端重新构建与打包**（Rust 改动需重新编译才生效）

> ⚠️ 本轮改的 `src-tauri/src/lib.rs` **需要重新构建桌面版才能生效**。在重新打包之前，装的还是旧端口逻辑。

## 七、本轮改动文件

`src/`：agents.js、chat.js、routes.js、llm.js、persona.js、comeback.js、memory.js、sessions.js、innerstate.js、paths.js、prompts.js、safety.js、strategy.js（后 7 个仅注释）；**删除** demo.js
`public/`：index.html、app.js、style.css
`src-tauri/`：src/lib.rs、tauri.conf.json、gen/schemas/capabilities.json
根目录：main.js、package.json、package-lock.json
`tests/run.js`、`eval/**`、`scripts/build-desktop.js`（用户可见文案改名）
