# 10｜GitHub 分阶段上传与外部复审协议

## 目的

每个阶段完成后，将可复现代码和证据提交 GitHub，让用户把精确提交交给外部评审，检查是否偏离产品目标。阶段复审是下一阶段的前置条件。

## 仓库建议

- 建议使用 GitHub Private Repository。
- `main` 保持为已复审稳定基线。
- 每阶段分支：`phase/00-feasibility`、`phase/01-foundation` 等。
- 不强推、不删除远端分支；未经授权不改仓库可见性。
- 如仓库没有 remote，Agent 不得猜仓库地址或擅自创建公开仓库；提供最短设置步骤并暂停。

## 每阶段流程

1. 确认阶段交付物和验收项。
2. 检查 `git status`、diff 和未跟踪文件。
3. 执行阶段定义的全部测试。
4. 生成真实证据和报告。
5. 执行 secret scan / grep 检查，确保无 Token、密钥、Cookie、`.env`、DSH Home、用户隐私文件。
6. 更新项目状态、handoff、阶段复审报告。
7. 提交阶段分支，commit message 格式：`phase(00): verify dsh integration`。
8. 推送 GitHub。
9. 记录完整 commit SHA、branch、remote URL、测试结果和证据路径。
10. 停止；等待用户/外部评审明确通过后再开始下一阶段。

## 复审时需要提供

- Repository URL（私有仓库需确保评审方有授权访问；不能访问时提供该 SHA 的审查 ZIP）。
- Branch 和完整 Commit SHA。
- `docs/review-handoff/PHASE_xx_REVIEW_HANDOFF.md`。
- 本阶段真实测试命令及退出码。
- 未完成/未验证/阻塞事项。
- 已知偏离、技术债和风险。

## 复审包不得只给“总结”

必须保留源代码、测试脚本、配置样例、必要的证据索引和可复现步骤。不要把大体积缓存/临时构建产物全量上传；需保留能证明来源和哈希的 manifest。

## 外部评审结果

- `APPROVED`：允许进入下一阶段。
- `APPROVED_WITH_ACTIONS`：先完成列出的修正，重新推送新 SHA 并复审。
- `REJECTED`：停止下一阶段，按问题清单修复。
- `NEED_MORE_EVIDENCE`：补充证据，不得将其当作通过。

## 私有仓库访问说明

评审方只有在 GitHub 连接已授权且该仓库位于允许访问范围内时，才能直接查看私有仓库。若无法访问，用户应提供指定提交的 ZIP 或开放必要的只读访问。不要把访问 Token 粘贴到聊天或提交到仓库。
