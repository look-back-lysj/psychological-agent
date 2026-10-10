# Day 17 · 2026-10-10

## 今日主题：v4.0 对话层底层重造 —— 从"规则恐吓"到"风格引导"

### 背景

用户反馈："角色回答没有人类的感觉，角色本身很不人类，回答很人机。"

这不是调几句提示词能解决的问题，而是底层架构方向性错误。今天做了底层重造。

### 调研（3 份报告，共产出约 200KB）

| 报告 | 内容 | 关键发现 |
|---|---|---|
| 学术方案深潜（98KB） | PsyDT / PsyChat / CPsyCoun / EmoLLM / Poppet 五大方案的论文+代码+提示词全文 | ① PsyDT：人格应下沉到数据而非 prompt（system prompt 被注释掉了）② Poppet：AI 味是可枚举的模式，但中文形态必须自建清单 |
| 心理学权威资料（704 行） | MI 官方术语表（Miller & Rollnick 第 3 版）+ Ivey 教材预览 + WHO 自杀干预 | ① "roll with resistance" 是已废弃术语 ② 双侧反映示例不符合 MI 定义 ③ Summarizing 技术缺失 |
| 现状实证诊断（34KB） | system prompt 约束密度实测 + 文献对照 + 架构数据流 | ① 213 条原子约束（学术基准上限的 21 倍）② 4 组硬互斥规则 ③ 规则:语料=8.7:1 ④「校」的 AI 腔防线失效（触发率仅 5%） |

### 重造内容

**止血**（commit d5846df）：
- 删掉 buildPlanBlock() 的形态 KPI（emotion=happy/强度=3/180字 的填表作业）
- 修复 4 组硬互斥规则（省略号配额矛盾 /「我在」矛盾 / 最多至少推进 / 重复条款）
- 修正心理学出处（roll with resistance → coming alongside；双侧反映示例）

**数据资产**（2 个 JSON，交叉验证全通过）：
- `data/style-corpus.json`：60 条风格语料（persona 原生 21 + CPsyCounD 20 + MI/Ivey 官方 19），每条标注心理学技术
- `data/ai-slop-list.json`：19 条中文 AI 味禁用清单（WRONG/RIGHT 对照 + 检测正则）

**v4.0 核心模块**（commit 5ca6a1d，4 个新文件）：
- `strategy-cards.js`：S0~S6 策略意图卡（含心理学出处 MI-G/EX3.6/Ivey）
- `style-retriever.js`：规则检索风格示例+AI味提醒（0.14ms，0次LLM调用）
- `prompts-v4.js`：单段式提示词组装（≈700token vs 旧版≈2500token，-77%）
- `output-guard.js`：安全拦截+AI味本地快检（替代失效的「校」，100%覆盖）

**心理学 RAG**（commit 10b880b）：
- Chroma + BGE-small-zh，221 文档索引（风格语料 + MI 术语 + 调研报告）
- 用途：构建时校验 + 答辩演示，不影响运行时延迟

**心理学出处文档**（commit b62d6f8，930 行）：
- `docs/psychology-basis.md`：16 个技术详解 + 7 策略详解 + 10 条术语修正 + 60 条语料对照

### 验证

- tests/run.js：42/42 + 历史回归 9/9，新旧两条路径（默认 + XINYU_V4=on）都通过
- 数据资产交叉验证：18/18 正则通过、6/6 策略覆盖、0 误伤
- 心理学出处文档：60/60 语料 verbatim 命中、0 幻觉

### 关键数据对比

| 维度 | v3.4 旧架构 | v4.0 新架构 |
|---|---|---|
| LLM 调用 | 2~3 次 | 1 次 |
| prompt 长度 | ≈2,500 token | ≈700 token（-77%） |
| 原子约束 | 213 条（4 组互斥） | ≈30 条 |
| 规则:语料 | 8.7:1 | ≈1:1 |
| AI 味防线 | 「校」触发率 5% | OutputGuard 100% 覆盖 |
| 心理学出处 | 1 处（有误） | 7 条权威出处 |

### 未完成

- A/B 对比验证（需要 DeepSeek API Key 跑真实对话，按 Poppet 清单 + PsyDT 四维打分）
- 2 位同学试用（考核硬性要求）
- 真实 API 调用记录

### 参考文献

- arXiv:2509.21051 — ManyIFEval：指令数增加 → 性能持续退化（213 条 = 基准上限的 21 倍）
- arXiv:2609.03156 — 复合约束超加性退化（解释 4 组互斥）
- arXiv:2412.13660 — PsyDT：人格下沉到数据（ACL 2025）
- arXiv:2312.04262 — PsyChat：来访者中心对话系统
- arXiv:2405.16433 — CPsyCoun：中文心理咨询多轮对话数据集（ACL 2024）
- Miller & Rollnick《Motivational Interviewing》第 3 版官方术语表（2013）
- SAMHSA TIP 35 EXHIBIT 3.6 — 反映类型官方示例表
- Ivey《Intentional Interviewing and Counseling》第 10 版 — 微技能金字塔 + 五阶段