# 设计 · 会话即项目（PLAN §2-2 / §2-3）

> 范围：只做设计调研，不含实现。上位事实：`docs/ARCHITECTURE.md`、`docs/PLAN.md`、`docs/03-design.md`。
> 证据口径：`file:line` 为提交时工作区（分支 `feat/session-project`，基线 `94cecca`）的真实行号；
> 命令类证据标「CMD」并附输出摘要。推断类结论标 **INFERRED**，未验证的一律不写成事实。
>
> 用户原话（PLAN §2 引用）：
> 1. 「现在的网页版新会话无法选择目录，每次打开新会话都是默认在主目录，所以我刚刚无法在网页版打开某个项目的新会话，最终又回到了终端。」
> 2. 「网页端本身没有整个工作区（项目）的概念，会话才有所属工作区（项目）的概念，所以顶部的配置，包括模型等功能，应该都是跟随会话的。」

路径前缀约定：`bridge/` `web/` 指本仓库；`pi:` 指
`~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/`。

---

## 1. 现状事实表

| # | 结论 | 证据 |
|---|---|---|
| F1 | 引擎子进程的启动目录 = `INITIAL_CWD`（`PI_SHELL_CWD` 或家目录），每列新建引擎都用它 | `bridge/src/index.mjs:80`（`const INITIAL_CWD = path.resolve(process.env.PI_SHELL_CWD \|\| os.homedir())`）、`bridge/src/index.mjs:317`（`cwd = INITIAL_CWD` 默认参数）、`bridge/src/index.mjs:1965-1986`（`claimEngine` → `createEngine(clientId, { mcp })`，不传 cwd） |
| F2 | 新建会话端点不接 cwd，也不读请求体；前端发空 body | `bridge/src/index.mjs:1826-1845`（`handleNewSession(engine, res)` 只有 `new_session` + `get_state`）；`bridge/src/index.mjs:2355-2363`（路由直接 `await handleNewSession(engine, res)`）；`web/src/column.js:1080`（`c.postJson("/api/session/new", {})`） |
| F3 | pi 的 `new_session` **不接受** cwd，用的是运行时自己的 cwd | `pi:dist/core/agent-session-runtime.js:147-152`（`async newSession(options)` → `createRuntime({ cwd: this.cwd, ... })`）；`pi:dist/modes/rpc/rpc-mode.js:334-338`（只转发 `parentSession`） |
| F4 | pi 的 `switch_session` 支持 `cwdOverride`，缺省用会话 header 的 cwd 重建运行时 | `pi:dist/core/agent-session-runtime.js:128-143`（`SessionManager.open(sessionPath, undefined, options?.cwdOverride)` → `createRuntime({ cwd: sessionManager.getCwd() })`）；`pi:dist/core/session-manager.js:1338-1358`（`cwdOverride ?? header cwd ?? process.cwd()`） |
| F5 | 打开一条旧会话后，**同一引擎里再新建会话会落在该会话的项目目录** | **INFERRED**（由 F3+F4 推）：`switchSession` → `apply()` 把运行时 cwd 换成 `sessionManager.getCwd()`（`pi:dist/core/agent-session-runtime.js:114-121`、`139-143`），`newSession` 读 `this.cwd`（`147-152`）。验收 T6 用真实会话验证 |
| F6 | pi 按 cwd 分目录存会话（`--<编码路径>--`），桥的扫描器已支持按子目录分组 | CMD `ls ~/.pi/agent/sessions` → `--C--Users-user--`、`--C--Users-user-pi-shell--` 等若干目录；`pi:dist/core/session-manager.js:291-296`（`--<cwd>--` 命名）；`bridge/src/sessions.mjs:199-240`（`<root>/<dir>/*.jsonl` 每目录一组） |
| F7 | 桥侧的 `engine.extra.cwd` **不随** `switch_session` 更新，只有 `/api/workspace` 会改它 | `bridge/src/index.mjs:1082`（唯一赋值点，在 `handleWorkspace` 内）；`bridge/src/index.mjs:1640-1670`（`attachSession` 只设 `claim`）；`grep -n "engine.extra.cwd" bridge/src/*.mjs` → `332 / 1078 / 1082 / 1257` 四处，无一处跟随会话 |
| F8 | 顶栏「工作区」文本只由 `onCwd` 更新；新建会话后不会刷新（前端读的 `state.cwd` 字段根本不存在） | `web/src/main.js:2754-2760`（`onCwd` 写 `#ws-path`）；`web/src/main.js:3049`（只有 `onCwd` 调用）；`web/src/column.js:1084`（`if (data.state?.cwd) c.cwd = data.state.cwd`）＋ `pi:dist/modes/rpc/rpc-mode.js:345-360`（`get_state` 返回 model/thinking/isStreaming/…，**无 cwd**）＝死分支 |
| F9 | 界面无任何选择/切换目录的入口；`POST /api/workspace` 端点还在，但前端零调用 | CMD `grep -rn "api/workspace" web/` → 无命中；`bridge/src/index.mjs:1053-1097`（`handleWorkspace` 完整实现：校验目录 → 停进程 → 新 cwd 重启 → 等 idle） |
| F10 | 顶部「工作区」按钮已删除，只剩只读文本 | 删除 `#switch-workspace` 与 `switchWorkspace()`（端点保留）；`web/index.html:50`（`<span id="ws-path">`） |
| F11 | 模型 / 思考级别的**写**操作已按「调用方自己的引擎」 | `bridge/src/index.mjs:2225-2231`、`2241-2247`（`needsEngine()`）；`bridge/src/index.mjs:1512-1534`（`set_model` → `rpc`）、`1547-1574`（`set_thinking_level` → `rpc`）；前端 `col.postJson` 带本列 clientId（`web/src/main.js:622, 636`、`web/src/column.js:19-25`） |
| F12 | 模型清单、命令清单取**主引擎**（`primaryEngine`），与会话无关 | `bridge/src/index.mjs:1447-1448`（`handleModels`：`const engine = primaryEngine(); // 全局端点`）、`1576-1577`（`handleCommands` 同）；`bridge/src/index.mjs:429` |
| F13 | 顶栏模型/思考确实跟随「活动列」，但只在 `setActive` 与 `columnUpdated` 两条路径上同步 | `web/src/main.js:516-524`（`syncHeaderFromColumn`）、`2998`（`setActive` 里调）、`2789-2791`（`columnUpdated` 里 `applyModelToSelect(active.model)` / `applyThinkingToSelect(...)`）；列状态来源 `web/src/column.js:650-655` |
| F14 | 会话的模型不在「已配置清单」里时，顶栏静默保留上一次的值（不是显示真实值） | `web/src/main.js:494-503`（`applyModelToSelect` 找不到 option → `return false`，`els.model.value` 不动）；清单来自 F12 的全局端点 |
| F15 | MCP 名单在**建引擎时**按 cwd 规则算一次；改名单 = 换子进程（并把会话 switch 回去） | `bridge/src/index.mjs:319`（`resolveMcpServers({ cwd, config })`）、`bridge/src/mcp-config.mjs:151-158`；`bridge/src/index.mjs:1214-1260`（`handleEngineRestart`：`createRpc(engine, engine.extra.cwd)` → 等 idle → `switch_session` 回原文件）；`bridge/src/index.mjs:1257` |
| F16 | 同一会话被两个引擎打开 → 409 `CONFLICT`；前端降级为只读浏览 | `bridge/src/index.mjs:1696-1700`（`pool.sessionOwner`）；`web/src/column.js:232-247`（409 文案区分「已被另一标签页打开」/「项目目录已移动或删除」） |
| F17 | 换 cwd 的代价是重启子进程（≈1–2s，带 MCP 还要多一次 3s 级 `switch_session`），重启后是**全新空会话**；streaming 中拒绝 | `docs/00-glossary.md:121`（「RPC 没有 `set_cwd`，`new_session` 也不接受 cwd，只能重启子进程，代价 1–2 秒」）、`docs/03-design.md:74-76`（重启后 pi 处于全新空会话，H-5）、`docs/ARCHITECTURE.md:259`（带 MCP 的接管回退到 1–3s）、`bridge/src/index.mjs:1214-1260`（`handleEngineRestart` 的 switch 超时 60s）；`bridge/src/index.mjs:1069-1070`（streaming → 503） |
| F18 | 列上限 3、引擎上限 4；移动端窄屏只显示活动列 + 侧栏抽屉 | `web/src/main.js:2702`、`bridge/src/index.mjs:82`；`web/src/main.js:94`、`2704-2706`、`2871`；`web/src/column.js:213`（选中会话自动收抽屉） |
| F19 | 新建会话在 streaming 中会被拒（桥 409 + 前端预检双保险） | `bridge/src/index.mjs:1830-1832`；`web/src/column.js:1075-1078` |
| F20 | 左侧会话列表已按 cwd 分组，且 group 携带 `cwd` 字段可直接复用为「项目清单」 | `bridge/src/sessions.mjs:353`（`header.cwd`）；`web/src/list.js:140`（渲染 `row.group.cwd`）；列表数据 `GET /api/sessions`（`bridge/src/index.mjs:827-860`） |

---

## 2. 差距清单

### 2.1 需求 2「网页新会话能选目录」

**后端**

| # | 缺口 | 依据 |
|---|---|---|
| B2-1 | `/api/session/new` 不收 cwd，也没有「按项目建会话」的语义 | F2 |
| B2-2 | 引擎创建/认领不接 cwd（`/api/engine/claim` 只认 `client` / `mcp`） | F1、F9、`bridge/src/index.mjs:2125-2135` |
| B2-3 | 没有「校验 + 归一化用户输入的目录」的公共函数（`handleWorkspace` 内联了一份，不可复用） | `bridge/src/index.mjs:1061-1068` |
| B2-4 | 响应里没有会话当前 cwd（`get_state` 无 cwd，桥也没补） | F8 |
| B2-5 | `engine.extra.cwd` 与会话真实 cwd 会脱钩（打开旧会话后），影响 `health.pi.cwd`、MCP 规则、turn-changes | F5、F7、`bridge/src/index.mjs:573`、`319` |

**前端**

| # | 缺口 | 依据 |
|---|---|---|
| F2-1 | 没有项目选择器 / 目录输入（顶栏只有只读 `#ws-path`） | F9、F10 |
| F2-2 | `newSession()` 发空 body，且成功后 `c.cwd` 不更新（读不存在的 `state.cwd`） | F2、F8 |
| F2-3 | 新会话无「所属项目」展示：`#session-meta`、列头、顶栏都可能停留在上一个项目 | F8、`web/src/column.js:1084` |
| F2-4 | 移动端无项目入口（抽屉里只有会话树/列表） | F18、`web/index.html` 侧栏结构 |
| F2-5 | 没有「最近使用的项目」记忆（每次都要重新输路径） | 代码内无 localStorage 项目键：CMD `grep -rn "project\|recent" web/src/*.js` 无项目级存储 |

### 2.2 需求 3「顶栏配置跟随会话」

**后端**

| # | 缺口 | 依据 |
|---|---|---|
| B3-1 | `/api/models` 取主引擎，不是调用方引擎（MCP shim 的临时 agentDir 可能给出不同模型表） | F12、F15；`bridge/src/index.mjs:1448` |
| B3-2 | `/api/commands` 同上（斜杠命令/技能清单随 agentDir 与项目 `.pi/` 变化） | `bridge/src/index.mjs:1577` |
| B3-3 | 没有「一次拿到该会话全部配置」的视图端点（cwd / model / thinking / mcp 分散在 4 个端点） | 现有端点清单 `bridge/src/index.mjs:2077-2247` |
| B3-4 | `health.pi.cwd` 用 `engine.extra.cwd`（陈旧），与「顶栏显示会话项目」冲突 | F7、`bridge/src/index.mjs:566-573` |
| B3-5 | 已符合项（不改）：`/api/model`、`/api/thinking`、`/api/thinking-levels`、`/api/mcp/state` 已按引擎 | F11；`bridge/src/index.mjs:2077-2096` |

**前端**

| # | 缺口 | 依据 |
|---|---|---|
| F3-1 | 顶栏 cwd 不随会话切换刷新（只有打开会话时 `onCwd` 一次） | F8 |
| F3-2 | 模型下拉的**选项集**是全局的、只在启动/reload 拉取，不随列/会话 | F12、`web/src/main.js:527` |
| F3-3 | 当前模型不在选项集时静默保留旧值 → 顶栏显示「上一个会话的模型」 | F14 |
| F3-4 | MCP 只体现在列头徽标与资源面板，顶栏没有该会话的 MCP 状态 | `web/src/main.js:2799`（`paintMcpBadges`）；`web/src/column.js` 列头 |
| F3-5 | 顶栏同步只覆盖 `setActive` / `columnUpdated` 两条路径，会话 attach 完成后不会主动再同步一次 cwd | F13、`web/src/column.js:220-228`（`openSession` 里 `onCwd` 有，`newSession` 里没有） |

**结论**：需求 3 的「写」链路已经按引擎（F11），真正的缺口是**读链路**（清单/视图）与**cwd 的真相来源**（F7/F8）。

---

## 3. 方案

### 3.A 需求 2：新会话怎么拿到目录

#### 方案 A1（推荐）：`/api/session/new` 接受 `cwd`，按需重启本列引擎

- 桥：`POST /api/session/new {cwd?}`
  1. `cwd` 缺省 → 走现状（当前运行时 cwd）；
  2. `cwd` 给出 → `resolve + stat` 校验（复用 `handleWorkspace` 的校验逻辑抽成 `resolveProjectDir()`）；
  3. 与该列**运行时 cwd** 不同 → 停子进程 → `engine.extra.cwd = next` → `createRpc(engine, next)` → 等 idle → `new_session`；
  4. 相同 → 直接 `new_session`；
  5. 响应补 `cwd`（并顺手修 F8 的死分支）。
- 前端：新建会话前弹「选项目」层：项目列表 = `/api/sessions` 的 groups（F20）去重后的 cwd，末尾「其他目录…」手输；选择结果写 localStorage（最近 5 个）；移动端用底部抽屉（复用侧栏抽屉样式）。
- 代价：换项目时 1–3s 停顿（F17）；`streaming` 中被拒（与现状一致，F19）。
- 风险：
  - **引擎重启失败**（新目录被删/权限）→ 必须先校验再停进程，失败保持原引擎与会话（`handleWorkspace` 已有此顺序，直接复用）；
  - **MCP shim 重建**：重启必须走「新 cwd → 重算 `resolveMcpServers` → 重建 shim」而不是沿用旧名单（否则项目级 `.pi/mcp.json` 规则失效，F15）；
  - **多列**：只重启本列引擎，不影响其他列（`createRpc` 是 engine 级，`bridge/src/index.mjs:332`）；
  - **409**：重启后 `engine.extra.claim = null`（新空会话不占文件），不会与其它列抢同一 `.jsonl`（F16）。
- 复用度：`handleWorkspace`（1053-1097）已有 90% 逻辑，只是入口语义从「切工作区」变成「给新会话选项目」，且不再需要「旧会话保留」那部分。

#### 方案 A2：列 = 项目（建列时选目录，列内永不变项目）

- `/api/engine/claim {cwd}` 建列即定项目；列头显示项目名；`newSession` 永远用列 cwd，不重启。
- 代价：新建/切列才 1–3s，新会话零等待；但要改「列=会话」的现有语义（`docs/ARCHITECTURE.md:71-85`），跨项目必须先加列（列上限 3，F18）。
- 风险：移动端单列时「换项目」= 关列再建列，用户会感知为「会话丢了」；且 `switch_session` 打开其他项目的历史会话仍会改运行时 cwd（F4），与「列锁项目」的承诺冲突——需要额外拒绝跨项目打开会话，属于范围扩张。
- 结论：不推荐（引入新模型，收益只是省 1–3s）。

#### 方案 A3：预置空会话文件 + `switch_session(cwdOverride)`

- 桥自己写一个 header-only `.jsonl`（`{type:"session", version, id, timestamp, cwd}`）到 `sessions/--<编码 cwd>--/`，再 `switch_session(path)`，pi 用 header cwd 重建运行时（F4），零重启。
- 代价：要自己维护 pi 的会话文件格式与版本迁移（`pi:dist/core/session-manager.js:1338-1358`、`migrateToCurrentVersion`）。
- 风险（高）：违反 H-5「空会话不落盘」（`docs/03-design.md`）；`session_start` 原因会变成 `resume`，扩展行为不同；pi 升级改 header 结构即坏；被删/被移动后需要清理孤儿文件。
- 结论：不推荐，仅作为「零重启」备选记录。

### 3.B 需求 3：顶栏配置跟随会话

#### 方案 B1（推荐）：会话视图对象 + 前端单一同步入口

- 后端：
  1. 新增 `GET /api/session/view?client=<id>`（按引擎）返回 `{ cwd, sessionFile, model, thinkingLevel, mcp: string[], projects? }`；cwd 真相取自 **运行时**（`switch_session` 后由 pi 侧决定 → 桥在 `attachSession` / `new_session` 后用会话 header cwd 回写 `engine.extra.cwd`，修 F7/B3-4）；
  2. `/api/models` `/api/commands` 改为「有 `client` 参数就用该引擎，否则回落主引擎」（向后兼容脚本）。
- 前端：`syncHeaderFromSession(view)` 成为唯一入口（替代 `syncHeaderFromColumn`），`setActive`、`columnUpdated`、`openSession`、`newSession`、SSE `session_attached` 都调它；模型下拉的选项集按 `view.client` 缓存（`Map<client, models>`）。
- 代价：一个端点 + 一处前端重构；`/api/models` 参数化需要 3 处调用点同步（`web/src/main.js:527`、`603`、`1129` 附近）。
- 风险：
  - 主引擎可能不存在（全部列已释放）→ 端点必须能只返回引擎侧字段、`projects` 由 sessions 聚合兜底；
  - 模型不在清单 → 顶栏显示「该模型已不可用」而不是静默保留旧值（修 F14），不引入降级；
  - 多列并发请求 → 视图按 client 计算，无全局缓存即可。

#### 方案 B2：只做前端补丁（不加端点）

- 各端点照旧，前端在 `openSession` / `newSession` 后各自拉 `/api/models?client=`、`/api/thinking-levels`、`/api/mcp/state`，并手工拼 `cwd`。
- 代价：改动最小（只动 `web/`），但前端要知道 4 个端点的组合规则；cwd 仍无真相来源（F7 不修），顶栏与 `health.pi.cwd` 会继续不一致。
- 结论：可作为 B1 的**降级路径**（若批次时间不够），不推荐作为终态。

---

## 4. 实施拆解（每条 ≤3h）

批次顺序：**G0 契约 → G1 需求2 → G2 需求3**。每批结束停手报证据。

### G0 · 契约与真相来源（约 5h，两条）

| 任务 | 内容 | 文件 | 验收命令（期望） | 证据脚本 | 估时 |
|---|---|---|---|---|---|
| T1 | 抽 `resolveProjectDir(input)`（resolve + stat.isDirectory + 错误码 `BAD_REQUEST`），`handleWorkspace` 改用它；`/api/session/new` 接受 `{cwd?}`，校验 → 需要时重启本列引擎 → `new_session` → 响应带 `cwd` | `bridge/src/index.mjs`（1053-1097、1826-1845、2355-2363）；新增 `bridge/src/project-dir.mjs` | `cd bridge && npm test`（≥148/148，新增 4 条：合法/不存在/非目录/无需重启）；CMD `curl -s -XPOST :PORT/api/session/new -d '{"cwd":"<tmp>"}'` → `{"cwd":"<tmp>", ...}`；`{"cwd":"C:/nope"}` → 400 `BAD_REQUEST` | 新增 `scripts/evidence/new-session-dir-api.mjs`（纯 HTTP，端口 7832） | 3h |
| T2 | 会话 cwd 回写：`attachSession` / `handleNewSession` / `handleEngineRestart` 后把会话 header cwd 写入 `engine.extra.cwd`；`/api/health` 的 `pi.cwd` 与 `/api/session/open` 响应的 `cwd` 一致 | `bridge/src/index.mjs`（1640-1675、1826-1845、1257 附近、566-573） | CMD 打开 `--C--Users-user-pi-shell--` 的会话后 `curl /api/health` → `pi.cwd == "C:/Users/user/pi-shell"` | 同上脚本 + `scripts/evidence/m1d-workspace-g1.mjs`（回归，走 HTTP） | 2h |

### G1 · 需求 2 前端（约 5h，两条）

| 任务 | 内容 | 文件 | 验收命令（期望） | 证据脚本 | 估时 |
|---|---|---|---|---|---|
| T3 | 项目选择层：数据源 `/api/sessions` groups 去重 cwd + 手输「其他目录」；localStorage 最近 5 个；`newSession(cwd)` 传参并回填 `c.cwd`（用响应 `cwd`，删 F8 死分支）；错误提示（目录不存在 400 / streaming 409） | `web/src/column.js`（1074-1106）、`web/src/main.js`（3059 绑定）、`web/index.html`（新增 dialog 节点）、`web/src/style.css` | CMD `node scripts/test-gate.mjs --only unit,composer,firstLoad` → 全绿；手工：选 `C:/Users/user/pi-shell` 新建 → 发一句 → `ls ~/.pi/agent/sessions/--C--Users-user-pi-shell--/` 出现新 `.jsonl` | 新增 `scripts/evidence/new-session-dir-ui.mjs`（CDP，端口 7833） | 3h |
| T4 | 移动端适配：项目选择层在 ≤`MOBILE_MAX` 用底部抽屉；顶栏 `#ws-path` 显示当前项目短名 | `web/src/style.css`、`web/src/main.js`（2754-2760） | CMD `PI_SHELL_MOBILE_PORT=7862 node scripts/evidence/mobile-ui.mjs` → PASS（含新会话可点） | `scripts/evidence/mobile-ui.mjs`（扩展一条断言） | 2h |

### G2 · 需求 3（约 6h，两条）

| 任务 | 内容 | 文件 | 验收命令（期望） | 证据脚本 | 估时 |
|---|---|---|---|---|---|
| T5 | 后端：`GET /api/session/view?client=` 返回 `{cwd, sessionFile, model, thinkingLevel, mcp}`；`/api/models` `/api/commands` 支持 `?client=`（缺省回落主引擎） | `bridge/src/index.mjs`（1447-1475、1576-1586、路由 2077-2247） | CMD `curl -s ':PORT/api/session/view?client=<col>'` → 字段齐全且 `cwd` == 该会话项目；`/api/models?client=<带shim的列>` → 与该列 `get_available_models` 一致 | 新增 `scripts/evidence/session-view-api.mjs`（纯 HTTP，端口 7834） | 3h |
| T6 | 前端：`syncHeaderFromSession()` 单一入口，接 `setActive`/`columnUpdated`/`openSession`/`newSession`/SSE `session_attached`；模型选项按 client 缓存；模型缺失时显式提示「该模型不可用」而非保留旧值；顶栏加 MCP 徽标 | `web/src/main.js`（494-530、516-524、2774-2805、2998）、`web/src/column.js`（220-228、650-655） | CMD `node scripts/test-gate.mjs --only composer,models,multi,mcp` → 全绿；脚本断言：切到 B 列后 `#model` 值 == B 列会话模型、`#ws-path` == B 列 cwd | 新增 `scripts/evidence/session-header-follow-ui.mjs`（CDP，端口 7835）+ 回归 `scripts/evidence/multi-column-ui.mjs`(7881)、`mcp-toggle-ui.mjs`(7898) | 3h |

**合计**：6 条任务 ≈16h（含自测与证据脚本）。G0 与 G1 可并行（不同文件），G2 依赖 T2（cwd 真相）。

---

## 5. 验收方式

### 5.1 通用纪律

- **不占 7788**：所有证据脚本用独立端口（本文件分配 7832–7835，现有脚本 7823/7825/7861/7881/7898）。
- **不碰真实会话**：`PI_SHELL_SESSIONS_DIR=%TEMP%\pi-shell-session-project\sessions` 作夹具；
  `PI_SHELL_MCP_CONFIG` 指向空配置（仿 `scripts/test-gate.mjs:26-31`）；
  `PI_SHELL_ORIGINS_FILE`、`PI_SHELL_LOG_DIR` 一并指向夹具目录。
- 收尾：按端口/PID 关桥，`Get-Process` 确认无残留（禁止按命令行模式批量杀）。

### 5.2 命令与期望

```bash
# 1) 单测（不启桥）
cd bridge && npm test
# 期望：≥148/148（现状 148），新增 session_new_cwd_* 4 条全过

# 2) 夹具桥 + 端点契约（T1/T5）
PI_SHELL_PORT=7832 \
PI_SHELL_SESSIONS_DIR="$TEMP/pi-shell-session-project/sessions" \
PI_SHELL_AGENT_DIR="$TEMP/pi-shell-session-project/agent" \
PI_SHELL_MCP_CONFIG="$TEMP/pi-shell-session-project/pi-shell-mcp.json" \
node bridge/src/index.mjs &
node scripts/evidence/new-session-dir-api.mjs
# 期望：PASS 全部（含 400 目录不存在、409 streaming、cwd 回填、无需重启的快速路径 <300ms）

# 3) 桥就绪 + 项目列表来源
curl -s "http://127.0.0.1:7832/api/sessions" | head -c 400
# 期望：groups[].cwd 存在（夹具里通常 0 组 → 用 UI 脚本造的 tmp 项目目录出现 1 组）

# 4) UI 主路径（T3）
node scripts/evidence/new-session-dir-ui.mjs
# 期望：N1 项目列表含夹具项目 → N2 新建后 #ws-path == 该项目 → N3 发消息后
#       夹具 sessions/--<编码>--/ 出现新 .jsonl（用 fs.readdir 断言，不看截图）

# 5) 顶栏跟随（T6）
node scripts/evidence/session-header-follow-ui.mjs
# 期望：切列/开会话后 #model / #thinking / #ws-path / MCP 徽标 == 该会话真实值；
#       模型被移除时出现「该模型不可用」提示而不是旧值

# 6) 回归门（发版前）
node scripts/test-gate.mjs --full
# 期望：全绿；若引入新脚本，先在 test-gate SUITES/MAP 登记
```

### 5.3 证据留档

`docs/evidence/` 只放**可复核的产物**：`session-project-api.txt`（脚本 stdout）、
`new-session-dir.png`、`session-header-follow.png`。截图不作为唯一证据（数字/文件名优先）。

---

## 6. 决策点

**决策点 1：新建会话换项目时，是否允许「同一列跨项目」（需重启引擎）**
- 选项 A：允许，`/api/session/new {cwd}` 按需重启本列引擎（1–3s 停顿，方案 A1）／代价：重启逻辑 + 校验 + MCP 重算，约 T1 3h
- 选项 B：不允许，列创建时锁项目（方案 A2）／代价：改「列=会话」语义 + 跨项目打开会话需拒绝，估时 ≥5h 且移动端体验倒退
- 我的推荐：**A**，理由：与现有「列=会话、会话带 cwd」模型一致，且能复用 `handleWorkspace`。

**决策点 2：决定「项目清单」的来源**
- 选项 A：`/api/sessions` 已知分组 ∪ 手输路径 ∪ localStorage 最近 5 个／代价：0 新配置，约 1h
- 选项 B：新增项目注册表文件（`~/.pi/agent/pi-shell-projects.json`，可命名/排序/置顶）／代价：新配置面 + 迁移 + 校验，约 3h，且引入「项目」为持久实体（用户原话只要求「会话所属目录」）
- 我的推荐：**A**，理由：用户要的是「新会话能选目录」，不是「项目管理」；注册表属未确认范围（PLAN §3 纪律）。

---

## 7. 不做 / 待验证

- 不做：项目注册表、项目级设置页、跨项目会话迁移、`pi` 会话文件手写（方案 A3）。
- 待验证（V-1，随 T6 闭环）：F5 的推断——同一引擎「打开 pi-shell 会话 → 新建会话」是否真的落在 `pi-shell` 目录；
  验证方法：夹具里打开 `--C--Users-user-pi-shell--` 的会话，新建后看新 `.jsonl` 落在哪个目录。
