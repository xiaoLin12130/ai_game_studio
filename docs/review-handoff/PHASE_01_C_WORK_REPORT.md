# PHASE 01-C 工作报告 — DSH Session 生命周期与 Studio Task 状态管理

> **状态：`BLOCKED`（接管轮 / 第 3 轮）。** 本报告不宣告通过，是否关闭由外部独立评审决定。
>
> 第 1 轮评审基线 §8cb415b§；第 2 轮修复 Runtime 关闭竞态、补齐两项缺失回归、修正交付记录。第 3 轮（WorkBuddy 接管）补齐 B 场景第二个 Runtime 的真实 OS 进程退出验证**代码**并完成**单元验证**；**安装版 A/B/C 复验被环境阻断**（见 §6.2），故无法交付"两个 Runtime 均 ABSENT"的安装版实证。

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

## 6. 安装版验证

### 6.1 本轮对 B 场景第二个 Runtime 的修复（代码 + 单元验证）

第 2 轮引入的"按 `(pid, creationMs)` 身份复核"解决了 `INVALID-1`（home 字符串匹配），但 B 场景只**单次**捕获一个 Runtime 身份，无法证明"中断→恢复"产生的**第二个** Runtime（rt-002）已退出。本轮补齐：

- `apps/studio/src/main/dsh/processes.ts`：新增 `discoverRuntimeIdentities(table, {parentPid, binMarker})`，返回父进程下**所有**匹配 `dsh CLI` 的子进程身份（而非只取第一个）；保留既有 `captureRuntimeIdentity` / `verifyRuntimeIdentity` / `createProcessTable`。
- `apps/studio/scripts/smoke-tasks-packaged.mjs`：把"单次 `captureIdentity`"替换为 `startIdentityWatcher`——在 App 整个生命周期内轮询（250ms），按 `(pid, creationMs)` 去重收集**所有** Runtime 身份；新增 `checkAllIdentities` 对每一个捕获身份执行 `verifyRuntimeIdentity`。B 场景新增三项强制校验：`runtimeIdentityCount === 2`、`runtimeIdentitiesDistinct === 2`、`allRuntimeProcessesGone`（仅当全部身份 `ABSENT` 才为真）。A/C 沿用同一机制独立验证各自 Runtime。
- 禁止项均遵守：未使用 `commandLine.includes(dshHome)`；未以 GUI 进程退出代替 Runtime 进程检查；未以 SDK `runtime.closed` 日志代替 OS 进程身份检查；四态 `PRESENT/ABSENT/FAILED/UNKNOWN` 一致。

该机制由**配额无关**的单元测试覆盖：`test/process-identity.test.js` 含 `discoverRuntimeIdentities` 返回全部 / 查询失败 / 全退出的用例，本轮 **11/11 通过**（见 §7）。

### 6.2 安装版 A/B/C 复验 —— 被环境阻断（BLOCKED）

第 3 轮对 `out-g` 打包构建（`/tmp/pkg-exp/out-g/win-unpacked`，DSH 0.2.1-rc.3）实跑了 A/B/C 三场景，结果 **无法达到通过**：

- 三个场景的 DSH runtime 一启动即 `FAILED`，`code: ROUTE_UNKNOWN`，`raw: "no adapter registered for provider \"commandcode\""`（真实证据：`/tmp/studio-pkg-B-*`，`out-task-interrupt-resume/smoke.json`）。
- `smoke-tasks-packaged.mjs`（HEAD 与本轮一致）写入 `provider: 'commandcode'`、`COMMANDCODE_API_KEY` 来自 `~/.dsh/.credentials.yaml`。但**当前仓库 `node_modules/@deepseek-ai/dsh-sdk-client@0.2.1-rc.3` 与全部三个打包 exe（out-c/d/g）的内置 DSH 均不含 `commandcode` provider**（受支持列表仅含 `deepseek`/`openai`/`anthropic` 等），grep 全磁盘 `AI Game Studio.exe` 亦无任何 `commandcode` 字符串。
- 后果：runtime 进程虽启动（`runtimeExitCode: 0`），但任务立即失败，B 场景的"中断→恢复"流程从未发生，**rt-002 从未启动**；本轮实跑仅捕获到 1 个 Runtime（已验证 `ABSENT`），无法证明"两个 Runtime 均退出"。

**这是环境/构建层面的阻断，不在 PHASE 01-C 范围内**（禁止重做 DSH 通信、禁止扩大验收范围、禁止伪造证据）。本轮**未**修改 provider 配置或伪造成功。`evidence/phase-01-c/packaged/summary.json` 保留为本轮真实实跑结果（`ok: false`，19 项场景级断言失败，根因为 `commandcode` 路由缺失），不作通过依据。

### 6.3 第 2 轮历史结果（保留，仅供审计）

第 2 轮报告 A/B/C **38/38 断言通过**；但其进程检查采用的"按 DSH home 字符串匹配"已在 `INVALID-1` 标记为无效，故第 2 轮的 A/B/C 安装版结论**不作为通过依据**。本轮未重跑以复现该结论。

C 场景是真实的异常退出（运行中 `app.exit(9)`，无优雅关闭、无 runtime close），崩溃后立即用崩溃前捕获的身份查进程表。该机制代码已就绪，待环境具备 `commandcode` provider 后可复验。

## 7. 测试与回归

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test`（应用全量，连续两次） | 0 / 0 | **101/101**，0 失败 | `unit/full-suite-1.txt`、`unit/full-suite-2.txt` |
| `node --test test/runtime-supervisor.test.js` | 0 | **9/9**（关闭竞态 6 + 启动失败清理 3） | `unit/supervisor-race.txt` |
| `node --test test/process-identity.test.js` | 0 | **11/11**（PRESENT/ABSENT/FAILED/UNKNOWN + `discoverRuntimeIdentities` 返回全部/查询失败/全退出） | `unit/process-identity.txt` |
| `node scripts/smoke-tasks-packaged.mjs <installed>` | 1 | **BLOCKED**：`commandcode` provider 不在当前 DSH 0.2.1-rc.3（仓库与 out-c/d/g 均不含），runtime 启动即 `ROUTE_UNKNOWN`，B 的 rt-002 从未启动，仅捕获 1 个 Runtime（已验证 ABSENT） | `packaged/summary.json` |
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
| BLOCKED | B-INSTALL-1 安装版 A/B/C 复验：`commandcode` provider 在当前 DSH 0.2.1-rc.3（仓库 + out-c/d/g exe）中未被注册，runtime 启动即 `ROUTE_UNKNOWN`，无法驱动 B 场景"中断→恢复"以产生第二个 Runtime；属环境/构建问题，超出 PHASE 01-C 范围，需具备 `commandcode` provider 的 DSH 构建/凭据方可复验 |

## 10. 结论

原始目标 1–8 代码已实现；B 场景第二个 Runtime 的 OS 进程退出验证**代码已补齐并由单元测试覆盖**（11/11）。但**安装版 A/B/C 复验被环境阻断**（B-INSTALL-1：`commandcode` provider 在当前 DSH 构建中不可用），无法交付"两个 Runtime 均 ABSENT"的安装版实证。代码、单元证据、真实失败实跑证据均已就位，待环境具备 `commandcode` provider 后可复验。

状态：**`BLOCKED`**（代码完成，安装版复验被环境阻断），等待外部独立评审与具备 `commandcode` provider 的环境。
