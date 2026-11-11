# evidence/phase-01-c — 索引

所有原始日志都是 `.txt`（`*.log` 被 `.gitignore` 忽略，本项目已因此丢过一次证据），已脱敏为 `<abs-path>`。

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite-1.txt` / `unit/full-suite-2.txt` | 应用全量测试，连续两次 | **90/90，0 失败**（各一次） |
| `unit/supervisor-race.txt` | Runtime 关闭竞态测试 | **6/6** |
| `real-dsh/integration.txt` | 真实 DSH + 真实模型回合 | 2/2 |
| `real-dsh/isolated-1/2/3.txt` | 隔离连续三次 | 各 2/2，退出码 0 |
| `packaged/summary.json` | **安装版场景 A/B/C** | 34/34 断言 |
| `packaged/mcp-tool-call.json` | **安装版 MCP 真实工具调用**（本轮补跑） | `toolCalled: true` |
| `regression/phase00-suite.txt` | PHASE 00 套件 | 166/166 |
| `regression/phase00-gates.json` | PHASE 00 三道门禁 | PASS，0 泄漏 |
| `regression/phase01a-failure.txt` | **PHASE 01-A failure 冒烟**（本轮补跑） | 退出码 0 |
| `regression/phase01a-ready.txt` / `phase01a-quit.txt` | PHASE 01-A 其余冒烟 | 退出码 0 |
| `regression/phase01b-mcp.txt` | PHASE 01-B MCP 握手（开发环境） | 退出码 0 |
| `verification.json` | 上述命令的总表（逐条列出文件路径，无通配符） | — |

## 安装版场景（`packaged/summary.json`）

- **A 正常完成**：真实模型回合 → 验收 SUCCEEDED → `disposeHadNoFailure` → 进程表 `ABSENT` → 无残留 GUI。
- **B 中断恢复**：INTERRUPTING → INTERRUPTED → resume 复用原 session → 新 attempt → 终态 → `disposeHadNoFailure` → 进程表 `ABSENT`。
- **C 崩溃恢复**：运行中 `app.exit(9)` → 崩溃后进程表检查（`crashLeftNoOrphan`）→ 重启识别 INTERRUPTED → 恢复 → 新 attempt → 干净退出。

进程检查复用 PHASE 01-A 已验证的进程表（`createProcessTable`），按 DSH home 认领，查询失败记为 `FAILED` 而不是"没找到即没有"。
