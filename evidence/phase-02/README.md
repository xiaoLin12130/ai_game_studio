# evidence/phase-02 — 索引

| 路径 | 内容 | 结果 |
|---|---|---|
| `unit/tsc.txt` | TypeScript 检查 | 退出码 0 |
| `unit/full-suite.txt` | 应用全量测试 | **291/291** |
| `unit/requirement-store.txt` | 需求存储与 v3 迁移 | **16/16** |
| `unit/requirement-services.txt` | 上下文/附件/基线/提案 | **19/19** |
| `advisor/advisor-chain.json` | 真实 DSH 顾问链路 | **11/11 步** |
| `desktop/summary.json` | 真实 Electron 旅程 | **13/13 检查** |
| `desktop/*.png` | 真实运行截图（6 张） | — |
| `capability/web-capability.json` | 联网能力实测 | fetch + search 均可用 |
| `regression/phase00-gates.json` | PHASE 00 门禁 | PASS，0 泄漏 |
| `regression/phase01a-ready.txt` | PHASE 01-A 冒烟 | 退出码 0 |
| `regression/phase01b-mcp.txt` | PHASE 01-B MCP 握手 | 退出码 0 |
| `regression/phase01c-d-tasks.txt` | PHASE 01-C/D 任务与锁 | **57/57** |
| `regression/phase01d-projects.txt` | PHASE 01-D 项目冒烟 | 退出码 0 |
| `verification.json` | 命令总表与验收对照 | — |

## 截图说明

`desktop/*.png` 是**真实运行截图**：真实 Electron 窗口、真实点击、真实 DSH 模型回复。
不是测试夹具。summary.json 中 `kind: "REAL_RUN"` 标明这一点。

## 关于真实模型调用

`advisor-probe.mjs` 与 `smoke-advisor.mjs` 都调用真实模型，消耗少量配额。
凭据从 `~/.dsh/.credentials.yaml` 读取，**未写入任何证据文件**。

历史阶段证据（PHASE 00/01-A/01-B/01-C/01-D 及其三轮补正）未被修改。
