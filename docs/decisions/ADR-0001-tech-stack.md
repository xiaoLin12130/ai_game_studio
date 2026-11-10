# ADR-0001｜桌面容器、前端框架与本地数据方案

- 状态：**PROPOSED**（待外部复审确认）
- 日期：2026-11-10
- 阶段：PHASE 00
- 决策人：用户（待批准）／本 ADR 由执行 Agent 起草
- 相关：`ADR-0002-dsh-integration.md`、`docs/03_SYSTEM_ARCHITECTURE.md`、`docs/02_SCOPE_AND_NON_GOALS.md`

---

## 1. 背景与不可回避的约束

`docs/03_SYSTEM_ARCHITECTURE.md` 明确「尚未锁定 UI 框架、桌面容器和本地数据库」，要求 PHASE 00 用证据决定。PHASE 00 实测得到三条硬约束，它们把选项空间压得很小：

| 编号 | 约束 | 证据 |
|---|---|---|
| C1 | **DSH Runtime 是 Node 程序**，官方 SDK 客户端是 TypeScript/Node 库，通过 spawn 子进程 + stdio JSON-RPC 驱动 | `@deepseek-ai/dsh` 的 `bin` 为 `lib/bin.js`；`dsh-sdk-client` 依赖 `@deepseek-ai/dsh@0.1.5-rc.2` 并自行解析同版本可执行文件。见 `PHASE_00_EVIDENCE.md` §2 |
| C2 | **DSH 凭据与 Profile 走本机 `DSH_HOME` 语义**，Runtime 需要在文件系统上物化 profile 目录与 `node_modules` 回退 | 隔离 `DSH_HOME` 首次启动会生成 `profiles/` 与 `profiles/node_modules`，冷启动实测 73 s |
| C3 | **无 wire 级取消能力**，停止一次 turn 只能关闭 Runtime 进程 | `session/cancel` 返回 `-32601`；协议文档写明 “No cancel or session-close methods”。见 `PHASE_00_EVIDENCE.md` §4 |

C1 的直接影响：无论选哪个外壳，**本机必须有一个 Node 运行时来承载 DSH SDK**。这决定了「把 Node 作为独立 sidecar 进程」还是「把 Node 放进主进程」是本次选型的主轴，而不是 UI 框架之争。

## 2. 候选方案

只保留两个候选。两者都用 **React + TypeScript** 做界面层：这一层与本 ADR 的核心取舍无关，单独为它再开分支没有证据价值；差异全部集中在容器、Node 承载方式与打包上。

### 方案 A：Electron 主进程内承载 DSH SDK

- 外壳：Electron（Chromium + 内置 Node）。
- 进程结构：**单进程即可**。Electron 主进程直接 `import { DeepSeekHarness }`，由它 spawn `dsh --profile sdk` 子进程；渲染进程通过 `contextBridge` 暴露的类型化 IPC 拿事件。
- 数据：SQLite（`better-sqlite3`，需 `electron-rebuild`）或先文件型 JSON 状态，后续迁移。
- 打包：`electron-builder` → NSIS 安装包；`electron-updater` 做增量升级。

### 方案 B：Tauri 外壳 + Node sidecar

- 外壳：Tauri（Rust + 系统 WebView2）。
- 进程结构：**双运行时**。Rust 主进程负责窗口、权限、文件对话框；Node sidecar 进程承载 DSH SDK 与业务服务层；两者之间再定义一层 IPC（stdio 或本地 HTTP）。
- 数据：Rust 侧 `rusqlite`，或由 Node sidecar 独占数据库，Rust 只做转发。
- 打包：Tauri bundler → MSI/NSIS，sidecar 作为 externalBin 一起签名分发。

## 3. 评估

| 维度 | 方案 A（Electron） | 方案 B（Tauri + Node sidecar） |
|---|---|---|
| Windows 本地单用户适配 | 满足。单一运行时，与 C1 天然一致 | 满足。但需同时维护 Rust 与 Node 两套运行时与两套依赖 |
| DSH SDK 运行与回收 | 主进程内 `try/finally` + `close()`，子进程归属清晰；实测 `close()` 后 950 ms 内进程消失 | sidecar 与 Rust 双份生命周期管理；崩溃恢复要处理两个进程的退出顺序 |
| UI ↔ 本地服务通信 | Electron IPC（`ipcMain`/`ipcRenderer` + `contextBridge`），类型可共享 | Rust↔Node 需自定义协议，WebView↔Rust 再一层；链路更长、故障点更多 |
| 本地数据与备份 | 单一 SQLite 文件 + WAL；备份=复制文件/定时快照 | 同左，但数据库归属需先决定在 Rust 还是 Node，否则出现双写 |
| 文件/Git/构建隔离与锁 | Node 侧 `child_process` + 进程内锁；与 DSH 工具执行同一运行时，锁语义一致 | 文件操作可能同时来自 Rust 与 Node，锁必须跨进程实现 |
| 打包体积 | 较大（~120–180 MB） | 较小（~10 MB 外壳 + Node sidecar ~60 MB） |
| 升级成本 | `electron-updater` 成熟；整包替换 | 需同时升级 Rust 二进制与 sidecar，签名链路更长 |
| 故障恢复 | 一个进程树，`taskkill`/重启语义明确 | 需处理「外壳活着但 sidecar 死了」等组合状态 |
| 主要风险 | 原生模块 ABI（若用 `better-sqlite3`）；Electron 版本升级需回归 | 双运行时复杂度；WebView2 依赖系统组件；sidecar 打包/签名未验证 |

## 4. 决策

**采用方案 A：Electron + React + TypeScript，DSH SDK 由主进程直接承载。**

理由（按权重排序）：

1. **与 C1 一致**。DSH 的官方 SDK 是 Node 库，Electron 主进程本身就是 Node，不需要为「跑一个 Node 依赖」再引入第二套运行时。方案 B 的双运行时是纯粹为外壳语言付出的复杂度。
2. **生命周期与 C3 匹配**。既然没有 wire 级取消、停止只能靠关进程，那么「谁拥有 DSH 子进程」必须是唯一的、可审计的。单进程模型让所有权天然唯一；方案 B 需要跨进程协调「关掉 sidecar 里的 dsh 子进程」。
3. **锁与隔离实现成本最低**。`AGENTS.md` 5 要求「同一项目同一时刻最多一个写任务、构建独占」。锁只有在单一进程内才可靠；跨 Rust/Node 需要额外机制。
4. **故障恢复面最小**。Studio 需要保证「崩溃后下次能起来」，而 PHASE 00 已经踩到 DSH profile 陈旧锁导致启动阻塞（见 §6 风险 R2）。少一层进程就少一类残留状态。

同时明确**不采用**的具体理由：

- 方案 B 被否，不是因为它不好，而是它的优势（体积、内存、安全模型）在本产品「单用户本地工具、主要成本在模型与构建」的场景下权重低，而复杂度直接落在最脆弱的地方（生命周期与锁）。
- 纯浏览器 + 本地 HTTP 服务（不打包外壳）曾作为第三选项考虑，未列入候选：它把「打开应用」降级为「先起服务再开浏览器」，与产品承诺 1「用户不必理解内部架构」冲突。若 Electron 打包在后续阶段被证明不可行，可回退到此形态，届时需新开 ADR。

## 5. 实施约束（本 ADR 生效即必须遵守）

1. **渲染进程不得直接持有 DSH 客户端**。所有 SDK 调用只在主进程，渲染进程通过 `contextBridge` 暴露的白名单通道拿**已序列化的事件**，`nodeIntegration: false`、`contextIsolation: true`。
2. **DSH 子进程必须由一个 `RuntimeSupervisor` 独占持有**，负责：启动握手、事件转发、`close()` 与退出码记录、陈旧锁自愈。任何时候只允许一个 supervisor 实例。
3. **每个项目一个 DSH `DSH_HOME` 子目录或一个受控 profile**，不得与用户日常 `~/.dsh` 混用（隔离原则，见 ADR-0002 §5）。
4. **数据库选型延后到 PHASE 01**：PHASE 00 不写业务数据。PHASE 01 需实测 `better-sqlite3` 在目标 Electron 版本下的 ABI，或验证 Electron 内置 Node 的 `node:sqlite` 可用性（本机 Node 22.22 已提供 `node:sqlite`，但 Electron 内置版本不同，**未验证**）。
5. **时间戳与版本记录**：所有证据文件写入 Build/Run 标识与时间戳，禁止只写「成功」。

## 6. 未验证风险

| ID | 风险 | 影响 | 缓解/下一步 |
|---|---|---|---|
| R1 | Electron 目标版本内置 Node 的 `node:sqlite` 或 `better-sqlite3` ABI 未验证 | 数据层返工 | PHASE 01 首任务即做 ABI 冒烟 |
| R2 | DSH 启动耗时不稳：热启动 2.2–2.6 s，需重建 profile 模块回退时 73–128 s（本机实测），默认 `initializeTimeoutMs` 10 s 会误判失败 | 首启动即报错，或用户以为卡死 | 已在探针中把超时提到 180 s；Studio 必须分「重建/冷启动」与「常规启动」两档超时并给进度反馈；PHASE 01 评估安装期预热 |
| R3 | DSH profile 陈旧锁（`profiles/node_modules.lock` 持有者 pid 已死）会让下次启动在 2 s 后失败，SDK 只报 `JSON-RPC input closed` | 应用「打不开」且原因不可读 | 已实现 `clearStaleProfileLock()` 参考实现（探针 G 复现缺陷并验证自愈）；Studio 需内置并把可读原因映射到 UI |
| R4 | 未验证 Electron 打包后 `dsh` 子进程在 asar 内的可执行性 | 打包版可能无法启动 Runtime | PHASE 01 用 `asarUnpack` 或外置 runtime 目录，并做安装包冒烟 |
| R5 | 未验证代码签名/自动更新链路 | 无法分发 | 属 PHASE 07 范围，届时评估 |

## 7. 复审时需要关注的问题

1. 是否接受「主进程承载 Node 依赖」而不是 sidecar 隔离？若担心主进程被 Agent 工具调用阻塞，需要说明：**DSH 的子进程是独立进程**，主进程只做 IPC 转发与生命周期管理，长任务不在主进程执行。
2. 是否接受把数据库选型推迟到 PHASE 01？本阶段没有业务数据可放，提前锁定只会制造返工。
3. 对 R2/R3 的处理方式（分档超时 + 陈旧锁自愈）是否符合「不谎称已停止」的要求。
