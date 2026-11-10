# 04｜DSH 统一 AI Runtime 集成规范

## 核心原则

所有需要模型理解、推理、归纳、生成、判断和规划的功能统一调用 DSH。AI Game Studio 不自建第二套模型通信体系，不直接调用其他模型 API 来绕过 DSH。

## 集成路径

- 优先使用 DSH 官方 SDK（TypeScript SDK 或经验证的官方等价 SDK）。
- SDK 启动/管理 DSH Runtime 子进程，Studio 负责生命周期、工作目录、会话映射、事件订阅、错误呈现和回收。
- 不自行手写 JSON-RPC transport、协议类型或私有 DSH 调用协议。
- DSH 版本、SDK 版本、Profile、Provider/Model 设置必须从真实安装和官方文档读取，记录在环境报告/ADR。

## 需要支持的 Session 类型

1. `PROJECT_CONVERSATION`：项目长期顾问讨论；讨论草稿不自动成为基线。
2. `TASK_EXECUTION`：任务隔离的代码/资源/测试执行会话。
3. `INDEPENDENT_REVIEW`：尽量独立的质量复审，不能只复述开发 Agent 自己的结论。
4. `KNOWLEDGE_MAINTENANCE`：知识索引、项目文档和经验整理。

每个 Session 必须关联 `projectId`、`taskId`（可为空）、`purpose`、`workspace`、DSH session id、创建版本和当前状态。Studio 业务任务状态不得依赖 Session 是否还活着。

## 工具桥接

通过 DSH 可用的官方 MCP Tools 机制或官方支持的工具注册机制，逐步向模型提供 Studio 能力。先只读，再提案，最后才是受控写入。

建议工具（示例名，最终名称需在 PHASE 00 统一命名）：

只读：
- `get_studio_health`
- `get_project_overview`
- `get_project_state`
- `search_project_knowledge`
- `get_development_rules`
- `get_requirement_baseline`
- `get_asset_catalog`
- `search_game_assets`
- `get_task_status`
- `get_build_evidence`
- `get_test_report`

提案：
- `create_requirement_draft`
- `propose_design_revision`
- `propose_change_request`
- `propose_asset_gap_solution`
- `submit_review_result`

受控执行（必须有任务授权、项目写锁和审计）：
- `start_authorized_task`
- `apply_approved_change`
- `run_project_check`
- `request_build`

危险操作必须由 Studio 审批，不得暴露无限制 shell/任意路径写入工具。

## MCP 能力边界

现有 DSH MCP Client 的公开说明明确面向工具桥接；不要假设 MCP Resources 或 Prompts 会被当前 Harness 当成原生上下文入口消费。知识检索应封装为 `search_project_knowledge` 等工具，返回片段、来源路径、版本和引用范围。

## RAG / 知识检索

- 文档切片、元数据、全文索引、来源追踪、版本管理由 Studio 确定性实现。
- 模型负责理解检索意图、选择工具、归纳证据。
- MVP 优先本地全文/关键词 + 元数据过滤；Embedding/向量检索只有在当前 SDK/API 和本地资源验证后再做 ADR，不要顺手另接一个模型供应商。
- 检索结果必须带 `sourceId`、文件路径、版本、行/页范围或 chunk id。

## 审批必须区分两层

1. **DSH 工具权限审批**：某一次工具操作是否允许。
2. **Studio 业务审批**：是否冻结需求、接受设计、批准变更、允许危险文件操作、批准发布交付。

两者不能混为一谈。即使某次 DSH 工具调用获得许可，也不能因此绕过 Studio 业务审批。

## 生命周期和恢复

- 保存 DSH Session id、DSH Home/工作区映射（敏感路径不上传）、Studio task checkpoint、事件游标和任务状态。
- 进程崩溃后先恢复 Studio 任务状态，再按当前 SDK 支持的 API 恢复 DSH Session。
- Session 恢复不代表 Shell/Browser 等外部进程自动恢复；必须重新检查运行环境。
- 超时/前端停止等待不等于停止 DSH 运行。若当前 SDK 没有运行时级取消能力，UI 不得谎称“已停止”。需要隔离 Runtime，明确关闭范围和副作用。
- 关闭 Runtime 必须等待进程真正退出并记录退出码；不得只隐藏 UI。

## PHASE 00 必须验证的官方资料

- DSH SDK 总览：<https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk>
- TypeScript Client：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md>
- SDK 指南：<https://deepseekdocs.com/docs/guides/drive-harness-from-program>
- MCP Client：<https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client>

上述内容可能随 DSH 迭代变化，只作为官方入口。实际实现必须核对当前安装版本和官方 API。
