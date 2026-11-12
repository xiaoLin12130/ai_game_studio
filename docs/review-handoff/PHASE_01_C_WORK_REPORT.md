# PHASE 01-C 工作报告 — DSH Session 生命周期与 Studio Task 状态管理

> **状态：`READY_FOR_EXTERNAL_REVIEW`（R7 / 安装版 A/B/C 最终验收）。** 本报告不宣告通过，是否关闭由外部独立评审决定。
>
> 第 1 轮评审基线 §8cb415b§；第 2 轮修复 Runtime 关闭竞态、补齐两项缺失回归、修正交付记录。第 3 轮（WorkBuddy 接管）补齐 B 场景第二个 Runtime 的真实 OS 进程退出验证**代码**并完成**单元验证**；**安装版 A/B/C 复验被环境阻断**（见 §6.2）。第 4 轮（评审补正）修复 watcher 的异步排空与错误纳入验收（新增 6 项单测），查清 `commandcode` 不匹配的两层根因（陈旧打包 + 沙箱 pnpm 限制），并修正状态文件 C2/C5/C6（不再以失败证据显示 PASS）。第 5 轮（记录修正）统一根因与范围表述、明确 A/B/C 属原始验收范围，并把历史测试与本轮测试分开记录。第 6 轮（R6）用 `%TEMP%` 独立 pnpm store 解阻塞 provider 安装并真实跑通 runtime/中断/恢复阶段，受阻于模型额度窗口。**第 7 轮（R7）额度窗口重置后，安装版 A/B/C 全部真实通过（`ok:true`，43 项检查 / 0 失败）。**

## 1. 本阶段原始目标

1. RuntimeSupervisorManager
2. Session 生命周期管理
3. Task 状态机
4. Task 执行协调
5. 中断与恢复
6. 持久化与崩溃恢复
7. 最小任务管理 UI
8. 测试与真实运行证据

## 2. Git

| 项 | 值 |
|---|---|
| 阶段基线 | `908c2fbff9f1c311e3e28630cb91aaea3d5686c5`（PHASE 01-B 关闭 HEAD） |
| 分支 | `phase/01-c-session-task-lifecycle` |
| 父提交 | `3e0c282`（上一轮"未完成"状态记录） |

## 3. 决定设计的两个实测事实

| 事实 | 依据 | 后果 |
|---|---|---|
| DSH **没有** wire-level cancel | `dsh-sdk-client` 类型注释原文 | 「停止任务」只能关闭该任务所属 Runtime |
| DSH **有**原生 `resumeSession(sessionId)` | `api.d.ts` + 实测 | 中断后 Session 落盘可恢复；恢复是新 attempt 复用原 session |

因此：写入型任务独占 Runtime（否则中断一个会带走另一个），只读任务可共享；恢复失败明确记 `RESUME_FAILED`，绝不静默新建会话。

## 4. 实现

| 模块 | 文件 |
|---|---|
| Task 状态机（表驱动，非法转换抛错） | `src/main/tasks/machine.ts` |
| 数据模型 | `src/main/tasks/types.ts` |
| SQLite 持久化（`node:sqlite`，迁移/事务/唯一约束） | `src/main/tasks/store.ts` |
| Runtime 调度与生命周期 | `src/main/runtime/supervisor.ts` |
| 执行协调、中断、恢复、崩溃恢复 | `src/main/tasks/runner.ts` |
| 服务面（IPC 入口） | `src/main/tasks/service.ts` |
| 任务面板 UI | `src/renderer/{index.html,renderer.ts,styles.css}` |

架构文档：`docs/architecture/phase-01-c-task-lifecycle.md`（含完整状态转换表）。

## 5. 缺陷与修复

### 5.1 第 1 轮评审指出的 P1（本轮修复）

| 编号 | 问题 | 修复 |
|---|---|---|
| P1-CLOSE-RACE | `#close()` 遇到 `state === 'closing'` 直接返回，`shutdownAll()` 不等待在途关闭，把仍在关闭的 Runtime 记为 failed | 每个 Runtime 保存唯一 `closePromise`，首次调用创建、后续一律 await 同一个；`shutdownAll` 等待而非猜测 |
| P1-CLOSE-TIMEOUT | `Promise.race([close, sleep(25000)])` 的超时分支正常 resolve，未关闭的 Runtime 可能被标成 `closed` | 超时改为抛错：未确认关闭不设 `closed`；失败保留在管理表并以 failed 上报，不再静默删除 |
| P1-DISPOSE-RESULT | `dispose()` 返回 closed/failed，但 `gracefulQuit()` 没有检查 | `dispose` 返回 `{closed, failed, ok}` 并记 `task.service.dispose.failed`；退出码按 `ok` 决定 |

新增 `test/runtime-supervisor.test.js`（6 项，全部用 deferred promise 构造竞态，不靠 sleep）：release 与 shutdown 共享同一 close、并发请求只调一次 SDK close、关闭挂起必须失败且保留在管理表、关闭抛错必须上报 failed、干净关闭才消失、dispose 在任一 Runtime 关闭失败时返回 `ok:false`。

### 5.2 顺带修掉的真实缺陷

`#create()` 的启动超时定时器在握手成功后没有清除，会让事件循环空转满 90 秒（测试文件因此耗时 90s）。已改为在 `finally` 中 `clearTimeout`，同一组测试从 90s 降到 0.56s。

### 5.3 上一轮记录的三处缺陷（保留说明）

| 编号 | 级别 | 问题 |
|---|---|---|
| F-01C-1 | P1 | 任务 runtime 没有 provider row，静默跑在 `deepseek-official` 路由上，以 `MISSING_CREDENTIAL` 失败并被表象成"没有 assistant 消息" |
| F-01C-2 | P1 | 会话未开始工作时的第一个 `idle` 被当作回合结束，任务 100ms 内以 0 事件"完成" |
| F-01C-3 | P2 | 启动健康探测与任务 runtime 同父进程，身份捕获歧义时拒绝（安全但报 UNKNOWN） |

## 6. 安装版验证

**进程检查方式（当前实现）**：Runtime 运行时用 `discoverRuntimeIdentities` 持续发现该 Studio 进程创建的所有 DSH Runtime，
每个 Runtime 记录 `(pid, creationMs, capturedAt, source='parent-and-bin')`；退出后用 `verifyRuntimeIdentity` 逐个复核，
判定四态 `PRESENT / ABSENT / FAILED / UNKNOWN`，**只有 ABSENT 算没有残留**。

不使用 DSH home 字符串匹配（home 是环境变量，运行中的 Runtime 命令行不含它，该判据恒返回 ABSENT，已在 `INVALID-1` 标记为无效）。

**B 场景有两个 Runtime**：`rt-001`（首次执行后中断）与 `rt-002`（恢复执行后完成），两者必须分别捕获、分别复核，
`runtimeIdentityCount` 必须为 2，`allRuntimeProcessesGone` 仅在两个检查均为 ABSENT 时为 true。

**成功判据（R7 补正）**：A/B/C 统一为 `finalStatus === 'SUCCEEDED'`。此前 B/C 使用
`['SUCCEEDED','FAILED'].includes(...)`，把恢复后失败也算作通过，已修正；定向测试见
`apps/studio/test/packaged-assertions.test.js`，对既有 R7 数据的独立复核见 `packaged/strict-recheck-r7.json`。

### 6.1 本轮对 B 场景第二个 Runtime 的修复（代码 + 单元验证）

第 2 轮引入的"按 `(pid, creationMs)` 身份复核"解决了 `INVALID-1`（home 字符串匹配），但 B 场景只**单次**捕获一个 Runtime 身份，无法证明"中断→恢复"产生的**第二个** Runtime（rt-002）已退出。本轮补齐：

- `apps/studio/src/main/dsh/processes.ts`：新增 `discoverRuntimeIdentities(table, {parentPid, binMarker})`，返回父进程下**所有**匹配 `dsh CLI` 的子进程身份（而非只取第一个）；保留既有 `captureRuntimeIdentity` / `verifyRuntimeIdentity` / `createProcessTable`。
- `apps/studio/scripts/smoke-tasks-packaged.mjs`：把"单次 `captureIdentity`"替换为 `startIdentityWatcher`——在 App 整个生命周期内轮询（250ms），按 `(pid, creationMs)` 去重收集**所有** Runtime 身份；新增 `checkAllIdentities` 对每一个捕获身份执行 `verifyRuntimeIdentity`。B 场景新增三项强制校验：`runtimeIdentityCount === 2`、`runtimeIdentitiesDistinct === 2`、`allRuntimeProcessesGone`（仅当全部身份 `ABSENT` 才为真）。A/C 沿用同一机制独立验证各自 Runtime。
- 禁止项均遵守：未使用 `commandLine.includes(dshHome)`；未以 GUI 进程退出代替 Runtime 进程检查；未以 SDK `runtime.closed` 日志代替 OS 进程身份检查；四态 `PRESENT/ABSENT/FAILED/UNKNOWN` 一致。

补正轮又修掉两个可靠性缺口（评审指出）：`stop()` 原先只置标志、不等待在途进程查询，App 恰在查询中退出时可能漏记身份；`identityWatchErrors` 原先未进入验收，查询失败仍可能按已捕获身份判定通过。现将 watcher 抽到 `scripts/lib/identity-watcher.mjs`：`stop()` 等待在途 tick 排空并返回最后捕获的身份；`verifyIdentities` 把 `watchErrors` 计入 `allGone`；smoke 脚本改为 `await watcher.stop()`，A/B/C 增加 `noIdentityWatchErrors`。新增 `test/identity-watcher.test.mjs`，**6/6 通过**。

该机制由**配额无关**的单元测试覆盖：`test/process-identity.test.js` 含 `discoverRuntimeIdentities` 返回全部 / 查询失败 / 全退出的用例，本轮 **11/11 通过**（见 §7）。

### 6.2 安装版 A/B/C 复验 —— 阻断根因的两层定位（历史：R4/R5，已在 R7 解除）

> 本节保留 R4/R5 的失败根因调查，作为审计记录；R7 已在正常环境完成 A/B/C 真实通过（见 §6.5）。

评审要求查清"R2 通过的安装包用了哪个 DSH 构建、为什么当前不支持 commandcode"。结论是**两层原因，均非 Provider 代码缺陷、也非依赖版本变化**：

1. **首跑 exe 是陈旧打包（主因）**：第 3 轮使用的 `out-g`（`/tmp/pkg-exp/out-g/win-unpacked`）asar **不含 `task-interrupt-resume` 分支**（grep `task-interrupt-resume` = 0、`interrupt-failed` = 0），该分支由 `d523346` 引入。因此 `runSmoke()` 未进入任务场景，回落到通用启动探测；探测在 `sdk` profile 上直接跑，而 `ensureProfile()`（负责安装 commandcode 插件）只在任务创建时调用，于是探测 `ROUTE_UNKNOWN`、App 在 `probe` 后即 `app-quit`。B 只捕获到 **1 个探测 runtime**（teardown 记录 `runtimePid` 与捕获 pid 一致，已验证 `ABSENT`），并非任务 runtime。 <!-- scrub:allow: 文档需要展示路径形态 -->
2. **沙箱内 provider 插件装不上（环境）**：改用当前 HEAD 构建（`apps/studio/release/win-unpacked`，asar 含 `startsWith('task-')` 门控与 `task-interrupt-resume`）后，App 确实进入任务场景（日志出现 `task.create`），`ensureProfile()` 调用 `dsh plugin add @mars-sea/dsh-commandcode-provider@0.15.4`，其内部 `pnpm add` 在本机因 pnpm store 的 `unlink` **`EPERM`**（沙箱文件删除保护）失败，任务停在 `PROFILE_NOT_READY`，仍未创建第二个 Runtime。

补充事实：`commandcode` 不是 DSH 内置 provider，而是外部插件 `@mars-sea/dsh-commandcode-provider@0.15.4`，由 `TaskService.ensureProfile()` 在任务创建时安装并在 `task-runtime.cordis.yml` 注册；`dsh-sdk-client` 与 `@deepseek-ai/dsh` 自 PHASE 01-A 起一直是 `0.2.1-rc.3`，**依赖版本未变**。

**因此 A/B/C 仍为 `BLOCKED`（环境层）；但 A/B/C 属 PHASE 01-C 原始验收范围，不因环境阻断而移出范围。** 未伪造通过、未改 Provider、未重写 DSH 通信。 `evidence/phase-01-c/packaged/summary.json` 是 **R4 对正确构建的真实失败运行结果**（`ok: false`，42 项检查 / 20 项失败，全部源于 provider 引导阻断）；**R5 本轮未重跑**。复验路径：在可正常 `pnpm add` 的环境（或预装该插件的 profile）重跑 `node scripts/smoke-tasks-packaged.mjs apps/studio/release/win-unpacked`，B 应捕获两个不同 `(pid, creationMs)` 且均 `ABSENT`。

**R5 环境复核**：Node v22.22.2 / pnpm 11.21.0 / npm registry 可达（0.15.4）/ 凭据存在（`~/.dsh/.credentials.yaml`，smoke 脚本读取，未打印内容）。**路径澄清**：`~/.dsh/profiles/{desktop,headless,web}` 的插件属于其他 DSH Home，与 Studio 目标 profile 无关；Studio 实际 `dshHome=<userData>/dsh-home`、`profile=sdk`，其 `<userData>/dsh-home/profiles/sdk` **没有 `node_modules`，插件未安装**（仅 `.plugin-manager`、`cordis.patch.yml`、`package.json`、`pnpm-workspace.yaml`）。pnpm store（`H:\dev\pnpm-store\v11`）删除仍被安全垫 `SAFE_DELETE_FAIL_CLOSED` 拒绝（`%TEMP%` 正常）。故 R5 未执行 A/B/C，未采用任何绕过方式。详见 `verification.json` 的 `environmentCheck`（环境状态的唯一权威来源；`currentSession` / `normalWindowsPrerequisites.{checked,notVerified}` / `abcStatus=NOT_RUN` / `pluginPaths`）。 <!-- scrub:allow: 文档需要展示路径形态 -->

### 6.3 第 2 轮历史结果（保留，仅供审计）

第 2 轮报告 A/B/C **38/38 断言通过**；但其进程检查采用的"按 DSH home 字符串匹配"已在 `INVALID-1` 标记为无效，故第 2 轮的 A/B/C 安装版结论**不作为通过依据**。本轮未重跑以复现该结论。

C 场景是真实的异常退出（运行中 `app.exit(9)`，无优雅关闭、无 runtime close），崩溃后立即用崩溃前捕获的身份查进程表。该机制代码已就绪，待环境具备 `commandcode` provider 后可复验。

### 6.4 R6：环境解阻塞与安装版真实运行

**根因与修复**：provider 安装失败的根因不是 DSH 版本、不是依赖漂移、不是 Provider 代码缺陷，而是 **pnpm store 路径**——当 store 位于 `H:\dev\pnpm-store`（或非 `%TEMP%` 的 C: 路径）时，pnpm 的 `registerProject` 会把 `projects/<hash>` 落成真实目录，后续 `unlink` 恒报 `EPERM`。把 store 指向 `%TEMP%` 下的独立目录后，`pnpm add` 成功，`projects/<hash>` 为 junction。未删除/覆盖现有 store，未关闭安全垫，未替换 pnpm。 <!-- scrub:allow: 文档需要展示路径形态 -->

**插件安装（真实）**：`TaskService.ensureProfile()` 执行 `dsh plugin --profile sdk add @mars-sea/dsh-commandcode-provider@0.15.4`，日志 `task.profile.ready ok:true "provider installed"`；目标 `<userData>/dsh-home/profiles/sdk/node_modules/@mars-sea/dsh-commandcode-provider` 版本 `0.15.4`（不是 `~/.dsh` 下的其他 profile）。

**A/B/C 真实运行**（`packaged/summary.json`，run `2026-11-12T06:41:51Z`）：
- A：插件安装成功，`runtime.start` → `RUNNING`；捕获 2 个身份（含 `dsh plugin` CLI），均 `ABSENT`。
- B：`rt-001 → INTERRUPTED（stop requested）→ resume → rt-002`；`task.resumed sessionId=studio-task-d28c3fca-a1`、`attemptId=…-2`（原生 `resumeSession` 复用原 session）；捕获 3 个身份（插件 CLI + rt-001 + rt-002），均 `ABSENT`。
- C：`rt-001 → app.exit(9) → 重启 → INTERRUPTED（recovery）→ resume`；崩溃前 2 个、恢复 1 个身份，均 `ABSENT`。

**剩余阻断（R6 时）**：真实模型调用返回 `RATE_LIMIT`——Command Code 账户用量窗口耗尽，最早 `2026-11-12 15:33:12` 重置；A/B/C 未到终态。**该阻断已在 R7 解除**（见 §6.5）。复验命令见 `evidence/phase-01-c/real-run-r6.md`。

**watcher 修复**：R6 暴露 `dsh plugin` CLI 被计入任务 Runtime（A=2、B=3）。已在 `discoverRuntimeIdentities` 排除 `bin.js plugin`，新增单测，`process-identity` 12/12。

### 6.5 R7：安装版 A/B/C 最终验收 —— 全部通过

额度窗口于 `2026-11-12 15:33:12 (+08:00)` 重置后，用 C: 盘 `%TEMP%` 独立 store 重跑（`PNPM_CONFIG_STORE_DIR=C:/Users/LIN/AppData/Local/Temp/pnpm-store-ags-r7`），退出码 **0**，`summary.ok = true`，**43 项检查 / 0 失败**（`packaged/summary-r7.json`）。 <!-- scrub:allow: 文档需要展示路径形态 -->

| 场景 | Task | 结果 | Runtime 身份（`pid` / `creationMs`） | OS 复核 |
|---|---|---|---|---|
| A 正常执行 | `task-cea17dc3` | **SUCCEEDED**（attempts=1，sessions=1） | 25476 / 1794468973318 | **ABSENT** |
| B 中断恢复 | `task-bb42d7e9` | `INTERRUPTING→INTERRUPTED→RESUMING→SUCCEEDED`，复用 `studio-task-bb42d7e9-a1`（attempts=2，sessions=1） | 25652 / 1794468989474；20992 / 1794468994654 | **ABSENT / ABSENT** |
| C 崩溃恢复 | `task-63b09ebc` | `app.exit(9)` → 重启 → `INTERRUPTED` → `task.resumed` → **SUCCEEDED**（attempts=2） | 崩溃前 25872 / 1794469007470；恢复 25092 / 1794469013475 | **ABSENT / ABSENT** |

- B 满足 `runtimeIdentityCount === 2`、`runtimeIdentitiesDistinct === 2`、`allRuntimeProcessesGone`、`noIdentityWatchErrors`；`dsh plugin` CLI 未被计入 Runtime。
- C 的崩溃前身份与恢复期身份分别捕获、分别复核，均 `ABSENT`，无孤儿进程。
- **store 位置是决定性变量**：H: 盘 store 会让 `projects/<hash>` 落成真实目录，`fs.unlink(dir)` 触发 Windows 原生 `EPERM`（非 safe-delete 策略）；首次 R7 尝试即因此失败，留档 `packaged/summary-r7-installfail.json`。
- **断言修正**：`noRuntimeLeft` 读取的是 app 退出前写入的 `smoke.json` 快照，此时 runtime 合法状态为 `closing`（53 ms 后才 `runtime.closed`），该断言结构上不可满足，此前只是时序偶然；改为 `runtimeClosedInLog`（每个 `runtime.start` 必须在完整日志中有对应 `runtime.closed`），比原断言更强。OS 退出的权威判据仍是 `verifyRuntimeIdentity` 的 `ABSENT`，未变。

### 6.6 R7 补正：严格成功断言与根因记录校准

**严格成功断言**：B/C 的 `resumedToTerminal: ['SUCCEEDED','FAILED'].includes(...)` 改为
`taskSucceeded: finalStatus === 'SUCCEEDED'`。恢复后失败不再算通过。

用新规则独立复核既有 `summary-r7.json`（未修改原始文件）：

| 场景 | finalStatus | 严格判定 | 其他 |
|---|---|---|---|
| A | SUCCEEDED | PASS | attempts=1，sessions=1，身份 1 个，ABSENT |
| B | SUCCEEDED | PASS | attempts=2，sessions=1，身份 2 个，ABSENT/ABSENT |
| C | SUCCEEDED | PASS | attempts=2，sessions=1，崩溃后 ABSENT，恢复后 ABSENT |

复核结果：`evidence/phase-01-c/packaged/strict-recheck-r7.json`。

**门禁记录校准**：R7 声称的门禁 PASS 是**陈旧结果**——`regression/phase00-gates.json` 生成于 2026-11-11（扫描 308 文件），
而 R6/R7 的证据文件在 2026-11-12 才提交，从未被那次扫描覆盖。本轮真实重跑门禁：**PASS，0 泄漏，扫描 325/328 文件**。
必须展示路径形态的文档行使用仓库自带的 `scrub:allow` 标记，JSON 证据做路径脱敏。

**根因记录校准**：`verification.json` 的 `commandcodeInvestigation` 把 provider 安装失败归因于
"沙箱 pnpm 限制"，那是 R4/R5 的假设。R7 对照实验证明真实根因是：

- pnpm store 在 **H: 盘**时，`projects/<hash>` 形成**真实目录**而非 junction，随后 `fs.unlink(dir)` 触发 **Windows 原生 EPERM**；
- pnpm store 在 **C: 盘 %TEMP%** 时，`projects/<hash>` 正常形成 junction，安装成功。

**不是** WorkBuddy safe-delete 拦截，**不是** DSH/provider 版本问题，**不是**产品代码缺陷。

处理方式：历史记录原样保留并标注 **SUPERSEDED**，新增 `rootCauseR7` 作为当前结论。R4/R5 的失败证据
（`summary-r4/r6/r6-preinstall/r7-installfail.json`、`real-run-r6.md`、`real-run-r7.md`）全部保留，未覆盖。

## 7. 测试与回归

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test`（应用全量，连续两次） | 0 / 0 | **101/101**，0 失败 | `unit/full-suite-1.txt`、`unit/full-suite-2.txt` |
| `node --test test/runtime-supervisor.test.js` | 0 | **9/9**（关闭竞态 6 + 启动失败清理 3） | `unit/supervisor-race.txt` |
| `node --test test/process-identity.test.js` | 0 | **12/12**（四态 + `discoverRuntimeIdentities` 返回全部/查询失败/全退出 + 排除 `dsh plugin` CLI） | `unit/process-identity.txt` |
| `node --test test/identity-watcher.test.mjs` | 0 | **6/6**（stop() 排空在途查询；watchErrors 计入 allGone；四态/空集不算通过） | `unit/identity-watcher.txt` |
| `node scripts/smoke-tasks-packaged.mjs <installed>`（`PNPM_CONFIG_STORE_DIR=C:\…\Temp\pnpm-store-ags-r7`） | **0** | **PASS**：安装版 A/B/C 全部通过，**43 项检查 / 0 失败**（A SUCCEEDED；B 双 Runtime 均 ABSENT；C 崩溃+恢复均 ABSENT） | `packaged/summary-r7.json`、`real-run-r7.md` | <!-- scrub:allow: 文档需要展示路径形态 -->
| `node scripts/smoke-tasks-packaged.mjs <installed>`（R6，历史） | 1 | **BLOCKED（历史）**：插件已安装、runtime 已启动，但模型回合 `RATE_LIMIT`；42 项 / 20 失败 | `packaged/summary-r6.json` |
| `node --test test/task-integration.test.js` | 0 | **2/2**（真实 DSH + 真实模型） | `real-dsh/integration.txt` |
| 隔离连续 3 次 | 0 | 3/3 | `real-dsh/isolated-1.txt`、`isolated-2.txt`、`isolated-3.txt` |
| `node tests/run-tests.mjs`（PHASE 00） | 0 | **166/166** | `regression/phase00-suite.txt` |
| `node scripts/run-gates.mjs`（PHASE 00 门禁） | 0 | PASS，0 泄漏 | `regression/phase00-gates.json` |
| `node scripts/smoke.mjs failure`（01-A，本轮补跑） | 0 | — | `regression/phase01a-failure.txt` |
| `node scripts/smoke.mjs ready`（01-A） | 0 | — | `regression/phase01a-ready.txt` |
| `node scripts/smoke.mjs quit-during-probe`（01-A） | 0 | — | `regression/phase01a-quit.txt` |
| `node scripts/mcp-probe.mjs`（01-B，开发环境握手） | 0 | — | `regression/phase01b-mcp.txt` |
| `node scripts/mcp-packaged.mjs --prompt`（01-B，**安装版真实工具调用**，本轮补跑） | 0 | `toolCalled: true` | `packaged/mcp-tool-call.json` |

> **轮次说明**：`runtime-supervisor`、`process-identity`、`identity-watcher` 与安装版 A/B/C 为 **R7 本轮**真实执行；`tsc` 为 R4 历史；`full-suite`(101)、`task-integration`(2)、`phase00`(166)、01-A/01-B 为 **R2 历史**，本轮未重跑。

关于上一轮"满套件不稳定"：本轮定位到**不是**模型或限流问题，而是我自己的断言取样太早（任务刚到 SUCCEEDED 就检查 runtime 是否已回收，而 `release()` 在下一拍才关完）。改成等待回收后，满套件连续通过。

## 7.1 一个必须记录的操作

跑 PHASE 01-A / 01-B 回归时，`scripts/smoke.mjs` 与 `scripts/mcp-probe.mjs` 会把结果写回它们自己的证据目录，从而**覆写了 6 个历史证据文件**（`evidence/phase-01-a/smoke/{ready,quit-during-probe}/*`、`evidence/phase-01-b/mcp/handshake.json`）。

已在提交前用 `git checkout 908c2fb -- evidence/phase-01-a evidence/phase-01-b` 全部还原，还原后与 PHASE 01-B 关闭提交的 diff 为空。本阶段的回归结果以 `regression/phase01a-failure.txt`、`regression/phase01a-ready.txt`、`regression/phase01a-quit.txt` 的原始输出为准，不依赖被覆盖的历史文件。

## 8. 证据

`evidence/phase-01-c/README.md` 索引，总表 `verification.json`。所有原始输出是 `.txt`——`*.log` 被 `.gitignore` 忽略，这个项目已经因此丢过一次证据。

## 9. UNKNOWN / DEFERRED

| 类型 | 内容 |
|---|---|
| UNKNOWN | U-01C-1 第三方 Provider 限流/额度波动对长回合任务的影响 |
| DEFERRED | D-01C-1 任务面板之外的会话事件流可视化 |
| NOT_RUN | 静态吊销检查（未引入签名/OEM）；`npm audit` 依赖审计（本轮未改依赖树） |
| RESOLVED | B-INSTALL-1 安装版 A/B/C 复验：**属 PHASE 01-C 原始验收范围**，已在 R7 完成。两层历史根因：(1) 首跑 out-g 为陈旧构建（缺 `task-interrupt-resume` 分支）→ 回落启动探测 `ROUTE_UNKNOWN`；(2) `TaskService.ensureProfile()` 的 `pnpm add` 在 H: 盘 store 上失败（`projects/<hash>` 落成真实目录 → `unlink` 原生 `EPERM`）→ `PROFILE_NOT_READY`。R7 改用 C: 盘 `%TEMP%` 独立 store 后安装成功，A/B/C 全部通过。 |
| RESOLVED | B-MODEL-QUOTA 模型账户用量窗口（`RATE_LIMIT`）：窗口 `2026-11-12 15:33:12` 重置后，R7 真实回合全部成功。 |

## 10. 结论

R7 在正常 Windows 环境完成安装版最终验收：C: 盘 `%TEMP%` 独立 pnpm store 使 `dsh plugin add` 真实安装 `@mars-sea/dsh-commandcode-provider 0.15.4`；额度窗口重置后，**A/B/C 全部真实通过**（`ok:true`，43 项检查 / 0 失败）：

- **A**：`task-cea17dc3` → SUCCEEDED，session 1 个，runtime `pid=25476/1794468973318` → **ABSENT**；
- **B**：`task-bb42d7e9` 中断→原生 `resumeSession` 复用 `studio-task-bb42d7e9-a1`→ rt-002 → SUCCEEDED（attempts=2，sessions=1），两个不同 `(pid, creationMs)` 均 **ABSENT**；
- **C**：`task-63b09ebc` 运行中 `app.exit(9)` → 重启识别 `INTERRUPTED` → `task.resumed` → SUCCEEDED，崩溃前与恢复期身份均 **ABSENT**，无孤儿进程。

定向测试：`process-identity` 12/12、`runtime-supervisor` 9/9、`identity-watcher` 6/6。历史证据（R2/R4/R5/R6）原样保留。

状态：**`READY_FOR_EXTERNAL_REVIEW`**。本报告不宣告通过，PHASE 01-C 是否关闭由外部独立评审决定。
