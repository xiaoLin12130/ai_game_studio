# evidence/phase-01-c — 索引（R2）

所有原始日志是 `.txt`（`*.log` 被 `.gitignore` 忽略），已脱敏为 `<abs-path>`。

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite-1.txt` / `unit/full-suite-2.txt` | 应用全量测试，连续两次 | **101/101，0 失败**（各一次） |
| `unit/supervisor-race.txt` | Runtime 关闭竞态（6）+ 启动失败清理（3） | **9/9** |
| `unit/process-identity.txt` | 进程身份判定四态 + `discoverRuntimeIdentities` 返回全部 Runtime | **11/11** |
| `real-dsh/integration.txt` | 真实 DSH + 真实模型回合 | 2/2 |
| `real-dsh/isolated-1/2/3.txt` | 隔离连续三次 | 各 2/2 |
| `packaged/summary.json` | **安装版 A/B/C 复验（接管轮）** | **BLOCKED**：`commandcode` provider 在当前 DSH 0.2.1-rc.3 中未注册，runtime 启动即 `ROUTE_UNKNOWN`，B 仅捕获 1 Runtime（已 ABSENT） |
| `packaged/mcp-tool-call.json` | 安装版 MCP 真实工具调用 | `toolCalled: true` |
| `regression/phase00-suite.txt` / `phase00-gates.json` | PHASE 00 套件与门禁 | 166/166，PASS，0 泄漏 |
| `regression/phase01a-*.txt` | PHASE 01-A 三个冒烟 | 退出码 0 |
| `regression/phase01b-mcp.txt` | PHASE 01-B MCP 握手（开发环境） | 退出码 0 |
| `verification.json` | 本轮真实执行的命令总表 | — |

## 安装版进程检查

**不再**使用 DSH home 字符串匹配：home 通过环境变量传递，运行中的 Runtime 命令行里没有它，
用 home 匹配会在进程活着时返回 ABSENT——上一轮的"无残留"结论因此被判定 **INVALID**（见 `verification.json` 的 `invalidated`）。

现在用 PHASE 01-A 的实例身份：

1. Runtime 运行时用 `captureRuntimeIdentity` 捕获「父进程 + dsh CLI + `creationMs`」；
2. **B 场景（中断→恢复）会先后产生两个 Runtime**。接管轮新增 `discoverRuntimeIdentities` 与
   `startIdentityWatcher`：在 App 整个生命周期内轮询，按 `(pid, creationMs)` 去重收集**所有**
   Runtime 身份，再逐个用 `verifyRuntimeIdentity` 复核；B 强制要求 `runtimeIdentityCount === 2`、
   `runtimeIdentitiesDistinct === 2`、`allRuntimeProcessesGone`（全部 ABSENT）。
3. 判定四态 `PRESENT` / `ABSENT` / `FAILED` / `UNKNOWN`，**只有 ABSENT 才算没有残留**；
4. 查询失败、创建时间无法比较、捕获歧义一律不算成功。

场景 C 在 `app.exit(9)` 之后**立即**用崩溃前捕获的身份检查（`crashOrphanStatus`），再启动恢复。

### 接管轮安装版复验：BLOCKED（环境）

对 `out-g` 打包构建（DSH 0.2.1-rc.3）实跑 A/B/C：`smoke-tasks-packaged.mjs` 写入
`provider: 'commandcode'`，但当前 DSH 0.2.1-rc.3（仓库 `node_modules` 与 out-c/d/g 三个 exe）**均未注册
`commandcode` provider**，runtime 启动即 `ROUTE_UNKNOWN`。B 场景"中断→恢复"从未发生，rt-002 未启动，
仅捕获 1 个 Runtime（已验证 ABSENT）。此属环境/构建问题，超出 PHASE 01-C 范围；本轮未改 provider
配置、未伪造成功。`packaged/summary.json` 保留为真实实跑结果（`ok:false`），不作通过依据。
