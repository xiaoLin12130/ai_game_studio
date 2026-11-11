# PHASE 00｜技术可行性与 DSH 最小垂直切片 — 阶段报告

权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

> **PHASE 00 已于 2026-11-11 关闭：`APPROVED`（PASS）**。本文件正文仍是 0.1.5 时代的历史报告，其中 `PARTIALLY_VERIFIED` / `BLOCKED` 为当时结论。最终判定、门禁证据与 PHASE 01 移交条件见 `docs/review-handoff/PHASE_00_CLOSURE_REPORT.md`。

> ## ⚠️ 本报告已被 PHASE 00-R1 部分取代（2026-11-10）
>
> 本文件保留为 **0.1.5 运行时的历史记录**，不再作为当前事实来源。三处结论已修正：
>
> 1. **「模型被账号余额阻断」是错的。** 真实原因是探针用了 `deepseek-official` 而非用户实际使用的 `commandcode`，且运行时静默回退到 DeepSeek 才出现 402。改用 commandcode 后，CLI 与 SDK 的真实对话均 PASS。
> 2. **「DSH 无 session resume」只对 0.1.5 成立。** 用户实际运行的 0.2.1-rc.3 有 `session/resume`，实测可恢复历史。
> 3. **门禁 10（GitHub 推送）已 PASS**，本文件表格中的 BLOCKED 为当时状态。
>
> **当前权威事实只有一处**：`state/project_state.json` → `phase_00_final`（由
> `authoritative_source.current_record` 显式声明）。本文件与 `phase_00.gate_results`、
> `phase_00_r1.gate_results` 均为历史快照，**保留但不作为当前状态**——这两个旧对象里
> 仍留有 `BLOCKED` / `PARTIALLY_VERIFIED` 的当时结论，不可引用。
> 完整整改报告见 **`docs/review-handoff/PHASE_00_R1_WORK_REPORT.md`**。
>
> 下表为 0.1.5 当时的状态，仅供追溯，**不要引用为当前结论**。

- 阶段：PHASE 00
- 状态：**PARTIALLY_VERIFIED / BLOCKED**（见 §5 门禁表；核心链路已验证，模型层被账号余额阻断）
- 日期：2026-11-10
- 执行者：AI Game Studio 主开发 Agent
- 证据：`docs/phase-reports/PHASE_00_EVIDENCE.md`、`spike/dsh-probe/evidence/`
- 决策：`docs/decisions/ADR-0001-tech-stack.md`、`docs/decisions/ADR-0002-dsh-integration.md`

---

## 1. 本阶段做了什么

在**真实本机环境**上，用官方 SDK 打通「Studio → DSH Runtime → 会话 → 事件 → 受控工具 → 关闭」的最小链路，并把每一次尝试都落成可复跑的探针与机器可读证据。

交付的代码只有一个目的：证明链路成立。**没有**实现任何未批准的业务功能（无项目管理、无素材库、无游戏流水线）。

### 1.1 交付物清单

| 类型 | 路径 | 说明 |
|---|---|---|
| 可运行验证代码 | `spike/dsh-probe/` | 7 个探针 + 1 个 Studio MCP tool server，`node run-all.mjs` 一键复跑 |
| 最小应用壳（诊断） | `spike/dsh-probe/src/studio-diag.mjs` | CLI 诊断壳：环境版本、连接、会话、`RUNNING/IDLE`、结果/错误、关闭回收。因技术栈未批准，故意不做窗口 |
| Studio 只读工具 | `spike/dsh-probe/mcp/studio-mcp-server.mjs` | 仅暴露 `get_studio_health`，只读、无写能力 |
| 证据原始数据 | `spike/dsh-probe/evidence/` | 每次运行的 JSONL / JSON，含事件流、审计日志、控制台输出 |
| 阶段报告 | `docs/phase-reports/PHASE_00_REPORT.md` | 本文件 |
| 环境与链路证据 | `docs/phase-reports/PHASE_00_EVIDENCE.md` | 环境清单 + 逐项测量 |
| 技术选型 ADR | `docs/decisions/ADR-0001-tech-stack.md` | Electron vs Tauri，含未验证风险 |
| 集成 ADR | `docs/decisions/ADR-0002-dsh-integration.md` | 生命周期 / 事件 / 工具 / 恢复 / 版本钉死 |
| 状态更新 | `state/project_state.json`、`state/memory.json` | 见 §7 |
| 交接 | `memory-bank/handoff.md`、`docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md` | 供外部复审 |
| 启动说明 | `README.md`（已更新）、`spike/dsh-probe/README.md` | 真实命令，可复现 |

## 2. 结论一句话

**DSH 的启动、会话、事件、关闭、工具桥接这五条链路全部真实跑通了；唯一没跑通的是「模型产出内容」，原因是 DeepSeek 账号余额不足（HTTP 402），与集成代码无关。**

## 3. 已验证的事实（带数据）

| 能力 | 结论 | 关键数据 |
|---|---|---|
| 官方 SDK 可用 | 是 | `@deepseek-ai/dsh-sdk-client@0.1.5-rc.2`，自带同版本 `dsh@0.1.5-rc.2` |
| 启动 Runtime | 是 | 热启动 2,252–2,582 ms；观察到真实 `dsh --profile sdk` 子进程 |
| 握手 | 是 | `serverInfo = {deepseek-harness-sdk-runtime, 0.0.1}` |
| 发送 Prompt | 是 | 返回 `messageId`，事件流出现 `agent/inbox/spliced` |
| 事件 / 状态 | 是 | 单轮 15 条事件、17 条通知；`session.event` + `session.status`；状态序列 `running → idle` |
| 关闭并回收 | 是 | `closeMs` 53–67 ms；关闭后 OS 进程表中子进程消失；`dsh --profile sdk` 在 stdin EOF 后 **exit code 0** |
| 工具桥接（注册） | 是 | Studio MCP server 完成 `initialize`(MCP `2025-11-25`) 与 `tools/list`；`mcp__studio__get_studio_health` 出现在模型工具清单（共 26 个工具） |
| 会话持久化 | 是 | `sessions/<workspace>/<sessionId>/session.v3.jsonl.zstd`，压缩 18,059 B |
| 并发会话隔离 | 是 | 单 Runtime 内两 session 并行，通知按 sessionId 不串台 |
| 运行中取消 | **不存在** | `session/cancel` → `unknown ... method` |
| 会话恢复（0.1.5） | **不存在** | `session/resume` 不存在；复用 sessionId 报 `already exists`。**0.2.1-rc.3**：正常关闭后 **CONFIRMED**（CC-3），中断轮次 `UNKNOWN`（U7） |
| 工具审批回调 | **未观察到**（`UNKNOWN`） | 0.1.5 无 server→client 请求；0.2.1 补测同样未见，但"未见"不等于"不存在" |

## 4. 关键技术发现（会直接改变实现方式）

### 4.1 启动耗时极不稳定：2.5 秒 或 2 分钟

`dsh` 每次启动会检查 `$DSH_HOME/profiles/node_modules` 这套「模块回退」。该目录在本机实测为 **187 个条目、其中 164 个符号链接**；需要重建时，Windows 上耗时 **73 s / 116 s / 119 s / 128 s**（多次实测），无需重建时 **2.2–2.6 s**。

而 SDK 默认 `initializeTimeoutMs = 10,000 ms`。**直接采用默认值会导致首次启动必然报「初始化超时」**。

→ 已在 ADR-0002 D2 要求两档超时 + 进度反馈；PHASE 01 需要评估「安装期预热 profile」以消除首启动 2 分钟等待。

### 4.2 崩溃遗留的锁会让下次启动失败，且错误信息完全误导

`dsh-atomic-write` 用 `wx` 创建 `profiles/node_modules.lock`，**不检查持有者 pid 是否存活**，只在 2,000 ms 内重试后抛错。SDK 上层把这层错误折叠成一句话：

```
dsh profile "sdk": JSON-RPC input closed
```

实测复现（探针 G，禁用「伪造死 pid + 强制 heal」）：

```
[probe] boot with stale lock (fresh home) {"exitCode":1,"ms":2719}
stderr: Error: atomic-write: timed out waiting for the writer lock at ...\profiles\node_modules.lock
```

→ Studio 必须：① 启动前检查锁并清理死 pid 的残留（参考实现 `clearStaleProfileLock()`）；② 把 stderr 摘要透出到 UI，不能只显示「连接被关闭」。

### 4.3 依赖图在 caret 范围内不可解

`dsh-app-boot` 精确声明 peer（`cordis@4.0.2` 等），而插件新版本要求 `cordis ~4.1.0`，`npm install` 直接 `ERESOLVE`；用 `--legacy-peer-deps` 装出来的树缺 `@deepseek-ai/cordis-plugin-group`，运行即 `ERR_MODULE_NOT_FOUND`。

→ 必须精确钉 6 个 cordis 包版本并提交 lockfile（ADR-0002 D6）。这不是洁癖，是「能不能装上」的问题。

### 4.4 文档与实现不一致：未知方法返回 -32603 而非 -32601

`dsh-sdk-protocol` README 写 `-32601`，实测 `-32603` + `unknown ... SDK runtime method: <name>`。判断「某能力是否存在」必须看消息文本，不能看错误码。

### 4.5 `--patch` 必须用 `insert:` 包裹

裸行会得到 `patch: entry "studio-mcp" not found`。`mcp-client` README 里的裸行示例是配置树条目，不是 `--patch` 文件。

## 5. 阶段门禁核对（逐条，不折算）

| # | 门禁 | 结果 | 依据 |
|---|---|---|---|
| 1 | 环境清单真实且带版本/命令输出 | **PASS** | EVIDENCE §1 |
| 2 | 官方 SDK 与实际 DSH 版本兼容性有证据 | **PASS** | EVIDENCE §2；版本漂移（全局 0.1.5-rc.1 / npm latest 0.2.2-rc.1）已记录 |
| 3 | 至少一条真实 Prompt 成功并收到可追踪结果 | **BLOCKED** | Prompt 成功入队并产生 15 条可追踪事件，但模型返回 402 `Insufficient Balance`；DSH 自身 `--profile headless` 同样 402，排除集成问题 |
| 4 | 事件/状态能记录并在 UI 或 CLI 展示 | **PASS** | 探针 CLI 实时输出 `running/idle`、事件计数；证据落盘 `evidence/*/summary.json` |
| 5 | Studio 只读工具被 DSH 调用成功 | **BLOCKED** | 注册链路 PASS（握手 + `tools/list` + 进入模型工具清单）；模型未运行故无 `tools/call` |
| 6 | Runtime 关闭后进程确实退出，记录退出码 | **PASS**（0.1.5 启动器级；0.2.1 见下方门禁 6 注） | 关闭后进程消失（探针 A/D）；启动器 stdin EOF 退出码 **0**，profile 启动失败退出码 **1**（探针 G） |
| 7 | Session 恢复/审批能力已验证或明确标记不支持 | **PASS**（0.1.5） | 0.1.5 上两者均标记 `NOT_SUPPORTED` 并有 `-32603 + unknown method` 证据；另验证 sessionId 复用被拒（0.1.5）。**0.2.1-rc.3**：正常关闭 Resume=`CONFIRMED`（CC-3）、审批=`UNKNOWN / NOT_OBSERVED`、`session/approve`=`NOT_SUPPORTED` |
| 8 | 技术选型 ADR 写明取舍和风险 | **PASS** | ADR-0001、ADR-0002 |
| 9 | 无密钥进入日志或 Git | **PASS** | EVIDENCE §11；`.gitignore` 覆盖 `.dsh/`、`dsh-home/`、`tmp/`、`.env` |
| 10 | GitHub 推送与复审交接完成 | **BLOCKED** | 仓库无 remote，本机无 `gh`；已在本地提交并生成复审包，推送需用户提供仓库 URL |

> **门禁 6 注（0.2.1-rc.3，2026-11-11）**：按原始措辞「Runtime 关闭后进程确实退出，记录退出码」判定，已满足。
> `evidence/cc-6-exitcode/summary.json`（`npm run probe:exit`）：正常 close → `exitCode = 0`；外部强杀 → `exitCode = 1`；两次均 `PROCESS_ABSENT`；`modelCallsMade = 0`。
> 退出码经 SDK 公开导出的 `TransportClosedError` message（`exit code: <n>`）取得；0.2.1-rc.3 没有结构化访问器（`HarnessClient#exitCode` 私有、`close()` 返回 `Promise<void>`、无 onExit 钩子），解析失败返回 `null`。

**综合判定：`PARTIALLY_VERIFIED`**。门禁 1/2/4/6/7/8/9 满足；3/5 被外部账号余额阻断；10 被远端缺失阻断。

按 `phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md` §结束状态，本阶段**不得标记 PASS**，也不得进入 PHASE 01。

## 6. 唯一阻塞项与解除方式

**阻塞：DeepSeek 账号余额不足（HTTP 402 / code QUOTA）。**

证据（两条独立路径）：

1. 探针事件流：`turn/end.reason.error = {code:"QUOTA", status:402, message:"Insufficient Balance (request_id: ...)"}`
2. DSH 自带 profile：`dsh --profile headless "Reply with exactly one word: PONG"` → `dsh: QUOTA: Insufficient Balance (...)`

解除只需要一件事：**为该账号充值，或提供一个有余额的 `DEEPSEEK_API_KEY`**。完成后执行：

```bash
cd spike/dsh-probe
node run-all.mjs      # 期望：A/B/C/D/E/F/G 全部 PASS，退出码 0
```

预期届时变化：A 的 `finalResponse` 非空、D 的 `stillRunningAtAbandon = true`、E 的审计日志出现 `tools/call get_studio_health`、F 的 `bothProducedText = true`。

## 7. 状态文件更新

- `state/project_state.json`：`current_phase = PHASE_00`，`phase_status.PHASE_00 = PARTIALLY_VERIFIED_DSH_BLOCKED_ON_MODEL_QUOTA`（**当时值**；当前以 `phase_00_final` 为准，不使用该后缀），后续阶段维持 `BLOCKED_BY_PREVIOUS_REVIEW`。
- `state/memory.json`：追加本阶段确认的技术事实（版本线、无取消/无恢复、MCP 唯一工具通道、依赖钉版本）。
- `memory-bank/handoff.md`：写入下一会话可直接接手的索引。

## 8. 与文档的偏离与需要记录的问题

| 项 | 原文档 | 实际 | 处理 |
|---|---|---|---|
| SDK 语言 | 「TypeScript SDK 或经验证的官方等价 SDK」 | TypeScript SDK 存在且可用 | 采用 TS SDK，偏离为零 |
| 未知方法错误码 | 协议 README 称 `-32601` | 实测 `-32603` | 记入 `docs/11`，ADR-0002 F2 |
| 会话恢复（0.1.5） | 「若当前 SDK 支持则验证」 | 0.1.5 不支持，且 sessionId 复用被拒；0.2.1-rc.3 正常关闭后 **CONFIRMED**（CC-3），中断轮次 `UNKNOWN`（U7） | 记入 ADR-0002 D4 |
| 工具审批 | 「若支持则验证映射」 | 0.1.5 协议层无审批消息、未观察到 server→client 请求；`session/approve` 方法本身不存在 | 审批回调记 `UNKNOWN / NOT_OBSERVED`；`session/approve` 记 `NOT_SUPPORTED` |
| 技术栈 | 未定 | 建议 Electron（ADR-0001） | 待复审批准 |

## 9. 明确没有做的事

- 没有进入 PHASE 01，没有创建项目工作台、素材库、任务调度或任何业务 UI。
- 没有为了「看起来完成」而用 Mock 替代真实调用；所有 Mock 均未使用。
- 没有提交任何密钥、`DSH_HOME` 实体、用户凭据或会话二进制。
- 没有为了让门禁变绿而修改断言；探针 G 的第一次实现曾因「未触发 heal 路径」得出错误结论，已被修正为强制走 heal 后才成立。

## 10. 建议的下一步（等复审结论后再执行）

1. 解除账号余额 → 复跑 `run-all.mjs`，把 A/D/E/F 从 BLOCKED 转 PASS，重新提交本阶段证据。
2. PHASE 01 首个任务应验证 ADR-0001 的 R4（Electron 打包后能否启动 `dsh`）与「安装期预热 profile」，这两项直接决定用户首次启动体验是 2.5 秒还是 2 分钟。
3. PHASE 01 需为 `RuntimeSupervisor` 落一份最小实现与契约测试（启动/关闭/崩溃/陈旧锁/双档超时）。
