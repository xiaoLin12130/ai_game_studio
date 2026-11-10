# 当前交接

- 当前项目：AI Game Studio。
- 当前阶段：PHASE 00 — **已完成执行，等待外部复审**。
- 当前状态：`PARTIALLY_VERIFIED`（核心链路已验证；模型层被账号余额阻断）。
- 阶段分支：`phase/00-feasibility`；**尚未推送**（仓库无 remote）。
- 尚无正式需求基线；不得提前进入业务功能开发。

## 一句话状态

DSH 的「启动 / 会话 / 事件 / 关闭 / 工具桥接注册」五条链路已在本机真实跑通并有证据；「模型产出内容」与「模型主动调用 Studio 工具」被 DeepSeek 账号 402 余额不足阻断，未验证。

## 下一会话先读什么

1. `docs/phase-reports/PHASE_00_REPORT.md` — 结论、门禁逐条核对、唯一阻塞项。
2. `docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md` — 给复审方的入口。
3. `docs/decisions/ADR-0001-tech-stack.md`、`ADR-0002-dsh-integration.md` — 两个待批准的技术决策。
4. `docs/phase-reports/PHASE_00_EVIDENCE.md` — 每条结论对应的原始数据。

需要复跑证据时：`cd spike/dsh-probe && node run-all.mjs`（退出码 0 全通过 / 2 有 BLOCKED / 1 有 FAIL）。

## 不要做的事

- **不要进入 PHASE 01。** 未收到明确的「复审通过，继续下一阶段」之前，后续阶段全部保持 `BLOCKED_BY_PREVIOUS_REVIEW`。
- **不要把 BLOCKED 改写成 PASS。** 探针 A/D/E/F 的模型类断言当前是 BLOCKED，原因写在 `state/project_state.json` 的 `phase_00.blocking_issue`。
- **不要升级 `@deepseek-ai/*` 版本** 而不重跑探针。协议是预发布态：全局 `dsh` 0.1.5-rc.1，npm latest 已是 0.2.2-rc.1。
- 不要把这些依赖的精确版本改回 `^`（会导致 `ERESOLVE`，或用 `--legacy-peer-deps` 装出缺包的坏树）。

## 未决项（等复审给方向）

1. ADR-0001 是否批准 Electron 方案（含把数据库选型推迟到 PHASE 01）。
2. ADR-0002 是否接受「无取消 / 无恢复」为既定约束，由 Studio 承接语义（上下文再水化）。
3. 生产形态用「每项目隔离 `DSH_HOME`」还是复用用户 `~/.dsh`（涉及用户重新授权成本）。
4. GitHub 私有仓库地址（用户创建后提供；Agent 不猜地址、不擅自建公开仓库）。

## 已知技术债（PHASE 01 首要处理）

- `spike/dsh-probe/mcp/studio-mcp-server.mjs` 是手写 MCP 实现，生产必须换 `@modelcontextprotocol/sdk`。
- `clearStaleProfileLock()` 目前只是探针里的参考实现，需落到 `RuntimeSupervisor`。
- 启动耗时 2.5 s vs 73–128 s 的双档体验未解决，需要评估安装期预热 profile。
