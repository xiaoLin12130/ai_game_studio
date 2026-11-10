# spike/dsh-probe — DSH 集成验证

这里的代码**不是产品代码**，是技术验证与回归基线。它证明 Studio 能通过官方 SDK 驱动真实的 DSH Runtime，并把每个版本「能做什么、不能做什么」测出来。

> **先看这个**：本目录有两套工程，别跑错。
>
> | 目录 | 目标运行时 | 用途 |
> |---|---|---|
> | `current-0.2.1/` | **DSH 0.2.1-rc.3 + 用户真实 commandcode 插件** | **生产决策依据**，日常回归跑这个 |
> | 本目录（根） | DSH 0.1.5-rc.2 | legacy 基线，仅作历史对照 |
>
> 0.1.5 无法加载 `@mars-sea/dsh-commandcode-provider@0.15.4`（插件要求 `>=0.2.1-rc.2 <0.2.2`），
> 运行时会**静默回退**到其它 provider。所以根目录套件的结果**不能**用来判断用户的模型是否可用。

---

## 1. 生产目标组合（唯一需要跑的那套）

```bash
cd current-0.2.1
npm install                 # 依赖精确钉版本，见 package.json
export COMMANDCODE_API_KEY=...   # 只从环境变量读，绝不写进仓库
node run-all.mjs            # 期望：PASS 5/5，退出码 0
```

`run-all.mjs` 会**先自动构建隔离环境**，再跑探针：创建 `dsh-home/`、生成 `cc-sdk` 与
`cc-cli` 两个 profile、把钉死版本的 commandcode 插件装进各自的 `node_modules`、写出
patch 文件。**不需要机器上预先存在任何 profile**，也不读写用户的 `~/.dsh`。

单独初始化（排查用）：

```bash
node scripts/setup-profiles.mjs --home ./dsh-home   # 幂等
```

想验证「干净环境可复现」，指定一个全新目录：

```bash
node scripts/setup-profiles.mjs --home <空目录>/dsh-home
CC_DSH_HOME=<空目录>/dsh-home node run-all.mjs
```

### 前置条件

- Node ≥ 22
- `COMMANDCODE_API_KEY` 可被 DSH 的 credential seam 解析（patch 里只写变量**名**）
- 首次启动可能较慢（要物化 profile 的模块回退），不是卡死

### 探针

| 探针 | 验证什么 | 判 PASS 的条件 |
|---|---|---|
| `probe-commandcode.mjs` | 真实对话 + 路由 | 回显随机标识 **且** `request/header.config` 是 commandcode/目标模型 |
| `probe-cc-tools.mjs` | MCP 工具三阶段 | server 起 → 工具进清单 → **模型真实调用 + Server 审计到 `tools/call.served`** |
| `probe-cc-resume.mjs` | Session Resume | 重启进程后仍答出随机口令；不存在的 session 被拒（负对照） |
| `probe-cc-concurrent.mjs` | 并发隔离 | 两会话答案不互换、通知不串台、关闭后无残留 |
| `probe-capability.mjs` | 协议能力矩阵 | 每个方法给出确定结论（存在/不存在）。**不做模型调用** |

退出码：`0` 全 PASS；`2` 有 BLOCKED（外部依赖，如凭据缺失）；`1` 有 FAIL。

---

## 2. 依赖与 Profile 的关系（容易踩的坑）

- `package.json` 的 `dependencies` 是**探针进程**自己的依赖（SDK 客户端等）。
- `@mars-sea/dsh-commandcode-provider` 不是探针的依赖，它必须装在**DSH profile 的 node_modules** 里，
  由运行时加载。版本钉在 `package.json` 的 `profilePlugins` 字段，由 `scripts/setup-profiles.mjs` 安装。
- patch 文件有两种写法，混用会失败：
  - `insert:` 用于**新增**行；
  - 裸 `id:` 用于**覆盖**已有行。
- **只注册 provider 不会改变默认模型**。CLI 场景必须同时覆盖 `agent-default-model`，
  否则运行时继续用别的 provider（表现为莫名其妙的 402）。`cc-cli` 的 patch 已包含这一步。

---

## 3. 证据与脱敏

- 证据写在 `current-0.2.1/evidence/<probe>/`，`summary.json` 是判定，`records.jsonl` 是时间序列。
- **所有证据写入都经 `redact()`**：仓库根 → `<repo>`、用户目录 → `<user-home>`、主机名 → `<host>`。
  JSONL 和 JSON 走同一条脱敏路径（R1.1 修的就是后者漏掉的问题）。
- 本目录 `evidence/` 是 0.1.5 legacy 结果，读法见 `evidence/README.md`。

---

## 4. 历史与边界

- 0.1.5 的原始探针与证据冻结在 `legacy-0.1.5/`，不再覆盖。
- 本机若注入了 `safe-delete` 之类的安全垫，会中止 DSH 自身的 profile 维护删除，导致 legacy 套件
  整体 BLOCKED。探针把这类错误归类为**环境干扰（BLOCKED）**，不计入 FAIL。
- 崩溃恢复（强制杀进程后 resume）、工具审批回调、多 Runtime 资源成本：**未验证**，不要当成已知能力。
