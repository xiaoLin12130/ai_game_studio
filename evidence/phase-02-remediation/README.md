# evidence/phase-02-remediation — 索引

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite.txt` | 应用全量测试 | **344/344** |
| `unit/research.txt` | 研究服务与来源溯源 | **15/15** |
| `unit/candidate.txt` | 候选版本与历史不可变 | **19/19** |
| `unit/docx.txt` | DOCX 真实文件解析 | **10/10** |
| `unit/state.txt` | 全局状态一致性 | **9/9** |
| `unit/requirements.txt` | 需求存储与服务 | **35/35** |
| `unit/project-isolation.txt` | 项目隔离 | **40/40** |
| `research/research-chain.json` | 真实研究链路 | **12/12 步** |
| `regression/phase00-gates.json` | PHASE 00 门禁 | PASS，0 泄漏 |
| `regression/phase01a-ready.txt` | PHASE 01-A 冒烟 | 退出码 0 |
| `regression/phase01b-mcp.txt` | PHASE 01-B MCP 握手 | 退出码 0 |
| `regression/phase01c-d-tasks.txt` | PHASE 01-C/D 任务与锁 | **57/57** |
| `regression/phase01d-projects.txt` | PHASE 01-D 项目冒烟 | 退出码 0 |
| `verification.json` | 命令总表与五个问题的结论 | — |

## 桌面证据

本轮新增的截图在 `evidence/phase-02/desktop/`：`07-proposal-approved.png`、`08-candidate-ready.png`、
`09-new-baseline.png`、`10-research-page.png`，与原有 6 张一起由 `summary.json` 索引（18 项检查全通过）。

## 关于真实模型调用

`research-probe.mjs` 与 `smoke-advisor.mjs` 调用真实模型，消耗少量配额。
凭据从 `~/.dsh/.credentials.yaml` 读取，**未写入任何证据文件**。

历史阶段证据（PHASE 00/01-A/01-B/01-C/01-D 及其三轮补正、PHASE 02 原始证据）未被修改。
