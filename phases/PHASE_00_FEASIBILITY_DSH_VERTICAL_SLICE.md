# PHASE 00｜技术可行性与 DSH 最小垂直切片

## 目标

用真实本机环境证明 AI Game Studio 能通过官方 DSH SDK 完成最小 AI 调用和受控工具桥接；同时选定可实施的应用技术路线。先验证最高风险，不先堆功能。

## 工作项

1. 仓库/工作区/环境盘点：OS、Node、pnpm/npm、Git、DSH、Cocos、微信开发者工具。
2. 阅读当前安装版本对应的 DSH 官方文档和 SDK package metadata。
3. 完成真实 DSH 启动、Prompt、事件、Session 状态、关闭验证。
4. 若 SDK 支持，验证 Session 恢复；若支持审批回调，验证单次工具许可审批。
5. 实现最小只读 Studio Tool，例如 `get_studio_health`，由 DSH 调用并返回真实结构化结果。
6. 验证超时、Runtime 关闭、并发请求和恢复边界；记录“停止等待”与“停止 Agent 工作”的区别。
7. 对比最多两个 UI/本地服务/数据存储技术方案，形成 ADR。
8. 创建最小可运行的应用壳/诊断页（仅需展示 DSH 连接、版本、会话和事件），不要实现完整业务 UI。
9. 定义日志、状态文件、阶段复审和 GitHub 交付机制。

## 禁止

- 禁止用假 DSH 客户端或固定字符串冒充真实联通。
- 禁止自己实现 JSON-RPC 代替官方 SDK。
- 禁止在未验证 SDK 版本的情况下写死 API。
- 禁止这一阶段开发完整项目管理、素材库或游戏开发流水线。

## 验收门禁

- [ ] 环境清单真实且带版本/命令输出。
- [ ] 官方 SDK 与实际 DSH 版本兼容性有证据。
- [ ] 至少一条真实 Prompt 成功并收到可追踪结果。
- [ ] 事件/状态能够记录并在 UI 或 CLI 展示。
- [ ] Studio 只读工具被 DSH 调用成功。
- [ ] Runtime 关闭后进程确实退出，记录退出码。
- [ ] Session 恢复/审批能力已验证或明确标记不支持/未测。
- [ ] 技术选型 ADR 写明取舍和风险。
- [ ] 无密钥进入日志或 Git。
- [ ] GitHub 推送与复审交接完成。

## 本阶段输出

- `docs/phase-reports/PHASE_00_REPORT.md`
- `docs/phase-reports/PHASE_00_EVIDENCE.md`
- `docs/decisions/ADR-0001-tech-stack.md`
- `docs/decisions/ADR-0002-dsh-integration.md`
- 最小验证代码和运行说明
- `docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md`

## 结束状态

只有门禁全部满足才 `PASS`。如果 DSH 核心能力被环境阻塞，状态 `BLOCKED`；提交证据和建议后暂停，不得假装通过，也不得跳过该阶段继续建设依赖它的功能。
