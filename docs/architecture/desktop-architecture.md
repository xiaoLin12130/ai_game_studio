# 桌面应用架构（PHASE 01-A）

权威状态：当前唯一权威记录为 `state/project_state.json` → `phase_00_final`（PHASE 00）；
PHASE 01-A 的状态记录在 `state/phase_01_a.json`。

## 1. 最高原则

**DSH 负责 AI 执行，Studio 负责确定性业务控制。**

PHASE 01-A 只实现「应用外壳 + 状态显示」，AI 执行仍全部由 DSH 承担：
Studio 不自己发模型请求、不自己解析模型输出、不自己维护 Agent 会话。

## 2. 进程拓扑

```
AI Game Studio (Electron 44.7.0)
│
├── Main Process (Node, CJS)
│   ├── 应用生命周期 / 窗口 / IPC 白名单
│   ├── 配置（config.json）与日志（studio.log）
│   └── DSH 适配层
│       └── @deepseek-ai/dsh-sdk-client → spawn
│             └── dsh runtime (electron.exe --run-as-node, profile=sdk, home=<userData>/dsh-home)
│
├── Preload (sandbox, contextBridge)
└── Renderer (file:// 页面，无 Node 权限)
```

## 3. 为什么 Electron 必须钉在 44.7.0

PHASE 01-A 实测：Electron 45.3.0 下，DSH 的原生加速层直接拒绝启动——

```
Error: dsh: host preparation failed: node-addon-require-builtin unsupported:
unsupported Electron runtime fingerprint: Node 24.22.2, V8 15.6.75.50-electron.0
(supported Electron versions: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6)
```

这不是本项目的 bug，是 DSH 原生 addon 的运行时白名单。因此：

- 应用依赖 **electron@44.7.0**（与 DSH Desktop 自身所用版本一致，在支持列表内）；
- 版本在 `apps/studio/package.json` 中 **精确钉死**，并附 `studio.electronPinReason`；
- 升级 Electron 前必须重跑桌面冒烟测试，否则会以「DSH 握手超时」的形式出现，且原因不可读。

## 4. 进程边界与安全设置

| 层 | 权限 | 说明 |
|---|---|---|
| Main | 全权（Node） | 唯一能碰文件、子进程、配置、日志的地方 |
| Preload | 仅 electron 的 contextBridge / ipcRenderer | 不暴露 `require`、`fs`、`child_process` |
| Renderer | 无 Node | `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、CSP `default-src 'none'` |

渲染进程只能通过 4 个白名单通道与主进程交互：

| 通道 | 用途 |
|---|---|
| `studio:get-state` | 读取当前 DSH 状态 |
| `studio:recheck` | 触发一次检测（单飞，见 §6） |
| `studio:open-logs` | 打开日志目录 |
| `studio:get-diagnostics` | 读取诊断信息（版本、路径、完整状态） |

另有主进程 → 渲染进程的单向推送 `studio:state-changed`。

## 5. 目录布局（用户数据，不入仓库）

```
%APPDATA%\ai-game-studio\
├── config.json          配置（缺失即用默认值；损坏则改名备份）
├── logs\studio.log      结构化日志（2 MB 轮转，保留 3 份）
├── dsh-home\            隔离的 DSH home（不碰用户的 ~/.dsh）
└── workspace\           DSH 会话的默认工作目录
```

## 6. 关闭与回收

- 关闭应用时取消进行中的检测；检测自身的 `close()` 会等 runtime 真正退出。
- 桌面冒烟测试在应用退出后扫描进程表，确认没有残留的 runtime 进程。
- 这与 ADR-0001 §2 的约束一致：**进程回收不是一个 kill，而是等它真的退出**。

## 7. 模块边界

| 文件 | 职责 |
|---|---|
| `src/main/main.ts` | 生命周期、启动顺序、冒烟模式 |
| `src/main/window.ts` | 窗口与安全选项 |
| `src/main/ipc.ts` | IPC 白名单与处理函数 |
| `src/main/config.ts` | 配置默认值、校验、损坏恢复 |
| `src/main/logger.ts` | 结构化日志、脱敏、轮转 |
| `src/main/dsh/locate.ts` | 运行时入口定位与版本读取 |
| `src/main/dsh/probe.ts` | 就绪探测（唯一与 DSH 通信的地方） |
| `src/main/dsh/service.ts` | 状态机、单飞、取消 |
| `src/shared/status.ts` | 状态模型与错误分类（纯函数，可单测） |
| `src/preload/preload.ts` | 桥接 |
| `src/renderer/*` | 纯展示 |
