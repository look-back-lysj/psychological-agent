# 守岸人 · 项目结构图

> 最后更新：2026-10-10（v4.0.0）
> 用途：让新加入的人 5 分钟内搞清楚"什么东西在哪"。

---

## 一、顶层目录一览

```
psych-companion-agent-starter/
│
├── main.js                  # 入口（3 行薄转发 → src/server.js）
├── package.json             # 项目配置（v4.0.0）
├── build.js                 # 后端打包脚本（生成 dist/守岸人/）
│
├── src/                     # ★ 后端源码（29 个 .js 文件，7 层架构）
├── public/                  # ★ 前端源码（HTML/CSS/JS，零依赖）
├── src-tauri/               # ★ Tauri 2 桌面外壳（Rust + WebView2）
├── data/                    # ★ v4.0 数据资产（风格语料 + AI 味清单）
├── tests/                   # ★ 42 条自动测试用例
├── eval/                    # ★ 评测体系（红队/AB/风险探针）
├── docs/                    # ★ 文档（30+ 份）
├── devlog/                  # ★ 开发日志（day01~day17）
├── scripts/                 # ★ 工具脚本
├── dist/                    # 构建产物（不入库）
├── logs/                    # 调用记录（脱敏样例入库，真实记录不入库）
├── samples/                 # 脱敏调用样例
└── _tmp/                    # 临时目录（不入库，会被清理）
```

---

## 二、src/ 后端源码（7 层，29 个文件）

依赖方向自上而下，**无反向依赖与循环依赖**。

```
入口层
├── main.js (3 行)                    # 薄转发
├── src/server.js (222 行)            # 装配路由 + 优雅退出
└── src/index.js (15 行)              # 薄别名（兼容旧命令）

L4 对话链路层
├── src/chat/index.js (188 行)        # Express Router，对话主入口
├── src/chat/pipeline.js (482 行)     # 对话流水线（v4.0 分流点）
├── src/chat/http.js (82 行)          # 本机三层防护
├── src/chat/extractor.js (116 行)    # 记忆抽取
├── src/chat/retry.js (72 行)         # 重试逻辑
├── src/chat/image.js (39 行)         # 图片输入链路
└── src/api/routes.js (155 行)        # 管理接口（设置/记忆/日志等）

L3 流水线层
├── src/pipeline/agents.js (560 行)   # 多智能体内核（观/校/档位/策略裁决）
├── src/pipeline/prompts.js (393 行)  # v3.4 提示词组装（旧版，13 段）
├── src/pipeline/strategy-cards.js (143 行)   # ★ v4.0 策略意图卡
├── src/pipeline/style-retriever.js (312 行)  # ★ v4.0 风格检索层
├── src/pipeline/prompts-v4.js (172 行)       # ★ v4.0 新提示词组装
├── src/pipeline/output-guard.js (221 行)     # ★ v4.0 输出后检
└── src/pipeline/vision.js (67 行)    # 视觉安全筛查

L2 基础设施层
├── src/infra/config.js (259 行)      # 配置读取（.env / config.json）
├── src/infra/llm.js (410 行)         # 大模型调用（DeepSeek）
├── src/infra/memory.js (964 行)      # 长期记忆
├── src/infra/sessions.js (380 行)    # 会话管理
├── src/infra/comeback.js (331 行)    # 回访逻辑
├── src/infra/atrest.js (124 行)      # AES-256 静态加密
├── src/safety.js (1149 行)           # ★ 安全大脑（输入分级 + 输出六类拦截）
└── src/strategy.js (417 行)          # 策略路由 S0~S6

L0/L1 基础层
├── src/core/utils.js (67 行)         # 工具函数
├── src/core/paths.js (106 行)        # 路径管理
├── src/core/logger.js (53 行)        # 日志
├── src/domain/persona.js (359 行)    # 守岸人人设（语气规则 + 反例 + 示例）
└── src/domain/innerstate.js (208 行) # 内心状态模型
```

---

## 三、public/ 前端源码

```
public/
├── index.html     # 聊天界面（含首次启动向导）
├── app.js         # 前端逻辑（SSE 流式接收、多会话、主题切换、图片发送）
└── style.css      # 样式（深浅色主题、移动端适配）
```

**特点**：零框架零依赖，原生 HTML/CSS/JS，不需要构建步骤。

---

## 四、src-tauri/ 桌面外壳

```
src-tauri/
├── Cargo.toml          # Rust 依赖
├── tauri.conf.json     # Tauri 配置（v4.0.0，NSIS 安装包）
├── build.rs            # 构建脚本
├── src/                # Rust 源码（启动 sidecar + 窗口管理）
├── capabilities/       # 权限配置
├── icons/              # 应用图标
├── splash/             # 启动画面
└── binaries/           # sidecar（后端 exe，构建时复制进来）
```

**架构**：Tauri WebView2 加载 `http://127.0.0.1:PORT`，后端作为 sidecar 子进程随应用启动/退出。

---

## 五、data/ v4.0 数据资产

```
data/
├── style-corpus.json    # 60 条风格语料（24KB）
│   # 来源：persona 原生 21 + CPsyCounD 20 + MI/Ivey 官方 19
│   # 每条：{ id, scene, user_says, shorekeeper_says, style_tags, psych_technique, source }
│
├── ai-slop-list.json    # 19 条中文 AI 味禁用清单（14KB）
│   # 每条：{ id, name, description, wrong, right, severity, trigger_scene, detection_regex }
│
└── chroma_db/           # 心理学 RAG 向量库（Chroma，221 文档，不入库）
```

---

## 六、tests/ + eval/ 评测体系

```
tests/
├── cases.jsonl    # 42 条正式测试用例 + 9 条历史回归
└── run.js         # 测试运行器（node tests/run.js）

eval/
├── redteam/       # 红队攻击测试（20/20）
├── risk-probe/    # 风险判定质量探针
├── ab/            # A/B 对照框架
└── human/         # 人工评分模板
```

---

## 七、docs/ 文档地图

| 分类 | 文件 | 说明 |
| --- | --- | --- |
| **新手入门** | `docs/操作手册.md` | 从打开应用到跑评测的完整步骤 |
| **架构** | `ARCHITECTURE.md` | 7 层架构 + 数据流 + v4.0 模块说明 |
| **心理学** | `docs/psychology-basis.md` | ★ v4.0 心理学出处（929 行，答辩核心材料） |
| **人设** | `docs/persona.md` | 守岸人角色卡 + 语气规范 + 安全边界 |
| **评测** | `docs/evaluation-plan.md` / `evaluation-report.md` / `evaluation-cases.md` | 评测方案 + 报告 + 用例 |
| **安全** | `docs/red-team.md` / `security-checklist.md` | 红队结果 + 安全检查清单 |
| **竞品** | `docs/competitor-research.md` | Replika + 星野调研 |
| **试用** | `docs/trial-feedback.md` | 2 位同学试用反馈模板 |
| **计划** | `docs/两周开发计划.md` / `schedule.md` | 开发计划 + 日程 |
| **升级** | `docs/upgrade-plan-v3.md` | v3.x 升级计划 |
| **性能** | `docs/performance-optimization.md` | 性能优化记录 |
| **风险** | `docs/risk-judgement-optimization.md` | 风险判定优化 |

---

## 八、devlog/ 开发日志

```
devlog/
├── day01.md ~ day16.md   # v1.0 ~ v3.4.0 的开发日志
└── day17.md              # ★ v4.0 对话层底层重造全过程记录
```

---

## 九、scripts/ 工具脚本

```
scripts/
├── build-desktop.js           # Tauri 桌面版一键构建（含 pkg + sidecar + NSIS）
├── check-layering.js          # 依赖分层检查（防循环依赖）
├── check-frontend-sections.js # 前端分区索引检查
├── publish-release.js         # Gitee Release 发布脚本
└── rag/
    └── build_rag.py           # ★ v4.0 心理学 RAG 构建（Chroma + BGE-small-zh）
```

---

## 十、常用命令速查

```bash
# 开发
npm start                          # 启动（默认 v3.4 链路）
$env:XINYU_V4='on'; npm start     # 启动（v4.0 新链路）

# 测试
node tests/run.js                  # 42/42 + 9/9 测试

# 构建
node build.js                      # 后端打包（dist/守岸人/）
node scripts/build-desktop.js      # 桌面版一键构建（安装包 + 绿色版）

# RAG
python scripts/rag/build_rag.py    # 建心理学向量库

# 检查
node scripts/check-layering.js     # 依赖分层检查
```

---

## 十一、关键环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | （必填） | DeepSeek API Key |
| `LLM_BASE_URL` | `https://api.deepseek.com` | API 地址 |
| `LLM_MODEL` | `deepseek-flash` | 模型名 |
| `PORT` | `3000` | 服务端口 |
| `XINYU_V4` | （不设=旧链路） | `on` 启用 v4.0 新链路 |
| `XINYU_AGENTS` | （不设=多智能体） | `off` 退回单模型路径 |
| `OPEN_BROWSER` | `0` | `1` 启动时自动打开浏览器 |
| `HF_HOME` | （RAG 用） | HuggingFace 缓存目录（建议 `D:\hf-models`） |