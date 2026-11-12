# PHASE 02 M0 审计

- 基线：`ea6c593301595e6909ff0b0a65de859eba41ca05`（PHASE 01-D 最终代码）
- 方式：只读检查源码、SDK 类型定义、bundle 配置与历史证据

## 0. 一个必须先说明的事实

`state/phase_01_d.json` 的 `status` 仍是 `READY_FOR_EXTERNAL_REVIEW`，`verdict` 为 `null`。
仓库内**没有**记录 PHASE 01-D 的外部评审通过结论。

任务书要求"PHASE 01-D 已有外部评审通过结论"才可开始。本阶段按用户明确指令继续执行，
但把这一事实记录在此：**PHASE 01-D 的关闭状态在仓库内不可自证**，需外部评审确认。

## 1. 现有架构

| 层 | 文件 | 职责 |
|---|---|---|
| 装配 | `main/app-wiring.ts` | `wireServices()`：一个数据库、一张锁表、一个连接所有者 |
| DSH | `dsh/{service,probe,processes,locate}.ts` | 连接探测、进程身份、入口定位 |
| Runtime | `runtime/supervisor.ts` | Runtime 池、租约、关闭阶梯 |
| 任务 | `tasks/{store,service,runner,machine,types}.ts` | 状态机、单飞、Session 恢复 |
| 项目 | `projects/{store,service,paths,locks,backup,rules,types}.ts` | 项目 CRUD、路径安全、锁、备份 |
| IPC | `ipc.ts` + `preload/preload.ts` | 23 个通道，白名单暴露 |
| UI | `renderer/{index.html,renderer.ts,styles.css}` | 五个一级视图，vanilla DOM |

数据库：SQLite `schema_version = 2`，13 张表，迁移在 `tasks/store.ts` 的 `MIGRATIONS` 数组。

## 2. DSH SDK 实际能力（以安装版本为准）

`@deepseek-ai/dsh-sdk-client@0.2.1-rc.3`，`HarnessClient` 公开方法：

```
start  initialize  prompt  resumeSession  getWorkingDirectory
setWorkingDirectory  request  subscribe  subscribeSessionTree  close
```

### 2.1 输入内容块

`prompt(sessionId, contentBlocks: SdkPromptContentBlock[])`，其中：

```ts
type SdkPromptContentBlock = ContentBlock | SdkEncodedImageBlock

interface SdkEncodedImageBlock {
  type: 'image'
  data: string          // base64
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

// ContentBlock 的 type 取值
'text' | 'reasoning' | 'image' | 'file' | 'tool-call' | 'tool-addition' | 'tool-removal'
```

**结论**：

| 格式 | 能力 | 依据 |
|---|---|---|
| 纯文本 / Markdown | **支持**，作为 `text` 块内联 | `TextBlock` |
| PNG / JPEG / WebP / GIF | **支持**，作为 `SdkEncodedImageBlock` 内联 base64 | 类型定义明确列出四种 MIME |
| PDF | **不支持直接输入** | 无对应块类型；`file` 块要求 `FileAttachmentRef`（durable attachment store 引用），不是任意路径 |
| DOCX | **不支持直接输入** | 同上 |

PDF/DOCX 只能由 Studio 本地解析成文本后作为 `text` 块送入。这是**允许的**（不构造不受支持的 SDK 参数），
但解析质量与版式信息会丢失，必须如实标注。

### 2.2 会话事件

`session.event` 通知的 `event.type` 取值（`dsh-session` 的 `SessionEventMap`）：

```
turn/start  turn/end  step/start  step/end
user/message  developer/message  assistant/message
tool/call  tool/result
```

`assistant/message` 携带 `message.content`（含 `text` 与 `tool-call` 块）、`usage`、`interrupted`。
`tool/call` 携带 `name` 与 `arguments`；`tool/result` 携带 `message` 与可选 `error`。

**这足以构建对话 UI**：用户消息、AI 文本、工具调用与结果都能从事件流还原。

### 2.3 已知限制（沿用 PHASE 00/01 的实测结论）

| ID | 结论 | 对本阶段的影响 |
|---|---|---|
| D-014 | **没有 wire-level cancel**，停止只能关闭 Runtime | 顾问对话的"停止"= 关闭该 Runtime；已生成的部分内容保留 |
| D-015 | 0.2.1 有 `session/resume`，正常关闭后能恢复历史 | 对话恢复可用；中断中的最后一轮为 UNKNOWN |
| D-016 | **没有可依赖的工具审批回调** | 不能依赖模型侧审批；审批必须由 Studio 业务层实现 |
| D-017 | 工具桥接唯一通道是 MCP | 顾问需要的项目上下文工具必须走 MCP |

## 3. 外部研究能力（已实测，不是推断）

### 3.1 静态配置看起来不可用

`dsh-base` bundle 中与联网相关的行：

| 行 id | 插件 | 配置 |
|---|---|---|
| `web-search-deepseek` | `dsh-web-search-deepseek` | `apiKeyEnv: DEEPSEEK_API_KEY` |
| `web-deepseek-api` | `dsh-web-deepseek-api` | `apiKeyEnv: DEEPSEEK_API_KEY` |
| `web-fetch-http` | `dsh-web-fetch-http` | 无 |
| `tool-web` | `dsh-tool-web` | `fetch: true` |

本机凭据文件中的键名（**只读键名，未读取值**）：`COMMANDCODE_API_KEY`、`CLOUDFLARE_WORKERS_AI_API_KEY`。
**没有 `DEEPSEEK_API_KEY`。** 按静态配置推断，搜索应当不可用。

### 3.2 实测结果：两者都可用

用 `scripts/web-capability-probe.mjs` 跑真实 DSH 会话（真实 provider、真实模型、真实工具调用）：

| 能力 | 结果 | 证据 |
|---|---|---|
| 工具是否暴露 | **是**，`request/header` 中 25 个工具，含 `web_fetch` 与 `web_search` | `evidence/phase-02/capability/web-capability.json` |
| 网页抓取 | **可用**。模型调用 `web_fetch` 抓取 `https://example.com`，返回真实页面标题 "Example Domain" | 同上 |
| 联网搜索 | **可用**。模型调用 `web_search` 搜索 "vampire survivors game design core loop"，返回真实标题与 URL | 同上 |

**为什么静态推断错了**：生成的 profile 的 `cordis.patch.yml` 把 `web` 行配置为：

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: commandcode
    fetchProvider: http
```

即搜索走 `commandcode` provider（用已有的 `COMMANDCODE_API_KEY`），不是 `deepseek-official`。
`dsh-web-search-deepseek` 的 `DEEPSEEK_PROVIDER_ID = "deepseek-official"` 是**另一个** provider，
本机没有它的凭据，但 profile 根本没选它。

**结论修正**：联网搜索与网页抓取**均可用**，研究报告可以引用真实来源。
这比原计划乐观，因此 M3 的研究报告**必须**带真实来源，不得以"未联网验证"作为默认借口。

### 3.3 仍然存在的限制

| 限制 | 影响 |
|---|---|
| 搜索走 `commandcode` provider，返回质量与配额受该 provider 约束 | 研究报告需记录 provider 与获取时间 |
| 抓取是 HTTP 直连，不执行 JS | 单页应用类站点可能抓不到正文，需标记 |
| 无工具审批回调（D-016） | 模型可自行调用联网工具，Studio 无法逐次拦截；只能在提示词与业务层约束 |

## 4. 数据关系现状

```
projects ──┬── tasks (project_id, ON DELETE SET NULL)
           ├── project_configs
           ├── project_events
           ├── approvals
           └── project_locks

tasks ──┬── task_transitions
        ├── attempts ── sessions
        ├── verifications
        └── events
```

`approvals` 表已存在（`PENDING/APPROVED/REJECTED`），但**没有任何代码写入它**——PHASE 01-D 只建了形状。
本阶段的需求变更审批可以复用它，但需要扩展（当前只有 `subject` 一个文本字段）。

## 5. UI 现状

五个一级视图：`workbench`、`projects`、`advisor`、`assets`、`decisions`。
`advisor` 与 `decisions` 目前是"尚未开发"占位。

`renderer.ts` 47 KB，vanilla DOM，无框架。新增顾问页面需要新增约 800–1200 行渲染逻辑。

## 6. 差距分析

| PHASE 02 目标 | 现状 | 差距 |
|---|---|---|
| 一句话开始讨论 | 无 | 全新 |
| 项目级长期顾问对话 | 有 Session 基础设施，无对话模型 | 需 Conversation/Message 表 + 服务 |
| 对话持久化与历史加载 | Session 由 DSH 持久化，Studio 无自己的记录 | 需 Studio 侧消息表（DSH 事件流是唯一真源，但需可查询的投影） |
| 附件 | 无 | 需 Attachment 表 + 图片内联 + 文本解析 |
| 上下文编译 | 有 `RulesService`（只读规则） | 需 ContextCompiler |
| 研究报告 | 无 | 全新 |
| 设计草稿 / GDD | 无 | 全新 |
| 正式基线 + 哈希 + 不可覆盖 | 无 | 全新，且必须由存储层强制 |
| 变更提案 + 影响分析 | `approvals` 表形状 | 需扩展 |
| 完整 UI 旅程 | 占位页 | 全新 |

## 7. 结论

- DSH 足以支撑顾问对话、追问、研究归纳与设计生成。
- 图片附件可直接内联；PDF/DOCX 需本地解析，且必须标注信息损失。
- 联网搜索当前**不可用**（缺凭据），网页抓取待验证。
- 没有工具审批回调，审批必须由 Studio 业务层实现——这与 PHASE 02 的要求一致。
- 数据库需要 v3 迁移，新增需求系统表，复用 `projects` 与 `approvals`。
