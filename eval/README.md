# eval/ · 心屿评测与实验

本目录放可复现的评测脚本，不包含业务代码，也不修改 `src/`、`public/`、`tests/`。

| 目录/文件 | 说明 |
| --- | --- |
| `ab/README.md` | A/B 对照实验协议：研究问题、控制变量、样本局限、执行步骤、揭盲与回退预案 |
| `ab/cases.jsonl` | 20 条盲评用例（学习压力 / 表达受阻 / 人际困扰 / 安全边界，各 5 条） |
| `ab/run-ab.js` | 自动拉起 A/B 两个后端实例，逐轮采集回复，产出盲评材料与客观指标 |
| `ab/score.js` | 生成 1—5 分盲评打分表（md/csv），回填后自动揭盲并做配对 t / Wilcoxon 检验 |

快速开始：

```bash
# 真实采集（需要 LLM_API_KEY 等环境变量）
node eval/ab/run-ab.js

# 零成本自测（先手动启动 node _tmp/mock-llm.js）
node eval/ab/run-ab.js --mock http://localhost:4010/v1 --count 2

# 生成打分表 / 回填后统计
node eval/ab/score.js --format csv
node eval/ab/score.js --score _tmp/ab-output/sheet-<runId>.csv
```

唯一实验变量是 `XINYU_AGENTS=on|off`；产物全部写入 `_tmp/`（已 gitignore），不含任何 API Key。
