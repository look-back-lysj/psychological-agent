# logs/ · 调用记录与成本台账

> 本目录是《产品范围与验收清单》里点名的**交付证据位置**（第 38 / 43 / 47 行）。
> 它默认被 `.gitignore` 忽略（运行期日志可能含原文），**但下面几个文件通过白名单强制入库**——
> 因为「可运行 Demo + 真实调用记录 + 成本台账」是硬性交付物，缺一项就算没完成。

## 入库策略（`.gitignore` 白名单）

```gitignore
logs/                     # 整个目录默认忽略（保护运行期原文）
!logs/usage_summary.md    # 成本台账 —— 必须入库
!logs/calls.sample.jsonl  # 脱敏调用样例 —— 必须入库
!logs/README.md           # 本文件
```

**为什么不把 `calls-*.jsonl` 全量入库**：那是按天滚动的运行期日志，会持续增长，
且未来可能记录更长上下文；全量入库既让仓库膨胀，也增加误带敏感内容的概率。
**做法**：运行期日志留在本机，**只把脱敏样例与台账入库**。

## 各文件说明

| 文件 | 入库 | 说明 |
| --- | --- | --- |
| `calls.sample.jsonl` | ✅ | **脱敏样例**：只保留 `ts / strategy / riskLevel / event / model / inputLength / latencyMs / ok / error / usage`，**不含对话原文、不含 Key** |
| `usage_summary.md` | ✅ | **成本与调用台账**：真实调用次数、延迟、省额度策略；估算值已明确标注「估算」 |
| `calls.jsonl` | ❌ | 本地累计日志（每次运行追加） |
| `calls-YYYY-MM-DD.jsonl` | ❌ | 按天滚动日志 |

## 脱敏规则

- 会话标识**只记哈希**（`sessionIdHash`），不记原始 session id；
- **不记对话原文**，只记 `inputLength`；
- **不记 API Key**（任何形式都不记）；
- `error` 字段在写入前会抹掉形如 `sk-…` 的串；
- 需要更强的盐：设置环境变量 `LOG_SALT`（**不要**用模板默认值）。

## 相关文档

- 台账内容：[`usage_summary.md`](usage_summary.md)
- 评测报告（引用了本目录）：[`../docs/evaluation-report.md`](../docs/evaluation-report.md)
- 红队与 A/B 的原始产物：[`../docs/eval-results/`](../docs/eval-results/)
- 记录字段的代码实现：[`../src/core/logger.js`](../src/core/logger.js)

## 本文件何时需要更新

改动以下任一项时：调用记录的**字段结构**、**脱敏规则**、或 `.gitignore` 的白名单范围。
