# PHASE 00-R1｜补充证据（0.2.1-rc.3 + commandcode）

权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

> **历史记录（R1 时代）**：本文件记录的是 R1 那一轮的证据，当时套件是 **5 个探针**，
> 因此下文出现的「5/5」属于当时规模，保留原样。**当前基线不是本文的数字，也不以 `r14` 段为准**：
> 唯一权威记录是 `state/project_state.json` → `phase_00_final`。当前规模：六探针 **6/6 PASS**
> （最后一次完整真实运行 `2026-11-10T12:43:44.987Z`，`evidence/r14/summary.json`，本轮未重跑）、
> **三道门禁**（dependency / state / leak，结果见 `evidence/r151/final-gates.json`）、回归测试 **143/143 PASS**
> （`evidence/r151/tests.json`），另有不消耗模型额度的 CC-6 退出码探针。

本文件补充并修正 `PHASE_00_EVIDENCE.md`。**0.1.5 的历史证据已冻结**在
`spike/dsh-probe/legacy-0.1.5/`（探针源码 + 证据快照），后续不再覆盖。

---

## A1. 为什么 0.1.5 的 402 不是用户模型的问题

| 观测 | 证据 |
|---|---|
| 0.2.1 CLI 加载 commandcode 0.11.3（headless profile）被拒绝 | `Plugin @mars-sea/dsh-commandcode-provider@0.11.3 is incompatible with dsh 0.2.1-rc.3` |
| 拒绝后运行时**静默回退**到 `deepseek-official` | 日志 `[llm-deepseek-api-key] model listing from https://api.deepseek.com/models` |
| 回退后才出现 402 | `dsh: QUOTA: Insufficient Balance` |

结论：PHASE 00 拿到的 402 来自**回退后的 DeepSeek 官方 provider**，与用户实际模型无关。

## A2. 0.2.1-rc.3 + commandcode 实测（`spike/dsh-probe/current-0.2.1/`）

| 探针 | 结果 | 关键证据文件 |
|---|---|---|
| CC-0 CLI 基准 | PASS | `evidence/cc-0-cli-baseline/summary.json`（`tokenEchoed` + `modelNamed`；原始输出已按 R1.2 要求移除，改由结构化字段承载） |
| CC-1 真实对话 | PASS | `evidence/cc-1-reply/summary.json`（`requestRoute.provider = commandcode`） |
| CC-2 MCP 工具 | PASS | `evidence/cc-2-tools/audit-records.json`（`tools/call` + `tools/call.served`） |
| CC-3 会话恢复（正常关闭） | **CONFIRMED** | `evidence/cc-3-resume/summary.json`（`RESUME_RESTORES_HISTORY`：新进程 resume 后答出随机口令）；中断中的最后一轮恢复为 `UNKNOWN`（U7） |
| CC-4 并发 | PASS | `evidence/cc-4-concurrent/summary.json`（答案未互换） |
| CC-5 能力矩阵 | PASS | `evidence/cc-5-capability/summary.json`（方法存在性） |

汇总：`node run-all.mjs` → PASS 5/5，退出码 0（`evidence/_aggregate/run-all.json`）。

## A3. 能力矩阵（方法级，实测）

| 方法 | 0.1.5-rc.2 | 0.2.1-rc.3 |
|---|---|---|
| `initialize` / `session/prompt` / `shutdown` | 支持 | 支持 |
| `session/resume` | 不存在 | **支持**（恢复历史） |
| `session/wait` | 不存在 | 支持 |
| `session/working-directory/get` / `set` | 不存在 | 支持 |
| `session/cancel` | 不存在 | **仍不存在** |
| `session/approve` | 不存在 | **仍不存在** |
| `session/close` | 不存在 | **仍不存在** |

判定依据：方法存在时返回真实业务错误（如 `session "x" not found`）；不存在时返回
`unknown ... SDK runtime method`（错误码 `-32603`，与其 README 所称 `-32601` 不一致）。

## A4. 探针粒度修正的验证

| 修正 | 验证方式 | 结果 |
|---|---|---|
| 进程检测三态 | 让查询本身失败 | 返回 `PROCESS_CHECK_FAILED` → 判 FAIL，不再当「已退出」 |
| 排除自观测 | 在无运行时状态下调用检测 | `PROCESS_ABSENT`（修复前会「发现」自己的检测子进程） |
| 探针 D 五断言 | 0.1.5 复跑 | A/D/E 成立，B/C 因 402 未成立 → BLOCKED（不再冒充 PASS） |
| 探针 E 三阶段 | 0.1.5 到 stage2；0.2.1 到 stage3 | 0.1.5 BLOCKED / 0.2.1 PASS |
| 探针 F 六断言 | 0.2.1 复跑 | 全 6 项 PASS |

## A5. 环境干扰（必须记录，不能算作 DSH 缺陷）

本机通过 `NODE_OPTIONS` 向所有 node 子进程注入 `safe-delete` 安全垫。DSH 每次启动会删除自己的
`profiles/node_modules.lock`，删除计数累积到阈值后触发：

```
Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {...,"targets":["...node_modules.lock"]...}
```

后果：0.1.5 legacy 套件在本机可能整体 BLOCKED；0.2.1 套件未受影响（删除次数较少）。
处理：`run-all.mjs` 与探针 G 均把此类错误归类为 **环境干扰 → BLOCKED**，不计入 FAIL。

## A6. 脱敏

证据写入统一经 `redact()`：仓库根 → `<repo>`、用户目录 → `<user-home>`、主机名 → `<host>`。
历史证据已批量清洗；报告中不出现真实用户名与目录结构。

## A7. SDK 退出码的可得性（2026-11-11 修订：门禁 6 按原始措辞判定）

**结论：0.2.1-rc.3 没有结构化的退出码访问器，但存在一条已文档化的 message 通道，实测可取得退出码。**

| 问题 | 结论 |
|---|---|
| 有没有结构化访问器 | **没有**。`HarnessClient#exitCode` 是私有字段，`close()` 返回 `Promise<void>`，`HarnessClientOptions` 没有 onExit 钩子 |
| 能不能拿到退出码 | **能**。SDK 公开导出的 `TransportClosedError` message 携带 `exit code: <n>`（`lib/types/client.d.ts` 明文声明 "The message carries the exit code"）；该值来自 `child.once('exit')`，对应 SDK 自己 spawn 的 runtime 子进程 |
| 实测值 | 正常 `close()` → `exitCode = 0`；外部 `taskkill /F` 强杀 → `exitCode = 1`；两次均 `PROCESS_ABSENT`（`evidence/cc-6-exitcode/summary.json`，`npm run probe:exit`，`modelCallsMade = 0`） |
| 限制 | 退出码只能从 **message 文本**解析；上游若改写文本则解析失败返回 `null`（不猜），需随 SDK 升级重跑 CC-6 |
| 启动器级退出码 | 干净 EOF → `0`；profile 启动失败 → `1`（探针 G，0.1.5，**不代表 SDK 管理进程**） |

**门禁 6 结论**：按阶段文件原始措辞「Runtime 关闭后进程确实退出，记录退出码」判定，**已满足**；
上一轮「改为进程树为空 + close 耗时」的规避措辞**作废**，不再使用。
