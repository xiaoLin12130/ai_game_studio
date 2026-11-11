# PHASE 01-C 工作报告（未完成）

> **状态：开发中，不宣告任何结论。** 本报告只记录已完成与未完成的事实。

## 1. 基线

| 项 | 值 |
|---|---|
| 分支 | `phase/01-c-session-task-lifecycle` |
| 阶段基线 | `908c2fb`（PHASE 01-B 关闭 HEAD） |
| 当前 HEAD | `aa0c54b` |

## 2. 已实现（有测试）

Task 状态机、SQLite 持久化、RuntimeSupervisorManager、TaskRunner、Studio 侧验收、IPC/preload 白名单、任务面板 UI。设计与状态转换表见 `docs/architecture/phase-01-c-task-lifecycle.md`。

## 3. 已验证事实

| 项 | 结果 |
|---|---|
| TypeScript | 退出码 0 |
| 状态机测试 | 13/13 |
| 持久化测试 | 全部通过 |
| Runner 故障注入 | 8/8 |
| 真实 DSH 端到端 | 建任务→真实回合→SUCCEEDED；中断→恢复复用原 session |
| UI（真实 Chromium） | 41/41 断言 |
| 真实集成测试隔离运行 | 连续 3 次退出码 0 |
| 满套件 | 84 项，83 通过；失败项为真实模型测试在并行负载下不稳定 |

## 3.1 本轮长跑结果（全部退出码 0）

| 项 | 结果 | 证据 |
|---|---|---|
| 真实集成测试隔离运行 | 3/3 退出码 0 | `real-dsh/isolated-{1,2,3}.txt` |
| **满套件连续两次** | 两次均退出码 0 | `regression/full-suite-{1,2}.txt` |
| PHASE 00 套件 + 三门禁 | 退出码 0 | `regression/phase00-suite.txt`、`phase00-gates.json` |
| PHASE 01-A 冒烟（ready / quit-during-probe） | 退出码 0 | `regression/phase01a-{ready,quit}.txt` |
| PHASE 01-B MCP 握手 | 退出码 0 | `regression/phase01b-mcp.txt` |

先前那份 83/84 的满套件结果不再复现；连续两次完整通过，说明当时的不稳定更可能是并行负载下的时序问题，而不是稳定缺陷。

## 4. 未完成（阻断交付）

1. **Windows 安装版任务链路（场景 A/B/C）未执行** —— 这是本阶段唯一未验证的核心目标。
2. 泄漏门禁、敏感信息扫描、Git diff 检查未执行。
3. 证据完整性检查脚本未实现（`.log` 被 gitignore 的坑，本轮已先把原始输出改为 `.txt`）。

## 5. 结论

不满足 `READY_FOR_EXTERNAL_REVIEW` 的条件。不得关闭本阶段。
