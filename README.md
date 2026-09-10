# 心屿 · 大学生情绪陪伴智能体

面向大学生日常学习压力、情绪低落和表达困难场景的非诊疗情绪陪伴原型。

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
