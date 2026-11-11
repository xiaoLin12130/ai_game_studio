# PHASE 01-B — 官方 MCP SDK 接入与 Windows 正式打包

- 基线：`45c897630ef2f6ca801cf40b0f2cae488a1b0126`（PHASE 01-A 最终提交）
- 分支：`phase/01-b-mcp-packaging`
- 前置：PHASE 01-A 通过外部独立评审（verdict=PASS，PHASE_01_A_APPROVED）

## 1. 目标

1. **B1/B2 官方 MCP SDK**：把手写 JSON-RPC 的 Studio MCP Server 换成 `@modelcontextprotocol/sdk`，
   精确锁定版本，并证明 DSH 0.2.1-rc.3 的 MCP Client 能连上。
2. **B3 真实工具调用**：`get_studio_health` 走完整链路（DSH → MCP Client → Studio Server → 工具 → 回传 → 模型继续），
   不是"工具出现在清单里"。
3. **B4/B5 Windows 打包**：产出正式安装包，安装后在**不依赖开发环境**的条件下启动 DSH Runtime。
4. **B6/B7 Provider 与 MCP**：commandcode 正常加载、无静默回退；安装后 MCP Server 能被真实调用。
5. **B8/B9/B10 生命周期与隔离**：关闭后进程有明确退出确认；不改用户原有 `~/.dsh`；不依赖开发机 Node PATH。
6. **B11/B12 回归与证据**：PHASE 01-A / PHASE 00 回归通过；源码、安装包、运行证据可追溯到 Commit。

## 2. 范围

做：MCP Server 换官方 SDK、真实工具调用验证、electron-builder 打包、NSIS 安装包、安装后冒烟、生命周期验证、证据与报告。

不做（PHASE 01-C 及以后）：Session 生命周期管理、Resume/崩溃恢复、RuntimeSupervisorManager、
Task 状态机、项目/需求管理、Decision Center、素材库、构建流水线、发布流程、业务审批、React UI 重构。

## 3. 验收（关闭条件）

| 编号 | 关闭条件 |
|---|---|
| B1 | 生产实现改用官方 SDK，依赖精确锁定 |
| B2 | DSH 0.2.1-rc.3 能连接该 Server |
| B3 | `get_studio_health` 完成真实端到端调用 |
| B4 | 成功生成 Windows 安装包 |
| B5 | 安装后能启动 DSH Runtime |
| B6 | commandcode 正常加载，无静默回退 |
| B7 | 安装后的 MCP Server 能被调用 |
| B8 | 关闭后进程有明确退出确认 |
| B9 | 不修改 `~/.dsh`，不泄漏凭据 |
| B10 | 不依赖开发环境 Node PATH |
| B11 | PHASE 01-A / PHASE 00 回归通过 |
| B12 | 证据可追溯 |

## 4. 关键约束

- Electron 固定 44.7.0（DSH 原生 addon 指纹白名单）。
- 所有 MCP 通信走官方 SDK，不保留手写协议实现作为生产备用通道。
- 不新增第二套模型 API；模型推理只经 DSH。
- Renderer 不得直接访问 Node/文件系统/DSH SDK；Preload 白名单 IPC。
- 不提交密钥、真实 DSH Home、用户配置。
- 证据区分 PASS / FAIL / BLOCKED / NOT_RUN / UNKNOWN。
