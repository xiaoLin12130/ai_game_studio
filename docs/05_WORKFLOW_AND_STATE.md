# 05｜工作流、状态机与自主权限

## 三个工作区与状态

- 讨论区：`DRAFT`，自由对话和研究，不触发正式写入。
- 正式研发区：`BASELINED`，仅消费已批准基线。
- 需求变更区：`CHANGE_PROPOSED → IMPACT_ANALYZED → AWAITING_APPROVAL → APPROVED/REJECTED → IMPLEMENTING → VERIFIED`。

## 项目阶段

`IDEA → DISCOVERY → DESIGN → BASELINE_APPROVAL → PROJECT_SETUP → PROTOTYPE → UI_UX → DEVELOPMENT → QA_PLATFORM → RELEASE_HANDOFF → DELIVERED`

阶段是项目生命周期视图，不代表所有任务必须串行。研究和素材盘点等可在依赖满足时并行；同一工程写入和构建仍需串行锁。

## 需求基线

- 基线具有版本号、批准人、批准时间、内容哈希和关联设计版本。
- 基线冻结后不可直接覆盖，只能创建新版本。
- 讨论草稿、AI 建议和未批准变更不能被任务规划器当作正式任务依据。
- 基线更新后，必须计算受影响任务并标记过期验收证据。

## 任务状态机

`DRAFT → READY → QUEUED → RUNNING → VERIFYING → PASSED`

异常状态：`BLOCKED`、`FAILED`、`CANCEL_REQUESTED`、`INTERRUPTED`、`REVIEW_REQUIRED`、`REJECTED`。

规则：
- 仅 `READY` 且依赖完成的任务可排队。
- `RUNNING` 必须有执行锁、DSH Session 映射和任务契约。
- `PASSED` 必须有完成标准对应的证据。
- 失败不得推进后续依赖任务。
- 任务重试必须判断幂等性和已有文件修改，不得盲目重复写入。

## 自主权限等级

- P0 只读分析：读取项目/知识/日志，自动允许。
- P1 草稿与隔离产出：生成报告、设计草稿、临时原型，自动允许；不能覆盖正式基线。
- P2 任务授权范围内执行：仅在用户已批准的任务契约、目录和操作范围内执行。
- P3 高风险/不可逆操作：删除/大范围覆盖、正式基线改变、架构迁移、正式构建替换、发布动作等必须审批。

风险判断因素：影响范围、可逆性、证据可信度、不确定性、外部影响。

## 项目目标层级

- Project Mission：用户最终想做什么。
- Milestone：当前阶段已批准的阶段目标。
- Task：当前可执行工作。

AI 只能维护、拆解和执行，不得擅自增加 Mission 或 Milestone 功能范围。

## 事件驱动

触发源可包括：文件变化、Git 提交、任务完成、构建完成、测试失败、素材导入、审批、里程碑变化。必须做事件聚合、去重、节流，并排除缓存/temp/build 输出，避免文件监听风暴。

## 通知

- P3 风险阻塞/需审批：立即提醒。
- 重要进度/失败：进入工作台待处理区。
- 普通信息：阶段摘要。
- 用户拒绝的建议不重复提醒，除非有新证据或事实变化。

不做发布后的定时巡检和运营通知。
