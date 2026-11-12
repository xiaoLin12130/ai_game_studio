# evidence/phase-01-d-remediation — 索引

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite.txt` | 应用全量测试 | **205/205** |
| `integration/resolve-path.txt` | 路径解析集成测试 | **8/8** |
| `integration/task-project-lock.txt` | 任务项目锁集成测试 | **9/9** |
| `integration/backup-app.txt` | 在线备份恢复集成测试 | **7/7** |
| `regression/phase01c-lifecycle.txt` | PHASE 01-C 生命周期回归 | **36/36** |
| `regression/phase01a-ready.txt` | PHASE 01-A 冒烟 | 退出码 0 |
| `regression/desktop-projects.txt` | 桌面项目冒烟 | 退出码 0 |
| `regression/phase00-gates.json` | PHASE 00 门禁 | PASS，0 泄漏 |
| `verification.json` | 命令总表与三个问题的结论 | — |

## 三个问题的结论

1. **路径安全**：`resolveProjectPath` 现在经 `assertInsideProject`，空路径显式拒绝。8 项测试直接调用该方法。
2. **项目锁**：`projectId` 从 IPC 打通到数据库；写入型项目任务在启动 Runtime **之前**取写锁，只读任务不取；9 项测试走 TaskService/TaskRunner 真实链路。
3. **备份恢复**：恢复改为在事务内逐表复制行，不替换文件，因此活动连接无需关闭；恢复前写安全副本，恢复后经正常 Store 校验。7 项测试覆盖在线恢复。

历史阶段证据（PHASE 00/01-A/01-B/01-C/01-D）未被修改。
