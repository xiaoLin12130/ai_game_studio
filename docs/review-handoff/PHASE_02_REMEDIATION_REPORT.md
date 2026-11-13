# PHASE 02 补正报告

> **状态：`READY_FOR_EXTERNAL_REVIEW`。** 本报告不宣告通过。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `phase/02-advisor-requirements-baseline` |
| 补正基线 | `aca0d0aed80b8cb414c4a9882b9d42ead5c1ee79` |
| 盘点 | `docs/review-handoff/PHASE_02_REMEDIATION_AUDIT.md` |

## 2. P1-A：接通真实研究执行器

### 2.1 原状

`app-wiring.ts` 里 `runResearch` 是硬编码失败：`'研究执行器尚未接入。'`。研究页面永远无法完成研究。

### 2.2 修复

新增 `requirements/research-executor.ts`，复用现有 `RuntimeSupervisor` 与 Session 机制，不新增模型通信层。

**来源只从工具结果生成。** `sourcesFromToolTraffic()` 遍历 `tool/call` 与 `tool/result` 事件：

- `web_fetch` 成功返回内容 → `via: 'fetch'`、`verified: true`、`status: 'ok'`
- `web_fetch` 失败 → `verified: false`、`status: 'failed'`，note 记录失败原因
- `web_search` 返回的 URL → `via: 'search'`、`verified: true`，note 写明"正文未抓取"
- 模型在正文里写的 URL → **不产生任何来源**

**没有工具调用即判失败。** 模型凭记忆作答不构成研究，返回 `'模型没有调用任何检索工具，本次研究没有可验证来源。'`。

**报告结构由 Studio 组装。** 模型只提供正文；五个章节（已验证事实／未验证信息／合理推测／AI 建议／需要用户决定）由 `assembleReport()` 保证存在。模型没写到的章节明确标注"没有单独列出"，而不是静默省略。

### 2.3 真实链路（12/12 步）

`evidence/phase-02-remediation/research/research-chain.json`：

- 请求创建 → `REQUESTED`
- 真实执行 → 模型调用 `web_search`，返回 16 条真实来源
- 每条来源带 `url`、`fetchedAt`、`via`、`verified`、`status`
- 报告保存、可从项目重新加载、项目隔离、重复执行不崩溃

**已知限制**：`web_fetch` 常被目标站点拦截（403），因此多数来源是 `via: 'search'`、正文未抓取。报告里如实写明"抓取正文 0 条、搜索结果 16 条"。

## 3. P1-B：变更批准后的新版本流程

### 3.1 原状

批准提案只更新 `change_proposals.status`，没有任何路径把它变成新基线。

### 3.2 修复

v4 迁移新增 `baseline_candidates` 表，`proposal_id` 唯一索引。

流程：**批准 → 生成候选 → 用户查看差异 → 用户确认 → 新基线**。

| 规则 | 强制点 |
|---|---|
| 批准不等于冻结 | `createCandidate()` 只写候选，不碰基线 |
| 只有已批准能生成候选 | `CANDIDATE_NOT_ALLOWED` |
| 同一提案只生成一个候选 | 唯一索引 + `CANDIDATE_EXISTS` |
| 候选不能重复冻结 | `CANDIDATE_ALREADY_FROZEN` |
| 冻结需用户确认 | `BASELINE_NOT_CONFIRMED` |
| 旧基线不变 | 数据库触发器 + 测试直接 SQL 验证 |
| 新版本可追溯 | `previous_baseline_id` |

### 3.3 UI 六种状态

`proposalStage()` 区分：待审批 / 已批准尚未生成候选 / 候选版本待确认 / 已冻结为新基线 / 已拒绝 / 需要修改。

桌面截图 `08-candidate-ready.png` 显示"候选版本待确认"且基线仍是 v1；`09-new-baseline.png` 显示 v1 与 v2 并存、哈希不同、提案标记"已冻结为新基线"。

## 4. P1-C：全局状态一致性

### 4.1 原状

`project_state.json` 的 `current_phase` 是 `PHASE_00`，`github.current_branch` 是 `phase/00-feasibility`，`phase_status` 把 PHASE 01–07 一律标成 `BLOCKED_BY_PREVIOUS_REVIEW`。

### 4.2 修复

`phase_status` 的值**直接取自各 `state/phase_0X_*.json` 的 `status` 字段**，不由本文件另行判断。测试 `state-consistency.test.js` 逐项比对，防止再次漂移。

PHASE 01-D 记为 `CLOSED_PASS`，`verdict` 为 `APPROVED_BY_EXTERNAL_REVIEW`，`closure.attestation` 写明：

> 外部评审通过结论由项目负责人转达；评审记录不在本仓库内。

**没有伪造评审记录。** 仓库内不存在任何外部评审文件，因此只记录结论来源，不编造证据。

### 4.3 一个必须说明的发现

`phase_01_a.json` 与 `phase_01_c.json` 仍记录为 `READY_FOR_EXTERNAL_REVIEW`，不是已关闭。本轮**没有**改写它们——它们属于已关闭阶段的历史记录。`phase_status` 如实反映这一点。

### 4.4 门禁的一处必要修改

PHASE 00 门禁硬编码 `current_phase === 'PHASE_00'`，后续阶段无法通过。改为：校验 `current_phase` 是已知阶段，且 `phase_00_final.verdict` 仍为 `PASS`。PHASE 00 的记录完整性检查一条未减。

## 5. P2-A：DOCX 提取

### 5.1 原状

把 DOCX（一个 ZIP）当 UTF-8 读，再用正则找 `<w:t>`。ZIP 正文是 deflate 压缩的，标准 DOCX 匹配不到任何内容。

### 5.2 修复

用 Node 自带的 `node:zlib`，**不新增依赖**：

1. 从尾部找 ZIP 的 end-of-central-directory 记录
2. 遍历中央目录找到 `word/document.xml`
3. 按 method 处理：0 = stored 直接读，8 = deflate 用 `inflateRawSync`
4. 解析 XML：`<w:t>` 取文本，`</w:p>` 转换行，`<w:tab/>` 转制表符
5. 解码 XML 实体（含数字与十六进制形式）

### 5.3 真实夹具

`test/fixtures/sample.docx` 由 python-docx 生成，36.9 KB，标准压缩。测试里有一条专门断言"把 ZIP 当 UTF-8 读找不到 `<w:t>`"，钉住修复的必要性。

**PDF 限制**：只提取文本层；扫描件与复杂版式不支持，`note` 里写明"PDF 文本层提取，版式与图片丢失"。提取不到文本时**拒绝**而不是存成空附件。

## 6. P2-B：历史保护

### 6.1 原状

`advisor_messages` 与 `draft_versions` 只有唯一索引。唯一索引保证 `seq` 与 `version` 不重复，**不阻止已有行被 UPDATE 或 DELETE**。

### 6.2 修复

v4 新增四个触发器：`trg_message_immutable_update/delete`、`trg_draft_version_immutable_update/delete`。

测试直接对数据库执行 `UPDATE` 与 `DELETE`，验证都被拒绝，且原值不变。正常编辑路径（追加新版本）不受影响，有单独测试覆盖。

## 7. 测试结果

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test` | 0 | **344/344** | `unit/full-suite.txt` |
| 研究服务与来源溯源 | 0 | **15/15** | `unit/research.txt` |
| 候选版本与历史不可变 | 0 | **19/19** | `unit/candidate.txt` |
| DOCX 真实文件解析 | 0 | **10/10** | `unit/docx.txt` |
| 全局状态一致性 | 0 | **9/9** | `unit/state.txt` |
| 需求存储与服务 | 0 | **35/35** | `unit/requirements.txt` |
| 项目隔离 | 0 | **40/40** | `unit/project-isolation.txt` |
| 真实研究链路 | 0 | **12/12 步** | `research/research-chain.json` |
| 桌面旅程 | 0 | **18/18 检查** | `evidence/phase-02-remediation/desktop/summary.json` |
| PHASE 01-C/D 任务与锁 | 0 | **57/57** | `regression/phase01c-d-tasks.txt` |
| PHASE 01-A 冒烟 | 0 | — | `regression/phase01a-ready.txt` |
| PHASE 01-B MCP 握手 | 0 | — | `regression/phase01b-mcp.txt` |
| PHASE 01-D 项目冒烟 | 0 | — | `regression/phase01d-projects.txt` |
| PHASE 00 门禁 | 0 | PASS，0 泄漏 | `regression/phase00-gates.json` |

## 8. 修复过程中发现的缺陷

| # | 缺陷 | 处理 |
|---|---|---|
| 1 | 研究两阶段在同一 session 上第二轮拿不到回复 | 改为单轮 + 硬性工具预算 |
| 2 | 模型只宣布意图不写正文 | 报告结构改由 Studio 从工具结果组装 |
| 3 | PHASE 00 门禁硬编码 `current_phase === 'PHASE_00'` | 改为校验 PHASE 00 记录仍为 PASS |
| 4 | v4 迁移后 10 项测试的版本断言过时 | 更新断言，未放宽校验 |

## 9. 未做

| 类型 | 内容 |
|---|---|
| NOT_RUN | 安装包重建与安装后研究链路；`npm audit` / 静态吊销检查 |
| DEFERRED | 素材库（PHASE 03）、UI 原型设计器（PHASE 04）、多 Agent 调度（PHASE 05）、多人审批（未排期） |
| UNKNOWN | 无新增 |
| BLOCKED | 无 |

## 10. 历史保护

PHASE 00 / 01-A / 01-B / 01-C / 01-D 及其三轮补正的证据、状态与 `spike/` 历史材料未被修改
（回归时被脚本覆写的已还原，diff 为空）。

`spike/dsh-probe/current-0.2.1/src/lib/gates.mjs` 有一处必要修改：PHASE 00 门禁的阶段断言，
理由见 `4.4`。PHASE 00 的记录完整性检查未减少。

## 11. 结论

五个问题均已修复并有真实链路证据。状态 **`READY_FOR_EXTERNAL_REVIEW`**。
