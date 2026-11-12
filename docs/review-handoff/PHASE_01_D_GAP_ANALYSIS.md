# PHASE 01-D 现状盘点（GAP 分析）

- 盘点基线：`fa453c96795e871dc3c612eced27043453b88136`（PHASE 01-C 关闭）
- 盘点方式：只读检查源码、测试、数据库 schema、IPC/preload 契约与渲染层结构
- 结论标记：`CONFIRMED` / `PARTIALLY_VERIFIED` / `NOT_IMPLEMENTED` / `UNKNOWN` / `DEFERRED`

## 1. 逐项盘点

| 能力 | 结论 | 现有实现 | 证据 |
|---|---|---|---|
| Windows 应用基础 | **CONFIRMED** | `src/main/main.ts`、`window.ts`、`config.ts` | PHASE 01-A 已关闭；`test/config.test.js`、`test/logger.test.js` |
| MCP 与正式打包 | **CONFIRMED** | `mcp/studio-mcp-server.mjs`、`electron-builder.yml` | PHASE 01-B 已关闭；`test/mcp-server.test.js` |
| Task / Session 生命周期 | **CONFIRMED** | `src/main/tasks/*`、`src/main/runtime/supervisor.ts` | PHASE 01-C 已关闭；`test/task-*.test.js`、`test/runtime-supervisor.test.js` |
| 本地持久化（SQLite） | **CONFIRMED** | `src/main/tasks/store.ts`（`node:sqlite`，WAL，事务，迁移） | `test/task-store.test.js` |
| 数据库迁移机制 | **PARTIALLY_VERIFIED** | `store.ts` 的 `#migrate()`：`schema_version` + 顺序迁移 + 事务回滚 | 只有 v1 一次迁移，**没有"迁移失败不破坏旧库"的测试** |
| 备份与恢复 | **NOT_IMPLEMENTED** | 无 | — |
| 项目创建 / 打开 / 关闭 | **NOT_IMPLEMENTED** | 全仓库无 `Project` 概念（grep 0 命中） | — |
| 项目配置（引擎/平台/路径） | **NOT_IMPLEMENTED** | `config.ts` 只有 DSH 与 UI 配置 | — |
| 项目数据隔离 | **NOT_IMPLEMENTED** | 无项目概念，无从隔离 | — |
| 项目根路径保护 | **NOT_IMPLEMENTED** | 无路径校验代码 | — |
| 项目写锁 / 构建锁 | **NOT_IMPLEMENTED** | 只有 Task 单飞与 Runtime 租约 | `runner.ts` 的 `#active` 是任务级，不是项目级 |
| 核心数据模型 Project/Event/Approval | **NOT_IMPLEMENTED** | 现有 8 张表：`tasks`、`task_transitions`、`attempts`、`sessions`、`runtimes`、`verifications`、`events`、`schema_version` | `store.ts` |
| 五个一级导航 | **NOT_IMPLEMENTED** | 渲染层只有 `dsh-card` 与 `tasks-card` 两个 section | `src/renderer/index.html` |
| 项目规则入口 | **NOT_IMPLEMENTED** | `AGENTS.md`/`docs`/`memory-bank`/`state` 存在，但应用不读取 | — |
| 诊断与环境检测 | **CONFIRMED** | `ipc.ts` 的 `studio:get-diagnostics`、`open-logs` | PHASE 01-A 已关闭 |

## 2. 可直接复用的代码

| 复用对象 | 位置 | 用法 |
|---|---|---|
| SQLite 打开/迁移/事务 | `tasks/store.ts` 的 `#migrate()`、`#transaction()` | 项目表作为 **v2 迁移**加进同一个库，不新建第二套数据库 |
| IPC 白名单模式 | `main/ipc.ts` + `preload/preload.ts` | 新增 `studio:projects:*` 通道，沿用同一写法 |
| 日志 | `main/logger.ts` | 项目操作写同一份 `studio.log` |
| 任务与项目关联 | `tasks/store.ts` 的 `tasks` 表 | 加 `project_id` 外键，不重建任务表 |
| 渲染层卡片风格 | `renderer/styles.css` 的 `:root` 变量与 `.card` | 五个入口沿用现有视觉，不重做 Renderer |

## 3. 需要新增的文件

```
src/main/projects/
  types.ts        项目数据模型
  store.ts        项目表 + v2 迁移（复用 tasks/store 的库）
  paths.ts        项目根路径安全（真实路径解析、包含关系、junction 检查）
  locks.ts        项目写锁与构建锁
  service.ts      项目创建/打开/关闭/配置
  rules.ts        项目规则与状态读取（受控文件访问）
src/main/ipc.ts   新增 projects 通道
src/preload/preload.ts  新增白名单方法
src/renderer/     五个一级入口 + 工作台/项目页
```

## 4. 依赖关系

```
paths.ts ──► service.ts ──► ipc.ts ──► preload ──► renderer
locks.ts ──► service.ts
store.ts（项目表）──► service.ts
rules.ts ──► service.ts
tasks/store.ts（v2 迁移）──► 项目表与 tasks.project_id
```

## 5. 风险与处理

| 风险 | 处理 |
|---|---|
| 项目表与任务表跨迁移耦合 | 项目表作为 v2 迁移加入同一库；`tasks.project_id` 用可空外键，旧数据不受影响 |
| 路径包含判断用字符串前缀会误判 | 用 `fs.realpathSync.native` 解析后按路径分段比较，并单独检查 junction |
| 锁文件残留导致项目永久锁死 | 锁记录持有者 PID 与时间；PID 不存在或超时即视为过期，可回收 |
| 备份恢复破坏现有数据 | 恢复前先备份当前库；恢复在事务内进行，失败回滚 |
| 五个入口做成空壳 | 每个入口明确标注"待开发"，不伪造功能 |

## 6. 本轮明确不做

AI 顾问对话、需求基线冻结、GDD 生成、完整 Decision Center 与审批流、素材库与素材识别、
UI 原型设计器、代码生成工作流、多 Agent 调度、多引擎完整支持、微信构建与发布、发布后运营监控、
DSH Runtime / MCP / Task-Session 生命周期重写、React 全面重构。
