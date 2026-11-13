## PHASE 02（READY_FOR_EXTERNAL_REVIEW）

- 分支 `phase/02-advisor-requirements-baseline`，基线 `ea6c593`。
- 顾问对话与 Session 映射、附件与上下文编译、研究报告、设计草稿/GDD 版本、正式基线冻结（规范化哈希 + 数据库触发器强制不可覆盖）、变更提案与影响分析、SQLite v3 迁移（11 张新表）、三栏顾问 UI 与冻结确认页。
- **验证**：应用全量 291/291；真实 DSH 顾问链路 11/11；真实 Electron 旅程 13/13（6 张真实截图）；PHASE 01-C/D 57/57；PHASE 00 门禁 PASS。
- **修复的真实缺陷**：应用从不读凭据、默认 provider 无凭据、顾问未调 `ensureProfile()`、只读 runtime 池过早关闭、冒烟看门狗硬编码、renderer 不知道已打开项目、空状态未隐藏、Markdown 原样显示、第二轮 session 冲突、影响分析分词方向反、上下文裁剪切掉最新消息。
- **能力实测**：`web_fetch` 与 `web_search` 均可用（走 commandcode provider）。
- 报告：`docs/review-handoff/PHASE_02_REPORT.md`；证据：`evidence/phase-02/`。

## PHASE 01-D 第三轮补正（READY_FOR_EXTERNAL_REVIEW）

- 基线 `2e061d8`，分支 `phase/01-d-project-workspace`。
- 修复：心跳失败后写任务不停止（现记 `PROJECT_LOCK_LOST` 并复用 `#stopActive` 关闭 Runtime，VERIFYING 前设闸门）；恢复校验只查 5 张表（现为 13 张，从迁移代码提取，备份检查与恢复校验共用同一常量）。
- 缺表备份在恢复前置检查阶段即被拒绝，避免逐表复制保留目标库旧数据。
- 测试：应用 248/248；锁丢失 12/12、数据库完整性 16/16、WAL 7/7、项目锁 9/9、在线备份 7/7、装配 8/8；PHASE 01-C 36/36；PHASE 00 门禁 PASS。
- 已知抖动：`processes.test.js` 的进程终止测试在并发负载下偶发失败，单独复跑与全量重跑均通过，已如实记录。
- 报告：`docs/review-handoff/PHASE_01_D_REMEDIATION_3_REPORT.md`；证据：`evidence/phase-01-d-remediation-3/`。

## PHASE 01-D 第二轮补正（READY_FOR_EXTERNAL_REVIEW）

- 基线 `53334cf`，分支 `phase/01-d-project-workspace`。
- 修复：生产装配未启用项目锁、projectId 未打通、锁心跳缺失、恢复检查用错集合、安全副本非快照、恢复校验恒真。
- 关键改动：抽出 `wireServices()` 供 main 与测试共用；心跳间隔 = staleAfterMs/4；安全副本改用 VACUUM INTO 且提前到校验之前；新增 `verifyDatabase()`。
- 测试：应用 227/227；装配 8/8、心跳 7/7、WAL 7/7、项目锁 9/9、在线备份 7/7、路径 8/8；PHASE 01-C 36/36；PHASE 00 门禁 PASS。
- 报告：`docs/review-handoff/PHASE_01_D_REMEDIATION_2_REPORT.md`；证据：`evidence/phase-01-d-remediation-2/`。

## PHASE 01-D 补正（READY_FOR_EXTERNAL_REVIEW）

- 基线 `bacd0eb`，分支 `phase/01-d-project-workspace`。
- 修复外部评审的三个问题：`resolveProjectPath` 无包含校验、`ProjectLocks` 未接入任务链路、备份恢复无应用调用链。
- 恢复改为事务内逐表复制行（不替换文件），因此活动连接无需关闭。
- 测试：应用 205/205；路径 8/8、项目锁 9/9、在线备份恢复 7/7；PHASE 01-C 生命周期 36/36；PHASE 00 门禁 PASS。
- 报告：`docs/review-handoff/PHASE_01_D_REMEDIATION_REPORT.md`；盘点：`..._AUDIT.md`；证据：`evidence/phase-01-d-remediation/`。

## PHASE 01-D（READY_FOR_EXTERNAL_REVIEW）

- 分支 `phase/01-d-project-workspace`，基线 `fa453c9`。
- 项目空间：创建/打开/关闭/配置，重启后恢复；数据模型作为 v2 迁移加入现有 SQLite。
- 安全：真实路径解析 + 分段比较（拒绝穿越/跨盘/UNC/junction 逃逸）；项目写锁与构建锁（行记录 + 心跳 + 过期回收）。
- 备份恢复：VACUUM INTO + 恢复前安全副本 + 关联校验。
- UI：五个一级入口，后三个明确标注待开发。
- 测试：应用 181/181，新增项目测试 55/55，桌面冒烟 9/9；PHASE 00 166/166 + 门禁 PASS。
- 报告：`docs/review-handoff/PHASE_01_D_WORK_REPORT.md`；证据：`evidence/phase-01-d/`。

## PHASE 01-B（APPROVED / PASS）

- 分支 `phase/01-b-mcp-packaging`，基线 `45c8976`。
- Studio MCP Server 换成官方 `@modelcontextprotocol/sdk@1.32.2`，工具 `get_studio_health` 完成真实端到端调用（开发环境 + 安装后各一次）。
- Windows 安装包 `AI-Game-Studio-0.1.0-x64.exe`（226.5 MB，SHA-256 `2C0491B4…`），静默安装后探测 READY、进程回收确认。
- 回归：应用测试 61/61、PHASE 00 套件 166/166、三门禁 PASS。
- 报告：`docs/review-handoff/PHASE_01_B_WORK_REPORT.md`；证据：`evidence/phase-01-b/`。
- 未做（后续阶段）：Session/Task/项目管理/Decision Center/素材库/构建流水线/React 重构。
- **关闭**：外部评审 2026-11-11 给出 PASS / PHASE_01_B_APPROVED。代码基线 `90b587d`，最终记录提交 `7d4248f`（只含文档与证据修正）。
- 遗留观察 O-01B-1：每次 MCP 连接会出现两个 Server 进程（server/discover 探针 + 服务进程），探针进程由 DSH 直接终止；安装后冒烟只确认 Runtime 与 GUI 退出，未单独记录探针 PID —— 后续生命周期监控补充。

# 当前交接

权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

- 当前项目：AI Game Studio。
- 当前阶段：**PHASE 00 已关闭 — `APPROVED`（PASS）**。下一步是 PHASE 01，不是继续微调 PHASE 00。收尾报告见 `docs/review-handoff/PHASE_00_CLOSURE_REPORT.md`。
- **唯一事实源**：`state/project_state.json` → **`phase_00_final`**（`authoritative_source.current_record` 声明）。
  `phase_00`、`phase_00_r1.gate_results`、`r11`…`r141` 全是历史快照，只读保留，勿引用为当前状态。
- 当前状态：冻结范围内 10 条门禁均有证据；六探针 **6/6 PASS**（最后一次完整真实运行
  `2026-11-10T12:43:44Z`，后续各轮未重复模型调用）；三道门禁（依赖 / 状态 / 脱敏）PASS。
- 8 项未解决问题**均不阻断** PHASE 00：U1–U7 = `DEFERRED`，**U8 = `BLOCKED`（环境限制，不解除）**；逐项登记在 `phase_00_final.deferred`（含阶段、风险、验证条件）；
  HY4 的 DSH 直连为独立 `UNKNOWN`，不阻塞、不伪造、不改架构。
- 运行组合：**DSH 0.2.1-rc.3（桌面端自带）+ commandcode 插件 0.15.4 + `deepseek/deepseek-v4.1-flash`**。PATH 上的 `dsh` 0.1.5-rc.1 不是目标版本。
- 阶段分支：`phase/00-feasibility`；**已推送**至 https://github.com/xiaoLin12130/ai_game_studio 。
- 交付提交 SHA：以分支 `phase/00-feasibility` 的 HEAD 为准；审查基准见 `phase_00_final.review_baseline_commit`。`phase_00_r1.r141` 为历史记录，不再作为交付指针。
  **报告不内嵌自身 SHA**，避免评审打开的固定提交与交付版本不一致。
- 尚无正式需求基线；**不得提前进入业务功能开发**。

## 一句话状态

DSH + commandcode + MCP 的技术链路早已证明可用；R1.4.1 收掉了最后一轮外部评审指出的四个门禁缺口，
并修正了「报告与 GitHub 固定提交不是同一份」这个交付流程问题。

## 下一会话先读什么

1. `docs/review-handoff/PHASE_00_R1_WORK_REPORT.md` — 头部「PHASE 00 最终结论」与末尾「最终验证与移交」是当前结论；其余章节是历史。
2. `state/project_state.json` → **`phase_00_final`** — **唯一事实源**。
3. `spike/dsh-probe/current-0.2.1/evidence/r14/README.md` — 每个证据文件属于哪次运行、数字为何不同。
4. `docs/decisions/ADR-0001-tech-stack.md`、`ADR-0002-dsh-integration.md` — 两个 `PROPOSED / CONDITIONAL` 决策。

## 复跑（Windows）

```powershell
cd spike\dsh-probe\current-0.2.1
npm install
$env:COMMANDCODE_API_KEY = "..."
npm test              # 163 项测试 + 六探针 + 三道门禁（消耗真实模型调用）
npm run test:unit      # 只跑 163 项测试；退出 0 才发布 tests.json（当前发布到 evidence/r153/tests.json）
npm run gates          # 只跑依赖/状态/脱敏三道门禁，写 evidence/r153/final-gates.json
npm run probe:exit     # CC-6：Runtime 退出码（close=0 / 强杀=1），不消耗模型额度
npm run lock:update    # 仅有意升级依赖时；随后必须重跑 npm test
```

```powershell
cd spike\dsh-probe
node scrub-evidence.mjs --check   # 全部发布文件；残留/读失败/空范围 → 退出 1
```

## 容易再犯的坑

1. **不要再让报告内嵌自身 Commit SHA。** 回填会改报告，导致「评审打开的固定提交」与「交付版本」不同。
   SHA 只放 state，由纯元数据提交回填，且该提交不改报告。
2. **探针默认 provider 会掩盖真实问题。** 必须断言 `request/header.config`；CC-0 是 CLI，不能用来证路由。
3. **门禁要可证伪。** 改规则后必须跑阳性/阴性对照：植入路径、改 integrity、删锁、注入失败。
4. **脚本化改写会破坏代码。** 曾把换行写成 `//n` 注释掉断言；也曾丢掉正则的 `g` 标志导致无限循环 OOM。
5. **不要在两个地方写同一份规则。** 唯一规则源 `src/lib/redact.mjs`；唯一输出层 `safe-output.mjs`；唯一扫描器 `scrub.mjs`。
6. **状态只能有一个当前记录。** 曾同时有 3 个文档各自宣布不同的「唯一权威」，其中旧对象里两条核心门禁
   仍标 `BLOCKED`（实际早已 PASS）。现在由 `authoritative_source.current_record` 指向 `phase_00_final`，
   `checkProjectState()` 会在任何探针运行前检查，失败即 exit 1。历史对象只读保留，不要删。
7. **WorkBuddy 能用 HY4 开发 ≠ DSH 能调 HY4。** 不得把 PHASE 00 的 DeepSeek 探针当成 HY4 兼容性证据，
   不得用私有/逆向接口当产品依赖，也不要为验证它改动 DSH Runtime 架构。

## 不要做的事

- **不要进入 PHASE 01。** 未收到明确的「复审通过，继续下一阶段」之前，后续阶段保持 `BLOCKED_BY_PREVIOUS_REVIEW`。
- **不要把 BLOCKED / UNKNOWN 改写成 PASS。**
- **不要升级用户的全局 DSH**，也不要在 `~/.dsh` 里增删 profile；验证一律用隔离 `DSH_HOME`。
- **不要改仓库可见性**（用户明确要求保持 public）。
- 不要把依赖版本改回 `^`；不要用 `--legacy-peer-deps` 绕过 peer 冲突装出缺包的树。

## 明确未验证与后续 PHASE 01 项

崩溃恢复（强杀 → resume）、中断轮次恢复、审批回调端到端、多跳 `request/header`、
多 Runtime 成本、Electron 打包链路、DSH 0.2.2、官方 MCP SDK 替换手写实现。

## 本机环境坑

`safe-delete` 安全垫会让 `fs.cpSync` 与批量 `fs.rmSync` 直接杀进程（exit 127、无输出）；
初始化脚本用手写递归复制。`npm ci` 偶发 EBUSY → staging 命中即复用 + 重试一次。
