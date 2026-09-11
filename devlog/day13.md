# day13 · 批次 C：界面与无障碍规范化，发布 v3.2.0

> 日期：2026-09-11
> 执行方式：2 路并行子 agent（按 CSS / JS 文件边界切分）+ 主 agent 统一收尾
> 版本：3.1.0 → **3.2.0**

---

## 一、做了什么

### 动效（依据 m3.material.io 官方 token 与 nn/g 一手结论）

- 时长收拢为 **5 档**：`--dur-fast:100` / `--dur:150` / `--dur-mid:200` / `--dur-slow:250` / `--dur-enter:300`；
- 曲线统一为 **M3 Standard 三条**：`cubic-bezier(0.2,0,0,1)` / `(0,0,0,1)` / `(0.3,0,1,1)`；
  ⚠️ **M3 的 Emphasized 在 Web/CSS 上官方标注为 "N/A (Use Standard as a fallback)"**，所以不采用；
- **入场比退场长**（抽屉/弹窗：入场 300ms、退场 200ms）；
- 消息入场 180ms + `calc(var(--i) * 40ms)` 阶梯。

### 排版

- **正文最大行宽 640px** —— 依据 **WCAG 2.2 SC 1.4.8**「CJK 为 40 字形」。这是整套界面里**唯一有正式规范支撑**的数值（M3 / Fluent 2 / Apple HIG **都没有聊天组件规范**，所以气泡圆角、内边距那些是我们自己定的，不能说是「官方规定」）。
- 正文 `line-height: 1.6`、标题 `1.35` —— 依据 **W3C clreq**「行间距为字身高度的 50%—100%」。
- **字体栈修正**：`PingFang SC`（苹方）**在 Windows 上不存在**，改为 `Microsoft YaHei UI` 优先、苹方末尾兜底。

### 无障碍（WCAG 2.2 逐条）

| 条款 | 做法 |
| --- | --- |
| 4.1.3 状态消息 | 消息区改 **`role="log"`**（W3C 官方对该 role 的示例就写着 chat logs）+ `aria-live="polite"` + `aria-relevant="additions text"` + `aria-label` |
| — | **流式期间 `aria-busy="true"`，结束后 `false`** → 读屏不再逐字刷屏，而是等回复完整后一次播报 |
| 2.4.7 焦点可见 | `:focus-visible` 统一 2px 描边 + `border-radius: inherit` |
| 2.5.8 目标尺寸 | 图标按钮 **≥24×24px**（实际 32—40px，用 padding 扩张、不改图标尺寸） |

- **不用** `aria-atomic="true"`（会逐字全量重播）、**不用** `assertive`（会打断播报队列）；
- `prefers-reduced-motion` 关闭块 **5 处 → 1 处**，并补上原先漏掉的两个无限脉冲动画。

### 交互

- **上滚不再被强行拉到底**：`IntersectionObserver` 观察底部锚点，阈值兜底 56px；跟随用**瞬时定位**（smooth 会在每个 token 上互相打断）。
- **等待期把停顿框成「思考」**：首字前显示「我在听」。
  依据：nng 的 0.1s/1.0s/10s 极限；以及 **CHI'26（240 人）的反直觉发现**——首字延迟 **2 秒**被认为「更不深思熟虑」，而 9s/20s 反被解读为「AI 正在思考」。**对她「慢、留白」的人设，机械秒回反而伤拟人感。**
- 数字改 `tabular-nums`，流式时不再跳动。

---

## 二、两处「按字面做反而错」的实测修正

| 项 | 问题 | 处理 |
| --- | --- | --- |
| C12 `content-visibility: auto` | 给 `.msg` 加它会带来 paint containment，**裁掉用户气泡阴影与头像光晕**（同一像素 `rgb(221,229,244)` → `rgb(236,239,244)`，两张 1100×760 截图差 **32975 px**） | **不采用**，改用 `.chat { contain: content }`（像素差 0） |
| C8 `min-block-size: 1.6em` | 全局 `border-box` 下被 11px×2 padding 吃掉（实测空气泡仍 24px） | 补 `.msg--typing` 规则，现在「三个点」气泡与一行正文**都是 48px**，首字到达零跳动 |

> 这两条都是**子 agent 实测发现并如实报告的**，没有为了「按指令完成」而假装生效。

---

## 三、子 agent 主动提出的问题（都是对的）

1. **删掉了一段旧的「请求前固定 sleep 500—1200ms」人为延迟** —— 与「不加入为延迟、让信号锚定真实模型延迟」的决策直接冲突。同意删除。
2. **补了一条我们漏掉的 `.is-tauri-native` 规则** —— `app.js` 已经 `add('is-tauri-native')` 后 return（放弃自绘标题栏），但 CSS 里一条对应规则都没有，Tauri 下会出现**双标题栏 + 38px 空白**。
3. CSS 侧指出 JS 的 `animationDelay = step*70+'ms'`（内联样式）会**盖掉** CSS 的 40ms 阶梯 —— 由主 agent 改为 `setProperty('--i', step)`。

---

## 四、顺带修的一个计数错误

`/api/comeback` 会被前端在同一会话内重复调用（有 5 秒缓存，超时会再拉），导致 `visitCount` **一次启动就涨到 3**。
改为：只有「距上次见到超过 `VISIT_GAP_MS`（30 分钟）」才算新的一次来访。
实测：同一会话连续 3 次调用 → `visitCount` 保持 1；隔 31 分钟再来 → 变 2、`hoursSince=0.5`。

---

## 五、验证（全部真实执行）

### 真实浏览器（无头 Edge + CDP）—— **14 / 14 通过**

```
PASS  role=log 已设置
PASS  aria-live=polite
PASS  aria-relevant="additions text"
PASS  aria-label 存在（role=log 必需）
PASS  未设置 aria-atomic
PASS  动效令牌全部可读
      --dur-fast=100ms  --dur=150ms  --dur-mid=200ms  --dur-slow=250ms  --dur-enter=300ms
      --ease=cubic-bezier(0.2, 0, 0, 1)  --ease-out=cubic-bezier(0, 0, 0, 1)  --ease-in=cubic-bezier(0.3, 0, 1, 1)
PASS  body 字体栈以 Windows 字体优先
PASS  消息正文最大行宽 640px（WCAG 1.4.8 CJK 40 字形）
PASS  prefers-reduced-motion: reduce 块已合并为 1 处（no-preference 保留 1 处）
PASS  可见的图标按钮触控目标均 ≥24×24（WCAG 2.5.8）
PASS  1100px 无横向溢出
PASS  ≤860px 侧栏转为 fixed 抽屉
PASS  ≤860px 无横向溢出
PASS  无 JS 运行时/控制台错误
```

### 其他

- 回归 **42/42 + 9/9**；CSS 花括号 650/650 平衡；`<button>` 标签 36/36 配平；
- 构建产物实测：端口固定 34117、仅 `127.0.0.1`、`shouan-v3`、记忆默认关闭、页面含 `role="log"`；
- 本地 zip 与远端下载**逐字节一致**（24670724 字节）。

### 调试过程里踩到的坑（记下来避免重犯）

1. **CDP 选错目标**：Edge 首启会开一个 `edge://sync-confirmation-dialog/` 页面，取「第一个 page」会连错靶，导致**所有断言都返回 null**。已改为**按 URL 匹配** `127.0.0.1:`。
2. **`document.styleSheets[0].cssRules` 在 headless 下抛 SecurityError**，导致样式断言恒为 0。已改为在页面里 `fetch('/style.css')` 后在 Node 侧匹配。
3. **heredoc 会吞反斜杠**：写进文件的正则从 `\s*` 变成 `s*`，断言一直失败。已改用**不含反斜杠的 `split` 计数**。

---

## 六、发布

**https://gitee.com/flowing-shadows-like-scenes/psychological-agent/releases/tag/v3.2.0**

| 附件 | 大小 |
| --- | --- |
| `shouanren-3.2.0-x64-setup.exe` | 17.04 MB |
| `shouanren-3.2.0-win-x64-portable.zip` | 23.53 MB |

- README 与操作手册的下载入口、截图引用已同步（向导已从 3 步变 4 步，旧的向导截图已作废重拍并新增「记忆同意」步骤截图）；
- 截图存于 `docs/screenshots/`（ui-01…ui-08，含首页/对话/高风险分支/深色/向导×3/移动端）；
- 旧版 v2.0.0 / v2.1.0 保持 **prerelease + 显著警告**；
- 令牌仅作为单条命令的环境变量传入，**未写入任何文件、未进入 git 历史**。

---

## 七、批次总览

| 批次 | 状态 |
| --- | --- |
| A（15 项 P0：端口/身份/死代码/记忆 bug/凭证） | ✅ |
| B（人格、开口引导、记忆 v3、隐私合规） | ✅ |
| C（界面、动效、无障碍） | ✅ |
| **D（红队 / A/B / 同学试用 / 评测报告）** | ⏳ **必须填入真实 DeepSeek API Key 才能跑** |

> 批次 D 是《验收清单》里唯一还空着的「证据」部分。它没有办法用代码完成，也不会用模拟数据充数。
