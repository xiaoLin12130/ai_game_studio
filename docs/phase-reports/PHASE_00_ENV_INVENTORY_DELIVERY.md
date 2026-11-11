# PHASE 00｜交付环境清单（0.2.1-rc.3 基线）

> 权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（`authoritative_source.current_record`）。

- 采集时间：2026-11-11T11:51:40+08:00
- 采集方式：在本机真实终端执行下列命令，逐条照抄输出；未做推测、未粘贴历史值。
- 覆盖对象：**交付环境**，即 `spike/dsh-probe/current-0.2.1` 实际驱动的 DSH 0.2.1-rc.3 与官方 SDK 0.2.1-rc.3。
- 与旧清单的关系：`docs/phase-reports/PHASE_00_EVIDENCE.md` 是 **0.1.5 冻结快照**，保留为历史证据，不再作为门禁 1 的依据。

## 1. 宿主与工具链

| 项 | 实测值 | 命令 |
|---|---|---|
| OS | `Microsoft Windows [Version 10.0.19045.6466]` | `cmd /c ver` |
| OS（.NET 视图） | `Microsoft Windows NT 10.0.19045.0` | `[System.Environment]::OSVersion.VersionString` |
| 主机名 | `<host>` | `[System.Net.Dns]::GetHostName()` |
| Node（当前 PATH） | `v24.19.0` | `node --version` |
| npm | `11.17.0` | `npm --version` |
| pnpm | `11.21.0` | `pnpm --version` |
| yarn | 未安装 | `yarn --version` → not installed |
| Git | `git version 2.54.0.windows.1` | `git --version` |
| Python | `Python 3.14.7` | `python --version` |
| DSH CLI（PATH 全局） | `0.1.5-rc.1` | `dsh --version` |
| `DSH_HOME` 环境变量 | `<user-home>\.dsh` | `$env:DSH_HOME` |
| 探针实际使用的 Node | `v22.22.2`（记录于 `evidence/r15/tests.json` 的 `node` 字段与 `evidence/r14/summary.json`） | 见证据文件 |

> **注意（真实差异，不是笔误）**：本机同时在用的 Node 有两个版本——交互终端是 v24.19.0，
> 而探针与回归测试记录的是 v22.22.2。两者都是真实观测，谁跑的就记谁的。

## 2. 交付运行时与官方 SDK（探针 `node_modules` 内实测）

| 包 | 实测版本 | 读取方式 |
|---|---|---|
| `@deepseek-ai/dsh` | **0.2.1-rc.3** | `node_modules/@deepseek-ai/dsh/package.json` → `version` |
| `@deepseek-ai/dsh-sdk-client` | **0.2.1-rc.3** | `node_modules/@deepseek-ai/dsh-sdk-client/package.json` → `version` |
| `@deepseek-ai/dsh-sdk-protocol` | **0.2.1-rc.3** | `node_modules/@deepseek-ai/dsh-sdk-protocol/package.json` → `version` |
| `@deepseek-ai/cordis` | `4.0.5` | `node_modules/@deepseek-ai/cordis/package.json` → `version` |
| `@mars-sea/dsh-commandcode-provider` | **0.15.4** | `dsh-home/profiles/cc-sdk/node_modules/@mars-sea/dsh-commandcode-provider/package.json` → `version` |
| 隔离 profile 目录 | `cc-cli`、`cc-sdk` | `dsh-home/profiles/` |
| npm 上 `@deepseek-ai/dsh` 的 latest | `0.2.2-rc.1` | `npm view @deepseek-ai/dsh version` |

依赖版本钉死位置：`spike/dsh-probe/current-0.2.1/package.json`（`dependencies` 与 `profilePlugins`）。

## 3. 引擎与平台工具

| 项 | 实测值 | 取得方式 |
|---|---|---|
| Cocos Creator | `3.8.6` | `<abs-path>\cocos\editors\Creator` 下的版本目录名（盘符已脱敏） |
| 微信开发者工具 | 已安装 | `<user-home>\AppData\Local\微信开发者工具` 存在 |
| 本机可用的 Node 二进制定版 | `22.22.2-6`（另含 `.locks`） | `<user-home>\.workbuddy\binaries\node\versions` |

## 4. 这份清单能证明什么、不能证明什么

能证明：门禁 1 要求的「环境清单真实且带版本/命令输出」，且清单指向的是**交付环境**（0.2.1-rc.3 + SDK 0.2.1-rc.3 + 插件 0.15.4），不是历史 0.1.5 环境。

不能证明：这台机器之外的环境；也不能证明 PATH 上的全局 `dsh@0.1.5-rc.1` 被使用过——
探针从 `node_modules` 里按精确版本加载 0.2.1-rc.3，这一点由 `evidence/r14/summary.json` 的
`runtime: "0.2.1-rc.3"` 与依赖门禁的版本区间校验共同证明（见 `evidence/r15/final-gates.json`）。

历史清单里出现的 `Git 2.55.0` 与本文的 `2.54.0` 不一致，属于不同时间的两次观测；
以本文（2026-11-11 实测）为当前值，历史值不再引用。
