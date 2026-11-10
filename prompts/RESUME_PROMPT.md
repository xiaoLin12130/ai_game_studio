# 跨 Session / 中断恢复提示词

你正在恢复 AI Game Studio 开发工作。不要依赖旧聊天全文，也不要重新规划整个项目。

按顺序读取：
1. `AGENTS.md`
2. `state/project_state.json`
3. `state/active_task.json`
4. `state/memory.json`
5. `memory-bank/handoff.md`
6. 当前阶段文件和任务契约
7. 当前阶段最新报告与 Git 状态

恢复步骤：
- 检查当前 Commit、工作区未提交修改、运行中的进程和项目锁。
- 核对 Studio 任务状态与 DSH Session 状态；两者不一致时以 Studio 持久化状态为基准并记录差异。
- 核查上次操作是否已产生副作用，禁止盲目重放。
- 若 DSH Session 可恢复，按当前官方 SDK 能力恢复；外部 Shell/Browser/开发者工具需要重新检测。
- 从 `next_action` 继续，只处理当前阶段。
- 不得因为旧会话中断而重做已经有证据通过的任务。
- 阶段完成后仍必须 GitHub 推送并暂停等待复审。
