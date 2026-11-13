# PHASE 02 报告 — AI 顾问、需求讨论与正式需求基线

> **状态：`READY_FOR_EXTERNAL_REVIEW`。** 本报告不宣告通过。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `phase/02-advisor-requirements-baseline` |
| 基线 | `ea6c593301595e6909ff0b0a65de859eba41ca05`（PHASE 01-D 最终代码） |
| 审计 | `docs/review-handoff/PHASE_02_M0_AUDIT.md` |
| 计划 | `docs/review-handoff/PHASE_02_IMPLEMENTATION_PLAN.md` |

### 1.1 一个必须说明的前置事实

`state/phase_01_d.json` 的 `status` 仍是 `READY_FOR_EXTERNAL_REVIEW`，`verdict` 为 `null`。
仓库内**没有**记录 PHASE 01-D 的外部评审通过结论。本阶段按用户明确指令继续，
但这一事实记录在此，需外部评审确认。

## 2. 本阶段的核心区分

**讨论不是需求。** 想法、研究、设计草稿、GDD 都是用户可以随时改变主意的对象。
只有冻结的基线有约束力，且只有用户能冻结它。

这条区分不是文案，是代码结构：

| 对象 | 可变性 | 强制点 |
|---|---|---|
| 对话 / 消息 | 只追加 | 存储层 |
| 草稿 | 每次修改产生新版本 | `draft_versions` 唯一索引 |
| 研究报告 | 只追加 | 存储层 |
| **正式基线** | **不可变** | **数据库触发器** |

## 3. 实现

### 3.1 数据（v3 迁移，11 张新表）

`advisor_conversations`、`advisor_messages`、`advisor_session_links`、`context_snapshots`、
`attachments`、`drafts`、`draft_versions`、`research_requests`、`research_reports`、
`requirement_baselines`、`change_proposals`。

全部挂在 `projects` 下，每次读取都带项目条件。v2→v3 升级保留旧数据（有测试）。

### 3.2 基线不可覆盖

三层强制，UI 不在其中：

1. `BaselineService.freeze()` 要求显式 `confirmedBy`；
2. `RequirementStore.updateBaseline()` 抛 `BASELINE_FROZEN`；
3. **数据库触发器** `trg_baseline_frozen_update` / `trg_baseline_frozen_delete` 拒绝任何 UPDATE/DELETE。

测试直接对数据库执行 `UPDATE` 与 `DELETE`，证明约束不依赖调用方。

哈希基于规范化 JSON（键排序），所以字段顺序变化不会产生无意义差异。

### 3.3 上下文编译

预算 24000 字符，按优先级花费：用户消息与项目身份（永不丢弃）→ 规则 → 已确认事实 →
待决问题 → 草稿 → 最近对话 → 附件。每次编译记录 `sources`，用户能看到什么进了上下文。

历史从**最新**往前保留：用户正在继续的是最近那一轮。

### 3.4 附件

按 runtime 实际能力分流：图片内联（`SdkEncodedImageBlock`，四种 MIME），文本直接读，
PDF/DOCX 本地提取文本并在 `note` 里写明信息损失。扫描件 PDF 提取不到文本时**拒绝**，
而不是存成空附件。

### 3.5 顾问

真实 DSH runtime、真实 provider、真实模型。系统提示明确角色与五条规则，
模型因此区分「用户说的／我的推测／我的建议」，一次只问一到两个问题。

## 4. 真实链路证据

### 4.1 顾问链路（`advisor-probe.mjs`，11/11 步）

真实模型的两轮回复节选：

> **用户说的（已确认）** 像素风格；微信小游戏；引擎 cocos-creator-3.8.6；玩法参考《吸血鬼幸存者》；主角是鸽子
> **我的推测** 目前"鸽子"可能只是美术皮肤，核心循环还没差异化
> **我的建议** 别急着一开始定数值。先决定"鸽子"是皮肤还是机制
> 所以只问两个问题：…

第二轮记得第一轮：

> 还剩上一轮的两个问题没答，我挑最关键的重新问

### 4.2 桌面旅程（`smoke-advisor.mjs`，13/13 检查，6 张真实截图）

真实 Electron 窗口中的真实点击：创建项目 → 顾问一句话开始 → 草稿 → 冻结确认页 →
冻结成功（显示哈希）→ 变更提案（显示影响分析与未分析范围）。

## 5. 修复过程中发现的真实缺陷

这些不是测试问题，是产品缺陷——每一个都会让用户看到失败：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 应用从不读取凭据文件 | 模型调用必然 `MISSING_CREDENTIAL` |
| 2 | 默认 provider 是 `deepseek-official`，本机只有 `commandcode` 凭据 | 同上 |
| 3 | 顾问路径未调用 `ensureProfile()` | 新装环境 provider 插件缺失，runtime 起来但模型不响应 |
| 4 | 只读 runtime 池在租约释放时关闭 | 每轮冷启动，且正在排空的流会失去 runtime |
| 5 | 冒烟看门狗硬编码 180 秒 | 任何超过 3 分钟的流程被误杀 |
| 6 | renderer 不知道主进程已打开的项目 | 重启后顾问拒绝工作 |
| 7 | 空状态未隐藏（组件 `display` 覆盖 `hidden`） | 对话与空状态重叠 |
| 8 | 顾问回复的 Markdown 原样显示 | 好答案看起来像坏掉的 |
| 9 | 第二轮 `resumeSession` 与已打开的 session 冲突 | 第二轮必然失败 |
| 10 | 影响分析的中文分词方向反了 | 匹配不到任何章节 |
| 11 | 上下文裁剪从尾部截断 | 切掉了刚保留的最新消息 |

第 1–3 条尤其重要：它们意味着**用户装了应用也永远无法使用顾问**，而单元测试全绿。

## 6. 测试结果

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test` | 0 | **291/291** | `unit/full-suite.txt` |
| `node --test test/requirement-store.test.js` | 0 | **16/16** | `unit/requirement-store.txt` |
| `node --test test/requirement-services.test.js` | 0 | **19/19** | `unit/requirement-services.txt` |
| `node scripts/advisor-probe.mjs` | 0 | **11/11 步** | `advisor/advisor-chain.json` |
| `node scripts/smoke-advisor.mjs` | 0 | **13/13 检查** | `desktop/summary.json` |
| PHASE 01-C/D 任务与锁 | 0 | **57/57** | `regression/phase01c-d-tasks.txt` |
| PHASE 01-A 冒烟 | 0 | — | `regression/phase01a-ready.txt` |
| PHASE 01-B MCP 握手 | 0 | — | `regression/phase01b-mcp.txt` |
| PHASE 01-D 项目冒烟 | 0 | — | `regression/phase01d-projects.txt` |
| PHASE 00 门禁 | 0 | PASS，0 泄漏 | `regression/phase00-gates.json` |

## 7. 能力实测（修正了 M0 的静态推断）

M0 审计最初按静态配置判断"联网研究不可用"（本机无 `DEEPSEEK_API_KEY`）。
真实探针推翻了它：生成的 profile 把 `web.searchProvider` 指向 `commandcode`。

| 能力 | 实测结果 |
|---|---|
| `web_fetch` | 可用，抓取 example.com 返回真实标题 |
| `web_search` | 可用，返回真实标题与 URL |
| 图片内联 | 支持 PNG/JPEG/WebP/GIF |
| PDF/DOCX | 需本地提取文本，信息损失已标注 |

审计文档保留了修正过程，而不是把猜测留下。

## 8. 未做

| 类型 | 内容 |
|---|---|
| NOT_RUN | 安装包重建与安装后顾问链路；`npm audit` / 静态吊销检查 |
| DEFERRED | 完整素材库（PHASE 03）、UI 原型设计器（PHASE 04）、多 Agent 调度（PHASE 05）、多人审批与角色权限（未排期） |
| UNKNOWN | 无新增 |
| BLOCKED | 无 |

## 9. 历史保护

PHASE 00 / 01-A / 01-B / 01-C / 01-D 及其三轮补正的证据、状态与 `spike/` 历史材料未被修改
（回归时被脚本覆写的已还原，diff 为空）。

## 10. 结论

PHASE 02 的原始目标已实现并有真实链路证据。状态 **`READY_FOR_EXTERNAL_REVIEW`**。
未标记 APPROVED，未开始 PHASE 03。
