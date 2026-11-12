# PHASE 01-D 第二轮补正报告

> **状态：`READY_FOR_EXTERNAL_REVIEW`。** 本报告不宣告通过。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `phase/01-d-project-workspace` |
| 补正基线 | `53334cfef9e28fffb3867db1779dcd3f28cc8da4` |
| 盘点 | `docs/review-handoff/PHASE_01_D_REMEDIATION_2_AUDIT.md` |

## 2. 六个问题的修复

### 2.1 生产环境未启用项目锁

**问题**：`main.ts` 构造 `TaskService` 时没有传 `projectLocks` 和 `projectExists`。上一轮的测试自己 new 了 TaskService 并手动注入，所以"锁能用"成立、"应用用了锁"不成立。

**修复**：抽出 `src/main/app-wiring.ts` 的 `wireServices()`，`main.ts` 与测试调用同一个函数。项目查找是闭包，在 `ProjectService` 创建后立即生效；未就绪时抛 `WIRING_NOT_READY` 而不是放行。

### 2.2 projectId 全链路

**问题**：Preload 的 `createTask` 没有 `projectId`，Renderer 也不传。

**修复**：Renderer → Preload → IPC → TaskService → Store 全链路打通。打开项目时新任务默认归属该项目，任务表单显示归属提示；未打开项目时创建全局任务。**Main Process 校验 projectId 对应真实项目**，伪造的 id 被拒绝。

### 2.3 锁心跳缺失

**问题**：`TaskRunner` 从不调用 `heartbeat()`。`staleAfterMs` 默认 10 分钟，任何更长的合法任务，其锁会被判定过期并可被回收。

**修复**：取锁后启动心跳，间隔为 `staleAfterMs / 4`；释放时停止；心跳失败记 `task.project-lock.heartbeat-failed` 并停止假装持锁。

**过程中发现的缺陷**：间隔原本写成 `Math.max(1000, ...)`，当 stale 窗口短于 4 秒时，心跳比窗口还慢——测试用 400ms 窗口立刻暴露了它。

### 2.4 恢复检查用错集合

**问题**：`main.ts` 用 `runner.activeTasks.length > 0`，而 `#active` 在最终写库**之前**就被清空。

**修复**：暴露 `hasInFlightWork` / `inflightCount`（基于 `#inflight`，只读 getter，不暴露可变集合），恢复改用它。

### 2.5 安全副本不是一致性快照

**问题**：`fs.copyFileSync(dbPath, safetyPath)` 在 WAL 模式下会漏掉未 checkpoint 的事务。

**修复**：改用 `VACUUM INTO` 一致性快照。**并且把取副本提到所有校验之前**——原实现遇到"备份文件不存在"就提前返回，用户最需要副本的时刻反而没有副本。

### 2.6 恢复后校验形同虚设

**问题**：`projects.list().length >= 0 && schemaVersion >= 1`，前者恒真。

**修复**：新增 `verifyDatabase()`：必需表存在 + `PRAGMA integrity_check` + `PRAGMA foreign_key_check` + schema 版本在支持范围内。

## 3. 数据库连接所有权

恢复采用**事务内逐表复制行**，不替换文件，因此连接始终有效、无需关闭。`TaskStore` 是唯一连接所有者；`ProjectService` 通过 `store.db` 访问同一连接。上一轮遗留的 `closeDatabase` 路径已不再需要，文档注释已相应修正。

## 4. 测试结果

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test` | 0 | **227/227** | `unit/full-suite.txt` |
| `node --test test/app-wiring.test.js` | 0 | **8/8** | `integration/app-wiring.txt` |
| `node --test test/lock-heartbeat.test.js` | 0 | **7/7** | `integration/lock-heartbeat.txt` |
| `node --test test/backup-wal.test.js` | 0 | **7/7** | `integration/backup-wal.txt` |
| `node --test test/task-project-lock.test.js` | 0 | **9/9** | `integration/task-project-lock.txt` |
| `node --test test/project-backup-app.test.js` | 0 | **7/7** | `integration/backup-app.txt` |
| `node --test test/project-resolve-path.test.js` | 0 | **8/8** | `integration/resolve-path.txt` |
| PHASE 01-C 生命周期回归 | 0 | **36/36** | `regression/phase01c-lifecycle.txt` |
| PHASE 01-A 冒烟 | 0 | — | `regression/phase01a-ready.txt` |
| 桌面项目冒烟 | 0 | — | `regression/desktop-projects.txt` |
| PHASE 00 门禁 | 0 | PASS，0 泄漏 | `regression/phase00-gates.json` |

**测试真实性**：

- 生产装配测试调用 `wireServices()`，不是自己 new TaskService；
- 心跳测试用 400ms 窗口 + 运行超过窗口的任务，不是短任务；
- WAL 测试不关闭数据库、不手动 checkpoint；
- 无 SKIPPED 计入 PASS。

## 5. 未做

| 类型 | 内容 |
|---|---|
| NOT_RUN | 安装包重建与安装后项目链路；`npm audit` / 静态吊销检查 |
| UNKNOWN | 无新增 |
| DEFERRED | 沿用 D-01D-1/2/3 |
| BLOCKED | 无 |

## 6. 历史保护

PHASE 00 / 01-A / 01-B / 01-C / 01-D / 01-D-remediation 的证据、状态与 `spike/` 历史材料未被修改（回归时被脚本覆写的已还原，diff 为空）。

## 7. 结论

六个问题均已修复并有真实调用链证据。状态 **`READY_FOR_EXTERNAL_REVIEW`**。
