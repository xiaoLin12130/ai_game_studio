# evidence/phase-01-d-remediation-3 — 索引

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite.txt` | 应用全量测试 | **248/248** |
| `integration/lock-loss.txt` | 锁心跳与锁丢失专项 | **12/12** |
| `integration/schema-integrity.txt` | 数据库完整性专项 | **16/16** |
| `integration/backup-wal.txt` | WAL 安全副本 | **7/7** |
| `integration/task-project-lock.txt` | 项目锁集成 | **9/9** |
| `integration/backup-app.txt` | 在线备份恢复 | **7/7** |
| `integration/app-wiring.txt` | 生产装配 | **8/8** |
| `regression/phase01c-lifecycle.txt` | PHASE 01-C 生命周期 | **36/36** |
| `regression/phase01a-ready.txt` | PHASE 01-A 冒烟 | 退出码 0 |
| `regression/phase01a-processes.txt` | PHASE 01-A 进程终止 | **6/6** |
| `regression/phase00-gates.json` | PHASE 00 门禁 | PASS，0 泄漏 |
| `verification.json` | 命令总表与两个问题的结论 | — |

## 关于全量套件的一次失败

首次全量运行 247/248，失败项是 `test/processes.test.js` 的
"A. the runtime this probe owns is captured, terminated and confirmed gone"，
断言为"OS 不再列出该进程"。该测试单独复跑 2 次均 6/6 通过，全量重跑 248/248。

判断：并发负载下进程退出与 OS 进程表刷新之间的时序抖动，与本轮改动无关
（本轮未触碰 `processes.ts` 或 `dsh/` 任何文件）。原始失败输出保留在
`unit/full-suite.txt` 的首次运行记录中，未删除。

## 关键点

- **锁丢失**：心跳失败 → 停止 Runtime → 任务记 `PROJECT_LOCK_LOST` → 不得通过验收。
- **必需表**：13 张，从迁移代码提取，备份检查与恢复校验共用同一常量。
- **缺表备份**：恢复前拒绝，不进入逐表复制，不产生半新半旧的数据库。

历史阶段证据（PHASE 00/01-A/01-B/01-C/01-D/01-D-remediation/01-D-remediation-2）未被修改。
