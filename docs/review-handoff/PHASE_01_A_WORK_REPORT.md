# PHASE 01-A 工作报告｜Windows 桌面应用基础与 DSH 真实连接状态

权威状态：PHASE 01-A 记录在 `state/phase_01_a.json`；PHASE 00 的权威记录仍为
`state/project_state.json` → `phase_00_final`。

## 1. 本阶段目标

交付一个真正能在 Windows 上启动、关闭、并显示 DSH **真实**连接状态的桌面应用最小闭环。
判据不是页面数量，而是「应用能跑，且它显示的 DSH 状态是真的」。

## 2. 固定开发基线

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/xiaoLin12130/ai_game_studio` |
| PHASE 00 最终批准提交 | `9c8757c8e91ec10ca0fd1114408306dd72980709`（标签 `phase-00-final`） |
| 本阶段分支 | `phase/01-a-windows-foundation`（从上述提交创建，未回退、未改写历史） |

## 3. 最终 Git SHA

以分支 HEAD 为准（`git rev-parse HEAD`）。仓库内不复刻本提交自身 SHA，理由与 PHASE 00 相同：
写进去就要再提交一次，新提交又让该 SHA 失效。

## 4. 技术栈与理由

| 选择 | 理由 |
|---|---|
| **Electron 44.7.0（精确钉死）** | DSH 原生 addon 有 Electron 运行时白名单；45.3.0 会被拒绝（见 §7.4）。44.7.0 与 DSH Desktop 自身一致 |
| TypeScript 5.9 + tsc | 与 ADR-0001 一致；不引入打包器，编译产物即运行产物 |
| 渲染层：静态 HTML/CSS + 编译后的 DOM 脚本 | 本阶段只有一个状态卡片；引入 React/Vite 会把失败面从 1 个编译产物扩大到开发服务器、路由与 CSP。渲染进程被 IPC 完全隔离，后续换框架不需要改主进程与适配层（P2-1） |
| 无第二个运行时 | 与 ADR-0001 §4 一致：不为了跑一个 Node 依赖再引入一个宿主 |

## 5. 实际实现内容

- **主进程**：应用生命周期、单实例锁、窗口创建、IPC 注册、用户数据目录初始化、退出时取消探测。
- **preload**：4 个白名单通道（读状态 / 重新检测 / 打开日志 / 读诊断）+ 1 个状态推送。
- **渲染进程**：顶部状态徽标、DSH 状态卡片、6 项事实（版本 / 协议服务 / 最近检测 / 耗时 / 退出码 / 入口来源）、诊断折叠面板、日志入口、重新检测按钮。
- **DSH 适配层**：入口定位（随 SDK 捆绑或自定义路径）、就绪探测、错误分类、单飞与取消。
- **配置**：默认值 + 校验；损坏文件改名备份，恢复行为显示在界面上。
- **日志**：JSON Lines、字段级脱敏、2 MB 轮转保留 3 份。
- **桌面冒烟**：真实启动 Electron、等待握手、截图、退出，并检查无残留进程。

## 6. 修改与新增文件

```
apps/studio/
├── package.json  tsconfig.json
├── src/
│   ├── shared/status.ts                 状态模型与错误分类（纯函数）
│   ├── main/{main,window,ipc,config,logger}.ts
│   ├── main/dsh/{locate,probe,service}.ts
│   ├── preload/preload.ts
│   └── renderer/{index.html,styles.css,renderer.ts}
├── test/{config,logger,status,service,probe.integration}.test.js   33 项
└── scripts/{ensure-electron,copy-assets,smoke,record-evidence}.mjs

docs/architecture/desktop-architecture.md
docs/runtime/dsh-connection-design.md
docs/review-handoff/PHASE_01_A_WORK_REPORT.md
phases/PHASE_01_A_WINDOWS_FOUNDATION.md
state/phase_01_a.json
evidence/phase-01-a/…
```

另有两处 PHASE 01 工程改进（不重开 PHASE 00）：

| 项 | 改动 | 说明 |
|---|---|---|
| 8.1 评审基线字段语义 | 不改 PHASE 00 记录，改为在 `state/phase_01_a.json.review_baseline_semantics` 中定义 product / review-pinned / phase-closing 三个概念 | DEFERRED 到 PHASE 01-B 统一字段名 |
| 8.2 全量运行 stateSource | `spike/dsh-probe/current-0.2.1/run-all.mjs` 的汇总新增 `stateSource`；套件新增两条断言 | PHASE 00 套件 166/166 仍全绿；未覆盖 r154 证据 |

## 7. DSH 检测机制与真实能力边界

### 7.1 就绪判据

> 用真实 dsh 可执行文件，在隔离 DSH home 上 spawn SDK runtime，在超时内完成 `initialize`
> 握手并拿到 `serverInfo`，随后关闭并确认进程退出。

比「文件存在 / 进程在 / 端口开」强，比「模型能回答」弱。探测 **不发 prompt**，零模型额度。

### 7.2 证明与不证明

**证明**：runtime 起得来；插件树挂载完成；当前 provider/model 路由可解析；stdio JSON-RPC 双向可用；关闭后进程退出。

**不证明**：模型真能回答（未验凭据/额度/网络）；版本匹配（版本单独读 manifest）；
用户真实 `~/.dsh` profile 可用；工具与长跑稳定性。详见 `docs/runtime/dsh-connection-design.md`。

### 7.3 失败分类

BINARY_MISSING / PROFILE_MISSING / HOME_UNUSABLE / PROFILE_MANIFEST_INVALID / PROFILE_DEGRADED /
ROUTE_UNKNOWN / TIMEOUT / INIT_FAILED / INTERNAL_ERROR，锚点全部取自本机真实报错，并有单测覆盖。
**空结果一律 UNKNOWN，绝不默认就绪。**

### 7.4 两条 Electron 相关的硬约束（本轮实际踩到）

1. **子进程必须带 `Electron_RUN_AS_NODE`**：SDK 用 `process.execPath` 启动 runtime，在 Electron 里
   那是 `electron.exe`，默认按 GUI 启动，永远不说 JSON-RPC，表现为「握手超时」。
2. **Electron 必须 44.7.0**：45.3.0 下 DSH 原生 addon 直接拒绝——
   `unsupported Electron runtime fingerprint: Node 24.22.2, V8 15.6.75.50-electron.0
   (supported Electron versions: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6)`。

## 8. 测试命令与完整结果

| 命令 | 结果 | 退出码 | 证据 |
|---|---|---|---|
| `npm run build`（tsc + copy-assets） | 通过 | 0 | — |
| `node --test` | **33/33 PASS**（含 5 项真实 DSH 集成测试） | 0 | `eXevidence/phase-01-a/app-tests.json` |
| `node scripts/smoke.mjs` | **10/10 检查通过**，墙钟 2.33 s | 0 | `eXevidence/phase-01-a/desktop-smoke/smoke-run.json` |
| `node tests/run-tests.mjs`（PHASE 00 套件） | **166/166 PASS** | 0 | 未发布，见 §6 说明 |
| `node scripts/run-gates.mjs`（PHASE 00 三门禁） | dependency / state / leak 全 PASS，0 泄漏 | 0 | `eXevidence/phase-01-a/phase00-gates.json` |

测试分三层，互不冒充：单元（纯函数/配置/日志）→ 集成（真实 dsh 进程）→ 桌面（真实 Electron 窗口）。

## 9. Windows 实际运行验证

由 `scripts/smoke.mjs` 在真实 Windows 上执行，10 项检查全部通过：

```
exitCodeZero / producedSmokeJson / windowVisible / singleWindow / rendererLoaded /
screenshotWritten / dshReady / handshakeIdentity / runtimeExitCodeObserved / noLingeringRuntime
```

其中 `runtimeExitCodeObserved` 证明探测真的读到了 SDK 报告的 runtime 退出码；`noLingeringRuntime`
在应用退出后扫描进程表确认无残留。窗口截图：`eXevidence/phase-01-a/desktop-smoke/window.png`。

## 10. 构建产物

- 未生成正式安装包（DEFERRED D1）。ADR-0001 §5 的打包冒烟未执行，因此 Electron 在 ADR 中的状态
  仍是「条件批准」，不因本阶段而转正。
- 已生成并实际运行的是**桌面开发构建**（`apps/studio/dist/`），由 `npm run build` 产出。
- Electron 二进制：44.7.0，246,302,208 bytes（`node_modules/electron/dist/electron.exe`，不入库）。

## 11. 问题清单

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 2 | P2-1 渲染层未用框架；P2-2 正式安装包未构建 |
| P3 | 0 | — |

本轮实际修复（实施期内，非评审缺陷）：Electron 45 运行时指纹不兼容、子进程缺 `Electron_RUN_AS_NODE`、
dsh 入口解析方式（CLI 包无 "." export）、证据目录误收 Chromium 用户数据。

## 12. DEFERRED

| ID | 内容 | 阶段 |
|---|---|---|
| D1 | Electron 打包冒烟（ADR-0001 §5 七项） | PHASE 01-B 或独立打包阶段 |
| D2 | review_baseline_commit 字段语义统一 | PHASE 01-B 状态结构调整 |

## 13. BLOCKED

无。

## 14. UNKNOWN

| ID | 内容 | 何时可验证 |
|---|---|---|
| U-01A-1 | 打包后 dsh runtime 能否启动（asar 内路径与原生 addon） | 执行打包后跑 ADR-0001 §5 |

## 15. 当前工作区状态

分支 `phase/01-a-windows-foundation`，工作区干净，已推送（见 §3）。
PHASE 00 的历史证据（`eXevidence/r14、r15、r151、r152、r153、r154`）未被修改。

## 16. 阶段关闭建议

**建议关闭 PHASE 01-A。** 九项验收门禁全部满足且有证据；无 P0/P1；两项 DEFERRED 与一项 UNKNOWN
均不影响本阶段验收（打包属于下一阶段前置）；测试与桌面验证均在真实 Windows 上执行。

下一阶段准备（不直接开始）：PHASE 01-B 接入官方 MCP SDK 替换手写原型，并把打包冒烟作为前置。
