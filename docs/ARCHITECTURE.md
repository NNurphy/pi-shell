# ARCHITECTURE · 架构与代码地图

> 适用范围：**pi-shell v1.2.0**（bridge + 原生 ESM 前端，运行于本机官方 pi 1.5.0）
> 最后更新：2026-11-25（接管/重连的初始 entries 改桥直读会话文件 —— 与会话体积解耦，§13.8）
> 维护者：开发 Agent（下一任）
>
> **维护约定**：每次小版本发版（`x.Y.0`）必须更新本文的版本号与新增机制小节（见 `docs/RUNBOOK.md` §3）。
>
> 契约与实测事实以 `docs/03-design.md` 为准；本文只做"人读版"地图，不复制契约。
> 两者冲突时：**代码 > 本文 > 设计文档**。

---

## 0. 一页速览

| 层 | 是什么 | 关键文件 | 不变量 |
|---|---|---|---|
| 浏览器 | 一套原生 ESM 网页，零构建、零远程资源 | `web/index.html`、`web/src/*.js` | 每列一个 `clientId = <tab>#cN`，一列 = 一个会话 = 一份 SSE |
| 桥 | Node ESM，零第三方依赖，只绑回环（可选 Tailscale 双栈） | `bridge/src/*.mjs` | 不改会话文件；只读 git；日志不记正文 |
| 引擎池 | 一到多个 `pi --mode rpc` 子进程，按列归属 | `bridge/src/engines.mjs` | 上限 4、**60s 空闲回收（流式中 pin，2h 兜底）**、同会话不得双开（无人看管的孤儿引擎可接管） |
| 引擎 | 官方 pi 1.5.0，用同一份 `~/.pi/agent` | `bridge/src/rpc.mjs` | JSONL over stdio，stdout 只放协议数据 |

当前并发口径：**并发 = 列**（1–3 列 / 页），**引擎 = 列 + 引导引擎**（上限 4，`PI_SHELL_MAX_ENGINES` 可改）。
一个标签页默认 1 列（「每个浏览器标签页一个引擎」的用法自然成立）；同一标签页里开 3 列就等于 3 个引擎。

---

## 1. 三层结构与数据流

```
┌──────────────── 浏览器（http://127.0.0.1:7788，桌面；Tailscale 模式另有 http://100.x:7788）────────────────┐
│ web/index.html + 原生 ESM                                                                    │
│   main.js    外壳编排：建/关列、活动列、顶栏跟随、命令面板、设置、MCP 面板、重启桥、健康轮询(2s)   │
│   column.js  一列的全套状态：会话流 / Composer / 滚动 / SSE / 列表打开 / 本轮改动 / 列头          │
│   list.js    会话列表：cwd 分组 + AGENT 板块 + 虚拟化 + 内存过滤                                  │
│   render.js  条目 → DOM：thinking/工具折叠、工具耗时与嵌套、图片                                    │
│   markdown.js / stream.js  MD 子集渲染 / 流式增量状态                                             │
└──▲────────────────────────┬──────────────────────────────┬──────────────────────────────────────┘
   │ ① SSE（每列一条）        │ ② HTTP /api/*（带 X-Pi-Shell-Client） │ ③ 静态 /src/*（CSP 在响应头）
   │ GET /api/events?client=  │                                       │
┌──┴────────────────────────▼───────────────────────────────────────▼──────────────────────────────┐
│ bridge（Node ESM，零依赖）                                                                        │
│   index.mjs       路由 / 静态 / SSE 广播 / 会话打开两段式编排 / 引擎重启 / 本轮改动接线 / 日志       │
│   engines.mjs     引擎池：getOrCreate · own(claim) · release · sweep(60s) · sessionOwner(409)       │
│   rpc.mjs         spawn(process.execPath, cli.js) + JSONL 请求配对 + 崩溃退避重启                    │
│   framing.mjs     只按 \n 切分 + 半行缓冲 + 32MiB 单行上限（PI_SHELL_MAX_LINE_BYTES 可调）        │
│   mcp-config.mjs  MCP 按需：配置校验/原子写/cwd 规则/临时 agentDir（shim）构建与回收                │
│   origins.mjs     会话来源分类（user/agent/test）+ 元数据文件 持久化 + 工具执行窗口                  │
│   sessions.mjs    会话扫描与摘要（只读）/ readSessionEntries（读文件先渲染）                        │
│   turn-changes.mjs 本轮改动快照（write/edit 前后各一份）+ diff 现算                                 │
│   models-config.mjs 只列已配置模型（auth.json / credentials.env）                                  │
│   session-delete.mjs 真删除（先移到 backups/deleted-sessions/<ts>/）                               │
│   files.mjs / git.mjs  工作区只读文件 / 只读 git（GIT_OPTIONAL_LOCKS=0）                            │
│   bind.mjs        绑定地址解析（loopback / tailscale 双栈 / 显式 IP / 0.0.0.0 拒绝）                │
└──▲────────────────────────────────────────────────────────────────▲─────────────────────────────┘
   │ stdin：命令 JSONL（带 id）                                        │ stdout：response / 事件 JSONL
┌──┴──────────────────────────────────────────────────────────────────┴─────────────────────────────┐
│ 引擎池：N 个 `pi 1.5.0 --mode rpc [--session-dir …] [--no-mcp]`                                    │
│   每个子进程独立 PI_CODING_AGENT_DIR（默认 ~/.pi/agent；勾了 MCP 时指向临时 shim 目录）             │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **① SSE 按引擎路由**：`broadcast(engine, payload)` 只写给 `engine.extra.sseClients`——也就是只写给"这一列"的那条 `EventSource`。帧里带 `engine`（= 该列的 clientId），列与列之间不会串流。**已落盘的历史不缓存**，补齐靠 `session/open` + `GET /api/session/entries?since=<最后 entryId>`（`resync` 帧要求全量重载）；**未落盘的尾巴**（`sse-tail.mjs`）按 `?since=` / `Last-Event-ID` 回放，先发一帧 `resume={from,to,truncated}`（见 §13.4）。
- **② HTTP**：34 条路由（`bridge/src/index.mjs` 实点），契约以 `docs/03 §5` 为单一事实来源。
- **③ 静态**：仅 `web/`，禁目录列表，越界/符号链接 403。

---

## 2. 引擎池（`bridge/src/engines.mjs`）

一个 `Engine = {id, rpc, owner, mcp[], pinned, createdAt, lastSeenAt, extra}`；`extra` 挂桥侧状态（`cwd`、`claim`、`sseClients`、`pendingExtDialogs`、`restarting`）。池只做**生命周期**，协议仍由 `rpc.mjs` 负责。

| 动作 | 触发 | 口径 |
|---|---|---|
| 创建 | `POST /api/engine/claim`、`/api/events`、任一"操作型"端点首次带新 clientId | `getOrCreate(clientId)`：先 `sweep()` 清僵尸 → `find()` 命中就复用 → 否则 `full()` 判上限 → 新建 |
| 上限 | `PI_SHELL_MAX_ENGINES`（默认 **4**） | `liveCount() >= max` → `503 PI_NOT_READY`「已达并行上限（N）：关闭一个标签页再试」 |
| 活引擎口径 | `isAlive()` | `pinned` 引导引擎算活着；`stopping` 不算；**`streaming` 算活着（S1：pin，超过 `MAX_PIN_MS`=2h 才不算）**；有 SSE 连接算活着；`idleMs` 内有请求算活着。**不数池内全部记录**（旧实现把僵尸算活，导致关掉标签页后 60s 内重开被误判超限） |
| 认领 | 标签页第一次来（`X-Pi-Shell-Client` 或 `?client=`） | `own(engine, clientId)`：池内键与 `id` 同步改名（SSE 帧/health 里显示的就是列标识），`pinned=false` → 从此参与空闲回收。启动即拉起的**引导引擎**被第一个来认领的列拿走，不额外起进程 |
| 回收 | `sweep()`，每 **5s** 一轮 | 先跳过 `stopping` / `pinned` / **`streaming`（S1）** / 有 SSE / 未过 `idleMs`；命中 → `release(engine, "idle-sweep")`：先 `rpc.stop()`，再 `onRemove(engine)`（MCP shim 的临时目录就在这里删） |
| S1 pin | 状态变化钩子（`bridge/src/index.mjs` `noteEngineState()`） | `streaming` → `noteStreaming()` 记本轮起点（`streamStartedAt`）；`idle`（含 `agent_settled`）→ `noteSettled()` 清起点 + `touch()`，再按 `idleMs` 回收。流式超过 `MAX_PIN_MS`（2h）→ 允许回收并记 `warn engine_pin_expired`（兜底，防卡死占槽）。`PI_SHELL_IDLE_MS` 可调 `idleMs` |
| S3 接管 | `POST /api/session/open` 命中别的引擎占着同一会话时 | `pool.adoptable()` 四条全中（同会话 + 非自己 + **无 SSE** + 静默 ≥ `ADOPT_GRACE_MS`）才走 `pool.adopt()`：**先 `release` 本 clientId 的旧引擎，再 `own()`**（同键覆盖会静默丢进程） |
| 同会话保护 | `POST /api/session/open` 之前 | `sessionOwner(sessionFile, {except})`：比对 `rpc.lastGetState.sessionFile` **和** `extra.claim`（attach 未完成时的占位），路径归一 + 大小写不敏感；命中别的引擎 → `409 CONFLICT`「该会话已在另一个标签页打开」。**例外**：命中引擎无 SSE 且静默 ≥30s（`PI_SHELL_ADOPT_GRACE_MS`）→ 可接管（S3，见 §13.5），有活跃标签仍然 409 |
| 重启（应用 MCP） | `POST /api/engine/restart {client, mcp:[…]}` | 见 §3；名单不变 → 幂等返回 `restarted:false`（不白停一次子进程）；`streaming` 中或正在重启 → `409` |

**引导引擎（pinned）**：桥启动就拉起一条 pi，既有脚本（`waitHealth`）依赖它；未被认领前不参与空闲回收，被认领后按普通引擎处理。

**引擎归属（操作型 vs 全局）**：`claim / events / session/open|new|entries|tree|fork|clone / prompt / abort / clear-queue / model / thinking / thinking-levels / stats / ext-ui-response / workspace / turn-changes(按列 cwd) / engine/restart` 走**调用方自己的引擎**；`health / sessions（含 DELETE）/ git/diff / files / file / models / models/reload / mcp/state / mcp/config / restart` 走**桥自身**（不额外起进程）。

---

## 3. MCP shim（`bridge/src/mcp-config.mjs`）

### 3.1 为什么需要它（硬事实）

pi 1.5.0 **没有**"按 server 选择性加载"的开关（`docs/03` H-16）：

- `--no-mcp` 是唯一内建开关，只能**全开 / 全关**；
- server 名单只从两处读：`<agentDir>/mcp.json`（全局）与 `<cwd>/.pi/mcp.json`（项目级，需受信任）；
- **没有** `--mcp-config`、**没有** `PI_MCP_CONFIG`；
- 唯一可重定向的是 `<agentDir>` 本身（`PI_CODING_AGENT_DIR`）。

### 3.2 做法：为一条引擎生成临时 agentDir

```
建引擎（mcp 非空）
  → createMcpShim({agentDir, servers, client})
       · 真实 agentDir 里的**目录** → symlink(…, "junction")（skills / install / memory / state …）
       · 真实 agentDir 里的**文件** → copyFile（settings.json / auth.json / models*.json …）
       · 只把 mcp.json 换成"只含选中 server"的生成文件（删掉 entry.enabled，选中即启用）
       · 目录：%TEMP%\pi-shell-mcp\<client 安全化>-XXXXXX
  → 子进程以 PI_CODING_AGENT_DIR=<shim> 启动（此时**不加** --no-mcp）
  → 回收 / 换名单 → cleanup()：rmSync 递归删（对 junction 只删链接、不动真实目录）
```

**选中集为空** → 不建 shim，子进程直接 `--no-mcp`（最省，单引擎整棵树 ≈90MB vs 全开 ≈544MB）。

### 3.3 名单从哪来

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 手动勾选（`POST /api/engine/restart {mcp:[…]}`） | 按列，覆盖一切；列头显示 `MCP·N` |
| 2 | cwd 规则 `rules[].cwd` | `~/.pi/agent/pi-shell-mcp.json`（`PI_SHELL_MCP_CONFIG` 可覆盖路径）；`*`/`?` 通配、**首条命中即止**、大小写不敏感 |
| 3 | `default` | 都不命中时用；缺省 `[]` = 不带 |

候选名单永远来自 `~/.pi/agent/mcp.json` 的 `mcpServers`（名称/command/args/env/description 原样继承）；`"enabled": false` 只是"默认休眠"，勾选照样能开。写了不存在的名字 → 静默剔除（`mcp_shim_unknown_server` 只进日志）。

### 3.4 已知限制（照实写）

- shim 里 `settings.json` / `auth.json` 是**拷贝**：引擎内对设置/token 的写入落在临时目录，重启时从真实目录重取（不写坏真实配置，但该引擎内改设置"看起来没生效"）。
- 名单变化必须**换子进程**（pi 不能进程内懒加载 MCP）；UI 有"约 1 秒重启 / 会话不变"提示与开关禁用态。
- 脚本直接 `claim` 带 `mcp` 不会立刻生效：响应给 `needsRestart:true`，要随后调 `POST /api/engine/restart`。
- 桥被强杀会残留 `%TEMP%\pi-shell-mcp\` 目录；下次启动兜底，可手删。
- `bilibili` 这类 `command` 指向本机绝对路径的自定义 server **未实测**。

---

## 4. 会话来源分类（`bridge/src/origins.mjs`）

机制级分类（不是给历史会话贴一次性标签），三类：`user` / `agent` / `test`。

判定顺序（命中即止，`classifyOrigin()` 是纯函数，便于单测）：

1. **手动覆盖**：元数据文件里已有记录 → 原样使用（可手改）。
2. **目录规则**：会话文件位于 `PI_SHELL_AGENT_SESSIONS_DIR`（默认 `~/.pi/agent/sessions-agents`）之下 → `agent`；元数据文件的键带根名前缀时无绝对路径也能判。
3. **工具执行窗口**：`header.timestamp` 落在任一引擎的 `tool_execution_start/end` 窗口 `[start-2s, end+5s]` 内 → `agent`。这是"AI 派生的会话"的机制指纹（AI 只能在工具调用期间派生新会话）。`ToolWindowTracker` 保留最近 200 个窗口，未闭合窗口按"至今仍在执行"处理。
4. **测试规则**：路径含 `pi-shell-probe` / `pi-shell-e2e` / `pi-shell-audit`，或 `header.cwd` 在系统临时目录下 → `test`。
5. 其余 → `user`。

持久化：`<agentDir>/sessions-origins.json`（覆盖 `PI_SHELL_SESSIONS_DIR` 时落在其同级目录）→ `{ "<相对会话根路径>": {origin, reason, classifiedAt} }`。键归一（`\`→`/`、去 `./`），原子写（tmp + rename），200ms 防抖合并写，超过 5000 条按 `classifiedAt` 删最旧。**桥自己维护的元数据文件，不写进 pi 的会话文件**。

界面口径：`/api/sessions` 默认不返回 `test` 会话；`agent` 会话进侧栏顶部独立板块「AGENT 会话（N）」并带 `AGENT` 徽标。

---

## 5. 会话树（前端派生，不改桥协议）

- 数据源：`GET /api/session/tree` = pi `get_tree` 的嵌套结构，**全部派生在前端**（父链 / depth / childCount / 子树节点数），桥不动。
- **主干优先**：默认只展开"当前 leaf 的父链"，兄弟折叠成一个"分支摘要行"（点开分页加载）。
- **扁平渲染**：一行一个 `div`，**不嵌套 DOM**（避免深链把布局吃掉）；缩进 = `min(depth, 3) * 12px`，超过 3 层显示 `D<depth>` 徽标而不是继续缩进。
- **深链兜底**：主干 > 1500 节点时根侧留 300 + 叶子侧留 1200、中间折叠成"展开 500"；DOM 行数硬上限 4000、每页 500 行。实测 949 层、5000 节点仍可用（首屏 85ms、DOM 行 1502）。
- **交互层**（PIX-2）：单击=选中（`aria-selected`，全局唯一，不动主对话）；双击或 `Enter`=在主对话中定位（`.is-located`）；`f`/「从此处继续」= `POST /api/session/fork`；「复制消息」= 剪贴板；`j`/`k` 上下选、`/` 聚焦搜索；「仅看分支点」只留 user 节点 / 分叉点 / 叶子。
- **fork 只支持 user 节点**：assistant / 工具节点按钮禁用并给 tooltip——刻意口径（从 AI 的话中间分叉没有语义）。

---

## 6. 本轮改动快照（`bridge/src/turn-changes.mjs`）

回答"这一轮 AI 到底改了哪些文件、改了什么"。

- **机制**：桥监听 pi 事件流的 `tool_execution_start` / `tool_execution_end`（外加流式 `toolcall_end` 预抓一次），对 write/edit 类工具（`args.path` / `args.file_path`）把文件拷到 `backups/turn-snapshots/<sessionId>/<turn>/<hash>-before|after`（可用 `PI_SHELL_TURN_SNAPSHOTS` 覆盖根目录）。
- **轮号**：会话内第 N 条 user 消息；旧会话的基数从会话文件里数回来（桥重启 / 打开旧会话都不错位）。
- **diff 来源**：读取时用 `git diff --no-index --unified=3` 现算（失败退化为空 diff，不阻塞工具执行）。
- **上限**：单轮 ≤50 个文件存内容、单文件 ≤2MiB、单轮总 ≤50MiB、单轮路径记录 ≤500、单文件 diff ≤512KiB（超出截断）；每会话只留最近 **20 轮**（启动时 + 每轮结束时清理）。
- **接口**：`GET /api/turn-changes?session=<id>&turn=<n>`（`turn` 省略 = 当前最近一轮）。
- **界面**：顶栏 `Changes` → 面板默认「本轮」（第 N 轮 · M 个文件，A/M/D + `+A −B` + 内联 diff），另一页「工作区」对齐 `git status --porcelain`；无改动显示空态。工作区干净/非 git 仓库时 Changes 按钮仍会在"本轮有改动"时出现。
- **已知竞态**：事件是异步回放而非 hook，桥收到时 pi 可能已经开始写文件 → `before` 偶发等于改后内容（diff 偏小）。

---

## 7. 安全边界

| 面 | 口径 | 实现 |
|---|---|---|
| 默认监听 | 只绑 `127.0.0.1`，不联网、无账号、无 cookie 登录 | `bind.mjs` `resolveBind()` 未设 `PI_SHELL_BIND` → loopback |
| 手机访问 | `PI_SHELL_BIND=tailscale` → 自动取 `tailscale ip -4`（失败再扫网卡 100.64.0.0/10）并**双栈**监听 `127.0.0.1` + `100.x`（同一端口、共享 handler） | 只走加密 tailnet，不开公网、不做端口转发 |
| 通配绑定 | `PI_SHELL_BIND=0.0.0.0` / `::` / `*` → **拒绝启动**（exit 1，文案给替代方案），除非 `PI_SHELL_ALLOW_LAN=1` | 日志 `bind_adjusted reason=wildcard_allowed_by_env` |
| 非法值 | 回落 `127.0.0.1` 并告警（不静默外露，也不静默崩溃） | `reason: invalid_bind` |
| 认证 | **无**——tailnet 即边界（能连到端口的人就能操作 pi） | 设计取舍，写进 USER-GUIDE 与 RUNBOOK §6.5 |
| 文件/Git | 只读；`resolve` + `realpath` 双重校验；文本 1MiB / 二进制 8MiB；`GIT_OPTIONAL_LOCKS=0` + 5s 超时 | `files.mjs` / `git.mjs` |
| 日志 | 只记动作（方法/路径/状态/耗时/事件名），**不记消息正文**，`sk-` / `tvly-` 类密钥兜底脱敏；按大小轮转（`PI_SHELL_LOG_MAX_MB=5` × `PI_SHELL_LOG_KEEP=5`），启动时顺带整理 launcher/notify/mcp | `log.mjs`、`index.mjs` log() |
| 静态 | 仅 `web/`，禁目录列表，越界/符号链接 403，CSP 走响应头 | `index.mjs` |

---

## 8. 模块地图（模块 → 职责 → 关键入口）

### 8.1 桥（`bridge/src/`）

| 模块 | 职责 | 关键导出 / 入口 |
|---|---|---|
| `index.mjs` | HTTP 路由、静态、SSE 广播与尾巴回放、会话打开两段式编排（含孤儿接管）、会话视图、新会话选目录、引擎重启、本轮改动接线、绑定启动、日志 | `main()`、`broadcast(engine, payload)`、`resolveOpEngine()`、`handleEngineRestart()`、`handleSessionView()`、`handleNewSession()`、`restartEngineForCwd()`、`adoptOrphanEngine()`、`resetSseTail()` |
| `log.mjs` | 日志按大小轮转：写前检查、启动整理其它日志、手动脚本共用同一套实现 | `rotateIfNeeded()` / `rotateIfNeededAsync()` / `appendWithRotation()` / `resolveLogLimits()` / `DEFAULT_ROTATE_FILES` |
| `engines.mjs` | 引擎池与生命周期（pin / busy / 接管） | `EnginePool`（`getOrCreate/own/release/sweep/sessionOwner/adoptable/adopt/liveCount`）、`Engine.noteStreaming/noteSettled/beginBusy/endBusy`（`busy` 期间 `isAlive` 为真、不参与 `sweep`）、`MAX_PIN_MS`、`DEFAULT_ADOPT_GRACE_MS`、`resolveMaxEngines()`、`DEFAULT_MAX_ENGINES=4`、`DEFAULT_IDLE_MS=60000` |
| `rpc.mjs` | spawn + JSONL 请求配对 + 握手 + 崩溃退避重启 | `PiRpc`（`request()`、`args()`：`--mode rpc` / `--session-dir` / `--no-mcp`、`env()`：`PI_CODING_AGENT_DIR`） |
| `framing.mjs` | 只按 `\n` 切分、半行缓冲、单行上限 32MiB 丢弃（`PI_SHELL_MAX_LINE_BYTES` 覆盖，非法值回退默认并记 warn） | `parseRecord()` / `FrameSplitter` / `parseMaxLineBytes()` |
| `sse-tail.mjs` | SSE 尾巴缓冲：按 seq 保存未落盘帧，供断线/接管回放（不重复、不乱序） | `SseTail`（`push/reset/since`）、`DEFAULT_MAX_BYTES=2MB`、`DEFAULT_MAX_FRAME_BYTES=512KB` |
| `session-view.mjs` | 会话视图纯解析（B1）：`cwd/sessionFile/model/thinkingLevel/mcp` + 按 client 选引擎 | `buildSessionView()` / `normalizeModel()` / `pickSessionEngine()` / `pickReadEngine()` |
| `project-dir.mjs` | 新会话目录校验与归一（A1） | `normalizeProjectDir()` / `resolveProjectDir()` / `sameProjectDir()` |
| `mcp-config.mjs` | MCP 按需配置 + shim 构建 | `loadShellMcpConfig()` / `validateShellMcpConfig()` / `writeShellMcpConfig()` / `resolveMcpServers()` / `createMcpShim()` / `listAvailableServers()` |
| `origins.mjs` | 会话来源分类 + 工具窗口 + 元数据文件 | `classifyOrigin()` / `ToolWindowTracker` / `OriginStore` |
| `session-memory.mjs` | 「每个 client 最后打开的会话」持久化元数据文件（原子写 / 去抖 / LRU） | `SessionMemoryStore`（`loadSync/get/set/delete/flush/flushSync`）、`resolveLastSessionsFile()`、`SESSION_MEMORY_MAX=64` |
| `sessions.mjs` | 会话扫描与摘要（只读）、读文件先渲染 | `SessionIndex`、`messageText()` |
| `turn-changes.mjs` | 本轮快照与 diff | `TurnChanges`、`TURN_LIMITS`、`isWriteTool()` |
| `models-config.mjs` | 只列已配置模型（`auth.json` / `credentials.env`） | `getModelsConfig()` / `invalidateModelsConfig()` / `annotateModels()` |
| `session-delete.mjs` | 真删除（先移到 `backups/deleted-sessions/<ts>/`） | `deleteSession()` |
| `files.mjs` | 工作区只读文件 | `listDir()` / `readFileSafe()` |
| `git.mjs` | 只读 git（status / diff --stat / diff） | `gitStatus()` / `gitDiff()` |
| `bind.mjs` | 绑定地址解析与横幅 | `resolveBind()` / `bindHosts()` / `bindBannerLines()` |

### 8.2 前端（`web/`）

| 模块 | 职责 | 关键入口 |
|---|---|---|
| `index.html` | 结构：顶栏（含 `⋯` 菜单）、侧栏、`#columns`、Composer、设置/MCP/面板/模态/遮罩 | `#column-1`、`#overflow-menu`、`#mcp-panel`、`#panel` |
| `src/main.js` | 外壳：建/关列、活动列、顶栏跟随、命令面板、设置、MCP 面板、重启桥、健康轮询（2s，兼作布局自愈时钟）、会话列表编排、全局快捷键 | `setColumnCount()`、`claimEngineFor()`、`pollHealth()`、`restartBridge()`、`openMcpPanel()` |
| `src/column.js` | 一列的全部状态与请求（会话流/Composer/滚动/SSE/打开会话/本轮改动/列头） | `createColumn({key, clientId})`、`connect()`、`postJson()` |
| `src/list.js` | 会话列表：cwd 分组 + AGENT 独立板块 + 虚拟化（>200 项）+ 内存过滤 | 折叠键 `AGENT_SECTION` |
| `src/render.js` | 条目 → DOM：折叠、工具耗时（`durationMs` 优先）、嵌套（`parentToolCallId`）、图片 | `renderEntries()`、`toolMeta` |
| `src/markdown.js` | 最小 GFM 子集 → DOM（全 `textContent`/DOM API） | — |
| `src/stream.js` | 实时事件 → 文本状态（增量 + `*_end` 覆盖） | — |
| `src/tokens.css` / `style.css` | 设计 token 单一来源（light/dark）/ 全部布局规则（`≤900px` 单列+切换器，`≤768px` 移动） | `body[data-cols]` |

### 8.3 脚本（`scripts/`）

| 脚本 | 用途 |
|---|---|
| `start-pi-shell.cmd` | 控制台入口（调试）：单实例、Tailscale 自动双栈、崩溃自愈（1s/2s/4s，5 分钟 3 次）、3s 后开浏览器 |
| `tray-pi-shell.ps1` | 托盘程序（v1.1.0）：隐藏控制台、托盘右键控制（打开/重启/停止）、tooltip 实时引擎数、单实例 Mutex、浅/深色图标随主题 |
| `setup-windows.ps1` | 桌面快捷方式安装器（v1.1.0）：创建/更新 `pi-shell.lnk`（托盘入口）与「重启 pi-shell.lnk」，幂等，`-Remove` 一键移除 |
| `make-icon.mjs` | favicon.svg → 两个 .ico（浅/深色，16/32/48/256），Edge headless 截图 + PNG-in-ICO 拼装，零 npm 依赖 |
| `restart-pi-shell.cmd` / `.ps1` | 桌面「重启 pi-shell」快捷方式 |
| `tailscale-setup.ps1` | 打印 `100.x` 地址与排查清单；`-Apply` 只加一条仅 100.64.0.0/10 的入站规则 |
| `test-gate.mjs` | 分层发版门（`--tier patch` = 轻量健康集 / `--tier full` = 全量；需开发期 E2E 套件，公仓不含） |
| `smoke-check.mjs` | 照妖镜（A-01~A-08 + N） |
| `evidence/*.mjs` | 证据脚本（截图 + 断言）；全部用 78xx/79xx 端口 + 夹具会话，**不碰真实桥 7788** |

---

## 9. 一次请求的生命周期（每列独立）

1. 列提交 → `POST /api/prompt`（带该列 `X-Pi-Shell-Client`）。
2. 桥 `rpc.request("prompt")`：pi 回 `{disposition}` → `started/queued` 置 `streaming`，`handled` **立即**置 `idle`。
3. pi 在 stdout 输出事件 → `framing` 切分 → `rpc` 解析 → 桥加 `seq` → **只广播给该引擎的 SSE 连接**。
4. `stream.js` 消费 `assistantMessageEvent` 增量 → 文本气泡；`message_end` 由 `render.js` **就地富渲染**（替换同一气泡，不新增）。
5. `agent_settled` → `idle`；页面刷新列表、`/api/stats`、`/api/turn-changes`（Changes 计数）。
6. 断线：SSE 每 15s 重试（不再 3 次弃疗）→ 横幅；重连带 `?since=<本列 lastSeq>`，桥先回 `resume` 帧再回放未落盘尾巴；已经落盘的部分由 `entries?since=<最后 entryId>` 补齐（`resync` 帧 = 全量重载）。`agent_settled` 后做一次权威重载，把回放合成的 live 节点换成正式 entry 节点。

---

## 10. 不变量（人读版）

1. **同会话不得双开**：`sessionOwner()` 命中即 `409`——但 pi 本身不加锁，终端与网页同开**拦不住**（桥只能提示 + 备份）。
2. **默认不带 MCP**：新引擎一律 `--no-mcp`；要 MCP 必须显式勾选或命中 cwd 规则（名单在建引擎时决定，改名单 = 换子进程）。
3. **一列 = 一个引擎 = 一条 SSE = 一个会话**：`clientId = <tabId>#cN`；引擎池按 clientId 归属，SSE 按引擎广播。
4. **引擎上限 4 是硬约束**（`PI_SHELL_MAX_ENGINES`）；列上限 3 是 UI 约束；两者都靠 `liveCount()` 判，不数僵尸。
5. **默认分组收起**：每次打开页面侧栏分组不自动展开；同 cwd 的 agent 分组与主组合并，不出现两个同名分组。
6. **新会话不落盘**：发第一条消息前没有 `.jsonl`（列表里不会出现，`fork/clone` 也会被 pi 拒绝）。
7. **"看"走读文件，"接管"才 `switch_session`**：读文件渲染零副作用；接管才碰引擎（默认无 MCP 时 ≈0.2s，勾了 MCP 回退到 1–3s）。
8. **JSONL 只按 `\n` 切分**（禁 `readline`，U+2028/2029 会误判）；单行上限 32MiB（`PI_SHELL_MAX_LINE_BYTES` 可调），超限丢弃不中断。**接管/重连的初始 entries 不看这条上限**：`attachSession` / `restoreEngineSession` / `handleEngineRestart` / 孤儿接管 / 复用路径一律由桥直读会话文件（§13.8），`get_entries` 只留给 `?since=` 增量与回合结束的权威重载。
9. **不能 `spawn("pi")`**：Windows 下必须 `spawn(process.execPath, [cli.js, …])`；`.cmd` 退路不实现。
10. **stdout 只放协议数据**；日志写文件，仅 TTY 时镜像 stderr（非 TTY 不写，避免 Windows 管道同步写阻塞）。
11. **文件和 Git 只读**，路径 `resolve`+`realpath` 双校验，不写 `index.lock`。
12. **证据脚本零真实会话写入**：全部用 78xx/79xx 端口 + 夹具会话/夹具 agentDir，真实桥（7788）与 `~/.pi/agent` 全程不碰（这类脚本属于开发期工具，不随公仓发布）。
13. **`0.0.0.0` 默认拒绝**；Tailscale 模式必须双栈（只绑 `100.x` 会让 `127.0.0.1` 失效，这是 Q2 修过的回归）。
14. **fork 仅 user 节点**；嵌套工具调用（`parentToolCallId`）不进会话文件，历史会话无法重建嵌套。
15. **`health.engines[].mcp` 是 server 名单数组**（如 `["codegraph"]`）。
16. **流式中的引擎不被空闲回收**（S1）：只要 `state==="streaming"` 就算活着；只有超过 `MAX_PIN_MS`（2h）才允许强收（日志 `engine_pin_expired`）。显式 `abort` / `release` / 切会话 / 新建会话 / 改 MCP **不受 pin 保护**。
17. **SSE 尾巴只回放未落盘部分**：回放起点 = `max(since, baseSeq)+1`；`message_end` 落盘即 `reset`；只缓冲 `streaming` 期间的内容帧，控制帧（`bridge_state` / `resync` / `session_attached*` / `extension_ui_request`）与启动期帧不进缓冲；超 `PI_SHELL_TAIL_MAX_BYTES`（2MB）或单帧 >512KB → `truncated`。
18. **接入（adopt）不 reset 尾巴、不重建 MCP shim**；且必须**先 release 再 own**（同 clientId 覆盖会静默丢旧引擎）。
19. **接管/恢复期间引擎算「忙」**（`Engine.beginBusy/endBusy`）：忙碌期间 `isAlive` 为真、不被 `sweep` 回收（否则 `switch_session` 在飞时看起来 idle 又无 SSE，会被当僵尸 SIGTERM → `engine_restore_failed code=PI_NOT_READY`）。可嵌套计数，`endBusy` 不会减成负数，结束时刷新 `lastSeenAt` 重新起算空闲窗口。
19. **会话 cwd 的真相是会话 header**：`attach` / `new_session` / 引擎重启后回写到 `engine.extra.cwd`；顶栏只读 `GET /api/session/view?client=<本列>`，不再拼四个端点。

---

## 11. 版本与兼容

> 版本号即对外发布口径；契约与行为变更记录在 `CHANGELOG.md` / `RELEASE-NOTES.md`，用户可感知的变化在 `docs/WHATS-NEW.md`。

| 版本 | 主题 | 说明 |
|---|---|---|
| v1.2.0 | 接管与会话体积解耦 | 接管/重连/恢复的初始 entries 改桥直读会话文件（`entriesVia=file`），`get_entries` 只留给 `?since=` 增量与权威重载；接管/恢复期间引擎标记 `busy` 不被空闲回收；`bridge` 单测 226/226 |
| v1.1.0 | 桌面化 + 超大会话接管修复 | LOGO 图标与快捷方式安装器（`setup-windows.ps1`）、系统托盘模式（`tray-pi-shell.ps1`）、JSONL 单行上限 8MiB→32MiB（`PI_SHELL_MAX_LINE_BYTES` 可调）；`bridge` 单测 223/223 |
| v1.0.0 | 首个公开发布 | 多列并行、SSE 断线重连与恢复、后台不中断、会话记忆持久化、MCP 按需、树视图与本轮改动面板、模型配置 UI；`bridge` 单测 216/216 |

口径必读（v1.0.0 的几条约定）：

1. **「并发 = 列」**：一个标签页开 3 列 = 3 个引擎；「复制标签页」会共享 `clientId`（刻意取舍，避免悄悄多占进程）。
2. **Tailscale 默认开（脚本启动时）**：用 `scripts\start-pi-shell.cmd` 启动时，本机装了 Tailscale 且拿到 `100.x` 就自动加绑；`PI_SHELL_NO_TAILSCALE=1` 关，直接 `node bridge\src\index.mjs` 不自动绑。
3. **模型只认配置文件**（`auth.json` / `credentials.env`），环境变量里的假 key 不再被当真。
4. **默认无 MCP**：codegraph / mcp-obsidian 不会自动在；需要时逐列勾选或写规则文件。
5. **新会话先选目录**：点「新会话」会先弹项目选择层；脚本直接调 `POST /api/session/new` 不传 `cwd` 仍然可用（沿用当前运行时 cwd）。
6. **关标签不再中止本轮**：引擎会在后台跑完（pin）；但**桥进程重启**（含界面内「重启桥」）仍会释放全部引擎，正在跑的回合会丢。

---

## 12. 运行时：标签页身份、引擎统计、日志轮转

### 12.1 标签页身份（tab-identity.js）
- `sessionStorage` 里的 clientId **会被"复制标签页"复制**；两个页面若共用同一个 clientId，会认领同一个引擎（互相顶掉、误报上限）。
- 解决：启动时用 `BroadcastChannel('pi-shell')` 广播 `hello`，300ms 内收到同 id 的 `here` → 判定被复制，**重新生成 clientId**；另有 `localStorage` 心跳表（30s TTL）兜底。
- 换 id 后重新 `claim` 并 `open` 原 sessionFile；若该会话已被旧页占用 → 409，页面保持只读并提示。

### 12.2 引擎统计（engine-stats.mjs）
- `GET /api/engines/stats` 返回每个引擎的 `{client, tab, state, sessionId, sessionTitle, mcp, piPid, rssMB, idleSec, pinned, live}`；`live` 取 `pool.isAlive()`（`streaming` 算 `true`）。
- RSS 为**整棵进程树**（pi + MCP 子进程）之和；用一次 `Get-CimInstance Win32_Process` 批量取，**5 秒缓存**，不进入 health 热路径。
- `POST /api/engine/release`：只回收指定 client 的引擎（会话文件不动）。

### 12.3 日志轮转（log.mjs）
- `appendWithRotation`：写入前检查大小，超 `PI_SHELL_LOG_MAX_MB`（默认 5）→ `name` → `name.1` … → 删最旧，保留 `PI_SHELL_LOG_KEEP`（默认 5）份；轮转行记 `log_rotated`。
- 桥启动时对 `bridge.log / launcher.log / notify.log / mcp.log` 执行一次 `rotateIfNeededAsync`（不阻塞启动）。
- 手动：`node scripts/rotate-logs.mjs --max-mb 5 --keep 5 [--dry-run]`。

---

## 13. 会话即项目 + 后台不中断

### 13.1 新会话可选目录（A1）

- 端点：`POST /api/session/new` 接受可选 `{cwd}`；不传 = 沿用当前运行时 cwd（旧行为与响应里的 `cwd` 字段都保留）。
- 顺序（必须）：先 `resolveProjectDir()`（`path.resolve` + 去尾分隔符 + `stat` 必须是已存在目录）→ **再碰进程**。目录非法 → `400 BAD_REQUEST`，引擎与当前会话都不变。
- 换目录：与该列运行时 cwd 不同（忽略大小写/尾分隔符）才 `restartEngineForCwd()`——停子进程 → 写 `engine.extra.cwd` → 清 `claim`（新空会话不占旧文件）→ **按新 cwd 重算 MCP 名单**（项目级 `.pi/mcp.json` 规则随 cwd 变）→ 重建 rpc → 等 idle（≤45s）。同目录不重启。
- 拒绝：`streaming` → `409`；引擎正在重启 → `503`；重启失败 → `502 PI_ERROR`（保留错误文案，不静默换目录）。
- 前端：点「新会话」先弹「选择项目」（桌面居中卡片 / ≤768px 底部抽屉）。候选 = `/api/sessions` 各分组 cwd（按最近会话排序，含 agent 板块）+ `localStorage['pi-shell.recentDirs']` 最近 5 个 + 「其他目录…」手输；选中后写回最近 5 个；弹层单例（开着再点不叠层）。
- H-5 不变：新会话**发第一条消息才落盘**。

### 13.2 会话视图端点（B1）

- `GET /api/session/view?client=<id>` → `{cwd, sessionFile, model, thinkingLevel, mcp[]}`。纯只读：显式 client 未命中 → `404 NOT_FOUND`（**不创建**引擎）；未带 client → 主引擎（兼容既有脚本）；握手未完成 → `503`。
- 字段真相：`cwd` 取 `engine.extra.cwd`（T2 已在 attach / new / restart 后按**会话 header** 回写）；`sessionFile/model/thinkingLevel` 取最近一次 `get_state`（不额外发 RPC）；`mcp` 取引擎当前名单。无全局缓存，按 client 现算。
- `/api/models`、`/api/commands` 支持 `?client=`：命中该引擎，未命中回落主引擎。
- 前端 `syncHeaderFromSession(col)` 是顶栏唯一入口（切换列 / 列更新 / `openSession` / `newSession` / SSE `session_attached` 都调它）；`sessionViews` 按 client 缓存，切列先用缓存回填，避免闪上一列的值。
- `git/diff` 的 cwd 白名单两侧先 `path.resolve` 再比（修引擎重启窗口里 `sessionFile` 未回填导致的误判 403）。

### 13.3 流式中不回收（S1，`bridge/src/engines.mjs`）

```
state=streaming → noteStreaming() 记 streamStartedAt → isAlive=true / sweep 跳过
agent_settled / idle → noteSettled() 清起点 + touch() → 再 linger 一个 idleMs（默认 60s）才回收
streaming 超过 MAX_PIN_MS（2h）→ 允许回收并记 warn engine_pin_expired（兜底，防「永远卡住」占死槽位）
```

- 只有 `idleMs` 可调（`PI_SHELL_IDLE_MS`，默认 60000）。
- 显式 `abort` / `release` / 切会话 / 新建会话 / 改 MCP **不受 pin 保护**（语义不变）。
- `isAlive()` 认 `streaming` → 资源面板 `live=true`、`引擎 N/4` 与上限判定同口径。

### 13.4 SSE 尾巴回放（S2，`bridge/src/sse-tail.mjs`）

- 边界用**落盘点**切：每个 `message_end` 广播后 `resetSseTail(engine)`（`baseSeq = seq`），此前帧丢弃（已完成内容在 entries 里）。
- **只缓冲本轮流式内容帧**（`engine.state === "streaming"`）；控制帧（`bridge_state` / `resync` / `session_attached*` / `extension_ui_request`）与启动期帧不进缓冲；连接快照也不入缓冲。
- 会话身份变化即 reset：`switch_session` / `new_session` / 引擎重启（MCP 切换、换 cwd）。**接管（adopt）不 reset**——前后是同一会话同一轮，尾巴就是后台还在跑的那段。
- 上限：`PI_SHELL_TAIL_MAX_BYTES`（默认 2MB）；单帧 >512KB 跳过并置 `truncated`；超总上限丢最旧帧。
- 连接时先回 `{type:"resume", from, to, truncated}`（控制帧，无 `id:` 行），再同步写回放帧；回放窗口 = `max(?since= 或 Last-Event-ID, baseSeq)+1 .. lastSeq`；无 `since`（新页面/刷新）从 `baseSeq+1` 开始（只补未落盘尾巴）。
- 不重复：回放起点永远在落盘点之后；`since` 与 `baseSeq` 之间的消息由 `entries?since=` 用真实 entry id 渲染。

### 13.5 孤儿接管（S3）

- `POST /api/session/open` 命中「同一会话被别的引擎占着」时，`pool.adoptable()` 四条全中才接管：
  1. 占着同一会话（`sessionFile` 或 attach 占位 `claim`，口径同 `sessionOwner`）；
  2. 不是本客户端自己的引擎；
  3. **没有任何 SSE 连接**（有活跃标签 → 仍 409，I1 不放宽）；
  4. 静默 ≥ `PI_SHELL_ADOPT_GRACE_MS`（默认 30000）；`stopping` 也排除。
- 动作（`pool.adopt()`）：**先 `release` 本 clientId 的旧引擎，再 `own()`**——`own()` 同键会静默覆盖记录，不先释放会漏掉旧 pi 子进程与 MCP shim（F25）。
- 响应带 `adopted:true` + `bridge_state`，前端据此自动 `connect()`，回放与实时帧都落在正确引擎上。
- 代价：孤儿流式引擎计入 `MAX_ENGINES`（默认 4），4 条孤儿 → 新列 503（不新增「静默 kill 用户回合」的路径）。

### 13.6 前端「真相」（S4，`web/src/column.js`）

- `lastSeq` 游标：重连带 `?since=`；接管 / 换引擎后清空（两条引擎的 seq 空间不同）。
- `resume.truncated` → 明确提示「部分输出未能补齐」，并在回合结束强制一次权威重载。
- 有回放窗口也重载：`agent_settled` 后把回放合成的 live 节点换成正式 entries（顺带修正 fork 锚点）。
- **`agent_settled` 一律走 `authoritativeReload()`**（不再只在「回放 / `truncated`」时）：直播态的思考块是展开的、且顺序以帧到达为准，只有落盘 entries 才是权威顺序（`thinking` → `text`）；重画后思考折叠成 `<details data-collapse="thinking" open=false>`、正文在其下方。在途重载中再来一次 → `reloadPending` 保留并在结束后补一次。
- 代价：每轮多一次 `POST /api/session/open`（走桥的 `session_open_reused` 复用路径：同会话文件直接复用引擎，不换会话、不重启引擎），换一次条目读取。
- 断线重连从「1/2/4s ×3 次弃疗」改为**每 15s 一直重试**；`visibilitychange` 回可见且 SSE 非 OPEN → 立刻重试一次（手机锁屏 / suspend）。
- 发送前 `ensureSessionIdentity()`：`attached` 且桥侧会话 ≠ 本列会话 → 先 `openSession` 再允许发送（防 prompt 进空会话）；**身份未知也先尝试恢复一次，仍未知则拦发（§13.7）**。
- 文案改真话：关列「关闭不会中止，会继续在后台运行」；切会话「这一轮未落盘的部分不会保留」。

### 13.7 重连恢复

**事故**（2026-11-14）：离开电脑 → 引擎被 60s 空闲回收 → 页面自动重连 → 桥新建空引擎 + 空会话（cwd 回到 `INITIAL_CWD`），页面仍显示旧历史 → 看似连续、实际 AI 失忆，模型退回默认。根因三条：① 桥没记住「这个 client 上次开的是哪个会话文件」，重建用 `INITIAL_CWD` 且不 `switch_session`；② 断线重试是「无限静默重试」，错误状态不可见；③ `ensureSessionIdentity()` 在引擎 `sessionId` 未知时直接放行，prompt 落进空会话。

**桥侧记忆**（`bridge/src/index.mjs`，`lastSessionByClient`）：

- 语义：`clientId → { path, cwd, model, thinkingLevel, at }`。**只存元数据，不读会话正文**（N-07）。
- 与**引擎生命周期解耦**：`release` / `idle-sweep` 都**不清**（清掉等于把用户的会话绑定在一条随时会被回收的 pi 进程上）；只在「显式进入无会话文件状态」时清（`new_session` / 切工作区 / 切目录且无会话文件），日志 `session_memory_cleared`。
- 边界：上限 `SESSION_MEMORY_MAX = 64`，超出按 `at` 淘汰最旧；**同一 `clientId`** 才命中（标签页身份自愈会换 clientId → 靠前端兜底）。

**持久化元数据文件**（`bridge/src/session-memory.mjs`，`d44079e`）：记忆落盘到 `<agentDir>/pi-shell-last-sessions.json`（`PI_SHELL_LAST_SESSIONS_FILE` 可覆盖；覆盖 `PI_SHELL_SESSIONS_DIR` 时落在其同级），与 `sessions-origins.json`（§4）并列——**桥自己维护的元数据文件，不写 pi 的会话文件**。结构 `{ version:1, updatedAt, sessions: { <clientId>: { path, cwd, model, thinkingLevel, at } } }`，只存元数据（不读会话正文，N-07）。写入口径与 `OriginStore` 一致：临时文件 + rename（**原子写**）、**200ms 防抖**合并写（attach / 每轮状态变化都会刷新，不能每条都落盘）、进程退出同步兜底一次；启动 `loadSync()` 一次，文件不存在 / 读失败 / 格式错 → 空表 + `warn session_memory_load_failed`（不影响启动，坏记录逐条跳过）。**桥重启后第一次认领也命中记忆**：`claimEngine` 拿到引导引擎时先查记忆，命中即记 `session_memory_hit{via:"bootstrap-adopt"}` 并 `scheduleEngineRestore()`（同一个 `clientId` 才能接回）。恢复失败且 `code=NOT_FOUND`（文件已删/被移）→ 广播 `session_attach_failed` + 日志 `engine_restore_failed`，并**移除该条**（`session_memory_cleared{reason:"session-file-missing"}`）——避免下次重连反复撞同一失败。

**恢复时序**（`claimEngine` 新建引擎时）：查记忆 → 用**原会话的 cwd** 起引擎（`restoreCwdFor()`：优先记忆里的 cwd，缺失时读会话 header；不是目录 → 回退 `INITIAL_CWD`）→ `scheduleEngineRestore()`（`setImmediate`，不阻塞认领响应）→ 等 `idle`/`failed`（≤45s）→ `switch_session` → `get_state` 校验 `sessionFile` 与记忆一致（不一致 → `RESTORE_MISMATCH`）→ `applySessionCwd(readSessionCwd(...))` 回写 cwd 真相 → `restoreModelAndThinking()`（`set_model` / `set_thinking_level`；失败只 `warn engine_restore_model_failed` / `engine_restore_thinking_failed`，**不回退会话**）→ 广播 `session_attached{restored:true}` + 日志 `engine_restored`（`client / engine / sessionFile / cwd / sessionId / ms`）。

**失败不静默**：广播 `session_attach_failed{code}` + 日志 `engine_restore_failed`。`NOT_FOUND`（文件已删/被移）、`RESTORE_MISMATCH`、`CONFLICT`（cwd 不存在）等；除 `PI_NOT_READY` 外，记忆跟随引擎真实身份（避免后续重连反复撞同一个失败）。与用户显式 `session/open` **共用 `engine.extra.attachToken`**：恢复完成前用户自己打开了别的会话 → 本次恢复作废、不广播噪音。

**前端兜底**（`web/src/column.js`）：

- 新连接一律把 `bridgeSessionId` 置 `null`（缓存里的是**上一个引擎**的身份，拿它判 = 事故复现），以本次连接现发的 `bridge_state` 快照为准；1.5s 无快照 → 按「身份不可信」兜底试一次。
- `maybeAutoRestore()` 命中即 `openSession({path, cwd})` 重新接管；`starting` / `not_started` / `streaming` 不抢；`restoreTriedFor` 闩锁保证**同一次连接只自动接管一次**，用户点「重试」重置。
- 成功：`session_attached` 回执 → 列头持久「已恢复上次会话」+ `applyWanted()` 把模型/思考跟回；失败：notice + 断线提示条，可点重试。
- `ensureSessionIdentity()`：身份未知且有会话路径 → 先 `restoreSession("identity")` 一次；仍未知 → **拦发**并提示「未能确认当前会话」，输入框内容保留。

**与 S1 pin / S3 adopt 的分工**（三种现场，按顺序判）：

1. 引擎还在（`pool.find(clientId)` 命中；pin 中的流式引擎也算）→ 直接复用，**不需要恢复**。
2. 引擎已被 `sweep` 回收 → 按 `lastSessionByClient` **恢复**（本节）。
3. 会话被**别的引擎**占着、无 SSE 且静默 ≥30s → 走 **S3 adopt**（先 `release` 再 `own()`，§13.5），不是恢复。

**已知边界**：同一 `clientId` 才命中（标签页身份自愈会换 clientId）；第一条消息落盘前没有会话文件，无法恢复（H-5）。

### 13.8 接管初始 entries 走桥直读（v1.2.0）

**问题**：接管原本需要一次 `get_entries` 全量 RPC——它的响应是「一行装下全部 entries」，受 JSONL 单行上限约束。会话一大（长历史 + 图片 base64）就超限被整行丢弃 → 桥等 30s 判 `TIMEOUT` → 「列表里能看见、点进去接不上」；而「只读浏览」因为本来就直读文件，始终能看——这就是「内容能看、接管失败」的根因。

**口径**：

| 路径 | 内容来源 |
|---|---|
| `open`（view + 后台接管） | `get_state` 只供状态；entries / leafId 直读会话文件 |
| 孤儿接管（adopt） | 直读会话文件（与只读浏览同一解析器 `readSessionEntries`） |
| 复用路径（已附着同一文件，S4 权威重载也走它） | 直读会话文件 |
| 重连恢复（`restoreEngineSession`） | leafId 直读会话文件 |
| 引擎重启（`handleEngineRestart`） | leafId 直读会话文件 |
| `?since=` 增量 / 重放 / 回合结束权威重载 | 仍用 `get_entries`（增量小，不装全会话） |

**失败不判死**：直读取不到 leafId 时只记 `warn attach_leafid_read_failed` 并回 `leafId:null`——接管本身已成功（`get_state` 已换会话），不因一条 leafId 回退到 30s 全量 RPC。日志带 `entriesVia:"file"` 便于确认走的哪条路。

### 13.9 限制（照实写）

- **桥进程重启仍会丢回合**：优雅退出会 `releaseAll` 全部引擎（SIGKILL 时 pi 子进程可能变孤儿，老问题）。当前版本只解决「标签页关闭 / 断线 / 切走」。
- 后台回合若恰好卡在扩展权限确认：无 SSE 10s 后自动 `cancelled:true`（`EXT_CANCEL_AFTER_MS`，未改）。
- 回放补的是「未落盘的尾巴」；超过缓冲上限的极长输出只能看到 `truncated` 提示 + 已落盘部分。
- 接管需要静默 ≥30s：关掉后**约 30 秒内**回来会仍拿 409（活跃标签的 409 语义不放宽）。
- `adoptable` 不判断「旧页面是不是真的死了」：旧页 30s 后网络抖动回来会拿到 409（保持只读）。

---

## 14. 相关文档

| 想了解 | 看哪里 |
|---|---|
| 契约 / 端点 / 错误码（单一事实来源） | `docs/03-design.md`（§5 端点表；版本号落后于代码时以代码为准） |
| 怎么用（面向用户） | `docs/USER-GUIDE.md` |
| 每个版本你感受到的变化 | `docs/WHATS-NEW.md` |
| 运行 / 排障 / 发布 / 回滚 | `docs/RUNBOOK.md` |
| 视觉与组件规范 | `docs/DESIGN-SYSTEM.md`、`docs/design/LAYOUT.md`、`docs/design/TREE-DISPLAY.md` |
| 变更明细 | `CHANGELOG.md`、`RELEASE-NOTES.md` |
| 验收 | `cd bridge && npm test`（单测，纯夹具）；端到端套件与证据脚本为开发期工具，不随公仓发布 |

