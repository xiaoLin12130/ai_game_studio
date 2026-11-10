# 11｜已确认决策与待验证事项

## 已确认

| ID | 决策 | 状态 |
|---|---|---|
| D-001 | 产品定位为 AI 游戏研发顾问 + 自动化开发平台 | CONFIRMED |
| D-002 | DSH 是唯一 AI Runtime，不另写模型通信/Agent Runtime | CONFIRMED |
| D-003 | 用户可自由讨论；正式执行必须经过基线和门禁 | CONFIRMED |
| D-004 | 需求讨论区、正式研发区、需求变更区分离 | CONFIRMED |
| D-005 | 全局共享素材库 + 项目专属素材库 | CONFIRMED |
| D-006 | 支持导入项目和全局 Inbox 两种素材入口 | CONFIRMED |
| D-007 | 需求变更先影响分析、审批，再局部返工 | CONFIRMED |
| D-008 | UI 以工作台、游戏项目、AI 顾问、设计与素材、决策中心为主要入口 | RECOMMENDED / 待原型验证 |
| D-009 | 不做发布后运营监控、持续顾问和自动迭代 | CONFIRMED |
| D-010 | 首个目标适配 Cocos Creator 3.8.6 + 微信小游戏 | 首轮验证目标 |
| D-011 | Windows 本地单用户优先 | 首轮产品约束 |
| D-012 | 每个阶段推送 GitHub 并暂停外部复审 | CONFIRMED |

## PHASE 00 必须核验

- 当前 DSH CLI 实际版本、SDK 包版本和兼容关系。
- 官方 SDK 的具体导入方式、启动参数、事件、审批、恢复和关闭行为。
- MCP Tools 的注册和权限边界。
- 当前 Windows 环境下的 Node/pnpm、进程和打包兼容性。
- Cocos/微信开发者工具实际安装版本与可用性。
- UI 容器、前端框架、本地服务、本地数据库和打包方案。
- GitHub CLI/远端认证可用性；只检查登录状态，不输出密钥。

## 暂不确定，不得擅自写死

- Electron / Tauri / Web 本地应用最终选择。
- React / Vue 等前端框架。
- SQLite / 文件型数据库的最终选择。
- Embedding/向量检索是否进入 MVP。
- DSH Session 的最佳 Runtime 隔离粒度。
- 未来是否需要团队多人协作或云端能力。

每个未决项都应由证据、原型和 ADR 决定，不得在多个模块中重复写死。

---

## PHASE 00 执行后新增（2026-11-10）

以下条目由本机实测得出，均已附证据于 `docs/phase-reports/PHASE_00_EVIDENCE.md`。**不是推测，也不是从文档抄的。**

### 已确认（新增）

| ID | 决策/事实 | 状态 |
|---|---|---|
| D-013 | DSH 官方 SDK 采用 TypeScript 版 `@deepseek-ai/dsh-sdk-client`，不需要引入 Python 运行时 | CONFIRMED（本机验证） |
| D-014 | 当前 DSH 版本**没有**运行中取消能力，停止只能关闭 Runtime 进程 | CONFIRMED（`session/cancel` 不存在） |
| D-015 | 当前 DSH 版本**没有**会话恢复能力，且复用已存在的 sessionId 会被拒绝 | CONFIRMED（`session/resume` 不存在 + `already exists`） |
| D-016 | 当前 DSH 版本**没有**工具审批回调（协议无 server→client 请求） | CONFIRMED（协议文档 + 实测无该通知） |
| D-017 | Studio 工具桥接的唯一 sanctioned 通道是 MCP（`dsh-mcp-client`），工具名形如 `mcp__<server>__<tool>` | CONFIRMED（握手指纹 `dsh-mcp-client@0.0.1`，MCP `2025-11-25`） |
| D-018 | `@deepseek-ai/*` 依赖必须整族精确钉版本并提交 lockfile | CONFIRMED（caret 范围会 `ERESOLVE`） |
| D-019 | 技术栈建议 Electron + React + TypeScript（ADR-0001） | PROPOSED，待复审 |
| D-020 | DSH 集成方式（生命周期/事件/工具/恢复策略）见 ADR-0002 | PROPOSED，待复审 |

### 文档与实现不一致（需要上游确认，不得自行选择解释）

| ID | 冲突 | 实测 | 处理 |
|---|---|---|---|
| X-001 | `dsh-sdk-protocol` README 称未注册方法返回 `-32601` | 实测返回 `-32603` + `unknown ... SDK runtime method: <name>` | 代码内以消息文本判定能力存在性；已记入 ADR-0002 F2 |
| X-002 | `dsh-mcp-client` README 的配置示例是裸行 | `--patch` 文件必须用 `insert:` 包裹，否则 `patch: entry "<id>" not found` | 以 `insert:` 形式生成 patch；已记入 ADR-0002 §3 D5 与 EVIDENCE §8 |
| X-003 | `docs/04` 写「优先 TypeScript SDK 或经验证的官方等价 SDK」 | TS SDK 存在且可用，但 npm 上 `sdk-client` 的 `latest` 标签（0.0.1-rc.1）远落后于 `next`（0.2.2-rc.1），且与 0.1.5 线不兼容 | 精确钉 `0.1.5-rc.2`；升级需重跑探针 |

### 阻塞项（需要用户决策或外部条件）

| ID | 内容 | 影响 |
|---|---|---|
| B-001 | DeepSeek 账号余额不足（HTTP 402 / QUOTA），DSH 自身 `--profile headless` 同样失败 | 门禁 3、5 无法转 PASS；所有模型输出类断言为 BLOCKED |
| B-002 | 仓库无 remote，本机无 `gh` CLI | 阶段分支无法推送；复审需用户提供仓库 URL |
| B-003 | 生产形态的 `DSH_HOME` 隔离粒度未定（每项目隔离 vs 复用 `~/.dsh`） | 影响凭据体验与多项目隔离，PHASE 01 前需拍板 |

### 仍未验证（不要假定已通过）

- Python SDK 路线（`packages/python`）。
- `sdk-minimal` profile 是否能挂 MCP（若可以，生产攻击面更小）。
- Electron 打包后 `dsh` 子进程能否启动。
- 模型真实回复、模型主动调用 Studio 工具、长 turn 下的「仍在工作」。
- 安装期预热 profile 能否把首启动从 2 分钟降到秒级。
