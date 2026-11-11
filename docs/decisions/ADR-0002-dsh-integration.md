# ADR-0002｜DSH 集成：Runtime 生命周期、恢复、审批、工具桥接与隔离

- 状态：**PROPOSED / CONDITIONAL**（待外部复审确认）
- 日期：2026-11-10（初稿）／2026-11-10 修订（PHASE 00-R1）／2026-11-11 口径同步（R1.4.1 / PHASE 00 final）
- 阶段：PHASE 00-R1
- 相关：`ADR-0001-tech-stack.md`、`docs/04_DSH_INTEGRATION_SPEC.md`、`docs/phase-reports/PHASE_00_EVIDENCE.md`

---

## 0. 本版修订了什么（R1）

| # | 原表述 | 问题 | 本版处理 |
|---|---|---|---|
| 1 | 「当前 DSH **没有**取消/恢复/审批」 | 把 0.1.5 的限制写成了 DSH 的永久限制 | 改为**版本化能力矩阵**（§2），0.2.1 实测 `session/resume` 存在且**真正恢复历史** |
| 2 | 「Studio 自建上下文再水化替代恢复」 | 前提错了 | 改为「**优先官方 Resume，失败再水化**」（§3A） |
| 3 | 「一个 Studio → 一个 Runtime」 | 固化成最终架构；0.2.1 仍无 Runtime 级取消，一个 Runtime 承载多任务会导致「停一个、停全部」 | 改为 **RuntimeSupervisor Manager + 多 Runtime 拓扑**（§3B） |
| 4 | 审批只提到「两条通道」 | 未验证新版本是否有 SDK 审批回调 | 明确 0.2.1 实测仍未观察到服务端→客户端请求（`UNKNOWN / NOT_OBSERVED`，不是「不存在」），重验方法记录在 §3C |
| 5 | 生产要换官方 MCP SDK，但没验证兼容性 | 空头承诺 | §3D 给出验证结论与 PHASE 01 动作 |

## 1. 结论摘要

Studio 用官方 TypeScript SDK（`@deepseek-ai/dsh-sdk-client@0.2.1-rc.3`）驱动用户实际运行的 **DSH 0.2.1-rc.3 + commandcode provider**；会话恢复**优先用官方 `session/resume`**（已实测能恢复历史），Studio 自己的状态持久化仍是唯一业务真相；Runtime 从「单例」改为**受控多实例**，由 `RuntimeSupervisorManager` 分配；工具只走 MCP；Studio 业务审批与 DSH 工具许可**彻底分离**。

## 2. 版本化能力矩阵（实测，不是推测）

| 能力 | 0.1.5-rc.2 | 0.2.1-rc.3（用户实际运行） | 生产是否需要 | 证据 |
|---|---|---|---|---|
| Runtime 启动 / 握手 | PASS | **PASS** | 必须 | `cc-1-reply`、`legacy-0.1.5/evidence/a-basic-run` |
| 真实模型对话（commandcode） | 不适用（插件 0.15.4 要求 0.2.1 线；0.1.5 上被跳过） | **PASS**（回显随机口令 + 自述模型） | 必须 | `cc-1-reply` |
| MCP 工具注册 | PASS（注册成功） | **PASS** | 必须 | `cc-2-tools` stage1/2 |
| MCP 工具**实际调用** | BLOCKED（无模型可用） | **PASS**（模型调用 + Server 执行 + 回复用工具数据） | 必须 | `cc-2-tools` stage3 |
| Session Resume | **NOT_SUPPORTED**（方法不存在；复用 id 报 `already exists`） | **CONFIRMED**（正常关闭路径：重启进程后 `session/resume` 恢复历史）；中断中的最后一轮 = **UNKNOWN**（U7，`DEFERRED`） | 强烈需要 | `cc-3-resume` = `RESUME_RESTORES_HISTORY` |
| 工具审批回调（DSH 原生、可依赖） | `UNKNOWN / NOT_OBSERVED` | **仍 `UNKNOWN / NOT_OBSERVED`**（协议无审批消息类型；运行时未发起过 server→client 请求。「未观察到」≠「不存在」） | 需要（但可绕过，见 §3C） | `cc-5-capability` + 传输层类型声明 |
| `session/approve` 协议方法 | NOT_SUPPORTED | **仍 NOT_SUPPORTED**（`unknown method`） | 需要 | `cc-5-capability` |
| Runtime 级取消 | NOT_SUPPORTED | **仍 NOT_SUPPORTED**（`session/cancel` → unknown method） | 不假设存在 | `cc-5-capability` |
| Session 关闭 | NOT_SUPPORTED | **仍 NOT_SUPPORTED**（`session/close` → unknown method） | — | `cc-5-capability` |
| 工作目录查询/设置 | 无 | **SUPPORTED**（`session/working-directory/get|set`） | 有用 | `cc-5-capability` |
| 并发 Session | 部分（无模型） | **PASS**（两会话并行，答案未互换，无串台） | 需要 | `cc-4-concurrent` |
| 进程退出与回收 | 部分（仅直接子进程） | **PASS**（三态检测，含孤儿匹配） | 必须 | 全部 new probes |

**只有上表标 PASS 的才可写进实现假设。** 0.1.5 一列是历史基线，保留用于说明「插件与运行时强绑定」。

## 3. 决策

### D1｜只用官方 SDK，不自建传输层

Studio 代码中不得出现任何 JSON-RPC 帧的拼装或解析。所有会话经 `DeepSeekHarness` / `HarnessClient`；所有工具经 MCP。

MCP Server 侧：PHASE 00 为免依赖手写了协议。**生产必须换 `@modelcontextprotocol/sdk`**，因为实测 DSH 的 MCP Client 协商的是 `2025-11-25` 版本，跟随演进只能靠官方实现。PHASE 01 首任务做兼容性冒烟（server 起得来、工具进清单、能被调用）。

### D2｜RuntimeSupervisor：唯一所有权 + 三态进程判据

- 一个 Runtime 由一个 supervisor 独占；supervisor 负责启动、握手、事件转发、`close()`、**进程树清空校验**。
- 关闭成功的唯一判据是 **OS 进程表里查不到该 Runtime 及其后代与孤儿**，不是 `close()` 返回，也不是 UI 关闭。
- 进程检测必须三态：`PROCESS_PRESENT` / `PROCESS_ABSENT` / `PROCESS_CHECK_FAILED`。**查询失败不得当作「已退出」**（PHASE 00 的 `catch → []` 就是反例，已修正）。
- 孤儿检测不能只走父子链：Windows 上父进程死后子进程会被重挂，必须同时用命令行标记（隔离的 `DSH_HOME` 路径、MCP server 脚本路径）匹配。
- 两档超时：常规启动 ≤ 30 s；需要重建 profile 模块回退时 ≤ 300 s，并向用户显示阶段。

### D3｜Runtime 隔离：按任务动态调度，不固定「一角色一 Runtime」

0.2.1 **仍无 Runtime 级取消**。若一个 Runtime 承载多个项目/任务，停止任一任务只能杀掉整个 Runtime，
会连带中止其他任务。这一点决定了必须有隔离边界，但**不等于**要为每个角色/项目永久固定一个 Runtime。

`RuntimeSupervisorManager` 定位为**动态调度器**：

```
Studio
│
├── RuntimeSupervisorManager
│     ├── 按任务类型申请/归还 Runtime
│     ├── 顾问类会话：可在受限条件下共享一个 Runtime（只读、不挂写工具）
│     ├── 执行类任务：独立 Runtime（有写权限，独立停止边界）
│     ├── 复审类会话：独立 Runtime（不与被审对象共享进程）
│     └── 资源预算：并发上限、内存/进程配额，超限先拒绝新任务再回收
```

必须满足的约束：

1. 顾问与代码执行**有隔离边界**：顾问 Runtime 不挂写工具。
2. 不同项目的执行任务**有独立停止边界**：停 A 不影响 B。
3. 同一项目的写入任务**仍然串行**：跨 Runtime 也要有项目级写锁（锁在 Studio 侧，不在 Runtime 侧）。
4. Agent 不得绕开写锁：写工具只在持锁的 Runtime 上注册。
5. 关闭一个 Runtime 不得影响其他：每个 supervisor 只跟踪自己的进程树。
6. Runtime 崩溃后能定位到具体任务：`DSHSessionLink{runtimeId, sessionId, projectId, taskId}` 持久化。
7. **用户不管理 Runtime**：分配、回收、限流全部由 Manager 决定，UI 只展示状态。

**不冻结的部分**（避免把未验证的编排写死）：并发 Runtime 数量、共享粒度、资源配额阈值。
这些由 PHASE 01 实测决定；ADR 只固定「必须有隔离与停止边界」和「用户不参与调度」两条。

### D4｜会话恢复：优先官方 Resume，Studio 状态永远是真源

0.2.1 实测 `session/resume` 能把历史恢复。**但必须说清证据边界**：探针 CC-3 走的是
「正常 `close()` → 新进程 → `resumeSession()` → 仍能答出随机口令」，**不是崩溃恢复**。
强制杀进程、任务执行到一半崩溃、外部 Shell/MCP 残留等情形**均未验证**（见 §6 第 3 条）。

因此恢复流程按「先能做什么」排序，未验证的环节在实现时必须先加探针：

```
Runtime 结束（正常关闭已实测；崩溃未实测）
   ↓
① 恢复 Studio 侧状态（项目/任务/契约/基线/Commit/审批/事件游标）
   ↓
② 检查原 DSH Session 是否仍在磁盘
   ↓
③ 尝试官方 session/resume（失败则新建 session）
   ↓
④ 校验上下文：用一条探针 prompt 确认关键事实仍在（如当前任务 id）
   ↓
⑤ 校验副作用：Shell/PTY/MCP 等外部进程是否还在，重新建立
   ↓
⑥ 由任务状态机决定继续 / 重试 / 请求用户
```

**必须写进实现的两条**：

- Session 恢复 ≠ 外部进程恢复。Shell、PTY、MCP Server、构建进程都要重新检查与重建。
- Studio 数据库是业务状态的唯一真相；Session 只是对话载体。禁止用 Session 历史推断任务状态。

### D5｜工具桥接与「审批双通道」

- 工具只经 MCP 暴露，命名固定 `mcp__studio__<tool>`；先只读，再提案，最后受控写入。
- 危险能力（任意路径写、无限制 shell）**不经 MCP 暴露**，由 Studio 适配器执行并受写锁约束。
- **DSH 工具许可审批在 0.2.1 仍没有可用 UI 映射**。证据边界要说清（R1.4 统一口径）：

  | 能力 | 状态 | 依据 |
  |---|---|---|
  | `session/approve` 协议方法 | `NOT_SUPPORTED` | `unknown ... method`（CC-5） |
  | 通用 `onRequest(handler)` 钩子 | **存在** | SDK 传输层类型声明；未被执行路径触及 |
  | DSH 原生、可依赖的审批回调 | `UNKNOWN / NOT_OBSERVED` | 协议无审批类消息；实测未出现 server→client 请求。「未观察到」≠「不存在」 |
  | 完整审批请求/响应流程 | `UNVERIFIED` | 无样本可测 |
  | Studio 自身业务审批 | 由 Studio 实现 | 不依赖 DSH 回调 |

  - 协议只有 7 个 client→server 请求和 4 个 server→client 通知，**没有任何审批类消息类型**。
  - 传输层暴露通用的 `onRequest(handler)`，理论上能接服务端发起的请求；但实测运行期间**服务端一次都没有发起过 server→client 请求**。
  - 因此结论是「**没有可依赖的审批回调**」，而不是「传输层完全没有这个钩子」——后者不准确。
  - Studio 的业务审批（冻结基线、批准变更、批准构建/发布、危险文件操作）是**自建 UI + 状态机**，与 DSH 无关。
  - 危险工具不直接暴露给模型：模型只能提出操作方案，Studio 审批通过后由**自己的适配器**执行。
  - 若未来版本提供成型的审批回调，必须先实测其请求 id、超时、拒绝后的工具语义，再接入；接入后**仍然不能**用「某次工具被批准」替代业务审批。

### D6｜版本钉死 + 探针即回归

- 依赖整族精确钉版本（cordis 4.0.5 / group 1.0.5 / include 1.0.10 / loader 1.0.6 / sdk-client 0.2.1-rc.3）。
- **不要升级用户全局 DSH**。`dsh` on PATH 是 0.1.5-rc.1，用户日常用的是桌面端 0.2.1-rc.3；Studio 应自带/锁定自己的运行时，不依赖 PATH。
- 升级前必须重跑 `spike/dsh-probe/current-0.2.1/npm test`（当前基线：156 项回归测试 + 六探针 6/6 + 三道门禁 PASS；另有不消耗模型额度的 CC-6 退出码探针）与 `legacy-0.1.5` 套件；协议随时可能变。
- 依赖锁由 `profile-locks/<profile>/package-lock.json` + `tree.json` 共同定义；普通运行不生成锁，只校验，漂移即失败。升级流程是 `npm run lock:update` → 重跑 `npm test`。

## 4. 已实测的缺陷与防御

| ID | 缺陷 | 后果 | 措施 |
|---|---|---|---|
| F1 | 崩溃的 profile 启动遗留 `profiles/node_modules.lock`；`dsh-atomic-write` 不校验 pid 存活，2 s 后抛错 | 下次启动失败，SDK 只报 `JSON-RPC input closed` | 启动前清理死 pid 锁；stderr 摘要透出 |
| F2 | 未知方法返回 `-32603` 而非文档所称 `-32601` | 用错误码判能力会误判 | 用消息文本 `unknown ... method` 判定；同时区分「方法存在但参数被拒」 |
| F3 | `session/prompt` 的 `messageId` 只是入队回执 | 把回执当结果会读到空 | 以 `session.status → idle` 为边界收敛 |
| F4 | 启动耗时双峰（2–3 s vs 73–128 s） | 默认 10 s 超时误报失败 | 两档超时 + 进度反馈 |
| F5 | Provider 错误以 `turn/end reason.kind=error` 出现，SDK 不抛异常 | 用户只看到「没回复」 | 解析 `turn/end.reason` 映射为可读文案 |
| F6 | 0.1.5 上加载不兼容插件会被**静默跳过并回退**到别的 provider | 测试结果张冠李戴（PHASE 00 的 402 就是 DeepSeek 回退，不是用户模型） | 每次运行必须记录 `request/header.config.provider/model`，并对「是否发生 Provider 回退」做断言 |

F6 是 PHASE 00-R1 最重要的教训：**不看路由证据就会把 A Provider 的失败当成 B Provider 不可用。**

## 5. 凭据与隔离

- Studio 不复制、不打印、不提交 `~/.dsh` 内容。探针全程使用隔离 `DSH_HOME`。
- Provider 凭据只以**环境变量名**形式出现在 patch 里（`apiKeyEnv: COMMANDCODE_API_KEY`），值由运行时的 credential seam 解析。
- 生产形态待定：**每项目一个隔离 DSH_HOME**（隔离会话/插件/权限）vs **复用用户 `~/.dsh`**（用户已登录、插件已装）。倾向隔离，但代价是用户需重新配置 provider；PHASE 01 需实测「隔离 home 里加载 commandcode 需要哪些前置」。
- `.credentials.yaml`、token、`DSH_HOME` 实体目录一律不进 Git。

## 6. 仍未验证

1. Electron 打包后上述链路是否成立（ADR-0001 §5）。
2. 隔离 `DSH_HOME` 下加载 commandcode 的完整前置（本次是用独立 profile + 手工安装插件达成的，生产安装流程未设计）。
3. Runtime 崩溃后「外部进程是否随崩溃消失」的实测。
4. MCP Server 换成官方 SDK 后的兼容性。
5. 多 Runtime 拓扑的资源占用与启动成本。
6. 0.2.2 线是否补上取消/审批（本次未测 0.2.2，只用 0.2.1-rc.3，因为它与用户插件声明兼容）。
7. **崩溃恢复**：强杀 Runtime 后 `session/resume` 能否恢复、中断中的最后一轮如何处理——CC-3 只覆盖了正常关闭路径，此项为 PHASE 01 早期可靠性验证项。

## 7. 复审关注点

1. D3 的多 Runtime 拓扑是否接受？它把「取消」问题转化为「隔离」问题，但会增加进程数与内存。
2. D4 的恢复流程中，"用一条探针 prompt 确认上下文仍在" 是否可接受（会消耗一次模型调用）。
3. D5 在无审批回调时的降级方案（不给工具 / 模型先提案）是否足以满足 P3 风险操作的门禁要求。
