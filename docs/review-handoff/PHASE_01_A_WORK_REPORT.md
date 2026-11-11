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

### 6.1 修复轮改动

**R1（提交 `c0cd5b9`）**

| 问题 | 改动 | 关键文件 |
|---|---|---|
| P1-01（首轮） | 探测返回可停止的 handle；teardown 单飞幂等；服务层 shutdown 协调；`before-quit` 拦截并等待清理 | `dsh/probe.ts`、`dsh/service.ts`、`main.ts` |
| P2-01（首轮） | 冒烟拆成 ready / failure / quit-during-probe 三场景 | `scripts/smoke.mjs` |
| P2-02 | 新增状态转换测试 | `test/transitions.test.js` |
| P2-03（首轮） | 5 处路径错字 | 本文件 |

**R2（本轮，针对第二轮评审）**

| 问题 | 改动 | 关键文件 |
|---|---|---|
| **P1-01** 完成条件错误 | `completed` 改为严格判定：close 成功 **且** OS 明确 ABSENT **且** 未超时；`null`（无法确定）不再被当作成功 | `dsh/service.ts`、`dsh/probe.ts` |
| **P1-01** READY 早于清理 | 握手后必须等待 teardown；未确认回收则返回 `UNKNOWN` + `TEARDOWN_UNCONFIRMED`，不显示健康状态 | `dsh/probe.ts` |
| **P1-01** 无兜底回收 | 新增按命令行验明归属的定向终止（`taskkill /PID`，先复核再杀，终止后重新查询），上界 6 s | `dsh/processes.ts` |
| **P1-01** 日志字段不全 | `dsh.shutdown.result` 记录 completed / confirmedGone / timedOut / teardownAttempted / closeSucceeded / closeError / processCheckStatus / processAbsent / remainingPids / forcedTermination* / exitCode / error / durationMs | `dsh/service.ts` |
| **P2-01** 失败场景断言不足 | failure 冒烟新增按钮可用性并**真的点击**触发第二次探测 | `scripts/smoke.mjs`、`main.ts` |
| **P2-03** 证据引用不一致 | state 的 A1/A2/A5 改指本轮 smoke；verification.json 覆盖 7 条命令；README 改为描述实际提交的 `.txt` 输出 | `state/phase_01_a.json`、`evidence/phase-01-a/` |

**R3（本轮，针对第三轮评审）**

| 问题 | 改动 | 关键文件 |
|---|---|---|
| **P1-02** 兜底回收没有真实上界 | 进程表与 taskkill 全部改为**异步**（不再阻塞主进程），每次调用只拿到「剩余预算」，低于 PowerShell 最小可执行预算时直接判超时而不发必然超时的查询；整段回收共用一个绝对 deadline | `dsh/processes.ts` |
| **P1-02** 预算写死在注释里 | 常量与文档一致：close 15 s、兜底 6 s、teardown 合计 22 s、shutdown 25 s、退出兜底 +5 s；超时以非零码退出并记录剩余 PID | `dsh/probe.ts`、`dsh/service.ts`、`main.ts` |
| **P1-03** 用 DSH home 判所有权会误杀 | 实测发现真实 runtime 的命令行**不含** home（home 是环境变量），原判据对真实进程命中 0 条。改为「父进程 = 本进程 + 命令行含 dsh CLI」捕获实例身份，并用创建时间钉住，PID 复用即拒绝终止 | `dsh/processes.ts`、`dsh/probe.ts` |
| **P2-04** 报告路径错字 | 9 处路径前缀错字修正为 `evidence/`（见 §8 证据列）；状态文件 2 处同时修正。PHASE 00 关闭报告中的同类错字**未改动**（PHASE 00 已关闭，不得修改其文档） | 本文件、`state/phase_01_a.json` |

另有两处 PHASE 01 工程改进（不重开 PHASE 00）：评审基线字段语义（DEFERRED）、全量运行记录 `stateSource`（已实现，PHASE 00 套件 166/166 仍全绿）。

## 7. DSH 检测机制与真实能力边界

### 7.1 就绪判据

> 用真实 dsh 可执行文件，在隔离 DSH home 上 spawn SDK runtime，在超时内完成 `initialize`
> 握手并拿到 `serverInfo`，**然后确认该探测所创建的 runtime 已被回收**。

比「文件存在 / 进程在 / 端口开」强，比「模型能回答」弱。探测 **不发 prompt**，零模型额度。

### 7.2 证明与不证明

**证明**：runtime 起得来；插件树挂载完成；当前 provider/model 路由可解析；stdio JSON-RPC 双向可用；关闭后进程确实消失（OS 进程表确认）。

**不证明**：模型真能回答（未验凭据/额度/网络）；版本匹配（版本单独读 manifest）；
用户真实 `~/.dsh` profile 可用；工具与长跑稳定性。详见 `docs/runtime/dsh-connection-design.md`。

### 7.3 失败分类

BINARY_MISSING / PROFILE_MISSING / HOME_UNUSABLE / PROFILE_MANIFEST_INVALID / PROFILE_DEGRADED /
ROUTE_UNKNOWN / TIMEOUT / INIT_FAILED / STOPPED / **TEARDOWN_UNCONFIRMED** / INTERNAL_ERROR。
**空结果一律 UNKNOWN，绝不默认就绪。**

### 7.4 两条 Electron 相关的硬约束

1. **子进程必须带 `Electron_RUN_AS_NODE`**：SDK 用 `process.execPath` 启动 runtime，在 Electron 里
   那是 `electron.exe`，默认按 GUI 启动，永远不说 JSON-RPC，表现为「握手超时」。
2. **Electron 必须 44.7.0**：45.3.0 下 DSH 原生 addon 直接拒绝——
   `unsupported Electron runtime fingerprint: Node 24.22.2, V8 15.6.75.50-electron.0
   (supported Electron versions: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6)`。

### 7.5 Runtime 生命周期与所有权（R3 修正后）

探测是这个 runtime 的**唯一所有者**，并一直负责到「确认已退出」为止。

**身份不是目录，是实例。** 实测：SDK 用环境变量传 DSH home，真实 runtime 的命令行里
**没有** home 字符串——用 home 匹配在真实运行中命中 0 条进程。因此所有权改为：

| 证据 | 取值时机 | 作用 |
|---|---|---|
| 父进程 = 本进程 | spawn 之后立即 | 两个 Studio 实例不会互相看见对方的 runtime |
| 命令行包含 dsh CLI 路径 | 同上 | 排除同父进程下的其它子进程 |
| 创建时间（CreationDate） | 同上 | 钉住实例；PID 被复用后创建时间不同，拒绝终止 |

home **不参与**终止授权。

**时间上界是真实的。** 进程查询与 taskkill 全部异步（`execFile` 回调），不会阻塞
Electron 主进程；整段回收共用一个绝对 deadline，每次调用只拿到剩余预算；低于
PowerShell 最小可执行预算（1.2 s）时直接判「没有时间」，而不是发一个必然超时的查询。

| 概念 | 条件 | 用途 |
|---|---|---|
| `completed` | close 成功 **且** 首次 OS 检查即 ABSENT **且** 未超时 | 决定探测能否返回 READY |
| `confirmedGone` | OS 明确 ABSENT（close 或兜底终止之后） | 决定应用退出码 |

关键点：

- **`null` 不等于成功**：无法确认（查询失败、超时、身份没建立）一律不算清理成功。
- **READY 要等清理**：握手成功但回收未确认 → `UNKNOWN` + `TEARDOWN_UNCONFIRMED`。
- **退出码只是诊断**：来自 SDK 同一通道，不构成独立证据。
- **兜底只在能证明归属时执行**：逐个复核身份（PID + 创建时间）后才 `taskkill /F /T /PID`，
  终止后重新查询；确认不了就不杀。
- **预算**：close 15 s、兜底 6 s、teardown 合计 22 s、shutdown 25 s、退出兜底 +5 s。
  超时以非零码退出，日志记录 remainingPids 与错误原因。

### 7.6 实测耗时（本轮真实测量）

脚本 `scripts/process-timings.mjs`，对真实子进程测量；原始数据 `evidence/phase-01-a/process-timings.json`。

| 环节 | 实测 | 说明 |
|---|---|---|
| 身份捕获（一次子进程查询） | 1296 ms | PowerShell + WMI 启动占主导 |
| 子进程列表查询 | 1102 ms | 同上 |
| PID 复核（inspect） | 1050 ms | 同上 |
| **taskkill** | **107 ms** | 终止本身很快 |
| 终止后再次确认 | 1074 ms | 仍是查询成本 |
| **整段兜底回收** | **2401 ms** | 复核 + 终止 + 确认，落在 6 s 预算内，尚有一次重试余量 |

这组数字也解释了为什么最小可执行查询预算是 1200 ms：低于它发起的查询必然超时。

## 8. 测试命令与完整结果（本轮真实执行）

| 命令 | 退出码 | PASS | FAIL | SKIP | 证据 |
|---|---|---|---|---|---|
| `node node_modules/typescript/bin/tsc -p tsconfig.json` | 0 | — | — | — | `evidence/phase-01-a/build-typescript.txt` |
| `node --test` | **0** | **53** | **0** | **0** | `evidence/phase-01-a/app-tests.json` |
| `node scripts/smoke.mjs ready` | **0** | 12/12 | 0 | 0 | `evidence/phase-01-a/smoke/ready/` |
| `node scripts/smoke.mjs failure` | **0** | 16/16 | 0 | 0 | `evidence/phase-01-a/smoke/failure/` |
| `node scripts/smoke.mjs quit-during-probe` | **0** | 11/11 | 0 | 0 | `evidence/phase-01-a/smoke/quit-during-probe/` |
| `node tests/run-tests.mjs`（PHASE 00 套件） | **0** | **166** | 0 | 0 | `evidence/phase-01-a/phase00-regression-suite.txt` |
| `node scripts/run-gates.mjs`（PHASE 00 三门禁） | **0** | 3 门全 PASS，0 泄漏 | 0 | 0 | `evidence/phase-01-a/phase00-gates.json` |

汇总：`evidence/phase-01-a/verification.json`（每条命令的 cwd / 退出码 / 耗时 / 计数 / 产物都在里面）。
每条的完整输出以 `.txt` 提交（`*.log` 被 .gitignore 忽略，因此不用 .log）。

测试从 53 增至 58：新增 8 项生命周期与进程回收用例，原有测试全部保留并通过。
其中 `processes.test.js` 的回收测试**不使用 mock**：它真的 spawn 一个带本探测 DSH home 的进程，
经 OS 进程表确认存在、命令行验明归属、定向终止、再查询确认消失。

## 9. Windows 实际运行验证

三个场景都由 `scripts/smoke.mjs` 启动真实 Electron 进程：

| 场景 | 检查数 | 验证内容 | 结果 |
|---|---|---|---|
| `ready` | 12 | 窗口可见、页面加载、握手成功、UI 显示已就绪、截图、退出后无残留 | PASS |
| `failure` | 16 | 真实坏 profile → 显示「不可用」与原因；按钮可用；**实际点击重新检测跑第二次并仍是失败**；UI 与状态一致 | PASS |
| `quit-during-probe` | 11 | 握手中途退出 → 身份已捕获、close 成功、OS 确认 ABSENT、**无需兜底**、退出码为 0 | PASS |

`quit-during-probe` 是生命周期与所有权的端到端证据：日志 `dsh.shutdown.result` 记录
`completed: true`、`confirmedGone: true`、`processCheckStatus: "ABSENT"`、
`forcedTerminationAttempted: false`、`runtimePid` 为真实 PID，且退出后进程表中没有任何持有该
DSH home 的进程。

## 10. 构建产物

- 未生成正式安装包（DEFERRED D1）。ADR-0001 §5 的打包冒烟未执行，Electron 在 ADR 中仍是「条件批准」。
- 已生成并实际运行的是**桌面开发构建**（`apps/studio/dist/`），由 `npm run build` 产出。
- Electron 二进制：44.7.0（`node_modules/electron/dist/electron.exe`，不入库）。

## 11. 问题清单

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | P1-01（两轮）与 P1-02/P1-03 均已修复（见 §7.5） |
| P2 | 2 | P2-1 渲染层未用框架；P2-2 正式安装包未构建 |
| P3 | 0 | — |

外部评审四轮意见逐项状态：

| 编号 | 状态 | 证据 |
|---|---|---|
| P1-01（R1）退出期间未回收 runtime | **已修复** | lifecycle 测试 + quit-during-probe 冒烟 |
| P1-01（R2）完成条件与兜底回收 | **已修复** | lifecycle 12 项 + processes 真实进程回收 |
| P2-01（R1）桌面失败场景缺失 | **已修复** | failure 冒烟 |
| P2-01（R2）失败场景断言不足 | **已修复** | failure 冒烟 16 项，含真实点击重新检测 |
| P2-02 状态转换测试 | **已修复** | transitions 4 项 |
| P2-03 证据引用不一致 | **已修复** | state / verification.json / README 与提交文件一致 |
| P1-02（R3）兜底回收无真实上界 | **已修复** | 异步子进程 + 共用 deadline；processes 测试 D |
| P1-03（R3）home 判所有权会误杀 | **已修复** | 实例身份（父进程 + CLI + 创建时间）；processes 测试 B/C |
| P2-04（R3）报告证据路径 | **已修复** | 本文件 9 处路径 + 状态文件 2 处 |

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
| U-01A-2 | 非 Windows 平台的进程确认与回收（当前实现仅 win32） | 若产品跨平台时 |
| U-01A-3 | 若将来一个 Studio 进程内并发启动多个 runtime，当前「父进程 + CLI」捕获会因多重匹配而拒绝建立身份（实现选择拒绝而非猜测） | 引入并发 runtime 时 |
| U-01A-4 | DSH 若改变子进程的启动方式（例如改为经中间进程），身份捕获需重新验证 | 升级 DSH 时 |

## 15. 当前工作区状态

分支 `phase/01-a-windows-foundation`，工作区干净，已推送。
PHASE 00 的历史证据（`spike/dsh-probe/current-0.2.1/evidence/` 下的 r14、r15、r151、r152、r153、r154）
与权威状态 `state/project_state.json` 未被修改。

## 16. 阶段关闭建议

**READY_FOR_EXTERNAL_REVIEW。** 第二轮评审指出的问题全部修复并有真实证据；无 P0/P1 遗留；
DEFERRED 两项与 UNKNOWN 两项均不影响本阶段验收。

PHASE 01-A 是否正式关闭由外部独立评审决定，本报告不自行宣布关闭。

下一阶段准备（不直接开始）：PHASE 01-B 接入官方 MCP SDK 替换手写原型，并把打包冒烟作为前置。
