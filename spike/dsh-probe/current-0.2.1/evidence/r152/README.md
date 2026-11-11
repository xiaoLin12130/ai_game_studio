# evidence/r152 — R15.2 修复轮（当前）的证据说明

> 权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

## 为什么还有一轮

外部评审在 `89ee04c`（R15.1）上确认两处修复有效，但指出**安全边界只铺了一半**：
`checkEvidencePath()` 已按真实路径校验，而 `loadStateCheck()` 仍直接 `readFileSync`，
于是 `state/` 或 `docs/review-handoff/` 本身可以是指向仓库外的 Junction。
另外门禁 06 的规则仍是"JSON 任意位置出现整数 exitCode 即通过"，过于宽松。

| 目录 | 记录什么 | 状态 |
|---|---|---|
| `evidence/r14/` | 2026-11-10 最后一次完整六探针真实模型运行 | 冻结 |
| `evidence/r15/` | R15 轮（评审对象 `36d0cfe`） | 冻结 |
| `evidence/r151/` | R15.1 修复轮（评审对象 `89ee04c`） | 冻结 |
| `evidence/r152/` | **R15.2 修复轮**（本轮） | 当前 |

## R15.2 修了什么

### 1. 状态入口也做真实路径校验

`loadStateCheck()` 现在：

- 仓库自带的 `state/project_state.json`：读取前经 `resolveContainedRealPath()` 校验，逃逸则记录 `state-escape` 违规并**仍然判失败**；
- 8 份 `STATE_DOC_POINTERS`：逐份校验，逃逸记录 `doc-escape` 且该文档同时从 `docs` 中缺席（于是 `doc-set-incomplete` 也会点名）；
- 读取一律使用**解析后的真实路径**；
- 违规通过 `loadStateCheck().violations` 传到 `checkProjectState()`，成为判定的一部分，不静默通过。

一个刻意的例外：`CC_STATE_FILE` 是测试/运维注入口（回归测试要在仓库外注入被改坏的状态），
该路径会 `realpath` 但不做仓库内 confinement。理由写在代码注释里——能设置该进程环境变量的人不需要这个口子。

### 2. 门禁 06 改为结构化校验

不再递归搜索任意 `exitCode`。现在要求：

| 字段 | 要求 |
|---|---|
| `gracefulClose.exitCode` | 整数，且等于 0 |
| `forcedKill.exitCode` | 整数，且与 graceful **不相等**（不等则证明是测出来的） |
| `gracefulClose.afterClose.status` | `PROCESS_ABSENT` |
| `forcedKill.afterKill.status` | `PROCESS_ABSENT` |
| 两个场景的 `exitCodeSource` | 必须是 SDK 通道（`exit-handler` / `post-close-subscribe` / `transport-closed-error`），出现 launcher/CLI 字样直接失败 |
| `noExitCodeReason` | 不得与 PASS 并存 |

`forcedKill.exitCode` 要求"与 graceful 不同"而不是写死 1：1 是 Windows `TerminateProcess` 的表现，
写死会把平台细节当成协议契约；"不同"同样能证明这个数字来自观测而不是常量。

### 3. 门禁 04 状态统一

按范围原文判定，**不改验收含义**：

- 第 31 行：「事件/状态能够记录并在 UI 或 CLI 展示。」
- 全文 grep「实时」= **0 次**。

因此门禁 04 = **PASS**（记录 + 展示都已满足），实时事件流单独登记为 `deferred.U9`（DEFERRED，`blocking:false`）。
`blocking_items` 现为空；两条能力限制移到 `limitations`。

## 本轮结果

| 文件 | 内容 |
|---|---|
| `tests.json` | 156/156 PASS，exit 0 |
| `final-gates.json` | dependency / state / leak 三道门 PASS，191 个发布文件，0 泄漏，exit 0 |

回归测试：143 → 156（新增 13 项）。

## 复现

```powershell
cd spike\dsh-probe\current-0.2.1
npm run test:unit     # 156 项；只有 exit 0 才发布 r152/tests.json
npm run gates         # 三道门禁；写 r152/final-gates.json
npm run probe:exit    # 退出码探针（0 模型调用）
npm run diag          # 诊断 CLI（0 模型调用）
npm test              # 完整链路：测试 + 六探针 + 门禁（会消耗真实模型调用，本轮未跑）
```

轮次目录由 `CC_GATE_ROUND` 决定（默认 `r152`）。
