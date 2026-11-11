# PHASE 00 工作报告（供外部评审）

权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

> **历史记录（0.1.5 运行时快照，2026-11-11 标注）**：本文件记录 PHASE 00 首轮在 **DSH 0.1.5** 上的实测与结论；`5/5`、`3 PASS / 4 BLOCKED`、退出码、阶段判定等均为当时状态，**保留原样只作追溯**，不代表当前事实。
> 当前生产目标是 DSH 0.2.1-rc.3 + commandcode；当前结论见 `docs/review-handoff/PHASE_00_R1_WORK_REPORT.md` 头部「PHASE 00 最终结论」与 `phase_00_final`。

> 这份报告是**独立可读**的：评审者不需要看仓库其他文件，也能判断本阶段做了什么、证据是否可信、结论是否成立。
> 需要深挖时，各节都指向具体文件路径。
>
> - 项目：AI Game Studio（AI 游戏研发顾问 + 自动化开发平台）
> - 阶段：**PHASE 00 — 技术可行性与 DSH 最小垂直切片**
> - 日期：2026-11-10
> - 仓库：`https://github.com/xiaoLin12130/ai_game_studio`
> - 分支：`phase/00-feasibility`
> - 审查基线提交：`5658479016fda62989a52baaf257c174cc897e02`
> - 阶段判定：**`PARTIALLY_VERIFIED`（不是 PASS）**

---

## 1. 一页结论

### 做成了什么

用官方 TypeScript SDK 在本机真实驱动 DeepSeek Harness（DSH）Runtime，打通了五条链路：

1. Studio 启动 DSH Runtime（子进程）
2. 建立会话并发送 Prompt
3. 收到结构化事件与 `running → idle` 状态变化
4. 关闭 Runtime 并**在操作系统层面确认进程消失**
5. 通过 MCP 把 Studio 的只读业务工具（`get_studio_health`）注册进模型的工具清单

### 没做成什么（一条外部原因）

**模型的真实回复没拿到**：DeepSeek 账号返回 `HTTP 402 Insufficient Balance`。

这不是集成问题——同一账号在 DSH 自带的 `headless` profile 上也是同样的 402：

```
$ dsh --profile headless "Reply with exactly one word: PONG"
dsh: QUOTA: Insufficient Balance (request_id: adb91a31-0e96-408e-b3fa-105f72fe0f9e)
```

因此凡是"必须由模型产出文本"的断言，一律标 `BLOCKED`，没有洗成 PASS。

### 一句话

**（0.1.5 时期）基础设施链路 5/5 打通；模型层被账号余额卡住；技术选型给出 ADR 但未获批准，故未进入 PHASE 01。**

> 当前（0.2.1-rc.3 + commandcode）真实模型链路六探针 6/6 PASS，见 `evidence/r14/summary.json`（`2026-11-10T12:43:44.987Z`，本轮未重跑）。

---

## 2. 执行环境（全部实测，非假设）

| 项 | 值 |
|---|---|
| OS | Windows 10.0.19045.6466（x64） |
| Node | v22.22.2 |
| npm / pnpm | 10.9.7 / 11.21.0 |
| Git | 2.55.0.windows.3 |
| GitHub CLI | **未安装**（因此未用 `gh` 建仓/推送） |
| DSH CLI（全局） | `@deepseek-ai/dsh` **0.1.5-rc.1** |
| DSH SDK | `@deepseek-ai/dsh-sdk-client` **0.1.5-rc.2**（自带同版本 Runtime `dsh@0.1.5-rc.2`） |
| DSH 协议服务身份 | `deepseek-harness-sdk-runtime` **0.0.1** |
| Cocos Creator | **3.8.6**（已安装，本阶段未调用） |
| 微信开发者工具 | **2.02.2608080**（已安装，本阶段未调用） |

两个值得注意的环境事实：

- npm 上 `@deepseek-ai/dsh` 的 `latest` 已是 **0.2.2-rc.1**，本机全局安装落后一个大版本。本阶段所有结论**只对 0.1.5 线成立**。
- DSH 的 `DSH_HOME` 未设置，默认 `<user-home>\.dsh`。本阶段所有实验都跑在**隔离的 `DSH_HOME`** 下，没有读写用户日常的 DSH 配置与会话。

---

## 3. 交付物

| 类型 | 路径 | 说明 |
|---|---|---|
| 验证代码 | `spike/dsh-probe/` | 7 个探针 + 1 个 Studio MCP server + 1 个诊断壳 |
| 最小应用壳 | `spike/dsh-probe/src/studio-diag.mjs` | CLI 诊断壳：环境/连接/会话/状态/错误/回收 |
| 只读业务工具 | `spike/dsh-probe/mcp/studio-mcp-server.mjs` | 只暴露 `get_studio_health`，无写能力 |
| 阶段报告 | `docs/phase-reports/PHASE_00_REPORT.md` | 门禁逐条核对 |
| 环境与链路证据 | `docs/phase-reports/PHASE_00_EVIDENCE.md` | 每条结论对应的原始输出 |
| 技术选型 ADR | `docs/decisions/ADR-0001-tech-stack.md` | Electron vs Tauri |
| 集成 ADR | `docs/decisions/ADR-0002-dsh-integration.md` | 生命周期/事件/工具/恢复/版本 |
| 复审交接 | `docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md` | 评审入口 |
| 状态文件 | `state/project_state.json`、`state/memory.json`、`memory-bank/handoff.md` | 供下一会话接手 |

---

## 4. 验证结果（0.1.5 legacy 套件）

一条命令复现（0.1.5）：`cd spike/dsh-probe && node run-all.mjs`

退出码语义：`0` 全 PASS；`2` 存在 BLOCKED；`1` 存在 FAIL。**当前为 2。**

| 探针 | 验证内容 | 结果 | 关键数据 |
|---|---|---|---|
| **A** | 启动 → 会话 → Prompt → 事件 → 关闭 | BLOCKED | 握手 2,274 ms（热）；单轮 15 事件 / 17 通知；`running→idle`；`close()` 67 ms；进程确已消失；**模型空回复（402）** |
| **B** | 协议能力边界 | **PASS** | `serverInfo=deepseek-harness-sdk-runtime 0.0.1`；`session/cancel`、`session/resume`、`session/close` 全部 `unknown method` |
| **C** | 会话持久化与恢复 | **PASS** | 会话日志落盘 18,059 B；复用 sessionId 被拒 → `NO_RESUME_AT_SDK_LEVEL` |
| **D** | 停止等待 ≠ 停止进程 | BLOCKED | 放弃等待 4,005 ms 后进程仍存活、事件仍在到达；但放弃时状态已是 `idle`，"仍在工作"未成立 |
| **E** | MCP 工具桥接 | BLOCKED | MCP 握手成功（`dsh-mcp-client@0.0.1`，协议 `2025-11-25`）；工具有效进入模型工具清单（26 个之一）；**模型未发起调用（402）** |
| **F** | 并发会话隔离 | BLOCKED | 两 session 并行 709 ms，通知按 sessionId 零串台；文本断言未验证（402） |
| **G** | 退出码与陈旧锁 | **PASS** | 正常关闭 **exit 0**（2,582 ms）；陈旧锁导致启动 **exit 1**（2,721 ms） |

**3 PASS / 4 BLOCKED / 0 FAIL。**

---

## 5. 六个关键技术结论（每条都有实测支撑）

### 5.1 0.1.5 的能力边界（0.2.1-rc.3 已修订，见本节末）

0.1.5 上这几项不是"没测"，是**协议里根本没有**（原始记录保留如下）：

| 能力 | 实测结果 |
|---|---|
| 运行中取消 | `session/cancel` → `unknown DeepSeek Harness SDK runtime method: session/cancel` |
| 会话恢复 | `session/resume` → 同上；且复用已存在 sessionId 直接报 `session "..." already exists` |
| 会话关闭 | `session/close` → 同上 |
| 工具审批回调 | 协议无任何 server→client 请求；当时转述官方说明称该能力"是死能力，服务器从不发送"（0.1.5 观测；现行口径 `UNKNOWN / NOT_OBSERVED`，"未观察到"≠"不存在"） |

**架构含义（0.1.5 当时）**：Studio 必须自己承接取消语义——
- 停止 = 关闭 Runtime 进程树，UI 必须区分「停止查看」与「停止运行」（0.2.1 仍无运行时级取消，这一点不变）
- 恢复 = Studio 自己的任务状态 + 「上下文再水化包」注入新会话（0.1.5 无 resume 时的做法；0.2.1-rc.3 改为**优先官方 `session/resume`，失败再水化**，见 ADR-0002 D4）

**当前（DSH 0.2.1-rc.3）五类能力必须分开记录**：

- 正常关闭后 Session Resume = **CONFIRMED**（CC-3：新进程 resume 后答出随机口令）
- 中断中的最后一轮恢复 = **UNKNOWN**（U7，`DEFERRED` 到 PHASE 01）
- DSH 原生审批回调 = **UNKNOWN / NOT_OBSERVED**
- `session/approve` = **NOT_SUPPORTED**（`-32603 unknown ... method`）
- Runtime 级取消 `session/cancel` = **NOT_SUPPORTED**（同上）

### 5.2 工具桥接唯一通路是 MCP

SDK 协议**没有任何工具注册方法**。官方通路是 `@deepseek-ai/dsh-mcp-client`，工具名形如 `mcp__<serverName>__<tool>`。

实测证据（Studio MCP server 的审计日志）：

```json
{"kind":"initialize","clientProtocolVersion":"2025-11-25","clientInfo":{"name":"dsh-mcp-client","version":"0.0.1"}}
{"kind":"notification","method":"notifications/initialized"}
{"kind":"tools/list","count":1}
```

且 `mcp__studio__get_studio_health` 确实出现在发给模型的 26 个工具清单里。

一个硬性格式要求：`--patch` 文件**必须用 `insert:` 包裹**新条目，否则 `patch: entry "studio-mcp" not found`（官方 README 的裸行示例是配置树条目，不是 patch 文件）。

### 5.3 启动耗时双峰：2.5 秒 或 2 分钟

| 场景 | 实测 |
|---|---|
| 热启动 | 2,252–2,582 ms |
| 需要重建 `$DSH_HOME/profiles/node_modules` 模块回退 | **73,129 / 116,466 / 118,998 / 128,688 ms** |

该目录本机实测 **187 个条目，其中 164 个符号链接**——Windows 上重建这套链接是分钟级工作。

而 SDK 默认 `initializeTimeoutMs = 10,000 ms`。**用默认值首次启动必然报「初始化超时」**，而这会被误读成集成失败。

### 5.4 崩溃遗留的锁会让下次启动失败，且错误信息误导

`dsh-atomic-write` 用 `wx` 创建 `profiles/node_modules.lock`，**不校验持有者 pid 是否存活**，只在 2,000 ms 内重试后抛错。而 SDK 对外只折叠成一句：

```
dsh profile "sdk": JSON-RPC input closed
```

真实原因（探针 G 复现）：

```
Error: atomic-write: timed out waiting for the writer lock at ...\profiles\node_modules.lock
```

**架构含义**：Studio 必须在启动前检查锁、清理死 pid 残留，并把 stderr 摘要透出到 UI——否则用户只会看到"打不开"。

> 诚实备注：探针 G 的第一版实现漏了「锁只在 profile 需要 heal 时才会被触碰」，因此错误地得出"伪造死锁不阻塞启动"的结论。现版本改用全新 `DSH_HOME` 强制走 heal 路径后才成立，这个修正过程写在了证据文件里。

### 5.5 依赖图在 caret 范围内不可解

`@deepseek-ai/dsh-app-boot` 用**精确 peer** 要求 `cordis@4.0.2`，而 `cordis-plugin-*` 的 caret 范围会解析到要求 `cordis ~4.1.0` 的新版本 → `npm install` 直接 `ERESOLVE`。

用 `--legacy-peer-deps` 能装，但装出来的树**缺 `@deepseek-ai/cordis-plugin-group`**，运行即 `ERR_MODULE_NOT_FOUND`。

解法：把 6 个 cordis 相关包按全局可用安装的实际版本精确钉死，并提交 lockfile。

### 5.6 文档与实现不一致

官方协议 README 称未注册方法返回 `-32601`，实测返回 **`-32603`**（`unknown ... method`）。

**含义**：判断"某能力是否存在"必须看错误消息文本，不能看错误码。

---

## 6. 阶段门禁逐条核对

| # | 门禁 | 结果 | 依据 |
|---|---|---|---|
| 1 | 环境清单真实且带版本/命令输出 | PASS | 报告 §2 |
| 2 | 官方 SDK 与实际 DSH 版本兼容性有证据 | PASS | §2、§5.5；含版本漂移记录 |
| 3 | 至少一条真实 Prompt 成功并收到可追踪结果 | **BLOCKED** | Prompt 入队成功、产生 15 条可追踪事件，但模型 402 |
| 4 | 事件/状态能记录并在 UI 或 CLI 展示 | PASS | 诊断壳实时输出 `RUNNING/IDLE`、事件数、错误原因 |
| 5 | Studio 只读工具被 DSH 调用成功 | **BLOCKED** | 注册链路 PASS；模型未运行，无 `tools/call` |
| 6 | Runtime 关闭后进程确实退出，记录退出码 | PASS（0.1.5 启动器级；0.2.1 见下方注） | 进程表复核；exit 0（正常）/ 1（启动失败） |
| 7 | Session 恢复/审批能力已验证或明确标记不支持 | PASS（0.1.5） | 0.1.5 上 resume/审批均 `NOT_SUPPORTED`，有 `unknown method` 证据；0.2.1 起：正常关闭 Resume=**CONFIRMED**、审批=`UNKNOWN / NOT_OBSERVED`、`session/approve`=`NOT_SUPPORTED` |

> **门禁 6 注（0.2.1-rc.3，2026-11-11）**：按原始措辞「Runtime 关闭后进程确实退出，记录退出码」判定，已满足。
> `evidence/cc-6-exitcode/summary.json`（`npm run probe:exit`）：正常 close → `exitCode = 0`；外部 `taskkill /F` 强杀 → `exitCode = 1`；两次均 `PROCESS_ABSENT`；`modelCallsMade = 0`。
> 取得通道是 SDK 公开导出的 `TransportClosedError` message 中的 `exit code: <n>`（`lib/types/client.d.ts` 已文档化）；0.2.1-rc.3 **没有**结构化访问器（`HarnessClient#exitCode` 私有、`close()` 返回 `Promise<void>`、`HarnessClientOptions` 无 onExit 钩子），解析失败返回 `null`，不猜。见 `src/lib/exitcode.mjs`、`src/probe-runtime-exit.mjs`。
| 8 | 技术选型 ADR 写明取舍和风险 | PASS | ADR-0001 / ADR-0002 |
| 9 | 无密钥进入日志或 Git | PASS | 见 §11 |
| 10 | GitHub 推送与复审交接完成 | **PASS**（2026-11-10 18:13 达成） | 已推送 `phase/00-feasibility`，远端 SHA 与本地一致，见 §14 |

**综合：`PARTIALLY_VERIFIED`。** 10 条门禁中 8 条 PASS、2 条 BLOCKED（均因模型账号余额）。按阶段文件约定，**不得标 PASS，不得进入 PHASE 01**。

---

## 7. 阻塞项（1 项未解除 + 1 项已解除 + 1 项待决策）

| 编号 | 阻塞 | 影响 | 状态 / 解除方式 |
|---|---|---|---|
| **B-001** | DeepSeek 账号余额不足（HTTP 402 / QUOTA） | 门禁 3、5 无法转 PASS；A/D/E/F 停在 BLOCKED | **未解除**。充值，或提供有余额的 `DEEPSEEK_API_KEY` |
| ~~B-002~~ | ~~到 github.com 的网络出口不通~~ | 无法 `git push` | **已解除**。两个叠加原因：① git 未走本机代理 `127.0.0.1:7890`；② 本机保存的 GitHub 凭据属于 `vJackLin2v`，而仓库属主是 `xiaoLin12130`。已在**仓库级**指定代理与账号（不改全局配置），推送成功 |
| **B-003** | 仓库当前是 **public**，而项目规范 `docs/10` 建议使用私有仓库 | 阶段材料（含本机绝对路径）公开可读 | **待用户决策**。若转 private，外部评审需另行提供 ZIP 或访问授权 |

关于 B-003 的说明：本阶段材料经过密钥扫描（无 token/private key/凭据文件），但证据文件里包含本机绝对路径（如 `<abs-path> 不擅自更改仓库可见性。**

---

## 8. 两个技术决策（待评审）

### ADR-0001：桌面容器与数据方案 → 推荐 **Electron + React + TypeScript**

评估了 2 个候选：

| 维度 | A：Electron（主进程内承载 SDK） | B：Tauri + Node sidecar |
|---|---|---|
| 与 DSH 的一致性 | **高**：DSH Runtime 与官方 SDK 都是 Node，主进程直接可用 | 需额外养一个 Node 进程 + 自定 IPC |
| 生命周期与回收 | 单一进程树，所有权清晰 | 双运行时，"外壳活着但 sidecar 死了"等组合状态要处理 |
| 写锁/构建独占 | 进程内锁，可靠 | 跨 Rust/Node，需跨进程锁 |
| 体积 | 大（~120–180 MB） | 小 |
| 打包/升级风险 | 成熟 | sidecar 签名与分发链更长 |

**推荐 A 的核心理由**：本产品的复杂度重心在 Runtime 生命周期与写锁（DSH 无运行时级取消——0.2.1-rc.3 仍 `NOT_SUPPORTED`，停止只能关进程），而不是安装体积。B 把复杂度加在最脆弱的地方。

> 注（2026-11-11）：「无恢复」已不成立——0.2.1-rc.3 正常关闭后 `session/resume` = **CONFIRMED**（CC-3）；中断轮次仍是 `UNKNOWN`（U7）。上面的推荐理由只需「无运行时级取消」即可成立。

**同时明确**：数据库选型（SQLite 的 ABI 或 `node:sqlite`）**推迟到 PHASE 01**，本阶段没有业务数据，提前锁定只会制造返工。

### ADR-0002：DSH 集成方式

六条决策：只用官方 SDK 不自建传输层；`RuntimeSupervisor` 独占 Runtime 且以"进程真实退出"为唯一判据；取消语义三态化；会话连续性由 Studio 负责（上下文再水化）；工具桥接分层且审批双通道分离；版本钉死 + 探针即回归用例。

---

## 9. 明确没有做的事

- **没有进入 PHASE 01**。没有创建项目工作台、素材库、任务调度、业务 UI。
- **没有用 Mock 冒充真实调用**。所有数据来自真实进程与真实 API 响应。
- **没有为了变绿改断言**。BLOCKED 就是 BLOCKED（探针 G 曾因结论错误被自我推翻重写，过程留在证据里）。
- **没有提交任何密钥**、`DSH_HOME` 实体、用户凭据或会话二进制。
- **没有覆盖仓库已有内容**：远端 `main` 只有 GitHub 自动生成的 `LICENSE`，推送为纯追加分支。

---

## 10. 仍未验证（不得当作已通过）

1. 模型真实回复（B-001 解除后应可验证）
2. 模型主动调用 Studio 工具（注册已 PASS，调用未验证）
3. 长 turn 下"Agent 仍在工作"
4. Electron 打包后 `dsh` 子进程能否启动
5. 安装期预热 profile 能否把首启动从 2 分钟降到秒级
6. `sdk-minimal` profile 是否更小攻击面（能否挂 MCP）
7. Python SDK 路线
8. Cocos Creator / 微信开发者工具的实际调用（属 PHASE 06）
9. 三个"无取消/无恢复/无审批"结论在 **0.2.x** 上是否仍成立（本阶段未升级验证）
   → 已由 R1 在 0.2.1-rc.3 上回答：**resume = CONFIRMED（正常关闭）**、cancel = `NOT_SUPPORTED`（仍成立）、审批 = `UNKNOWN / NOT_OBSERVED`。

---

## 11. 安全与合规自查

| 检查 | 结果 |
|---|---|
| 仓库内真实密钥 | 无（正则扫描 `sk-*` / `ghp_*` / `AKIA*` / `PRIVATE KEY` 均无命中） |
| 是否复制用户 `~/.dsh` | 否，全程隔离 `DSH_HOME` |
| 是否读取凭据内容 | 仅读过键路径与长度以判断"环境变量密钥是否同一把"，未输出任何值 |
| `node_modules`（291 MB）/ 会话二进制 | 未入库，已 gitignore |
| 入库存量 | 86 个文件，约 935 KB |

---

## 12. 给评审者的 8 个具体问题

1. `PARTIALLY_VERIFIED` 这个判定是否恰当？还是应该更严格地标 `BLOCKED`（完全不通过）？
2. ADR-0001 选 Electron 的理由（不引入第二套 Node 运行时）是否成立？有没有被我低估的 Tauri 优势？
3. 把数据库选型推迟到 PHASE 01 是否可接受？
4. ADR-0002 用「上下文再水化」替代 DSH 会话恢复，是否足以支撑崩溃恢复？代价（每次重启消耗一次较大 prompt）是否可接受？
5. 「无取消 → 停止就关进程」这个语义，对用户体验是否可接受？是否需要考虑"每次任务一个独立 Runtime"的隔离粒度？
6. 工具桥接目前只读。进入写操作前，Studio 侧审批门禁的最小设计应该包含什么？
7. 探针 D 判定 BLOCKED 是否过于保守？（它证明了"进程不会因为你不再等待而消失"，但没证明"Agent 仍在产出"）
8. 仓库改为 private 是否必要？还是 public 可作为对外展示？

---

## 13. 复现方式

```bash
# 前置：Node ≥ 22，环境变量 DEEPSEEK_API_KEY 可用
cd spike/dsh-probe
npm install            # 依赖已精确钉版本；直接装 latest 会 ERESOLVE
node run-all.mjs       # 7 个探针；退出码 0/2/1
node src/studio-diag.mjs "Say hi"   # 最小诊断壳
```

首次运行可能需要 1–2 分钟重建 profile 模块回退，不是卡死。

---

## 14. 提交与推送状态

```
远端仓库：https://github.com/xiaoLin12130/ai_game_studio  （public）
分支：    phase/00-feasibility
审查基线提交：5658479016fda62989a52baaf257c174cc897e02
远端状态：已推送（远端该分支 SHA 与本行一致）
```

提交序列：

| SHA | 内容 |
|---|---|
| `91a44d8` | PHASE 00 实施：探针、MCP server、证据、ADR、报告 |
| `ad94dae` | 文档：回填阶段提交 SHA |
| `b3fdfb7` | 诊断壳 `studio-diag.mjs` |
| `5658479` | **本工作报告 + 远端状态记录（审查基线）** |

> 本文件自身在基线之后还有一次回填提交（补充推送信息），因此分支 HEAD 会略新于 `5658479`。审查时以 `git rev-parse HEAD` 为准；两者差异仅为本文件第 14 节与状态文件。

拉取与复现：

```bash
git clone -b phase/00-feasibility https://github.com/xiaoLin12130/ai_game_studio.git
cd ai_game_studio/spike/dsh-probe
npm install && node run-all.mjs
```

> 仓库为 public，评审方可直接以只读方式 clone；若改为 private，需另行提供 ZIP 或访问授权。

---

## 15. 结论

本阶段验证了**最高风险项**（能否用官方 SDK 真实驱动 DSH），并给出了可直接实施的集成方案与两个 ADR。

**唯一没验证的是模型层，原因是账号余额，不是代码。** 这恰好也证明了一件事：错误处理路径是必要的——诊断壳在模型被拒时明确打印 `ERROR (MODEL_QUOTA QUOTA/402)`，而不是显示一个空回复。

**等待评审结论；未获明确通过前不会进入 PHASE 01。**
