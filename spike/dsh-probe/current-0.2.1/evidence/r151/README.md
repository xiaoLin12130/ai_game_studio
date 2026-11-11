# evidence/r151 — R15.1 修复轮（当前）的证据说明

> 权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

## 为什么又多了一个目录

外部评审在 `36d0cfe`（R15 轮）上发现两个**验证器自身**的边界缺陷：

1. `staysInside()` 是纯词法检查，不跟随链接。仓库内一个指向仓库外的 Windows Junction
   可以让 `evidence/external-link/secret.json` 通过词法检查，而 `fs.statSync` /
   `fs.readFileSync` 会正常跟随链接读到仓库外的文件。Windows 上**普通用户即可创建 Junction**，
   所以这不是理论问题。
2. 门禁 06 的内容规则同时接受整数 `exitCode` 和非空字符串 `noExitCodeReason`，
   等于允许"用『没有退出码』的解释"冒充"已经记录退出码"。

| 目录 | 记录什么 | 状态 |
|---|---|---|
| `evidence/r14/` | 2026-11-10 最后一次完整六探针真实模型运行 | 冻结 |
| `evidence/r15/` | R15 轮（评审对象 `36d0cfe`）的门禁与测试回归 | 冻结，不再改写 |
| `evidence/r151/` | **R15.1 修复轮**（本轮）的门禁与测试回归 | 当前 |

## R15.1 修了什么

| 缺陷 | 修复 |
|---|---|
| 链接逃逸 | 新增 `resolveContainedRealPath()`：先词法拒绝 → 找到**最深的真实存在祖先**并 `realpath`（覆盖路径中间的 junction/symlink）→ 拼回不存在的尾部 → 与仓库根的 `realpath` 比较。证据改为通过真实路径读取 |
| 门禁 06 允许解释替代退出码 | 内容规则改为**只接受整数 `exitCode`**；`noExitCodeReason` 不再满足 PASS，并单独给出"理由是理由、不是退出码"的报错 |
| 缺对应负向测试 | 新增 8 项：junction 逃逸、仓库内链接放行、链接尾部缺失、`isInsideDirectory` 非前缀语义、状态文件经链接逃逸、只有 reason 必须失败、整数通过、字符串 `exitCode` 失败 |

回归测试：**135 → 143**。

## 本轮结果

| 文件 | 内容 |
|---|---|
| `tests.json` | 143/143 PASS，exit 0 |
| `final-gates.json` | dependency / state / leak 三道门 PASS，0 泄漏，exit 0 |

## 复现

```powershell
cd spike\dsh-probe\current-0.2.1
npm run test:unit     # 143 项；只有 exit 0 才发布 r151/tests.json
npm run gates         # 三道门禁；写 r151/final-gates.json
npm run probe:exit    # 退出码探针（0 模型调用）
npm run diag          # 诊断 CLI（0 模型调用）
npm test              # 完整链路：测试 + 六探针 + 门禁（会消耗真实模型调用，本轮未跑）
```

轮次目录由 `CC_GATE_ROUND` 决定（默认 `r151`）。
