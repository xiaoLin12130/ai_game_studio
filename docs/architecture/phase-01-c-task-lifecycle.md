# PHASE 01-C 架构：Task 生命周期与 Session 协调

## 1. 职责边界

| 责任 | Studio | DSH |
|---|---|---|
| 模型推理、工具执行 | 不负责 | 负责 |
| Task 生命周期与状态判定 | **负责** | 不负责 |
| Session 生命周期（创建/中断/恢复的协调） | **负责协调** | 提供原生能力 |
| 任务持久化与执行记录 | **负责** | 不负责 |
| 完成判定（验收） | **负责** | 只提供事件与结果 |

模型输出是**证据**，不是**状态**。LLM 说"完成了"只会进入 Studio 的验收流程，不直接改 Task 状态。

## 2. 实测的 DSH 能力（决定实现方式的事实）

来自 `@deepseek-ai/dsh-sdk-client@0.2.1-rc.3` 的类型定义与运行验证：

| 能力 | 结论 | 依据 |
|---|---|---|
| 创建 Session | 有。`client.session(id?)` 只开句柄；首次 prompt 时 runtime 才真正创建 | `api.d.ts` |
| 指定 sessionId | 有。`prompt(sessionId, blocks)`，id 由调用方给 | `client.d.ts` |
| **原生 Resume** | **有**。`resumeSession(sessionId)`：启动 runtime 并恢复已持久化历史，不发 prompt；home 里没有该历史或 session 被占用都会拒绝 | `api.d.ts` |
| Session 持久化 | 有。历史存在 DSH home（我们的应用用 `userData/dsh-home`），重启后仍在 | `resumeSession` 文档 + 实测 |
| **wire-level cancel** | **没有**。原文：`There is no wire-level cancel: a timed-out request stays running server-side until the runtime is closed.` | `client.d.ts` |
| 执行结果 | `RunResult { sessionId, finalResponse, events, notifications }`，事件为 `session.event` 的原始 payload | `types.d.ts` |
| 目录控制 | `getWorkingDirectory` / `setWorkingDirectory` | `client.d.ts` |
| 子会话树 | `subscribeSessionTree(rootSessionId)` | `client.d.ts` |

**推论（这决定了整个设计）**：

1. **中断 = 关闭该 Session 所属的 Runtime**。没有别的办法让 DSH 停下来。
2. 因为中断要杀 Runtime，**写入型任务必须独占 Runtime**；否则中断一个任务会带走另一个任务。
3. Session 落盘 + 原生 Resume 让「应用重启后继续」成为官方路径，而不是我们拼凑上下文。

## 3. RuntimeSupervisorManager

`src/main/runtime/supervisor.ts`。不是"一个角色一个 Runtime"，也不是"一个任务一个 Runtime"的固定绑定，而是按**隔离类**调度：

| 隔离类 | 谁用 | 策略 |
|---|---|---|
| `readonly` | 只读顾问、分析、问答 | 可共享一个 Runtime（默认上限 1，可配），中断会波及同池任务，因此**只允许不产生写入的任务进入** |
| `writable` | 会改文件、跑构建、执行命令的任务 | **独占 Runtime**，结束即回收 |

对外接口：

```ts
acquire(spec: { taskId, isolation: 'readonly' | 'writable', label }): Promise<RuntimeLease>
release(lease, reason): Promise<void>
health(): RuntimeHealth[]
shutdownAll(reason): Promise<ShutdownSummary>
on('runtime:exited' | 'runtime:failed', handler)
```

每个 Runtime 记录：`id`、`pid`（沿用 PHASE 01-A 的实例身份捕获）、`isolation`、`state`、`sessions`、`startedAt`、`lastError`。

健康与异常：

- 启动失败 → 租约申请失败，Task 进 `FAILED`，错误分类保留。
- 运行中退出 → `runtime:exited` 事件 → 关联 Task 立即离开 `RUNNING`（`INTERRUPTED`，原因 `runtime-exited`）。
- 关闭超时 → 复用 PHASE 01-A 的 `shutdown` 有界回收，超时记为 `UNKNOWN` 并保留 PID。

## 4. Task 与 Session 的数据模型

```
Task 1 ──< Attempt N ── 1 Session
Task 1 ──< Transition N
Session N ── 1 Runtime(lease)
```

- **Task**：业务工作。`id, title, goal, type, status, createdAt, updatedAt, currentAttemptId`。
- **Attempt**：一次执行尝试。`id, taskId, sessionId, runtimeId, status, startedAt, endedAt, errorCode, errorMessage`。
- **Session**：DSH 的会话身份。`id (= DSH sessionId), taskId, attemptId, runtimeId, state, createdAt`。
- Session id 与 Task id **不是同一个东西**：Task 可以有多条 Session 记录（多次尝试）。

## 5. Task 状态机

`src/main/tasks/machine.ts`。表驱动，非法转换在程序里拒绝。

| 状态 | 含义 |
|---|---|
| `CREATED` | 已创建，未排队 |
| `QUEUED` | 已排队，等 Runtime |
| `PREPARING` | 申请 Runtime / 创建或恢复 Session |
| `RUNNING` | DSH 正在执行 |
| `WAITING_FOR_USER` | 需要用户输入（本阶段只做状态与展示） |
| `INTERRUPTING` | 中断请求已发出，等 Runtime 关闭确认 |
| `INTERRUPTED` | 已中断，Session 已落盘，可恢复 |
| `RESUMING` | 正在恢复 Session |
| `VERIFYING` | 执行结束，Studio 正在验收 |
| `SUCCEEDED` | 验收通过（终态） |
| `FAILED` | 失败（终态，可重试产生新 Attempt） |
| `CANCELLED` | 用户取消（终态） |

合法转换（节选，完整表在代码里）：

- `CREATED → QUEUED | CANCELLED`
- `QUEUED → PREPARING | CANCELLED`
- `PREPARING → RUNNING | FAILED | CANCELLED`
- `RUNNING → INTERRUPTING | VERIFYING | FAILED`
- `INTERRUPTING → INTERRUPTED | FAILED`
- `INTERRUPTED → RESUMING | CANCELLED`
- `RESUMING → RUNNING | FAILED（恢复失败）`
- `VERIFYING → SUCCEEDED | FAILED`
- `FAILED → QUEUED（重试，产生新 Attempt）| CANCELLED`

**明确禁止**：`SUCCEEDED → *`、`FAILED → RUNNING`（必须经 `QUEUED` + 新 Attempt）、`INTERRUPTED → RUNNING`（必须经 `RESUMING`）。

每次转换写一条 `task_transitions` 记录：原状态、新状态、原因、来源（`user|scheduler|runtime|verifier|recovery`）、时间、`sessionId`、`attemptId`、错误信息。

## 6. 执行与完成判定

```
创建 Task → QUEUED → 调度 → PREPARING（acquire runtime + create/resume session）
→ RUNNING（run） → 收到 idle 或错误 → VERIFYING → SUCCEEDED / FAILED
```

验收器接口（可扩展，本阶段实现 3 个内置规则）：

```ts
interface Verifier { id: string; verify(ctx): Promise<{ ok: boolean; code?: string; detail?: string }> }
```

内置规则：

1. `run-completed`：DSH 回合正常结束，没有传输错误。
2. `response-present`：`RunResult.finalResponse` 非空。
3. `tools-succeeded`：任务声明了必需工具时，对应 `tool/result` 不得是错误。

**模型说"完成"不改变任何状态**——只有验收器通过才进 `SUCCEEDED`。

## 7. 中断与恢复

**中断（用户点停止）**：

```
RUNNING → INTERRUPTING → runtime.close()（有界）→ 确认进程消失 → INTERRUPTED
```

理由：DSH 没有 cancel；关闭 Runtime 是唯一能让执行真正停止的方式。Session 已落盘，可恢复。

**恢复**：

```
INTERRUPTED → RESUMING → 新 Runtime → client.resumeSession(sessionId) → RUNNING
```

- 恢复成功：同一 Session，继续原上下文。
- 恢复失败（`resumeSession` 抛错）：保留失败原因，Task → `FAILED`（`RESUME_FAILED`），**不静默新建 Session**。用户可显式重试，重试产生**新 Attempt + 新 Session**，并保留旧记录。

**应用重启后**：

启动时扫描非终态 Task，把 `RUNNING/PREPARING/RESUMING` 一律记为 `INTERRUPTED`（原因 `app-exit`），然后允许恢复。

## 8. 持久化

`node:sqlite`（Electron 44.7 内置 Node 24.21，已实测 `DatabaseSync` 可用，无需原生模块、无需 rebuild）。

位置：`<userData>/studio.db`，WAL 模式。

表：`schema_version`、`tasks`、`task_transitions`、`attempts`、`sessions`、`runtimes`、`events`、`verifications`。

原则：

- 状态迁移与事件写入在同一事务里提交。
- 唯一约束防重复：`(task_id, attempt_no)`、`(attempt_id)` 唯一。
- 事件表只存**元数据与摘要**；完整输出写文件系统（`<userData>/records/<taskId>/<attemptId>.jsonl`），库里存相对路径。
- 迁移按 `schema_version` 顺序执行；未知更高版本直接拒绝启动持久化（不猜）。

## 9. UI

在现有 vanilla 渲染层上扩展（不引入 React）：

- 左侧任务列表（状态色 + 最近更新 + 当前 Session）
- 右侧任务详情（目标、状态、步骤、执行历史、事件、失败原因、验收结果）
- 按状态给出合法操作：开始 / 停止 / 恢复 / 重试；非法操作禁用并说明原因
- 高级信息（Runtime、PID、Session id、事件日志）折叠在"技术详情"里，不占主视线
