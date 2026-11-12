# evidence/phase-01-c — 索引（R5 补正）

所有原始日志是 `.txt`（`*.log` 被 `.gitignore` 忽略），已脱敏为 `<abs-path>`。

"轮次"列标明每条证据的产生轮次：**R5 本轮**为本次实际执行；R2/R4 为历史轮次产物，本轮未重跑，结果保持原值。

| 路径 | 内容 | 轮次 | 结果 |
|---|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | R4 历史 | 退出码 0 |
| `unit/full-suite-1.txt` / `unit/full-suite-2.txt` | 应用全量测试，连续两次 | R2 历史 | **101/101，0 失败**（各一次） |
| `unit/supervisor-race.txt` | Runtime 关闭竞态（6）+ 启动失败清理（3） | **R5 本轮** | **9/9** |
| `unit/process-identity.txt` | 进程身份判定四态 + `discoverRuntimeIdentities` 返回全部 Runtime | **R5 本轮** | **11/11** |
| `unit/identity-watcher.txt` | watcher 排空在途查询 + 错误纳入验收 | **R5 本轮** | **6/6** |
| `real-dsh/integration.txt` | 真实 DSH + 真实模型回合 | R2 历史 | 2/2 |
| `real-dsh/isolated-1.txt`、`isolated-2.txt`、`isolated-3.txt` | 隔离连续三次 | R2 历史 | 各 2/2 |
| `packaged/summary.json` | **安装版 A/B/C 复验** | R4 运行（本轮未重跑） | **BLOCKED**：正确构建已进任务场景，但 `dsh plugin add` 的 `pnpm add` 因 pnpm store unlink EPERM（沙箱）失败 → `PROFILE_NOT_READY`，B 未产生第二个 Runtime（42 项检查 / 20 失败） |
| `packaged/mcp-tool-call.json` | 安装版 MCP 真实工具调用 | R2 历史 | `toolCalled: true` |
| `regression/phase00-suite.txt` / `phase00-gates.json` | PHASE 00 套件与门禁 | R2 历史 | 166/166，PASS，0 泄漏 |
| `regression/phase01a-failure.txt`、`phase01a-quit.txt`、`phase01a-ready.txt` | PHASE 01-A 三个冒烟 | R2 历史 | 退出码 0 |
| `regression/phase01b-mcp.txt` | PHASE 01-B MCP 握手（开发环境） | R2 历史 | 退出码 0 |
| `verification.json` | 真实执行记录总表（本轮 matrix 仅 4 项） | **R5 本轮** | — |

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

### 补正轮安装版复验：BLOCKED（两层根因）

1. **陈旧打包**：首跑 `out-g` 的 asar 不含 `task-interrupt-resume` 分支（grep = 0），回落启动探测 →
   `ROUTE_UNKNOWN`，只捕获探测 runtime（B 只有 1 个的直接原因）。
2. **沙箱 pnpm 限制**：改用当前 HEAD 构建 `apps/studio/release/win-unpacked` 后已进入任务场景，
   但 `ensureProfile()` 的 `dsh plugin add @mars-sea/dsh-commandcode-provider@0.15.4` 内部 `pnpm add`
   因 pnpm store 的 `unlink` **EPERM**（沙箱删除保护）失败 → `PROFILE_NOT_READY`，B 仍未产生第二个 Runtime。

`commandcode` 是外部插件（非 DSH 内置），`dsh-sdk-client`/`@deepseek-ai/dsh` 全程 `0.2.1-rc.3`（依赖未变）。
本轮未改 Provider、未重写 DSH 通信、未伪造成功；`packaged/summary.json` 保留为真实实跑结果（`ok:false`）。

**R5 环境复核**：Node v22.22.2 / pnpm 11.21.0 / npm registry 可达（0.15.4）/ 凭据存在（`~/.dsh/.credentials.yaml`，仅检查存在性）。**路径澄清**：Studio 实际 `dshHome=<userData>/dsh-home`、`profile=sdk`，目标 `profiles/sdk` **无 `node_modules`、插件未安装**（`~/.dsh/profiles/{desktop,headless,web}` 属其他 DSH Home，不能作为证据）。pnpm store（`H:\dev\pnpm-store\v11`）删除仍被安全垫 `SAFE_DELETE_FAIL_CLOSED` 拒绝（`%TEMP%` 正常），故 R5 未执行 A/B/C，未采用改 store 目录/关闭安全垫等绕过方式。详见 `verification.json` 的 `environmentCheck`。

**A/B/C 属 PHASE 01-C 原始验收范围**，不因环境阻断而移出范围。正常 Windows 环境复验：

```
cd apps\studio
node scripts\smoke-tasks-packaged.mjs "release\win-unpacked"
# 或已安装目录：node scripts\smoke-tasks-packaged.mjs "%LOCALAPPDATA%\Programs\AI Game Studio"
```

前置：Node ≥ 22.12、可访问 npm registry、pnpm store 可写、`~/.dsh/.credentials.yaml` 含 `COMMANDCODE_API_KEY`。
构建产物：`release/AI-Game-Studio-0.1.0-x64.exe`（237,548,789 B，`415c5003…`）、`release/win-unpacked/AI Game Studio.exe`（246,302,208 B，`1255d65a…`）。
