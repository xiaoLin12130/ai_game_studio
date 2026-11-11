# evidence/r153 — R15.3 修复轮（当前）的证据说明

> 权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

## 为什么还有一轮

外部评审在 `b689fb9`（R15.2）上确认门禁 06 与门禁 04 的处理，但指出状态入口仍有两个问题：

1. **发现了逃逸却仍然去读**：`loadStateCheck()` 记录 `state-escape` 之后，仍把词法路径交给
   `fs.readFileSync()`，而它会跟随 Junction。检测不等于拒绝。
2. **测试注入口被正式命令继承**：`npm run gates` 读的是 `process.env.CC_STATE_FILE`，
   于是正式门禁可以被指向仓库外的文件。

| 目录 | 记录什么 | 状态 |
|---|---|---|
| `evidence/r14/` | 2026-11-10 最后一次完整六探针真实模型运行 | 冻结 |
| `evidence/r15/` | R15（评审对象 `36d0cfe`） | 冻结 |
| `evidence/r151/` | R15.1（评审对象 `89ee04c`） | 冻结 |
| `evidence/r152/` | R15.2（评审对象 `b689fb9`） | 冻结 |
| `evidence/r153/` | **R15.3**（本轮） | 当前 |

## R15.3 修了什么

### 1. 逃逸的状态文件不再被读取

`loadStateCheck()` 现在的分支：

```
containment 失败 → violations.push(state-escape)
                 → state = null，不执行 readFileSync
                 → checkProjectState 返回 [state-escape, state-unreadable]
```

负向测试不再只断言"最终判定失败"，而是把仓库外的 `project_state.json` 写成**非法 JSON**：
如果实现仍然去读，就必然抛解析错误；测试断言"不抛错、`state === null`、带 `state-escape` 违规"，
从行为上证明外部文件没有被读取。

### 2. 测试注入口与正式验收通道隔离

新增 `officialStateFile(env)`：

| 环境 | 结果 |
|---|---|
| 无 `CC_STATE_FILE` | `{ok:true, file:null}` → 读仓库内 `state/project_state.json` |
| 有 `CC_STATE_FILE`、无 `CC_TEST_MODE=1` | `{ok:false, code:'state-override-forbidden'}` → 正式门禁**明确失败** |
| 有 `CC_STATE_FILE` 且 `CC_TEST_MODE=1` | `{ok:true, testOverride:true}` → 仅测试注入 |

`scripts/run-gates.mjs` 与 `run-all.mjs` 都走这个判定；被拒绝时把
`state-override-forbidden` 写进门禁结果并 exit 1，而不是拿外部状态当权威。

另加 `CC_GATE_OUT`（测试用输出路径），让回归测试可以跑真正的官方门禁脚本而不改写已发布的轮次目录。

### 3. 新增负向测试 7 项

- 逃逸的状态文件**不得被读取**（外部放非法 JSON）
- `officialStateFile`：无注入 / 有注入无测试模式 / 空字符串 / 测试模式注入
- 官方门禁 + 仓库外**合法但错误**的状态 → exit 1 且记录 `state-override-forbidden`
- 官方门禁 + 仓库外**非法**状态 → exit 1 且同样记录
- 官方门禁无注入 → exit 0，且实际校验的是仓库内状态（10 条门禁）

## 本轮结果

| 文件 | 内容 |
|---|---|
| `tests.json` | 163/163 PASS，exit 0 |
| `final-gates.json` | dependency / state / leak 三道门 PASS，0 泄漏，exit 0 |

回归测试：156 → 163（新增 7 项）。

## 复现

```powershell
cd spike\dsh-probe\current-0.2.1
npm run test:unit     # 163 项；只有 exit 0 才发布 r153/tests.json
npm run gates         # 三道门禁；写 r153/final-gates.json
npm run probe:exit    # 退出码探针（0 模型调用）
npm run diag          # 诊断 CLI（0 模型调用）

# 正式门禁拒绝测试注入：
$env:CC_STATE_FILE = "<abs-path>\fake-state.json"
npm run gates         # 期望 exit 1，错误码 state-override-forbidden
```

轮次目录由 `CC_GATE_ROUND` 决定（默认 `r153`）。
