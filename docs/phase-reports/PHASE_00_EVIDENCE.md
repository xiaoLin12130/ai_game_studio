# PHASE 00｜证据文件（Environment & Vertical Slice Evidence）

- 生成时间：2026-11-10
- 生成环境：本机（非模拟），Windows 10.0.19045.6466
- 对应报告：`docs/phase-reports/PHASE_00_REPORT.md`
- 复现目录：`spike/dsh-probe/`（`node run-all.mjs`）
- 证据原始数据：`spike/dsh-probe/evidence/`（17 个 JSON/JSONL 文件，逐条可查）

> 本文件的每条结论都必须能对应到下面某个命令输出或某个 evidence 文件。凡未取得证据的，标注 `BLOCKED` / `UNKNOWN`，不标注 PASS。

---

## 1. 环境清单（实测）

| 项 | 值 | 取得方式 |
|---|---|---|
| OS | Windows 10.0.19045.6466（`MINGW64_NT-10.0-19045`） | `cmd /c ver`、`uname -a` |
| 主机名 | <host> | `uname -a` |
| Node | v22.22.2 | `node --version` |
| npm | 10.9.7 | `npm --version` |
| pnpm | 11.21.0 | `pnpm --version` |
| yarn | **未安装** | `yarn --version` → command not found |
| Git | 2.55.0.windows.3 | `git --version` |
| Python | 3.13.14 / 3.14.7（`py`） | `python --version`、`py --version` |
| GitHub CLI | **未安装** | `gh --version` → command not found |
| DSH CLI（全局） | **0.1.5-rc.1**，包名 `@deepseek-ai/dsh` | `dsh --version` |
| DSH 全局安装路径 | `<user-home>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` | `cat .../npm/dsh`（shim 指向 `lib/bin.js`） |
| `DSH_HOME` 环境变量 | **未设置**，默认 `<user-home>\.dsh` | `echo $DSH_HOME` → 空 |
| 已有 DSH Profile | `desktop`、`githubtest`、`headless`、`web`、`web_backup` | `ls ~/.dsh/profiles` |
| Cocos Creator | **3.8.6** 已安装 | `<abs-path> 存在；目录名即版本 |
| 微信开发者工具 | **2.02.2608080** 已安装 | `<abs-path> 存在 |

补充事实：

- Cocos 安装目录下的 `version` 文件内容为 `31.3.1`，那是内置 Electron 运行时版本，**不是** Creator 版本；Creator 版本以编辑器官方的版本目录名 `3.8.6` 为准。
- 微信开发者工具不在 `Program Files`，而在 `<abs-path> 可执行（`-h/--help` 正常返回用法），但不提供 `--version`，版本取自应用包元数据。
- npm 上 `@deepseek-ai/dsh` 的 `latest` 已是 **0.2.2-rc.1**，本机全局安装落后一个大版本（0.1.5-rc.1）。本阶段所有结论绑定 **0.1.5 线**，升级必须重跑探针。

### 1.1 本阶段锁定的依赖（写在 `spike/dsh-probe/package.json`）

```json
"dependencies": {
  "@deepseek-ai/cordis": "4.0.2",
  "@deepseek-ai/cordis-plugin-group": "1.0.2",
  "@deepseek-ai/cordis-plugin-hmr": "1.0.17",
  "@deepseek-ai/cordis-plugin-include": "1.0.7",
  "@deepseek-ai/cordis-plugin-loader": "1.0.3",
  "@deepseek-ai/cordis-plugin-timer": "1.1.4",
  "@deepseek-ai/dsh-sdk-client": "0.1.5-rc.2",
  "@deepseek-ai/dsh-sdk-protocol": "0.1.5-rc.2"
}
```

为什么必须精确钉死：见 §2.2。

---

## 2. 官方 SDK 与版本兼容性

### 2.1 SDK 真实 API（来自已安装包的 `.d.ts` 与 README，非猜测）

`@deepseek-ai/dsh-sdk-client@0.1.5-rc.2` 暴露两层：

```ts
// 高层：Studio 实际使用的入口
const harness = new DeepSeekHarness({
  profile: 'sdk', dshHome, cwd, provider: 'deepseek-official',
  model: 'deepseek-v4-flash', maxTokens, requestTimeoutMs, initializeTimeoutMs,
  patches: ['./studio-mcp.cordis.yml'],
})
await harness.start()
const result = await harness.session(id).run(prompt, { onNotification })
await harness.close()   // 返回 RunResult { sessionId, finalResponse, events, notifications }

// 低层：协议级控制
const client = new HarnessClient({ profile: 'sdk', dshHome })
client.start()
const init = await client.initialize({ cwd, provider, model })  // → { serverInfo }
const messageId = await client.prompt(sessionId, [{ type: 'text', text }])
await client.request(method, params, timeoutMs)
client.subscribe(filter) / client.subscribeSessionTree(id)
await client.close()
```

协议方法只有 3 个请求 + 4 个通知（`dsh-sdk-protocol` 官方说明）：

| 方向 | 方法 | 载荷 |
|---|---|---|
| client→server | `initialize` | `InitializeParams{cwd,provider,model,reasoningEffort?,maxTokens?}` → `{serverInfo}` |
| client→server | `session/prompt` | `{sessionId, contentBlocks}` → `{messageId}`（仅入队回执） |
| client→server | `shutdown` | 无 → `{}` |
| server→client | `session.event` / `session.status` / `subagent.started` / `subagent.finished` | 见协议类型 |

### 2.2 依赖图冲突（真实踩坑，已解决）

直接 `npm i @deepseek-ai/dsh-sdk-client@0.1.5-rc.2` 会失败：

```
npm error code ERESOLVE
npm error Found: @deepseek-ai/cordis@4.0.2
npm error Could not resolve dependency:
npm error peer @deepseek-ai/cordis@"~4.1.0" from @deepseek-ai/cordis-plugin-timer@1.2.0
npm error   peer @deepseek-ai/cordis-plugin-timer@"^1.1.4" from @deepseek-ai/cordis-plugin-hmr@1.0.17
```

根因：`@deepseek-ai/dsh-app-boot` 以 **精确版本** 声明 peer（`cordis@4.0.2`、`cordis-plugin-group@1.0.2`、`cordis-plugin-include@1.0.7`…），而这些插件的 caret 范围会解析到要求 `cordis ~4.1.0` 的新版本，两端无法同时满足。

用 `--legacy-peer-deps` 能装上，但**装出来的树是坏的**：`@deepseek-ai/cordis-plugin-group` 缺失，运行时报

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis-plugin-group'
  imported from .../@deepseek-ai/dsh-app-boot/lib/index.js
```

最终解法：把 5 个 cordis 相关包按**全局可用的 `dsh@0.1.5-rc.1` 内部实际版本**精确写进 `dependencies`（见 §1.1），不再使用 `--legacy-peer-deps`，`npm install` 干净通过（`added 23 packages, removed 102 packages`）。

> 结论：**Studio 必须提交 lockfile 并精确钉版本**；否则「昨天能装，今天装不上」是必然事件。

### 2.3 冷启动与超时

| 场景 | 实测耗时 | 说明 |
|---|---|---|
| 首次冷启动（隔离 `DSH_HOME`，需物化 profile 的 `node_modules` 回退） | **73,129 ms** | 探针 A 首轮 |
| 需要重建模块回退的启动 | **116,466 / 118,998 / 128,688 ms** | 多次复现，见探针 A、G |
| 热启动（profile 已物化） | **2,252–2,582 ms** | 探针 A、G |

模块回退目录实测规模：`$DSH_HOME/profiles/node_modules` 共 **187 个条目，其中 164 个是符号链接**（其余 23 个为真实目录）。在 Windows 上重建这套链接是 2 分钟级别的工作量，这解释了「同样的启动，有时 2.5 秒、有时 2 分钟」。

SDK 默认 `initializeTimeoutMs` 为 **10,000 ms**。冷启动会直接超时报错：

```
Error: initialize timed out after 10000ms waiting for dsh profile "sdk"
```

→ 已把探针超时提到 180 s。Studio 必须分档（见 ADR-0002 D2）。

### 2.4 崩溃遗留的锁会让下次启动失败（真实缺陷，已精确定位）

`dsh-atomic-write` 的实现（`withFileLock`）：用 `flags: "wx"` 创建 `profiles/node_modules.lock`，内容写入 `process.pid`；遇到 `EEXIST` 只做退避重试，**不校验持有者 pid 是否存活**，直到 `DEFAULT_LOCK_WAIT_MS = 2000` 超时后抛错。`finally` 里 `rm(lockPath, { force: true })` —— 所以进程若在持锁期间被杀，锁就留在磁盘上。

复现实验（探针 G，用全新的 `DSH_HOME` 强制走 heal 路径，并预置一个 pid=999999 的锁文件）：

```
[probe] boot with stale lock (fresh home) {"exitCode":1,"ms":2719}
Error: atomic-write: timed out waiting for the writer lock at
       ...\tmp\dsh-home-locktest\profiles\node_modules.lock
```

而 SDK 对外只报：

```
dsh profile "sdk": JSON-RPC input closed
exit code: 1
```

即：**用户看到的是「连接被关闭」，真实原因是锁被一个已死的进程占着；启动被拖慢 2 秒后直接失败。** 本阶段实现了 `clearStaleProfileLock()`（读 pid → `process.kill(pid,0)` 探活 → 死则删）作为参考实现，实测可自愈（探针日志 `cleared stale profile lock {"stalePid":...}`）。

> 注意一个容易误判的细节：如果 `profiles/node_modules` 已经健康，启动根本不会去碰这把锁，此时「预置一个死锁」不会复现失败。第一次实现探针 G 时正是漏了这一点，得出了错误结论；现版本用全新 home 强制 heal 才成立。

---

## 3. 垂直切片结果总览

单一命令复现：`cd spike/dsh-probe && node run-all.mjs`

退出码语义：`0` 全 PASS；`2` 存在 BLOCKED（外部依赖阻断）；`1` 存在 FAIL。

最近一次完整运行：

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

（A 与 G 单次耗时包含 §2.3 的模块回退重建。）

### 3.1 为什么是 BLOCKED 而不是 PASS：账户余额

所有「模型必须产出文本」的断言都卡在同一个外部原因。事件流原文：

```json
{"type":"assistant/attempt","data":{"turn":1,"step":1,"stream":[
  {"type":"chunk","chunk":{"type":"finish","reason":{"kind":"error","failure":{
    "message":"Insufficient Balance (request_id: 262bb320-a771-4065-9fa2-b0f5c11a4f9a)",
    "code":"QUOTA","status":402}}}}]}}

{"type":"turn/end","data":{"turn":1,"reason":{"kind":"error","error":{
  "message":"Insufficient Balance (request_id: ...)","code":"QUOTA","status":402}}}}
```

同一账号问题在 **DSH 自身**上同样复现（排除本阶段代码嫌疑）：

```
$ dsh --profile headless "Reply with exactly one word: PONG"
dsh: QUOTA: Insufficient Balance (request_id: adb91a31-0e96-408e-b3fa-105f72fe0f9e)
```

→ 这是账号侧余额问题，不是 SDK 集成问题。解除方式见 `PHASE_00_REPORT.md` §6。

---

## 4. 探针 A｜SDK 启动 → 会话 → 事件 → 关闭（基础设施）

文件：`spike/dsh-probe/src/probe-basic.mjs`，证据：`evidence/a-basic-run/`

| 断言 | 结果 | 数值 |
|---|---|---|
| SDK 拉起 DSH Runtime | PASS | `startMs = 2,274 ms`（热启动） |
| 有真实 `dsh` 子进程 | PASS | 观察到 2 个后代进程（`node.exe` 运行 `dsh/lib/bin.js --profile sdk`） |
| 建立会话 | PASS | `sessionId = session-<32 hex>`（SDK 铸造） |
| 发送真实 Prompt | PASS | `session/prompt` 返回 `messageId`，进入 `agent/inbox/spliced` |
| 收到事件 | PASS | 单轮 `events = 15`，`notifications = 17` |
| 状态变化可见 | PASS | 通知方法集合 `["session.event","session.status"]`；状态序列含 `running` → `idle` |
| 关闭后进程消失 | PASS | `closeMs = 67 ms`，`dshChildGoneAfterClose = true`（OS 进程表复核） |
| 模型产出文本 | **BLOCKED** | `finalResponse = ""`，原因 `MODEL_QUOTA 402` |

事件种类（`evidence/a-basic-run/events.json`）：`agent/inbox/spliced`、`turn/start`、`step/start`、`system/message`、`user/message`、`request/header`、`request/context`、`session/title`、`assistant/attempt`、`step/end`、`turn/end`。足以驱动一个真实的运行态 UI。

## 5. 探针 B｜协议事实（无取消 / 无恢复）

文件：`src/probe-protocol.mjs`，证据：`evidence/b-protocol-facts/`

| 断言 | 结果 | 证据 |
|---|---|---|
| 握手返回真实身份 | PASS | `serverInfo = {name:"deepseek-harness-sdk-runtime", version:"0.0.1"}` |
| 状态机 `running → idle` | PASS | `statusSequence = ["running","idle"]`，`idleWaitMs = 826 ms` |
| 无 `session/cancel` | PASS（能力不存在） | `JsonRpcResponseError`: `unknown DeepSeek Harness SDK runtime method: session/cancel` |
| 无 `session/resume` | PASS（能力不存在） | 同上，方法名 `session/resume` |
| 无 `session/close` / `session/snapshot` | PASS（能力不存在） | 同上 |

**文档与实现不一致**：`dsh-sdk-protocol` README 写「未注册处理器返回 `-32601`」，实测返回 **`-32603`**（`unknownMethodErrorCode = -32603`）。判断「能力是否存在」不能用错误码，必须看消息文本。已记入 `docs/11_DECISIONS_AND_OPEN_QUESTIONS.md`。

## 6. 探针 C｜会话连续性与持久化

文件：`src/probe-resume.mjs`，证据：`evidence/c-resume/`

| 断言 | 结果 | 证据 |
|---|---|---|
| 第一轮后进程被回收 | PASS | `dshChildGoneAfterClose = true` |
| 会话日志落盘 | PASS | `sessions/--H-AI...workspace--/probe-resume-<ts>/session.v3.jsonl.zstd`，压缩后 **18,059 B** |
| 新进程复用同一 sessionId | **被拒绝** | `session "probe-resume-<ts>" already exists` |
| 日志可再次解压读取 | PASS | 首个 zstd 帧解出会话头：`{"type":"session","version":3,"id":"probe-resume-...","cwd":"<abs-path>","isSeeded":false,...}`（210 B） |

**结论 `NO_RESUME_AT_SDK_LEVEL`**：当前版本既不提供 `session/resume`，也不允许复用已存在的 sessionId。会话文件是**只增的压缩帧流**（首帧为会话头，后续帧为追加事件，探针未逐帧解码）。

对架构的影响：Studio 不能用「沿用旧 session」实现崩溃恢复，必须自己做上下文再水化（ADR-0002 D4）。

## 7. 探针 D｜「停止等待」≠「停止工作」

文件：`src/probe-cancel.mjs`，证据：`evidence/d-abandon/`

| 断言 | 结果 | 证据 |
|---|---|---|
| Agent 进入 `running` | PASS | `sawRunning = true` |
| 放弃等待后进程仍存活 | PASS | 等待 4,005 ms 后 `childStillAlive = true`，进程表可见 `node.exe` |
| 放弃等待后事件仍在到达 | PASS | 事件数 `6 → 18` |
| 关闭后进程消失 | PASS | `closeMs = 53 ms`，`childGoneAfterClose = true` |
| 放弃时 agent 仍在 `running` | **未满足** | 放弃时刻 `lastStatus = "idle"`（因 402 提前结束），`stillRunningAtAbandon = false` |

因此本探针判定为 **BLOCKED** 而非 PASS：**「进程不会因为你不再等待而消失」已证明**；但「长任务仍在推进」这一更强的断言需要一次真实的长 turn，被余额阻断。后续事件增加来自失败重试，不能包装成「仍在产出工作」。

## 8. 探针 E｜受控工具桥接（MCP）

文件：`src/probe-tools.mjs` + `mcp/studio-mcp-server.mjs`，证据：`evidence/e-tools/`

机制：`--patch` 注入 `@deepseek-ai/dsh-mcp-client`，由它 spawn Studio 的 stdio MCP server，工具以 `mcp__studio__get_studio_health` 暴露。

patch 文件（实测必须用 `insert:` 包裹）：

```yaml
- insert:
    - id: studio-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: studio
        transport: stdio
        command: '<node.exe 绝对路径>'
        args: ['<studio-mcp-server.mjs 绝对路径>']
        env: { STUDIO_MCP_AUDIT_LOG: '<审计日志绝对路径>' }
        failOnStartupError: true
        toolCallTimeoutMs: 30000
```

> 踩坑记录：写成裸行（不带 `insert:`）会得到 `patch: entry "studio-mcp" not found`——`mcp-client` README 里那个裸行示例是**配置树条目**，不是 `--patch` 文件格式。

| 断言 | 结果 | 证据 |
|---|---|---|
| Studio MCP server 被拉起并完成握手 | PASS | 审计日志 `kinds = ["server.started","initialize","notification","tools/list"]` |
| 协商的 MCP 版本与客户端 | PASS | `clientProtocolVersion = "2025-11-25"`, `clientInfo = {name:"dsh-mcp-client", version:"0.0.1"}` |
| Studio 工具进入模型工具清单 | PASS | `advertisedToolCount = 26`，其中含 `mcp__studio__get_studio_health` |
| 模型实际发起 `tools/call` | **BLOCKED** | 审计日志 `toolCalls = []`（模型未运行，402） |

审计日志原文（`evidence/e-tools/audit-records.json`）：

```json
{"kind":"initialize","clientProtocolVersion":"2025-11-25","clientInfo":{"name":"dsh-mcp-client","version":"0.0.1"}}
{"kind":"notification","method":"notifications/initialized"}
{"kind":"tools/list","count":1}
```

## 9. 探针 F｜并发与会话隔离

文件：`src/probe-concurrent.mjs`，证据：`evidence/f-concurrent/`

| 断言 | 结果 | 证据 |
|---|---|---|
| 两个 session 并行发起 | PASS | 单 Runtime 内 `Promise.all`，总耗时 709 ms |
| session 互不相同 | PASS | 两个不同 `session-<hex>` |
| 事件无串台（A） | PASS | runA 通知只含 `session-b36cf48f...` |
| 事件无串台（B） | PASS | runB 通知只含 `session-0168bc8c...` |
| 双方各自产出文本 | **BLOCKED** | 均为空（402） |

## 10. 探针 G｜退出码与陈旧锁

文件：`src/probe-exitcode.mjs`，证据：`evidence/g-exit-code/`

| 断言 | 结果 | 数值 |
|---|---|---|
| 正常关闭退出码为 0 | PASS | `dsh --profile sdk` 在 stdin 立即 EOF 后 `exitCode = 0`，耗时 2,582 ms，无 stderr |
| 陈旧锁导致启动失败 | PASS（缺陷已复现） | 全新 `DSH_HOME` + 预置 pid=999999 的锁 → `exitCode = 1`，耗时 2,721 ms |
| 失败信息指向锁 | PASS | stderr 含 `timed out waiting for the writer lock` |

说明：退出码取自启动器进程本身（`spawn` 的 `close` 事件），因为 SDK 的 `HarnessClient` 把 `exitCode` 保留为私有字段。这与门禁 6「记录退出码」的要求对应：**正常关闭 = 0，profile 启动失败 = 1**。

## 11. 未验证清单（不得当作已通过）

| 项 | 状态 | 原因 | 解除方式 |
|---|---|---|---|
| 模型真实回复 | `BLOCKED` | 账号 402 Insufficient Balance | 充值或换可用密钥 |
| 模型主动调用 Studio 工具 | `BLOCKED` | 同上；注册链路已 PASS | 同上，然后重跑探针 E |
| 长任务下「仍在工作」 | `BLOCKED` | 同上，无法制造长 turn | 同上，然后重跑探针 D |
| 工具审批回调 | `NOT_SUPPORTED` | 当前协议无 server→client 请求 | 无（等上游实现） |
| 运行中取消 | `NOT_SUPPORTED` | 无 `session/cancel` | 设计上以「关进程」替代 |
| 会话恢复 | `NOT_SUPPORTED` | 无 `session/resume`，sessionId 复用被拒 | Studio 自建再水化 |
| Python SDK 路线 | `UNKNOWN` | 未安装未验证 | 若需非 Node 宿主再评估 |
| `sdk-minimal` profile | `UNKNOWN` | 未验证能否挂 MCP | PHASE 01 评估（更小攻击面） |
| Electron 打包后运行 Runtime | `UNKNOWN` | 本阶段未打包 | PHASE 01 冒烟 |
| Cocos / 微信工具的实际调用 | `NOT_RUN` | 本阶段不涉及引擎与平台链路 | PHASE 06 |
| GitHub 推送 | `BLOCKED` | 仓库无 remote，且本机无 `gh` | 用户创建私有仓库并提供 URL |

## 12. 安全与合规检查

| 检查 | 结果 |
|---|---|
| 仓库内是否出现真实密钥 | 否。`spike/dsh-probe/package.json` 仅含包名与版本；无 token |
| 是否复制用户 `~/.dsh` 凭据 | 否。全程使用隔离 `DSH_HOME = spike/dsh-probe<abs-path> `.gitignore` 的 `tmp/` 覆盖 |
| 探针是否读取凭据内容 | 仅读取 `~/.dsh/.credentials.yaml` 的**键路径与长度**用于判断「环境变量密钥是否同一把」，未输出任何密钥值；对比结果为否（`env key substring present = false`） |
| 事件/日志是否含敏感信息 | 事件含 Prompt 文本与系统提示，属本阶段自造内容；审计日志仅含工具名与时间戳 |
| `node_modules`（291 MB）是否入库 | 否，被 `node_modules/` 忽略 |
| 会话二进制日志是否入库 | 否，位于 `tmp/`，被忽略 |
