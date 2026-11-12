# PHASE 01-D 补正：只读调用链盘点

- 盘点基线：`bacd0eb0587d3d288b928209c383b6204b21c8d6`
- 方式：只读检查源码与调用点计数，未修改任何文件

## 1. 任务创建、执行、停止、恢复、重试的实际调用链

```
Renderer  renderer.ts
   └─ window.studio.createTask / actOnTask        (preload 白名单)
        └─ ipc.ts  studio:tasks:create / studio:tasks:act
             └─ TaskService.create / act
                  └─ TaskRunner.start / stop / resume / retry / cancel
                       ├─ RuntimeSupervisor.acquire   (Runtime 租约)
                       ├─ store.createAttempt / transition
                       └─ client.prompt → 观察事件 → 验收 → transition
```

## 2. project_id 能否从 UI 传到数据库和 TaskRunner

**不能。** 实测计数：

| 文件 | `projectId` / `project_id` 出现次数 |
|---|---|
| `projects/service.ts` | 10（项目自身） |
| `projects/store.ts` | 35（项目表） |
| `projects/locks.ts` | 35（锁表） |
| `tasks/store.ts` | 9（仅 v2 迁移里的列定义与索引） |
| `tasks/types.ts` | **0** |
| `tasks/service.ts` | **0** |
| `tasks/runner.ts` | **0** |
| `ipc.ts` | 1（仅 `projectBackup` 的参数名） |

结论：数据库有 `tasks.project_id` 列，但**没有任何代码写入它**，也没有从 IPC 传下来。
`CreateTaskRequest` 没有 `projectId` 字段，`TaskRecord` 也没有。

## 3. ProjectLocks 是否被真实任务执行流程调用

**没有。** `ProjectLocks` 只在 `projects/service.ts` 里被构造（3 处引用，均为字段声明与实例化），
`tasks/service.ts` 与 `tasks/runner.ts` 对它的引用为 **0**。

即：锁类可用且有 13 项独立测试，但任务执行路径从不获取它。

## 4. 项目路径解析方法的调用方

| 方法 | 调用方 |
|---|---|
| `assertInsideProject` / `resolveInsideProject`（`paths.ts`） | 只有 `projects/rules.ts` 与测试 |
| `ProjectService.resolveProjectPath` | **无调用方**；且其实现是裸 `path.resolve()`，**不做包含校验** |

`resolveProjectPath` 目前是死代码，但它是一个公开方法，一旦被接上就是绕过入口。

## 5. 备份与恢复函数的调用方

| 函数 | 调用方 |
|---|---|
| `createBackup` | 只有 `test/project-backup.test.js` |
| `restoreBackup` | 只有 `test/project-backup.test.js` |

`ipc.ts` 的 `studio:projects:backup` 处理器**不调用**这两个函数，只返回项目数据目录。
Preload 与 Renderer 没有备份/恢复入口。

## 6. SQLite 连接由谁持有

`TaskService` 构造时创建 `TaskStore`（`new TaskStore(dbPath)`），`TaskStore` 持有 `DatabaseSync`。
`ProjectService` 复用同一个连接（`db: tasks.store.db`）。
连接在 `TaskService.dispose()` 里通过 `store.close()` 关闭，即**应用退出时**。
运行期间连接始终打开，WAL 模式。

## 7. 备份恢复如何在不破坏连接与 WAL 的前提下执行

当前 `restoreBackup` 直接 `fs.copyFileSync` 覆盖数据库文件，这要求**没有活动连接**。
单元测试里能成立是因为测试先 `store.close()` 再恢复；应用运行中做不到。

因此在线恢复必须：

1. 拒绝在有活动任务时恢复（否则会覆盖正在写入的库）；
2. 关闭当前连接；
3. 执行恢复（含恢复前安全副本）；
4. 重新打开连接；
5. 通过正常 Store 读回校验；
6. 任一步失败都要保证 Studio 不会继续使用损坏连接。

## 8. 结论

评审指出的三个问题全部成立，且都不是"已有代码覆盖"：

| 问题 | 状态 |
|---|---|
| `resolveProjectPath` 无包含校验 | 确认，且是公开方法 |
| `ProjectLocks` 未接入任务链路 | 确认，`projectId` 全链路缺失 |
| 备份恢复无应用调用链 | 确认，IPC 处理器是空壳 |
