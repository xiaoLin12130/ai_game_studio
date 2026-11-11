# PHASE 01-B 工作报告 — 官方 MCP SDK 与 Windows 正式打包

> 状态：**READY_FOR_EXTERNAL_REVIEW**。本报告不宣告阶段关闭，关闭由外部独立评审决定。

## 1. 本阶段原始目标

把 PHASE 00 用最低依赖证明过的两件事（DSH 能连 MCP、Windows 桌面能起）做成**能交付的形态**：

1. Studio MCP Server 换成官方 `@modelcontextprotocol/sdk`，精确锁版本；
2. `get_studio_health` 完成一次真实端到端调用（不是"工具出现在清单里"）；
3. 产出 Windows 安装包，**安装后**在无开发环境的条件下启动 DSH Runtime；
4. 关闭后进程有明确退出确认；
5. 不改用户原有 `~/.dsh`，不泄漏凭据；
6. PHASE 01-A / PHASE 00 回归通过。

## 2. Git

| 项 | 值 |
|---|---|
| 基线 | `45c897630ef2f6ca801cf40b0f2cae488a1b0126`（PHASE 01-A 最终提交） |
| 分支 | `phase/01-b-mcp-packaging` |
| 父提交 | `45c897630ef2f6ca801cf40b0f2cae488a1b0126` |
| 本阶段提交 | 见本分支 HEAD（提交信息以 `feat(phase-01-b):` 开头） |

PHASE 01-A 的关闭状态、PHASE 00 的证据与权威状态、`phase-01-a` 标签均未改动。

## 3. 官方 MCP SDK 与兼容性

| 项 | 值 |
|---|---|
| 包 | `@modelcontextprotocol/sdk`（官方） |
| 版本 | **1.32.2**（精确锁定，无 `^`） |
| 生产入口 | `apps/studio/mcp/studio-mcp-server.mjs` |
| 工具 | `get_studio_health`（只读、无参），在 DSH 中的公开名 `mcp__studio__get_studio_health` |

**为什么是 1.32.x**：DSH 0.2.1-rc.3 的 MCP client 实际基于 `@modelcontextprotocol/client@2.2.0`（v2 拆包线），
其 `SUPPORTED_PROTOCOL_VERSIONS` 为 `[2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07]`。
官方 v1 线（`@modelcontextprotocol/sdk`）只有 1.x。**实测协商结果是双方都到 `2025-11-25`，完全一致**，
不存在降级：抓包见 `evidence/phase-01-b/mcp/protocol-negotiation.json`（client 请求 `2025-11-25` →
server 回应 `2025-11-25` → `notifications/initialized` → `tools/list`）。

同一次抓包还看到 DSH 客户端在 auto 模式下的行为：先发 `server/discover` 探针，我们的 server 不实现该方法、
应答错误后客户端回退到 legacy initialize。这也是每次连接会出现两个 server 进程的原因（探针进程被丢弃）。

**实测握手证据**：`evidence/phase-01-b/mcp/handshake.json` 的 audit 里记录
`initialize.completed`，`clientInfo = { name: "dsh-mcp-client", version: "0.0.1" }`；Server 侧同时记录了
`server.start` / `transport.connected` / `server.stop`。

**"连接成功 ≠ 工具可用"**：本阶段不拿 `initialize` 成功当判据。判据是 Server 侧 audit 里出现
`tools/call` 与 `tools/call.served`（见下一节）。DSH 的 `failOnStartupError` 只产生一条 stderr 警告，
harness 照样起得来 —— 这一点已写进报告，避免下一个人误用。

## 4. 真实工具调用（B3 / B7）

### 4.1 开发环境端到端

`evidence/phase-01-b/mcp/tool-call.json`，一次真实模型回合（provider `commandcode`，model
`deepseek/deepseek-v4-flash`），完整链路：

| 环节 | 证据 |
|---|---|
| DSH 把工具挂进请求头 | `request/header` 事件里包含 `mcp__studio__get_studio_health` |
| 模型决定调用 | `assistant/message` 内含 `tool-call` |
| 运行时执行 | `tool/call` 事件 |
| Studio MCP Server 收到并执行 | audit：`tools/call` → `tools/call.served`（status=ok） |
| 结果回到 DSH | `tool/result` 内容是工具返回的真实 JSON（`status:"ok"` …） |
| 模型基于结果继续 | 最终消息 `TOOL_STATUS=ok SERVER_PHASE=PHASE_01-B`，值来自工具返回值，不是编造 |

### 4.2 安装后端到端

`evidence/phase-01-b/mcp/packaged-tool-call.json`：用**安装目录里的 artifacts** 重跑同一条链 ——
安装后的 `AI Game Studio.exe`（`ELECTRON_RUN_AS_NODE` 模式）加载 `resources/app.asar` 里的 SDK client，
DSH Runtime 用 `app.asar` 内的 `@deepseek-ai/dsh` 启动，MCP Server 是 `app.asar` 内同一个脚本。
结果 `toolCalled: true`、退出码 0。**没有使用任何开发目录路径。**

## 5. Windows 安装包（B4 / B5）

| 项 | 值 |
|---|---|
| 构建命令 | `npx electron-builder --win`（`npm run dist:win`） |
| 退出码 | 0 |
| 产物 | `AI-Game-Studio-0.1.0-x64.exe` |
| 大小 | **237,521,179 字节（226.5 MB）** |
| SHA-256 | `2C0491B413EAC17EE3B3AB9CA52B5A0C6247F49AA7F5DAA875BA332F05BAD5E4` |
| 目标 | NSIS x64，`oneClick:false` / `perMachine:false` / 可选安装目录 |
| Electron | 44.7.0（未变） |
| DSH Runtime | 0.2.1-rc.3 |
| 静默安装 | `/S /D=<dir>` → 退出码 0 |
| 安装位置（本次验证） | 临时目录，非开发目录 |
| 用户数据 | `%APPDATA%\AI Game Studio`（按 productName） |
| 证据 | `evidence/phase-01-b/packaging/installer.json` |

打包踩到的两个真实坑（都已解决并写进配置注释）：

1. **electron-builder 默认会静默丢掉 peerDependencies** —— 打包后第一次探测 4 ms 失败：
   `Cannot find package '@deepseek-ai/dsh-sdk-protocol'`。修法是用 `files` 的
   `{ from: "node_modules", to: "node_modules" }` 映射把整棵依赖树带进去。
2. **asar 内不能 spawn .exe** —— `asarUnpack` 覆盖 `*.node / *.dll / *.exe` 以及
   node-pty、ripgrep（DSH 会把 `.asar` 改写成 `.asar.unpacked`，不 unpack 则 glob/grep 静默失效）、
   libreoffice-kit 等。MCP Server 脚本**留在 asar 内**：它被当作脚本执行（不是 .exe），
   且它的依赖在打包后的 node_modules 里，只有通过 Electron 的 asar 感知加载器才能解析。

## 6. 安装后运行结果（B5 / B6 / B8 / B10）

`evidence/phase-01-b/smoke/summary.json`，对**安装后的 exe** 跑两个场景，11 项断言全过：

| 断言 | 结果 |
|---|---|
| 启动退出码 0 | PASS |
| 产出 smoke.json | PASS |
| 状态 READY | PASS |
| 探测链路 READY（真实 DSH 握手） | PASS |
| teardown completed | PASS |
| **OS 确认进程 ABSENT** | PASS |
| 无残留 GUI 进程 | PASS |
| 探测中途退出退出码 0 | PASS |
| 探测中途退出后 runtime 已回收 | PASS |
| 无残留进程（第二场景） | PASS |

- **不依赖开发环境 Node PATH**：子进程始终是 `process.execPath`（安装目录的 exe）+ `ELECTRON_RUN_AS_NODE=1`。
- **provider 正常加载**：`dsh.probe.end` 干净返回，没有 `no adapter registered for provider`。
- **隔离**：每次运行用独立的 `STUDIO_USER_DATA`，用户真实 `~/.dsh` 只被**读**（取 commandcode 凭据），未写入。

## 7. 生命周期

沿用 PHASE 01-A 的机制，未另写一套：

`before-quit` → 服务标记关闭 → `probe.stop()` → `client.close()`（15 s）→ 捕获实例身份 →
OS 进程表确认（ABSENT 才算数）→ 需要时定向终止再确认 → 写 `dsh.shutdown.result` → 退出。

三态保留：`PROCESS_PRESENT` / `PROCESS_ABSENT` / `PROCESS_CHECK_FAILED`，查询失败绝不当作已退出。
安装后的两个场景都得到 `completed: true` 与 `processAbsent: true`。

## 8. 测试与回归

| 命令 | 退出码 | 结果 |
|---|---|---|
| `tsc -p tsconfig.json` | 0 | — |
| `node --test`（apps/studio） | 0 | **61 / 61**，0 fail，0 skip |
| `node scripts/mcp-probe.mjs` | 0 | 握手 + 工具注册 |
| `node scripts/mcp-probe.mjs --prompt` | 0 | 真实工具调用 |
| `node scripts/smoke.mjs ready / failure / quit-during-probe` | 0 / 0 / 0 | PHASE 01-A 回归 |
| `npx electron-builder --win` | 0 | 安装包 |
| `… /S /D=<dir>` | 0 | 静默安装 |
| `node scripts/smoke-packaged.mjs <installed exe>` | 0 | 11/11 |
| `node scripts/mcp-packaged.mjs <install dir>` | 0 | 安装后握手 |
| `node scripts/mcp-packaged.mjs <install dir> --prompt` | 0 | 安装后真实工具调用 |
| PHASE 00 套件 `node tests/run-tests.mjs` | 0 | **166 / 166** |
| PHASE 00 三门禁 `node scripts/run-gates.mjs` | 0 | 3 门 PASS，0 泄漏 |

新增 3 项 MCP Server 测试（`test/mcp-server.test.js`）：工具清单（有且仅有 1 个只读工具、描述非空、
无参数）、真实调用返回业务 JSON + audit 里出现 `tools/call`、未知工具必须被拒绝。

## 9. 证据路径

见 `evidence/phase-01-b/README.md` 的索引；总表在 `evidence/phase-01-b/verification.json`。

## 10. BLOCKED / UNKNOWN / DEFERRED

| 类型 | 项 | 说明 |
|---|---|---|
| BLOCKED | 无 | — |
| UNKNOWN | U-01B-1 | MCP 的远程/HTTP transport 未验证（本阶段仅 stdio） |
| UNKNOWN | U-01B-2 | 安装包未签名，SmartScreen 会告警 |
| UNKNOWN | U-01B-3 | GUI 内暂无"手动触发 MCP 工具调用"的入口；B3/B7 的调用由验证脚本驱动真实运行时完成 |
| DEFERRED | D-01B-1 | 代码签名 |
| DEFERRED | D-01B-2 | 安装包体积优化（226.5 MB） |

## 11. 尚未实现的后续阶段功能

Session 生命周期与 Resume、RuntimeSupervisorManager、Task 状态机、项目/需求管理、Decision Center、
素材库、构建流水线、微信发布、业务审批、React UI 重构 —— 全部属于 PHASE 01-C 及以后，本阶段未触碰。

## 12. 是否满足原始验收标准

B1–B12 全部 **PASS**（逐条证据见 `state/phase_01_b.json` 与 `evidence/phase-01-b/README.md`）。

结论：**READY_FOR_EXTERNAL_REVIEW**。不自行宣告关闭。
