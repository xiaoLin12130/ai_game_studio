# PHASE 00｜阶段关闭报告（Closure Report）

> 权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

## A. 基线信息

| 项 | 值 |
|---|---|
| 原始基线（评审固定） | `84d7a978b539a5a8c971e5e00cbc1c2c7caed3d7`（标签 `phase-00-r153`） |
| 分支 | `phase/00-feasibility` |
| 最终提交 | 以分支 HEAD 为准（`git rev-parse HEAD`）；本文件不内嵌自身 SHA，避免回填导致「评审打开的提交」与「交付版本」不一致 |
| 工作区 | 干净，与远端同步 |
| 验收依据 | `phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md`（**本轮未修改**） |

## B. 整体审查结果

一次性审查覆盖四段真实执行链路：权威状态读取、正式/测试命令入口、证据完整性、验证器本身。
共 6 个发现，其中 **P0 两个**、P1 两个、P2 两个。

| # | 发现 | 分级 | 是否本轮修复 |
|---|---|---|---|
| F1 | 全量运行 `npm test` 把结果写进冻结的 `eXevidence/r14/`，会覆盖唯一真实模型证据并使状态引用失效 | **P0** | 已修 |
| F2 | 内容规则只在 `.json/.jsonl` 分支执行，把门禁 06 证据指向 `.md` 即静默跳过校验并判 PASS | **P0** | 已修 |
| F3 | `testOverride` 计算后无人消费，注入运行与官方产物无法区分 | P1 | 已修 |
| F4 | 门禁 09 引用的是覆盖面更小的历史轮产物（173 文件），非当前发布集 | P1 | 已修 |
| F5 | 十条门禁仅 06 有内容规则，其余是「存在 + 可解析」 | P2 | 记录，移交 |
| F6 | `CC_GATE_ROUND=r14` 等显式变量仍可写回历史轮 | P2 | 记录，移交 |

### 没有发现问题的范围（逐条确认，非默认）

- 正常官方路径读取的权威状态就是仓库内 `state/project_state.json`（`REPO_ROOT` 计算正确）。
- `state/` 为 Junction → `state-escape` **且不读取**（用非法 JSON 哨兵证明）。
- 指针文档 Junction → `doc-escape`；证据 Junction/符号链接越界 → `gate-evidence-escape`。
- 缺文件 / 坏 JSON → `state-unreadable`；空 `CC_STATE_FILE` 视为无注入。
- 被拒的执行不运行模型探针（探针循环受 `!setupFailure && stateGate !== 'FAIL'` 保护，实测 total=0）。
- 测试框架不会吞掉失败：`test()` 只 catch 后计入 failed，退出码由失败数决定；`CC_TEST_FAIL_INJECT` 证明失败运行不发布结果。
- 十条门禁 ID 与阶段文件第 28–37 行逐条一一对应、顺序一致。
- `eXevidence/r14/summary.json` 与 HEAD blob 完全一致，`generatedAt=2026-11-10T12:43:44.987Z`、6/6 PASS、exit 0；r15/r151/r152/r153 自各自提交后未被改动。

## C. 修复结果

| 问题 | 修复 | 文件 |
|---|---|---|
| F1 | 全量运行改为发布到独立轮次目录 `CC_FULL_ROUND`（默认 `r154`），不再写 `eXevidence/r14/`；回归用例断言「不得在 `eXevidence/r14` 下产生写入」 | `run-all.mjs`、`tests/run-tests.mjs` |
| F2 | 若某门禁定义了内容规则，而证据扩展名不是 `.json/.jsonl`，直接判 `gate-evidence-content`（规则不可评估时必须失败，不得静默跳过） | `src/lib/gates.mjs` |
| F3 | 门禁产物新增 `stateSource: { kind: repository / test-injected, file }` 并打印 | `scripts/run-gates.mjs` |
| F4 | 门禁 09 证据改为当前轮次的全量脱敏扫描 | `state/project_state.json` |

新增测试 3 项：Markdown 证据必失败、无扩展名与 `.txt` 证据必失败、注入运行必须标记 `test-injected`；
另在既有套件用例中加入「全量运行不得写 r14」「官方产物必须标记 repository」。

变异验证：把 F2 的守卫改回不生效，两条目标用例立即失败；恢复后文件 sha256 与修改前一致。

## D. 验证结果

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node --check`（全部改动 `.mjs`） | SYNTAX_OK | 0 |
| `npm run test:unit` | **166/166 PASS** | 0 |
| `npm run gates` | dependency / state / leak 全 PASS，`stateSource=repository`，0 泄漏 | 0 |
| `npm run gates`（设置 `CC_STATE_FILE`） | REFUSED `state-override-forbidden`，不写产物 | 1 |
| `npm run probe:exit` | graceful=0 / forced=1，均 `PROCESS_ABSENT`，0 模型调用 | 0 |
| `npm run diag` | live 连接 + replay transcript | 0 |

- 证据完整性：`eXevidence/r154/` 为本轮产物；`r14 / r15 / r151 / r152 / r153` 全部冻结未改动（git 逐目录核对）。
- 真实模型探针：**未重跑**。六探针结论沿用 `eXevidence/r14/summary.json`（2026-11-10T12:43:44.987Z，6/6 PASS）。
- 工作区：干净。

## E. 最终阶段结论

**APPROVED（PHASE 00 正式通过）**

依据：

1. `phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md` 的 10 条验收门禁全部满足，且每条都有直接、可机器校验的证据；
2. `checkProjectState()` 独立校验通过（10 门禁 / 8 份指针文档 / 10 份证据 / 9 项 deferred / 3 项 unknown）；
3. 三道正式门禁（dependency / state / leak）全部 PASS，0 泄漏；
4. 本轮发现的两个 P0 已在同一批次修复并各有可复现的负向测试与变异验证；
5. 权威历史证据完整未被覆盖，唯一真实模型证据保持原始时间戳。

不阻断本阶段的已记录事项：U1–U9（U1–U7、U9 = DEFERRED，U8 = BLOCKED 环境限制）、K1–K3（UNKNOWN）、
以及 F5/F6 两条已记录限制。它们不影响上述任一条门禁的成立。

## F. PHASE 01 移交

**启动条件**：PHASE 00 已批准，可直接启动 PHASE 01；不再围绕 PHASE 00 做微调，除非发现影响本结论的实质缺陷。

**首批任务**

1. 按已验证的 DSH SDK 链路落地 Windows 本地应用基础与真实连接状态展示；
2. 官方 MCP SDK 兼容性冒烟（U5），替换 PHASE 00 的手写原型；
3. ADR-0001 §5 Electron 打包冒烟（U1），决定技术栈是否转正；
4. 崩溃恢复与中断轮次可靠性验证（U4 / U7）；
5. 产品决策：生产形态的 `DH_HOME 策略`（U2）。

**已知限制（不阻断，但需在 PHASE 01 记住）**

| 编号 | 内容 | 处理阶段 |
|---|---|---|
| limitation-1 | 退出码经 SDK 已文档化的 `TransportClosedError` message 文本取得，非结构化字段；SDK 升级后必须重跑 CC-6 | 升级前 |
| limitation-2 | 诊断 CLI 的事件/状态时间线来自真实录制运行的回放；实时事件流未重跑 | U9 / PHASE 01 |
| F5 | 除门禁 06 外，其余门禁的证据只校验「存在 + 可解析」，不校验内容是否支持该条款 | PHASE 01 质量改进 |
| F6 | 显式设置 `CC_GATE_ROUND=r14` 等变量仍可写回历史轮次目录 | 工程习惯约束 |

**DEFERRED / UNKNOWN 一览**

- U1 Electron 打包冒烟 · U2 DSH_HOME 策略 · U3 多 Runtime 资源占用 · U4 崩溃瞬间外部进程回收 ·
  U5 官方 MCP SDK 兼容 · U6 DSH 0.2.2 取消/审批能力 · U7 中断中的最后一轮 resume · U9 实时事件流
- U8 = **BLOCKED**（0.1.5 legacy 套件本机稳定复现，环境限制，不解除）
- K1 审批回调完整流程与 UI 映射 · K2 多跳 request/header · K3 未来版本能力
- HY4 经由 DSH 官方接口直连 = **UNKNOWN**，不阻断任何阶段

**明确不在 PHASE 00 处理的事项**：以上全部。PHASE 00 已完成，不再接受非阻断项驱动的追加修复。
