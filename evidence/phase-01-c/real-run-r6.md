# PHASE 01-C R6 — 正常 Windows 环境解阻塞与安装版真实运行记录

本文件记录 2026-11-12 R6 轮的真实执行，不覆盖 R4/R5 历史记录。

## 1. 环境根因与修复

| 项 | 实测 |
|---|---|
| 构建 | `release-r5/win-unpacked/AI Game Studio.exe`，246,302,208 B，SHA-256 `1255d65ad1c7e4e547f541a3ca4323d243aa6abe709bf50cf92a15d404d11d96`（构建自 `0268470`；此后仅记录文件变更） |
| 失败 store | `H:\dev\pnpm-store`、`C:\Users\LIN\AppData\Local\pnpm-store-*`（非 `%TEMP%` 路径）→ `pnpm add` 报 `EPERM: unlink .../projects/<hash>`，多次重试后 `projects/<hash>` 变成真实目录，后续 `unlink` 恒失败 | <!-- scrub:allow: 文档需要展示路径形态 -->
| 可用 store | **`%TEMP%` 下的独立目录**（本轮 `C:\Users\LIN\AppData\Local\Temp\pnpm-store-ags-abc`）→ `pnpm add` 成功，`projects/<hash>` 为 junction | <!-- scrub:allow: 文档需要展示路径形态 -->
| 隔离验证 | 系统 node + `dsh plugin add`（C: store）成功；打包 exe + `ELECTRON_RUN_AS_NODE=1` + `dsh plugin add`（C: store）成功；失败仅在 store 位于 H: / 非 `%TEMP%` C: 路径时复现 |
| 未执行 | 未修改 pnpm store 现有内容、未关闭安全垫、未替换 pnpm、未修改 Provider 或 DSH 通信 |

**结论**：provider 安装失败是 **pnpm store 路径**问题，不是 DSH 版本、不是依赖漂移、不是 Provider 代码缺陷。把 store 放到 `%TEMP%` 的独立目录后，`TaskService.ensureProfile()` 可真实安装插件。

## 2. 插件安装（真实）

- 安装命令（由 `ensureProfile()` 发起）：`dsh plugin --profile sdk add @mars-sea/dsh-commandcode-provider@0.15.4`
- 目标 profile：`<userData>/dsh-home/profiles/sdk`（Studio 默认 `dshHome`，profile `sdk`）
- 安装结果日志：
```
{"ts":"2026-11-12T06:32:44.800Z","level":"info","event":"task.profile.ready","ok":true,"detail":"provider installed"}
```
- 目标目录：`<userData>/dsh-home/profiles/sdk/node_modules/@mars-sea/dsh-commandcode-provider`
- 版本：`@mars-sea/dsh-commandcode-provider 0.15.4`
- 该 profile 不是 `~/.dsh/profiles/sdk`；`~/.dsh/profiles/{desktop,headless,web}` 与本目标 profile 无关。

## 3. A/B/C 真实运行（R6，summary.json）

- run `generatedAt`：`2026-11-12T06:41:51.506Z`（本地 14:41）
- `ok=false`，`failed=20`；失败原因均为**模型调用被限流**，不是安装失败。

| 场景 | Runtime 捕获（含 `dsh plugin` CLI） | 复核 | 业务进展 |
|---|---|---|---|
| A | 2：`pid=25824, creationMs=1794465151013`、`pid=22640, creationMs=1794465164825` | 均 `ABSENT` | 插件安装成功、`runtime.start` → `RUNNING`；模型调用 `RATE_LIMIT`，未到 SUCCEEDED |
| B | 3：`pid=19648, creationMs=1794465335229`、`pid=23808, creationMs=1794465340027`、`pid=8864, creationMs=1794465345237` | 均 `ABSENT` | rt-001 → `INTERRUPTED`（stop requested）→ resume → rt-002；`sessionId=studio-task-d28c3fca-a1`、`attemptId=att-task-d28c3fca-2`；模型 `RATE_LIMIT` |
| C | 崩溃前 2：`pid=9400, creationMs=1794465519526`、`pid=21312, creationMs=1794465522940`；恢复 1：`pid=25572, creationMs=1794465528967` | 均 `ABSENT` | rt-001 → `app.exit(9)` → 重启 → `INTERRUPTED`（recovery）→ resume；模型 `RATE_LIMIT` |

> 说明：R6 运行使用的是**修复前**的 watcher，因此 `dsh plugin` CLI 进程被计入 Runtime（A=2、B=3、C 崩溃前=2）。修复后（本提交）`discoverRuntimeIdentities` 已排除 `bin.js plugin`，`process-identity` 12/12。修复后的 A/B/C 复跑需在用量窗口重置后执行。

## 4. 唯一剩余阻断：模型账户用量窗口

真实模型调用返回（节选，未含任何凭据）：

```
"failure": {
  "message": "llm-commandcode: all 1 Command Code account(s) have exhausted their usage window; the earliest window resets at 2026/11/12 15:33:12 — requests will succeed again after the reset (or add another account)；已用尽全部 1 个 Command Code 账户的用量窗口，最早的重置时间为 2026/11/12 15:33:12——窗口重置后请求会自动恢复（也可以添加更多账户）",
  "code": "RATE_LIMIT"
}
```

因此 A/B/C 在 15:33:12 之前无法完成真实模型回合，阶段保持 `BLOCKED`。

## 5. 重置后的复验命令

```powershell
# 普通 Windows 终端；store 必须在 %TEMP% 下的独立目录
cd H:\AI与开发\ai_game_studio_starter\apps\studio <!-- scrub:allow: 文档需要展示路径形态 -->
$env:PNPM_CONFIG_STORE_DIR = "$env:TEMP\pnpm-store-ags-r6"
node scripts\smoke-tasks-packaged.mjs "H:\workbuddy\AI_Game_Studio\release-r5\win-unpacked" <!-- scrub:allow: 文档需要展示路径形态 -->
# 期望：evidence\phase-01-c\packaged\summary.json 的 ok=true；
# A taskSucceeded=true；B runtimeIdentityCount=2、distinct=true、allRuntimeProcessesGone=true、
# noIdentityWatchErrors=true；C crashOrphanStatus=ABSENT、恢复 Runtime ABSENT、resumedToTerminal=true
```
