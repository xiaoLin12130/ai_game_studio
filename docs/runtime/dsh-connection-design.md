# DSH 连接与就绪判定（PHASE 01-A）

权威状态：PHASE 01-A 的状态记录在 `state/phase_01_a.json`；PHASE 00 的权威记录仍为
`state/project_state.json` → `phase_00_final`。

## 1. 「已就绪」的定义

> **就绪 = 用一个真实的 dsh 可执行文件，在隔离的 DSH home 上启动 SDK runtime，
> 在超时内完成 `initialize` 握手并拿到 `serverInfo`，然后关闭并确认进程退出。**

这个定义刻意比「文件存在」强，比「模型能回答」弱。原因：

| 判据 | 能证明 | 为什么不够 / 为什么足够 |
|---|---|---|
| 可执行文件存在 | 路径对 | DSH 是插件化运行时，包在不等于是跑得起来 |
| 版本号可读 | 装的是哪一版 | 版本对也不代表插件树能挂载 |
| 端口监听 | 某个服务在听 | DSH SDK 走 stdio，没有端口 |
| 历史成功过 | 过去可用 | 现在的环境可能已经坏了 |
| **SDK initialize 握手成功** | **runtime 起得来、插件树加载完成、该 provider/model 路由可解析、双向 JSON-RPC 通** | 本阶段采用 |

握手在服务端做的事（由 SDK 服务端实现决定）：先等插件加载落定，再检查 provider 适配器，
再 `resolveCallConfig` 解析路由，最后返回 serverInfo。因此「握手成功」不是「进程起来了」的同义词。

## 2. 它证明什么、不证明什么

**证明**：DSH runtime 能用当前 profile 与 home 启动；插件树挂载完成；当前 provider/model
路由存在；stdio JSON-RPC 双向可用；关闭后进程确实退出。

**不证明**（必须记住，不要越界解读）：

1. 不证明模型真的能回答：探测不发 prompt，因此不验证凭据、额度、网络、模型可用性。
2. 不证明版本匹配：实测 0.1.5-rc.1 的 dsh 也能完成同一套握手，且 `serverInfo.version` 恒为
   `0.0.1`（是协议版本，不是 DSH 版本）。**版本单独读包 manifest**。
3. 不证明 Studio 真正要用的 route 可用：探测用配置里的 provider/model，若与实际任务用的不同，
   结论不迁移。
4. 不证明用户自己 `~/.dsh` 里的第三方插件可用：探测用隔离 home + 内置 `sdk` profile。
5. 不证明工具、沙箱、终端、文件系统行为；不证明长跑与并发稳定。
6. 不证明退出干净：带第三方插件的 profile 在 Windows 上实测出现 teardown 崩溃
   （`0xC0000409`），与握手无关。**因此退出码只作诊断字段，不作为就绪门槛。**

## 3. 探测实现

位置：`apps/studio/src/main/dsh/probe.ts`

```
client = new HarnessClient({ dshHome, profile: 'sdk', initializeTimeoutMs, env })
client.start()
await client.initialize({ cwd, provider, model })   // 唯一握手，不发 prompt
serverInfo ← 返回值
await client.close()                                // 等 runtime 真正退出
exitCode  ← TransportClosedError 消息里的 "exit code: <n>"
```

两条 Electron 相关的硬约束：

1. **子进程必须带 `Electron_RUN_AS_NODE`**：SDK 用 `process.execPath` 启动 runtime，
   在 Electron 里那是 `electron.exe`，默认按 GUI 启动，永远不说 JSON-RPC，表现为「握手超时」。
2. **Electron 必须是 44.7.0**：DSH 原生 addon 有运行时白名单，45.x 会被拒绝
   （详见 `docs/architecture/desktop-architecture.md` §3）。

## 4. 失败分类

分类函数是纯函数（`src/shared/status.ts`），锚点全部取自本机真实报错：

| 现象 | 状态 | code | 典型耗时 |
|---|---|---|---|
| 找不到模块 / 二进制缺失 | UNAVAILABLE | BINARY_MISSING | < 60 ms |
| profile 不存在 | UNAVAILABLE | PROFILE_MISSING | ~190 ms |
| home 目录不可用（ENOTDIR / 权限） | UNAVAILABLE | HOME_UNUSABLE | ~190 ms |
| profile 清单损坏（非法 JSON） | UNAVAILABLE | PROFILE_MANIFEST_INVALID | ~200 ms |
| profile bundle 缺失（挂起型） | UNAVAILABLE | PROFILE_DEGRADED | 跑满超时 |
| provider/model 无适配器 | FAILED | ROUTE_UNKNOWN | ~1.7 s |
| 超时 | TIMEOUT | TIMEOUT | = 超时值 |
| 其它 transport 关闭 | FAILED | INIT_FAILED | 不定 |
| 空结果 | UNKNOWN | INTERNAL_ERROR | — |

**空结果一律 UNKNOWN，绝不默认就绪。**

## 5. 实测耗时（本机，Electron 44.7.0 + 内置 sdk profile，隔离新 home）

| 场景 | 耗时 |
|---|---|
| 首次探测（home 自动创建 profile） | ~1.7 s |
| 后续探测 | ~1.7 s |
| 失败（profile 缺失） | ~0.19 s |
| 桌面冒烟端到端（启动 → 渲染 → 握手 → 截图 → 退出） | ~2.5 s |

默认超时 60 s（可配置，范围 1–300 s）。按上游调查，最坏毛刺可达 5.3 s，因此预算不应小于 15 s。

## 6. 单飞与取消

- 同一时刻只允许一个探测：第二个请求会 **join** 正在跑的那个（日志 `dsh.probe.join`），
  不会叠加第二个 runtime 进程。
- 关闭应用时取消探测；探测自身负责回收 runtime 子进程。
- 本阶段**不做定时轮询**：只有「启动时一次 + 用户手动重新检测」，避免高频探测与并发失控。

## 7. 隔离

- Studio 使用自己的 `<userData>/dsh-home`，从不写入或复用用户 `~/.dsh`。
- home 不存在时由 dsh 自动创建内置 `sdk` profile，无需联网、无需凭据。
- 探测不读取、不修改用户的任何 DSH 配置。

## 8. Runtime 生命周期与退出

### 8.1 所有权

一次探测只拥有它自己 spawn 的那个 runtime，并且负责到「确认退出」为止。没有全局的 Runtime
管理器，也没有第二套清理路径。

### 8.2 退出时的顺序

```
before-quit 被拦截 (preventDefault)
      ↓
service 标记为关闭 —— 之后新探测请求被拒绝
      ↓
probe.stop()（幂等）—— 立刻开始 teardown，并打断等待握手的那一段
      ↓
client.close()（上界 15s）
      ↓
操作系统进程表查询（决定性判据）
      ↓
若仍存在：验明归属 → 定向终止 → 再次查询（上界 6s）
      ↓
写 dsh.shutdown.result 日志
      ↓
app.exit()：confirmedGone 为 false 时用非零退出码
```

### 8.3 什么才算「清理完成」

两个不同的概念，实现里分开：

| 字段 | 含义 | 条件 |
|---|---|---|
| `completed` | **干净路径成功** | SDK `close()` 成功 **且** OS 明确 ABSENT **且** 没有 shutdown 超时 |
| `confirmedGone` | **安全属性成立** | OS 明确 ABSENT（可以是 close 成功，也可以是兜底终止之后） |

- 只有 `completed` 才允许探测返回 **READY**。握手成功但没能确认 runtime 已退出时，返回
  `UNKNOWN` + `TEARDOWN_UNCONFIRMED`，界面不会显示健康状态。
- 退出码由 `confirmedGone` 决定：进程可能还活着就绝不 exit 0。

### 8.4 三条证据，各自的作用

| 信号 | 来源 | 在判定中的作用 |
|---|---|---|
| `close()` resolve | SDK | 干净路径的必要条件 |
| `exit code: <n>` 消息 | SDK 的 exit 事件 | **仅诊断**，记录进日志，不是成功判据 |
| 进程表查询 | 操作系统 | **决定性判据**：只有 ABSENT 才算「没有残留」 |

早期版本把退出码写成「第三重确认」，那是错的：退出码和 close 来自同一侧，而且第三方插件在
Windows 上实测会出现 teardown 崩溃（`0xC0000409`）却仍然完成回收。退出码现在是诊断字段。

**`null`（无法确定）与 `false`（确认存在）同样被当作未清理成功**，两者都不会被解释为 PASS。

### 8.5 兜底回收

当 OS 报告仍有进程（PRESENT）时：

1. 逐个 PID 重新读取命令行，确认其中仍包含本次探测的 DSH home；不匹配则跳过、不杀。
2. 用 `taskkill /F /T /PID <pid>` 定向终止（**绝不**用 `/IM node.exe` 这类广谱终止）。
3. 轮询进程表直到 ABSENT 或 6 s 上界。
4. 只有再次查询到 ABSENT，才记录 `forcedTerminationSucceeded` 与 `processAbsent: true`。

如果进程检查本身失败（FAILED），**不会**触发终止——无法证明归属就不能杀。此时 `completed`
与 `confirmedGone` 都为 false，日志保留错误原因。

### 8.6 失败与超时的处理

- close 上界 15 s；shutdown 上界 20 s；进程终止上界 6 s。
- 超时或回收失败：`timedOut: true` / `completed: false` / `confirmedGone: false`，日志 level=error。
- 退出流程另有 +5 s 兜底定时器：即使清理卡死，进程也会以非零码退出，并在日志中留下残留 PID 风险记录。
- 绝不把 UNKNOWN 当作成功。

### 8.7 已知边界

- 进程查询与终止仅在 Windows 实现；其它平台返回 FAILED，记为未知，不当作已退出。
- 归属判据是「命令行包含该 DSH home」，同机另一个使用同一 home 的 Studio 实例会被算作残留（保守方向）。
- SDK 没有运行时级取消协议（PHASE 00 已验证 `session/cancel` = NOT_SUPPORTED），所以「停止探测」
  只能是「关闭本次探测拥有的 runtime」。
