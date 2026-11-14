# PHASE 02 外部评审请求

> **状态：`PHASE_02_REVIEW_READY`**
> 本文件表示材料已准备好，可以提交外部评审。
> **它不等于 PHASE 02 外部评审 PASS，不等于 PHASE 02 正式关闭，也不代表 PHASE 03 获得启动授权。**

---

## 1. 项目简介与阶段目标

**AI Game Studio** 是一个 Windows 本地单用户应用，帮助独立开发者从一句游戏想法走到可执行的需求基线。
架构原则：**DSH 负责 AI 执行，Studio 负责确定性业务控制**——所有模型推理通过 DSH 完成，业务规则由代码保证。

**PHASE 02 的目标**：让用户用自然语言提出想法，与 DSH 顾问持续讨论，形成研究/设计草稿，
最终由用户亲自确认并冻结正式需求基线；冻结后的修改必须走变更提案。

**本阶段的核心区分**：讨论不是需求。想法、研究、设计草稿、GDD 都是用户可以改变主意的对象；
只有冻结的基线有约束力，且只有用户能冻结它。

---

## 2. 固定仓库与代码基线

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/xiaoLin12130/ai_game_studio` |
| 本地目录 | `H:\AI与开发\ai_game_studio_starter` |
| 分支 | `phase/02-advisor-requirements-baseline` |
| **代码基线 HEAD** | **`3b613f28a9e8a667e3f231b78220ee9f193e97c0`** |
| 基线来源 | PHASE 01-D 最终代码 `ea6c593301595e6909ff0b0a65de859eba41ca05` |

**注意**：本轮工作区有 2 项未提交变更（`state/phase_02.json` 的前置说明修正 + 本评审材料），
尚未提交。评审基线以 `3b613f2` 为准；未提交部分见 `11。

---

## 3. PHASE 02 核心功能清单

| # | 能力 | 源码位置 | 测试位置 | 证据文件 |
|---|---|---|---|---|
| 1 | Advisor 真实对话链路 | `src/main/requirements/advisor.ts` | `scripts/advisor-probe.mjs` | `evidence/phase-02/advisor/advisor-chain.json` |
| 2 | Session 与项目映射 | `requirements/advisor.ts`（`#sessionFor` / `linkSession`） | `test/app-wiring.test.js` | `evidence/phase-02/advisor/advisor-chain.json` |
| 3 | 消息持久化与项目隔离 | `requirements/store.ts` | `test/requirement-store.test.js` | `evidence/phase-02/unit/requirement-store.txt` |
| 4 | 附件（图片/文本/PDF/DOCX） | `requirements/attachments.ts` | `test/docx-extraction.test.js` | `evidence/phase-02-remediation/unit/docx.txt` |
| 5 | 上下文预算与来源记录 | `requirements/context.ts` | `test/requirement-services.test.js` | `evidence/phase-02/unit/requirement-services.txt` |
| 6 | 研究请求与报告 | `requirements/research.ts` + `research-executor.ts` | `test/research-executor.test.js` | `evidence/phase-02-remediation/research/research-chain.json` |
| 7 | 设计草稿与 GDD 版本 | `requirements/store.ts`（`drafts` / `draft_versions`） | `test/requirement-store.test.js` | `evidence/phase-02/unit/requirement-store.txt` |
| 8 | 基线预览/确认/冻结 | `requirements/baseline.ts` | `test/baseline-candidate.test.js` | `evidence/phase-02-remediation/unit/candidate.txt` |
| 9 | 变更提案与影响分析 | `requirements/baseline.ts` | `test/baseline-candidate.test.js` | `evidence/phase-02-remediation/unit/candidate.txt` |
| 10 | SQLite v3 迁移 | `tasks/store.ts`（`MIGRATIONS`） | `test/requirement-store.test.js` | `evidence/phase-02/unit/requirement-store.txt` |
| 11 | UI 实际操作流程 | `src/renderer/requirements-ui.ts` | `scripts/smoke-advisor.mjs` | `evidence/phase-02-remediation/desktop/summary.json` |
| 12 | 真实 DSH Runtime 调用 | `app-wiring.ts` + `runtime/supervisor.ts` | `test/app-wiring.test.js` | `evidence/phase-02/advisor/advisor-chain.json` |

---

## 4. 实现范围与明确不包含

### 4.1 本阶段实现

- 项目级顾问对话（多 Session、消息持久化、项目隔离）
- 上下文编译（预算 24000 字符、来源记录、最新消息优先保留）
- 附件（图片内联、文本直读、PDF/DOCX 本地提取）
- 研究请求与报告（来源只从工具结果生成）
- 设计草稿 / GDD 与版本历史
- 正式需求基线（预览 → 用户确认 → 冻结 → 规范化哈希 → 数据库触发器强制不可覆盖）
- 变更提案（批准 → 候选版本 → 用户确认 → 新基线，`previous_baseline_id` 关联）
- SQLite v3 迁移（11 张新表）+ v4 迁移（候选版本表 + 历史不可变触发器）
- 三栏顾问 UI、草稿页、冻结确认页、变更提案页

### 4.2 明确不包含（DEFERRED）

| 项 | 计划阶段 |
|---|---|
| 完整素材库与素材识别 | PHASE 03 |
| UI 原型设计器 | PHASE 04 |
| 多 Agent 调度 | PHASE 05 |
| 微信构建与真机门禁 | PHASE 06 |
| 发布交付工作流 | PHASE 07 |
| 多人审批、角色权限、云端协作 | 未排期 |
| 自研 Agent Runtime、额外模型供应商路由 | 永久不做 |

---

## 5. 补正前外部评审问题

上一轮外部评审对 PHASE 02 提出五个问题：

| 编号 | 问题 |
|---|---|
| **P1-A** | 生产装配中 `runResearch` 硬编码返回「研究执行器尚未接入。」，研究页面永远无法完成研究 |
| **P1-B** | 批准变更提案只更新状态，没有候选版本流程，无法产生新基线 |
| **P1-C** | `project_state.json` 仍指向 PHASE 00，`phase_status` 把 PHASE 01–07 一律标成 `BLOCKED_BY_PREVIOUS_REVIEW` |
| **P2-A** | DOCX 提取把 ZIP 当 UTF-8 读，标准压缩 DOCX 匹配不到任何内容 |
| **P2-B** | `advisor_messages` 与 `draft_versions` 只有唯一索引，不阻止已有行被 UPDATE/DELETE |

---

## 6. 每个问题的实际修复位置

| 评审问题 | 修复位置 | 测试证据 | 是否解决 |
|---|---|---|---|
| **P1-A** | `requirements/research-executor.ts`（新增 `ResearchExecutor`）<br>`app-wiring.ts`（接入真实执行器） | `test/research-executor.test.js` **15/15**<br>`evidence/phase-02-remediation/research/research-chain.json` **12/12 步** | ✅ **已解决** |
| **P1-B** | `tasks/store.ts` v4 迁移新增 `baseline_candidates`<br>`requirements/baseline.ts` 新增 `createCandidate` / `freezeCandidate` / `candidateDiff` | `test/baseline-candidate.test.js` **19/19** | ✅ **已解决** |
| **P1-C** | `state/project_state.json` 的 `phase_status` 改为直接取自各阶段源文件<br>`test/state-consistency.test.js` 强制校验 | `test/state-consistency.test.js` **9/9** | ✅ **已解决** |
| **P2-A** | `requirements/attachments.ts` 用 `node:zlib` 读 ZIP 中央目录并 inflate `word/document.xml` | `test/docx-extraction.test.js` **10/10**（夹具为 python-docx 生成的真实压缩 DOCX） | ✅ **已解决** |
| **P2-B** | `tasks/store.ts` v4 迁移新增四个不可变触发器 | `test/baseline-candidate.test.js` 中的直接 SQL 测试 | ✅ **已解决** |

### 6.1 补正过程中额外发现并修复的缺陷

| # | 缺陷 | 处理 |
|---|---|---|
| 1 | 研究两阶段在同一 session 上第二轮拿不到回复 | 改为单轮 + 硬性工具预算 |
| 2 | 模型只宣布意图不写正文 | 报告结构改由 Studio 从工具结果组装 |
| 3 | PHASE 00 门禁硬编码 `current_phase === 'PHASE_00'` | 改为校验 PHASE 00 记录仍为 PASS |
| 4 | v4 迁移后 10 项测试版本断言过时 | 更新断言，未放宽校验 |

---

## 7. 测试与证据索引

### 7.1 原始 PHASE 02 测试（补正前，基线 `aca0d0a`）

| 命令 | 结果 | 证据 |
|---|---|---|
| `node --test` | **291/291** | `evidence/phase-02/unit/full-suite.txt` |
| `test/requirement-store.test.js` | **16/16** | `evidence/phase-02/unit/requirement-store.txt` |
| `test/requirement-services.test.js` | **19/19** | `evidence/phase-02/unit/requirement-services.txt` |
| `scripts/advisor-probe.mjs` | **11/11 步** | `evidence/phase-02/advisor/advisor-chain.json` |
| `scripts/smoke-advisor.mjs` | **13/13 检查** | `evidence/phase-02/desktop/summary.json` |

### 7.2 补正阶段新增测试（基线 `aca0d0a` → `3b613f2`）

| 命令 | 结果 | 证据 |
|---|---|---|
| `node --test` | **344/344** | `evidence/phase-02-remediation/unit/full-suite.txt` |
| `test/research-executor.test.js` | **15/15** | `evidence/phase-02-remediation/unit/research.txt` |
| `test/baseline-candidate.test.js` | **19/19** | `evidence/phase-02-remediation/unit/candidate.txt` |
| `test/docx-extraction.test.js` | **10/10** | `evidence/phase-02-remediation/unit/docx.txt` |
| `test/state-consistency.test.js` | **9/9** | `evidence/phase-02-remediation/unit/state.txt` |
| `test/requirement-{store,services}.test.js` | **35/35** | `evidence/phase-02-remediation/unit/requirements.txt` |
| `test/project-*.test.js`（隔离） | **40/40** | `evidence/phase-02-remediation/unit/project-isolation.txt` |
| `scripts/research-probe.mjs` | **12/12 步** | `evidence/phase-02-remediation/research/research-chain.json` |
| `scripts/smoke-advisor.mjs` | **18/18 检查** | `evidence/phase-02-remediation/desktop/summary.json` |

### 7.3 本轮状态修正测试（2026-11-14）

| 命令 | 结果 | 说明 |
|---|---|---|
| `node --test test/state-consistency.test.js` | **9/9** | 修改 `phase_02.json` 前置说明后重跑 |

### 7.4 回归

| 命令 | 结果 | 证据 |
|---|---|---|
| PHASE 00 门禁 | PASS，0 泄漏 | `evidence/phase-02-remediation/regression/phase00-gates.json` |
| PHASE 01-A 冒烟 | 退出码 0 | `evidence/phase-02-remediation/regression/phase01a-ready.txt` |
| PHASE 01-B MCP 握手 | 退出码 0 | `evidence/phase-02-remediation/regression/phase01b-mcp.txt` |
| PHASE 01-C/D 任务与锁 | **57/57** | `evidence/phase-02-remediation/regression/phase01c-d-tasks.txt` |
| PHASE 01-D 项目冒烟 | 退出码 0 | `evidence/phase-02-remediation/regression/phase01d-projects.txt` |

### 7.5 未执行的测试（NOT RUN，不写成 PASS）

| 项 | 原因 |
|---|---|
| 安装包重建与安装后顾问链路 | 本轮未改打包配置 |
| `npm audit` / 静态吊销检查 | 未改依赖树 |
| 微信构建 / 真机 | 与 PHASE 02 无关 |

---

## 8. 关键业务流程

### 8.1 从一句话到冻结基线

```
用户输入一句话
  → AdvisorService.send()（上下文编译 → 租约 → prompt → 事件流）
  → 消息持久化（advisor_messages，只追加）
  → 用户发起研究 → ResearchExecutor（web_search / web_fetch）
  → 来源只从 tool/result 生成（模型正文里的 URL 不算来源）
  → 研究报告保存（research_reports）
  → 用户整理为设计草稿（drafts + draft_versions，每次修改产生新版本）
  → 用户点击「准备冻结新基线」→ BaselineService.preview()
  → 冻结确认页（显示未确认章节、未决问题、与上一版差异、冻结后果）
  → 用户点击「确认冻结」→ BaselineService.freeze()
  → requirement_baselines（规范化哈希 + FROZEN）
```

### 8.2 变更提案闭环

```
用户提出变更 → ChangeProposal（PENDING）
  → 影响分析（章节/草稿/返工/风险/未分析范围）
  → 用户批准（APPROVED）
  → 生成候选版本（baseline_candidates，proposal_id 唯一）
  → 用户查看与当前基线的差异
  → 用户确认 → freezeCandidate() → 新基线（previous_baseline_id 关联旧版）
  → 旧基线字节与哈希不变
```

---

## 9. 数据库迁移与数据完整性证据

### 9.1 迁移链

| 版本 | 内容 |
|---|---|
| v1 | `schema_version`、`tasks`、`task_transitions`、`attempts`、`sessions`、`runtimes`、`verifications`、`events` |
| v2 | `projects`、`project_configs`、`project_events`、`approvals`、`project_locks`；`tasks.project_id` |
| v3 | 需求系统 11 张表（对话/消息/会话链接/上下文快照/附件/草稿/草稿版本/研究请求/研究报告/基线/变更提案） |
| v4 | `baseline_candidates`；4 个历史不可变触发器 |

### 9.2 完整性保障

| 保障 | 实现 | 测试 |
|---|---|---|
| 迁移失败不破坏原库 | `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` | `test/project-store.test.js` 构造失败迁移 |
| 冻结基线不可覆盖 | 数据库触发器 `trg_baseline_frozen_update/delete` | 直接 SQL `UPDATE`/`DELETE` 被拒绝 |
| 消息不可篡改 | `trg_message_immutable_update/delete` | 直接 SQL 测试 |
| 草稿版本不可篡改 | `trg_draft_version_immutable_update/delete` | 直接 SQL 测试 |
| 同一提案不重复生成候选 | `idx_candidate_proposal` 唯一索引 | `CANDIDATE_EXISTS` 测试 |
| 备份恢复校验 | `verifyDatabase`（必需表 + `integrity_check` + `foreign_key_check` + 版本范围） | `test/schema-integrity.test.js` |

---

## 10. 历史阶段状态及未解决事项

**本节如实披露，不包装成已解决。**

| 阶段 | 当前状态 | 说明 |
|---|---|---|
| PHASE 00 | `PASS` | 标签 `phase-00-final` 写明 "closed: APPROVED (PASS)" |
| **PHASE 01-A** | `READY_FOR_EXTERNAL_REVIEW` | **`BLOCKED_BY_CONFLICTING_EVIDENCE`**：`phase_01_b.json` 的 `closure.note` 称 01-A 已获外部 PASS，但 01-A 自身三轮评审均为 `PARTIALLY_VERIFIED`、无 `verdict`、无 `closure`、标签无 approved、工作报告写"不自行宣布关闭" |
| PHASE 01-B | `APPROVED` | 有外部评审记录（`review.reviewer = "external"`） |
| **PHASE 01-C** | `READY_FOR_EXTERNAL_REVIEW` | R7 有 43 项技术验收通过（**自测**），但**无独立外部评审通过记录**；`verdict` 为 `null` |
| PHASE 01-D | `CLOSED_PASS` | 结论来源于**用户转达**的外部评审结果，原始评审记录未存储在仓库 |
| **PHASE 02** | `READY_FOR_EXTERNAL_REVIEW` | **本阶段，等待本次外部评审** |

**本轮未修改 PHASE 01-A/B/C/D 的任何状态。**

---

## 11. 已知限制

| # | 限制 | 影响 |
|---|---|---|
| 1 | 研究来源以搜索结果为主 | `web_fetch` 常被目标站点拦截（403），多数来源标记 `via: search`、正文未抓取；报告如实写明 |
| 2 | PDF 只提取文本层 | 扫描件与复杂版式不支持，`note` 中标注 |
| 3 | DOCX 提取正文文本 | 样式、图片与表格排版丢失 |
| 4 | 无 wire-level cancel | 停止 = 关闭 Runtime（DSH 0.2.1-rc.3 限制） |
| 5 | 影响分析基于关键词匹配 | 不是对变更语义的理解；`notAnalyzed` 明确列出未覆盖范围 |
| 6 | PHASE 01-A / 01-C 状态冲突 | 见 `10，需人工确认 |
| 7 | PHASE 01-D 评审记录不在仓库 | 依赖用户转达，无法自证 |
| 8 | 本轮 2 项变更未提交 | 见 `2 |

---

## 12. 外部评审需要回答的具体问题

请评审方重点判断：

### 12.1 功能真实性

1. 12 项能力是否**真实实现**，而非仅通过 Mock 或脚本模拟？
2. Advisor 与 Research 是否真的调用了 DSH Runtime 与真实模型？证据是否可追溯？
3. 桌面旅程的 18 项检查与 10 张截图，是否足以证明 UI 可操作？

### 12.2 数据一致性

4. 项目隔离是否在所有读写路径上成立（对话/消息/草稿/附件/研究/基线/提案）？
5. v3/v4 迁移是否可能破坏已有数据？迁移失败是否真的回滚？
6. 备份恢复后的数据校验是否足以发现缺表、损坏、外键断裂？

### 12.3 审批与基线安全

7. 冻结基线是否**真的不可覆盖**（数据库触发器是否足够，还是仍可通过其他路径绕过）？
8. 批准变更提案是否**真的不会**自动修改基线？
9. 是否存在"AI 自动批准"或"未经用户确认就冻结"的路径？
10. 同一提案重复应用是否真的不会产生重复版本？

### 12.4 成功状态正确性

11. 是否存在**错误的成功状态**（例如研究失败却标记 COMPLETED、恢复失败却显示成功）？
12. 模型只宣布意图不写正文时，报告是否会被误判为成功？

### 12.5 失败场景覆盖

13. 关键失败场景（模型失败、工具失败、session 冲突、迁移失败、恢复失败）是否都有测试覆盖？
14. 补正是否引入新回归？344/344 与 57/57 是否可信？

### 12.6 阶段关闭判断

15. 当前证据是否足以支持 PHASE 02 正式关闭？
16. PHASE 01-A 与 01-C 的状态冲突是否影响 PHASE 02 的评审结论？

---

## 13. 评审范围

**本次外部评审只针对 PHASE 02。**

不扩大为整个 AI Game Studio 的重新审计。但 PHASE 01-A / 01-C 的状态冲突与 PHASE 01-D 的转达证明方式
作为**背景披露**（见 `10），供评审方判断其对 PHASE 02 结论的影响。

---

## 14. 材料清单

| 文件 | 内容 |
|---|---|
| `docs/review-handoff/PHASE_02_M0_AUDIT.md` | M0 只读审计（含联网能力实测修正） |
| `docs/review-handoff/PHASE_02_IMPLEMENTATION_PLAN.md` | 实施计划 |
| `docs/review-handoff/PHASE_02_REPORT.md` | 阶段实施报告 |
| `docs/review-handoff/PHASE_02_REMEDIATION_AUDIT.md` | 补正盘点 |
| `docs/review-handoff/PHASE_02_REMEDIATION_REPORT.md` | 补正报告 |
| `docs/reviews/PHASE_02_STAGE_STATUS_RECONCILIATION.md` | 阶段状态核验 |
| `evidence/phase-02/` | 原始证据（22 个文件） |
| `evidence/phase-02-remediation/` | 补正证据（26 个文件） |
| `state/phase_02.json` | 阶段状态 |
| `state/project_state.json` | 项目总状态 |

---

## 15. 声明

- 本文件为**新增**，未覆盖任何既有文件。
- 未修改 PHASE 02 业务代码、数据库 schema、UI。
- 未修改 PHASE 01-A/B/C/D 状态。
- 未执行 `git add` / `commit` / `push` / `merge`。
- 未启动 PHASE 03。
- **未宣称 PHASE 02 通过外部评审。**
