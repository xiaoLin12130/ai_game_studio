# PHASE 01-D 补正报告

> **状态：`READY_FOR_EXTERNAL_REVIEW`。** 本报告不宣告通过。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `phase/01-d-project-workspace` |
| 补正基线 | `bacd0eb0587d3d288b928209c383b6204b21c8d6` |
| 盘点 | `docs/review-handoff/PHASE_01_D_REMEDIATION_AUDIT.md` |

## 2. 三个问题的修复

### 2.1 路径安全

**问题**：`ProjectService.resolveProjectPath()` 直接 `path.resolve()`，不做包含校验。盘点还发现空路径会解析成项目根目录本身，被"在项目内"的检查放过。

**修复**：统一经 `assertInsideProject()`（真实路径解析 + 分段比较 + junction 检查），空路径显式拒绝。

**测试**：`test/project-resolve-path.test.js` 8 项，**直接调用 `resolveProjectPath()`**，覆盖正常路径、`..`、多层 `../../`、绝对路径越界、未知项目、空路径、真实 junction 逃逸、尚不存在的路径。

### 2.2 项目锁

**问题**：`ProjectLocks` 有 13 项独立测试，但 `TaskService`/`TaskRunner` 从未调用它；`projectId` 在 `tasks/types.ts`、`tasks/service.ts`、`tasks/runner.ts` 中出现次数均为 0。

**修复**：

- `tasks.project_id` 打通 IPC → TaskService → Store → TaskRecord；
- 写入型项目任务在**启动 Runtime 之前**取写锁，冲突时任务直接 `FAILED/PROJECT_LOCKED`，不会先起 Runtime 再发现；
- 只读任务不取锁，可同项目并行；
- 停止、失败、验收失败、异常、dispose 全部释放；
- `dispose` 顺序改为：停 Runtime → 等执行结束 → 释放锁 → 关库。

**过程中发现的两个真实缺陷**（不是测试问题）：

1. `dispose` 先释放锁再停 Runtime，仍在收尾的任务会重新取锁——顺序反了；
2. `waitForIdle` 只等 `#active` 映射，而该映射在最终写库之前就被删除，导致关库时仍有写入。改为跟踪完整执行 promise。

**测试**：`test/task-project-lock.test.js` 9 项，全部经 `TaskService.act()` 真实链路。

### 2.3 备份恢复

**问题**：IPC 的 `projectBackup` 只返回数据目录，`createBackup`/`restoreBackup` 无任何调用方；且原实现用 `fs.copyFileSync` 覆盖数据库文件，在连接打开时不可行。

**修复**：

- `ProjectService.createBackup()` / `restoreBackup()` + IPC + Preload + 项目详情页按钮；
- 备份用 `VACUUM INTO` 写到 `<dataDir>/<projectId>/backups/studio-<时间戳>.db`；
- **恢复改为在事务内逐表复制行**，不替换文件——因此活动连接无需关闭，也不存在 WAL 句柄问题；
- 恢复前写 `pre-restore-*.db` 安全副本；
- 恢复后经正常 Store 读回校验；
- 有任务在跑时拒绝恢复。

**为什么不用文件替换**：实测在 Windows 上 `close()` 之后 `-wal`/`-shm` 句柄仍可能被占用（同进程其他连接、或系统延迟释放），删不掉就替换会导致旧 WAL 帧被重放进新库。逐表复制在 SQLite 内部完成，事务保证要么全成要么全不变。

**测试**：`test/project-backup-app.test.js` 7 项，连接保持打开状态下完成备份与恢复。

## 3. 测试结果

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test` | 0 | **205/205** | `unit/full-suite.txt` |
| `node --test test/project-resolve-path.test.js` | 0 | **8/8** | `integration/resolve-path.txt` |
| `node --test test/task-project-lock.test.js` | 0 | **9/9** | `integration/task-project-lock.txt` |
| `node --test test/project-backup-app.test.js` | 0 | **7/7** | `integration/backup-app.txt` |
| PHASE 01-C 生命周期回归 | 0 | **36/36** | `regression/phase01c-lifecycle.txt` |
| PHASE 01-A 冒烟 | 0 | — | `regression/phase01a-ready.txt` |
| 桌面项目冒烟 | 0 | — | `regression/desktop-projects.txt` |
| PHASE 00 门禁 | 0 | PASS，0 泄漏 | `regression/phase00-gates.json` |

## 4. 未做

| 类型 | 内容 |
|---|---|
| NOT_RUN | 安装包重建与安装后项目链路；`npm audit` / 静态吊销检查 |
| UNKNOWN | 无新增 |
| DEFERRED | 沿用 PHASE 01-D 的 D-01D-1/2/3 |
| BLOCKED | 无 |

## 5. 历史保护

PHASE 00 / 01-A / 01-B / 01-C / 01-D 的证据、状态与 `spike/` 历史材料未被修改（回归时被脚本覆写的已还原，diff 为空）。

## 6. 结论

三个问题均已修复并有真实调用链测试。状态 **`READY_FOR_EXTERNAL_REVIEW`**。
