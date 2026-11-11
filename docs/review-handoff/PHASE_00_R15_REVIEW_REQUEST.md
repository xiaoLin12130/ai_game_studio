# PHASE 00-R1.5｜收敛轮 + R15.1 / R15.2 / R15.3 修复轮 复审请求

> 权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

- 分支：`phase/00-feasibility`
- 评审固定点：**该分支 HEAD**（`phase_00_final.delivery_point.policy = branch-head`）。本文件刻意不写提交 SHA——写进去就要再提交一次，新提交又让那个 SHA 失效。
- 上一轮评审固定的提交：`6943618efa63b60193eda2749782b856ea54d58f`（R14 收尾）
- 再上一轮评审固定的提交：`36d0cfe`（R15 收敛轮，评审结论 PARTIALLY_VERIFIED）
- 再上一轮的上一轮：`89ee04c`（R15.1 修复轮，评审结论 PARTIALLY_VERIFIED）
- 再上一轮的上一轮：`b689fb9`（R15.2 修复轮，评审结论 PARTIALLY_VERIFIED）

## 0.000 R15.3：状态读取入口的最终隔离（本轮）

评审在 `b689fb9` 上确认了门禁 06 与门禁 04 的处理，但指出状态入口还有两个问题。
两处都成立，本轮修完，并且换了测试的断言方式。

### 0.000.1 发现逃逸却仍然读取

旧实现记录 `state-escape` 之后仍把词法路径交给 `fs.readFileSync()`——
**检测到了，但没有拒绝**。现在 containment 失败时：

```
violations.push(state-escape) → state = null → 不执行 readFileSync
                              → checkProjectState 返回 [state-escape, state-unreadable]
```

负向测试不再只断言"最终判定失败"：把仓库外的 `project_state.json` 写成**非法 JSON**，
断言 `loadStateCheck()` **不抛错**且 `state === null`。如果实现仍然去读，就必然抛解析错误。
这是从行为上证明外部文件没有被读取，而不是从错误码推断。

### 0.000.2 测试注入口被正式命令继承

`npm run gates` 原来直接读 `process.env.CC_STATE_FILE`，等于正式验收通道可以被指向仓库外。
新增 `officialStateFile(env)`：

| 环境 | 结果 |
|---|---|
| 无 `CC_STATE_FILE` | `{ok:true, file:null}` → 只读仓库内 `state/project_state.json` |
| 有 `CC_STATE_FILE`、无 `CC_TEST_MODE=1` | `{ok:false, code:'state-override-forbidden'}` → 正式门禁**明确失败** |
| 有 `CC_STATE_FILE` 且 `CC_TEST_MODE=1` | `{ok:true, testOverride:true}` → 仅测试注入 |

`scripts/run-gates.mjs` 与 `run-all.mjs` 都走这个判定；被拒绝时把
`state-override-forbidden` 写进门禁结果并 exit 1，不拿外部状态当权威。

另加 `CC_GATE_OUT`（测试用**输出**路径），让回归测试能跑真正的官方门禁脚本，
而不改写已发布的轮次目录。它只决定结果写到哪，不决定校验哪份权威。

### 0.000.3 新增负向测试 7 项

逃逸状态文件不得被读取；`officialStateFile` 的四种环境组合；
官方门禁 + 仓库外合法但错误的状态 → exit 1 且记录 `state-override-forbidden`；
官方门禁 + 仓库外非法状态 → 同样失败；官方门禁无注入 → exit 0 且实际校验仓库内状态。

回归测试：**156 → 163**。证据轮次：`evidence/r152/`（R15.2，冻结）→ `evidence/r153/`（本轮）。

## 0.0 R15.2：评审在 R15.1 上发现的三个问题（已修）

### 0.0.1 状态入口没有做真实路径校验（最严重）

R15.1 只把 containment 用在了 `checkEvidencePath()`，而 `loadStateCheck()` 仍在裸读：

```
repo/state               → (Junction) → <abs-path>/outside/
repo/docs/review-handoff → (Junction) → <abs-path>/outside/
```

两条入口都能把"决定门禁看什么"的输入换成仓库外的文件。现在：

- `state/project_state.json`：读取前经 `resolveContainedRealPath()`，逃逸记 `state-escape`；
- 8 份 `STATE_DOC_POINTERS`：逐份校验，逃逸记 `doc-escape`，且该文档同时缺席（`doc-set-incomplete` 会点名）；
- 读取一律用解析后的真实路径；
- 违规经 `loadStateCheck().violations` 进入 `checkProjectState()`，参与判定，不静默通过。

刻意例外：`CC_STATE_FILE` 是测试/运维注入口（回归测试要在仓库外注入坏状态），
该路径会 `realpath` 但不做仓库内 confinement——能改这个进程环境变量的人不需要这个口子。这一条写在代码注释里，供评审判断。

### 0.0.2 门禁 06 的证据规则仍然宽松

旧规则递归搜索任意整数 `exitCode`，所以 `{"metadata":{"exitCode":0},"runtime":{"processAfterClose":"UNKNOWN"}}` 能通过。现在改为结构化：

| 字段 | 要求 |
|---|---|
| `gracefulClose.exitCode` | 整数且为 0 |
| `forcedKill.exitCode` | 整数且与 graceful 不等（不等即证明是测出来的） |
| `gracefulClose.afterClose.status` | `PROCESS_ABSENT` |
| `forcedKill.afterKill.status` | `PROCESS_ABSENT` |
| 两个 `exitCodeSource` | 必须是 SDK 通道；出现 launcher/CLI 字样直接失败 |
| `noExitCodeReason` | 不得与 PASS 并存 |

`forcedKill` 要求"与 graceful 不同"而不是写死 1：1 是 Windows `TerminateProcess` 的表现，
写死等于把平台细节当协议契约；"不同"同样能证明该数字来自观测而非常量。

### 0.0.3 门禁 04 的状态表达

按范围原文判定，**不改验收含义**：

- 第 31 行：「事件/状态能够记录并在 UI 或 CLI 展示。」
- 全文 grep「实时」= **0 次**。

所以门禁 04 = **PASS**（记录 + 展示均已满足），实时事件流单独登记 `deferred.U9`（DEFERRED，`blocking:false`）。
`blocking_items` 现为空；两条能力限制移到 `limitations`。

回归测试：**143 → 156**（新增 13 项）。证据轮次：`evidence/r151/`（R15.1，冻结）→ `evidence/r152/`（R15.2，冻结）→ `evidence/r153/`（本轮的 R15.3 结果）。

## 0.1 R15.1：评审在 R15 上发现的两个验证器缺陷（已修）

评审在 `36d0cfe` 上认定门禁 06 的取证方式可接受、状态门禁进步最大，但同时指出
**验证器自身**还有两个边界问题。两处都属实，本轮已修，并各配一条能复现逃逸的负向测试。

### 0.1 链接逃逸：`staysInside()` 只看词法，不看真实目标

旧实现用 `path.resolve` 比较字符串前缀，因此下面这条路径**通过**检查：

```
repo/evidence/external-link  →  (Junction)  →  <abs-path>/outside/
repo/evidence/external-link/secret.json
```

词法上它在仓库内，但 `fs.statSync` / `fs.readFileSync` 会跟随链接读到仓库外的文件。
Windows 上**普通用户无需管理员权限即可创建 Junction**，所以这是可实际利用的路径。

修复：新增 `resolveContainedRealPath()`

1. 先做词法拒绝（`..`、绝对路径），不进文件系统；
2. 找到**最深的真实存在祖先**并 `realpath`（`fs.realpathSync.native`，可解析 Junction），
   因此**路径中间的链接组件也会被解析**；
3. 把不存在的尾部拼回去，再与仓库根的 `realpath` 用 `path.relative` 比较
   （win32 上大小写不敏感），而不是字符串前缀；
4. 证据读写改用解析后的真实路径。

### 0.2 门禁 06：`noExitCodeReason` 被当成退出码

旧规则同时接受整数 `exitCode` 和非空字符串 `noExitCodeReason`，等于允许只写
`{"noExitCodeReason": "SDK did not provide an exit code"}` 就满足门禁 06。

修复：**只接受整数 `exitCode`**。`noExitCodeReason` 不再满足 PASS，报错会明确写出
"理由是理由，不是退出码"。

### 0.3 新增负向测试（8 项）

junction 逃逸必须失败 / 仓库内链接必须放行 / 链接尾部缺失仍按祖先判定 /
`isInsideDirectory` 不是前缀比较 / 状态文件经链接逃逸必须失败 /
只有 `noExitCodeReason` 必须失败 / 整数 `exitCode` 必须通过 / 字符串 `exitCode` 必须失败。

**变异验证**：把两处修复人工回退后重跑，上述 3 条关键用例失败、其余全过；
恢复后文件 sha256 一致。

回归测试：**135 → 143**。证据轮次：`evidence/r15/`（R15，冻结）→ `evidence/r151/`（R15.1，冻结）→ `evidence/r152/`（R15.2，冻结）→ `evidence/r153/`（本轮）。

## 1. R15 轮只做了四件事

| # | 事项 | 动的是 |
|---|---|---|
| A | 重新独立核查 10 条门禁 | 只读，结论写进 `state/project_state.json` |
| B | 用受支持的方式取得 Runtime 真实退出码 | 新增 CC-6 探针 + 证据 |
| C | 修 `checkProjectState()` 完整性漏洞 | `src/lib/gates.mjs` + 测试 |
| D | 修状态与交接文档不一致 | 12 份文档 + 3 份 state |

没有做：重跑六探针、改阶段范围、进 PHASE 01、开发新功能。

## 2. 上一轮的三个缺口怎么补的

### 缺口一：门禁 6 被「改写」而不是「满足」

旧证据只有 `PROCESS_ABSENT`。旧 `PHASE_00_R1_EVIDENCE.md` §A7 自己承认把门禁改成
「进程树为空 + close 耗时」。阶段文件原文（第 33 行）从未修改。

现在：新增 `src/probe-runtime-exit.mjs`（`npm run probe:exit`），**0 次模型调用**。

| 场景 | 退出码 | 进程 |
|---|---|---|
| 正常 `close()` | **0** | `PROCESS_ABSENT` |
| 外部 `taskkill /F` | **1** | `PROCESS_ABSENT` |

取得通道：公开导出类型 `TransportClosedError` 的 message（`lib/types/client.d.ts` 明文写
"The message carries the exit code"），值来自 SDK 内部 `child.once('exit')`，即 SDK 亲自主
spawn 的那个子进程。**没有**用 CLI 启动器退出码，**没有**读私有字段。

### 缺口二：门禁 1 引用的是 0.1.5 旧清单

现在：`docs/phase-reports/PHASE_00_ENV_INVENTORY_DELIVERY.md` —— 交付环境
（DSH 0.2.1-rc.3 / SDK 0.2.1-rc.3 / protocol 0.2.1-rc.3 / cordis 4.0.5 / commandcode 0.15.4）
的真实盘点，逐条附命令与输出。

### 缺口三：门禁 4 在当前切片没有可复跑的 CLI 展示

现在：`src/studio-diag.mjs`（`npm run diag`）。
`live` 展示版本/连接/会话/回收/退出码；`--replay` 把真实录制运行的事件与状态时间线在 CLI 展开
（`running → idle → running → idle`）。transcript 落盘在 `evidence/cc-7-diag/cli-output.txt`。

## 3. 门禁本身被加固（这是本轮最容易被忽略的部分）

旧的 `checkProjectState()` 有三个可被利用的漏洞，现在全部堵死：

| 旧行为 | 现在 |
|---|---|
| 只查 `gates.length === 10` | 按 **10 个具名门禁 ID** 比对 |
| 只查文档数量 ≥ 4 | 按 **8 份具名路径**比对 |
| 只查 `fs.existsSync` | 普通文件 + 非空 + JSON/JSONL 可解析 + **不得路径穿越** |
| 门禁 6 内容不校验 | 证据必须含整数 `exitCode`（旧的 cc-3 证据现在会判失败） |
| 无判定一致性 | PASS 判定不得跑在门禁前面，也不得与 blocking_items 并存 |

回归测试 **107 → 143 → 156 → 163**，每条新用例都是一个「以前能通过」的利用手法。
另做过一次变异验证：把门禁人工削弱回旧逻辑，**恰好 7 条目标用例失败**，恢复后文件 sha256 一致。

## 4. 怎么验（三条命令，尽量别跑第四条）

```powershell
cd spike\dsh-probe\current-0.2.1

npm run test:unit    # 期望 163/163 PASS，exit 0；只有 exit 0 才发布 r153/tests.json
npm run gates        # 期望 dependency/state/leak 全 PASS，0 泄漏，exit 0
npm run probe:exit   # 期望 graceful=0 / forced=1，均 PROCESS_ABSENT，exit 0（0 模型调用）

npm test             # ← 会消耗真实模型调用，除非你要复核六探针，否则不要跑
```

## 5. 两处需要你判断的边界（我不替你判）

1. **门禁 6 的取证通道**：SDK 没有结构化访问器，退出码只能从已文档化的 message 文本解析。
   我据此判定「已满足原始措辞」。如果你认为「文本解析不算受支持的方式」，请把门禁 6 判回未满足。
2. **门禁 4 的展示**：`live` 模式不发 prompt（因此无实时事件流），事件/状态时间线来自
   **真实录制运行的回放**。如果你要求实时事件流，需要一次真实模型轮次，本轮未获准重跑。

## 6. 本轮没有动的东西

- `phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md` —— **一字未改**（`git diff 6943618..HEAD -- phases/` 为空）
- `spike/dsh-probe/current-0.2.1/evidence/r14/` —— 冻结，作为 2026-11-10 那次完整六探针运行的记录
- `spike/dsh-probe/legacy-0.1.5/` —— 冻结
- 六探针真实模型调用 —— **本轮 0 次**（时间戳仍为 2026-11-10T12:43:44.987Z）

## 7. 当前结论

`PHASE_00 = PARTIALLY_VERIFIED`，**没有**自行宣布 PASS。十条门禁现在都有直接证据，
但按 `phase_00_final.verdict_reason`，正式 PASS 需外部评审确认；确认前不进入 PHASE 01。
