# spike/dsh-probe — PHASE 00 垂直切片验证

这里的代码**不是产品代码**，是 PHASE 00 的可复跑证据：用来证明 Studio 能通过官方 SDK 驱动真实的 DSH Runtime，并把当前版本的能做什么、不能做什么测出来。

保留它的原因：DSH 的协议与依赖图在预发布期会变。升级 `@deepseek-ai/*` 之后，`node run-all.mjs` 就是回归门禁——退出码不是 0 就说明集成假设已经不成立。

## 运行

```bash
cd spike/dsh-probe
npm install          # 依赖已精确钉版本，见下方说明
node run-all.mjs
```

退出码：`0` 全部 PASS；`2` 存在 BLOCKED（外部依赖阻断，例如模型账号余额）；`1` 存在 FAIL。

单独跑某个探针：

```bash
node src/probe-basic.mjs       # A：启动 → 会话 → 事件 → 关闭
node src/probe-protocol.mjs    # B：协议事实（无 cancel / 无 resume）
node src/probe-resume.mjs      # C：会话持久化与 id 复用行为
node src/probe-cancel.mjs      # D：放弃等待 ≠ 停止进程
node src/probe-tools.mjs       # E：MCP 工具桥接
node src/probe-concurrent.mjs  # F：并发会话隔离
node src/probe-exitcode.mjs    # G：退出码与陈旧锁缺陷
```

## 前置条件

- Node ≥ 22（用到 `node:zlib` 的 zstd 解压）
- 可用模型凭据：环境变量 `DEEPSEEK_API_KEY`（provider 走 `deepseek-official`）
- 首次运行会在 `tmp/dsh-home/` 创建**隔离的 DSH_HOME**，不会碰你的 `~/.dsh`
- 首次启动可能很慢（需要重建 profile 的模块回退，实测 1–2 分钟）。这不是卡死，`initializeTimeoutMs` 已设 180 s

## 为什么依赖要精确钉版本

```json
"@deepseek-ai/cordis": "4.0.2",
"@deepseek-ai/cordis-plugin-group": "1.0.2",
"@deepseek-ai/cordis-plugin-hmr": "1.0.17",
"@deepseek-ai/cordis-plugin-include": "1.0.7",
"@deepseek-ai/cordis-plugin-loader": "1.0.3",
"@deepseek-ai/cordis-plugin-timer": "1.1.4"
```

`@deepseek-ai/dsh-app-boot` 用**精确 peer** 要求 `cordis@4.0.2`，而 `cordis-plugin-*` 的 caret 范围会解析到要求 `cordis ~4.1.0` 的新版本，两边无法同时满足 → `npm install` 报 `ERESOLVE`；用 `--legacy-peer-deps` 绕过会装出缺包的坏树（`ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis-plugin-group`）。

所以：**不要把这些版本改回 `^`**。详见 `docs/decisions/ADR-0002-dsh-integration.md` D6。

## 产物

- `evidence/<probe>/summary.json`：每个探针的断言与判定（PASS / BLOCKED / FAIL）
- `evidence/<probe>/records.jsonl`：时间序列记录
- `evidence/a-basic-run/events.json`、`timeline.json`：真实事件流
- `evidence/e-tools/audit-records.json`：Studio MCP server 的审计日志（证明 DSH 真的连上来了）
- `evidence/_aggregate/run-all.json`、`run-all-console.txt`：整轮汇总

`tmp/`、`node_modules/`、`*.log` 均被 gitignore；`evidence/` 会入库。

## 一个诚实的说明

探针里所有 Mock 都没有。`mcp/studio-mcp-server.mjs` 是真实 MCP server（手写协议实现以便零依赖，生产应换 `@modelcontextprotocol/sdk`）。若某项因外部原因测不了，判定是 `BLOCKED` 而不是 `PASS`，见 `docs/phase-reports/PHASE_00_EVIDENCE.md` §11。
