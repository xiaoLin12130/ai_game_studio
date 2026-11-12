# PHASE 01-D｜项目空间与基础设施

- 基线：`fa453c96795e871dc3c612eced27043453b88136`（PHASE 01-C 关闭）
- 分支：`phase/01-d-project-workspace`
- 前置：PHASE 00 / 01-A / 01-B / 01-C 均已关闭，只读保护

## 目标

让用户第一次打开 AI Game Studio 时，能真正创建一个游戏项目、保存项目状态、重新打开项目，
并确信不同项目的数据不会互相污染。为 PHASE 02（AI 顾问与需求基线）提供可靠的项目载体。

## 工作项与验收

| 编号 | 工作项 | 验收条件 | 测试命令 |
|---|---|---|---|
| D1 | 项目创建/打开/关闭 | 创建→重启→仍在；打开→关闭→回到工作台 | `node --test test/project-service.test.js` |
| D2 | 项目数据模型 | Project/ProjectConfig/ProjectEvent/Approval 建表，Task 关联项目 | `node --test test/project-store.test.js` |
| D3 | 持久化与迁移 | v1→v2 迁移保留旧数据；迁移失败不破坏原库 | `node --test test/project-migration.test.js` |
| D4 | 备份与恢复 | 真实恢复并校验项目/Task/Session 关联 | `node --test test/project-backup.test.js` |
| D5 | 路径安全 | 穿越、跨盘、UNC、junction 逃逸全部拒绝 | `node --test test/project-paths.test.js` |
| D6 | 项目隔离 | A 项目不能读写 B 项目受控文件 | 同上 |
| D7 | 写锁 | 同项目第二个写任务被拒；只读可并行 | `node --test test/project-locks.test.js` |
| D8 | 构建锁 | 构建独占；构建期间写被拒 | 同上 |
| D9 | 锁恢复 | 异常退出后过期锁可回收 | 同上 |
| D10 | 五个一级导航 | 工作台/游戏项目/AI 顾问/设计与素材/决策中心 | 桌面冒烟 |
| D11 | 规则读取 | 全局与项目规则可读，Renderer 不碰 FS | `node --test test/project-rules.test.js` |
| D12 | 桌面真实运行 | 创建项目→重启→打开 | `node scripts/smoke.mjs projects` |

## 允许修改范围

- `apps/studio/src/main/projects/**`（新增）
- `apps/studio/src/main/tasks/store.ts`（仅追加 v2 迁移与 `project_id`）
- `apps/studio/src/main/ipc.ts`、`src/preload/preload.ts`（追加通道）
- `apps/studio/src/renderer/**`（追加导航与页面）
- `apps/studio/test/**`（新增测试）
- `docs/review-handoff/PHASE_01_D_*`、`evidence/phase-01-d/**`、`state/phase_01_d.json`

## 禁止修改范围

PHASE 00 / 01-A / 01-B / 01-C 的源码行为、历史证据、关闭报告与状态记录；
`state/project_state.json` 中已关闭阶段的记录（只允许追加 PHASE 01-D 指针）。

## 明确不做

AI 顾问对话、需求基线冻结、GDD 生成、完整 Decision Center、素材库、UI 原型设计器、
代码生成、多 Agent 调度、多引擎完整支持、微信构建发布、发布后运营监控、
DSH Runtime / MCP / Task-Session 重写、React 重构。
