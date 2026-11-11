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
│   ├── shared/status.ts                    状态模型与错误分类（纯函数）
│   ├── main/{main,window,ipc,config,logger}.ts
│   ├── main/dsh/{locate,probe,service,processes}.ts
│   ├── preload/preload.ts
│   └── renderer/{index.html,styles.css,renderer.ts}
├── test/
│   ├── config / logger / status / service .test.js          基础
│   ├── probe.integration.test.js                           真实 DSH 集成
│   ├── lifecycle.test.js                                   Runtime 生命周期（P1-01）
│   └── transitions.test.js                                 失败→恢复→READY（P2-02）
└── scripts/{ensure-electron,copy-assets,smoke,record-evidence}.mjs

docs/architecture/desktop-architecture.md
docs/runtime/dsh-connection-design.md
docs/review-handoff/PHASE_01_A_WORK_REPORT.md
phases/PHASE_01_A_WINDOWS_FOUNDATION.md
state/phase_01_a.json
evidence/phase-01-a/…
```

### 6.1 本修复轮（R1）的改动

| 问题 | 改动 | 关键文件 |
|---|---|---|
| **P1-01** Runtime 生命周期 | 探测返回可停止的 handle；teardown 单飞且幂等；新增 OS 级进程确认；服务层 shutdown 协调；`before-quit` 拦截退出并等待清理 | `dsh/probe.ts`、`dsh/service.ts`、`dsh/processes.ts`、`main.ts` |
| **P2-01** 桌面失败场景 | 冒烟拆成三个场景（ready / failure / quit-during-probe），failure 场景用真实坏 profile 验证 UI 呈现 | `scripts/smoke.mjs`、`main.ts` |
| **P2-02** 状态转换 | 新增 transitions 测试：失败→修复→READY、READY 复检、单飞、状态与 UI 一致 | `test/transitions.test.js` |
| **P2-03** 报告路径错字 | 5 处 `eXevidence/` 修正为 `evidence/` | 本文件 |

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
另有 STOPPED 表示「被调用方主动停止」，**空结果一律 UNKNOWN，绝不默认就绪。**

### 7.4 两条 Electron 相关的硬约束

1. **子进程必须带 `Electron_RUN_AS_NODE`**：SDK 用 `process.execPath` 启动 runtime，在 Electron 里
   那是 `electron.exe`，默认按 GUI 启动，永远不说 JSON-RPC，表现为「握手超时」。
2. **Electron 必须 44.7.0**：45.3.0 下 DSH 原生 addon 直接拒绝——
   `unsupported Electron runtime fingerprint: Node 24.22.2, V8 15.6.75.50-electron.0
   (supported Electron versions: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6)`。

### 7.5 Runtime 生命周期（P1-01）

探测是这个 runtime 的**唯一所有者**，并一直负责到「确认已退出」为止，包括用户在握手途中退出应用。

| 阶段 | 行为 |
|---|---|
| 收到退出请求 | `before-quit` 被拦截（`preventDefault`），开始 shutdown；此后新的探测请求被拒绝 |
| 停止探测 | `probe.stop()` 幂等：立刻开始 teardown，并打断正在等待握手的那一段 |
| 关闭 runtime | `client.close()`（SDK 文档保证「进程真正退出后才 resolve」），整段有 15 s 上界 |
| 确认退出 | 三重信号：① close 已 resolve；② 订阅被 exit 事件以 `exit code: <n>` 失败（记录退出码）；③ **操作系统进程表**里没有该 DSH home 的进程 |
| 失败/超时 | 记录 `dsh.shutdown.result`（level=error）并给出明确终态；退出等待有硬上界（SHUTDOWN_BOUND_MS + 5 s 兜底），绝不无限阻塞 |
| 重复退出 | 第二次请求 join 同一个 shutdown，只产生一次 close |
| 清理幂等 | 每次探测只有一个 teardown promise，`stop()` 多次调用返回同一份报告 |

**为什么需要三重信号**：SDK 的 Promise 与它自己报的退出码来自同一侧；进程表来自另一侧。
只用 Promise 结束就断言「进程没了」，正是评审指出的不可靠之处。

## 8. 测试命令与完整结果（本轮真实执行）

| 命令 | 结果 | 退出码 | 证据 |
|---|---|---|---|
| `npm run build`（tsc + copy-assets） | 通过 | 0 | — |
| `node --test` | **45/45 PASS**（0 fail / 0 skipped） | 0 | `evidence/phase-01-a/app-tests.json` |
| `node scripts/smoke.mjs ready` | 12/12 检查通过 | 0 | `evidence/phase-01-a/smoke/ready/` |
| `node scripts/smoke.mjs failure` | 11/11 检查通过（真实坏 profile） | 0 | `evidence/phase-01-a/smoke/failure/` |
| `node scripts/smoke.mjs quit-during-probe` | 9/9 检查通过（退出时回收 runtime） | 0 | `evidence/phase-01-a/smoke/quit-during-probe/` |
| `node tests/run-tests.mjs`（PHASE 00 套件） | **166/166 PASS** | 0 | 未重新发布，见下方说明 |
| `node scripts/run-gates.mjs`（PHASE 00 三门禁） | dependency / state / leak 全 PASS，0 泄漏 | 0 | `evidence/phase-01-a/phase00-gates.json` |

汇总见 `evidence/phase-01-a/verification.json`，每项都有独立日志 `evidence/phase-01-a/*.log`。

测试分三层，互不冒充：单元（纯函数/配置/日志）→ 集成（真实 dsh 进程）→ 桌面（真实 Electron 窗口）。
**新增的 12 项测试**（45 项中的一部分）覆盖 P1-01 与 P2-02；原有 33 项全部保留并继续通过。

说明：PHASE 00 的 `r154` 证据未被覆盖。本轮只验证「PHASE 00 套件不受本轮改动影响」，因此
不重新发布其证据轮次。

## 9. Windows 实际运行验证

三个场景都由 `scripts/smoke.mjs` 在真实 Windows 上启动真实 Electron 进程：

| 场景 | 验证内容 | 结果 |
|---|---|---|
| `ready` | 窗口可见、页面加载、握手成功、UI 显示已就绪、截图、退出后无残留 | PASS |
| `failure` | 真实坏 profile → UI 显示「不可用」与原因、应用仍可用、可再次检测 | PASS |
| `quit-during-probe` | 在握手中途请求退出 → runtime 被回收、进程表确认无残留、退出码被记录 | PASS |

`quit-during-probe` 是 P1-01 的端到端证据：应用在握手进行中收到退出请求，日志中
`dsh.shutdown.result` 记录 `completed: true`、`teardown.closed: true`、`teardown.processAbsent: true`，
且退出后进程表中没有任何持有该 DSH home 的进程。
失败场景截图：`evidence/phase-01-a/smoke/failure/window.png`（顶部「不可用」、正文为可读原因）。

## 10. 构建产物

- 未生成正式安装包（DEFERRED D1）。ADR-0001 §5 的打包冒烟未执行，因此 Electron 在 ADR 中的状态
  仍是「条件批准」，不因本阶段而转正。
- 已生成并实际运行的是**桌面开发构建**（`apps/studio/dist/`），由 `npm run build` 产出。
- Electron 二进制：44.7.0，246,302,208 bytes（`node_modules/electron/dist/electron.exe`，不入库）。

## 11. 问题清单

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | P1-01 已修复（见 §7.5、§8、§9） |
| P2 | 2 | P2-1 渲染层未用框架；P2-2 正式安装包未构建 |
| P3 | 0 | — |

外部评审提出的四项，逐项状态：

| 编号 | 状态 | 证据 |
|---|---|---|
| P1-01 退出期间 Runtime 未保证回收 | **已修复** | lifecycle 测试 8 项 + quit-during-probe 冒烟 |
| P2-01 桌面失败场景缺测试 | **已修复** | failure 冒烟（真实坏 profile + DOM 断言） |
| P2-02 缺失败→恢复→READY 转换测试 | **已修复** | transitions 测试 4 项 |
| P2-03 报告路径拼写错误 | **已修复** | 本文件 5 处 eXevidence → evidence |

实施期内另修复（非评审缺陷）：Electron 45 运行时指纹不兼容、子进程缺 `Electron_RUN_AS_NODE`、
dsh 入口解析方式（CLI 包无 "." export）、证据目录误收 Chromium 用户数据、冒烟残留检查自匹配。

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
| U-01A-2 | 非 Windows 平台上的进程确认（当前 OS 级检查只在 win32 生效，其它平台返回 FAILED 并记为未知） | 若产品跨平台时 |

## 15. 当前工作区状态

分支 `phase/01-a-windows-foundation`，工作区干净，已推送（见 §3）。
PHASE 00 的历史证据（`eXevidence/r14、r15、r151、r152、r153、r154`）未被修改。

## 16. 阶段关闭建议

**READY_FOR_EXTERNAL_REVIEW。** 外部评审提出的 P1-01、P2-01、P2-02、P2-03 均已修复并有真实证据；
无 P0/P1 遗留；DEFERRED 两项与 UNKNOWN 两项均不影响本阶段验收。

PHASE 01-A 是否正式关闭，由外部独立评审决定，本报告不自行宣布关闭。

下一阶段准备（不直接开始）：PHASE 01-B 接入官方 MCP SDK 替换手写原型，并把打包冒烟作为前置。
