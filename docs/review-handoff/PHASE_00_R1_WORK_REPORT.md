# PHASE 00-R1 工作报告（外部复审整改）

> 本报告对应外部复审对 PHASE 00 的整改要求。**结论先行**：PHASE 00 中「模型不可用」的判断是错的——那不是用户模型的问题，而是探针用错了 Provider 且发生静默回退。整改后，用户真实的 **commandcode + deepseek/deepseek-v4.1-flash** 在 **DSH 0.2.1-rc.3** 上完整跑通，包括**模型真实调用 Studio MCP 工具并由 Server 执行**，以及 **session/resume 真正恢复历史**。
>
> - 仓库：`https://github.com/xiaoLin12130/ai_game_studio`（**保持 Public**，未改可见性）
> - 分支：`phase/00-feasibility`
> - 日期：2026-11-10
> - 提交 SHA：见 §12（提交后回填）

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
SDK 集成测试结果：      PASS（5/5 探针）
是否使用真实模型：      是（随机标识回显，无法用桩伪造）
是否发生 Provider 回退：否（每次运行都断言 request/header.config.provider === commandcode）
```

**关于「是否发生 Provider 回退」的说明**：PHASE 00 的探针没有断言路由，导致 DeepSeek 官方 provider 的 402 被误当成「用户模型不可用」。整改后每个探针都读取 `request/header.config` 并断言 provider 与 model，回退会被判成 FAIL 而不是静默通过。

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

输出（`evidence/cc-0-cli-baseline/stdout.txt`）：

```
No tools needed.
验证标识 CC-cli-1794307597；我使用的模型名是 deepseek/deepseek-v4.1-flash。
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
| 工具审批回调 | NOT_SUPPORTED | **NOT_SUPPORTED** | 需要 |
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
提交：    <见本文件提交后的 git log；本报告随整改提单一并入库>
复现：    cd spike/dsh-probe/current-0.2.1 && node run-all.mjs   # 期望 PASS 5/5, exit 0
          cd spike/dsh-probe && node run-all.mjs                 # legacy 0.1.5 基线
```

---

## 13. 给复审者的三个必答问题

1. **gate 7 是否算真正关闭**？判据是「模型发起调用」+「Studio Server 审计到执行」，而不是模型口头声明。如果要求更强的证据（如工具返回值带不可预测随机数），可以再加一轮。
2. **多 Runtime 拓扑（ADR-0002 §3B）是否接受**？它把「无取消」转化为「隔离」，代价是进程数与内存增加。
3. **生产 DSH_HOME 策略（U2）** 需要产品决定：隔离更干净但用户要重配 provider；复用则要处理「Studio 改动用户日常配置」的风险。
