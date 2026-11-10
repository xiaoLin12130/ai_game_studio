# evidence/ 说明（PHASE 00-R1 之后）

这个目录里有两类证据，**不要混着读**。

## 1. `current-0.2.1/evidence/` —— 生产决策依据

`spike/dsh-probe/current-0.2.1/` 对应 **DSH 0.2.1-rc.3 + 用户实际 commandcode 插件**，这是用户日常真正运行的组合。

```
cd spike/dsh-probe/current-0.2.1 && node run-all.mjs      # 期望 PASS 5/5, exit 0
```

| 目录 | 证明什么 |
|---|---|
| `cc-0-cli-baseline/` | CLI 通过 commandcode 完成真实推理，回显随机标识 |
| `cc-1-reply/` | SDK 真实对话，且断言 `request/header.config.provider === commandcode` |
| `cc-2-tools/` | 工具三阶段：server 起 → 进清单 → **模型调用 + Server 执行** |
| `cc-3-resume/` | `session/resume` 重启后恢复历史（`RESUME_RESTORES_HISTORY`） |
| `cc-4-concurrent/` | 两会话并行、答案不互换、无残留 |
| `cc-5-capability/` | 方法级能力矩阵 |

## 2. 本目录（`spike/dsh-probe/evidence/`）—— 0.1.5 legacy 基线

对应 **DSH 0.1.5-rc.2**。它有两个问题，读的时候必须知道：

1. **Provider 不对**：0.1.5 无法加载 commandcode 0.15.4（插件要求 `>=0.2.1-rc.2 <0.2.2`），运行时静默回退到 `deepseek-official`，才有了 402。
2. **当前不可稳定复现**：本机通过 `NODE_OPTIONS` 注入的 `safe-delete` 安全垫会中止 DSH 的 profile 维护删除，导致套件整体 BLOCKED/FAIL。

因此：

- **权威的 0.1.5 记录**是冻结快照 `spike/dsh-probe/legacy-0.1.5/evidence/`（在安全垫干扰出现之前采集）。
- 本目录下的文件是最近一次复跑的结果，只用于说明「修正后的探针在敌对环境下如何自我判定」（三态检测、环境干扰归类）。
- **不要把本目录的 BLOCKED/FAIL 当作 DSH 或 commandcode 的能力结论。**

## 3. 关于 FAIL 的读法

修正后的探针遵循三条：

- 查询失败 ≠ 什么都没发现（`PROCESS_CHECK_FAILED` 单独一态）。
- 外部条件导致测不了 → `BLOCKED`，不是 `PASS` 也不是 `FAIL`。
- 本机安全垫干扰 → `BLOCKED`，并在 `environmentInterference` 字段记录原因。

所以看到 FAIL 时，先看 `summary.json` 里的 `error` / `environmentInterference` 字段，再判断是不是我们自己的问题。
