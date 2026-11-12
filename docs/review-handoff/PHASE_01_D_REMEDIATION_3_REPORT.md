# PHASE 01-D 第三轮补正报告

> **状态：`READY_FOR_EXTERNAL_REVIEW`。** 本报告不宣告通过。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `phase/01-d-project-workspace` |
| 补正基线 | `2e061d8c4ababc98bc3e8f33b8e01b633ac0a2f9` |
| 盘点 | `docs/review-handoff/PHASE_01_D_REMEDIATION_3_AUDIT.md` |

## 2. 问题一：锁心跳失败必须触发安全退出

### 2.1 原行为

`#startHeartbeat()` 的 catch 只有两个动作：记 `task.project-lock.heartbeat-failed` 日志、停定时器。
Runtime 继续运行，任务继续走 `VERIFYING`，可能被验收为 `SUCCEEDED`——而此时项目锁可能已被另一个任务回收。

### 2.2 修复

| 要求 | 实现 |
|---|---|
| 视为写入权限丢失 | 新增 `#abandonOnLockLoss()`，不再只是日志 |
| 复用现有生命周期 | 调用既有 `#stopActive(active, 'cancelled')`，不新建 Runtime 控制逻辑 |
| 不得继续写入 | Runtime 被关闭，`observe()` 随之结束 |
| 防止重复关闭 | `#stopActive` 的 `active.stopping` 守卫吸收竞争；`#lockLost` 集合防重复处理 |
| 不得验收为 SUCCEEDED | `VERIFYING` 之前设闸门，锁丢失直接走失败分支 |
| 明确失败原因 | `PROJECT_LOCK_LOST`，与运行超时区分 |
| 不误释放他人锁 | `#releaseProjectLock` 按 `ownerId` 释放，锁已被他人持有时 `NOT_OWNER` 被捕获并记日志 |
| 清理资源 | 停心跳、关 Runtime、清 `#active`、清 `#lockLost` |
| 兼容其他路径 | 用户 stop / dispose / Runtime 退出 / resume 失败均复用同一套停止流程 |

### 2.3 竞争处理

| 场景 | 处理 |
|---|---|
| 心跳失败时任务在 `observe()` | `#stopActive` 关闭 lease，`observe` 结束 |
| 用户同时 stop | `active.stopping` 已置位，第二次调用直接返回 |
| Runtime 同时退出 | `#onRuntimeExited` 已删 `#active`，锁丢失路径走 `#failIfUnsettled` |
| 任务已进入 `VERIFYING` | 闸门在 `#move(VERIFYING)` 之前，锁丢失直接失败 |
| `dispose` 同时发生 | `beginShutdown()` 置位后，延迟回调不再写库 |

### 2.4 修复过程中发现的缺陷

**dispose 关库后延迟回调仍写库**：`#abandonOnLockLoss` 的 `.finally()` 在 `dispose` 关闭数据库之后才执行，
触发 `database is not open`。修复：新增 `#shuttingDown` 标志与 `beginShutdown()`，`TaskService.dispose()`
在停 Runtime 之前调用它。

## 3. 问题二：恢复校验必须覆盖完整数据库结构

### 3.1 原行为

`verifyLiveDatabase()` 只传 5 张表；`backup.ts` 的 `REQUIRED_TABLES` 只有 3 张。两套清单不一致，且都远小于真实 schema。

### 3.2 修复

从 `tasks/store.ts` 的 `MIGRATIONS` 中 `CREATE TABLE IF NOT EXISTS` 提取，共 **13** 张：

```
schema_version  tasks            task_transitions  attempts
sessions        runtimes         verifications     events
projects        project_configs  project_events    approvals
project_locks
```

导出为 `REQUIRED_TABLES` 单一常量，**备份可用性检查与恢复后校验共用**，避免再次漂移。
新增 `SCHEMA_VERSION_MIN` / `SCHEMA_VERSION_MAX`，`verifyDatabase()` 同时检查上下限。

### 3.3 缺表备份的处理

逐表事务复制遍历的是**备份文件**里的表。若备份缺某张表，该表在目标库中原样保留，
复制"成功"，用户看到"恢复成功"但实际是新旧数据混合。

修复：`ProjectService.restoreBackup()` 在**前置检查阶段**用 `REQUIRED_TABLES` 校验备份完整性，
缺表直接拒绝并列出缺失表名，不进入恢复流程、不做安全副本。
底层 `restoreBackup()` 也做同样检查，作为第二道防线。

## 4. 恢复入口的前置检查与安全副本语义

明确区分两类失败：

| 类型 | 何时发生 | 是否需要安全副本 |
|---|---|---|
| **非破坏性前置检查失败** | 备份不存在、无法打开、缺表、有活动任务 | **不需要**——尚未进入恢复操作，当前数据未被触碰 |
| **已进入恢复操作后失败** | 复制过程中出错、校验不通过 | **必须有**——底层在任何复制前先做 `VACUUM INTO` 快照 |

最终规则：

1. `ProjectService` 先做前置检查（`projectId`、`dbPath`、`hasActiveWork`、文件存在、可打开、**表齐全**）；
2. 通过后调用底层 `replaceDatabase()`；
3. 底层**第一件事**是 `VACUUM INTO` 安全副本，然后才校验备份内容并复制；
4. 复制在单个事务内完成，失败则 `ROLLBACK`，当前数据不变；
5. 复制后经 `verifyDatabase()` 校验，不通过则报告失败并保留安全副本。

Renderer 收到的是 `{ ok, verified, safetyCopy, error }`，失败时 `error` 为中文可读原因。

## 5. 测试结果

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test` | 0 | **248/248** | `unit/full-suite.txt` |
| `node --test test/lock-heartbeat.test.js` | 0 | **12/12** | `integration/lock-loss.txt` |
| `node --test test/schema-integrity.test.js` | 0 | **16/16** | `integration/schema-integrity.txt` |
| `node --test test/backup-wal.test.js` | 0 | **7/7** | `integration/backup-wal.txt` |
| `node --test test/task-project-lock.test.js` | 0 | **9/9** | `integration/task-project-lock.txt` |
| `node --test test/project-backup-app.test.js` | 0 | **7/7** | `integration/backup-app.txt` |
| `node --test test/app-wiring.test.js` | 0 | **8/8** | `integration/app-wiring.txt` |
| PHASE 01-C 生命周期 | 0 | **36/36** | `regression/phase01c-lifecycle.txt` |
| PHASE 01-A 冒烟 | 0 | — | `regression/phase01a-ready.txt` |
| PHASE 01-A 进程终止 | 0 | **6/6** | `regression/phase01a-processes.txt` |
| PHASE 00 门禁 | 0 | PASS，0 泄漏 | `regression/phase00-gates.json` |

### 5.1 锁丢失专项测试的观测记录

| 测试 | 锁丢失前 | 锁丢失后 | 最终任务状态 |
|---|---|---|---|
| 锁丢失停止运行 | owner = 本任务 | owner = `task-thief` | `FAILED` / `PROJECT_LOCK_LOST` |
| 心跳定时器停止 | 心跳持续更新 | 心跳不再更新 | 同上 |
| 不释放他人锁 | owner = 本任务 | owner = `task-thief` 保留 | 同上 |
| 用户 stop 竞争 | owner = 本任务 | owner = `task-thief` | `FAILED` 或 `INTERRUPTED`，Runtime 只关一次 |
| dispose 竞争 | owner = 本任务 | 仅剩 `task-thief` 的锁 | 无残留、无未处理异常 |

### 5.2 全量套件的一次失败（如实记录）

首次全量运行 **247/248**，失败项为 `test/processes.test.js` 的
"A. the runtime this probe owns is captured, terminated and confirmed gone"，
断言"OS 不再列出该进程"。

- 单独复跑 2 次：均 6/6 通过；
- 全量重跑：248/248。

判断为并发负载下进程退出与 OS 进程表刷新之间的时序抖动。本轮未触碰 `processes.ts` 或 `dsh/` 任何文件。
原始失败输出保留在 `unit/full-suite.txt` 的首次记录中，未删除、未篡改。

## 6. 未做

| 类型 | 内容 |
|---|---|
| NOT_RUN | 安装包重建与安装后项目链路；`npm audit` / 静态吊销检查；真实 DSH 模型探针（本轮改动不涉及模型调用链路） |
| UNKNOWN | 无新增 |
| DEFERRED | 沿用 D-01D-1/2/3 |
| BLOCKED | 无 |

## 7. 历史保护

PHASE 00 / 01-A / 01-B / 01-C / 01-D / 01-D-remediation / 01-D-remediation-2 的证据、状态与 `spike/` 历史材料未被修改
（回归时被脚本覆写的已还原，diff 为空）。

## 8. 结论

两个问题均已修复并有真实调用链证据。状态 **`READY_FOR_EXTERNAL_REVIEW`**。
