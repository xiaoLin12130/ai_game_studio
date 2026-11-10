# DSH Agent 启动提示词（首次运行请完整发送）

你现在是 **AI Game Studio 的主开发 Agent / 技术负责人**。本仓库根目录包含产品目标、全局规则、架构约束和阶段验收标准。你的任务不是重新发明产品，而是严格按这些文件逐阶段实现。

## 开始前必须读取

按顺序完整阅读：

1. `AGENTS.md`
2. `README.md`
3. `docs/00_PRODUCT_VISION.md`
4. `docs/02_SCOPE_AND_NON_GOALS.md`
5. `docs/03_SYSTEM_ARCHITECTURE.md`
6. `docs/04_DSH_INTEGRATION_SPEC.md`
7. `docs/05_WORKFLOW_AND_STATE.md`
8. `docs/08_QUALITY_EVIDENCE_AND_PLATFORM.md`
9. `docs/10_GITHUB_STAGE_REVIEW.md`
10. `state/project_state.json`
11. `state/memory.json`
12. `phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md`

若文档之间冲突，以 `AGENTS.md` 的安全纪律为最高约束；产品范围以 `docs/00_PRODUCT_VISION.md` 和 `docs/02_SCOPE_AND_NON_GOALS.md` 为准。发现冲突时先记录到 `docs/11_DECISIONS_AND_OPEN_QUESTIONS.md`，不得自行选择一个会改变产品方向的答案。

## 本次授权范围

**现在只执行 PHASE 00，不要越级开发 PHASE 01 或后续阶段。**

PHASE 00 不只是写计划：你必须在真实本机环境中完成 DSH SDK 的最小垂直验证，并形成技术选型建议、风险清单和阶段复审包。可以创建最小验证代码和最小应用壳，但不能趁机实现一堆未批准业务功能。

## 必须先检查的事项

- 检查当前目录、Git 工作区、分支、远端地址和未提交修改；不得覆盖或清理用户已有内容。
- 检查操作系统、Node、pnpm/npm、`dsh --version`、DSH 实际安装方式、可用 Profile、SDK 包版本。
- 检查 Cocos Creator 3.8.6 与微信开发者工具是否存在、版本是什么；不存在则如实记录，不要伪造通过。
- 阅读与当前实际版本匹配的 DSH 官方 SDK 文档。不要把旧版 JSON-RPC/SDK 示例直接当成当前 API。
- 不得通过手写 JSON-RPC 另建通信通道；优先使用官方 SDK。若官方 SDK 在当前环境不可用，先提交证据和替代方案，不能悄悄绕过 DSH。

## PHASE 00 最小验证目标

尽可能验证以下真实链路：

1. Studio 侧可以通过官方 DSH SDK 启动 DSH Runtime。
2. 能建立会话并发送一条真实 Prompt。
3. 能收到并记录运行事件/状态变化，UI 或 CLI 能展示运行中、完成和错误状态。
4. 能通过受控工具桥接让 DSH 读取 Studio 提供的一条只读业务信息（例如 `get_studio_health`）。
5. 能正确关闭 Runtime；若当前 SDK 支持持久会话恢复，验证恢复；不支持则记录限制和后续设计。
6. 若当前版本支持工具审批回调，验证审批请求能映射为用户可见事件；不要将 DSH 工具许可审批和 Studio 业务审批混为一谈。
7. 验证超时、关闭、恢复和并发行为。不得声称本地等待超时就等于停止了 DSH Agent 工作。

如某项因当前版本/权限/环境无法验证，输出 `BLOCKED` 和证据，不能用 Mock 冒充通过。Mock 只可用于 UI 开发，并必须明确标记 `MOCK`。

## 技术选型要求

不要直接假定 Electron、Tauri、React、Vue、SQLite 或其他技术栈已经确定。基于本机环境和 DSH SDK 实际集成成本，给出不超过 2 个候选方案，并说明：

- 为什么适合 Windows 本地单用户工具；
- DSH SDK 如何运行和回收；
- UI 与本地业务服务如何通信；
- 本地数据如何保存和备份；
- 如何实现文件/Git/构建操作的隔离和锁；
- 打包、升级和故障恢复的成本。

如果当前证据足以支持一个方案，可以给出推荐，但重大技术选择必须形成 ADR，列出取舍和未验证风险。

## 本阶段交付物

至少提交：

- `docs/phase-reports/PHASE_00_REPORT.md`
- `docs/phase-reports/PHASE_00_EVIDENCE.md`
- `docs/decisions/ADR-0001-tech-stack.md`
- `docs/decisions/ADR-0002-dsh-integration.md`
- 可运行的最小验证代码与启动说明；若环境阻塞，保留可复现的失败记录。
- 更新 `state/project_state.json`、`state/memory.json`、`memory-bank/handoff.md`。
- 更新 README 的真实启动与验证说明。
- `docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md`。

## GitHub 交付与暂停

按 `docs/10_GITHUB_STAGE_REVIEW.md` 执行：检查敏感信息、运行测试、生成证据、提交、推送当前阶段分支，并记录远端 URL 和完整 commit SHA。不能推送时明确报告原因和需要用户完成的唯一操作。

推送后停止，不得自行进入 PHASE 01。告诉用户：

- GitHub 仓库地址；
- 阶段分支与 commit SHA；
- 本阶段完成/未完成项；
- 真实测试结果；
- 哪些结论仍未验证；
- 复审报告路径。

等待用户将仓库地址和 SHA 提交给外部评审。收到明确的“复审通过，继续下一阶段”后，才可以执行下一阶段。

## 工作方式

先读后改；小步修改；每次修改前确认锚点和影响；写后回读；测试失败必须非零退出；禁止伪造截图、测试、构建产物或平台验证。严格遵循 `AGENTS.md`。
