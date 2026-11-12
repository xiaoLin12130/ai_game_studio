# evidence/phase-01-d-remediation-2 — 索引

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite.txt` | 应用全量测试 | **227/227** |
| `integration/app-wiring.txt` | 生产装配集成测试 | **8/8** |
| `integration/lock-heartbeat.txt` | 锁心跳与释放路径 | **7/7** |
| `integration/backup-wal.txt` | WAL 安全副本与恢复校验 | **7/7** |
| `integration/task-project-lock.txt` | 项目锁集成 | **9/9** |
| `integration/backup-app.txt` | 在线备份恢复 | **7/7** |
| `integration/resolve-path.txt` | 路径解析 | **8/8** |
| `regression/phase01c-lifecycle.txt` | PHASE 01-C 生命周期回归 | **36/36** |
| `regression/phase01a-ready.txt` | PHASE 01-A 冒烟 | 退出码 0 |
| `regression/desktop-projects.txt` | 桌面项目冒烟 | 退出码 0 |
| `regression/phase00-gates.json` | PHASE 00 门禁 | PASS，0 泄漏 |
| `verification.json` | 命令总表与六个问题的结论 | — |

## 关键点

- **生产装配**：`test/app-wiring.test.js` 调用 `wireServices()`——与 `main.ts` 同一个函数，不是自己 new TaskService。
- **心跳**：`staleAfterMs` 设为 400ms，任务运行超过该窗口仍持锁；心跳间隔为窗口的 1/4。
- **WAL**：测试不关闭数据库、不手动 checkpoint，安全副本必须包含仅在 WAL 中的写入。
- **校验**：`verifyDatabase()` 检查必需表、`PRAGMA integrity_check`、`PRAGMA foreign_key_check`、schema 版本范围。

历史阶段证据（PHASE 00/01-A/01-B/01-C/01-D/01-D-remediation）未被修改。
