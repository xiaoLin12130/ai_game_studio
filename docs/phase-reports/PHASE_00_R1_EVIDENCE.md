# PHASE 00-R1｜补充证据（0.2.1-rc.3 + commandcode）

> **历史记录（R1 时代）**：本文件记录的是 R1 那一轮的证据，当时套件是 **5 个探针**，
> 因此下文出现的「5/5」属于当时规模。当前基线是 **六探针 6/6 + 两个门禁 + 68 项回归测试**，
> 以 `spike/dsh-probe/current-0.2.1/evidence/r14/` 与 `state/project_state.json` 的 `r14` 段为准。

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
| CC-0 CLI 基准 | PASS | `evidence/cc-0-cli-baseline/stdout.txt`（回显随机标识 + 自述模型名） |
| CC-1 真实对话 | PASS | `evidence/cc-1-reply/summary.json`（`requestRoute.provider = commandcode`） |
| CC-2 MCP 工具 | PASS | `evidence/cc-2-tools/audit-records.json`（`tools/call` + `tools/call.served`） |
| CC-3 会话恢复 | PASS | `evidence/cc-3-resume/summary.json`（`RESUME_RESTORES_HISTORY`） |
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

## A7. SDK 退出码的可得性（对应门禁 6 的措辞修正）

| 问题 | 结论 |
|---|---|
| SDK 是否返回被管理进程的退出码 | **否**。`HarnessClient` 的 `exitCode` 是私有字段；正常 `close()` 只保证回收完成 |
| 能取得的证据 | `close()` 耗时、OS 进程表三态结果、（异常时）`TransportClosedError` 携带的退出码 |
| 启动器级退出码 | 单独测量：干净 EOF → `0`；profile 启动失败 → `1`（探针 G，**不代表 SDK 管理进程**） |

因此门禁 6 改为「关闭后进程树为空 + close 耗时」，不再声称 SDK 会返回退出码。
