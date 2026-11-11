# PHASE 01-C 工作报告 — DSH Session 生命周期与 Studio Task 状态管理

> **状态：`READY_FOR_EXTERNAL_REVIEW`（第 2 轮）。** 本报告不宣告通过，是否关闭由外部独立评审决定。
>
> 第 1 轮评审基线 §8cb415b§；本轮修复 Runtime 关闭竞态、补齐两项缺失回归、修正交付记录。

## 1. 本阶段原始目标

1. RuntimeSupervisorManager
2. Session 生命周期管理
3. Task 状态机
4. Task 执行协调
5. 中断与恢复
6. 持久化与崩溃恢复
7. 最小任务管理 UI
8. 测试与真实运行证据

## 2. Git

| 项 | 值 |
|---|---|
| 阶段基线 | `908c2fbff9f1c311e3e28630cb91aaea3d5686c5`（PHASE 01-B 关闭 HEAD） |
| 分支 | `phase/01-c-session-task-lifecycle` |
| 父提交 | `3e0c282`（上一轮"未完成"状态记录） |

## 3. 决定设计的两个实测事实

| 事实 | 依据 | 后果 |
|---|---|---|
| DSH **没有** wire-level cancel | `dsh-sdk-client` 类型注释原文 | 「停止任务」只能关闭该任务所属 Runtime |
| DSH **有**原生 `resumeSession(sessionId)` | `api.d.ts` + 实测 | 中断后 Session 落盘可恢复；恢复是新 attempt 复用原 session |

因此：写入型任务独占 Runtime（否则中断一个会带走另一个），只读任务可共享；恢复失败明确记 `RESUME_FAILED`，绝不静默新建会话。

## 4. 实现

| 模块 | 文件 |
|---|---|
| Task 状态机（表驱动，非法转换抛错） | `src/main/tasks/machine.ts` |
| 数据模型 | `src/main/tasks/types.ts` |
| SQLite 持久化（`node:sqlite`，迁移/事务/唯一约束） | `src/main/tasks/store.ts` |
| Runtime 调度与生命周期 | `src/main/runtime/supervisor.ts` |
| 执行协调、中断、恢复、崩溃恢复 | `src/main/tasks/runner.ts` |
| 服务面（IPC 入口） | `src/main/tasks/service.ts` |
| 任务面板 UI | `src/renderer/{index.html,renderer.ts,styles.css}` |

架构文档：`docs/architecture/phase-01-c-task-lifecycle.md`（含完整状态转换表）。

## 5. 缺陷与修复

### 5.1 第 1 轮评审指出的 P1（本轮修复）

| 编号 | 问题 | 修复 |
|---|---|---|
| P1-CLOSE-RACE | `#close()` 遇到 `state === 'closing'` 直接返回，`shutdownAll()` 不等待在途关闭，把仍在关闭的 Runtime 记为 failed | 每个 Runtime 保存唯一 `closePromise`，首次调用创建、后续一律 await 同一个；`shutdownAll` 等待而非猜测 |
| P1-CLOSE-TIMEOUT | `Promise.race([close, sleep(25000)])` 的超时分支正常 resolve，未关闭的 Runtime 可能被标成 `closed` | 超时改为抛错：未确认关闭不设 `closed`；失败保留在管理表并以 failed 上报，不再静默删除 |
| P1-DISPOSE-RESULT | `dispose()` 返回 closed/failed，但 `gracefulQuit()` 没有检查 | `dispose` 返回 `{closed, failed, ok}` 并记 `task.service.dispose.failed`；退出码按 `ok` 决定 |

新增 `test/runtime-supervisor.test.js`（6 项，全部用 deferred promise 构造竞态，不靠 sleep）：release 与 shutdown 共享同一 close、并发请求只调一次 SDK close、关闭挂起必须失败且保留在管理表、关闭抛错必须上报 failed、干净关闭才消失、dispose 在任一 Runtime 关闭失败时返回 `ok:false`。

### 5.2 顺带修掉的真实缺陷

`#create()` 的启动超时定时器在握手成功后没有清除，会让事件循环空转满 90 秒（测试文件因此耗时 90s）。已改为在 `finally` 中 `clearTimeout`，同一组测试从 90s 降到 0.56s。

### 5.3 上一轮记录的三处缺陷（保留说明）

| 编号 | 级别 | 问题 |
|---|---|---|
| F-01C-1 | P1 | 任务 runtime 没有 provider row，静默跑在 `deepseek-official` 路由上，以 `MISSING_CREDENTIAL` 失败并被表象成"没有 assistant 消息" |
| F-01C-2 | P1 | 会话未开始工作时的第一个 `idle` 被当作回合结束，任务 100ms 内以 0 事件"完成" |
| F-01C-3 | P2 | 启动健康探测与任务 runtime 同父进程，身份捕获歧义时拒绝（安全但报 UNKNOWN） |

## 6. 安装版验证（本轮核心）

真实安装包（NSIS），静默安装后运行三个场景，**38/38 断言通过**（`evidence/phase-01-c/packaged/summary.json`）。每个场景都额外检查 §disposeHadNoFailure§（日志无 §task.service.dispose.failed§ / §runtime.close.failed§）与 §runtimeProcessGone§（按 DSH home 查进程表，状态必须为 §ABSENT§）：

| 场景 | 内容 | 结果 |
|---|---|---|
| A 正常完成 | 创建任务 → 真实模型回合 → Studio 验收 → SUCCEEDED → 无残留 runtime、无残留 GUI 进程 | PASS |
| B 中断恢复 | 启动 → 停止（经 INTERRUPTING）→ INTERRUPTED → resume → **同一 session** → 新 attempt → 终态 | PASS |
| C 崩溃恢复 | 运行中 §app.exit(9)§（无优雅关闭）→ **崩溃后立即查进程表**（§crashLeftNoOrphan§）→ 重启 → 识别 INTERRUPTED → 恢复 → 新 attempt → 干净退出 | PASS |

C 场景是真实的异常退出，不是故障注入：进程被直接结束，没有 shutdown、没有 runtime close。

## 7. 测试与回归

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test`（应用全量，连续两次） | 0 / 0 | **101/101**，0 失败 | `unit/full-suite-1.txt`、`unit/full-suite-2.txt` |
| `node --test test/runtime-supervisor.test.js` | 0 | **9/9**（关闭竞态 6 + 启动失败清理 3） | `unit/supervisor-race.txt` |
| `node --test test/process-identity.test.js` | 0 | **8/8**（PRESENT/ABSENT/FAILED/UNKNOWN） | `unit/process-identity.txt` |
| `node --test test/task-integration.test.js` | 0 | **2/2**（真实 DSH + 真实模型） | `real-dsh/integration.txt` |
| 隔离连续 3 次 | 0 | 3/3 | `real-dsh/isolated-1.txt`、`isolated-2.txt`、`isolated-3.txt` |
| `node tests/run-tests.mjs`（PHASE 00） | 0 | **166/166** | `regression/phase00-suite.txt` |
| `node scripts/run-gates.mjs`（PHASE 00 门禁） | 0 | PASS，0 泄漏 | `regression/phase00-gates.json` |
| `node scripts/smoke.mjs failure`（01-A，本轮补跑） | 0 | — | `regression/phase01a-failure.txt` |
| `node scripts/smoke.mjs ready`（01-A） | 0 | — | `regression/phase01a-ready.txt` |
| `node scripts/smoke.mjs quit-during-probe`（01-A） | 0 | — | `regression/phase01a-quit.txt` |
| `node scripts/mcp-probe.mjs`（01-B，开发环境握手） | 0 | — | `regression/phase01b-mcp.txt` |
| `node scripts/mcp-packaged.mjs --prompt`（01-B，**安装版真实工具调用**，本轮补跑） | 0 | `toolCalled: true` | `packaged/mcp-tool-call.json` |

关于上一轮"满套件不稳定"：本轮定位到**不是**模型或限流问题，而是我自己的断言取样太早（任务刚到 SUCCEEDED 就检查 runtime 是否已回收，而 `release()` 在下一拍才关完）。改成等待回收后，满套件连续通过。

## 7.1 一个必须记录的操作

跑 PHASE 01-A / 01-B 回归时，`scripts/smoke.mjs` 与 `scripts/mcp-probe.mjs` 会把结果写回它们自己的证据目录，从而**覆写了 6 个历史证据文件**（`evidence/phase-01-a/smoke/{ready,quit-during-probe}/*`、`evidence/phase-01-b/mcp/handshake.json`）。

已在提交前用 `git checkout 908c2fb -- evidence/phase-01-a evidence/phase-01-b` 全部还原，还原后与 PHASE 01-B 关闭提交的 diff 为空。本阶段的回归结果以 `regression/phase01a-failure.txt`、`regression/phase01a-ready.txt`、`regression/phase01a-quit.txt` 的原始输出为准，不依赖被覆盖的历史文件。

## 8. 证据

`evidence/phase-01-c/README.md` 索引，总表 `verification.json`。所有原始输出是 `.txt`——`*.log` 被 `.gitignore` 忽略，这个项目已经因此丢过一次证据。

## 9. UNKNOWN / DEFERRED

| 类型 | 内容 |
|---|---|
| UNKNOWN | U-01C-1 第三方 Provider 限流/额度波动对长回合任务的影响 |
| DEFERRED | D-01C-1 任务面板之外的会话事件流可视化 |
| NOT_RUN | 静态吊销检查（未引入签名/OEM）；`npm audit` 依赖审计（本轮未改依赖树） |
| BLOCKED | 无 |

## 10. 结论

原始目标 1–8 全部实现并有证据；安装版 A/B/C、三方回归、门禁均通过；无已知 P0/P1 遗留。

状态：**`READY_FOR_EXTERNAL_REVIEW`**，等待外部独立评审。
