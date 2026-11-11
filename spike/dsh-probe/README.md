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

Windows PowerShell：

```powershell
cd spike\dsh-probe\current-0.2.1
npm install                                  # 探针依赖，精确钉版本
$env:COMMANDCODE_API_KEY = "..."             # 只从环境变量读，绝不写进仓库
npm test                                     # 143 项回归测试 + 六探针 + 三道门禁
```

Windows `cmd.exe`：

```bat
cd spike\dsh-probe\current-0.2.1
npm install
set COMMANDCODE_API_KEY=...
npm test
```

只跑套件（跳过回归测试）：`node run-all.mjs`，期望 `PASS 6/6  GATES PASS/PASS/PASS  exit 0`。
只跑回归测试：`npm run test:unit`，期望 `143/143 tests passed  exit 0`；只有退出 0 才发布 `tests.json`。
只跑受影响门禁（不消耗模型调用）：`npm run gates`（依赖 / 状态一致性 / 脱敏）。

`run-all.mjs` 会**先校验依赖与项目状态**，再跑探针，最后跑脱敏门禁：

1. 依赖门禁：profile 与 `profile-locks/` 比对（版本 + integrity + 安装树指纹 + bundle + 运行时兼容范围）；
2. 状态门禁：`state/project_state.json` 只有一个当前记录（`phase_00_final`），10 条范围门禁有证据、
   DEFERRED/UNKNOWN 登记完整、历史记录未被删除；失败则**任何探针都不运行**；
3. 六个探针；
4. 脱敏门禁：扫描整个仓库的发布文件；
5. 写 aggregate —— 只有门禁跑完才写，避免「结论先于检查」。

任一门禁失败 → `OVERALL FAIL`、退出码 1，**六项探针全 PASS 也不能覆盖**。
**不需要机器上预先存在任何 profile**，也不读写用户的 `~/.dsh`。

依赖锁的维护（普通运行只校验、不生成）：

```powershell
npm run lock:update   # 有意的依赖升级；随后必须重跑 npm test
```

单独初始化（排查用）：

```powershell
node scripts/setup-profiles.mjs --home .\dsh-home --json   # 幂等；缺锁会失败
```

想验证「干净环境可复现」，指定一个全新目录：

```powershell
node scripts/setup-profiles.mjs --home <空目录>\dsh-home
$env:CC_DSH_HOME = "<空目录>\dsh-home"
node run-all.mjs
```

### 前置条件

- Node ≥ 22
- `COMMANDCODE_API_KEY` 可被 DSH 的 credential seam 解析（patch 里只写变量**名**）
- 首次启动可能较慢（要物化 profile 的模块回退），不是卡死

### 探针（6 个，全部自动化）

| 探针 | 验证什么 | 判 PASS 的条件 |
|---|---|---|
| `probe-cli-baseline.mjs`（CC-0） | CLI 真实对话 | 回显随机标识 **且** 自述模型名 **且** 退出码 0。CLI 没有 `request/header`，**不能**用它断言 provider 路由 |
| `probe-commandcode.mjs`（CC-1） | SDK 真实对话 + 路由 | 回显随机标识 **且** 每个 `request/header` 都是 commandcode/目标模型 |
| `probe-cc-tools.mjs`（CC-2） | MCP 工具三阶段 | server 起 → 工具进清单 → **模型真实调用 + Server 审计到 `tools/call.served`** |
| `probe-cc-resume.mjs`（CC-3） | Session Resume | 正常关闭后重启进程仍答出随机口令；不存在的 session 被拒（负对照） |
| `probe-cc-concurrent.mjs`（CC-4） | 并发隔离 | 两会话答案不互换、各自都有通知且不串台、关闭后无残留 |
| `probe-capability.mjs`（CC-5） | 协议能力矩阵 | 每个方法给出确定结论（存在/不存在）。**不做模型调用** |

退出码：`0` 全 PASS；`2` 有 BLOCKED（外部依赖，如凭据缺失）；`1` 有 FAIL 或环境构建失败。

---

## 2. 依赖与 Profile 的关系（容易踩的坑）

- `package.json` 的 `dependencies` 是**探针进程**自己的依赖（SDK 客户端等）。
- `@mars-sea/dsh-commandcode-provider` 不是探针的依赖，它必须装在**DSH profile 的 node_modules** 里，
  由运行时加载。版本钉在 `package.json` 的 `profilePlugins` 字段。
- 真正决定安装结果的是 `profile-locks/<profile>/package-lock.json`：
  `setup-profiles.mjs` 用它跑 `npm ci`，再把结果复制进 profile。所以「今天装到什么」是确定的。
  该插件没有 `dependencies`，只有由 profile bundles 满足的 peer，因此 lockfile 里只有一个条目——
  这是完整的树，不是漏记。
- `profile-locks/<profile>/tree.json` 记录安装树的**文件数与 sha256**。版本号相等但文件被改，
  会被判为 `install-tree` 并触发确定性修复；修不好则整轮失败。
- lockfile 缺失 → `lock-missing`（普通运行**不会**自动补锁）；版本漂移 → `lock-version-mismatch`；
  声明漂移 → `lock-manifest-mismatch`；JSON 损坏 → `lock-invalid`。全部是硬失败。
- patch 文件有两种写法，混用会失败：
  - `insert:` 用于**新增**行；
  - 裸 `id:` 用于**覆盖**已有行。
- **只注册 provider 不会改变默认模型**。CLI 场景必须同时覆盖 `agent-default-model`，
  否则运行时继续用别的 provider（表现为莫名其妙的 402）。`cc-cli` 的 patch 已包含这一步。

---

## 3. 证据与脱敏

- 证据写在 `current-0.2.1/evidence/<probe>/`，`summary.json` 是判定，`records.jsonl` 是时间序列。
- **所有证据写入都经 `redact()`**：仓库根 → `<repo>`、用户目录 → `<user-home>`、主机名 → `<host>`、
  任意绝对路径（盘符 / 带空格目录 / UNC / POSIX 系统根）→ `<abs-path>`，
  凭据形状（API key、token、Bearer、JWT、私钥块、赋值式密钥）→ `<credential>`。
  规则与扫描器共用 `src/lib/redact.mjs` 同一份定义，不会出现「写得干净、查得不同」。
- **不保存模型原文**：CLI 探针只保留退出码、耗时、随机标识是否回显、是否自述模型名、截断后的答案行；
  失败只记录**类别**（QUOTA / AUTH / PLUGIN_INCOMPATIBLE / …），不记录错误文本。
- 控制台输出同样脱敏：所有写出口都在 `src/lib/safe-output.mjs`，子进程输出按**行**转发后逐行脱敏。

### 脱敏门禁

```powershell
cd spike\dsh-probe
node scrub-evidence.mjs --check    # 有残留、扫描失败、或扫不到文件 → 退出 1
```

扫描范围是**整个仓库的发布文件**（git 跟踪 + 未跟踪未忽略），**不设扩展名白名单**：
`.gitignore`、`.orig` 等同样被检查，二进制按 NUL 字节识别并计入 `skippedBinary`。
数据与文档文件会被就地清洗；源码只报告、不改写。
套件本身也执行同一份扫描（`src/lib/scrub.mjs`），失败即 `OVERALL FAIL`。

---

## 4. 回归测试

```powershell
npm run test:unit            # 143 项，夹具全部在临时目录里运行
```

覆盖：路径检测（含一般带空格目录）、凭据规则 7 阳性 / 4 阴性、扫描器边界（空目录、读失败、JSON 解码、无扩展名文件、二进制 NUL）、
CLI 退出码、错误分类 6 例、路由断言 4 例、并发隔离 4 例、门禁判定 6 例、
版本范围 5 例、依赖五场景、**项目状态门禁 15 例（含 11 条负向）**、输出层静态检查，
以及「依赖门禁失败 / 状态门禁失败 → 套件退出 1 且零探针运行」两个端到端用例。

测试通过 `CC_LOCK_ROOT` / `CC_DSH_HOME` / `CC_EVIDENCE_OUT` / `CC_STATE_FILE` 指向临时目录，
不会改动真实的锁、profile、状态文件或证据。

---

## 5. 历史与边界

- 0.1.5 的原始探针与证据冻结在 `legacy-0.1.5/`，不再覆盖。
- 本机若注入了 `safe-delete` 之类的安全垫，会中止 DSH 自身的 profile 维护删除，导致 legacy 套件
  整体 BLOCKED。探针把这类错误归类为**环境干扰（BLOCKED）**，不计入 FAIL。
  同一个安全垫也会终止 `fs.cpSync`（进程直接退出 127，无错误信息），所以初始化脚本用手写递归复制。
- 崩溃恢复（强制杀进程后 resume）、工具审批回调、多 Runtime 资源成本：**未验证**，不要当成已知能力。
