# PHASE 02 能力探针证据

| 文件 | 内容 |
|---|---|
| `web-capability.json` | 真实 DSH 会话：工具清单、`web_fetch` 抓取结果、`web_search` 搜索结果 |

## 方法

`scripts/web-capability-probe.mjs` 用真实 `HarnessClient`、真实 `commandcode` provider、
真实模型 `deepseek/deepseek-v4-flash` 跑一个会话，从 `request/header` 事件读取运行时实际提供给模型的工具清单，
再让模型真实调用一次 `web_fetch` 与一次 `web_search`。

## 结论

- 工具清单 25 项，含 `web_fetch` 与 `web_search`。
- 抓取 `https://example.com` 返回真实标题 "Example Domain"。
- 搜索 "vampire survivors game design core loop" 返回真实标题与 URL。

## 注意

本探针消耗少量模型配额。凭据从 `~/.dsh/.credentials.yaml` 读取，**未写入任何证据文件**。
