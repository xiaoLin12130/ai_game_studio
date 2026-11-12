# PHASE 01-C — R7 安装版 A/B/C 真实验收记录

生成时间：2026-11-12 15:37 (+08:00)
结论：**A/B/C 全部真实通过**（`summary.ok = true`，0 失败，43 项检查）

---

## 1. 环境与前置

| 项 | 值 |
|---|---|
| 宿主 | Windows 10.0.19045，本机 NTFS 固定盘；命令经 WorkBuddy `sandbox-cli.exe` 派生 |
| Node / pnpm / npm | v22.22.2 / 11.21.0 / 10.9.7 |
| 安装包 | `H:\workbuddy\AI_Game_Studio\release-r5\win-unpacked`（构建自 `0268470`） |
| 可执行文件 SHA-256 | `1255d65ad1c7e4e547f541a3ca4323d243aa6abe709bf50cf92a15d404d11d96`（246,302,208 B） |
| DSH Home（本次运行） | `<userData>/dsh-home`（临时目录），profile = `sdk` |
| pnpm store（成功） | `C:/Users/LIN/AppData/Local/Temp/pnpm-store-ags-r7` |
| pnpm store（失败） | `H:\dev\pnpm-store\v11`、`H:\ai_music_crew\.tmp\pnpm-store-ags-r7` |
| Provider 插件 | `@mars-sea/dsh-commandcode-provider@0.15.4`，`task.profile.ready ok:true "provider installed"` |
| 模型额度 | 窗口于 `2026-11-12 15:33:12 +08:00` 重置；首个真实回合 15:34:16 完成 |

### 1.1 store 位置的决定性差异

- **H: 盘上的 store 必失败**：`pnpm registerProject` 落下的 `projects/<hash>` 是**真实目录**，随后
  `forceSymlink` 走 `renameTried` 分支执行 `fs.unlink(<dir>)`，Windows 对目录的 `unlink` 恒返回 **EPERM**。
- **C: 盘 `%TEMP%` 下的 store 正常**：`projects/<hash>` 形成 **junction**，安装成功。
- 该 EPERM 是 **Windows 原生语义**，与 WorkBuddy safe-delete 策略无关（Node shim 对目录路径直接放行给原生实现）。

首次 R7 尝试用 H: 盘 `%TEMP%` store，插件安装失败，原始结果保留为
`packaged/summary-r7-installfail.json`。

---

## 2. 执行命令

```bash
cd apps/studio
PNPM_CONFIG_STORE_DIR="C:/Users/LIN/AppData/Local/Temp/pnpm-store-ags-r7" \
  node scripts/smoke-tasks-packaged.mjs "H:/workbuddy/AI_Game_Studio/release-r5/win-unpacked"
```

退出码 **0**，`summary.ok = true`，`failed = []`。
完整结果：`packaged/summary-r7.json`（同一份也在 `summary.json`）。

---

## 3. A — 正常执行

| 项 | 实测 |
|---|---|
| Task | `task-cea17dc3` |
| 终态 | **SUCCEEDED**（`VERIFYING → SUCCEEDED`，`reason: acceptance passed`） |
| Attempts / Sessions | 1 / 1 |
| Session | `studio-task-cea17dc3-a1` |
| Runtime 身份 | `pid=25476, creationMs=1794468973318`（`source: parent-and-bin`） |
| OS 进程复核 | **ABSENT** |
| 日志级关闭证明 | `runtime.closed rt-001` 存在（`runtimeClosedInLog: true`） |
| 其它 | `disposeHadNoFailure`、`noLingeringApp`、`noIdentityWatchErrors` 均为 true |

## 4. B — 中断与恢复

| 项 | 实测 |
|---|---|
| Task | `task-bb42d7e9` |
| 状态序列 | `CREATED→QUEUED→PREPARING→RUNNING→INTERRUPTING→INTERRUPTED→RESUMING→RUNNING→VERIFYING→SUCCEEDED` |
| 中断时快照 | `status=INTERRUPTED`，`attempts=1` |
| 恢复方式 | DSH 原生 `resumeSession(sessionId)`（`task.action resume`） |
| Session | `studio-task-bb42d7e9-a1` —— **两次 attempt 复用同一 session**（`sessions=1`, `attempts=2`） |
| Runtime #1 | `pid=25652, creationMs=1794468989474` → **ABSENT** |
| Runtime #2 | `pid=20992, creationMs=1794468994654` → **ABSENT** |
| 身份数 / 去重 | `runtimeIdentityCount=2`、`runtimeIdentitiesDistinct=2` |
| 日志级关闭证明 | `runtime.closed rt-001 (interrupted)` 与 `runtime.closed rt-002 (completed)` |
| 其它 | `noIdentityWatchErrors`、`noLingeringApp` 均为 true |

## 5. C — 真实崩溃恢复

| 项 | 实测 |
|---|---|
| Task | `task-63b09ebc` |
| 崩溃方式 | 运行中 `app.exit(9)`（`crashedAsExpected: true`，`crashLeftTaskRunning: true`） |
| 崩溃前 Runtime | `pid=25872, creationMs=1794469007470` → **ABSENT**（`crashOrphanStatus`） |
| 重启后 | `app.start` → 识别 `INTERRUPTED` → `RESUMING` → `task.resumed`（`recovered: true`） |
| 恢复 Runtime | `pid=25092, creationMs=1794469013475` → **ABSENT** |
| 终态 | SUCCEEDED，`attempts=2`、`sessions=1` |
| 其它 | `noIdentityWatchErrors`、`noLingeringApp` 均为 true |

---

## 6. 本轮唯一代码改动（断言修正）

`apps/studio/scripts/smoke-tasks-packaged.mjs`

- 删除 `noRuntimeLeft`：它读取 app 退出前写入的 `smoke.json` 快照，此时 runtime 合法状态为
  `closing`（53 ms 后才 `runtime.closed`），**结构上不可能为真**，此前只是时序上的偶然通过。
- 新增 `runtimeClosedInLog`（A、B 都启用）：要求每个 `runtime.start` 在完整日志中都有对应的
  `runtime.closed`。这是**更强**的断言，而不是放宽。
- OS 进程退出的权威证明仍是 `verifyRuntimeIdentity` 的 **ABSENT**，未改变。

未改产品代码、未改构建产物、未改 Provider/DSH 通信。

---

## 7. 定向测试

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node --test test/process-identity.test.js` | 12/12 | 0 |
| `node --test test/runtime-supervisor.test.js` | 9/9 | 0 |
| `node --test test/identity-watcher.test.mjs` | 6/6 | 0 |
| `node scripts/smoke-tasks-packaged.mjs`（安装版 A/B/C） | ok:true，43 检查，0 失败 | 0 |

历史证据保留：`packaged/summary-r4.json`、`summary-r6.json`、`summary-r7-installfail.json`。
