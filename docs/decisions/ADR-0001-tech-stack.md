# ADR-0001｜桌面容器、前端框架与本地数据方案

- 状态：**PROPOSED / CONDITIONAL**（保留 Electron 为优先候选，最终批准需用户决策 + PHASE 01 打包冒烟）
- 日期：2026-11-10（PHASE 00 初稿）／2026-11-10 修订（PHASE 00-R1）
- 阶段：PHASE 00-R1
- 相关：`ADR-0002-dsh-integration.md`、`docs/03_SYSTEM_ARCHITECTURE.md`、`docs/02_SCOPE_AND_NON_GOALS.md`

---

## 0. 本版修订了什么（R1）

外部复审指出三处问题，本版逐一修正：

| # | 原表述 | 问题 | 本版处理 |
|---|---|---|---|
| 1 | 「Electron 主进程 + 单进程即可」被读成单进程架构 | 事实错误：Electron 天然是**多进程**（main / renderer / GPU / utility），且 DSH Runtime 还是**子进程** | §2 给出真实进程拓扑图，删除「单进程」表述 |
| 2 | Tauri 被否的理由之一是「跨进程锁不可靠」 | 论证偷懒：只要 Node sidecar 独占文件/构建/Git，锁所有权仍然清晰 | §3 重新评价 Tauri，承认其可行 |
| 3 | 未验证打包后能否运行 | 缺证据 | §5 列出 PHASE 01 必做的打包冒烟清单 |

同时补入 PHASE 00-R1 的新事实：用户实际运行的是 **DSH Desktop 0.2.1-rc.3**（不是 PATH 上的 0.1.5-rc.1），provider 是 **commandcode**。

## 1. 约束重述（已被实测确认）

| 编号 | 约束 | 证据 |
|---|---|---|
| C1 | DSH Runtime 是 Node 程序；官方 SDK 是 TypeScript/Node 库，通过 spawn 子进程 + stdio JSON-RPC 驱动 | `@deepseek-ai/dsh-sdk-client@0.2.1-rc.3` 依赖同版本 `@deepseek-ai/dsh` 并自行解析可执行文件 |
| C2 | 用户实际 Provider 是第三方插件 `@mars-sea/dsh-commandcode-provider@0.15.4`，要求 DSH `>=0.2.1-rc.2 <0.2.2` | 插件 `package.json` 的 `dsh.compatibility`；桌面端 0.2.1-rc.3 |
| C3 | 0.2.1-rc.3 有 `session/resume`，但**仍无** Runtime 级取消；工具审批回调**未观察到**（`UNKNOWN`，不是"已证明不存在"） | `spike/dsh-probe/current-0.2.1/evidence/cc-5-capability/summary.json` |

C1+C2 的直接结论：**本机必须有一个能加载第三方 bundle 的 Node 运行时来承载 DSH**，且该运行时的版本必须与插件兼容（0.2.1 线）。

## 2. Electron 的真实进程拓扑

不能再用「单进程」描述它：

```
AI Game Studio (Electron)
│
├── Main Process (Node)
│   ├── Studio 业务服务层（任务/状态/审批/锁）
│   ├── DSH SDK Client  ← @deepseek-ai/dsh-sdk-client
│   │   └── spawn → DSH Runtime (node.exe, profile=cc-sdk)
│   │       ├── commandcode provider 插件
│   │       ├── MCP Client ── stdio ──→ Studio MCP Server (node.exe)
│   │       └── Shell / PTY 等工具子进程
│   └── SQLite / 文件适配器
│
├── Renderer Process (Chromium)  ← 只拿序列化事件，不持有 SDK
├── GPU Process
└── Utility Processes (crashpad 等)
```

由此得到两条必须写进实现的约束：

1. **进程回收不是一个 `kill`**。关闭顺序必须是：`SDK.close()` → 等 DSH Runtime 退出 → 等 MCP Server 退出 → 校验进程树为空（三态检测，见 `proc.mjs`）。任何一步只等 UI 都是错。
2. **渲染进程不得 import SDK**。`contextIsolation: true`、`nodeIntegration: false`，事件经 `contextBridge` 白名单通道传递。

## 3. 重新评价 Tauri（不再为了证明 Electron 而贬低它）

Tauri 拓扑：

```
AI Game Studio (Tauri)
│
├── Rust Host
│   ├── 窗口 / WebView2 / 菜单 / 文件对话框
│   └── IPC 转发层
│
└── Node Sidecar (独立进程)
    └── DSH SDK Client
        └── DSH Runtime
            ├── commandcode provider
            └── MCP Client → Studio MCP Server
```

复审的两点批评成立，本版接受：

- **跨进程锁并非不可靠**。只要约定「文件 / 构建 / Git / 任务执行全部由 Node sidecar 独占」，Rust 侧只读 UI 状态，锁的所有权就是单一且清晰的。这一点我上一版说错了。
- **Tauri 的体积与内存优势是真实的**（外壳 ~10 MB + WebView2 复用系统组件），对「本地单用户工具」并非无意义。

那么两者的真实差异收敛为三条，而不是「能不能做」：

| 维度 | Electron | Tauri + Node sidecar |
|---|---|---|
| 运行时数量 | 1 个 Node（main process 内） | 2 个（Rust + Node） |
| 关闭/崩溃的失败组合 | 1 个进程树的退出顺序 | 外壳活着 + sidecar 死了 / sidecar 活着 + 外壳死了 / 各自持有部分子进程 |
| 打包与签名 | electron-builder 一条链 | Tauri bundler + sidecar externalBin，两条链 |
| 团队门槛 | 纯 TS | Rust + TS 双栈 |
| 体积/内存 | 较大 | 明显更小 |
| 安全模型 | Node 全权 | Rust 侧可做能力收窄 |

**本 ADR 的判断**：本产品的风险重心不在安装体积，而在「Agent 子进程的生命周期与写锁」——因为 DSH 没有取消能力，停止一个任务只能关进程（C3），一旦一个 Runtime 承载多任务，关闭边界就是产品正确性问题。每多一个运行时，就多一组「谁还活着」的状态组合。因此在**当前阶段**仍推荐 Electron。

但这是**有条件的推荐**，条件写在 §5。如果 PHASE 01 的打包冒烟失败，Tauri 是**完全可行**的备选，而不是退路。

## 4. 推荐方案（条件批准）

**Electron + React + TypeScript；DSH SDK 只在主进程；SQLite 选型推迟。**

理由按权重：

1. 与 C1 一致：不引入第二个运行时来跑一个 Node 依赖。
2. 与 C3 一致：无取消 → 关闭即停止 → 进程所有权必须唯一可审计。
3. 锁与隔离的落点单一：所有写操作（文件/Git/构建）只在主进程的适配器里。
4. 团队门槛低：单语言栈，PHASE 01–07 的迭代成本最低。

明确不选的替代：纯浏览器 + 本地 HTTP 服务。它把「打开应用」降级为「先起服务再开浏览器」，与产品承诺「用户不必理解内部架构」冲突。若 Electron 打包失败，此形态可作为临时验证手段，但需新开 ADR。

## 5. PHASE 01 必做的打包冒烟（Electron 批准的前置条件）

打包版必须逐条验证，任何一条失败都要回到本 ADR：

| # | 冒烟项 | 为什么必须 |
|---|---|---|
| 1 | 打包后 SDK 能 `start()` | asar 内 `dsh` 可执行性未验证 |
| 2 | 打包后 DSH Runtime 能启动（0.2.1-rc.3） | 依赖 Node 版本与路径解析 |
| 3 | 打包后 **commandcode 能加载** | 第三方 bundle 需要 node_modules 解析链 |
| 4 | 打包后 MCP Server 能启动并被调用 | 需要绝对路径，asar 内不可执行 |
| 5 | 关闭后进程树为空（三态检测） | 防止「UI 关了但 Agent 还在跑」 |
| 6 | 不依赖开发环境的 Node 路径 | 开发机 `process.execPath` 与打包后不同 |
| 7 | 不写用户已有 `~/.dsh` 配置 | 隔离原则，见 ADR-0002 §5 |

配套工程约束：DSH Runtime 与 MCP Server 必须 `asarUnpack` 或放在 `resources/runtime/`；启动前做依赖自检，缺失时给可读错误而不是 `JSON-RPC input closed`。

## 6. 数据方案（推迟，但有边界）

- 本阶段无业务数据，不锁定 SQLite 具体实现。
- PHASE 01 首个任务验证两条路：`better-sqlite3`（需 `electron-rebuild`）或 Electron 内置 Node 的 `node:sqlite`（版本可用性未验证）。
- 无论选哪条，**数据库文件必须可备份**：单文件 + WAL，导出/导入走显式命令。

## 7. 未验证风险

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | Electron 打包后运行时解析失败 | 打包版不可用 | §5 冒烟 1–7 |
| R2 | 启动耗时双峰（热 2.2–3.2 s；重建 profile 模块回退 73–128 s） | 首启动像卡死 | 两档超时 + 进度反馈；PHASE 01 评估安装期预热 |
| R3 | 陈旧 `profiles/node_modules.lock` 让下次启动 2 s 后失败，且 SDK 只报 `JSON-RPC input closed` | 应用「打不开」且原因不可读 | 启动前 `clearStaleProfileLock()`；stderr 摘要透出 |
| R4 | commandcode 插件要求 0.2.1 线，Electron 内置 Node 版本可能不满足 | Runtime 起不来 | 打包时外置 Node 24 或校验版本 |
| R5 | 代码签名 / 自动更新链路未做 | 无法分发 | PHASE 07 |

## 8. 复审关注点

1. 是否接受「当前阶段推荐 Electron，但 Tauri 为等价可行备选」这一条件表述？
2. §5 的 7 条冒烟是否足够作为 Electron 的批准前置条件？
3. 是否接受把数据库选型继续推迟到 PHASE 01 初期？
