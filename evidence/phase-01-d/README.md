# evidence/phase-01-d — 索引

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite.txt` | 应用全量测试 | **181/181**，0 失败 |
| `unit/project-tests.txt` | 本轮新增的项目测试 | **55/55** |
| `desktop/summary.json` | 桌面真实运行：创建→退出→重启→重开 | **9/9** |
| `regression/phase00-suite.txt` | PHASE 00 套件 | 166/166 |
| `regression/phase00-gates.json` | PHASE 00 三道门禁 | PASS，0 泄漏 |
| `regression/phase01a-*.txt` | PHASE 01-A 冒烟 | 退出码 0 |
| `regression/phase01b-mcp.txt` | PHASE 01-B MCP 握手 | 退出码 0 |
| `verification.json` | 命令总表与 D1–D15 验收 | — |

## 新增测试分布

| 文件 | 覆盖 |
|---|---|
| `test/project-store.test.js` | 表结构、v1→v2 迁移、迁移失败保护、任务归属、审批形状 |
| `test/project-paths.test.js` | 穿越、跨盘、UNC、junction 逃逸、前缀相似目录 |
| `test/project-locks.test.js` | 写锁互斥、构建锁互斥、过期锁回收、心跳、非持有者拒绝 |
| `test/project-service.test.js` | 创建/打开/关闭、非空目录拒绝、重启恢复、配置隔离 |
| `test/project-backup.test.js` | 备份可读、真实恢复、关联完整、损坏备份拒绝 |
| `test/project-rules.test.js` | 全局/项目规则、缺失文件、截断、状态解析 |

## 说明

证据中的绝对路径已脱敏为 `<abs-path>`。历史阶段证据（PHASE 00/01-A/01-B/01-C）未被修改。
