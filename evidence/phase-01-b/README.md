# evidence/phase-01-b — 索引

本阶段全部证据都可追溯到提交（见 `verification.json` 的 `commit` 字段）。

| 路径 | 证明什么 | 归属验收 |
|---|---|---|
| `mcp/handshake.json` | 开发环境：DSH Runtime 用 `patches` 连上官方 SDK 写的 Studio MCP Server（`initialize.completed`，clientInfo = dsh-mcp-client） | B1, B2 |
| `mcp/tool-call.json` | 开发环境：真实模型回合调用 `mcp__studio__get_studio_health`，Server 侧 audit 有 `tools/call` + `tools/call.served` | B3 |
| `mcp/packaged-handshake.json` | **安装后**的 artifacts：安装目录 exe（node 模式）加载 app.asar 里的 SDK client，DSH 连上 asar 内的 Studio MCP Server | B7 |
| `mcp/packaged-tool-call.json` | **安装后**：真实模型回合调用工具成功（`toolCalled: true`） | B3, B7 |
| `packaging/installer.json` | 安装包文件名/大小/SHA-256、Electron、DSH、MCP SDK 版本、构建工具与目标 | B4, B12 |
| `smoke/ready.json` | 安装后启动：DSH Runtime READY、teardown completed、processAbsent、无残留 GUI 进程 | B5, B6, B8 |
| `smoke/quit-during-probe.json` | 安装后退出：探测中途退出仍完成回收 | B8 |
| `smoke/summary.json` | 两个场景的汇总断言 | B5, B8 |
| `regression/phase00-gates.json` | PHASE 00 三道门禁在 PHASE 01-B 代码上的回归结果 | B11 |
| `regression/phase00-suite.txt` | PHASE 00 套件回归输出 | B11 |
| `verification.json` | 本轮实际执行的全部命令、退出码、计数、产物路径 | B12 |

## 说明

- 证据中的绝对路径已脱敏为 `<abs-path>`，符合 PHASE 00 的泄漏门禁。
- 安装包本身（约 226.5 MB）**不入库**，只记录文件名、大小与 SHA-256；`apps/studio/release/` 已在 `.gitignore` 中。
- 截图/窗口图来自真实安装后的应用（`smoke/*/window.png` 由应用自身 `capturePage` 产生）；本阶段没有使用任何测试夹具图。
