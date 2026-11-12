# PHASE 02 实施计划

## 1. 复用 / 新增 / 不改

### 复用（不重写）

| 能力 | 位置 |
|---|---|
| Runtime 池与租约 | `runtime/supervisor.ts` |
| Session 创建/恢复/事件 | `tasks/runner.ts` 的 `#subscribe` / `#observe` |
| 项目 CRUD 与隔离 | `projects/service.ts` |
| 路径安全 | `projects/paths.ts` |
| 项目写锁 | `projects/locks.ts` |
| 规则读取 | `projects/rules.ts` |
| 数据库与迁移机制 | `tasks/store.ts` 的 `MIGRATIONS` |
| IPC 白名单模式 | `ipc.ts` + `preload.ts` |
| 装配 | `app-wiring.ts` |

### 新增

| 模块 | 文件 | 职责 |
|---|---|---|
| 需求数据模型 | `requirements/types.ts` | 概念对象与状态枚举 |
| 需求存储 | `requirements/store.ts` | v3 迁移 + 全部读写 |
| 顾问服务 | `requirements/advisor.ts` | 对话、消息、Session 映射 |
| 上下文编译 | `requirements/context.ts` | 预算、来源记录、项目隔离 |
| 附件服务 | `requirements/attachments.ts` | 元数据、文本解析、图片内联 |
| 草稿服务 | `requirements/drafts.ts` | IdeaDraft / DesignDraft / GDDDraft + 版本 |
| 研究服务 | `requirements/research.ts` | 研究请求与报告 |
| 基线服务 | `requirements/baseline.ts` | 冻结、哈希、不可覆盖 |
| 变更服务 | `requirements/changes.ts` | 提案、影响分析、审批 |
| UI | `renderer/advisor.ts` 等 | 顾问页、草稿页、基线页、变更页 |

### 不改

- PHASE 00/01-A/01-B/01-C/01-D 的任何源码行为、证据、状态。
- `tasks/` 与 `projects/` 的既有语义（只做加法：新增表、新增服务）。
- Renderer 不引入框架。

## 2. 数据模型（v3 迁移）

```sql
-- 对话
advisor_conversations (id, project_id, title, status, created_at, updated_at, last_message_at)
advisor_messages      (id, conversation_id, role, kind, content, session_id, seq, created_at)
advisor_session_links (conversation_id, session_id, runtime_id, state, created_at)

-- 上下文
context_snapshots (id, project_id, conversation_id, purpose, sources, tokens, created_at)

-- 附件
attachments (id, project_id, conversation_id, filename, mime, bytes, sha256, kind, extracted_text, created_at)

-- 草稿
drafts (id, project_id, kind, title, status, current_version, created_at, updated_at)
draft_versions (id, draft_id, version, content, note, created_at)

-- 研究
research_requests (id, project_id, conversation_id, question, scope, status, created_at)
research_reports  (id, project_id, request_id, title, content, sources, status, created_at)

-- 基线
requirement_baselines (id, project_id, version, name, content, content_hash, status, created_at, frozen_at, confirmed_by, source_draft_id, previous_baseline_id)

-- 变更
change_proposals (id, project_id, baseline_id, title, description, impact, status, created_at, decided_at, decided_by, note)
```

关键约束（由存储层强制，不依赖 UI）：

1. `requirement_baselines` 的 `(project_id, version)` 唯一。
2. 冻结后 `content` 不可 UPDATE —— 用触发器或服务层 + 测试双重保证。
3. `content_hash` 基于规范化 JSON（键排序）计算。
4. 所有表带 `project_id`，跨项目查询必须显式带条件。

## 3. 模块依赖

```
requirements/store.ts
   ├── requirements/context.ts ── projects/rules.ts
   ├── requirements/attachments.ts ── projects/paths.ts
   ├── requirements/advisor.ts ── runtime/supervisor.ts + tasks/runner.ts 的事件订阅
   ├── requirements/drafts.ts
   ├── requirements/research.ts
   ├── requirements/baseline.ts
   └── requirements/changes.ts
```

## 4. UI 页面规划

| 视图 | 入口 | 内容 |
|---|---|---|
| AI 顾问 | 一级导航 | 左：讨论列表；中：对话；右：项目上下文（可折叠） |
| 设计与素材 | 一级导航 | 本阶段只放设计草稿与 GDD，素材留给 PHASE 03 |
| 决策中心 | 一级导航 | 基线列表、冻结确认页、变更提案与审批 |

工作台增加"当前基线"卡片；项目详情增加"需求状态"。

## 5. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 顾问对话 + Session 映射 | 一句话开始讨论；消息持久化；多项目隔离；恢复 |
| M2 | 附件 + 上下文编译 | 图片内联；文本解析；预算生效；来源记录 |
| M3 | 研究请求与报告 | 事实/推测/建议分离；来源可追踪；未验证标记 |
| M4 | 设计草稿与 GDD | 分章节编辑；版本比较；拒绝不影响基线 |
| M5 | 正式基线 | 预览、确认、冻结、哈希、不可覆盖 |
| M6 | 变更提案 | 影响分析；审批；批准后生成新版本 |
| M7 | 数据模型补全 | v3 迁移；迁移失败回滚；重启恢复 |
| M8 | UI 完整旅程 | 八步旅程可走通 |
| M9 | 测试与回归 | 真实链路测试；PHASE 00/01 回归 |
| M10 | 交付 | 报告、证据、推送 |

## 6. 风险与未决

| ID | 风险 | 处理 |
|---|---|---|
| R-02-1 | ~~联网搜索缺凭据~~ **已实测可用** | 搜索走 `commandcode` provider，不依赖 `DEEPSEEK_API_KEY`；研究报告必须带真实来源 |
| R-02-2 | ~~网页抓取未验证~~ **已实测可用** | `web_fetch` 抓取 example.com 成功；单页应用可能抓不到正文，需标记 |
| R-02-3 | PDF/DOCX 解析质量 | 本地解析，标注信息损失；解析失败给明确错误 |
| R-02-4 | 无 wire-level cancel | 停止 = 关闭 Runtime；UI 明确说明 |
| R-02-5 | 上下文窗口 | 预算 + 摘要；不注入全部历史 |
| R-02-6 | 真实模型调用成本 | 先最小链路验证，其余用可控测试 Runtime |
| R-02-7 | PHASE 01-D 关闭状态不可自证 | 已在审计中记录，交外部评审 |

## 7. 明确不做（DEFERRED）

- 完整素材库与素材识别（PHASE 03）。
- UI 原型设计器（PHASE 04）。
- 多 Agent 调度（PHASE 05）。
- 微信构建与真机门禁（PHASE 06）。
- 发布交付（PHASE 07）。
- 多人审批、角色权限、云端协作。
- 自研 Agent Runtime、额外模型供应商路由。
