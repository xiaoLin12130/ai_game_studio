# External Review Handoff｜PHASE 00 外部复审交接

- Product：AI Game Studio
- Phase：**PHASE 00 — 技术可行性与 DSH 最小垂直切片**
- Repository URL：`https://github.com/xiaoLin12130/ai_game_studio`（public）
- Branch：`phase/00-feasibility`
- Full Commit SHA：`5658479016fda62989a52baaf257c174cc897e02`（审查基线；本文件后续回填提交会使其略新，以 `git rev-parse HEAD` 为准）
- Status：**`PARTIALLY_VERIFIED`** — 核心链路已验证；模型层被账号余额阻断

---

## 1. 本阶段希望评审者重点检查

1. **是否接受 `PARTIALLY_VERIFIED` 这个判定**，而不是把「基础设施全通、模型没跑」写成 PASS。判定依据在 `docs/phase-reports/PHASE_00_REPORT.md` §5。
2. **ADR-0001（Electron）的取舍是否成立**：核心论据是「DSH Runtime 与官方 SDK 都是 Node，双运行时（Tauri + sidecar）只为外壳语言付复杂度」。
3. **ADR-0002 对四个「不存在的官方能力」的处理是否诚实且可实施**：无取消 → 关进程；无恢复 → Studio 自建上下文再水化；无工具审批 → 审批全部留在 Studio 侧；工具只走 MCP。
4. **是否认同把数据库选型推迟到 PHASE 01**。
5. **探针本身是否可信**：断言是否够硬、有没有把 BLOCKED 洗成 PASS、有没有硬编码路径或吞错。

## 2. 关键代码路径

| 路径 | 作用 |
|---|---|
| `spike/dsh-probe/src/probe-basic.mjs` | A：SDK 启动 → 会话 → Prompt → 事件 → 关闭 |
| `spike/dsh-probe/src/probe-protocol.mjs` | B：协议事实，用真实 JSON-RPC 调用证明 cancel/resume/close 不存在 |
| `spike/dsh-probe/src/probe-resume.mjs` | C：会话持久化与 sessionId 复用行为 |
| `spike/dsh-probe/src/probe-cancel.mjs` | D：放弃等待 ≠ 停止进程 |
| `spike/dsh-probe/src/probe-tools.mjs` | E：MCP 工具桥接（生成 patch + 校验审计日志） |
| `spike/dsh-probe/src/probe-concurrent.mjs` | F：并发会话与事件隔离 |
| `spike/dsh-probe/src/probe-exitcode.mjs` | G：退出码与陈旧锁缺陷复现 |
| `spike/dsh-probe/src/studio-diag.mjs` | 最小诊断壳（CLI）：展示连接/版本/会话/事件/错误/回收 |
| `spike/dsh-probe/mcp/studio-mcp-server.mjs` | Studio 只读 MCP tool server（仅 `get_studio_health`） |
| `spike/dsh-probe/src/lib/outcome.mjs` | PASS / BLOCKED / FAIL 三态判定与退出码语义 |
| `spike/dsh-probe/src/lib/proc.mjs` | OS 进程探测 + `clearStaleProfileLock()` 参考实现 |
| `spike/dsh-probe/run-all.mjs` | 汇总运行器（含单探针超时保护） |

## 3. 关键产品行为（本阶段实际具备的）

- 能通过官方 SDK 启动真实 DSH Runtime，并在关闭后确认 OS 进程消失。
- 能建立会话、发送 Prompt、收到 15 条结构化事件与 `running → idle` 状态变化。
- 能把 Studio 的只读业务信息（`get_studio_health`）注册进模型的工具清单。
- 能在崩溃残留锁的情况下识别并自愈启动失败。

**不具备**（当前 DSH 版本本身不支持，非本阶段未做）：运行中取消、会话恢复、工具审批回调。

## 4. 测试/构建命令与结果

```bash
cd spike/dsh-probe
npm install            # exit 0（需按 package.json 精确 pin；直接装 latest 会 ERESOLVE）
node run-all.mjs       # exit 2
```

最终一次完整运行（控制台原文：`spike/dsh-probe/evidence/_aggregate/run-all-console.txt`）：

```
BLOCKED A-basic-run      (exit 3, 118998ms)
PASS    B-protocol-facts (exit 0, 2554ms)
PASS    C-resume         (exit 0, 5910ms)
BLOCKED D-abandon        (exit 3, 8640ms)
BLOCKED E-tools          (exit 3, 3639ms)
BLOCKED F-concurrent     (exit 3, 3322ms)
PASS    G-exit-code      (exit 0, 130313ms)

PASS 3/7  BLOCKED 4  FAIL 0
```

退出码约定：`0` 全 PASS；`2` 存在 BLOCKED；`1` 存在 FAIL。**当前为 2，不是 0。**

另有独立验证（非探针）：

```bash
dsh --version                                    # 0.1.5-rc.1
dsh --profile sdk --help                          # exit 0，SDK stdio 服务可用
dsh --profile headless "Reply with ... PONG"      # dsh: QUOTA: Insufficient Balance  ← 证明阻塞来自账号而非集成
printf '' | DSH_HOME=<隔离> dsh --profile sdk     # exit 0（干净关闭）
```

## 5. 证据文件

- `docs/phase-reports/PHASE_00_EVIDENCE.md` — 环境清单 + 逐项测量 + 原始输出
- `spike/dsh-probe/evidence/*/summary.json` — 每个探针的断言与判定
- `spike/dsh-probe/evidence/a-basic-run/events.json`、`timeline.json` — 真实事件流
- `spike/dsh-probe/evidence/e-tools/audit-records.json` — DSH 连入 Studio MCP server 的审计记录
- `spike/dsh-probe/evidence/g-exit-code/summary.json` — 退出码与陈旧锁复现
- `spike/dsh-probe/evidence/_aggregate/run-all.json`、`run-all-console.txt` — 整轮汇总

## 6. 已验证事实（CONFIRMED）

| 事实 | 证据 |
|---|---|
| `@deepseek-ai/dsh-sdk-client@0.1.5-rc.2` 可驱动 `dsh@0.1.5-rc.2` | 探针 A/B，`serverInfo = deepseek-harness-sdk-runtime 0.0.1` |
| 启动耗时为双峰：热 2.2–2.6 s / 重建模块回退 73–128 s | 探针 A、G 多次 |
| 关闭后进程真实退出；干净退出码 0，失败启动退出码 1 | 探针 A/D/G + OS 进程表 |
| 协议只有 initialize / session/prompt / shutdown | 协议类型定义 + 探针 B |
| 无 cancel、无 resume、无 session-close | 探针 B：`-32603 unknown ... method` |
| sessionId 复用被拒 → `NO_RESUME_AT_SDK_LEVEL` | 探针 C |
| 工具桥接只能走 MCP；`insert:` 包裹是 `--patch` 的硬要求 | 探针 E + `patch: entry "studio-mcp" not found` |
| Studio 工具确实进入模型工具清单（26 个中之一） | 探针 E `request/header` |
| 单 Runtime 可并行两 session，事件不串台 | 探针 F |
| 依赖必须整族精确钉版本 | `ERESOLVE` 与 `ERR_MODULE_NOT_FOUND` 两次实测 |

## 7. 推荐但未验证（RECOMMENDED / NOT_VERIFIED）

- ADR-0001 推荐 Electron —— 未做打包验证。
- 上下文再水化替代 session 恢复 —— 未做原型验证，成本未量化。
- 安装期预热 profile 可消除 2 分钟首启动 —— 未验证。
- `sdk-minimal` profile 更小攻击面 —— 未验证能否挂 MCP。
- 生产用 `@modelcontextprotocol/sdk` 替换手写 MCP server —— 未实施。

## 8. 阻塞事项（BLOCKED）

| 编号 | 阻塞 | 需要谁做 | 解除后能看到什么 |
|---|---|---|---|
| B-001 | DeepSeek 账号余额不足（HTTP 402 `QUOTA`） | 用户充值或提供有余额的 `DEEPSEEK_API_KEY` | 门禁 3、5 转 PASS；A/D/E/F 从 BLOCKED 转 PASS |
| ~~B-002~~ | ~~仓库无 remote / 网络不通~~ **已解除** | — | 叠加原因：git 未走本机代理 `127.0.0.1:7890`，且本机凭据属于 `vJackLin2v` 而仓库属主是 `xiaoLin12130`。已按仓库级指定代理与账号（未改全局配置），于 2026-11-10 18:13 推送成功 |

解除 B-001 后执行 `cd spike/dsh-probe && node run-all.mjs`，期望退出码 `0`。

## 9. 已知偏离/风险

| 项 | 说明 |
|---|---|
| 全局 `dsh` 落后 | 本机 0.1.5-rc.1，npm `latest` 已 0.2.2-rc.1。所有结论绑定 0.1.5 线；升级须重跑探针 |
| 文档与实现不一致 | 未知方法返回 `-32603` 而非文档所称 `-32601`；已在代码里改用消息文本判定 |
| MCP server 为手写实现 | 为免依赖；生产需替换为官方 SDK |
| 探针 G 曾有错误结论 | 首版未强制走 heal 路径，误判「伪造死锁不阻塞」；已修正为全新 home 强制 heal 后才成立，并写入 EVIDENCE §2.4 备注 |
| 探针 A/D 的「仍有产出」不可采信 | 402 下事件继续到达来自失败重试，故 D 判定 BLOCKED 而非 PASS |

## 10. 需要用户/评审者决定

1. 是否批准 ADR-0001（Electron）与「数据库延后到 PHASE 01」。
2. 是否接受 ADR-0002 的四个能力缺口处理方式。
3. 生产 `DSH_HOME` 隔离粒度：每项目隔离 vs 复用 `~/.dsh`。
4. 是否先充值解除 B-001，再复审本阶段（推荐顺序：充值 → 复跑 → 复审）。

## 11. 下一阶段是否允许启动

**NO — 等待明确外部复审结论。**

当前状态 `PARTIALLY_VERIFIED`，按 `phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md` 的结束状态约定，本阶段不得标记 PASS，也不得进入 PHASE 01。

---

## 提交信息（已回填）

- 审查基线提交：`5658479016fda62989a52baaf257c174cc897e02`（已在远端）
- 分支：`phase/00-feasibility`
- 工作区状态：干净（`git status --porcelain` 为空）
- 远端状态：**已推送**，远端 `refs/heads/phase/00-feasibility` 与该 SHA 一致
- 提交序列：`91a44d8` 阶段实施 → `ad94dae` 回填 SHA → `b3fdfb7` 诊断壳 → `5658479` 工作报告
- 审查以该分支最新 HEAD 为准；其后仅为本文件的推送信息回填提交，不含功能改动

克隆与复现：

```bash
git clone -b phase/00-feasibility https://github.com/xiaoLin12130/ai_game_studio.git
cd ai_game_studio/spike/dsh-probe
npm install && node run-all.mjs
```

> 仓库为 public，评审方可只读 clone。若后续改为 private，需另行提供 ZIP 或访问授权。
