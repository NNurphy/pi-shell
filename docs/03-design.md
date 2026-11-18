# 03 · 开发文档（技术设计）

版本 **v1.0.0** ｜ 依赖：pi 1.5.0 / Node 24 / Windows 11

---

## 1. 已实测的硬事实（决定多处设计，附证据位置）

| # | 事实 | 证据 |
|---|---|---|
| H-1 | **pi 对会话文件不加锁** | `dist/core/session-manager.js` 全文无 lock 调用（`proper-lockfile` 仅用于 settings/auth） |
| H-2 | 会话写入 = **append**；首次落盘时一次性写入内存中的全部条目 | `_persist()`：首写用 `openSync(sessionFile,"wx")` + 逐条 `writeFileSync`，之后 `appendFileSync` |
| H-3 | **整文件重写只有 3 处**：①打开"存在但解析为空"的显式路径会话 ②`migrateToCurrentVersion` ③`createBranchedSession`（写**新**文件） | `_rewriteFile()` 调用点 `:679`、`:724`、`:1295` |
| H-4 | compaction 通过 **append 摘要条目** 实现（`appendCompaction` + `firstKeptEntryId`）；`branch()`/`resetLeaf()` **只改内存 leafId**，后续仍为 append | `:892`、`:1173`、`:1184` |
| H-5 | **新会话不落盘**：只有出现 user/assistant 消息后才创建文件 | `_persist()` 注释与 `_hasConversation()` |
| H-6 | **消息对象无 `id`**；`id` 在**条目**层级（`{type,id,parentId,timestamp,message}`）。`get_entries` 支持 `since` 游标 | 实读 jsonl；`rpc-commands.md` §get_entries |
| H-7 | 会话 header 无 `name`；本机会话条目类型仅 `session`/`model_change`/`thinking_level_change`/`message`/`context_edit` → **title 只能取自首条用户消息** | 实读多份真实会话 |
| H-8 | RPC **拒绝 `@file`** | `docs/rpc.md:20` |
| H-9 | RPC 无 `set_cwd`；`new_session` 不接受 cwd；`switch_session` 用会话自身 cwd（cwd 不存在会抛错，可被扩展取消） | `rpc-commands.md`、`agent-session-runtime.js` |
| H-10 | **Windows 下 `spawn("pi")` = ENOENT；`spawn("pi.cmd")` = EINVAL**（绝对路径同样 EINVAL）；首选 `spawn(process.execPath, [<cli.js>, …])` 直连（子进程即 pi），`cmd.exe /d /s /c` 仅作退路 | 本机 Node 24 实测 |
| H-11 | 会话目录由 `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` / `sessionDir` 决定 | `docs/sessions.md:58` |
| H-12 | `get_session_stats` 的 tokens/cost **包含工具用量与压缩摘要** | `rpc-commands.md` §get_session_stats |
| H-13 | 经 `cmd.exe` 包装时，`kill(子进程)` **不会终止 pi**（孙进程存活）；`taskkill /PID <pid> /T /F` 可回收整棵树 | 本机实测（3 组对照） |
| H-15 | **Windows 上 `process.stderr` 指向管道时写入是同步的**：管道被接走但读取端不消费时，累计约 64–80KB 日志后 `write()` 阻塞事件循环 → 桥假死（health 超时、CPU 空闲、进程存活）。复现：`stdio:["ignore","pipe","pipe"]` 不消费 + 27 次 3KB 路径请求 | 本机实测（2026-11-06，`stderr.readableLength=16608B`） |
| H-14 | `cmd /s /c` 下给可执行文件加单层引号会被拒绝（`'"C:\…\pi.cmd"' is not recognized`，status=1）；直连 node+CLI 无此问题 | 本机实测 |
| H-16 | **pi 1.5.0 没有「按 server 选择性加载」的开关**：`docs/cli.md` 只有 `--no-mcp`（全禁），`docs/mcp.md` 的 server 名单只来自 `<agentDir>/mcp.json`（全局）与 `<cwd>/.pi/mcp.json`（项目，需信任）；`docs/environment-variables.md` 全文**无** `PI_MCP_CONFIG`，`dist/cli/args.js` **无** `--mcp-config`。唯一可控的是 `<agentDir>` 本身：`PI_CODING_AGENT_DIR` 可重定向（`getMcpConfig` 读 `join(agentDir,"mcp.json")`） | `docs/mcp.md` §Configure servers、`docs/environment-variables.md` §Pi Process Configuration、`dist/extensions/mcp/config.js:loadMcpConfig`、`dist/cli/args.js:163` |
| H-17 | **MCP 的内存代价在子进程树上，不在 pi 本体**：`--no-mcp` 引擎（pi 自身）RSS 82MB / 整棵树 90MB；开 codegraph + mcp-obsidian 后 pi 本体仅 94MB，但整棵树 **544MB**（codegraph + npx + uvx + python）。「≈500MB/引擎」指的是整棵树 | 本机实测 2026-11-09（`scripts/evidence/mcp-toggle-ui.mjs` M5） |

---

## 2. 架构

```
┌────────────────────────── 浏览器（127.0.0.1:7788）──────────────────────────┐
│ 原生 ESM：会话树 / 对话流 / Composer / 命令面板 / 模态框                    │
└──────────────▲─────────────────────────────────┬───────────────────────────┘
               │ SSE(GET /api/events)            │ HTTP /api/*
┌──────────────┴─────────────────────────────────▼───────────────────────────┐
│ bridge（Node ESM，零第三方依赖）                                            │
│  index.mjs 路由/静态/SSE/工作区重启编排                                     │
│  rpc.mjs   spawn（直连 node+CLI；cmd.exe 仅退路）、JSONL 分帧、id 配对、重启   │
│  sessions.mjs 扫描/摘要（只读）   files.mjs 工作区文件（只读）              │
│  git.mjs 只读 diff               log.mjs 脱敏日志                            │
└──────────────┬─────────────────────────────────▲───────────────────────────┘
               │ stdin（命令 JSONL）             │ stdout（事件/响应 JSONL）
┌──────────────▼─────────────────────────────────┴───────────────────────────┐
│ pi 1.5.0 --mode rpc [--session-dir …]  ← 使用 ~/.pi/agent                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 进程、工作区与环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `PI_SHELL_PORT` | `7788` | 仅绑 `127.0.0.1` |
| `PI_SHELL_LOG_FILE` | `<project>/logs/bridge.log` | 日志文件路径（H-15：非 TTY 只写文件，不写 stderr） |
| `PI_SHELL_LOG_DIR` | `<project>/logs` | 日志目录（N2：启动时整理 launcher/notify/mcp 也看这里） |
| `PI_SHELL_LOG_MAX_MB` | `5` | N2：单文件轮转上限（MB）；文件大于上限才轮转，非法值回落 5 |
| `PI_SHELL_LOG_KEEP` | `5` | N2：轮转历史保留份数（`.1`…`.N`，最旧删除），非法值回落 5 |
| `PI_SHELL_CWD` | `~`（用户主目录） | 子进程工作目录 → 决定**新会话**落哪个分组 |
| `PI_SHELL_SESSIONS_DIR` | 空（不传） | 非空时**同时**作为 `--session-dir` 传给子进程、并作为扫描根（保证读写同一目录，见 H-11） |
| `PI_SHELL_PI_BIN` | 空（自动解析） | 为空时：读 `install/current-version` → `releases/<v>/node_modules/@earendil-works/pi-coding-agent/package.json` → 取 **`bin.pi`**（1.5.0 实为 `dist/bundle/cli.js`，不要硬编码此路径）→ 解析为绝对路径；非空时视为 **`cli.js` 的绝对路径**（覆盖自动解析；不经 shell、不接受 `.cmd`） |
| `PI_SHELL_AGENT_DIR` | `~/.pi/agent` | 仅测试用：隔离 agent 目录；桥把它同时作为子进程的 `PI_CODING_AGENT_DIR` 传入 |
| `PI_SHELL_MCP_CONFIG` | `<agentDir>/pi-shell-mcp.json` | MCP 按需配置（`{default:[], rules:[{cwd,servers}]}`）。文件不存在 = 全默认空（引擎带 `--no-mcp`）；test-gate 注入空配置保证 E2E 不读真实配置 |
| `PI_SHELL_EXTRA_ARGS` | 空 | 追加给子进程的参数，**按 JSON 字符串数组解析**（首选，支持含空格路径，如 `["-e","~/pi-shell/my ext/a.ts"]`）；非 JSON 时退化为按空白切分（不支持含空格路径） |

**启动方式（Windows，按 H-10/H-14）**：
- **默认（直连）**：`spawn(process.execPath, [<cli.js>, "--mode","rpc"], { cwd: PI_SHELL_CWD, env: { …process.env, PI_MANAGED_INSTALL_ROOT: <install>, PI_CODING_AGENT_DIR: <agentDir> }, stdio: ["pipe","pipe","pipe"] })`。子进程即 pi，无包装层，`kill` 即终止（本机实测：`--version` 正常，SIGTERM 后无残留）。stderr 只转发到日志（脱敏），不参与协议解析。
- **`.cmd` 退路：不实现**（H-13/H-14：包装层会导致孙进程残留、引号形式脆弱，且与"单一 pi 子进程"前提冲突）。若将来确需，须单独立项并连带改造终止逻辑（`taskkill /T /F`）。
- POSIX：`spawn(piBin, args)`。

**工作区切换**（F-09）：`POST /api/workspace {cwd}` → 校验目录 → `abort` → 关子进程 → 以新 cwd 重启 → `get_state`。
**切换后的会话语义（明确定义）**：重启后 pi 处于**全新空会话**（H-5：无消息则不落盘），页面**清空对话区**并提示"已切到 <cwd>；旧会话仍在列表中，可点开"；原会话不丢失、不迁移。
`streaming` / `restarting` 时拒绝切换（`PI_NOT_READY`）。

**生命周期**：启动 → 握手；子进程崩溃退避重启 1s/2s/4s（5 分钟 ≤3 次）；桥崩溃不自动拉起（N-09）；退出先发 `abort`（等 response）→ 直连模式 `SIGTERM`，2s 后 `SIGKILL`；端口占用直接报错不换端口。每次重启/切换工作区后校验无残留 pi 进程（04 §3 G0-7）。

---

## 4. 数据流

**① 发消息**：`POST /api/prompt` → `prompt` 命令 → `{"type":"response","data":{"disposition"}}`
- `started` → 进 `streaming`
- `queued` → 保持 `streaming`（不新增气泡）
- `handled` → **立即回 `idle`**（扩展命令已消费，不会再有 `agent_settled`）

**② 收事件**：stdout 逐行 JSON → 解析失败记日志跳过 → 加 `seq` → SSE → 状态归并 → 增量渲染。

**③ 扩展弹窗**：`extension_ui_request` → SSE → 模态 → `POST /api/ext-ui-response` → 回写 stdin。
`timeout` 由 pi 侧自动 resolve；前端只做展示。**页面关闭时未回执的对话框无解**（见 §16）。

**④ 文件引用（`@file` 被拒，H-8）**：前端读取 ≤200KB 文本 → 以
```
[File: <相对路径>]
<内容>
```
拼入 `message`；二进制或超限直接拒绝并提示。

---

## 5. HTTP 接口契约（共 23 个：M0 4 / M1 12 / M2 7）

| 阶段 | 方法 | 路径 | 入参 | 出参 | 映射/说明 |
|---|---|---|---|---|---|
| M0 | GET | `/api/health` | — | `{ok,pi:{version,pid,state,cwd}}` | — |
| M0 | GET | `/api/events` | — | `text/event-stream` | 事件流（带 `seq`） |
| M0 | POST | `/api/prompt` | `{message,images?,streamingBehavior?}` | `{disposition}` | `prompt` |
| M0 | POST | `/api/abort` | — | `{ok}` | `abort` |
| M1 | POST | `/api/clear-queue` | — | `{steering,followUp}` | `clear_queue` |
| M1 | GET | `/api/sessions` | `?q=` | `{groups:[{cwd,dir,flat?,sessions:[SessionSummary]}],warnings:[{path,reason}]}` | 本地扫描（`?q=` 过滤 title/lastSnippet；`warnings` 非致命，如无 header、读失败） |
| M1 | POST | `/api/session/open` | `{path}` | `{mode:"live"\|"view", sessionId, state, entries, attach:"attached"\|"pending"}` | **先读文件返回内容（目标 ≤2s），再后台 `switch_session` 接管**；同一文件已附着时直接 `get_entries`；接管失败（cancelled/CONFLICT）经 SSE `session_attach_failed` 通知，页面保持只读 |
| M1 | POST | `/api/session/new` | — | `{sessionId,state}` | `new_session` → `get_state` → `noteGetState`；**此时不落盘**（H-5）；streaming 中 409 `CONFLICT`「正在运行中：请先中止再新建会话」，未就绪 503 `PI_NOT_READY`，扩展取消 409；日志 `session_created` |
| M1 | GET | `/api/session/entries` | `?since=<entryId>` | `{entries,leafId}` | `get_entries`（断线补齐的游标） |
| M1 | GET | `/api/models` | — | `{models}` | `get_available_models` |
| M1 | POST | `/api/model` | `{provider,modelId}` | `{ok}` | `set_model` |
| M1 | GET | `/api/thinking-levels` | — | `{levels}` | `get_available_thinking_levels` |
| M1 | POST | `/api/thinking` | `{level}` | `{ok}` | `set_thinking_level`；**桥侧先按 `get_available_thinking_levels` 校验，非法值 400**（pi 对未知 level 会静默归一为 `off`，实测） |
| M1 | GET | `/api/commands` | — | `{commands}` | `get_commands` |
| M1 | POST | `/api/workspace` | `{cwd}` | `{cwd,sessionId}` | 重启子进程（§3） |
| M1 | POST | `/api/ext-ui-response` | `{id,value?,confirmed?,cancelled?}` | `{ok}` | `extension_ui_response`；**只接受当前 pending 集合内的 id，其余 409 `CONFLICT`** |
| M2 | POST | `/api/session/fork` | `{entryId}`（**必填**） | `{text,cancelled,sessionId,sessionFile}` | `fork` → 成功后 `get_state` 取 `sessionFile` |
| M2 | POST | `/api/session/clone` | — | `{cancelled,sessionId,sessionFile}` | `clone` → `get_state` |
| M2 | GET | `/api/session/tree` | — | `{tree}` | `get_tree` |
| M2 | GET | `/api/stats` | — | `{tokens,cost,contextUsage}` | `get_session_stats` **原样透传**（不改字段名、不做二次计算） |
| M2 | GET | `/api/files` | `?path=` | `{entries}` | 本地（限工作区）；越界/符号链接 403 |
| M2 | GET | `/api/file` | `?path=` | `{content,mime,size,truncated?}` | 本地（限工作区）；**文本 ≤1 MiB、二进制 ≤8 MiB，超限 400 `BAD_REQUEST`**；越界/符号链接 403 |
| M2 | GET | `/api/git/diff` | — | `{available,stat,patch,truncated?}` | 本地只读（`git -C <workspaceCwd> status --porcelain` + `diff --stat` + `diff`）；**非 git 仓库返回 `available:false` 而非报错**；patch 上限 **2 MiB**（超出截断并 `truncated:true`）；命令超时 5s |

**追加（MCP 按需，本表未重排编号）**：

| 方法 | 路径 | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| GET | `/api/mcp/state` | —（可带 `X-Pi-Shell-Client`） | `{available:[{name,description,enabledByDefault,transport}], default, rules, current, configPath, configExists, error}` | UI 勾选面板的数据源；`current` 是该列引擎实际启用的名单 |
| POST | `/api/mcp/config` | `{default?, rules?}`（部分更新） | 同 `/api/mcp/state` | schema 校验 → 原子写（tmp + rename）→ 立刻重载；非法 400 |
| POST | `/api/engine/restart` | `{client?, mcp:[name…]}`（旧脚本可传 `boolean`） | `{mcp, engine, engines, restarted, sessionKept, oldPid, pid, ms}` | 换子进程应用 MCP 名单 → `switch_session` 回原 `sessionFile`；名单不变时幂等（`restarted:false`）；streaming 中 409 |

**引擎的 MCP 名单怎么落地（H-16 的绕法）**：名单为空 → 子进程带 `--no-mcp`；名单非空 → 桥为这条引擎生成**临时 agentDir（shim）**（`%TEMP%/pi-shell-mcp/<client>-XXXX`：真实 agentDir 的目录 `junction`、文件拷贝，只把 `mcp.json` 换成「只含选中 server」的生成文件），子进程以 `PI_CODING_AGENT_DIR=<shim>` 启动。settings / auth / skills / extensions 全部照旧；引擎回收时删 shim（`rmSync` 对 junction 只删链接）。选中集与 `mcp.json` 的对账在 `bridge/src/mcp-config.mjs`（未知名字丢 warn，不报错）。

`SessionSummary`：`{id,path,title,updatedAt,cwd,lastSnippet,status:"attached"|"unknown"}`
**请求体上限 8 MiB**（`MAX_BODY_BYTES`，images 的 base64 计入）；超限 400 `BAD_REQUEST`，不读剩余流。
**错误**：`{error:{code,message}}`，不透出堆栈。code 与 HTTP 状态一一对应：

| code | HTTP | 典型场景 |
|---|---|---|
| `BAD_REQUEST` | 400 | 入参不合法 |
| `FORBIDDEN` | 403 | 路径越界（静态/文件预览） |
| `NOT_FOUND` | 404 | 未知端点 / 不存在的会话或文件 |
| `CONFLICT` | 409 | `switch_session` 目标 cwd 已不存在等状态冲突 |
| `PI_ERROR` | 502 | pi 返回 `success:false` 或协议内其它失败 |
| `PI_NOT_READY` | 503 | 子进程未就绪 / 重启中 / `failed` |
| `TIMEOUT` | 504 | 请求 30s 无响应（不重发）；**扩展命令在 handler 内等对话框时，prompt 回执必然 504，属预期** |

---

## 6. 模块职责

| 文件 | 职责 | 不做 |
|---|---|---|
| `index.mjs` | 路由、静态、SSE 广播、工作区重启 | 业务解析 |
| `rpc.mjs` | spawn（默认直连 node+CLI；`cmd.exe` 仅退路）、分帧、`id` 配对、30s 超时、崩溃重启 | UI 决策 |
| `sessions.mjs` | 扫描、header/首条 user/末条 message、缓存 | 写文件 |
| `files.mjs` | 工作区内路径解析、越界 403、只读读取 | 写文件 |
| `git.mjs` | `git status/diff` 只读 | 写操作 |
| `log.mjs` | 结构化、脱敏 | 写 stdout |
| `web/src/stream.js` | 事件→状态；`disposition` 三态；entry id 游标 | 碰 DOM |
| `web/src/render.js` | 状态→DOM；14.1 渲染清单 | 发请求 |

**JSONL 分帧**：`TextDecoder` + 手动按 `\n` 切分；禁 `readline`（U+2028/U+2029 误判）、去尾部 `
`。
**单行上限 8 MiB**（`DEFAULT_MAX_LINE_BYTES`）：超限丢弃该行并记 `onSkip{reason:"overlong"}`，**不中断流**；未完成的半行同样受此上限约束（超限进入丢弃态直到下一个换行），子进程重启时 `reset()` 清空缓冲。

---

## 7. 会话发现（对齐 H-5/H-7）

1. **扫描根**：`PI_SHELL_SESSIONS_DIR`；为空时取 `<agentDir>/sessions`（默认布局）。目录不存在 → 空列表 + 提示，不报错
2. **两种布局都要兼容**（T-06 实测）：
   - **默认布局**：`<root>/<编码 cwd>/*.jsonl` —— 分组键 = 子目录名（以 header `cwd` 校正）
   - **`--session-dir` 布局**：`*.jsonl` 直接落在 root 根下（pi 不为 cwd 建子目录）—— **按 header `cwd` 分组**，组上带 `flat: true`
3. 每个 `*.jsonl`：
   - 读首行 → `{id,timestamp,cwd}`
   - **向前扫描至多 64 条 / 64KB**，取**第一条 `message.role==="user"`** 的文本前 30 字作为 `title`
   - **从文件末尾向前**取**最后一条 `message` 条目**（跳过 `model_change`/`thinking_level_change`/`context_edit`），生成 `lastSnippet`（≤120 字符）
4. `title` 回退：64 条内没有 user 消息 → **`sessionId` 前 8 位**；header 缺失 → `cwd` 退化为所在目录名原文，并追加一条 `warnings`
5. 排序 `updatedAt` 倒序；缓存键 `{path,mtime,size}`
6. **空会话不落盘 → 不出现在列表中**（正常行为，页面在新建会话后显示"尚未产生消息"占位）
7. `status`：只有桥当前打开的会话为 `attached`，其余一律 `unknown`（无锁事实，见 D-08）

---

## 8. 状态机

```
starting → idle ─prompt(started/queued)→ streaming ─agent_settled→ idle
             ▲                              │
             │                              ├─ disposition="handled" → idle（立即）
             │                              ├─ extension_ui_request → awaiting_input
             │                              │      └─ response/timeout → streaming
             │                              └─ pi exit → crashed → 重启成功 → idle
             └── workspace restarting（清空对话区，新空会话）
             └── bridge 崩溃 → disconnected（横幅 + 手动重试）
```

- `session/open` 分两步：内容先到（`mode:"view"`，Composer 禁用并显示"接管中…"）→ 后台 `switch_session` 成功发 `session_attached`（Composer 启用）；失败发 `session_attach_failed`（横幅 + 重试，仍可只读浏览）
- `restarting` 期间禁止发送；结束后对话区为空、左侧列表不变

---

## 9. 双端同开的风险与兜底（按 H-1~H-4 修正）

**为什么无法检测**：无锁、打开后不重读盘、不比对 mtime。

**实际风险形态**（按可能性排序）：

| # | 形态 | 触发 | 后果 |
|---|---|---|---|
| 1 | **追加交错 / 半行** | 两端同时写大条目（工具结果可达数十 KB） | 出现半行；扫描时**静默跳过**该行 → 页面少一条且无提示 |
| 2 | **分支分裂** | TUI 侧 `/tree` 回退或切分支后继续写 | 两端口径不一致；重开时只加载当前 leaf 分支，另一支成"孤儿" |
| 3 | **双份压缩摘要** | 两端各自触发 compaction | 上下文重复摘要，token 膨胀 |
| 4 | 整文件重写 | 仅：打开"存在但解析为空"的显式路径会话 / 版本迁移 | 极端情况丢内容（本机会话均为 v3，迁移不触发） |

**兜底（三层，不承诺技术阻止）**
1. 打开会话/新建会话前展示横幅："不要同时在终端打开同一会话"（首次勾选，本会话内不再重复）
2. 桥不自行改会话文件（只发 `prompt`）
3. M0 前备份 `sessions\` → **`~/pi-shell-backup/sessions-backup-<YYYY-MM-DD>/`**（项目目录之外，卸载不删；不在 `~/.pi/agent` 内，符合 C-02）；README 给恢复步骤

其他并发：同页切换串行化；两标签以最后一次 `switch_session` 为准并提示；`switch_session` 目标 cwd 不存在 → `CONFLICT`；扩展取消 → `cancelled:true`。

---

## 10. 错误处理与重连

| 场景 | 行为 |
|---|---|
| JSONL 行解析失败 | 记日志（无内容）跳过 |
| 请求 30s 无响应 | 504 `TIMEOUT`，不自动重试 |
| 子进程崩溃 | 退避重启；期间 `PI_NOT_READY` |
| `switch_session` 返回 `cancelled:true` | 保持原会话，返回 `{cancelled:true}`，不调用 `get_state`/`get_entries` |
| `switch_session` 目标 cwd 不存在 | `CONFLICT` + "项目目录已移动或删除" |
| `new_session` 后未发消息 | 页面显示空会话占位；不产生文件（H-5），不报错 |
| `get_entries` 的 `since` 失效（返回 `success:false`） | 按“全量重载”处理：重新 `session/open`，SSE 下发 `resync`，前端重建列表；不报错、不重复插入 |
| SSE 断开 | 立即重连 ×3（1s/2s/4s）；失败 → `disconnected` + 手动重试；恢复后调用 `GET /api/session/entries?since=<最后一条 entryId>` **按游标补齐**（H-6），按 `entry.id` 去重 |
| 页面关闭时未回执弹窗 | 无解；pi 侧 timeout 或一直等（§16） |
| 页面刷新 / 重开标签 | 桥不缓存历史、**pi 侧队列不清空**：上一轮 `queued` 消息可能在刷新后继续产生事件，页面会出现「旧内容续播」。属预期（历史对齐在 M1 的 `session/open`） |

---

## 11. 安全

1. 仅绑 `127.0.0.1`，无"允许远程"开关
2. 无认证（D-04），与 TUI 同信任级
3. CSP 经**响应头**：`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`
4. 不读 `credentials.env` / `auth.json`；模型请求由 pi 发出
5. 日志脱敏（正文不入；`sk-`/`tvly-` 兜底）
6. 渲染一律 `textContent`，不用 `innerHTML` 拼消息
7. `files.mjs`：`path.resolve` 后必须落在工作区根内，否则 403（含符号链接逃逸）
8. 零第三方依赖；若走 `cmd.exe` 退路，不拼接未转义参数（`PI_SHELL_EXTRA_ARGS` 逐项加引号）

---

## 12. 性能

| 项 | 目标 | 手段 | 任务 |
|---|---|---|---|
| 首屏（1000 会话） | < 3s | header + 前 64 条 + 末条 message；mtime 缓存；>200 项虚拟化 | T-06/T-07 |
| 流式 | 单 delta < 50ms | 同帧合并 | T-05 |
| 长会话（>500 消息） | **内容可见 < 2s** | 读文件 + 末 100 条 + 懒加载（`switch_session` 不阻塞渲染） | T-17 |
| 接管（可发送） | ≈3s，**只记录不设硬门槛** | 由 pi 每次 `switch_session` 重启 MCP 决定（本机 3 个 MCP 实测 2.6–2.9s；`--no-mcp` 后 0.13–0.15s） | T-17 |
| bridge 内存 | < 250MB | 不缓存完整消息体 | T-14 |
| 单引擎内存（默认） | **≈90MB**（整棵树） | 默认不带 MCP（`--no-mcp`）；按列勾选才起 server | MCP 按需 |
| 单引擎内存（codegraph + obsidian） | ≈544MB（整棵树） | 只在该列勾选时付费；关掉即回落（实测差 453.7MB） | MCP 按需 |

---

## 13. 目录与依赖

```
~/pi-shell\
├─ README.md
├─ docs\ 00–11
├─ bridge\ package.json, src\{index,rpc,sessions,files,git,log}.mjs, test\*.test.mjs（node --test，零依赖）
├─ web\ index.html, src\{main,stream,render}.js
├─ scripts\ smoke-check.mjs, evidence\{m0,m1-sessions,…}.mjs（可复现证据驱动）
├─ test-ext\ select-demo.ts      # A-06 用，经 -e 绝对路径加载
├─ logs\                          # git 忽略
└─ .gitignore
```
- `bridge/package.json`：`dependencies: {}`
- `web/`：无构建、无 npm 依赖
- 规模预期：bridge 约 400–600 行（含 files/git），web 约 600–900 行

---

## 14. 测试

### 14.1 渲染清单（F-02 唯一依据）

用**两份样本**：
- **样本 A**（工具密集）：`sessions/--<编码 cwd>--/<时间戳>_*.jsonl`（取一份工具调用密集的真实会话）
- **样本 B**（含图片）：同目录另一份 `<时间戳>_*.jsonl`（含图片消息）

逐项打勾：① 一/二级标题 ② 无序/有序列表 ③ 行内代码 ④ 代码块（语言标签） ⑤ 表格 ⑥ 链接 ⑦ 引用块 ⑧ thinking 折叠（默认收起） ⑨ 工具调用折叠（默认收起，展开见原始 JSON） ⑩ 图片渲染（**用样本 B**） ⑪ 长文本不横向溢出 ⑫ 折叠状态跨会话保持

### 14.2 其他

| 层级 | 内容 | 时机 |
|---|---|---|
| 协议单测 | 分帧（U+2028/CRLF/半行/超长行）、id 配对、超时；运行 `cd bridge && npm test`（`node --test`，零依赖） | M0 |
| 会话单测 | 目录名→cwd、header 缺失、空文件、无 user 消息时的 title 回退 | M1 |
| 文件安全单测 | `..` 越界、符号链接、>200KB | M2 |
| 端到端 | A-01~A-08 | M1 收尾 / M2 |
| 手工回归 | 06 §2（带阶段） | 每里程碑 |
| 稳定性 | bridge 2h 内存（N-03） | M1 收尾 |

---

## 15. 可观测性

`logs/bridge.log`：`时间|级别|事件|关键字段`（无正文）。页面右下"诊断"：版本/PID/SSE 状态/事件计数/最近 5 条错误。

---

## 16. 已知限制

1. **无会话锁**：无法检测双端同开；风险形态见 §9，只有提示与备份
2. **RPC 降级清单**（`rpc-extension-ui.md`）：`custom()`→`undefined`；`onTerminalInput` no-op；`setWorkingMessage`/`setWorkingVisible`/`setWorkingIndicator`/`setHiddenThinkingLabel`/`setFooter`/`setHeader`/`addAutocompleteProvider`/`setEditorComponent`/`setToolsExpanded` 均 no-op；`getEditorText()`→`""`；`getEditorComponent()`→`undefined`；`getToolsExpanded()`→`false`；`pasteToEditor()` 退化为设文本；`getAllThemes()`→`[]`；`getTheme()`→`undefined`；`setTheme()` 失败；`setWidget` 仅字符串数组（`widgetKey` / `widgetLines[]` / `widgetPlacement: aboveEditor|belowEditor`）；`setStatus` 用 `statusKey`+`statusText`；`notify` 用 `message`+`notifyType`
3. **无 `set_cwd`**：换工作区必须重启（**≈3s，含 MCP 重启**），且新会话为空会话
4. **新会话不落盘**：需先发一条消息才产生文件（H-5）
5. **`@file` 不可用**：前端读文件注入，限 200KB
6. **无认证 / 无多用户 / 无远程 / 无移动端 / 无 daemon**
7. 页面关闭时未回执的对话框：桥可在“无 SSE 客户端超过 10s”时对未回执 id 发 `{"type":"extension_ui_response","id":X,"cancelled":true}`（协议支持取消）；短暂刷新不应触发
8. **状态灯不保证出现**：依赖 `ctx.ui.theme` 的状态类扩展先取 `ctx.ui.theme.fg(...)` 再 `setStatus`；RPC 下 `getTheme()` 返回 `undefined`，扩展的 `try/catch` 会吞掉异常 → 可能整块不产出 `setStatus`（V-09 实测确认）
9. **每次 `switch_session` 会重启 MCP 服务器**：本机装有 3 个 MCP server 时实测每次切换约 **2.6–2.9s**，与会话大小无关（`--no-mcp` 后 0.13–0.15s）。因此*查看*会话改为读文件，*接管*才切换；工作区切换也含此成本
11. **stderr 管道阻塞（H-15）**：日志写 stderr 时若读取端不消费，会阻塞事件循环导致桥假死。约束：stderr 仅在 TTY 时写（否则只写文件日志），并对写失败/背压做丢弃计数；E2E 脚本必须消费或继承子进程 stdio
10. **进程树**：若走 `cmd.exe` 退路，`kill(子进程)` 不会终止 pi（H-13）；必须 `taskkill /T /F`，否则换工作区会残留 pi 进程，等同自己制造双写

11. **偏好存于 localStorage**：清站点数据即恢复默认；`localStorage` 被禁用时降级为默认值 + 一条提示（T-21）
12. **fork 需要已保存的会话**：新会话未发消息前（H-5）fork/clone 会被 pi 拒绝（"not been saved yet"），前端透传错误；属 pi 语义