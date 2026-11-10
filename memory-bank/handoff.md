# 当前交接

- 当前项目：AI Game Studio。
- 当前阶段：**PHASE 00-R1.4（集中收尾）— 已完成，等待外部复审**。
- 当前状态：六探针 **6/6 PASS**，依赖门禁与脱敏门禁 **PASS**，回归测试 **68/68**，套件退出码 **0**。
- 运行组合：**DSH 0.2.1-rc.3（桌面端自带）+ commandcode 插件 0.15.4 + `deepseek/deepseek-v4.1-flash`**。PATH 上的 `dsh` 0.1.5-rc.1 不是目标版本。
- 阶段分支：`phase/00-feasibility`；**已推送**至 https://github.com/xiaoLin12130/ai_game_studio 。
- 复审基线：`<R14_SHA>`（回填后以 `state/project_state.json` 的 `r14.delivery_commit` 为准）。
- 尚无正式需求基线；**不得提前进入业务功能开发**。

## 一句话状态

DSH + commandcode + MCP 的技术链路在 R1 已证明可用；R1.4 把它固化成**可复现、可检查、可追责**的工程基线——
输出只有一个脱敏出口、依赖有 lockfile 与安装树指纹、门禁有反向测试证明会失败。

## 下一会话先读什么

1. `docs/review-handoff/PHASE_00_R1_WORK_REPORT.md` — 头部「R1.4 当前状态」是结论；末尾 §R1.4 是逐项证据。
2. `state/project_state.json` → `phase_00_r1.r14` — **唯一事实源**（验收、门禁、未验证项）。
3. `spike/dsh-probe/current-0.2.1/evidence/r14/` — 套件、门禁、回归测试、负向证明的机器可读记录。
4. `docs/decisions/ADR-0001-tech-stack.md`、`ADR-0002-dsh-integration.md` — 两个 `PROPOSED / CONDITIONAL` 决策。

## 已确认的能力（有证据）

| 能力 | 依据 |
|---|---|
| SDK 真实模型对话（commandcode） | CC-1：随机标识回显，每个 `request/header` 都是 commandcode |
| 模型真实调用 Studio MCP 工具 | CC-2：Server 审计到 `tools/call` + `tools/call.served` |
| Session Resume（正常关闭后重启） | CC-3：跨进程答出历史口令；不存在的 session 被拒 |
| 并发会话隔离 | CC-4：答案不互换、通知不串台、关闭后无残留 |
| 协议能力矩阵 | CC-5：方法级存在性 |
| CLI 链路 | CC-0：退出码 + 标识回显 + 模型自述（**无 `request/header`，不构成路由证明**） |

## 明确未验证（不要当成能力）

崩溃恢复（强杀 → resume）、中断中的最后一轮恢复、审批回调端到端、多跳 `request/header`、
多 Runtime 并发成本、Electron 打包链路、DSH 0.2.2 能力。

## 复跑（Windows）

```powershell
cd spike\dsh-probe\current-0.2.1
npm install
$env:COMMANDCODE_API_KEY = "..."
npm test                                  # 68 回归测试 + 6 探针 + 2 门禁
```

单跑门禁：

```powershell
cd spike\dsh-probe
node scrub-evidence.mjs --check           # 有残留 / 扫描失败 / 扫不到文件 → 退出 1
```

## 五个容易再犯的坑

1. **探针默认 provider 会掩盖真实问题。** 必须断言 `request/header.config`；CC-0 是 CLI，没有该事件，别用它证路由。
2. **门禁要可证伪。** 脱敏脚本曾因正则要求两个反斜杠而永远查不出真实路径。改动后必须跑一次阳性对照。
3. **脚本化改写会破坏代码。** 曾把换行转义写成字面量 `//n`，导致断言被 `//` 注释掉。改写后必须回读 + 实跑断言值。
4. **不要在两个地方写同一份规则。** 脱敏与检测共用 `src/lib/redact.mjs`；输出只有一个出口 `safe-output.mjs`。
5. **普通运行不生成锁。** 依赖升级只能走 `npm run lock:update`，随后必须重跑 `npm test`。

## 不要做的事

- **不要进入 PHASE 01。** 未收到明确的「复审通过，继续下一阶段」之前，后续阶段保持 `BLOCKED_BY_PREVIOUS_REVIEW`。
- **不要把 BLOCKED / UNKNOWN 改写成 PASS。**
- **不要升级用户的全局 DSH**，也不要在 `~/.dsh` 里增删 profile；验证一律用隔离 `DSH_HOME`。
- **不要改仓库可见性**（用户明确要求保持 public）。
- 不要把依赖版本改回 `^`；不要用 `--legacy-peer-deps` 绕过 peer 冲突去装出缺包的树。

## 已知技术债（PHASE 01 首要处理）

- `mcp/studio-mcp-server.mjs` 是手写 MCP 实现，生产必须换 `@modelcontextprotocol/sdk`。
- `clearStaleProfileLock()` 仍只是探针里的参考实现，需落到 `RuntimeSupervisor`。
- 启动耗时 2.5 s vs 73–128 s 的双档体验未解决，需要评估安装期预热 profile。
- 依赖门禁每次运行都会校验安装树哈希；若未来 profile 变大，需要评估耗时。
