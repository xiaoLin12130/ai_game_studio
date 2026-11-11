# evidence/phase-01-c — 索引

每一条都能对应到下面的命令、退出码与原始输出。原始日志统一用 `.txt`（`*.log` 被 `.gitignore` 忽略），并已脱敏为 `<abs-path>` / `<repo>`。

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite.txt` | 应用全量测试 | 84/84，0 失败 |
| `real-dsh/final-integration.txt` | 真实 DSH + 真实模型回合 | 2/2 |
| `real-dsh/isolated-{1,2,3}.txt` | 隔离连续 3 次 | 3/3 退出码 0 |
| `packaged/summary.json` | **安装版场景 A/B/C** | 24/24 断言 |
| `regression/phase00-suite.txt` | PHASE 00 套件 | 166/166 |
| `regression/phase00-gates.json` | PHASE 00 三道门禁 | PASS，0 泄漏 |
| `regression/phase01a-{ready,quit}.txt` | PHASE 01-A 桌面冒烟 | 退出码 0 |
| `regression/phase01b-mcp.txt` | PHASE 01-B MCP 握手 | 退出码 0 |
| `verification.json` | 上述命令的总表 | — |

## 安装版场景（`packaged/summary.json`）

- **A 正常完成**：创建任务 → 真实模型回合 → Studio 验收 → SUCCEEDED → 无残留 runtime / 无残留 GUI 进程。
- **B 中断恢复**：启动 → 停止（经 INTERRUPTING）→ INTERRUPTED → resume → 同一 session → 新 attempt → 终态。
- **C 崩溃恢复**：运行中 `app.exit(9)`（无优雅关闭）→ 重启 → 识别 INTERRUPTED → 恢复 → 新 attempt → 干净退出。

## 已知缺口

安装包本身（约 226 MB）不入库；SHA-256 与大小记录在 `verification.json`。
