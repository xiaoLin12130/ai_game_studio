# evidence/phase-01-a — 每个文件属于哪一轮

本目录保留多轮证据。**当前结论以 R2 那一组为准**，更早的文件作为历史保留。

| 文件 / 目录 | 轮次 | 内容 |
|---|---|---|
| `verification.json` | **R2（当前）** | 完整验收矩阵：7 条实际执行的命令、退出码、耗时、计数、产物路径 |
| `app-tests.json` | **R2** | `node --test` 的结构化结果：53 项，0 fail，0 skipped |
| `build-typescript.txt` | **R2** | 类型检查编译输出 |
| `unit-and-integration-tests.txt` | **R2** | 全部测试的完整输出（已脱敏） |
| `desktop-smoke-ready.txt` 等三份 `desktop-smoke-*.txt` | **R2** | 三个桌面场景的控制台输出 |
| `phase00-regression-suite.txt` | **R2** | PHASE 00 套件（166 项）在本轮的回归输出 |
| `smoke/ready/` | **R2** | 场景一：握手成功、UI 显示已就绪；含窗口截图 |
| `smoke/failure/` | **R2** | 场景二：真实坏 profile；UI 显示不可用，并实际点击重新检测跑第二次 |
| `smoke/quit-during-probe/` | **R2** | 场景三：握手中途退出，runtime 被回收，进程表确认无残留 |
| `phase00-gates.json` | **R2** | PHASE 00 三道门禁的回归结果（未覆盖其 r154 证据） |
| `app-tests.txtB、`desktop-smoke/` | R1（提交 `c0cd5b9`） | 旧轮次产物，已被上面取代，保留不动 |

说明：完整输出使用 `.txt` 而不是 `.log` —— 仓库的 `.gitignore` 忽略 `*.log`，
用 `.log` 会得到「文档声称有日志、实际没有提交」的结果。

PHASE 00 的历史证据在 `spike/dsh-probe/current-0.2.1/evidence/` 下，本轮未触碰。
