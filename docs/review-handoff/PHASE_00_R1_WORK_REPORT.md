# PHASE 00-R1 工作报告（含 PHASE 00 最终结论）

权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

> 本报告覆盖 PHASE 00 的六轮整改与最终收尾。**当前状态只以「PHASE 00 最终结论」一节为准**；
> 其后各章（含「R1.4.1 当前状态」）均为历史记录，其中的数字（5/5、163、167、68/90 项）
> 属于当时的运行规模，不代表当前事实。
>
> - 仓库：`https://github.com/xiaoLin12130/ai_game_studio`（**保持 Public**，未改可见性）
> - 分支：`phase/00-feasibility`
> - 日期：2026-11-11
> - 外部评审固定的 R1.4 提交：`1928fb1628b8dc3ac057fd618936aa601d9267ef`
> - **本轮审查基准（固定 Commit）**：`6230340071d6618d50d57832f6dff62b8dd8a735`
> - **本轮交付 Commit**：分支 `phase/00-feasibility` 的 HEAD（`git rev-parse HEAD`）。
>   报告**不内嵌自身 Commit SHA** —— 上一轮正是因为把交付 SHA 写在报告里、又在后续提交中改动报告，
>   造成「评审打开的固定提交」与「交付版本」不是同一份文件。

## PHASE 00 最终结论（唯一权威）

| 项 | 值 |
|---|---|
| 阶段结论 | **`PARTIALLY_VERIFIED`** |
| 依据 | 冻结范围内 10 条门禁均有证据且为 PASS；但最近一次外部独立评审结论为 `PARTIALLY_VERIFIED`，R1.4.1 收尾尚未获得正式复审通过；本轮未重跑真实模型探针。按阶段定义「只有门禁全部满足才 PASS」，正式 PASS 由外部评审决定，本报告不自行宣布 |
| 唯一事实源 | `state/project_state.json` → **`phase_00_final`**，由 `authoritative_source.current_record` 显式声明 |
| 历史记录 | `phase_00`、`phase_00_r1.gate_results`、`r11`…`r141` 全部保留、只读，不作当前状态（旧对象里仍留有 `BLOCKED` 的当时结论） |
| 六探针 | 6/6 PASS，`2026-11-10T12:43:44Z` 真实模型运行（`evidence/r14/summary.json`）；**本轮未重跑、未覆盖、未伪造** |
| 本轮验证 | `npm run test:unit` / `npm run gates` / `scrub --check` / 静态检查，见「最终验证」一节；数字以对应证据文件为准 |
| 本轮阻断项 | 无（PHASE 00 范围内）。已修的是「状态权威源不唯一 + 两条核心门禁仍标 BLOCKED」这一交付缺陷 |
| 8 项未解决问题 | **均不阻断 PHASE 00**：U1–U7 = `DEFERRED`，U8 = `BLOCKED`（环境安全垫，不解除）；逐项登记于 `phase_00_final.deferred`（含后续阶段、风险、验证条件）与 `unknown` |
| HY4 | 独立验证事项 `UNKNOWN`：WorkBuddy 免费额度下可用 HY4 开发 ≠ DSH 已能通过官方接口调用 HY4；不阻塞当前阶段、不改架构、不伪造测试 |
| 下一步 | 等外部评审；通过后按 `phase_00_final.next_phase` 进入 PHASE 01 |

本轮只做范围收口，**未改动任何 DSH 探针执行逻辑**，因此未重跑六项真实模型探针。
证据目录与每个文件的归属见 `spike/dsh-probe/current-0.2.1/evidence/r14/README.md`。

---

## R1.4.1 当前状态（历史记录，已被上节取代）

| 项 | 值 |
|---|---|
| 阶段 | PHASE 00-R1.4.1（四项收口，不新增技术探索、不重跑模型探针） |
| 六探针 | **6/6 PASS**，来自最后一次完整真实运行 `2026-11-10T12:43:44Z`（`evidence/r14/summary.json`）；**R1.4.1 按评审要求未重复模型调用** |
| 最终门禁回归 | 依赖门禁 **PASS**；脱敏门禁 **PASS**：扫描 **173/173** 个发布文件，泄漏 0，exit **0**（`evidence/r14/final-gates.json`） |
| 回归测试 | **90/90 PASS**，exit **0**（`evidence/r14/tests.json`） |
| 阶段判定 | `PARTIALLY_VERIFIED` — 四项修正已 `CONFIRMED`；冻结范围外能力仍为 `UNKNOWN` |

当时的权威事实源为 `state/project_state.json` → `phase_00_r1.r141`；**现已由 `phase_00_final` 取代**。

---

## 0. 必填事实表

```text
实际 DSH Provider / 插件：commandcode / @mars-sea/dsh-commandcode-provider@0.15.4
实际模型：              deepseek/deepseek-v4.1-flash
实际 Profile：          cc-sdk（SDK 验证，隔离 DSH_HOME）
                        cc-cli（CLI 基准，隔离 DSH_HOME，headless 型）
                        用户日常：desktop（只读核对配置，未修改）
DSH CLI 版本：          0.1.5-rc.1（PATH 上的旧版）
                        0.2.1-rc.3（DSH Desktop 自带，用户实际运行）
SDK 版本：              @deepseek-ai/dsh-sdk-client@0.2.1-rc.3
CLI 基准测试结果：      PASS（真实推理 + 回显随机标识 + 自述模型名）
SDK 集成测试结果：      PASS（六探针 6/6 + 三道门禁；另有不消耗模型额度的 CC-6 退出码探针）
是否使用真实模型：      是（随机标识回显，无法用桩伪造）
是否发生 Provider 回退：否（SDK 探针断言每一个 request/header 的 provider 与 model）
```

**关于「是否发生 Provider 回退」的说明**：PHASE 00 的探针没有断言路由，导致 DeepSeek 官方 provider 的 402 被误当成「用户模型不可用」。整改后**所有会发模型请求的 SDK 探针**（CC-1…CC-4）都读取 `request/header.config` 并断言 provider 与 model，回退会被判成 FAIL 而不是静默通过。**CC-0 是 CLI 探针，没有 `request/header` 事件**，它只断言退出码、随机标识回显、模型自述与失败类别——CLI 链路的 provider 归属靠「自述模型名 + 无回退类错误」间接佐证，不构成路由证明。

---

## 1. 整改前的问题（复审指出的 + 我自查的）

| # | 问题 | 严重性 | 证据 |
|---|---|---|---|
| P1 | 探针默认 `provider=deepseek-official`、`model=deepseek-v4-flash`，**不是用户实际配置** | 致命：结论与用户环境无关 | `legacy-0.1.5/src/probe-basic.mjs` 的 `PROBE_PROVIDER/PROBE_MODEL` 默认值 |
| P2 | PHASE 00 把 402 归因为「用户模型不可用」 | 致命：错误结论 | `docs/phase-reports/PHASE_00_REPORT.md`（旧版）§6 |
| P3 | 进程检测吞异常：`catch { return [] }` → 查询失败被当成「进程已退出」 | 高：把坏检查当成通过 | `legacy-0.1.5/src/lib/proc.mjs` |
| P4 | 只检查直接子进程，且不排除检测程序自身（自污染） | 高：孤儿/自身进程都被误判 | legacy `listChildProcesses` |
| P5 | 探针 D 把「事件数增长」等同于「模型仍在工作」 | 高：402 的重试事件会被当成有效产出 | legacy `probe-cancel.mjs` |
| P6 | 探针 C 把「会话文件存在」当成「历史可恢复」 | 中：结论超出证据 | legacy `probe-resume.mjs` |
| P7 | 探针 E 只验证到「工具进清单」，但措辞接近「桥接完成」 | 中：阶段混淆 | legacy `probe-tools.mjs` |
| P8 | 0.1.5 的限制被写成 DSH 的普遍限制 | 高：误导架构决策 | 旧 ADR-0002 §2 |
| P9 | 报告/状态文件互相矛盾（8 PASS vs 7 PASS） | 中：多真相源 | 复审指出 |
| P10 | 证据含本机绝对路径（公开仓库） | 中：隐私 | 旧 evidence/*.json |

---

## 2. commandcode 是怎么被加载的（可复现）

用户日常的 DSH Desktop 0.2.1-rc.3 通过 **profile bundle 机制**加载第三方 provider：

1. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 与 `dependencies` 含 `@mars-sea/dsh-commandcode-provider@0.15.4`；
2. 该插件自带 `cordis.patch.yml`，插入一行 `llm-commandcode`（`apiKeyEnv: COMMANDCODE_API_KEY`）；
3. `~/.dsh/profiles/desktop/cordis.patch.yml` 再把 `agent-default-model` 覆盖为 `provider: commandcode` / `model: deepseek/deepseek-v4.1-flash`；
4. 插件 `package.json` 声明 `dsh.compatibility: ">=0.2.1-rc.2 <0.2.2-0"` —— **这就是不能停留在 0.1.5 的硬原因**。

本次验证用的是**隔离 DSH_HOME** 下的自建 profile，结构与 desktop 同构但不含 UI 插件：

```
spike/dsh-probe/current-0.2.1/dsh-home/profiles/
├── cc-sdk/   bundles: dsh-base + dsh-sdk-app + (patch) llm-commandcode
└── cc-cli/   bundles: dsh-base + dsh-headless + (patch) llm-commandcode + agent-default-model
```

补丁形态（`insert:` 用于新增行，`id:` 裸行用于覆盖已有行——这个区别在 PHASE 00 也踩过）：

```yaml
- insert:
    - id: llm-commandcode
      name: '@mars-sea/dsh-commandcode-provider'
      config:
        apiKeyEnv: COMMANDCODE_API_KEY
- id: agent-default-model
  config:
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash
    reasoningEffort: high
```

**未修改用户任何全局配置**：`~/.dsh` 只读；未升级全局 `dsh`；未删除任何 Session；凭据只以环境变量**名**出现在配置里。

> 一个必须记住的坑：只插 `llm-commandcode` 行**不会**改变默认模型。CLI 场景下 `agent-default-model` 仍指向 deepseek，于是静默回退并报 402。我第一次跑 CLI 基准就中了这个坑，日志里出现 `[llm-deepseek-api-key] model listing ...` 才暴露。

---

## 3. CLI 基准测试（gate 4）

命令（隔离 DSH_HOME，0.2.1-rc.3 运行时，commandcode 0.15.4）：

```
node ./node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile cc-cli --patch tmp/cc-cli.patch.yml \
  "请回复一行，原样包含：验证标识 CC-cli-1794307597。并说明你使用的模型名。"
```

输出：当时保存的原始 stdout 已按 R1.2 的安全要求删除，改由
`evidence/cc-0-cli-baseline/summary.json` 的结构化字段承载（`tokenEchoed=true`、`modelNamed=true`、
`exitCode=0`、`diagnostics.kind=null`）。当时的原始回显内容形如：

```
No tools needed.
验证标识 CC-cli-<随机值>；我使用的模型名是 deepseek/deepseek-v4.1-flash。
EXIT=0
```

**结论**：`CONFIRMED` — CLI 通过用户真实 provider 完成推理并回显随机标识。

对照实验（证明「不能停在 0.1.5」）：

```
dsh --profile headless "Reply with exactly one word: PONG"     # 0.2.1 CLI
→ dsh: skipping profile bundle "@mars-sea/dsh-commandcode-provider":
  Plugin ...@0.11.3 is incompatible with dsh 0.2.1-rc.3 ...
→ [llm-deepseek-api-key] model listing from https://api.deepseek.com/models ...
→ dsh: QUOTA: Insufficient Balance
```

即：**旧 profile 的 0.11.3 被运行时拒绝 → 静默回退到 DeepSeek → 402**。PHASE 00 收到的正是这个 402。

---

## 4. SDK 集成测试（gate 5 / 6 / 7；R1 期 5 探针，历史数字）

`cd spike/dsh-probe/current-0.2.1 && node run-all.mjs` → **5/5 PASS，退出码 0**（R1 期 5 探针规模；当前为六探针 **6/6 PASS**，最后一次完整真实运行 `2026-11-10T12:43:44.987Z`，见头部最终结论）

| 探针 | 验证内容 | 结果 | 关键证据 |
|---|---|---|---|
| **CC-1** | 真实对话 + 路由断言 | **PASS** | 回显随机标识 `studio-xxxx`；`request/header.config = {provider:"commandcode", model:"deepseek/deepseek-v4.1-flash"}`；自述模型名 |
| **CC-2** | MCP 工具三阶段 | **PASS** | server 启动 + 握手 → 工具进清单 → **模型真实调用** `mcp__studio__get_studio_health` 且 **Studio Server 审计到 `tools/call.served`** → 回复 `status=ok` / `phase=PHASE_00` |
| **CC-3** | Session Resume | **PASS** | `RESUME_RESTORES_HISTORY`：重启进程后 `session/resume` 仍答出随机口令 `recall-xxxx`；且 resume 不存在的 session 被拒（负对照） |
| **CC-4** | 并发隔离 | **PASS** | 两会话并行，分别答 `APPLE` / `BANANA`，未互换；通知仅含各自 sessionId；关闭后无残留 |
| **CC-5** | 能力矩阵 | **PASS** | `session/resume` / `session/wait` / `working-directory:get,set` 存在；`session/cancel` / `session/approve` / `session/close` 不存在 |

CC-2 的审计日志（Studio 侧，最能说明「真的调用了」）：

```json
{"kind":"server.started"}
{"kind":"initialize","clientProtocolVersion":"2025-11-25","clientInfo":{"name":"dsh-mcp-client"}}
{"kind":"tools/list","count":1}
{"kind":"tools/call","name":"get_studio_health"}
{"kind":"tools/call.served","name":"get_studio_health","status":"ok"}
```

**gate 7 由此关闭**：模型不是「说它调用了」，而是 Studio MCP Server 记录了这次调用并返回了真实数据。

---

## 5. DSH 新旧版本能力差异（gate 10）

| 能力 | 0.1.5-rc.2（legacy 基线） | 0.2.1-rc.3（用户实际运行） | 生产是否需要 |
|---|---|---|---|
| Runtime 启动 / 握手 | PASS | PASS | 必须 |
| 真实模型对话（commandcode） | 不可用：插件 0.15.4 要求 0.2.1 线 | **PASS** | 必须 |
| MCP 工具注册 | PASS | PASS | 必须 |
| MCP 工具**实际调用** | BLOCKED（无可用模型） | **PASS** | 必须 |
| Session Resume | **NOT_SUPPORTED**（`already exists`） | **CONFIRMED**（正常关闭；中断中的最后一轮 = `UNKNOWN`，U7） | 强烈需要 |
| 工具审批回调（DSH 原生、可依赖） | `UNKNOWN / NOT_OBSERVED` | `UNKNOWN / NOT_OBSERVED`（协议无审批消息类型，实测未出现 server→client 请求） | 需要 |
| `session/approve` 协议方法 | NOT_SUPPORTED | **NOT_SUPPORTED**（`unknown method`） | 需要 |
| Runtime 级取消 | NOT_SUPPORTED | **NOT_SUPPORTED** | 不假设存在 |
| Session 关闭 | NOT_SUPPORTED | **NOT_SUPPORTED** | — |
| working-directory get/set | 无 | **SUPPORTED** | 有用 |
| 并发 Session | 部分（无模型） | **PASS** | 需要 |
| 进程退出与回收 | 部分（仅直接子进程） | **PASS**（三态 + 孤儿匹配） | 必须 |

未测：0.2.2 线（与用户插件声明不兼容，故未升级）；未升级用户全局 DSH。

---

## 6. 探针判定粒度修正（gate 9）

### 6.1 进程检测：三态化，不再吞异常

`spike/dsh-probe/src/lib/proc.mjs` 重写：

- `PROCESS_PRESENT` / `PROCESS_ABSENT` / `PROCESS_CHECK_FAILED`
- PowerShell 侧用 `try/catch` 包住并返回 `{ok:false,error}`；**非零退出、无法解析、进程表为空**都判 `CHECK_FAILED`
- 只有「查询成功且无匹配」才是 `ABSENT`；`CHECK_FAILED` 一律按测试失败处理
- 匹配不再只靠父子链：Windows 上孤儿会被重挂，故同时用命令行标记（隔离 `DSH_HOME` 路径、MCP server 脚本路径）匹配
- 排除检测程序自身：每次查询带唯一哨兵字符串，避免「自己看见自己」；并排除 `conhost.exe`

> 修正过程中踩了两个坑并已修：① 用 `#` 写哨兵注释，导致整行 PowerShell 被注释掉 → 查询全失败；② 未排除自身 → 每次回收检查都"发现"一个残留 powershell。

### 6.2 探针 C：缩小结论范围

原结论「session 文件存在 = 可恢复」被撤回，改为分项记录：

- 会话文件存在（`session.v3.jsonl.zstd`，压缩后 ~18 KB）
- 文件可解压（首帧为会话头，后续为追加帧）
- 0.1.5：`session/resume` **不存在**，复用 id 报 `already exists` → `NO_RESUME_AT_SDK_LEVEL`
- 0.2.1：`session/resume` 存在且**恢复历史**（CC-3 证明）
- 未验证：中断的最后一轮能否恢复；外部进程（Shell/MCP）能否随会话恢复

### 6.3 探针 D：五条独立断言

| 断言 | 0.1.5 实测 | 0.2.1 |
|---|---|---|
| A 放弃等待后 Runtime 仍存活 | PASS | 未重复测（生命周期已在 CC 套件覆盖） |
| B 放弃瞬间仍为 `running` | 未成立（402 提前 idle） | 未测 |
| C 放弃后产生**新的 assistant 文本** | 否 | 未测 |
| D 关闭后进程树为空 | PASS | PASS（CC-1/2/4） |
| E 无外部进程残留 | PASS | PASS（含 MCP Server） |

明确不再用「事件数增长」当工作证据：402 的重试事件也算事件，但不算产出。

### 6.4 探针 E/F

- E 拆成 stage1（server 起）/ stage2（进清单）/ stage3（模型调用 + Server 执行），**只有 stage3 全真才算完成**。0.1.5 只到 stage2（BLOCKED）；0.2.1 到 stage3（PASS）。
- F 拆成 6 项：session id 不同、通知不串台、各自有事件、双方都有文本、答案未互换、关闭后无残留。0.1.5 前 3 项与第 6 项成立、文本类 BLOCKED；0.2.1 全 6 项 PASS。

### 6.5 门禁 6 的措辞修正（退出码，2026-11-11 已被 CC-6 推翻）

复审指出「CLI 退出码 ≠ SDK 管理进程的退出码」，这一点成立。当时的记录是：

- SDK 的 `HarnessClient` 把 `exitCode` 保留为**私有字段**，`close()` 返回 `Promise<void>`，没有结构化访问器；
- 当时以为能拿到的证据只有 `close()` 耗时与 OS 进程表三态结果（外加异常时的 `TransportClosedError`）；
- 于是门禁描述被改成「**关闭后进程树为空 + close 耗时**」，把「exit code 0 / 1」降级为**启动器级别**观测（探针 G）。

**该规避措辞已于 2026-11-11 作废**：CC-6（`npm run probe:exit`）实测——正常 `close()` → `exitCode = 0`、外部强杀 → `exitCode = 1`，两次均 `PROCESS_ABSENT`（`evidence/cc-6-exitcode/summary.json`）。退出码来自 SDK 公开导出的 `TransportClosedError` message 中的 `exit code: <n>`（`lib/types/client.d.ts` 已文档化），**正常关闭同样可取得**。门禁 6 按原始措辞「关闭后进程确实退出，记录退出码」判定，见 `PHASE_00_R1_EVIDENCE.md` §A7。

---

## 7. 文档一致性整改（gate 1）

（**历史记录，R1 当时的做法**）当时统一为单一事实源，指向 `state/project_state.json` 的 `phase_00.gate_results`。
**当前**的唯一事实源已改为 `state/project_state.json` → `phase_00_final`（见本报告头部「PHASE 00 最终结论」）；
此处旧指针保留仅为追溯，不代表当前状态。

| 文档 | 整改前 | 整改后 |
|---|---|---|
| `docs/review-handoff/PHASE_00_WORK_REPORT.md` | 8 PASS / 2 BLOCKED | 已改为「PHASE 00 历史快照 + 指向 R1 报告」 |
| `docs/phase-reports/PHASE_00_REPORT.md` | 7 PASS / 3 BLOCKED（陈旧） | 重算并标注「0.1.5 基线，已被 R1 部分取代」 |
| `docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md` | 推送 BLOCKED | 改为已推送 + R1 入口 |
| `state/project_state.json` | 混合状态 | 新增 `phase_00_r1` 段，门禁逐条 + 证据路径 |
| `state/memory.json` | 含「无 resume / 无审批」的绝对表述 | 改为带版本号的表述 |
| `memory-bank/handoff.md` | 指向 PHASE 00 | 指向 R1 结论与下一步 |

---

## 8. ADR 修改原因（gate 11 / 12）

### ADR-0001（Electron / Tauri）

| 复审意见 | 处理 |
|---|---|
| 「单进程架构」表述错误 | 删除，改为真实拓扑图：main(含 SDK) → DSH Runtime → MCP Server/Shell；renderer 独立；GPU/utility 独立 |
| 不应贬低 Tauri 的跨进程锁 | 承认「Node sidecar 独占文件/构建/Git 即可保证锁所有权」，改为三处真实差异：运行时数量、失败组合数、打包链数 |
| 需要打包验证 | 新增 §5「PHASE 01 必做 7 条打包冒烟」，作为 Electron 批准的前置条件 |

状态改为 **PROPOSED / CONDITIONAL**。

### ADR-0002（DSH 集成）

| 复审意见 | 处理 |
|---|---|
| Resume 不能写成永久不支持 | §3D 改为「优先官方 resume → 失败再水化」，并给出 6 步恢复流程 |
| 单 Runtime 固化不合理 | §3B 改为 `RuntimeSupervisorManager` + 多 Runtime 拓扑（顾问/执行/QA 分离），并列出 7 条必须满足的约束 |
| 审批双通道要研究新版回调 | §3C 明确 0.2.1 **仍无** server→client 请求；给出无回调时的降级方案（不给工具 / 模型先提案） |
| MCP 生产实现要验证 | §3D 记录：实测协商 MCP `2025-11-25`，PHASE 01 必须换官方 SDK 并冒烟 |

---

## 9. 安全与脱敏（gate 2）

| 检查 | 结果 |
|---|---|
| 仓库可见性 | **public 未改**（未执行任何改可见性/转移/归档操作） |
| Git 历史重写 / 强推 | 未执行 |
| 工作树密钥扫描 | 见 §9.1 |
| 凭据文件 | 仓库内无 `.credentials.yaml`、无真实 `.env`、无 `DSH_HOME` 实体 |
| 证据脱敏 | 新增 `redact()`：把仓库根路径 → `<repo>`、用户目录 → `<user-home>`、主机名 → `<host>`；新证据自动生效，历史证据已批量清洗 |
| 报告中的个人路径 | 全部改为 `<repo>` / `<user-home>` 示例 |

### 9.1 扫描方式与结果

- 正则扫描：`sk-[A-Za-z0-9]{16,}`、`ghp_`、`AKIA`、`PRIVATE KEY`、`COMMANDCODE_API_KEY=<值>` → **0 命中**
- 人工复核命中位置：仅存在**变量名**（`apiKeyEnv: COMMANDCODE_API_KEY`）与文档说明，无值
- 结论：**当前工作树无真实密钥**。历史提交（4 个，均在本阶段）同为无密钥状态；未发现需要吊销凭据的泄露，因此**未执行历史重写**（该动作需用户决策）。

---

## 10. 仍未解决 / 未验证（**R1 当时的历史登记表**）

> 本表保留为历史记录，**不是当前状态**。当时的 `UNTESTED`（U6）不属于本阶段状态集，
> 且各栏缺少后续阶段、风险与验证条件。当前登记表见本报告末尾「PHASE 00 最终验证与移交」
> 及 `state/project_state.json` → `phase_00_final.deferred` / `unknown`。
> 逐项判定「是否阻断 PHASE 00」的结论也写在那一节。

| ID | 项 | 状态 | 说明 |
|---|---|---|---|
| U1 | Electron 打包后的完整链路 | `UNKNOWN` | PHASE 01 冒烟（ADR-0001 §5） |
| U2 | 生产形态的 DSH_HOME 策略 | `UNKNOWN` | 隔离 home 需重装 provider；复用用户 home 则污染其配置。需产品决策 |
| U3 | 多 Runtime 的资源占用 | `UNKNOWN` | 拓扑已定，成本未测 |
| U4 | 崩溃瞬间外部进程（Shell/MCP）是否随之消失 | `UNKNOWN` | 需人为 kill 后观测 |
| U5 | MCP Server 换官方 SDK 的兼容性 | `UNKNOWN` | PHASE 01 冒烟 |
| U6 | 0.2.2 线的取消/审批能力 | `UNTESTED` | 与用户插件声明不兼容，未升级 |
| U7 | 中断的最后一轮能否 resume | `UNKNOWN` | 只验证了「完整轮次后重启仍记得」 |
| U8 | 0.1.5 legacy 套件在本机的稳定复现 | `BLOCKED`（环境） | 本机 NODE_OPTIONS 注入的 safe-delete 安全垫会中止 DSH 的 profile 维护删除，整套 0.1.5 复跑不可稳定完成；权威记录改以冻结快照 `spike/dsh-probe/legacy-0.1.5/evidence/` 为准 |

## 11. 所有 BLOCKED 项

| 项 | 原因 | 解除方式 |
|---|---|---|
| 0.1.5 上的模型类断言（A/D/E/F） | 0.1.5 无法加载 commandcode 0.15.4；回退 DeepSeek 后 402 | 无需解除：0.1.5 已定性为 legacy，生产走 0.2.1 |
| 0.1.5 整套复跑（本机） | NODE_OPTIONS 注入的 safe-delete 安全垫中止 DSH profile 维护删除 | 换一台无该安全垫的机器，或以冻结快照为 0.1.5 记录（已采用） |
| 探针 G 的「干净启动 exit 0」 | 本机注入 `safe-delete` 安全垫，会在 profile 维护时中止进程 | 已在探针内归类为 `BLOCKED / SAFE_DELETE_SHIM`；历史成功值保留 |

---

## 12. 提交与推送

```
分支：    phase/00-feasibility
仓库：    https://github.com/xiaoLin12130/ai_game_studio （public）
提交：    852d234cec16ed75de2a40809be0fc1bd42bb47b（R1 实施提交，已推送）
复现：    cd spike/dsh-probe/current-0.2.1 && node run-all.mjs   # 期望 PASS 5/5, exit 0
          cd spike/dsh-probe && node run-all.mjs                 # legacy 0.1.5 基线
```

---

## 13. 给复审者的三个必答问题

1. **gate 7 是否算真正关闭**？判据是「模型发起调用」+「Studio Server 审计到执行」，而不是模型口头声明。如果要求更强的证据（如工具返回值带不可预测随机数），可以再加一轮。
2. **多 Runtime 拓扑（ADR-0002 §3B）是否接受**？它把「无取消」转化为「隔离」，代价是进程数与内存增加。
3. **生产 DSH_HOME 策略（U2）** 需要产品决定：隔离更干净但用户要重配 provider；复用则要处理「Studio 改动用户日常配置」的风险。

---

# R1.1 修正（回应第二次外部复审，2026-11-10）

复审结论：核心链路认可、保留 `PARTIALLY_VERIFIED`、PHASE 01 有条件放行，但要求先修 5 个问题。
本节逐条说明修了什么、怎么验证。

## R1.1-P1a｜证据脱敏只覆盖了一半

**问题**：`evidence.mjs` 里 `records.jsonl` 走了 `redact()`，但 `writeJson()`（写 `summary.json`）没有，
所以 CC-1/CC-2 的汇总文件仍有本机绝对路径；旧 `PHASE_00_EVIDENCE.md` 也残留主机名。

**修复**：

1. `writeJson()` 改为 `JSON.stringify(redact(value))`，与 JSONL 同一条脱敏路径。
2. `run-all.mjs` 写 `_aggregate/run-all.json` 时同样调用 `redact()`（复审没点出，但同样漏了）。
3. 新增 `src/lib/paths.mjs` 统一解析 DSH home / workspace，便于干净目录复现。
4. 全仓扫描并清洗：仓库根 → `<repo>`、用户目录 → `<user-home>`、主机名 → `<host>`。

**验证**：

```
grep -rI -E "<abs-path>" spike/dsh-probe/current-0.2.1/evidence
→ 无输出
grep -rI "<hostname>" .
→ 无输出
```

仍含绝对路径的两个文件都在 `tmp/` 下（patch 生成物），已被 `.gitignore` 的 `tmp/` 规则排除，未入库。

## R1.1-P1b｜干净环境不可复现

**问题**：`cc-sdk` / `cc-cli` 只存在于作者机器；`package.json` 没声明 commandcode 插件；
`run-all.mjs` 不负责建 profile；旧 README 还在讲 `deepseek-official` + `DEEPSEEK_API_KEY`。

**修复**：

1. 新增 `current-0.2.1/scripts/setup-profiles.mjs`：创建隔离 `DSH_HOME`、生成两个 profile、
   把**钉死版本**的 `@mars-sea/dsh-commandcode-provider@0.15.4` 装进各自 `node_modules`、
   写出两个 patch 文件。幂等，不碰用户 `~/.dsh`。
2. `package.json` 增加 `profilePlugins` 字段声明版本；`npm test` 先跑 setup 再跑探针。
3. `run-all.mjs` 启动时自动调用 setup，并在汇总里记录 profiles / 插件版本 / 凭据是否存在。
4. 探针支持 `CC_DSH_HOME` 覆盖，可在任意干净目录运行。
5. 重写 `spike/dsh-probe/README.md`：区分 0.2.1（生产依据）与 0.1.5（legacy），
   明确 `COMMANDCODE_API_KEY` 只从环境变量读、patch 里只写变量名。

**验证（干净目录，不依赖任何既有 profile）**：

```
node scripts/setup-profiles.mjs --home <空目录>/dsh-home
→ profile.created cc-sdk / cc-cli，plugin.installed 0.15.4 ×2，credential present=true

CC_DSH_HOME=<空目录>/dsh-home node run-all.mjs
→ PASS 5/5，exit 0
```

本次最终证据全部来自这条干净路径。

## R1.1-P1c｜路由断言只覆盖了 CC-1

**问题**：报告称「每个探针都断言 provider/model」，实际 CC-2 只断言 provider、CC-3/CC-4 完全没提。

**修复**：新增 `requestRoute()` / `routeMatches()`（`lib/outcome.mjs`），在**所有会调用模型的探针**中统一使用：

| 探针 | 断言 |
|---|---|
| CC-1 | `routeIsCommandcode` + `modelAsRequested` |
| CC-2 | `routeIsCommandcode` + `modelAsRequested` + `routeMatchesExpected` |
| CC-3 | `routeBothTurnsCommandcode`（两轮都查） |
| CC-4 | `routeBothRunsCommandcode`（两个并发会话都查） |
| CC-5 | **不做模型调用**，只做协议方法探测，报告中已如此标注 |

**验证**：干净环境复跑，四项断言均为 `true`；`summary.json` 中可见
`requestRoute = {provider:"commandcode", model:"deepseek/deepseek-v4.1-flash"}`。

## R1.1-P2a｜Resume 通过，但不是崩溃恢复

**问题**：CC-3 注释写 "kill the runtime"，实际调用的是 `close()`——正常关闭，不是强杀。

**修复（表述，不改成果）**：

1. CC-3 源码注释改为「正常关闭 Runtime 后由新进程 resume」，不再暗示强杀。
2. ADR-0002 能力矩阵该行改为「**部分 PASS**：正常关闭后可恢复；**崩溃恢复未验证**」（**该表述已于 2026-11-11 升级为 CONFIRMED + UNKNOWN（U7）**，见 ADR-0002 §2）。
3. ADR-0002 D4 恢复流程首行标注「正常关闭已实测 / 崩溃未实测」。
4. ADR-0002 §6 新增第 7 条：强杀后的 resume、中断中的最后一轮，列为 PHASE 01 早期可靠性验证项。

**结论不变**：`session/resume` 确实能恢复历史；但「崩溃恢复」仍是 `UNKNOWN`。

## R1.1-P2b｜审批与多 Runtime 的表述收紧

**审批**：复审指出「`session/approve` 不存在」不等于「SDK 没有审批回调」。已核对 0.2.1 的类型声明：

- 协议只有 7 个 client→server 请求 + 4 个 server→client 通知，**没有任何审批类消息类型**；
- 传输层确实暴露通用 `onRequest(handler)`，理论上能接服务端请求；
- 但实测运行期间**服务端一次都没有发起过 server→client 请求**。

因此 ADR-0002 D5 的措辞改为「**没有可依赖的审批回调**」，并保留保守策略：危险工具不暴露给模型、
模型只提案、Studio 审批后由自己的适配器执行。

**多 Runtime**：D3 从「一角色一 Runtime 固定拓扑」改为**动态调度器**——按任务类型申请/归还、
顾问会话可在受限条件下共享、执行任务独立停止边界、按资源预算决定并发上限、用户不参与管理。
ADR 只固定「必须有隔离与停止边界」「用户不参与调度」，并发数量与配额留给 PHASE 01 实测。

## R1.1 复跑结果

```
cd spike/dsh-probe/current-0.2.1
CC_DSH_HOME=<clean>/dsh-home node run-all.mjs

PASS  CC-1-reply       8,395ms
PASS  CC-2-tools       9,393ms
PASS  CC-3-resume     18,591ms
PASS  CC-4-concurrent  7,605ms
PASS  CC-5-capability  4,316ms
PASS 5/5   exit 0
```

## R1.1 之后仍未解决

| 项 | 状态 |
|---|---|
| 崩溃恢复（强杀 → resume） | `UNKNOWN`，PHASE 01 早期验证 |
| 中断中的最后一轮恢复 | `UNKNOWN` |
| 工具审批回调的 UI 映射 | `UNKNOWN / NOT_OBSERVED`（协议无审批消息类型，实测未出现 server→client 请求；「没观测到」不等于「不存在」） |
| 多 Runtime 并发上限与资源成本 | `UNKNOWN` |
| Electron 打包后完整链路 | `UNKNOWN`，PHASE 01 |
| 0.1.5 legacy 套件本机稳定复现 | `BLOCKED`（环境安全垫），以冻结快照为记录 |

---

# R1.2 修正（回应第三次外部复审，2026-11-10）

复审用固定 commit 实际读取文件后指出：四项里有三项只能算 `PARTIALLY_VERIFIED`。
这次不再自我认证，逐条对齐可核实的证据。

## R1.2-1｜证据脱敏（P1a）：真因不是「忘了调」，而是路径形态没被覆盖

**复审发现的实际泄露**：

- `cc-1-reply/records.jsonl` 的 `commandline` 字段仍含 `<drive>:\...` 形式的绝对路径；
- `legacy-0.1.5/evidence/a-basic-run/summary.json` 仍含 `<user-profile>\...` 形式的路径；
- 我上一轮写的验证命令本身是错的（grep 的是斜杠形式，实际是反斜杠；`<hostname>` 也不是真实主机名）。

**真因（两个，都不是「漏调用」）**：

1. **编码**：进程命令行由操作系统按控制台代码页返回，含中文的路径到达时已是乱码，
   与正确的 Unicode 仓库根做字符串替换自然匹配不上。
2. **转义**：JSON 原文里路径前的换行是 `\n` 两个字符，驱动盘字母前一个字符是字母 `n`，
   任何基于词边界的正则都会失效。

**修复**：

1. `redact()` 增加按形态匹配：`<abs-path> `<abs-path>
   （后者专门覆盖被转义前缀破坏边界的情况）；POSIX 家目录路径同样处理。
2. 证据写入三条路径（JSONL / summary.json / 聚合）统一走 `redact()`。
3. 新增 `spike/dsh-probe/scrub-evidence.mjs`：**先解析 JSON/JSONL 再脱敏**（解码后的值才有真实分隔符），
   纯文本按形态脱敏；`--check` 模式只校验，有残留即非零退出。
4. 移除 `cc-0-cli-baseline/stdout.txt`（含模型中间推理原文）。CLI 改为结构化探针
   `probe-cli-baseline.mjs`，只保留：退出码、耗时、随机标识是否回显、是否自述模型名、
   截断后的答案行；**原始流不落盘**。

**验证（可复现，不是自述）**：

```
cd spike/dsh-probe
node scrub-evidence.mjs --check
→ [scrub] scanned=79 rewritten=0 (check only)
→ [scrub] no absolute paths remain
```

`--check` 会先解码 JSON 再匹配，所以转义形态也能识别；返回码非 0 即表示仍有残留。

## R1.2-2｜干净环境复现（P1b）：补三个缺口

| 缺口 | 修复 |
|---|---|
| A 插件传递依赖未固定 | `setup-profiles.mjs` 安装后执行 `npm ls --all --json`，把解析结果写成 `profile-locks/<profile>.deps.json`（含 `sha256` 指纹与完整 `name@version` 列表，随仓库提交）；后续运行比对指纹，漂移时输出 `deps.drift_detected` 而不是静默通过 |
| B 既有 Profile 未核验版本 | 安装前比对实际版本与期望 `0.15.4`，不一致即重装并输出 `plugin.version_mismatch`；profile 的 `dsh.profile.bundles` 也做一致性校验，不一致则重写 |
| C CLI 基准未进自动化 | 新增 `CC-0-cli` 探针并纳入 `run-all.mjs`，现在是 **6 项**；CLI 与 SDK 两条链在同一次运行中一起验证 |

干净目录实测（本轮全部证据来源）：

```
CC_DSH_HOME=<空目录>/dsh-home node run-all.mjs
PASS  CC-0-cli  CC-1-reply  CC-2-tools  CC-3-resume  CC-4-concurrent  CC-5-capability
PASS 6/6   exit 0
```

## R1.2-3｜路由断言（P1c）：改为检查全部请求

复审判定正确：`requestRoute()` 只取第一个 `request/header`。一次带工具调用的轮次会有多个模型请求
（请求 → 工具 → 再请求），只看第一个会漏掉后续 hop 的回退。

**修复**：新增 `requestRoutes()` 与 `allRoutesMatch()`（`lib/outcome.mjs`），断言改为
「至少一个请求，且**每一个**都是 commandcode + 目标模型」。各探针新增
`allRequestsOnExpectedRoute`，并把完整 `routes` 数组写入 summary 便于复核。

| 探针 | 断言 |
|---|---|
| CC-0 | CLI 无 `request/header`，改为断言退出码、标识回显、模型名、无 QUOTA |
| CC-1 | `routeIsCommandcode` + `allRequestsOnExpectedRoute` |
| CC-2 | 同上 + `routeMatchesExpected` + `allRequestsOnExpectedRoute` |
| CC-3 | 两轮各自 `allRoutesMatch` |
| CC-4 | 两个并发会话各自 `allRoutesMatch` |
| CC-5 | 不做模型调用（已标注） |

## R1.2-4｜审批回调的状态分类（P2b）

复审指出状态表把「未观察到」写成 `NOT_SUPPORTED` 不准确。已拆开：

| 能力 | 状态 | 依据 |
|---|---|---|
| `session/approve` 协议方法 | `NOT_SUPPORTED` | `unknown ... method`（CC-5） |
| 0.2.1 中可依赖的 DSH 审批回调 | `UNKNOWN / NOT_OBSERVED` | 协议无审批消息类型；实测未出现 server→client 请求；但「未观察到」≠「不存在」 |
| SDK 通用 `onRequest(handler)` | 存在 | 传输层类型声明 |
| 完整审批请求/响应流程 | `UNVERIFIED` | 无样本可测 |
| Studio 业务审批 | 由 Studio 实现 | 不依赖 DSH 回调 |

策略不变：危险工具不暴露给模型，模型只提案，Studio 审批后由自己的适配器执行。

## R1.2-5｜状态文件与提交基线

- `state/project_state.json` 增加 `r12` 段，并在 `github` 下记录 R1.1 与 R1.2 的 commit。
- 本报告头部同时标注 R1 实施提交与**最新复审提交**，避免新会话误审旧版本。
- 单一事实源仍是 `state/project_state.json`，报告只引用不另立统计。

## R1.2 之后的状态

| 项 | 状态 |
|---|---|
| 公开证据含本机路径 | `FIXED`（`scrub --check` 零残留） |
| 公开证据含模型推理原文 | `FIXED`（原文已删，结构化替代） |
| 干净环境复现 | `CONFIRMED`（6/6，依赖指纹已入库） |
| 全部请求的路由断言 | `FIXED`（`allRequestsOnExpectedRoute` 全 true） |
| 审批回调分类 | `FIXED`（拆为 NOT_SUPPORTED / NOT_OBSERVED / UNVERIFIED） |
| 崩溃恢复、中断轮次、多 Runtime 成本、Electron 打包 | 仍为 `UNKNOWN`，按 ADR 放到 PHASE 01 |

---

# R1.3 修正（回应第四次外部复审，2026-11-10）

复审结论：核心技术链路 CONFIRMED，但 4 项里有 3 项只能算 `PARTIALLY_VERIFIED`。
这一轮不加新功能，只把门禁做实、把旧结论统一。

## R1.3-1｜证据输出（P1a）：三处出口 + 一个失效的扫描器

### A. CLI 的 stderr 仍在保存模型文本

复审准确：删掉 `stdout.txt` 不等于清干净。模型把推理写在**诊断流**里，`stderrTail` 接着它落盘了。

现在 CC-0 **不保存任何自由文本**，只保留：

- 退出码、耗时
- 随机标识是否回显、是否自述模型名
- 截断到 200 字符的答案行
- **失败类别**（`QUOTA` / `AUTH` / `PLUGIN_INCOMPATIBLE` / `PROFILE_BOOT` / `TIMEOUT`），由 stdout **和** stderr 一起判定，但不保存判定依据的原文

实际产物：`cc-0-cli-baseline/summary.json` 的键里已经没有 `stderrTail`，`diagnostics = {kind:null, stdoutBytes:51, stderrBytes:0}`。

### B. 扫描器：范围不对，正则也是错的

两个独立缺陷，都让 `79 files, 0 residual` 这个结论无效：

| 缺陷 | 后果 |
|---|---|
| 只扫 `evidence/` 与 `docs/` 四个目录 | `state/`、`memory-bank/`、`README.md`、源码从未被检查 |
| 正则要求**两个**反斜杠，而解码后是**一个** | 真实路径永远匹配不上，检查必然通过 |

修正：

- 范围改为 `git ls-files --cached --others --exclude-standard` —— 扫**会被发布的那批文件**（本轮 152 个），
  自动排除 `node_modules`、生成的 `dsh-home`、构建产物。
- 判定改为「解析 JSON 后检查字符串值」，并要求路径**至少两级分隔**。
  这一条同时解决两类误报：JSON 转义 `\n` / `\t` 被当成路径分隔符，以及 URL 里的 `https:/`。

**阳性对照（必须有，否则又是空门禁）**：

```
planted  docs/_scrub_selftest/leak.md  →  一个形如 <drive>:\Users\<name>\file.txt 的路径
run      node scrub-evidence.mjs --check
result   LEAKS (1) … exit 1
removed  → 再次运行 exit 0
```

### C. 控制台也脱敏

- `run-all.mjs` 按**行**转发子进程输出，逐行过 `redact()`（按 chunk 脱敏会漏掉跨块的路径）。
- `setup-profiles.mjs` 不再打印绝对路径：仓库内显示 `<probe>/…`，仓库外显示 `<external>/<basename>`；
  `--json` 整份走 `redact()`。

## R1.3-2｜依赖锁（P1b）：从「指纹」换成真 lockfile，漂移即失败

复审指出 `*.deps.json` 不是 lockfile，且漂移只打印不失败。两点都成立。

现在：

```
profile-locks/<profile>/package.json       插件钉版本
profile-locks/<profile>/package-lock.json  真实 npm 锁（lockfileVersion 3，含 integrity）
```

- 安装走 `npm ci`（在 staging 目录），再把解析结果复制进 profile —— 装到什么是锁决定的，不是注册表当天给什么。
- 版本与锁不符 → `DependencyDriftError` → **整轮中止**，退出码 1，并把原因写进 `_aggregate/run-all.json`。
- **实测**：把锁里的版本改成 `0.15.3` 后运行 → 退出码 1，错误信息点名 profile 与两个版本。

关于「只有一个条目」：该插件 `dependencies` 为空，`peerDependencies` 由 profile bundles 提供，
所以它的可安装树确实只有一个包。这是完整的树，不是漏记。

附带发现（环境层）：本机安全垫会让 `fs.cpSync` 与批量 `fs.rmSync` **直接终止进程**（退出 127，无错误信息）。
初始化脚本因此改用手写递归复制，且从不删除目录树；`npm ci` 本身不受影响。

README 已同步：6/6、六个探针、Windows 环境变量写法（PowerShell 与 cmd 各一份）、lockfile 说明。

## R1.3-3｜测试质量：两处误通过

| 问题 | 修正 |
|---|---|
| CC-4 用 `eventSessions.every(...)`，空数组也返回 true | 新增 `notificationsPresentA/B`，先要求非空再比对 |
| CC-0 只用 stderr 判定失败类别 | 改为 stdout + stderr 一起判定；仍不保存文本 |

## R1.3-4｜我自查发现的更严重问题：两条路由断言被注释掉了

复审没有提到，但我在核对 CC-4 源码时发现行内出现 `//n`：

```js
routeBothRunsCommandcode://n      routeMatches(summary.runA.route, …) &&
  routeMatches(summary.runB.route, …),
```

这是早前一次脚本化改写把换行转义写成了字面量 `//n`，于是 `//` 把**第一个** `routeMatches` 变成了注释。
后果很直接：

- CC-4 的 `routeBothRunsCommandcode` 与 `allRequestsOnExpectedRoute` 实际**只检查了 runB**；
- CC-3 的对应两条**只检查了 turn2**。

也就是说，R1.2 报告里「两轮都查」「两个并发会话都查」在当时是**不成立的**。
两个文件已重写，本轮复跑后四条断言均为 true，`summary.json` 里能看到 `turn1Routes`/`turn2Routes`、
`runA.routes`/`runB.routes` 各 1 条记录。

**边界说明**：每次运行只观测到 **1 个** `request/header`（含带工具调用的 CC-2），
所以「覆盖全部请求」目前是「覆盖了 SDK 暴露的全部请求」，
**多跳（工具调用后再次请求）场景尚未观测到**，已列入未验证项。

## R1.3-5｜文档一致性

复审指出新章节写对了、旧结论没改。已统一：

| 位置 | 原值 | 现值 |
|---|---|---|
| 报告 §5 能力矩阵 | 工具审批回调 `NOT_SUPPORTED` | `UNKNOWN / NOT_OBSERVED`（并新增 `session/approve` 一行 = `NOT_SUPPORTED`） |
| 报告「R1.1 之后仍未解决」 | 审批 UI 映射 `NOT_SUPPORTED` | `UNKNOWN / NOT_OBSERVED` |
| ADR-0002 能力矩阵 | 同上 | 同上，两行拆分 |
| ADR-0001 C3 | 「无工具审批回调」 | 「未观察到（UNKNOWN）」 |
| `PHASE_00_REPORT.md` / `PHASE_00_EVIDENCE.md` | 「不存在」 | 「未观察到」 |
| `docs/11` D-016 | `CONFIRMED 没有` | `UNKNOWN / NOT_OBSERVED` |
| `project_state.verified_capability_deltas` | `NOT_SUPPORTED in both` | 拆成 4 项：回调=UNKNOWN、`session/approve`=NOT_SUPPORTED、`onRequest` 钩子=存在、完整流程=UNVERIFIED |

README 也同步到 6/6 与六个探针。

## R1.3 复跑结果（干净目录，不依赖任何既有 profile）

```
node scripts/setup-profiles.mjs --home <空目录>/dsh-home
  → profile.created ×2, lock.verified ×2, plugin.installed ×2

CC_DSH_HOME=<空目录>/dsh-home node run-all.mjs
  PASS  CC-0-cli         6,426ms
  PASS  CC-1-reply       8,426ms
  PASS  CC-2-tools      10,021ms
  PASS  CC-3-resume     20,035ms
  PASS  CC-4-concurrent  6,907ms
  PASS  CC-5-capability  5,310ms
  PASS 6/6   exit 0   （总计 57s）

node scrub-evidence.mjs --check
  → scanned=152  no absolute paths remain  exit 0
```

## R1.3 之后仍未解决

| 项 | 状态 |
|---|---|
| 崩溃恢复（强杀 → resume） | `UNKNOWN` |
| 中断中的最后一轮恢复 | `UNKNOWN` |
| 审批回调完整流程与 UI 映射 | `UNKNOWN / NOT_OBSERVED` |
| 多跳 `request/header`（工具调用后再请求） | `UNKNOWN`（本轮每轮只观测到 1 个） |
| 多 Runtime 并发上限与资源成本 | `UNKNOWN` |
| Electron 打包后完整链路 | `UNKNOWN` |
| 0.2.2 能力 | `UNKNOWN` |
| 0.1.5 legacy 套件本机稳定复现 | `BLOCKED`（环境安全垫） |

---

# R1.4 集中收尾（2026-11-10）

前四轮的共同病灶不是「某个 bug 没修」，而是**修完没有门禁、门禁本身也没被证明能失败**。
本轮按「一次性检查完整链路 → 集中整改 → 反向证明 → 统一口径」执行，不再逐条打补丁。

## R1.4-0｜基线

| 项 | 值 |
|---|---|
| 上轮评审固定基线 | `1985fb010684de4abd2bb6b9ea54cf06360ffc1e` |
| 本轮实际起点 | `e3176bfe850fc0aa7902eff41390d43f2baafdff`（包含上述基线，仅多一个文档回填提交） |
| 本轮交付提交 | `1928fb1628b8dc3ac057fd618936aa601d9267ef` |
| 工作区 | 干净 |

## R1.4-1｜输出脱敏：从「每个出口各自处理」改为「唯一输出层」

**根因**：脱敏写在调用点，而不是写在出口。于是每轮都能找出一个漏掉的出口
（stdout → stderr → `--json` → 子进程转发 → aggregate）。

**修改**：

| 新文件 | 职责 |
|---|---|
| `src/lib/redact.mjs` | 唯一规则源：`redactText` / `redact` / `findLeaks` / `PATH_RULES` |
| `src/lib/safe-output.mjs` | 唯一写出口：`out` / `err` / `jsonOut` / `createForwarder` |
| `src/lib/scrub.mjs` | 唯一扫描实现：CLI、套件门禁、测试三方共用 |

- 探针的 `step()`、`setup` 的普通输出与 `--json`、`run-all` 的子进程转发与 aggregate，全部经由 `safe-output`。
- `evidence.mjs` 只保留「写文件」，且 JSON 与 JSONL 走同一条 `redact`。
- **规则与检测共用一份定义**：以前「写的人」和「查的人」各有一套正则，这就是两次「扫描通过但仍在泄漏」的机制性原因。

**证据**：`evidence/r14/scrub.json`；`npm run scrub` 退出 0。

## R1.4-2｜扫描器：范围、形状、可证伪

| 缺陷 | 修正 |
|---|---|
| 只扫 4 个目录 | 改为 `git ls-files --cached --others --exclude-standard`，扫「会被发布的那批文件」（本轮 167） |
| 正则要求两个反斜杠，解码后是一个 → 永远匹配不上 | 改为先解析 JSON 再匹配字符串值；同时覆盖盘符/正斜杠/UNC |
| 只认已知前缀（仓库根、家目录） | 改为形状识别：盘符 + 两级分隔、系统根、UNC、`/Users /home /root /mnt /tmp /opt /var /private /workspace /srv` |
| JSON 转义 `\n` 被当成路径 | 要求至少两级分隔，纯转义片段不可能构成 |
| URL 被误判 | 后行断言：`https://host/home/x` 里斜杠前是主机名字符，不匹配 |
| 整文件出现 `scrub:allow` 就全豁免 | 只豁免该行；这个 bug 是本轮写测试时自己撞出来的 |

**排除规则（明确列出，而非悄悄跳过）**：`.git`（对象库）、`node_modules`（第三方）、`dist/build/out/coverage`（构建产物）。
在 git 模式下这些本来就被 `.gitignore` 排除，跳过清单只影响无 git 时的退化路径。

**阳性 / 阴性夹具**（`tests/run-tests.mjs`，夹具字符串在运行时拼接，仓库里不含真实路径）：

- 阳性 14 例：盘符、带空格、非 ASCII、正斜杠、UNC、`/mnt`、`/tmp`、`/opt`、`/home`、`/root`、`/workspace`、仓库根、家目录。
- 阴性 12 例：`<repo>` / `<user-home>` / `<host>` / `<abs-path>`、相对路径、两种 URL、`note:` + 反斜杠 n、`10:30`、裸 `C:`、`/api/v1/users`、正则源码。

**边界行为**：空目录 → 报 `scope` 错误并退出 1；文件读失败 → 报 `read` 错误并退出 1；两者都不会被当成「干净」。

## R1.4-3｜脱敏门禁接入主流程

`run-all.mjs` 在探针跑完后**自己**执行扫描（同一份 `scrub.mjs`），并写入 aggregate：

```text
PASS  gate:dependency
PASS  CC-0-cli … CC-5-capability
FAIL  gate:leak  (scanned 168, leaks 1)
PASS 6/6  BLOCKED 0  FAIL 0  GATES PASS/FAIL
OVERALL FAIL      exit 1
```

这就是 R1.4 的反向证明：**六项探针全 PASS，仅因脱敏失败，整体仍判 FAIL、退出码 1**。
记录见 `evidence/r14/negative-leak-gate.json`（植入文件已删除，真实证据未被覆盖——那次运行把 `CC_EVIDENCE_OUT` 指到了临时目录）。

## R1.4-4｜依赖锁定：从「版本号相等」到「字节相等」

**根因**：只比较 `package.json` 里的版本字符串，无法发现 `node_modules` 被改、`integrity` 缺失、或 bundle 配置漂移。

**现在的校验链**（任一不满足即 `DependencyError`，整轮中止）：

1. `profile-locks/<profile>/package.json` 声明的插件版本 == 期望；
2. `package-lock.json` 的 `version` / `integrity` / `resolved` 齐全且版本一致；
3. `tree.json` 的文件数与 sha256 == 实际安装树；
4. 实际安装插件版本 == 锁版本；
5. profile 的 `package.json` 字段级一致（`dependencies` + `dsh.profile.bundles`），不一致则确定性修复；
6. 插件的 `engines.dsh` 范围与实际运行时版本比对（`COMPATIBLE / INCOMPATIBLE / UNKNOWN`）。

**lockfile 缺失策略**：普通运行**直接失败**（`lock-missing`），只有 `npm run lock:update` 才生成。
本轮把「自动补锁后继续跑」这个行为删掉了——那会让「复现成功」变成自我实现。

**五个场景实测**（`tests/run-tests.mjs`，全部在临时目录 + 临时 lock 根上做）：

| 场景 | 期望 | 实际 |
|---|---|---|
| 全新空 `DSH_HOME` | 建两个 profile 并通过 | PASS |
| 已有正确 profile | 不重装、不修复、校验通过 | PASS |
| 已有错误 profile（改 bundle） | 检测并确定性修复 | PASS |
| 已安装文件被改（追加字节） | 检测并修复；再次运行干净 | PASS |
| lockfile 缺失 / 版本漂移 / manifest 漂移 / JSON 损坏 | 分别以 `lock-missing` / `lock-version-mismatch` / `lock-manifest-mismatch` / `lock-invalid` 失败 | PASS |

## R1.4-5｜探针质量

| 问题 | 修正 | 测试 |
|---|---|---|
| CC-0 只按 stderr 归类 | `classifyRun({stdout, stderr})` 抽到 `src/lib/diagnostics.mjs`，两路都看，只留类别 | 6 例：仅 stdout、仅 stderr、两者、插件不兼容优先、健康、无法归类 |
| CC-4 空数组误通过 | `notificationsIsolated()` 先判非空再逐个比对 | 4 例：空、外来 id、混合、正确 |
| 路由只查第一个请求 | `routesAllMatch()` 要求「至少一个，且每一个都对」 | 4 例：空、单条正确、第二跳回退、模型不符 |
| `//n` 注释掉断言（R1.3 自查发现） | CC-3/CC-4 重写；本轮再次核对两处都真实求值 | 复跑后 `routeBothTurnsCommandcode` / `routeBothRunsCommandcode` / `allRequestsOnExpectedRoute` 均 true，summary 内有 `routeShape` |

**诚实边界**：每次运行只观测到 **1 个** `request/header`（含带工具调用的 CC-2），
所以「覆盖全部请求」目前是「覆盖 SDK 暴露的全部请求」；**多跳场景未观测到**，记为 `UNKNOWN`。
`routeShape.multiHopObserved` 会把这件事显式写进证据，而不是靠报告口头声明。

## R1.4-6｜文档与状态统一

| 文件 | 变更 |
|---|---|
| 本报告 | 头部新增「R1.4 当前状态」，历史章节明确标注 |
| `README.md` | 6/6 + 双门禁 + `npm test` + `npm run lock:update` + PowerShell/cmd 两种写法 |
| `spike/dsh-probe/README.md` | 六探针、门禁、lockfile 维护、安全垫三坑 |
| `ADR-0002` | 审批五档分类表；D6 基线改为 `npm test`；锁由 `package-lock + tree.json` 共同定义 |
| `state/project_state.json` | 新增 `phase_00_r1.r14`，顶层 `product_status` / `current_phase` / `phase_status` 同步 |
| `memory-bank/handoff.md` | 重写为 R1.4 状态 + 三坑 |
| `state/memory.json` | 追加本轮技术事实与禁令 |

## R1.4-7｜本轮修改文件

**新增**
`src/lib/redact.mjs`、`src/lib/safe-output.mjs`、`src/lib/scrub.mjs`、`src/lib/diagnostics.mjs`、
`src/lib/assertions.mjs`、`src/lib/gates.mjs`、`tests/run-tests.mjs`、
`profile-locks/<profile>/tree.json`、`evidence/r14/*`

**重写/修改**
`src/lib/evidence.mjs`、`scripts/setup-profiles.mjs`、`run-all.mjs`、`scrub-evidence.mjs`、
`src/probe-cli-baseline.mjs`、`src/probe-cc-concurrent.mjs`、`src/probe-cc-resume.mjs`、`src/probe-cc-tools.mjs`、
`package.json`

## R1.4-8｜验收对照

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 所有输出出口统一脱敏 | CONFIRMED | `safe-output.mjs` 为唯一出口；`tests.json` 阴性 12 例 |
| 2 | 扫描范围明确、阳性/阴性通过 | CONFIRMED | `scrub.json`（167 文件 / 0 泄漏）+ 14 阳性 / 12 阴性 |
| 3 | 泄漏时整体失败 | CONFIRMED | `negative-leak-gate.json`：6/6 PASS 仍 OVERALL FAIL / exit 1 |
| 4 | Profile 依赖可校验（新旧环境） | CONFIRMED | 五场景测试 |
| 5 | Lockfile 缺失/漂移/损坏有明确策略 | CONFIRMED | 四个错误码测试 |
| 6 | 依赖异常影响最终退出码 | CONFIRMED | `gate: dependency failure exits 1` |
| 7 | CLI 错误分类兼容 stdout/stderr | CONFIRMED | 6 例分类测试 |
| 8 | 全部已观测 SDK 请求被检查 | CONFIRMED | 4 例路由测试 + `routeShape` |
| 9 | 并发隔离空/串线不误通过 | CONFIRMED | 4 例隔离测试 |
| 10 | 关键门禁有反向测试 | CONFIRMED | 68 项中 20 项为反向用例 |
| 11 | README/ADR/报告口径一致 | CONFIRMED | 本轮同步 |
| 12 | project_state 与实际一致 | CONFIRMED | `r14` 段 |

## R1.4-9｜仍未解决（冻结，不再本轮扩大）

| 项 | 状态 |
|---|---|
| 强制杀进程后的 session 恢复 | `UNKNOWN` |
| 中断中的最后一轮恢复 | `UNKNOWN` |
| DSH 原生审批回调端到端 | `UNKNOWN / NOT_OBSERVED` |
| 多跳 `request/header` 实际行为 | `UNKNOWN`（未观测到） |
| 多 Runtime 最大并发与成本 | `UNKNOWN` |
| Electron 打包链路 | `UNKNOWN` |
| DSH 0.2.2 及以后能力 | `UNKNOWN` |
| 0.1.5 legacy 套件在本机稳定复现 | `BLOCKED`（环境安全垫） |

## R1.4-10｜当时的结论（已被外部评审修正）

当时写的是「12 项全部 CONFIRMED，具备提交外部评审条件」。**外部复审判定 R1.4 为 `PARTIALLY_VERIFIED`，不认可该结论**，并具体指出：通用输出安全性、全部路径扫描覆盖、依赖锁完整性、文档与状态统一四项只是 `PARTIALLY_VERIFIED`。
上述问题已在 **R1.4.1** 收口，见本报告最后一章。本节保留原话是为了让修正过程可追溯，不作为当前结论。

PHASE 00 是否正式通过由外部评审决定，本报告不代替该结论。

---

# R1.4.1 收尾（2026-11-11，回应第五次外部复审）

外部评审以固定提交 `1928fb1` 为准，判定 `PARTIALLY_VERIFIED`，并要求只做四项小修正、不重跑模型探针。
同时指出一个交付流程问题：**上传的报告与固定提交里的报告不是同一份内容**（前者 SHA 已回填、扫描 167；后者仍留着 SHA 占位符、扫描 163）。
本轮按「先承认版本问题、再一次性收口」执行。

## R1.4.1-0｜交付版本一致性

- 起因：R1.4 把「实施提交」与「SHA 回填 / 数字同步」拆成了多个提交；评审打开实施提交时，看到的是尚未回填的报告。
- 修正：本报告**不再内嵌自身 Commit SHA**（自引用必然导致回填后版本漂移）。交付 SHA 只写进
  `state/project_state.json` 的 `r141.delivery_commit`，由一个纯元数据提交回填；该提交**不修改本报告**。
  因此「R1.4.1 实施提交中的报告」与「分支 HEAD 中的报告」逐字节相同。
- 评审应打开的固定版本：**分支 `phase/00-feasibility` 的 HEAD**（交付消息中给出完整 SHA）。
- 历史数字全部标注为历史；当前数字只出现在本章与头部「R1.4.1 当前状态」表。

## R1.4.1-1｜输出安全（P1）

| 问题 | 修正 | 代码 |
|---|---|---|
| 测试脚本直接 `process.stdout.write`，异常文本未脱敏 | 全部改为 `safe-output.mjs` 的 `out()` | `tests/run-tests.mjs` |
| 失败的运行会覆盖已发布 `evidence/r14/tests.json` | `run-tests.mjs` 默认只写临时目录；`tests/record-tests.mjs` 在**真实退出码为 0** 时才发布 | 两个文件 + `package.json` |
| 规则集只管路径/主机名，无凭据规则 | 新增 7 条凭据规则：OpenAI/GitHub/AWS key、Bearer、JWT、私钥块、`api_key=` 赋值 | `src/lib/redact.mjs` 的 `LEAK_RULES` |

**测试**：7 条凭据正向用例（检测 + 脱敏 + 幂等）、4 条凭据阴性用例（仅变量名、`apiKeyEnv` 间接引用、短前缀、npm integrity）、
1 条「文件中出现凭据 → 扫描器报出规则 id」、1 条「注入失败时已发布证据不变」。
另有一条故障注入接缝 `CC_TEST_FAIL_INJECT=1`，使该反向测试验证的是退出码，而不是日志文字。

**没有发现本次证据实际泄露 API Key**；这一项修的是「代码无法证明能保护凭据」，不是补一个已发生的泄露。

## R1.4.1-2｜路径扫描（P1）

| 问题 | 修正 |
|---|---|
| 普通带空格目录路径（形如盘符 + `Work Folder` + 子目录 + 文件名）零命中：段类 `[^\\\s...]` 排除了所有空格 | `windows-nested` 改为允许空格、只排除反斜杠/换行/JSON 分隔符；保持单条线性重复，避免嵌套量词回溯 |
| 169 个发布文件只扫 167 个：`.gitignore`、`package.json.orig` 被扩展名白名单排除 | **删掉扩展名白名单**，范围=全部发布文件；二进制改由 NUL 字节识别并计入 `skippedBinary` |

修复过程中自查发现两个新缺陷并已修掉：
① 重写时丢了 `findLeaks` 的 `g` 标志，`exec` 永远返回同一匹配导致堆溢出（OOM）；
② `windows-spaced` 首版用了嵌套 `*`，在证据文件上灾难性回溯。两者都由全仓扫描 + 90 项测试覆盖。

**测试**：新增「一般带空格目录」`Work Folder`、深层带空格 `My Projects / AI Game Studio`、
扩展名无关文件、二进制按 NUL 跳过、文件内凭据检测。最终 **173/173** 文件全部被扫描。

## R1.4.1-3｜依赖完整性（P2）

`tree.json` 现在记录 `integrity` 与 `resolved`，`loadLock()` 真正把两者与 `package-lock.json` 逐项比对：

- `tree-integrity-mismatch`：tree 与 lock 的 integrity 不一致（含「staging 缓存命中、但 lock 已被重新解析」）；
- `tree-resolved-mismatch`：`resolved` 不一致；
- `tree-metadata-mismatch`：版本不一致；
- `lock-invalid` / `lock-missing` / `lock-manifest-mismatch` / `lock-version-mismatch`：沿用。

`--update-lock` 改为直接重建基线，不再被它本应满足的一致性检查挡住。

**测试**：4 条新增篡改用例（tree.integrity、tree.resolved、lock.integrity、lock.resolved），
每条断言具体错误码；加上原有五场景与四个错误码，共覆盖 9 种依赖异常。

## R1.4.1-4｜统一数字与状态

以最后一次**真实运行**为准，区分两类证据，避免再出现 163 / 167 / 12:33 / 12:43 混用：

| 记录 | 含义 | 数字 |
|---|---|---|
| `evidence/r14/summary.json`、`_aggregate/run-all.json` | 最后一次完整六探针真实运行（12:43:44Z） | 6/6 PASS，双门禁 PASS，扫描 167，exit 0 |
| `evidence/r14/final-gates.json` | R1.4.1 门禁回归（不跑模型） | 依赖 PASS，脱敏 PASS，扫描 **173/173**，泄漏 0，exit 0 |
| `evidence/r14/tests.json` | R1.4.1 回归测试 | **90/90 PASS**，exit 0 |
| `evidence/r14/README.md` | 逐个说明上述文件的归属与时间 | — |

`state/project_state.json` 的 `r14.tested_at` / `gates.scanned_files` 已从 12:33 / 163 修正为 12:43:44Z / 167（取自真实 aggregate），
新增 `r141` 段记录本轮门禁回归的 173/173 与 90/90；顶层 `product_status`、`current_phase`、`phase_status` 同步。

## R1.4.1-5｜修改文件

**新增** `tests/record-tests.mjs`、`scripts/run-gates.mjs`、`evidence/r14/final-gates.json`、`evidence/r14/README.md`
**修改** `src/lib/redact.mjs`、`src/lib/scrub.mjs`、`scripts/setup-profiles.mjs`（integrity/resolved）、
`tests/run-tests.mjs`、`package.json`、`profile-locks/*/tree.json`、
`README.md`、`spike/dsh-probe/README.md`、本报告、`PHASE_00_REVIEW_HANDOFF.md`、
`state/project_state.json`、`state/memory.json`、`memory-bank/handoff.md`

## R1.4.1-6｜验收对照

| # | 事项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 输出安全：统一出口 + 凭据规则 + 失败不覆盖证据 | CONFIRMED | 90 项测试中的 13 项；`record-tests.mjs` |
| 2 | 路径扫描：一般空格路径 + 全部发布文本文件 | CONFIRMED | 173/173 扫描；带空格与无扩展名阳性用例 |
| 3 | 依赖锁：integrity / resolved 与树指纹一致 | CONFIRMED | 4 条篡改用例返回具体错误码 |
| 4 | 文档、状态、GitHub 版本统一 | CONFIRMED | 头部当前状态表 + `r141` + 本报告不内嵌自身 SHA |
| 5 | 六探针 / MCP / Resume / 并发 / 路由 / CLI 分类 | CONFIRMED（沿用已提交运行证据，**未重跑**） | `evidence/r14/summary.json` |

## R1.4.1-7｜仍未解决（冻结范围，不扩大）

强制崩溃后恢复、中断轮次恢复、DSH 原生审批回调端到端、多跳 `request/header` 实际行为、
多 Runtime 并发上限与成本、Electron 打包链路、DSH 0.2.2 能力、0.1.5 legacy 套件本机稳定复现（环境安全垫 `BLOCKED`）。

## R1.4.1-8｜是否具备提交外部评审条件

具备。本轮四项修正均有源码、反向测试与机器可读证据；六探针结果沿用最后一次真实运行，未以 Mock 或未执行项充当 PASS。
PHASE 00 是否正式通过仍由外部独立评审决定。


---

# PHASE 00 最终验证与移交（2026-11-11）

本节是本轮收尾的**唯一当前结论**。审查基准为固定提交 `6230340071d6618d50d57832f6dff62b8dd8a735`；
工作区当时干净、远端一致，远端报告与本地报告 sha256 相同。

## A. 8 项未解决问题：逐项判定

权威范围来自 `phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md` 的 10 条门禁。
**8 项全部不在该范围内，且都不影响当前已验证的 DSH 核心调用链，因此没有一项需要在进入下一阶段前修复。**

| ID | 问题 | 在 PHASE 00 范围内 | 影响核心链路 | 已验证的替代 | 状态 | 后续阶段 | 实际风险 | 验证条件 |
|---|---|---|---|---|---|---|---|---|
| U1 | Electron 打包链路 | 否（ADR-0001 §5 明列 PHASE 01 冒烟） | 否 | 无，也不影响 SDK 调用 | `DEFERRED` | PHASE 01 | 技术栈仍 `PROPOSED / CONDITIONAL`；打包失败需按 ADR 转 Tauri | 有可安装包并逐条跑完 ADR-0001 §5 |
| U2 | 生产 DSH_HOME 策略 | 否（产品决策） | 否 | 隔离 home 已在探针里验证可用 | `DEFERRED` + 需用户决策 | PHASE 01 前期 | 隔离要重配 provider；复用会改动用户日常 DSH 配置 | 用户选定后实测隔离 home 加载 commandcode 的前置并更新 ADR-0002 |
| U3 | 多 Runtime 资源占用 | 否（成本，非能力） | 否 | CC-4 已证 2 个并发 Session 隔离可用 | `DEFERRED` | PHASE 05（PHASE 01 可取基线） | 未知并发下内存/进程上限，影响调度器设计 | N 个并发 Runtime 的资源曲线 |
| U4 | 崩溃后外部进程回收 | 否；门禁 6 只要求正常关闭后进程退出（已验证） | 部分相关，但已有验证路径 | 进程树回收与退出码均已实测：CC-6 记录正常 close → `exitCode = 0`、强杀 → `exitCode = 1`，两次均 `PROCESS_ABSENT`（`evidence/cc-6-exitcode/summary.json`） | `DEFERRED` | PHASE 01 早期可靠性（ADR-0002 §6#7） | 强杀后可能残留 Shell/MCP 孤儿进程 | 人为 kill Runtime 后观测进程树 |
| U5 | 官方 MCP SDK 兼容性 | 否（U5 明列 PHASE 01 首任务） | 否 | 工具调用链经 DSH 认可的 MCP bridge 已实测；手写 stdio 原型是显式标注的 PHASE 00 临时实现 | `DEFERRED` | PHASE 01 首任务（ADR-0002 §3D） | 手写帧会随 MCP 协议版本漂移，生产网关必须替换 | 官方 SDK server 起得来、工具进清单、能被 DSH 调用 |
| U6 | DSH 0.2.2 取消/审批 | 否（未来版本） | 否 | 无取消能力已由「每任务一 Runtime + 关闭进程」隔离替代（ADR-0002 §3B） | `DEFERRED` + 需用户决定 | 版本升级时 | 无取消 → 依赖进程隔离；不升级不影响本阶段 | 有兼容插件后做取消/审批冒烟 |
| U7 | 中断中最后一轮恢复 | 否；门禁 7 允许「明确标记未测」 | 否 | CC-3 已证完整轮次后正常关闭可 resume | `DEFERRED` | PHASE 01 早期可靠性 | 强杀可能丢失当前轮 | 轮次执行中强杀 → resume → 检查最后一轮 |
| U8 | 0.1.5 legacy 本机复现 | 否（legacy 已冻结） | 否 | 冻结快照 `spike/dsh-probe/legacy-0.1.5/evidence/` 为权威记录 | `BLOCKED`（环境） | 不解除 | 仅影响历史对照；生产目标是 0.2.1-rc.3 | 换一台无 safe-delete 安全垫的机器 |

**没有为了让 UNKNOWN 数量变成 0 而扩大范围**：本轮未测试崩溃恢复、未研究审批机制、未测试 Electron、未升级 DSH、未启动 PHASE 01、未引入任何新技术探索。

## B. 本轮唯一修复：状态权威源不唯一

独立核查发现，全仓有 **3 个互相竞争的「唯一权威」指针**：

| 位置 | 指向 | 问题 |
|---|---|---|
| `docs/phase-reports/PHASE_00_REPORT.md:11` | `phase_00_r1.gate_results` | 其中 `13_automation_and_regression` 仍是 `PARTIALLY_VERIFIED` |
| 本报告 §7（R1 历史章节） | `phase_00.gate_results` | 其中 `real_prompt_with_trackable_result` 与 `studio_readonly_tool_invoked_by_dsh` **仍是 `BLOCKED`**，而这两条核心门禁实际早已 PASS |
| 报告头 / `README.md` / `memory-bank/handoff.md` | `phase_00_r1.r141` | 与上面两个并存 |

即：**报告写 PASS，而被文档声明为权威的状态对象里两条核心门禁还是 BLOCKED**。这属于阶段定义门禁 10「复审交接」范围内的真实缺陷，也是历轮返工的同源问题（多个真相源）。

**修法（最小）**：

1. `state/project_state.json` 新增顶层 `authoritative_source.current_record = "phase_00_final"`，
   并新增唯一当前记录 `phase_00_final`：10 条范围门禁（各带真实证据路径）、`verdict`、
   8 项 `deferred`（各带 `phase` / `risk` / `verify_when`）、3 项 `unknown`（各带
   `why_unknown` / `condition_to_verify`）、HY4 独立验证项、用户决策清单、下一阶段计划。
2. **历史对象一个都没删**：`phase_00`、`phase_00_r1.gate_results`、`r11`…`r141` 全部保留只读，
   并在文档里显式标注为历史快照；顶层 `product_status` / `current_phase` / `phase_status` 同步。
3. 4 处文档指针统一改指 `phase_00_final`，旧指针所在段落标注「历史记录」。
4. 新增可证伪的自动化门禁 `checkProjectState()`（`src/lib/gates.mjs`）：
   检查唯一权威指针、10 条门禁状态与证据文件存在性、DEFERRED/UNKNOWN 字段完整性、
   HY4 不得标成 CONFIRMED 或 blocking、历史记录不得丢失、4 份文档不得再指向旧对象。
   **文档集不完整时直接判失败**，不能靠少给文件蒙混通过。
5. 门禁接入两个入口：`run-all.mjs` 作为**前置门禁**（失败则任何探针都不运行、exit 1），
   `scripts/run-gates.mjs` 作为门禁回归的第三道门；`decideOverall()` 把 state 失败计入整体判定。
6. 顺带修掉同一输出链上的最后一个缺口：`tests/record-tests.mjs` 曾直接转发子进程的原始
   stderr，而未捕获的异常栈里含绝对路径。现已统一走 `safe-output.mjs`，并由静态测试守住。

**负向证明**（都是真实行为/退出码，不是检查日志文字）：

| 用例 | 期望 | 实测 |
|---|---|---|
| 删除 `authoritative_source` | `authority-missing` | PASS |
| 删除 `phase_00_final` | `current-record-missing` | PASS |
| 把一条范围门禁改成 `BLOCKED` | `gate-not-pass` | PASS |
| 门禁证据路径指向不存在文件 | `gate-evidence-missing` | PASS |
| DEFERRED 去掉 `phase` / 标成 `CONFIRMED` | `deferred-incomplete` / `deferred-overclaimed` | PASS |
| UNKNOWN 去掉验证条件 | `unknown-incomplete` | PASS |
| HY4 标成 `CONFIRMED` 或 blocking | `hy4-status` / `hy4-blocking` | PASS |
| 删除历史轮次记录 | `history-lost` | PASS |
| 文档重新声明旧对象为当前权威 | `doc-stale-pointer` | PASS |
| 只提供 1 份文档（靠省略求 PASS） | `doc-set-incomplete` | PASS |
| **真实子进程**：`CC_STATE_FILE` 指向损坏状态后跑 `run-all.mjs` | exit 1、`aggregate.gates.state=FAIL`、`total=0`（零模型调用） | PASS |

## C. HY4 与 WorkBuddy 的边界（独立记录）

- 用户当前通过 **WorkBuddy 免费额度使用 HY4 开发**。这只说明 IDE 侧可用，
  **不能推出 DSH Runtime 已能通过官方接口调用 HY4**。
- PHASE 00 的六探针用的是 `commandcode + deepseek/deepseek-v4.1-flash`，
  **不能当作 HY4 兼容性证据**。
- 目前没有可用的官方免费 DSH→HY4 接入方式，也**没有做过任何直连测试**。
  该项记为 `independent_verification.hy4_dsh_direct.status = UNKNOWN`、`blocking = false`，
  并写明 `why_unknown` 与 `condition_to_verify`。
- 不要求用户更换模型、不要求付费、不使用 WorkBuddy 私有/逆向接口作为产品依赖、
  不为验证 HY4 改动 DSH Runtime 核心架构。若将来有官方接入方式，另立独立验证，不并入本阶段。

## D. 本轮独立验证（真实执行；下表为 2026-11-11 上一轮，r152 结果见本节末尾注）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node --check` 全部改动 `.mjs` | `SYNTAX_OK` | 0 |
| `npm run test:unit`（`tests/record-tests.mjs`） | **107/107 PASS**，其中 17 项为本轮新增 | 0 |
| `npm run gates`（依赖 / 状态 / 脱敏三道门） | PASS / PASS / PASS，`173/173` 发布文件、0 泄漏 | 0 |
| `node scrub-evidence.mjs --check` | `173/173`、0 残留 | 0 |
| `checkProjectState(loadStateCheck(REPO_ROOT))` 只读复核 | `ok=true`（10 门禁 / 8 DEFERRED / 3 UNKNOWN / 4 文档） | — |

**未重跑六项真实模型探针**：本轮改动只涉及状态记录、文档与门禁编排，
没有改动任何 DSH 探针执行逻辑；且 `createEvidence()` 写固定路径，重跑会覆盖
`evidence/cc-*/` 的历史证据。因此六探针结论**明确标注为沿用**
`evidence/r14/summary.json`（`2026-11-10T12:43:44Z`，6/6 PASS, exit 0），
**不是本轮测试结果，也没有被覆盖或伪造重跑**。

> **2026-11-11 后续轮次（r15 → r151 → r152）**：门禁回归与回归测试已重跑并发布到 `spike/dsh-probe/current-0.2.1/evidence/r152/`——回归测试 **156/156 PASS**（`evidence/r152/tests.json`），三道门禁 PASS，扫描文件数见 `evidence/r152/final-gates.json` 的 `scanned`（不在此处写死）。上表数字属于本报告成文时的上一轮，保留原样。

**未覆盖项（不计 PASS）**：DSH 核心调用链的真实模型执行、Session 恢复与工具调用的真实
运行时行为，本轮未重新执行；其断言逻辑（路由、并发隔离、错误分类、整体判定）由单元测试
与故障注入覆盖，真实执行证据沿用上述已提交记录。这正是本阶段结论为
`PARTIALLY_VERIFIED` 而非 `PASS` 的原因之一。

测试防自证检查：所有负向用例都在临时目录（`CC_STATE_FILE` / `CC_EVIDENCE_OUT` /
`CC_LOCK_ROOT` / `CC_DSH_HOME`）中注入故障，断言的是**子进程真实退出码或函数返回值**；
`record-tests.mjs` 只在子进程退出码为 0 时才发布 `tests.json`，失败不覆盖已发布证据。
`REPO_ROOT` 由模块位置解析，门禁读取的确实是本仓库而非其它目录。

## E. 未解决问题分类

- **本阶段阻断项**：无。
- **后续阶段处理项**：U1（PHASE 01 打包冒烟）、U3（PHASE 05 资源）、
  U4 / U5 / U7（PHASE 01 早期可靠性与官方 MCP SDK 冒烟）。
- **需要用户决策**：U2（DSH_HOME 策略）、U6（是否升级 0.2.2）、
  ADR-0001 / ADR-0002 仍为 `PROPOSED / CONDITIONAL` 需正式批准、HY4 官方接入方式（如未来需要）。
- **受环境限制无法验证**：U8（本机 NODE_OPTIONS 注入的 safe-delete 安全垫中止 DSH 0.1.5 profile
  维护删除）；保留冻结快照，不解除、不假装通过。
- **UNKNOWN（说明为何未知 + 验证条件）**：K1 审批回调完整流程（`state.phase_00_final.unknown`）、
  K2 多跳 `request/header`、K3 DSH 0.2.2 能力，以及 HY4 直连；均写明原因与所需条件。

## F. 下一阶段建议

PHASE 00 的技术目标（用官方 DSH SDK 证明最小 AI 调用与受控工具桥接）已经完成。
**下一阶段应是 PHASE 01「应用基础、项目空间与可靠状态」**，而不是继续开 PHASE 00 整改轮次。
首批任务按 `phases/PHASE_01_FOUNDATION_PROJECT_WORKSPACE.md` 与 `phase_00_final.next_phase`：

1. 落地 Windows 本地应用基础，展示**真实** DSH 连接状态（未连接必须显示未连接）。
2. 官方 MCP SDK 兼容性冒烟（U5），把 PHASE 00 的手写 stdio 原型替换为生产实现。
3. Electron 打包冒烟（U1），据结果让 ADR-0001 转正或按 ADR 切 Tauri。
4. 崩溃恢复与中断轮次可靠性（U4 / U7）。
5. 产品决策 DSH_HOME 策略（U2）并更新 ADR-0002。

**前置条件**：外部独立评审确认 PHASE 00。在此之前不进入业务功能开发。

## G. 结论

**`PARTIALLY_VERIFIED`**。

- 冻结范围内 10 条门禁均有证据且为 PASS，本轮唯一真实缺陷（状态权威源）已修复并有负向证明；
- 但最近一次外部独立评审结论是 `PARTIALLY_VERIFIED`，R1.4.1 收尾尚未获得正式复审通过；
- 8 项未解决问题按 `DEFERRED` / `BLOCKED` / `UNKNOWN` 明确登记，**不等于 PASS 也不等于 FAIL**；
- 本轮未重跑真实模型探针，六探针结果属于沿用证据。

按阶段定义「只有门禁全部满足才 PASS」，正式 PASS 由外部独立评审决定，本报告**不自行宣布通过**。
`READY_FOR_EXTERNAL_REVIEW` 只表示本轮收尾完成、材料可交评审。
