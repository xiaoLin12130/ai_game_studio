# 当前交接

- 当前项目：AI Game Studio。
- 当前阶段：**PHASE 00-R1.3（第四轮复审整改）— 已完成，等待外部复审**。
- 当前状态：生产目标链路已用用户真实 provider 跑通，**干净目录 6/6 PASS**；0.1.5 legacy 套件在本机不可稳定复现（环境安全垫）。
- 运行组合：**DSH 0.2.1-rc.3（桌面端自带）+ commandcode 插件 0.15.4 + `deepseek/deepseek-v4.1-flash`**。PATH 上的 `dsh` 0.1.5-rc.1 不是目标版本。
- 阶段分支：`phase/00-feasibility`；**已推送**至 https://github.com/xiaoLin12130/ai_game_studio 。
- 复审基线：`1985fb010684de4abd2bb6b9ea54cf06360ffc1e`。
- 尚无正式需求基线；**不得提前进入业务功能开发**。

## 一句话状态

Studio 能通过官方 DSH SDK 驱动用户实际使用的 commandcode 模型，并让模型真实调用 Studio 的 MCP 工具；证据体系（脱敏、依赖锁、断言粒度）直到 R1.3 才真正可作为验收基线。

## 下一会话先读什么

1. `docs/review-handoff/PHASE_00_R1_WORK_REPORT.md` — 含 R1.1 / R1.2 / R1.3 三轮修正，是唯一完整叙述。
2. `state/project_state.json` → `phase_00_r1` — **单一事实源**（门禁、能力矩阵、未解决项）。
3. `docs/decisions/ADR-0001-tech-stack.md`、`ADR-0002-dsh-integration.md` — 两个 `PROPOSED / CONDITIONAL` 决策。
4. `spike/dsh-probe/README.md` — 怎么复跑（6 个探针 + 脱敏门禁）。

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

崩溃恢复（强杀 → resume）、中断中的最后一轮恢复、审批回调完整流程与 UI 映射、
多跳 `request/header`（每轮目前只观测到 1 个）、多 Runtime 并发成本、
Electron 打包后的完整链路、DSH 0.2.2 能力。

## 复跑（Windows）

```powershell
cd spike\dsh-probe\current-0.2.1
npm install
$env:COMMANDCODE_API_KEY = "..."
npm test                                  # setup-profiles → 6 探针
```

脱敏门禁：

```powershell
cd spike\dsh-probe
node scrub-evidence.mjs --check           # 有残留即退出 1
```

## 三个容易再犯的坑

1. **探针默认 provider 会掩盖真实问题。** 必须断言 `request/header.config`，否则运行时回退到
   `deepseek-official` 之后的 402 会被误当成「用户模型不可用」。CC-0 是 CLI，没有该事件，别用它证路由。
2. **门禁要可证伪。** 脱敏脚本曾因正则要求两个反斜杠而永远查不出真实路径，
   `0 residual` 是假的。以后每次改动都要跑一次阳性对照（放一个假路径，确认退出 1）。
3. **脚本化改写会破坏代码。** 早前把换行转义写成了字面量 `//n`，导致两条路由断言被 `//` 注释掉，
   报告却声称「两轮都查」。改写后必须回读，并用 `node --check` + 实际断言值确认。

## 不要做的事

- **不要进入 PHASE 01。** 未收到明确的「复审通过，继续下一阶段」之前，后续阶段全部保持 `BLOCKED_BY_PREVIOUS_REVIEW`。
- **不要把 BLOCKED / UNKNOWN 改写成 PASS。**
- **不要升级用户的全局 DSH**，也不要在 `~/.dsh` 里增删 profile；验证一律用隔离 `DSH_HOME`。
- **不要改仓库可见性**（用户明确要求保持 public）。
- 不要把这些依赖的精确版本改回 `^`（会导致 `ERESOLVE`，或用 `--legacy-peer-deps` 装出缺包的坏树）。

## 未决项（等复审给方向）

1. ADR-0001 是否批准 Electron 方案（含把数据库选型推迟到 PHASE 01）。
2. ADR-0002 的恢复策略、Runtime 动态调度与审批双通道是否成立。
3. 生产形态用「每项目隔离 `DSH_HOME`」还是复用用户 `~/.dsh`（涉及用户重新授权成本）。
4. Electron 打包后的冒烟测试清单是否足够（7 条，见 ADR-0001）。

## 已知技术债（PHASE 01 首要处理）

- `spike/dsh-probe/mcp/studio-mcp-server.mjs` 是手写 MCP 实现，生产必须换 `@modelcontextprotocol/sdk`。
- `clearStaleProfileLock()` 目前只是探针里的参考实现，需落到 `RuntimeSupervisor`。
- 启动耗时 2.5 s vs 73–128 s 的双档体验未解决，需要评估安装期预热 profile。
