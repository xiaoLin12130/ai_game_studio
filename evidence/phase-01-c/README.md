# evidence/phase-01-c — 索引（R7 验收）

所有原始日志是 `.txt`（`*.log` 被 `.gitignore` 忽略），已脱敏为 `<abs-path>`。

"轮次"列标明每条证据的产生轮次：**R7 本轮**为最终验收的真实执行；R2/R4/R5/R6 为历史轮次产物，本轮未重跑，结果保持原值。

| 路径 | 内容 | 轮次 | 结果 |
|---|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | R4 历史 | 退出码 0 |
| `unit/full-suite-1.txt` / `unit/full-suite-2.txt` | 应用全量测试，连续两次 | R2 历史 | **101/101，0 失败**（各一次） |
| `unit/supervisor-race.txt` | Runtime 关闭竞态（6）+ 启动失败清理（3） | **R7 本轮** | **9/9** |
| `unit/process-identity.txt` | 进程身份判定四态 + `discoverRuntimeIdentities` 返回全部 Runtime（含排除 plugin CLI） | **R7 本轮** | **12/12** |
| `unit/identity-watcher.txt` | watcher 排空在途查询 + 错误纳入验收 | **R7 本轮** | **6/6** |
| `real-dsh/integration.txt` | 真实 DSH + 真实模型回合 | R2 历史 | 2/2 |
| `real-dsh/isolated-1.txt`、`isolated-2.txt`、`isolated-3.txt` | 隔离连续三次 | R2 历史 | 各 2/2 |
| `packaged/summary.json` / `summary-r7.json` | **安装版 A/B/C 最终验收** | **R7 本轮** | **PASS**：`ok:true`，43 项检查 / 0 失败；A SUCCEEDED、B 双 Runtime 均 ABSENT、C 崩溃+恢复均 ABSENT |
| `packaged/summary-r7-installfail.json` | R7 首次尝试（H: 盘 store → `PROFILE_NOT_READY`） | R7 失败留档 | `ok:false`，保留审计 |
| `packaged/summary-r6.json` | R6 真实运行（模型 `RATE_LIMIT`） | R6 历史 | `ok:false`，保留审计 |
| `packaged/summary-r4.json` | R4 真实失败运行（`PROFILE_NOT_READY`） | R4 历史 | `ok:false`，保留审计 |
| `packaged/summary-r6-preinstall.json` | R6 修复前真实失败运行（pnpm store 污染 → `PROFILE_NOT_READY`） | R6 修复前 | `ok:false`，保留审计 |
| `real-run-r7.md` | **R7 环境解阻塞与 A/B/C 真实验收记录** | **R7 本轮** | — |
| `real-run-r6.md` | R6 环境修复与真实运行记录 | R6 历史 | — |
| `packaged/mcp-tool-call.json` | 安装版 MCP 真实工具调用 | R2 历史 | `toolCalled: true` |
| `regression/phase00-suite.txt` / `phase00-gates.json` | PHASE 00 套件与门禁 | R2 历史 | 166/166，PASS，0 泄漏 |
| `regression/phase01a-failure.txt`、`phase01a-quit.txt`、`phase01a-ready.txt` | PHASE 01-A 三个冒烟 | R2 历史 | 退出码 0 |
| `regression/phase01b-mcp.txt` | PHASE 01-B MCP 握手（开发环境） | R2 历史 | 退出码 0 |
| `verification.json` | 真实执行记录总表（R7 matrix：3 个单测 + 安装版 A/B/C） | **R7 本轮** | — |

## 安装版进程检查

**不再**使用 DSH home 字符串匹配：home 通过环境变量传递，运行中的 Runtime 命令行里没有它，
用 home 匹配会在进程活着时返回 ABSENT——上一轮的"无残留"结论因此被判定 **INVALID**（见 `verification.json` 的 `invalidated`）。

现在用 PHASE 01-A 的实例身份：

1. Runtime 运行时用 `captureRuntimeIdentity` 捕获「父进程 + dsh CLI + `creationMs`」；
2. **B 场景（中断→恢复）会先后产生两个 Runtime**。新增 `discoverRuntimeIdentities` 与
   `scripts/lib/identity-watcher.mjs` 的 `createIdentityWatcher`：在 App 整个生命周期内轮询，按
   `(pid, creationMs)` 去重收集**所有** Runtime 身份；`stop()` 会**等待在途查询排空**再返回（避免
   App 退出瞬间漏记身份）。随后 `verifyIdentities` 逐个复核，并把 `watchErrors` 计入 `allGone`
   （查询失败一律不算通过）。B 强制要求 `runtimeIdentityCount === 2`、`runtimeIdentitiesDistinct === 2`、
   `allRuntimeProcessesGone`、`noIdentityWatchErrors`。
3. 判定四态 `PRESENT` / `ABSENT` / `FAILED` / `UNKNOWN`，**只有 ABSENT 才算没有残留**；
4. 查询失败、创建时间无法比较、捕获歧义一律不算成功。

场景 C 在 `app.exit(9)` 之后**立即**用崩溃前捕获的身份检查（`crashOrphanStatus`），再启动恢复。

### R7 最终验收：PASS（A/B/C 全部真实通过）

| 场景 | 结果 | 关键证据 |
|---|---|---|
| A 正常执行 | Task `task-cea17dc3` → **SUCCEEDED**；`pid=25476/1794468973318` → **ABSENT** | `packaged/summary-r7.json` |
| B 中断恢复 | `task-bb42d7e9`：`INTERRUPTING→INTERRUPTED→RESUMING→SUCCEEDED`，复用 `studio-task-bb42d7e9-a1`（attempts=2/sessions=1）；`pid=25652/1794468989474`、`pid=20992/1794468994654` 均 **ABSENT** | 同上 |
| C 崩溃恢复 | `task-63b09ebc`：`app.exit(9)` → 重启 → `INTERRUPTED` → `task.resumed` → SUCCEEDED（attempts=2）；崩溃前 `pid=25872/1794469007470`、恢复 `pid=25092/1794469013475` 均 **ABSENT** | 同上 |

- `summary.ok = true`，43 项检查 / **0 失败**，退出码 0。
- store 必须在 **C: 盘 `%TEMP%`**：H: 盘 store 会让 `projects/<hash>` 落成真实目录，`fs.unlink(dir)` 触发 Windows 原生 **EPERM**（与 safe-delete 无关）。失败留档 `summary-r7-installfail.json`。
- 断言修正：`noRuntimeLeft` 读取的是 app 退出前的 `smoke.json` 快照（此时 runtime 合法为 `closing`），结构上不可满足；改为 `runtimeClosedInLog`（每个 `runtime.start` 必须有 `runtime.closed`），比原断言更强。

### 历史：R5/R6 环境阻断（已解决，保留审计）

1. **陈旧打包**：首跑 `out-g` 的 asar 不含 `task-interrupt-resume` 分支（grep = 0），回落启动探测 →
   `ROUTE_UNKNOWN`，只捕获探测 runtime。
2. **pnpm store 位置**：`dsh plugin add` 内部 `pnpm add` 在 H: 盘 store 上失败（`unlink` EPERM）→ `PROFILE_NOT_READY`。
3. **模型额度**：R6 真实回合 `RATE_LIMIT`，窗口 `2026-11-12 15:33:12` 重置；R7 重置后全部成功。

`commandcode` 是外部插件（非 DSH 内置），`dsh-sdk-client`/`@deepseek-ai/dsh` 全程 `0.2.1-rc.3`（依赖未变）。
未改 Provider、未重写 DSH 通信、未伪造成功。

**A/B/C 属 PHASE 01-C 原始验收范围**，不因环境阻断而移出范围。正常 Windows 环境复验：

```
cd apps\studio
node scripts\smoke-tasks-packaged.mjs "release\win-unpacked"
# 或已安装目录：node scripts\smoke-tasks-packaged.mjs "%LOCALAPPDATA%\Programs\AI Game Studio"
```

前置：Node ≥ 22.12、可访问 npm registry、pnpm store 可写、`~/.dsh/.credentials.yaml` 含 `COMMANDCODE_API_KEY`。
构建产物：`release/AI-Game-Studio-0.1.0-x64.exe`（237,548,789 B，`415c5003…`）、`release/win-unpacked/AI Game Studio.exe`（246,302,208 B，`1255d65a…`）。


## 严格成功断言（R7 补正）

A/B/C 三个场景的成功判据统一为 `finalStatus === 'SUCCEEDED'`。

此前 B/C 使用 `['SUCCEEDED','FAILED'].includes(...)`，把"恢复后失败"也算作通过——那是不合格的成功断言。
定向测试见 `apps/studio/test/packaged-assertions.test.js`；对既有 R7 数据的独立复核见
`packaged/strict-recheck-r7.json`（A/B/C 均为 SUCCEEDED，原始 `summary-r7.json` 未被修改）。

## 根因记录（R7 校准）

`verification.json` 的 `commandcodeInvestigation` 是 R4/R5 的历史假设（沙箱 pnpm 限制），已标注 **SUPERSEDED**。
当前结论见 `rootCauseR7`：pnpm store 位于 H: 盘时 `projects/<hash>` 形成真实目录而非 junction，
随后 `fs.unlink(dir)` 触发 **Windows 原生 EPERM**；C: 盘 `%TEMP%` 独立 store 正常形成 junction 并安装成功。

这不是 WorkBuddy safe-delete 拦截，也不是 DSH 通信或产品代码缺陷。历史失败证据全部保留。
