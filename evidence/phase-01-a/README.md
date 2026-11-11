# evidence/phase-01-a — 每个文件属于哪一轮

本轮（修复轮 R1）与上一轮产出的证据都保留在这里，避免新旧数字混看。

| 文件 / 目录 | 属于哪一轮 | 内容 |
|---|---|---|
| `verification.json` | **R1（当前）** | 完整验收矩阵：4 项的真实命令、退出码、耗时、产物路径 |
| `app-tests.json` | **R1** | `node --test` 的结果：45 项，0 fail，0 skipped |
| `unit-and-integration-tests.log` 等四个 B*.log` | **R1** | 每一项的完整原始输出（已脱敏） |
| `smoke/ready/` | **R1** | 冒烟场景一：握手成功、UI 显示已就绪 |
| `smoke/failure/` | **R1** | 冒烟场景二：真实坏 profile，UI 显示不可用 |
| `smoke/quit-during-probe/` | **R1** | 冒烟场景三：握手中途退出，runtime 被回收 |
| `phase00-gates.json` | **R1** | PHASE 00 三道门禁的回归结果（未覆盖其 r154 证据） |
| `app-tests.txt` | 上一轮（提交 `8c760bd`） | 旧的 33 项测试输出，已被上面的 json 取代 |
| `desktop-smoke/` | 上一轮（提交 `8c760bd`） | 旧的单场景冒烟，已被 `smoke/ready/` 取代 |

上一轮的文件是历史记录，保留不动；当前结论以上表上半部分为准。
