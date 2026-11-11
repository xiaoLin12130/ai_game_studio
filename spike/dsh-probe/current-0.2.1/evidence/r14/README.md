# evidence/r14 — 每个文件属于哪一次运行

公开仓库里同时存在几次运行的结果。数字不同是**因为文件集在增长**，不是为了凑结论。
当前状态请以 `state/project_state.json` → **`phase_00_final`** 为准（`authoritative_source.current_record` 声明）；
`r141` 及更早的对象是历史快照。本目录只提供原始记录。

| 文件 | 属于哪次运行 | 关键数字 |
|---|---|---|
| `summary.json` | 最后一次**完整六探针真实运行**（2026-11-10T12:43:44Z，`npm test` 中的 `run-all.mjs`） | 6/6 PASS，双门禁 PASS，脱敏扫描 167 文件 / 0 泄漏，exit 0 |
| `_aggregate/run-all.json`（上级目录） | 同上，由 `run-all.mjs` 写出 | 与 `summary.json` 同源同时间 |
| `scrub.json` | 同上一次完整运行，由 `run-all.mjs` 写出的脱敏门禁结果 | 167 文件 / 0 泄漏 |
| `dependencies.json` | 同上一次完整运行，依赖门禁结果 | PASS |
| `negative-leak-gate.json` | R1.4 负向证明：植入一条路径后**完整跑一遍六探针** | 六探针仍 6/6 PASS，脱敏门禁 FAIL，`OVERALL FAIL`，exit 1 |
| `tests.json` | **PHASE 00 最终收尾**回归测试，由 `npm run test:unit` 发布（只覆盖成功运行） | 107/107 PASS，exit 0；R1.4.1 的 90/90 是历史值 |
| `final-gates.json` | **PHASE 00 最终收尾门禁回归**：依赖 + 状态一致性 + 脱敏三道门，**不跑模型探针** | 三道门均 PASS，扫描 173/173，泄漏 0，exit 0；数字以文件内 `generatedAt` 为准 |

## 为什么 167 和 173 不一样

R1.4 之后新增了源码、测试和文档文件，扫描范围也随之增长。
`167` 是 2026-11-10 那次完整运行的发布文件数；`173` 是 R1.4.1 收尾后的全量发布文件数。
两者都记录的是**当时 git 发布集的全部文本文件**，不是抽样。

## 为什么 R1.4.1 没有重新生成 `summary.json`

这次只改了脱敏规则、扫描器、依赖元数据校验、测试与文档，没有改动 DSH 探针执行逻辑。
按评审意见「只针对受影响门禁做回归，不无意义重复真实模型调用」，`scripts/run-gates.mjs`
只重跑两个受影响门禁并写 `final-gates.json`；六探针的真实运行证据保持原样，不被覆盖、也不被伪造重跑。

## 复现

```powershell
cd spike\dsh-probe\current-0.2.1
npm run test:unit   # 90 项，只有退出 0 才发布 tests.json
npm run gates       # 只跑门禁，写 final-gates.json
npm test            # 完整链路：测试 + 六探针 + 双门禁（会消耗真实模型调用）
```
