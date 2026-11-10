# ADR-0002｜DSH 集成方式：Runtime 生命周期、事件、工具桥接与会话连续性

- 状态：**PROPOSED**（待外部复审确认）
- 日期：2026-11-10
- 阶段：PHASE 00
- 相关：`ADR-0001-tech-stack.md`、`docs/04_DSH_INTEGRATION_SPEC.md`、`docs/phase-reports/PHASE_00_EVIDENCE.md`

---

## 1. 结论摘要

Studio 通过**官方 TypeScript SDK**（`@deepseek-ai/dsh-sdk-client`）在子进程中启动 `dsh --profile sdk`，用 `DeepSeekHarness` 跑会话、用 `HarnessClient` 做底层控制；**工具桥接只走官方 MCP 通道**（`@deepseek-ai/dsh-mcp-client` + Studio 自建 stdio MCP server）；**会话恢复、运行中取消、工具审批回调在当前版本均不存在**，Studio 必须用自己的状态机承载这些语义。以上全部由 PHASE 00 实测得出，证据见 `PHASE_00_EVIDENCE.md`。

## 2. 实测到的能力边界（当前安装版本）

| 能力 | 现状 | 证据 |
|---|---|---|
| 启动 Runtime | 可用。`DeepSeekHarness.start()` / `HarnessClient.start()` | 探针 A、B |
| 握手 | 可用。`initialize{cwd, provider, model, reasoningEffort?, maxTokens?}` → `serverInfo{name:"deepseek-harness-sdk-runtime", version:"0.0.1"}` | 探针 B `initialize.result` |
| 发送 Prompt | 可用。`session/prompt{sessionId, contentBlocks}` → `{messageId}`（仅入队回执） | 探针 B |
| 事件 | 可用且足够。`session.event`（完整 session log 事件）、`session.status`（`running`/`idle`）、`subagent.started`/`subagent.finished` | 探针 A：单轮 15 条事件；B：状态序列 `running → idle` |
| 关闭 | 可用。协议 `shutdown` → stdin EOF → SIGTERM → SIGKILL，直到进程真退出 | 探针 A/D：关闭后 51–1057 ms 内子进程消失 |
| 运行中取消 | **不存在**。`session/cancel` 被拒 | 探针 B：`unknown ... SDK runtime method: session/cancel` |
| 会话恢复 | **不存在**。`session/resume` 被拒；复用已存在的 sessionId 直接报错 `session "..." already exists` | 探针 B、C |
| 会话关闭 | **不存在**。`session/close` 被拒 | 探针 B |
| 工具审批回调 | **不存在**。协议明确「server→client requests 是死能力，服务器从不发送」 | 文档 + 探针 B（无任何 server→client 请求出现） |
| 工具桥接 | 可用，且**只有 MCP 一条路**。SDK 协议没有任何工具注册方法 | 探针 E：Studio MCP server 完成 `initialize`(protocolVersion `2025-11-25`, client `dsh-mcp-client@0.0.1`) 与 `tools/list`，工具以 `mcp__studio__get_studio_health` 出现在模型工具清单（26 个工具中） |
| 并发 | 同一 Runtime 可并行两个 session，事件按 sessionId 隔离 | 探针 F |

## 3. 决策

### D1｜只用官方 SDK，不自建传输层

`AGENTS.md` 2 与 `docs/04` 明令禁止手写 JSON-RPC。本 ADR 进一步收紧：**Studio 代码中不得出现任何 `\n` 分隔 JSON-RPC 帧的拼装或解析**。所有调用经 `DeepSeekHarness` / `HarnessClient`；所有工具经 MCP。

副产品：Studio 侧的 MCP server 是**自己的实现**，它讲的 MCP 协议（公开标准）不是 DSH 协议。PHASE 00 的探针实现为免依赖手写了 MCP 握手；**生产必须换用 `@modelcontextprotocol/sdk` 的 server**，理由是这样才能跟上 MCP 版本演进（实测 DSH 协商的是 `2025-11-25`）。

### D2｜`RuntimeSupervisor` 独占 Runtime，且以「进程真实退出」为唯一成功判据

- 一个 Studio 进程对应一个 supervisor，一个 supervisor 对应至多一个 dsh 子进程。
- 启动：spawn → `initialize` 握手 → 记录 `serverInfo`；失败则按 `AggregateError` 语义上报，不重试到天荒地老。
- 关闭：调用 `close()`，随后**轮询 OS 进程表**确认子进程消失，记录耗时与退出码；不得只把 UI 置灰。
- 超时：`initializeTimeoutMs` 不能沿用 SDK 默认 10 s。实测首次冷启动 **73 s**（要物化 profile 的 `node_modules` 回退），热启动约 **2.2 s**。Studio 需两档超时（冷启动 ≥180 s 且向用户显示阶段），否则首启动即误报失败。

### D3｜取消语义：把「停止等待」和「停止工作」在 UI 上分开表达

协议无取消。Studio 的「停止」只有两种诚实实现：

1. **停止查看**：断开订阅，Runtime 继续跑。UI 必须显示「Agent 仍在运行」。
2. **停止运行**：`close()` 杀掉 Runtime 进程树。UI 必须显示「运行时已关闭，未完成的 turn 已中止」。

禁止出现「已取消」这种既不真停也不说明的第三态。这与 `AGENTS.md` 5 末句、`docs/04` 生命周期段一致。

### D4｜会话连续性由 Studio 负责，不依赖 DSH 恢复

实测结论：`NO_RESUME_AT_SDK_LEVEL`（探针 C）。同一 sessionId 在新进程中复用会被拒绝，说明「沿用旧 session」这条路是关的。

因此 Studio 的恢复设计为：

- 业务状态、任务契约、事件游标、审批记录一律存 Studio 自己的库（`docs/03` 已要求「业务状态以 Studio 为准」）。
- Runtime 重启后**新建 session**，由 Studio 编译一份「上下文再水化包」（当前任务、已批准基线摘要、未完成项、上次事件游标）作为首条 prompt 的上下文注入。
- Session 的持久日志（`$DSH_HOME/sessions/<workspace>/<sessionId>/session.v3.jsonl.zstd`）只作**审计证据**，不作恢复依据。

### D5｜工具桥接分层，且审批分成两条独立通道

- Studio 起一个 stdio MCP server（每个 Runtime 一个，绑定当前 `projectId`），通过 `--patch` 注入 `dsh-mcp-client`。
- 工具命名固定 `mcp__studio__<tool>`；PHASE 00 只暴露只读 `get_studio_health`。
- **DSH 工具许可审批当前不可用**（无 server→client 请求）。Studio 的业务审批（冻结基线、批准变更、批准构建与发布）是**自建 UI + 状态机**，与 DSH 无关。两者不得共用一套「已批准」标记——这正是 `docs/04` 「审批必须区分两层」的落地方式。
- 危险能力（任意路径写、无限制 shell）**不通过 MCP 暴露**；构建、Git、文件写入由 Studio 自己的适配器执行，受项目写锁约束。

### D6｜版本钉死 + 探针即回归用例

实测发现依赖图在 caret 范围内会漂移成不可解：

- `dsh-app-boot` 精确要求 `@deepseek-ai/cordis@4.0.2`；
- 但 `cordis-plugin-include@1.1.0` / `cordis-plugin-timer@1.2.0` 要求 `cordis ~4.1.0` → `npm install` 直接 `ERESOLVE`。

可行组合（与全局 `dsh@0.1.5-rc.1` 内部一致）：`cordis 4.0.2`、`cordis-plugin-group 1.0.2`、`cordis-plugin-hmr 1.0.17`、`cordis-plugin-include 1.0.7`、`cordis-plugin-loader 1.0.3`、`cordis-plugin-timer 1.1.4`。

因此：

- 这 6 个包 + `dsh-sdk-client` **全部精确版本、写进 `package.json` 与 lockfile**，不使用 `^`。
- SDK 客户端会把**同版本的 `@deepseek-ai/dsh`** 作为依赖带入，因此 Studio 不必依赖用户全局安装的 `dsh`。当前全局是 `0.1.5-rc.1`，npm 上 `latest` 已是 `0.2.2-rc.1`——**升级前必须重跑本阶段探针套件**，因为协议随时可能变。
- `spike/dsh-probe` 保留为可执行回归基线，`node run-all.mjs` 退出码即门禁（0 全通过 / 2 有 BLOCKED / 1 有 FAIL）。

## 4. 已知缺陷与必须的防御

| ID | 缺陷 | 后果 | Studio 侧措施 |
|---|---|---|---|
| F1 | 崩溃的 profile 启动会遗留 `$DSH_HOME/profiles/node_modules.lock`（内容是持有者 pid）；`dsh-atomic-write` **不校验 pid 存活**，只在 2,000 ms 内重试后抛错 | 下次启动在 2 秒后失败，SDK 只报 `JSON-RPC input closed`，用户看不到原因 | 启动前检查锁：pid 不存活则清理并记审计；仍失败则把原始 stderr 摘要呈现给用户。参考实现 `clearStaleProfileLock()`（探针 G 已复现该缺陷） |
| F2 | 未知方法返回 `-32603` 而非其文档声称的 `-32601` | 用错误码判断「能力是否存在」会误判 | 判断依据改用错误消息 `unknown ... method`，并记录码值差异 |
| F3 | `session/prompt` 的 `messageId` 只表示用户消息入队，不代表 assistant 回复 | 把回执当结果会读到空内容 | 以 `session.status → idle` 为边界收敛，再取区间内最后一条 assistant 消息（SDK `RunResult.finalResponse` 已按此实现） |
| F4 | 启动耗时不稳：热启动 2.2–2.6 s，需要重建 `profiles/node_modules` 模块回退时 **73–128 s**（该目录本机实测 187 条目 / 164 符号链接）；SDK 默认握手超时 10 s | 误报初始化失败；用户以为应用卡死 | 两档超时 + 进度提示（D2）；PHASE 01 评估安装期预热 profile |
| F5 | 供应商错误（如 402 QUOTA）在事件流里以 `turn/end reason.kind=error` 出现，SDK 不抛异常 | 用户只看到「没回复」 | Studio 必须解析 `turn/end.reason` 并映射为可读文案；`detectModelBlocker()` 是参考实现 |

## 5. 凭据与隔离

- Studio **不复制、不打印、不提交** 用户 `~/.dsh` 内容。PHASE 00 探针全程使用隔离 `DSH_HOME`（`spike/dsh-probe/tmp/dsh-home`，已 gitignore）；只有 `DEEPSEEK_API_KEY` 从环境继承。
- 生产形态待定（PHASE 01 ADR）：**每项目一个隔离 DSH_HOME** vs 复用用户 `~/.dsh`。倾向前者（隔离会话与插件），代价是用户需要重新授权/provider 配置，需产品确认。
- 任何 `.credentials.yaml`、token、`DSH_HOME` 实体目录**不得**进入 Git；`.gitignore` 已覆盖 `.dsh/`、`dsh-home/`、`.env`。

## 6. 未验证项（不得当作已通过）

1. **模型真实回复**：账号余额不足（402），探针 A/C/E/F 的「模型产出文本」类断言均为 `BLOCKED`。
2. **模型主动调用 Studio 工具**：工具已注册并出现在模型工具清单，但缺少模型实际发起 `tools/call` 的记录（同上）。MCP 握手与注册已验证。
3. **工具审批回调**：当前协议根本不支持，非「未测」而是「不存在」。
4. **Python SDK**（`packages/python`）存在但未验证；本阶段只用 TypeScript SDK，避免引入第三种运行时。
5. **`sdk-minimal` profile 是否更适合生产**（更小攻击面、只暴露一个 shell）：未验证其是否可挂 MCP。
6. **Electron 打包后 `dsh` 子进程可用性**：见 ADR-0001 R4。

## 7. 复审关注点

1. 接受「无取消 + 无恢复」作为当前版本的既定约束，由 Studio 承接语义吗？若不接受，需要重新评估 DSH 版本（`0.2.2-rc.1` 是否已补齐）——但这会改变已验证基线。
2. 上下文再水化（D4）是否足以替代 session 恢复？它的代价是每次重启都要消耗一次较大的 prompt。
3. 工具桥接目前只读；进入写操作前，是否需要先补一套「Studio 侧审批 + 审计」的强制门禁（本 ADR 认为必须有）。
