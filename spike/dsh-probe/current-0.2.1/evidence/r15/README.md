# evidence/r15 — PHASE 00 收敛轮（本轮）的证据说明

> 权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

本轮**没有覆盖 r14**。r14 是 2026-11-10 那次完整六探针真实模型运行的记录，
它必须保持原样；本轮只改了门禁实现、测试与文档，因此把新结果发布到独立的 r15。

| 文件 | 属于哪次运行 | 关键内容 |
|---|---|---|
| `tests.json` | 本轮回归测试（`npm run test:unit`） | 135/135 PASS，exit 0 |
| `final-gates.json` | 本轮门禁回归（`npm run gates`，**不跑模型探针**） | dependency / state / leak 三道门 PASS，0 泄漏，exit 0 |

## r14 与 r15 的分工

| 目录 | 记录什么 | 什么时候会被改写 |
|---|---|---|
| `evidence/r14/` | 最后一次**完整六探针真实模型运行** + 那一轮的门禁输出 | 不再改写（历史） |
| `evidence/r15/` | 本轮（收敛轮）的测试与门禁回归结果 | 只在重跑本轮回归时改写 |

轮次目录由 `CC_GATE_ROUND` 决定（默认 `r15`，见 `scripts/run-gates.mjs` 与 `tests/record-tests.mjs`）。
设置 `CC_GATE_ROUND=r14` 可以复现旧行为，但会覆盖历史记录，只在明确需要时使用。

## 本轮新增、不写进 r15 的独立证据

这几个是独立探针，各自有自己的目录，因为它们**不消耗模型额度**、可任意重跑：

| 目录 | 探针 | 跑什么 |
|---|---|---|
| `evidence/cc-6-exitcode/` | `src/probe-runtime-exit.mjs`（`npm run probe:exit`） | 被 SDK 托管 Runtime 的真实退出码：正常 close = 0，外部强杀 = 1，两次均 PROCESS_ABSENT |
| `evidence/cc-7-diag/` | `src/studio-diag.mjs`（`npm run diag`） | 诊断 CLI 的 CLI 输出：live 模式展示版本/连接/会话/回收；replay 模式展开真实录制的事件与状态时间线 |

## 复现

```powershell
cd spike\dsh-probe\current-0.2.1
npm run test:unit     # 135 项；只有 exit 0 才发布 r15/tests.json
npm run gates         # 三道门禁；写 r15/final-gates.json
npm run probe:exit    # 退出码探针（0 模型调用）
npm run diag          # 诊断 CLI（0 模型调用）
npm test              # 完整链路：测试 + 六探针 + 门禁（会消耗真实模型调用，本轮未跑）
```
