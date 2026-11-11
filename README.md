# AI Game Studio｜开发启动包

权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

> 版本：0.1.0｜用途：交给 DSH Agent 作为项目总控规则、产品目标、分阶段开发计划和 GitHub 复审约定。

## 这是什么

这不是已经写好的 AI Game Studio 应用程序，而是一套可执行的**项目启动与开发约束包**。它把我们讨论确认的产品方向转成 Agent 能读取、执行、更新和验收的项目资料，避免 Agent 只凭一段长提示词自由发挥。

核心原则：

- **用户管理游戏，Studio 管理研发过程，DSH 负责 AI。**
- 凡是需要模型理解、推理、归纳、生成、判断、规划的工作，统一交给 DSH；Studio 负责确定性业务逻辑、状态、权限、文件、构建、测试和证据。
- 用户可以随时讨论任何想法；正式执行必须遵守需求基线、审批和阶段门禁。
- 先做可验证的最小闭环，再扩展，不允许一开始就建设庞大的通用平台。
- 每完成一个阶段，必须提交 GitHub、生成复审材料并暂停，等待用户完成外部复审后再进入下一阶段。

## 已确认的产品边界

1. 产品定位：AI 游戏研发顾问 + 自动化开发平台。
2. AI Runtime：深度集成 DeepSeek Harness（DSH），不自建第二套模型通信/Agent Runtime。
3. 首个落地目标：Windows 本地单用户工作环境；优先验证 Cocos Creator 3.8.6 + 微信小游戏研发链路。架构保留引擎/平台适配边界，但 MVP 不做多引擎大而全支持。
4. 素材库：全局共享素材库 + 项目专属素材库；支持直接导入项目和导入全局 Inbox。
5. 需求工作方式：自由讨论区、正式研发区、需求变更区三者分离。
6. 需求变更：先分析影响和返工范围，用户审批后才更新正式基线和派生任务。
7. 发布后持续顾问、线上运营监控、数据分析和发布后迭代**不属于本产品范围**。本产品的终点是完成开发、质量验收、生成发布交付包，并由用户自行在微信平台完成最终发布操作。
8. 保留并升级用户已有提示词/项目管理体系：`AGENTS.md`、`docs/`、`memory-bank/`、`state/project_state.json`、`state/memory.json`、任务契约、交接记录和历史经验。

## 开始方式

1. 将本目录解压到一个新的、干净的项目目录。
2. 将整个目录初始化为 Git 仓库，并创建 GitHub 私有仓库（推荐）。不要把 DSH 配置目录、密钥、`.env`、真实用户数据或整个开发环境上传。
3. 在 DSH 中打开该项目目录，将 `START_HERE.md` 全文作为启动提示词发送给 Agent。
4. Agent 只执行当前阶段（首次为 PHASE 00），完成后推送 GitHub 并暂停。
5. 将 GitHub 仓库地址、阶段编号、提交 SHA 和复审报告发给 GPT 复审。复审通过后，再让 Agent 执行下一阶段。

## 文件地图

- `START_HERE.md`：首次启动提示词，直接复制给 DSH。
- `AGENTS.md`：全局开发纪律和不可违反的约束。
- `docs/`：产品定义、用户旅程、架构、DSH、工作流、UI、素材、质量和安全规范。
- `phases/`：PHASE 00–07 阶段任务与验收标准。
- `prompts/`：阶段执行、恢复、需求变更、外部复审提示词。
- `templates/`：任务契约、阶段报告、变更申请、复审交接模板。
- `state/`：机器可读的项目状态文件。
- `memory-bank/`：长期决策、经验教训和跨会话交接。

## 重要提醒

- 这个包是产品目标和开发约束，不是要求 Agent 不经验证就照抄某种技术栈。
- PHASE 00 必须先核验本机实际 DSH 版本、SDK、Node/pnpm、Cocos、微信开发者工具和 GitHub 能力；发现差异必须记录，不得猜 API。
- 不允许跳阶段、不允许用“代码已写”替代“已运行验证”，不允许用模拟 DSH 冒充真实集成。
- 当前阶段完成后，Agent 必须停止推进下一阶段，等待复审结论。

---

## 当前状态（PHASE 00 最终收尾之后）

| 项 | 值 |
|---|---|
| 阶段结论 | **`APPROVED`（PASS）** — 10 条原始验收门禁全部满足并有直接证据；收尾轮集中修复 2 个 P0 后关闭。详见 `docs/review-handoff/PHASE_00_CLOSURE_REPORT.md` |
| 六探针 | **6/6 PASS**（最后一次完整真实运行 `2026-11-10T12:43:44Z`；后续各轮按评审要求未重复模型调用） |
| 门禁 | 依赖 PASS；脱敏 PASS（全部发布文件、0 泄漏）；项目状态一致性 PASS |
| 运行组合 | DSH **0.2.1-rc.3**（桌面端自带）+ **commandcode** 插件 0.15.4 + `deepseek/deepseek-v4.1-flash` |
| 分支 / 仓库 | `phase/00-feasibility`；public（按用户要求保持公开） |
| 未解决事项 | U1–U7 = `DEFERRED`，**U8 = `BLOCKED`（环境限制，不解除）**；8 项均不阻断 PHASE 00。HY4 DSH 直连为独立 `UNKNOWN`，不阻塞 |
| 下一阶段 | 未授权。等外部评审通过后再进入 PHASE 01 |

> 注意：PATH 上的 `dsh` 是 0.1.5-rc.1，**不是**用户日常运行的版本。本项目的验证目标是 0.2.1-rc.3。
> WorkBuddy 免费额度下用 HY4 开发，**不等于** DSH 已经能通过官方接口调用 HY4；此项单列待验证。

**唯一权威事实源**：`state/project_state.json` → **`phase_00_final`**（由 `authoritative_source.current_record` 声明）。
`phase_00`、`phase_00_r1.gate_results`、`r11`…`r141` 均为历史快照，只读保留。
整改报告：`docs/review-handoff/PHASE_00_R1_WORK_REPORT.md`（头部为「PHASE 00 最终结论」，其余为历史）。
证据文件归属见 `spike/dsh-probe/current-0.2.1/evidence/r14/README.md`。

## 如何验证（真实命令）

前提：Node ≥ 22；环境变量 `COMMANDCODE_API_KEY` 可用（由 DSH 的 credential seam 解析）。

### 生产目标组合（0.2.1-rc.3 + commandcode）

Windows PowerShell：

```powershell
cd spike\dsh-probe\current-0.2.1
npm install
$env:COMMANDCODE_API_KEY = "..."
npm test          # 163 项回归测试 + 六探针 + 三道门禁；期望 exit 0
```

只回归受影响的门禁（**不消耗真实模型调用**）：

```powershell
npm run test:unit   # 163 项；只有退出 0 才发布 tests.json（当前发布到 evidence/r153/tests.json）
npm run gates       # 依赖 + 状态一致性 + 脱敏三道门禁，写 final-gates.json
```

Windows `cmd.exe`：

```bat
cd spike\dsh-probe\current-0.2.1
npm install
set COMMANDCODE_API_KEY=...
npm test
```

只想跑套件（跳过回归测试）：

```powershell
node run-all.mjs  # 期望：PASS 6/6，GATES PASS/PASS/PASS，exit 0
npm run probe:exit  # CC-6：Runtime 退出码（close=0 / 强杀=1），不消耗模型额度
```

依赖锁的维护（普通运行**不会**自动生成锁）：

```powershell
npm run lock:update   # 只在有意升级依赖时执行，随后必须重跑 npm test
```

### 0.1.5 legacy 基线（仅作历史对照）

```bash
cd spike/dsh-probe
node run-all.mjs
```

该套件在本机可能整体 BLOCKED：0.1.5 无法加载 commandcode 0.15.4，且本机安全垫会干扰 profile 维护。
详见 `spike/dsh-probe/evidence/README.md`。

## 本阶段产出的文件

- `spike/dsh-probe/` — 7 个探针 + Studio 只读 MCP tool server（`get_studio_health`）
- `docs/phase-reports/PHASE_00_REPORT.md` / `PHASE_00_EVIDENCE.md`
- `docs/decisions/ADR-0001-tech-stack.md` / `ADR-0002-dsh-integration.md`
- `docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md`
- `state/project_state.json` / `state/memory.json` / `memory-bank/handoff.md`
