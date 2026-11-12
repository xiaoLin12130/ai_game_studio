# PHASE 01-D 第三轮补正：只读盘点

- 基线：`2e061d8c4ababc98bc3e8f33b8e01b633ac0a2f9`
- 方式：只读检查源码与迁移定义，未修改任何文件

## 1. 心跳失败当前的实际行为

`runner.ts` 的 `#startHeartbeat()`：

```ts
const timer = setInterval(() => {
  try {
    this.#projectLocks!.heartbeat(projectId, 'write', taskId)
  } catch (error) {
    this.#logger.error('task.project-lock.heartbeat-failed', {...})
    this.#stopHeartbeat(taskId)
  }
}, interval)
```

**catch 里只有两个动作：记日志、停定时器。** 没有停止 Runtime，没有迁移任务状态。

后果：任务继续执行 `observe()`，继续走 `VERIFYING`，最后可能被验收为 `SUCCEEDED`——
而此时项目锁可能已被另一个任务回收，两个任务同时在写同一个项目。

## 2. 现有可复用的停止机制

| 方法 | 作用 | 幂等性 |
|---|---|---|
| `#stopActive(active, reason)` | `active.lease.release()` 关闭 Runtime，然后从 `#active` 删除 | **是**，`active.stopping` 守卫，重复调用直接返回 |
| `#onRuntimeExited(event)` | Runtime 自行退出时清理 active、结束 attempt、迁移到 INTERRUPTED | 依赖 `#active` 是否存在 |
| `#fail(taskId, code, message)` | 迁移到 FAILED 并写事件 | 已 settled 状态（FAILED/CANCELLED/SUCCEEDED/INTERRUPTED）时跳过 |
| `#releaseProjectLock(taskId)` | 停心跳 + 按 ownerId 释放锁 | 是，`heldLocks` 无记录即返回 |

结论：**不需要新建 Runtime 控制逻辑**，`#stopActive` 的 `stopping` 守卫已经能吸收"用户 stop 与心跳失败同时发生"的重复关闭。

## 3. 竞争窗口

| 场景 | 现状 |
|---|---|
| 心跳失败时任务正在 `observe()` | `observe` 不会被打断，会一直等到事件或超时 |
| 用户同时 stop | `active.stopping` 已置位，锁丢失路径不会再关一次 |
| Runtime 同时退出 | `#onRuntimeExited` 删 active 并迁 INTERRUPTED；锁丢失路径找不到 active |
| 任务已进入 `VERIFYING` | 校验通过就会 `SUCCEEDED`，**这是最危险的窗口** |
| `dispose` 同时发生 | `waitForIdle` + `releaseAllProjectLocks`，需避免在已关闭的库上写 |

## 4. 必需表清单：以迁移代码为准

`tasks/store.ts` 的 `MIGRATIONS` 中 `CREATE TABLE IF NOT EXISTS` 共 **13** 张：

```
schema_version  tasks         task_transitions  attempts
sessions        runtimes      verifications     events
projects        project_configs  project_events  approvals
project_locks
```

当前 `verifyLiveDatabase()` 只传 5 张：

```ts
['schema_version', 'tasks', 'projects', 'attempts', 'sessions']
```

**缺 8 张**：`task_transitions`、`runtimes`、`verifications`、`events`、`project_configs`、`project_events`、`approvals`、`project_locks`。

同时 `backup.ts` 的 `REQUIRED_TABLES` 只有 `['schema_version', 'tasks', 'projects']`——**两套清单不一致**，
且都比真实 schema 宽松。

## 5. 逐表事务复制在缺表场景下的行为

`restoreBackup` 遍历**备份文件**里的表，对每张表先 `DELETE` 再插入。若备份缺某张表：

- 该表在目标库里**原样保留**（不会被删），复制"成功"；
- `readTables(dbPath)` 能列出全部表，所以看起来一切正常；
- 用户会看到一个"恢复成功"但实际是新旧数据混合的数据库。

**这是真实缺陷**：必须在复制前用统一清单校验备份的完整性，缺表直接拒绝。

## 6. `ProjectService.restoreBackup()` 的前置检查与底层顺序

当前 `ProjectService.restoreBackup()` 顺序：

1. 校验 `projectId` 非空；
2. 校验 `#dbPath`/`#reopenDatabase` 存在；
3. 校验 `hasActiveWork()`；
4. 校验备份文件存在；
5. `readTables(backupFile)` 能否打开；
6. **调用 `replaceDatabase()`**——底层此时先做安全副本，再做表校验。

**语义差异**：步骤 4/5 属于"还没进入恢复操作"的**非破坏性前置检查**，此时无需副本，是对的；
一旦通过这些检查进入第 6 步，就必须先有安全副本。

但步骤 5 只验证"能打开"，不验证"表齐全"，所以缺表备份会通过前置检查进入恢复流程。
修复方案：**把完整性校验提到 `ProjectService` 的前置检查里**（缺表直接拒绝，不进入恢复、不做副本），
同时**保留底层在任何复制前先做安全副本**的顺序，两层各司其职。

## 7. 结论

| 评审指出 | 是否成立 |
|---|---|
| 心跳失败后写任务不停止 | **成立** |
| 恢复校验未覆盖全部必需表 | **成立**（5/13，且与备份检查清单不一致） |
| 缺表备份会被误判为完整恢复 | **成立**（逐表复制会保留目标库旧数据） |
