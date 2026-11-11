# PHASE 01-C 工作报告 — DSH Session 生命周期与 Studio Task 状态管理

> **状态：`READY_FOR_EXTERNAL_REVIEW`。** 本报告不宣告通过，是否关闭由外部独立评审决定。

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

## 5. 本轮发现并修掉的缺陷

这三个都是"跑真东西"才暴露的，不是设计推演出来的：

| 编号 | 级别 | 问题 | 修复 |
|---|---|---|---|
| F-01C-1 | **P1** | 任务 runtime 里没有任何 provider row，所有任务静默跑在 `deepseek-official` 路由上，以 `MISSING_CREDENTIAL` 失败，却被表象成"没有 assistant 消息" | TaskService 为 commandcode 生成 cordis patch 交给 supervisor |
| F-01C-2 | **P1** | 会话尚未开始工作时的第一个 `idle` 被当作回合结束，任务 100ms 内以 0 事件"完成" | 只有出现过活动之后的 idle 才结束回合 |
| F-01C-3 | P2 | 启动健康探测与任务 runtime 同父进程，身份捕获歧义时拒绝（安全但报 UNKNOWN） | 任务场景下跳过启动探测 |

F-01C-1 值得单独说明：它是最危险的一类失败——任务看起来"跑了"，实际连模型都没调用，而错误信息指向一个不相关的环节。

## 6. 安装版验证（本轮核心）

真实安装包（NSIS，237,547,404 字节），静默安装后运行三个场景，**24/24 断言通过**（`evidence/phase-01-c/packaged/summary.json`）：

| 场景 | 内容 | 结果 |
|---|---|---|
| A 正常完成 | 创建任务 → 真实模型回合 → Studio 验收 → SUCCEEDED → 无残留 runtime、无残留 GUI 进程 | PASS |
| B 中断恢复 | 启动 → 停止（经 INTERRUPTING）→ INTERRUPTED → resume → **同一 session** → 新 attempt → 终态 | PASS |
| C 崩溃恢复 | 运行中 `app.exit(9)`（无优雅关闭）→ 重启 → 识别 INTERRUPTED → 恢复 → 新 attempt → 干净退出 | PASS |

C 场景是真实的异常退出，不是故障注入：进程被直接结束，没有 shutdown、没有 runtime close。

## 7. 测试与回归

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test`（应用全量） | 0 | **84/84**，0 失败 | `unit/full-suite.txt` |
| `node --test test/task-integration.test.js` | 0 | **2/2**（真实 DSH + 真实模型） | `real-dsh/final-integration.txt` |
| 隔离连续 3 次 | 0 | 3/3 | `real-dsh/isolated-{1,2,3}.txt` |
| `node tests/run-tests.mjs`（PHASE 00） | 0 | **166/166** | `regression/phase00-suite.txt` |
| `node scripts/run-gates.mjs`（PHASE 00 门禁） | 0 | PASS，0 泄漏 | `regression/phase00-gates.json` |
| `node scripts/smoke.mjs ready`（01-A） | 0 | — | `regression/phase01a-ready.txt` |
| `node scripts/smoke.mjs quit-during-probe`（01-A） | 0 | — | `regression/phase01a-quit.txt` |
| `node scripts/mcp-probe.mjs`（01-B） | 0 | — | `regression/phase01b-mcp.txt` |

关于上一轮"满套件不稳定"：本轮定位到**不是**模型或限流问题，而是我自己的断言取样太早（任务刚到 SUCCEEDED 就检查 runtime 是否已回收，而 `release()` 在下一拍才关完）。改成等待回收后，满套件连续通过。

## 8. 证据

`evidence/phase-01-c/README.md` 索引，总表 `verification.json`。所有原始输出是 `.txt`——`*.log` 被 `.gitignore` 忽略，这个项目已经因此丢过一次证据。

## 9. UNKNOWN / DEFERRED

| 类型 | 内容 |
|---|---|
| UNKNOWN | U-01C-1 第三方 Provider 限流/额度波动对长回合任务的影响 |
| DEFERRED | D-01C-1 任务面板之外的会话事件流可视化 |
| BLOCKED | 无 |

## 10. 结论

原始目标 1–8 全部实现并有证据；安装版 A/B/C、三方回归、门禁均通过；无已知 P0/P1 遗留。

状态：**`READY_FOR_EXTERNAL_REVIEW`**，等待外部独立评审。
