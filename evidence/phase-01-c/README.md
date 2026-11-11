# evidence/phase-01-c — 索引（R2）

所有原始日志是 `.txt`（`*.log` 被 `.gitignore` 忽略），已脱敏为 `<abs-path>`。

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite-1.txt` / `unit/full-suite-2.txt` | 应用全量测试，连续两次 | **101/101，0 失败**（各一次） |
| `unit/supervisor-race.txt` | Runtime 关闭竞态（6）+ 启动失败清理（3） | **9/9** |
| `unit/process-identity.txt` | 进程身份判定四态 | **8/8** |
| `real-dsh/integration.txt` | 真实 DSH + 真实模型回合 | 2/2 |
| `real-dsh/isolated-1/2/3.txt` | 隔离连续三次 | 各 2/2 |
| `packaged/summary.json` | **安装版 A/B/C（R2，身份复核）** | **38/38** |
| `packaged/mcp-tool-call.json` | 安装版 MCP 真实工具调用 | `toolCalled: true` |
| `regression/phase00-suite.txt` / `phase00-gates.json` | PHASE 00 套件与门禁 | 166/166，PASS，0 泄漏 |
| `regression/phase01a-*.txt` | PHASE 01-A 三个冒烟 | 退出码 0 |
| `regression/phase01b-mcp.txt` | PHASE 01-B MCP 握手（开发环境） | 退出码 0 |
| `verification.json` | 本轮真实执行的命令总表 | — |

## 安装版进程检查（R2 的关键改动）

**不再**使用 DSH home 字符串匹配：home 通过环境变量传递，运行中的 Runtime 命令行里没有它，
用 home 匹配会在进程活着时返回 ABSENT——上一轮的"无残留"结论因此被判定 **INVALID**。

现在用 PHASE 01-A 的实例身份：

1. Runtime 运行时用 `captureRuntimeIdentity` 捕获「父进程 + dsh CLI + `creationMs`」；
2. 退出（或崩溃）后用 `verifyRuntimeIdentity` 复核同一个 `(pid, creationMs)`；
3. 判定四态 `PRESENT` / `ABSENT` / `FAILED` / `UNKNOWN`，**只有 ABSENT 才算没有残留**；
4. 查询失败、创建时间无法比较、捕获歧义一律不算成功。

场景 C 在 `app.exit(9)` 之后**立即**用崩溃前捕获的身份检查（`crashOrphanStatus`），再启动恢复。
