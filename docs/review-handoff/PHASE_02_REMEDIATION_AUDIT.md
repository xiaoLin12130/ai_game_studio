# PHASE 02 补正：只读盘点与计划

- 基线：`aca0d0aed80b8cb414c4a9882b9d42ead5c1ee79`
- 方式：只读检查源码与状态文件，未修改任何文件

## 1. P1-A 研究执行器

`app-wiring.ts`：

```ts
runResearch: async () => ({ ok: false, markdown: '', sources: [], error: '研究执行器尚未接入。' }),
```

**确认**：生产装配里研究执行器是硬编码失败。`ResearchService.run()` 会把状态置为 `FAILED`
并返回错误，所以研究页面永远无法完成研究。

同时确认 `types.ts` 的 `ResearchSource` 目前只有 `title/url/fetchedAt/via/note`——
**没有"是否已验证"字段**，因此模型在正文里写出的 URL 与真实抓取过的 URL 在数据结构上无法区分。

## 2. P1-B 变更批准后的版本流程

`RequirementStore.decideProposal()` 只更新 `change_proposals.status`。
`BaselineService` 没有"候选版本"概念：`freeze()` 直接从内容冻结，`proposeChange()` 只读不写新内容。

**确认**：批准之后没有任何路径能把提案变成新基线，也没有"候选待确认"状态。
`change_proposals` 表没有指向产物的列。

## 3. P1-C 状态一致性

`state/project_state.json` 实际值：

```
current_phase: PHASE_00
phase_status: { PHASE_00: PASS, PHASE_01..07: BLOCKED_BY_PREVIOUS_REVIEW }
github.current_branch: phase/00-feasibility
github.last_reviewed_commit: 6943618…
next_action: PHASE 02 等待外部评审；…
```

**确认**：`current_phase` 与 `branch` 都停留在 PHASE 00；`phase_status` 把 PHASE 01–07 一律标成
`BLOCKED_BY_PREVIOUS_REVIEW`，与实际已关闭的 01-A/01-B/01-C/01-D 矛盾。
`phase_02` 索引块本身是对的，与顶层字段不一致。

`state/phase_01_d.json`：`status` = `READY_FOR_EXTERNAL_REVIEW`，`verdict` = `null`。

仓库内**没有**任何外部评审记录文件（`**/*review*` 无匹配）。因此 PHASE 01-D 的通过结论
只能来自用户明确告知，仓库内无法自证。补正时按"用户告知的外部评审结论"记录，
并写明证据在仓库之外——不伪造一份评审记录。

## 4. P2-A DOCX 提取

`attachments.ts` 当前把整个 DOCX（一个 ZIP）当 UTF-8 文本读，再用正则找 `<w:t>`。
ZIP 的正文是 deflate 压缩的，这段正则在标准 DOCX 上匹配不到任何内容。

依赖里**没有** zip 库（`package.json` 只有 `dsh-sdk-client` 与 `modelcontextprotocol/sdk`）。
Node 自带 `node:zlib`，可以用 `inflateRawSync` 解压 ZIP 条目，不需要新增依赖。

## 5. P2-B 消息与草稿版本的历史保护

v3 迁移里：

| 表 | 现有约束 | 是否防篡改 |
|---|---|---|
| `advisor_messages` | `idx_messages_seq` 唯一索引 | **否** |
| `draft_versions` | `idx_draft_version` 唯一索引 | **否** |

**确认**：唯一索引只保证同一会话内 `seq` 不重复、同一草稿内 `version` 不重复，
不阻止已有行被 `UPDATE` 或 `DELETE`。评审的这一条成立。

## 6. 补正范围

| 编号 | 修复 |
|---|---|
| P1-A | 新增研究执行器，复用 RuntimeSupervisor + Session；来源只从真实工具结果生成 |
| P1-B | 新增 `baseline_candidates`，批准 → 候选 → 用户确认 → 新基线 |
| P1-C | 修正 `project_state.json` 与 `phase_01_d.json` |
| P2-A | 用 `node:zlib` 真正读 DOCX 的 `word/document.xml` |
| P2-B | 为 `advisor_messages` 与 `draft_versions` 加不可变触发器 + 直接 SQL 测试 |

## 7. 不做

- 不重写 DSH Runtime、Session、项目隔离、写锁、Runtime 池。
- 不重开 PHASE 00 / 01-A / 01-B / 01-C / 01-D。
- 不开始 PHASE 03。
