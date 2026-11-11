# External Review Handoff｜PHASE 00 外部复审交接

权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

> **文档范围（2026-11-11 校正）**：本文件正文 §2–§9 是 **DSH 0.1.5（legacy 套件）的历史交接记录**，其中的探针数量、`3/7`、`exit 2`、启动器级退出码、「无 resume」等结论都是 0.1.5 时代的实测结果，保留原样只作追溯。
> **当前生产目标**是 DSH 0.2.1-rc.3（桌面端自带）+ commandcode 0.15.4；当前结论见 `docs/review-handoff/PHASE_00_R1_WORK_REPORT.md` 头部「PHASE 00 最终结论」与 `phase_00_final`。

- Product：AI Game Studio
- Phase：**PHASE 00 — 技术可行性与 DSH 最小垂直切片**
- Repository URL：`https://github.com/xiaoLin12130/ai_game_studio`（public）
- Branch：`phase/00-feasibility`
- Full Commit SHA：**以分支 `phase/00-feasibility` 的 HEAD 为准**（`git rev-parse HEAD`）。
  报告不内嵌自身 SHA，避免出现「评审打开的固定提交」与「交付版本」不一致。
- **唯一事实源**：`state/project_state.json` → **`phase_00_final`**。
- Status：**`PARTIALLY_VERIFIED`** — 冻结范围内 10 条门禁均有证据；正式 PASS 由外部评审决定。
  「模型层被账号余额阻断」是 0.1.5 时期的**错误结论，已推翻**：真实模型链路（commandcode +
  deepseek/deepseek-v4.1-flash）在 DSH 0.2.1-rc.3 上 6/6 PASS。
- 本轮（最终收尾）**未重跑真实模型探针**；六探针结论沿用 `evidence/r14/summary.json`
  （`2026-11-10T12:43:44Z`）。8 项未解决问题**均不阻断** PHASE 00：U1–U7 = `DEFERRED`，**U8 = `BLOCKED`（环境限制，不解除）**；逐项带后续阶段与验证条件。

---

## 1. 本阶段希望评审者重点检查

1. **是否接受 `PARTIALLY_VERIFIED` 这个判定**：10 条范围门禁均有证据，但上一轮外部评审结论仍是
   `PARTIALLY_VERIFIED`、R1.4.1 收尾尚未获正式复审通过、本轮未重跑六项真实模型探针。
2. **8 项未解决问题是否确实不属于 PHASE 00 阻断项**：判据与逐项风险见
   `docs/review-handoff/PHASE_00_R1_WORK_REPORT.md` 末尾「PHASE 00 最终验证与移交」A 节。
3. **状态权威源是否已唯一**：`checkProjectState()` 是否真的能抓住多真相源、旧门禁标 BLOCKED、
   DEFERRED 缺阶段、UNKNOWN 无验证条件、历史记录被删等情况；负向用例是否验证真实退出码。
4. **HY4 边界是否被诚实记录**：WorkBuddy 免费额度下用 HY4 开发 ≠ DSH 已能通过官方接口调用 HY4；
   该项为独立 `UNKNOWN`、不阻塞、不伪造。
5. **ADR-0001 / ADR-0002 仍为 `PROPOSED / CONDITIONAL`**：Electron 打包冒烟与 DSH_HOME 产品决策
   留待 PHASE 01，是否认可这个边界；以及下一阶段应先做哪几项。

## 2. 关键代码路径（0.1.5 legacy）

> 下表是 0.1.5 的探针源码。**当前目标代码**在 `spike/dsh-probe/current-0.2.1/`（CC-0…CC-6；`npm test` / `npm run probe:exit`）。

| 路径 | 作用 |
|---|---|
| `spike/dsh-probe/src/probe-basic.mjs` | A：SDK 启动 → 会话 → Prompt → 事件 → 关闭 |
| `spike/dsh-probe/src/probe-protocol.mjs` | B：协议事实，用真实 JSON-RPC 调用证明 cancel/resume/close 不存在 |
| `spike/dsh-probe/src/probe-resume.mjs` | C：会话持久化与 sessionId 复用行为 |
| `spike/dsh-probe/src/probe-cancel.mjs` | D：放弃等待 ≠ 停止进程 |
| `spike/dsh-probe/src/probe-tools.mjs` | E：MCP 工具桥接（生成 patch + 校验审计日志） |
| `spike/dsh-probe/src/probe-concurrent.mjs` | F：并发会话与事件隔离 |
| `spike/dsh-probe/src/probe-exitcode.mjs` | G：退出码与陈旧锁缺陷复现 |
| `spike/dsh-probe/src/studio-diag.mjs` | 最小诊断壳（CLI）：展示连接/版本/会话/事件/错误/回收 |
| `spike/dsh-probe/mcp/studio-mcp-server.mjs` | Studio 只读 MCP tool server（仅 `get_studio_health`） |
| `spike/dsh-probe/src/lib/outcome.mjs` | PASS / BLOCKED / FAIL 三态判定与退出码语义 |
| `spike/dsh-probe/src/lib/proc.mjs` | OS 进程探测 + `clearStaleProfileLock()` 参考实现 |
| `spike/dsh-probe/run-all.mjs` | 汇总运行器（含单探针超时保护） |

## 3. 关键产品行为（本阶段实际具备的）

- 能通过官方 SDK 启动真实 DSH Runtime，并在关闭后确认 OS 进程消失。
- 能建立会话、发送 Prompt、收到 15 条结构化事件与 `running → idle` 状态变化。
- 能把 Studio 的只读业务信息（`get_studio_health`）注册进模型的工具清单。
- 能在崩溃残留锁的情况下识别并自愈启动失败。

**0.1.5 历史结论（已过时，勿作当前口径）**：0.1.5 上运行中取消、会话恢复、工具审批回调均不可用。

**当前（DSH 0.2.1-rc.3）五类能力必须分开看**：

- 正常关闭后 Session Resume = **CONFIRMED**（CC-3：新进程 resume 后答出随机口令，`evidence/cc-3-resume/summary.json`）
- 中断中的最后一轮恢复 = **UNKNOWN**（U7，`DEFERRED` 到 PHASE 01）
- DSH 原生审批回调 = **UNKNOWN / NOT_OBSERVED**（「未观察到」≠「不存在」）
- `session/approve` = **NOT_SUPPORTED**（`-32603 unknown ... method`）
- Runtime 级取消 `session/cancel` = **NOT_SUPPORTED**（同上）

## 4. 测试/构建命令与结果（0.1.5 legacy 快照）

> **当前生产目标的命令**：`cd spike/dsh-probe/current-0.2.1 && npm test`（六探针 6/6 PASS，最后一次完整真实运行 `2026-11-10T12:43:44.987Z`，本轮未重跑；门禁回归与测试结果见 `evidence/r153/final-gates.json`、`evidence/r153/tests.json`）。
> 以下代码块是 0.1.5 的原始命令与输出，保留原样。

```bash
cd spike/dsh-probe
npm install            # exit 0（需按 package.json 精确 pin；直接装 latest 会 ERESOLVE）
node run-all.mjs       # exit 2
```

最终一次完整运行（控制台原文：`spike/dsh-probe/evidence/_aggregate/run-all-console.txt`）：

```
BLOCKED A-basic-run      (exit 3, 118998ms)
PASS    B-protocol-facts (exit 0, 2554ms)
PASS    C-resume         (exit 0, 5910ms)
BLOCKED D-abandon        (exit 3, 8640ms)
BLOCKED E-tools          (exit 3, 3639ms)
BLOCKED F-concurrent     (exit 3, 3322ms)
PASS    G-exit-code      (exit 0, 130313ms)

PASS 3/7  BLOCKED 4  FAIL 0
```

退出码约定：`0` 全 PASS；`2` 存在 BLOCKED；`1` 存在 FAIL。**当前为 2，不是 0。**

另有独立验证（非探针，0.1.5 / PATH 旧版观测）：

```bash
dsh --version                                    # 0.1.5-rc.1
dsh --profile sdk --help                          # exit 0，SDK stdio 服务可用
dsh --profile headless "Reply with ... PONG"      # dsh: QUOTA: Insufficient Balance  ← 证明阻塞来自账号而非集成
printf '' | DSH_HOME=<隔离> dsh --profile sdk     # exit 0（干净关闭）
```

## 5. 证据文件

- `docs/phase-reports/PHASE_00_EVIDENCE.md` — 环境清单 + 逐项测量 + 原始输出
- `spike/dsh-probe/evidence/*/summary.json` — 每个探针的断言与判定
- `spike/dsh-probe/evidence/a-basic-run/events.json`、`timeline.json` — 真实事件流
- `spike/dsh-probe/evidence/e-tools/audit-records.json` — DSH 连入 Studio MCP server 的审计记录
- `spike/dsh-probe/evidence/g-exit-code/summary.json` — 退出码与陈旧锁复现
- `spike/dsh-probe/evidence/_aggregate/run-all.json`、`run-all-console.txt` — 整轮汇总

## 6. 已验证事实（0.1.5 历史；带「当前」标注的行已在 0.2.1-rc.3 上修订）

| 事实 | 证据 |
|---|---|
| `@deepseek-ai/dsh-sdk-client@0.1.5-rc.2` 可驱动 `dsh@0.1.5-rc.2` | 探针 A/B，`serverInfo = deepseek-harness-sdk-runtime 0.0.1` |
| 启动耗时为双峰：热 2.2–2.6 s / 重建模块回退 73–128 s | 探针 A、G 多次 |
| 关闭后进程真实退出；干净退出码 0，失败启动退出码 1 | 探针 A/D/G + OS 进程表 |
| 协议只有 initialize / session/prompt / shutdown | 协议类型定义 + 探针 B |
| 0.1.5：无 cancel、无 resume、无 session-close | 探针 B：`-32603 unknown ... method`。**当前 0.2.1-rc.3**：`session/cancel` / `session/approve` / `session/close` 仍 `NOT_SUPPORTED`；`session/resume` 存在，正常关闭后 **CONFIRMED**（CC-3） |
| 0.1.5：sessionId 复用被拒 → `NO_RESUME_AT_SDK_LEVEL` | 探针 C。**当前 0.2.1-rc.3**：用 `session/resume` 恢复历史；「不存在的 session 被拒」是负对照，与 0.1.5「复用已存在 id 被拒」不是同一件事 |
| 工具桥接只能走 MCP；`insert:` 包裹是 `--patch` 的硬要求 | 探针 E + `patch: entry "studio-mcp" not found` |
| Studio 工具确实进入模型工具清单（26 个中之一） | 探针 E `request/header` |
| 单 Runtime 可并行两 session，事件不串台 | 探针 F |
| 依赖必须整族精确钉版本 | `ERESOLVE` 与 `ERR_MODULE_NOT_FOUND` 两次实测 |

## 7. 推荐但未验证（RECOMMENDED / NOT_VERIFIED）

- ADR-0001 推荐 Electron —— 未做打包验证。
- 上下文再水化替代 session 恢复 —— 未做原型验证，成本未量化。
- 安装期预热 profile 可消除 2 分钟首启动 —— 未验证。
- `sdk-minimal` profile 更小攻击面 —— 未验证能否挂 MCP。
- 生产用 `@modelcontextprotocol/sdk` 替换手写 MCP server —— 未实施。

## 8. 阻塞事项（BLOCKED）

| 编号 | 阻塞 | 需要谁做 | 解除后能看到什么 |
|---|---|---|---|
| B-001 | DeepSeek 账号余额不足（HTTP 402 `QUOTA`） | 用户充值或提供有余额的 `DEEPSEEK_API_KEY` | 门禁 3、5 转 PASS；A/D/E/F 从 BLOCKED 转 PASS |
| ~~B-002~~ | ~~仓库无 remote / 网络不通~~ **已解除** | — | 叠加原因：git 未走本机代理 `127.0.0.1:7890`，且本机凭据属于 `vJackLin2v` 而仓库属主是 `xiaoLin12130`。已按仓库级指定代理与账号（未改全局配置），于 2026-11-10 18:13 推送成功 |

> **历史状态（2026-11-11 校正）**：B-001 已解除——改用用户真实 provider（commandcode）+ DSH 0.2.1-rc.3 后，六探针 6/6 PASS；0.1.5 的 402 是运行时回退到 `deepseek-official` 的产物（详见 R1 报告 §3 与 ADR-0002 F6）。B-002 已于 2026-11-10 18:13 推送成功。

（0.1.5 历史）解除 B-001 后执行 `cd spike/dsh-probe && node run-all.mjs`，期望退出码 `0`。

## 9. 已知偏离/风险

| 项 | 说明 |
|---|---|
| 全局 `dsh` 落后 | 本机 0.1.5-rc.1，npm `latest` 已 0.2.2-rc.1。所有结论绑定 0.1.5 线；升级须重跑探针 |
| 文档与实现不一致 | 未知方法返回 `-32603` 而非文档所称 `-32601`；已在代码里改用消息文本判定 |
| MCP server 为手写实现 | 为免依赖；生产需替换为官方 SDK |
| 探针 G 曾有错误结论 | 首版未强制走 heal 路径，误判「伪造死锁不阻塞」；已修正为全新 home 强制 heal 后才成立，并写入 EVIDENCE §2.4 备注 |
| 探针 A/D 的「仍有产出」不可采信 | 402 下事件继续到达来自失败重试，故 D 判定 BLOCKED 而非 PASS |

## 10. 需要用户/评审者决定

1. 是否批准 ADR-0001（Electron）与「数据库延后到 PHASE 01」。
2. 是否接受 ADR-0002 的四个能力缺口处理方式。
3. 生产 `DSH_HOME` 隔离粒度：每项目隔离 vs 复用 `~/.dsh`。
4. ~~是否先充值解除 B-001~~（B-001 已解除，见 §8 注）；复审顺序按 §11。

## 11. 下一阶段是否允许启动

**NO — 等待明确外部复审结论。**

当前状态 `PARTIALLY_VERIFIED`，按 `phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md` 的结束状态约定，本阶段不得标记 PASS，也不得进入 PHASE 01。

---

## 提交信息（PHASE 00 最终收尾）

- 外部评审固定的 R1.4 提交：`1928fb1628b8dc3ac057fd618936aa601d9267ef`
- **本轮审查基准（固定 Commit）**：`6230340071d6618d50d57832f6dff62b8dd8a735`
- **本次交付提交**：分支 `phase/00-feasibility` 的 HEAD（`git rev-parse HEAD`）。
  报告不内嵌自身 SHA；当前状态见 `state/project_state.json` → `phase_00_final`。
- 分支：`phase/00-feasibility`
- 工作区状态：干净（`git status --porcelain` 为空）
- 远端状态：**已推送**
- 提交序列（节选）：
  - `91a44d8` PHASE 00 实施 ｜ `852d234` R1 实施（commandcode 实测）
  - `207feac` R1.1 ｜ `052319a` R1.2 ｜ `1985fb0` R1.3
  - `1928fb1` R1.4 实施 ｜ `855e876` SHA 回填 ｜ `0b9bc28` 文档同步
  - `7ba76e0` R1.4.1 实施 ｜ `6230340` R1.4.1 SHA 回填（被本轮评审固定）
  - 本轮：PHASE 00 最终收尾实施提交（状态权威源、门禁、文档同步）

克隆与复现（**跑生产目标那一套，不是 legacy**）：

```bash
git clone -b phase/00-feasibility https://github.com/xiaoLin12130/ai_game_studio.git
cd ai_game_studio/spike/dsh-probe/current-0.2.1
npm install
npm test          # 163 项回归测试 → 六探针 → 三道门禁（消耗真实模型调用）；门禁回归结果见 evidence/r153/
npm run gates     # 只跑依赖 / 状态一致性 / 脱敏门禁，不消耗模型调用
```

脱敏门禁：

```bash
cd spike/dsh-probe
node scrub-evidence.mjs --check   # 有残留 / 扫描失败 / 扫不到文件 → 退出 1
```

> 仓库为 public，评审方可只读 clone。若后续改为 private，需另行提供 ZIP 或访问授权。
