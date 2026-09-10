# 提交前检查清单

## 功能与运行

- [x] README 能完整说明项目是什么、怎么启动；
- [x] 页面能输入消息；
- [x] 后端能正常启动；
- [x] 普通输入可返回策略标签；
- [x] 高风险输入进入安全分支；
- [x] 诊断请求不返回疾病结论；
- [x] 模型未配置或失败时有友好兜底；
- [x] `npm test` 通过（9/9）；
- [x] `npm run bundle` 可生成发布目录；`npm run build` 可生成 exe。

## 安全与仓库卫生

- [x] `.env` 未提交（仓库内不存在 `.env`）；
- [x] `.gitignore` 已排除敏感文件（`.env`、`logs/`、`*.pem`、`*.key` 等）；
- [x] 构建产物（`dist/`、`*.zip`、`*.exe`）未提交；
- [x] 全仓库扫描无明文密钥（`git grep` 无 token/私钥命中）；
- [x] 调用记录为脱敏样例（`samples/calls.sample.jsonl`）；
- [x] 提交前执行过 `git status`、`git diff --cached`、`git grep`。

## 真实性与材料

- [ ] 已接入真实实验室 API 并生成真实调用记录；
- [ ] 已完成两位同学试用并回收结构化反馈；
- [x] 评测报告与试用模板齐全（`docs/evaluation-report.md`、`docs/trial-feedback.md`）。
