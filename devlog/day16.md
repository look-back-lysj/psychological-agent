# day16 · 图片能力接入 + 输出侧与接口加固 + 交付证据采集

> 本轮由单个 agent 串行完成（文件边界见 §一 的清单），验证全部真实执行，未跑的项在 §六 如实列出。

---

## 一、本轮做了什么（8 项，按依赖顺序）

| # | 事项 | 涉及文件 |
| --- | --- | --- |
| 1 | **输出侧安全兜底补四类** + 修复 `hasMethodAdvice` 死循环 | `src/safety.js` |
| 2 | **数据目录与配置权限收紧**（Windows ACL / POSIX） | `src/core/paths.js`、`src/infra/config.js` |
| 3 | **本机接口三层防护**：Host 白名单 + Origin/Referer 校验 + 启动随机令牌 | `src/server.js`、`public/app.js` |
| 4 | **会话与记忆静态加密**（AES-256-GCM + `data/.key`） | 新增 `src/infra/atrest.js`、`src/infra/sessions.js`、`src/infra/memory.js` |
| 5 | **图片 ↔ 危机分级**：含图不低于 L1、视觉信号只升不降 | `src/safety.js`、`src/chat/pipeline.js` |
| 6 | **图片输入全链路**：接口校验 / 多模态 payload / 视觉筛查 / 不落盘 / 前端入口 | 新增 `src/chat/image.js`、`src/pipeline/vision.js`；`src/infra/llm.js`、`src/infra/sessions.js`、`src/chat/*`、`public/*` |
| 7 | **评测脚本鉴权适配**（只补令牌，不动判定） | `eval/redteam/run-redteam.js`、`eval/ab/run-ab.js` |
| 8 | **交付证据采集**（真实调用记录 / 成本台账 / 红队 / A/B） | `logs/usage_summary.md`、`logs/calls.sample.jsonl`、`logs/redteam-2026-09-14.log`、`CHANGELOG.md` |

设计要点：
- **图片与危机分级是「单向保守」**——图片内容规则层判不了、视觉模型不可信，所以只能升级、永不降级；
  含图轮保底 L1（情绪分下限抬到 3），`selfHarmVisible` 直接进 L3 危机协议并附固定话术。
- **图片一律不持久化**：服务端 `addTurn` 防御性剥离，前端 `saveState/sanitizeMessage` 只留 `hasImage` 布尔标记。
- **含图轮单独抬 `max_tokens`**：实测视觉任务思考 token 占 151—463，沿用默认 512 会得到空回复（`empty_output` 兜底）。

---

## 二、验证（全部真实执行）

| 验证项 | 结果 |
| --- | --- |
| `npm test` | **42/42 + 9/9**，退出码 0 |
| `node scripts/check-layering.js` | ✅ 无反向依赖 / 无循环依赖 |
| `node scripts/check-frontend-sections.js` | ✅ **197/197**（新增 4 个函数均已归属分区） |
| 仓库自带输出侧扫描（9 条历史 bad_output） | 拦截数 **2/9 → 8/9**（未拦的 s6「你去做一个大计划」属有意保留） |
| 离线探针：图片 ↔ 危机分级 | **10/10**（含 42 条用例逐字段向后兼容比对，差异 0） |
| 离线探针：图片后端链路（mock 模型端到端） | **11/11**（含"自伤信号 → L3 + CRISIS_REPLY 且**不调主模型**"） |
| 真浏览器端到端（CDP 驱动 Edge） | **10/10**（粘贴 → 预览 → 发送 → 气泡含图 → 刷新后显示「含图片（未保存）」且图片不入 localStorage） |
| **真实模型**：视觉筛查回归（3 张真实截图） | **6/6**：全部保持 **L1 未误升级**；单轮 3.4—4.0 s |
| **真实模型**：L4 红队 20 条 / 29 轮 | **20/20**：红线字面命中 **0%**、规则句式硬命中 **0**、危机识别 **7/7 = 100%** |
| **真实模型**：A/B 对照 20 条 × 2 组 / 40 轮 | A 2,636.6 ms / B 1,551.3 ms（**+70%**）、首字 2,155.4 / 1,071.6 ms（**+101%**）、客观指标无差异 |
| **实测 token（仓库首次）** | 干净对话 6 轮 = prompt **20,273** + completion **284** = **20,557**；缓存命中 896/轮 |

---

## 三、本轮自己踩的 4 个坑（诚实记录，附修法）

1. **`hasMethodAdvice` 死循环（最严重）**：方法正则漏加 `g` 标志 → `exec` 循环里 `lastIndex` 不前进 →
   命中「被否定保护跳过」的文本时无限空转，**进程挂死**（表现是工具调用超时、输出截断）。
   修法：三重防呆 —— `g` 标志 + 零长度匹配强制推进 + 硬上限 100 次；教训写进代码注释。
   **静态阅读看不出来，只有真跑才会暴露。**
2. **探针没设 `XINYU_DATA_DIR`** → `atrest` 在仓库 `data/` 里误建了一个 `.key`。
   已删除（`data/` 恢复为空；该文件被 `.gitignore` 覆盖、不含用户数据、从未提交）。
   副产品：这次失败**验证了一个设计** —— 解密失败先留档 `*.unreadable-<时间戳>` 再抛错，**没有静默丢数据**。
3. **当日运行期日志被 mock 跑污染**：mock 返回假 `usage`，混进 `logs/calls-2026-09-14.jsonl`。
   处理：把污染的日志挪到 `_tmp/` 留档，**重跑一轮干净的真实对话**再作为样例，避免样例带假数据。
4. **探针自身的断言错误**（4 处）：mock 的 `captured` 在内存累积未被真正重置 / 复用同一 `sessionId`
   导致文本轮继承了图片轮的 L3 历史 / 用明文 `JSON.parse` 去读加密文件 / 补丁把 `\n` 转义吃掉。
   **都属"测试写错"而非产品缺陷**，逐个定位后修正；期间没有改动任何产品逻辑去迁就测试。

---

## 四、交付证据（S1 的五项）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实调用记录 | ✅ | 干净对话 6 轮 → `logs/calls-2026-09-14.jsonl`；`logs/calls.sample.jsonl` 用 6 条真实成功调用替换（原为 2 条 `error` 占位） |
| 成本台账 | ✅ | `logs/usage_summary.md` 重写，**首次记录实测 token**；红队/A-B 未采集 usage → 只给「估算」并标注依据 |
| 红队 | ✅ | 20/20，报告留档 `logs/redteam-2026-09-14.log` |
| A/B 对照 | ✅ | 40 轮；metrics/blind/key 从 `_tmp/` 复制到 `logs/`（上一次的产物就被 `_tmp/` 清理器删掉了） |
| 人工评分（L2）与同学试用（L3） | ⏳ **未做** | 评分表已由 `eval/ab/score.js --format md` 生成；真人试用需 2 位同学 |

---

## 五、可复现的验证命令

```bash
node --check <改动的文件>          # 语法
npm test                          # L1：42 正式 + 9 历史回归
node scripts/check-layering.js     # 分层机检
node scripts/check-frontend-sections.js  # 前端分区机检
node eval/redteam/run-redteam.js   # L4 红队（需 LLM_API_KEY，产物 _tmp/redteam-report.json）
node eval/ab/run-ab.js             # A/B 对照（需 LLM_API_KEY，产物 _tmp/ab-output/）
```

---

## 六、未完成与局限（如实，不许删）

1. **L2 人工盲评与 L3 同学试用未做** —— 本日不含真人体验结论；「像不像真人」必须等盲评。
2. **红队与 A/B 不采集 token**（架构债 #8）：仓库仍**没有**这两项的实测 token 数，台账里的估算不得当实测引用。
3. **视觉筛查准确率未评估**：只证明了链路正确与「3 张正常截图未被误升级」，**不能推断真实模型下的漏判率**；
   按设计漏判由「含图 → L1」地板兜底，误判只是更保守。
4. **前端外观未人工目测**（助手看不了图）：已做 CDP 行为审计与布局审计（横向溢出 0），
   但 Edge headless 的 `--window-size` 未生效（两次视口均为 500px），**真机窄屏未覆盖**。
5. **A/B 两轮结论一致**（+56% / +70% 延迟、无客观收益），但产品侧仍保留多智能体（DR-001）——
   该决策建议补充说明，或改为「低风险走 minimal 档、高风险才开 agent」。
6. 本日新增的加密、接口令牌、图片能力**改变了本机数据格式与请求形状**：
   回滚开关分别是 `XINYU_ENCRYPT_DATA=0`、`XINYU_IMAGE_SCREEN=off`；
   `data/.key` 丢失会导致历史数据不可解（会留档不删除）。
