# PHASE 00-R1 工作报告（外部复审整改，含 R1.4 收尾）

> 本报告覆盖 PHASE 00 的五轮整改。**当前状态以本节为准；从 §1 起各章为历史记录**，其中的「5/5」指当时的五探针套件，不代表当前规模（R1.3 起为六探针）。
>
> - 仓库：`https://github.com/xiaoLin12130/ai_game_studio`（**保持 Public**，未改可见性）
> - 分支：`phase/00-feasibility`
> - 日期：2026-11-10
> - 提交 SHA：R1.4 复审基线 `1928fb1628b8dc3ac057fd618936aa601d9267ef`；R1.3 `1985fb010684de4abd2bb6b9ea54cf06360ffc1e`；R1.2 `052319aac2b6521b84c48b6f268cffa79f77cd99`；R1.1 `207feac5f8556494877fb478562381b108e953a3`；R1 实施 `852d234cec16ed75de2a40809be0fc1bd42bb47b`

## R1.4 当前状态（唯一权威）

| 项 | 值 |
|---|---|
| 阶段 | PHASE 00-R1.4（集中收尾，不新增技术探索） |
| 基线 | 代码基线 `1985fb0`（上轮评审固定），本轮实际起点 `e3176bf` |
| 探针 | **6/6 PASS**（CC-0 CLI、CC-1 Reply、CC-2 Tools、CC-3 Resume、CC-4 Concurrent、CC-5 Capability） |
| 门禁 | 依赖门禁 **PASS**；脱敏门禁 **PASS**（扫描 167 个文件，泄漏 0） |
| 回归测试 | **68/68 PASS**（含阳性/阴性/反向用例） |
| 套件退出码 | **0**（`OVERALL PASS`） |
| 阶段判定 | `PARTIALLY_VERIFIED` — 本轮要求的工程门禁已建立，冻结范围外能力仍为 `UNKNOWN` |
| 阻塞项 | 无（本轮范围内） |
| 下一步 | 交外部复审；未获明确批准前不进入 PHASE 01 |

权威事实源：`state/project_state.json` → `phase_00_r1.r14`。证据：`spike/dsh-probe/current-0.2.1/evidence/r14/`。

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
SDK 集成测试结果：      PASS（六探针 6/6 + 两个门禁，见 §R1.4）
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

## 4. SDK 集成测试（gate 5 / 6 / 7）

`cd spike/dsh-probe/current-0.2.1 && node run-all.mjs` → **5/5 PASS，退出码 0**

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
| Session Resume | **NOT_SUPPORTED**（`already exists`） | **PASS（恢复历史）** | 强烈需要 |
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

### 6.5 门禁 6 的措辞修正（退出码）

复审指出「CLI 退出码 ≠ SDK 管理进程的退出码」，正确。事实是：

- SDK 的 `HarnessClient` 把 `exitCode` 保留为**私有字段**，正常 `close()` 不返回退出码；
- 能拿到的证据是：`close()` 耗时、OS 进程表三态检测结果、以及（异常时）`TransportClosedError` 携带的退出码；
- 因此门禁描述已改为「**关闭后进程树为空 + close 耗时**」，并把「exit code 0 / 1」标注为**启动器级别**的观测（探针 G），不再声称是 SDK 返回值。

---

## 7. 文档一致性整改（gate 1）

统一为**单一事实源**：`state/project_state.json` 的 `phase_00.gate_results` 是唯一权威；其余文档只引用、不另立统计。

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

## 10. 仍未解决 / 未验证

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
2. ADR-0002 能力矩阵该行改为「**部分 PASS**：正常关闭后可恢复；**崩溃恢复未验证**」。
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

## R1.4-10｜是否具备提交外部评审条件

具备。本轮范围内 12 项验收全部 `CONFIRMED`，六探针与两个门禁可一键复跑（`npm test`）。
PHASE 00 是否正式通过由外部评审决定，本报告不代替该结论。
