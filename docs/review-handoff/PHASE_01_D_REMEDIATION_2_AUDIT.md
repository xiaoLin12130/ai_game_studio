# PHASE 01-D 第二轮补正：只读盘点

- 基线：`53334cfef9e28fffb3867db1779dcd3f28cc8da4`
- 方式：只读检查源码，未修改任何文件

## 1. 正式启动时 TaskService 的构造参数

`main.ts` 中：

```ts
tasks = new TaskService({
  logger, userDataDir,
  dshHome, profile, provider, model, cwd, entryPath,
})
```

**没有 `projectLocks`，没有 `projectExists`。** 两者只在测试里手动注入。

## 2. ProjectLocks 是否传给生产 TaskRunner

**没有。** `TaskService` 把 `options.projectLocks` 透传给 `TaskRunner`，但生产环境该值为 `undefined`，
所以 `#acquireProjectLock()` 第一行就返回 `{ ok: true }`——生产环境**从不取项目锁**。

## 3. projectExists 是否注入生产环境

**没有。** `TaskService.create()` 里 `const exists = this.#options.projectExists ? ... : true`，
生产环境走 `true` 分支，即**任何 projectId 都被接受**，包括不存在的。

## 4. Renderer 创建任务时是否传递 projectId

**没有。** `preload.ts` 的 `createTask(request: { title, goal, type?, isolation? })` 没有 `projectId` 字段；
`renderer.ts` 的 `submitTaskForm` 也不传。

## 5. 项目选择与任务创建之间的真实关系

**没有关系。** 项目页与任务面板是两个独立区域，`currentProjectId` 只用于项目页的按钮状态，
任务创建完全不读它。

## 6. TaskRunner 取得锁、心跳、释放锁的路径

| 动作 | 现状 |
|---|---|
| 取得 | `#acquireProjectLock()` 在 `#execute()` 开头调用（生产环境因缺依赖而空转） |
| **心跳** | **0 处调用**。`ProjectLocks.heartbeat()` 存在但无人调用 |
| 释放 | `#releaseProjectLock()` 在停止、失败、验收失败、异常、dispose 五处调用 |

心跳缺失的后果：`staleAfterMs` 默认 10 分钟，任何超过 10 分钟的写任务，其锁会被判定为过期并可被回收——
即"另一个任务可以抢走仍在合法运行的任务的锁"。

## 7. #active 与 #inflight 各自代表什么

| 集合 | 含义 | 生命周期 |
|---|---|---|
| `#active` | 正在执行的任务（含 sessionId、lease） | 在**最终写库之前**删除 |
| `#inflight` | 完整执行 promise | 直到 `#execute()` 全部结束（含写库）才移除 |

`main.ts` 的 `hasActiveWork` 用的是 `runner.activeTasks.length > 0`，即 `#active`。
**这是错的**：任务收尾写库期间 `#active` 已空，恢复会被放行，而此时数据库正在被写。

## 8. 恢复前安全副本是否包含未 checkpoint 的 WAL 数据

**不包含。** `backup.ts` 用 `fs.copyFileSync(dbPath, safetyPath)` 直接复制主文件。
WAL 模式下未 checkpoint 的事务在 `-wal` 里，主文件不含这些数据，因此安全副本**可能丢失最近的写入**。

## 9. 恢复完成后 TaskStore 的连接是否指向当前有效数据库

**是**，但路径绕：`closeDatabase` 关闭旧连接 → `restoreBackup` 逐表复制行 → `reopenDatabase` 新建连接 →
`TaskStore.adopt()` 换掉句柄。`ProjectService` 自己持有的 `this.store` 仍指向旧 `DatabaseSync` 对象，
不过它每次操作都走 `this.store.db`，而 `adopt()` 更新了该字段，所以实际可用。

风险：`ProjectService` 与 `TaskService` 共享同一个 `TaskStore` 实例，`adopt()` 只改一处，这是对的；
但如果将来有人另建连接就会失配。文档需要写明"只有一个连接所有者"。

## 10. 恢复后的数据校验能否发现缺表、损坏、外键断裂和关联丢失

**不能。** 当前校验是：

```ts
projects.list().length >= 0 && reopened.schemaVersion >= 1
```

`length >= 0` 恒为真。没有 `PRAGMA integrity_check`，没有 `PRAGMA foreign_key_check`，
没有必需表检查，没有关联可读性检查。

## 结论

| 评审指出的问题 | 是否成立 |
|---|---|
| 生产环境未启用 ProjectLocks / projectExists | **成立** |
| Renderer/Preload 未传 projectId | **成立** |
| 锁心跳缺失 | **成立**（0 处调用） |
| 恢复检查用 `#active` 而非 `#inflight` | **成立** |
| 安全副本用文件复制而非一致性快照 | **成立** |
| 恢复后校验形同虚设 | **成立** |
