# PHASE 01-D 工作报告 — 项目空间与基础设施

> **状态：`READY_FOR_EXTERNAL_REVIEW`。** 本报告不宣告通过，是否关闭由外部独立评审决定。

## 1. 本阶段目标

让用户第一次打开 AI Game Studio 时，能真正创建一个游戏项目、保存项目状态、重新打开项目，
并确信不同项目的数据不会互相污染。

## 2. Git

| 项 | 值 |
|---|---|
| 基线 | `fa453c96795e871dc3c612eced27043453b88136`（PHASE 01-C 关闭） |
| 分支 | `phase/01-d-project-workspace` |
| 提交 | 按里程碑拆分：M0 盘点与契约 / M1–M4 实现 / M5 验收 |

## 3. 实现

| 模块 | 文件 | 说明 |
|---|---|---|
| 数据模型 | `src/main/projects/types.ts` | Project / ProjectConfig / ProjectEvent / Approval |
| 持久化 | `src/main/projects/store.ts` + `tasks/store.ts` 的 v2 迁移 | 同一数据库，不是第二套 |
| 路径安全 | `src/main/projects/paths.ts` | 真实路径解析 + 分段比较 + junction 检查 |
| 锁 | `src/main/projects/locks.ts` | 写锁与构建锁，行记录 + 心跳 + 过期回收 |
| 备份恢复 | `src/main/projects/backup.ts` | VACUUM INTO + 恢复前安全副本 |
| 生命周期 | `src/main/projects/service.ts` | 创建/打开/关闭/配置 |
| 规则读取 | `src/main/projects/rules.ts` | 固定来源清单，受控读取 |
| UI | `src/renderer/{index.html,renderer.ts,styles.css}` | 五个一级入口 + 项目页 |

### 3.1 数据库

v1 → v2 迁移新增 `projects`、`project_configs`、`project_events`、`approvals`、`project_locks` 五张表，
并给 `tasks` 加可空的 `project_id`（`ON DELETE SET NULL`）。

**关闭项目不删除任务与会话**——这是外键行为，不是注释里的承诺。

### 3.2 三种互斥的职责划分

| 机制 | 粒度 | 归属 |
|---|---|---|
| TaskRunner 单飞 | 一个任务同时只跑一次 | PHASE 01-C |
| Runtime 租约 | 写入型任务独占 Runtime | PHASE 01-C |
| **项目写锁** | 一个项目同时只有一个写者 | 本阶段 |
| **构建锁** | 构建独占，且排斥写者 | 本阶段 |

一个任务可以是唯一在跑的任务，同时是同一项目的第二个写者——所以项目锁不能从任务锁推导出来。

### 3.3 路径安全

不用字符串前缀判断。两侧都解析到真实路径（跟随 junction），再按路径分段比较。
拒绝：`..` 越界、跨盘、UNC、junction 逃逸、相对路径、空路径。
**无法解析的路径一律拒绝**，不假设安全。

## 4. 验收结果

| 编号 | 目标 | 结果 | 证据 |
|---|---|---|---|
| D1 | 项目创建/打开/关闭 | PASS | `desktop/summary.json` |
| D2 | 项目数据模型 | PASS | `unit/project-tests.txt` |
| D3 | 持久化与迁移 | PASS | 同上（含迁移失败保护） |
| D4 | 备份与恢复 | PASS | 同上（真实恢复 + 关联校验） |
| D5 | 路径安全 | PASS | 同上（含真实 junction 逃逸） |
| D6 | 项目隔离 | PASS | 同上 |
| D7 | 项目写锁 | PASS | 同上 |
| D8 | 构建锁 | PASS | 同上 |
| D9 | 锁恢复 | PASS | 同上 |
| D10 | 五个一级导航 | PASS | `src/renderer/index.html` |
| D11 | 规则读取 | PASS | `unit/project-tests.txt` |
| D12 | 桌面真实运行 | PASS | `desktop/summary.json` |
| D13 | 历史回归 | PASS | `regression/phase00-suite.txt`、`regression/phase00-gates.json`、`regression/phase01a-ready.txt`、`regression/phase01b-mcp.txt` |
| D14 | 证据可追溯 | PASS | `verification.json` |
| D15 | 报告与推送 | PASS | 本文件 |

## 5. 测试

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `tsc -p tsconfig.json` | 0 | — | `unit/tsc.txt` |
| `node --test` | 0 | **181/181** | `unit/full-suite.txt` |
| `node --test test/project-*.test.js` | 0 | **55/55** | `unit/project-tests.txt` |
| `node scripts/smoke-projects.mjs` | 0 | **9/9** | `desktop/summary.json` |
| PHASE 00 套件 | 0 | **166/166** | `regression/phase00-suite.txt` |
| PHASE 00 门禁 | 0 | PASS，0 泄漏 | `regression/phase00-gates.json` |
| PHASE 01-A 冒烟 ×2 | 0 / 0 | — | `regression/phase01a-ready.txt`、`regression/phase01a-quit.txt` |
| PHASE 01-B MCP 握手 | 0 | — | `regression/phase01b-mcp.txt` |

新增 55 项测试，覆盖：表结构与迁移（7）、路径安全（10）、锁（13）、项目生命周期（10）、备份恢复（6）、规则读取（9）。

**测试具备失败能力**：路径测试包含真实 junction 逃逸；迁移测试构造会失败的 v2 迁移并验证版本不推进、数据不丢；
备份测试用损坏文件验证拒绝覆盖；锁测试用可控 PID 与时钟验证过期判定。

## 6. 一个必须记录的过程问题

首次跑 PHASE 00 套件时出现 164/166——两项失败是**我引入的泄漏**导致的：渲染层输入框示例里写了真实路径形态，
桌面冒烟证据里带了真实临时目录。门禁在真实树上跑不过，PHASE 00 的"官方门禁"测试因此失败。

修法：文档行用仓库自带的 `scrub:allow` 标记，证据在生成时就脱敏。修复后 166/166、门禁 PASS。

## 7. 未做

AI 顾问对话、需求基线冻结、GDD 生成、完整 Decision Center、素材库、UI 原型设计器、代码生成、
多 Agent 调度、多引擎支持、微信构建发布、发布后运营监控、DSH/MCP/Task-Session 重写、React 重构。

## 8. UNKNOWN / DEFERRED / NOT_RUN

| 类型 | 内容 |
|---|---|
| UNKNOWN | U-01D-1 多引擎/多平台支持；U-01D-2 安装包内的项目链路 |
| DEFERRED | D-01D-1 AI 顾问与需求基线（PHASE 02）；D-01D-2 素材库（PHASE 03）；D-01D-3 完整审批流（PHASE 02） |
| NOT_RUN | 安装包重建与安装后项目链路；`npm audit` / 静态吊销检查 |
| BLOCKED | 无 |

## 9. 历史保护

PHASE 00 / 01-A / 01-B / 01-C 的源码行为、历史证据、关闭报告与状态记录均未修改。
回归时被脚本覆写的证据已用 `git checkout` 还原，diff 为空。

## 10. 结论

D1–D15 全部 PASS，状态 **`READY_FOR_EXTERNAL_REVIEW`**。未自行标记 APPROVED，未开始 PHASE 02。
