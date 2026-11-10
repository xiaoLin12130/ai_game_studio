# AI Game Studio｜开发启动包

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

## 当前状态（PHASE 00 执行后）

| 项 | 值 |
|---|---|
| 阶段 | PHASE 00 — 技术可行性与 DSH 最小垂直切片 |
| 结果 | `PARTIALLY_VERIFIED`（核心链路通过；模型层被账号余额阻断） |
| 分支 | `phase/00-feasibility` |
| 推送 | **未推送**（仓库尚无 remote） |
| 下一阶段 | 未授权。PHASE 01 及之后保持 `BLOCKED_BY_PREVIOUS_REVIEW` |

详细结论见 `docs/phase-reports/PHASE_00_REPORT.md`，复审入口见 `docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md`。

## 如何在本机验证（真实命令）

前提：Node ≥ 22、环境变量 `DEEPSEEK_API_KEY` 可用。

```bash
cd spike/dsh-probe
npm install          # 依赖已精确钉版本，不要改成 ^
node run-all.mjs     # 全部探针；退出码 0=全 PASS，2=有 BLOCKED，1=有 FAIL
```

首次运行可能很慢（需重建 profile 的模块回退，实测 1–2 分钟），这不是卡死。

预期结果（当前账号状态）：

```
BLOCKED A-basic-run      SDK/会话/事件/关闭已验证，模型返回 402
PASS    B-protocol-facts  无 cancel / 无 resume（-32603 unknown method）
PASS    C-resume         sessionId 复用被拒 → NO_RESUME_AT_SDK_LEVEL
BLOCKED D-abandon        进程在放弃等待后仍存活；长 turn 因 402 未成立
BLOCKED E-tools          MCP 握手+工具注册 PASS，模型调用被 402 阻断
BLOCKED F-concurrent     会话隔离 PASS，文本断言被 402 阻断
PASS    G-exit-code      正常关闭 exit 0；陈旧锁导致启动 exit 1
```

账号充值后重跑，A/D/E/F 应转为 PASS。证据落在 `spike/dsh-probe/evidence/`。

## 本阶段产出的文件

- `spike/dsh-probe/` — 7 个探针 + Studio 只读 MCP tool server（`get_studio_health`）
- `docs/phase-reports/PHASE_00_REPORT.md` / `PHASE_00_EVIDENCE.md`
- `docs/decisions/ADR-0001-tech-stack.md` / `ADR-0002-dsh-integration.md`
- `docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md`
- `state/project_state.json` / `state/memory.json` / `memory-bank/handoff.md`
