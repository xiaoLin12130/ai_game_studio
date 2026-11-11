# 当前交接

- 当前项目：AI Game Studio。
- 当前阶段：**PHASE 00-R1.4.1（四项收口）— 已完成，等待外部复审**。
- 当前状态：六探针 **6/6 PASS**（最后一次完整真实运行 `2026-11-10T12:43:44Z`，R1.4.1 未重复模型调用）；
  最终门禁回归 **PASS/PASS**（173/173 发布文件、0 泄漏）；回归测试 **90/90 PASS**。
- 运行组合：**DSH 0.2.1-rc.3（桌面端自带）+ commandcode 插件 0.15.4 + `deepseek/deepseek-v4.1-flash`**。PATH 上的 `dsh` 0.1.5-rc.1 不是目标版本。
- 阶段分支：`phase/00-feasibility`；**已推送**至 https://github.com/xiaoLin12130/ai_game_studio 。
- 交付提交 SHA：见 `state/project_state.json` → `phase_00_r1.r141.delivery_commit`（由纯元数据提交回填）。
  **报告不内嵌自身 SHA**，避免评审打开的固定提交与交付版本不一致。
- 尚无正式需求基线；**不得提前进入业务功能开发**。

## 一句话状态

DSH + commandcode + MCP 的技术链路早已证明可用；R1.4.1 收掉了最后一轮外部评审指出的四个门禁缺口，
并修正了「报告与 GitHub 固定提交不是同一份」这个交付流程问题。

## 下一会话先读什么

1. `docs/review-handoff/PHASE_00_R1_WORK_REPORT.md` — 头部「R1.4.1 当前状态」是唯一当前结论；其余章节是历史。
2. `state/project_state.json` → `phase_00_r1.r141` — **唯一事实源**。
3. `spike/dsh-probe/current-0.2.1/evidence/r14/README.md` — 每个证据文件属于哪次运行、数字为何不同。
4. `docs/decisions/ADR-0001-tech-stack.md`、`ADR-0002-dsh-integration.md` — 两个 `PROPOSED / CONDITIONAL` 决策。

## 复跑（Windows）

```powershell
cd spike\dsh-probe\current-0.2.1
npm install
$env:COMMANDCODE_API_KEY = "..."
npm test              # 90 项测试 + 六探针 + 双门禁（消耗真实模型调用）
npm run test:unit      # 只跑 90 项测试；退出 0 才发布 tests.json
npm run gates          # 只跑依赖 + 脱敏门禁，写 final-gates.json
npm run lock:update    # 仅有意升级依赖时；随后必须重跑 npm test
```

```powershell
cd spike\dsh-probe
node scrub-evidence.mjs --check   # 全部发布文件；残留/读失败/空范围 → 退出 1
```

## 五个容易再犯的坑

1. **不要再让报告内嵌自身 Commit SHA。** 回填会改报告，导致「评审打开的固定提交」与「交付版本」不同。
   SHA 只放 state，由纯元数据提交回填，且该提交不改报告。
2. **探针默认 provider 会掩盖真实问题。** 必须断言 `request/header.config`；CC-0 是 CLI，不能用来证路由。
3. **门禁要可证伪。** 改规则后必须跑阳性/阴性对照：植入路径、改 integrity、删锁、注入失败。
4. **脚本化改写会破坏代码。** 曾把换行写成 `//n` 注释掉断言；也曾丢掉正则的 `g` 标志导致无限循环 OOM。
5. **不要在两个地方写同一份规则。** 唯一规则源 `src/lib/redact.mjs`；唯一输出层 `safe-output.mjs`；唯一扫描器 `scrub.mjs`。

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
