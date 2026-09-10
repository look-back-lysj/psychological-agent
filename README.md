# 心屿 · 大学生情绪陪伴智能体

面向大学生日常学习压力、情绪低落和表达困难场景的非诊疗情绪陪伴原型。

## 界面预览

| 首页 | 对话（流式回复 + 策略 / 风险标签） |
| --- | --- |
| ![首页](docs/screenshots/ui-01-home.png) | ![对话](docs/screenshots/ui-02-chat.png) |

| 高风险 → 安全优先分支 | 深色模式 |
| --- | --- |
| ![安全优先](docs/screenshots/ui-03-safety.png) | ![深色模式](docs/screenshots/ui-04-dark.png) |

移动端自适应：

<img src="docs/screenshots/ui-05-mobile.png" alt="移动端" width="300" />

> 截图均为打包后程序的实际运行效果（对接本地 mock 模型）。未配置模型密钥时，普通对话会返回兜底回复。

## 功能特性

- **先判断沟通策略**：低压力陪伴 / 共情 / 温和澄清 / 一起想办法 / 安全优先；每条回答下方显示本次策略与风险等级。
- **安全优先分支**：识别到明确安全风险时暂停普通陪伴，给出联系现实支持的引导。
- **流式回复**：逐字输出（SSE）；服务端**先做输出安全检查再下发**，并保留尾部缓冲，避免越界内容闪现。
- **多会话管理**：会话列表、自动命名、删除、本地持久化（仅存于浏览器）。
- **安全 Markdown**：粗体 / 列表 / 代码 / 引用 / 链接（仅 http/https），全程 HTML 转义。
- **细节体验**：深 / 浅色主题、移动端自适应、输入框自动增高、Enter 发送、复制 / 重试、回到最新、免责声明弹窗。
- **优雅降级**：流式失败自动回退到普通接口；模型未配置时返回友好兜底而不是报错。

## 快速开始

1. 保证已安装 Node.js（建议 18+）。
2. 复制配置并填入真实密钥（不要提交真实密钥）：
   ```bash
   cp .env.example .env
   ```
3. 安装依赖：
   ```bash
   npm install
   ```
4. 启动：
   ```bash
   npm start
   ```
5. 打开：http://localhost:3000

> 服务入口是根目录的 `main.js`（会自动加载 `.env`、启动 Express，并在本机自动打开浏览器）。
> `src/index.js` 为兼容入口，等价于 `node main.js`。
> 在服务器或测试环境可设置 `NO_BROWSER=1` 禁止自动打开浏览器。

## 目录结构

```text
main.js          服务入口
src/             核心模块（chat / safety / strategy / prompts / llm / sessions / logger / utils）
public/          前端页面
tests/           自动化测试（9 条策略与安全用例）
samples/         脱敏后的调用记录样例
docs/            设计、评测、竞品调研、日程与试用模板
devlog/          开发日志
```

## 打包与分发

```bash
# 生成发布目录 dist/心屿/（内置离线生产依赖）
npm run bundle

# 生成免安装 exe（Windows，无需本机安装 Node.js）
npm run build
```

发布方式二选一：

1. 解压 `心屿.zip`，双击 `启动心屿.bat`（需本机已装 Node.js；依赖已内置，可离线运行）；
2. 直接运行 `dist/心屿/心屿.exe`（免安装 Node.js）。

> 构建产物 `dist/`、`心屿.zip`、`*.exe` 已由 `.gitignore` 排除，请勿提交到仓库。

## 这个项目解决什么问题

不是做一个普通聊天壳，而是做一个**会先判断沟通策略**的对话系统。

核心顺序：

```text
输入 → 风险检查 → 选择沟通策略 → 拼提示词 → 调用模型 → 输出检查 → 返回页面
```

## 比赛要求对应关系

| 比赛要求 | 本项目对应内容 |
| --- | --- |
| 基于大模型 API 搭建智能体 | 可运行聊天原型 |
| 角色、语气与边界 | 角色提示词与安全规则 |
| 心理沟通策略选择机制 | 策略选择器 |
| 调研同类智能体 | docs 竞品调研文档 |
| 调通 API 并完成场景测试 | 测试脚本与评测记录 |
| 请两位同学试用 | 试用反馈文档 |
| 提交 GitHub 仓库 | README、文档、日志 |

## 接口约定

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务状态与当前模型名 |
| POST | `/api/chat` | 非流式聊天，返回 `{ ok, data: { reply, strategy, riskLevel, sessionId } }` |
| POST | `/api/chat/stream` | 流式聊天（SSE），请求体同为 `{ message, sessionId }` |

`/api/chat/stream` 事件序列：

```text
event: meta     data: { sessionId, requestId, strategy, riskLevel }
event: delta    data: { text }                    # 增量文本，可出现多次
event: replace  data: { reply, blocked, reason }  # 输出被安全拦截时整体替换
event: error    data: { message }                 # 模型未配置或调用失败
event: done     data: { reply, strategy, riskLevel, sessionId, blocked }
```

> 服务端在输出前完成安全检查（并保留尾部缓冲），命中越界内容时改发 `replace` 兜底文案。

## 环境变量

只允许放在本地 `.env`，不提交到仓库。

```text
LLM_BASE_URL=你的API基础地址
LLM_MODEL=你的模型名称
LLM_API_KEY=your_api_key_here
PORT=3000
LOG_SALT=请用随机长字符串填写
NO_BROWSER=0
```

> `.env` 只放本地，`git` 不会跟踪；`.env.example` 是不含任何真实凭据的模板。

## 重要提示

- 本项目不是心理诊断工具；
- 不应作为心理危机唯一支持来源；
- 真正的高风险情况应引导联系现实中的专业支持与可信任人。

## 许可

仅供学习与课程作品使用。
