# 设计 · 后台不中断（PLAN §2-1）

> 范围：**只做设计调研，不含实现**。上位事实：`docs/PLAN.md` §2-1、`docs/ARCHITECTURE.md`、`docs/03-design.md`。
> 证据口径：`file:line` 为提交时工作区（分支 `feat/bg-continue`，基线 `ab52e16`）的真实行号；
> 命令类证据标 **CMD** 并附输出摘要。推断类结论标 **INFERRED**；未验证的写进 §7。
>
> 用户原话（PLAN §2-1）：
> 「切走/关标签后，正在跑的那一轮继续运行，回来时补齐输出。」
>
> 路径前缀约定：`bridge/` `web/` 指本仓库；`pi:` 指
> `~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/`；
> `piagent:` 指同目录下 `@earendil-works/pi-agent-core/`。

---

## 0. 结论摘要（先看这 6 条）

1. **关标签不会立刻中止回合**——SSE 断开只做集合清理，全仓库唯一的 `abort` 调用点是显式 `/api/abort`。
   回合会被 **60–65s 后的空闲回收**（SIGTERM）杀掉，而不是"一关就死"。
2. 回收判定**完全不看 `state === "streaming"`**：`sweep()` 只看「无 SSE + 超过 idleMs 无请求」。
   CMD 探针（§2 F4）实测：`state=streaming`、无 SSE、idle 66s → 被 `idle-sweep` 回收。
3. `idleMs` 的起点是**最后一次请求**（打 prompt 那一刻）；流式期间桥不再发请求，所以"长回合"
   = 打 prompt 后 60s 就进入可回收窗口，与 SSE 何时断开无关。
4. **pi 侧的能力边界**：`get_entries?since` 的 entry id 是跨重启的持久游标，但**落盘发生在
   `message_end`**；流式中的半条 assistant 消息只存在 `agent.state.streamingMessage` 里，
   `get_state`/`get_messages`/会话 jsonl 都取不到 → **单靠会话文件补不齐"正在生成的那一段"**。
5. 推荐方案 = **A（流式中禁止回收）+ A2（每条消息落盘点重置的 SSE 尾巴回放）+ A3（孤儿引擎接管）**，
   分 4 个切片共 ≈9h；B（只延长窗口）与 C（回收后从文件补）都不满足原话，C 作为兜底保留现状。
6. 现有 409 / 切会话确认 / 资源面板释放 / 移动端 / MCP shim 的语义**一条都不改**——只有
   "同一会话被**无人看管**的引擎占着"这一种 409 会变成可接管（§9 自行决定 D1）。

> **决策点：无。** 两项由需求/参数推导出的取舍记在 §9（D1 自动接管、D2 容量计入），待 Owner 复核；
> 不属于「不改就无法继续」的事项，不占决策点名额。

---

## 1. 术语与边界

| 词 | 含义 |
|---|---|
| 切走 | 切到别的窗口 / 别的浏览器标签 / 别的列；本页仍在，但可能被浏览器节流 |
| 关标签 | 页面被销毁（`pagehide` → `clientId` 随 sessionStorage 消失，`tab-identity.js:1-20`） |
| 断线 | SSE 连接断但页面活着（网络抖动、代理超时、手机锁屏被 suspend） |
| 一轮 / turn | 一条 user 消息驱动的一段工作，结束标志是 `agent_settled`（`pi:docs/json.md:36-48`） |
| 孤儿引擎 | 池里仍在跑、但**没有任何 SSE 连接**的引擎（标签页已关/被 suspend） |

**明确不在本设计内**：桥进程重启后恢复（优雅退出会 `releaseAll` 全部引擎
`bridge/src/index.mjs:2633-2665`，回合必丢；桥被 `SIGKILL` 时 pi 子进程可能变孤儿是老问题，不在本设计内）；
跨设备/跨用户恢复（无账号体系）；"关标签后继续心跳保活"（会破坏 pi-shell 的"关标签即释放"约定）；
修改 pi 本身；**放宽扩展权限确认的 10s 自动取消**（F30，见 V-8）。

---

## 2. 现状事实表

### 2.1 断链路的实际行为

| # | 结论 | 证据 |
|---|---|---|
| F1 | **SSE 断开不触发任何中止**：`cleanup` 只从两个 Set 里删连接、记 `sse_close` | `bridge/src/index.mjs:814-824` |
| F2 | 全仓库唯一的中止调用点是显式端点：`await rpc.request("abort")` | CMD `grep -rn '"abort"' bridge/src/*.mjs` → 仅 `bridge/src/index.mjs:2033`（路由 `2509-2520`） |
| F3 | **`sweep()` 不检查 `streaming`**：只跳过 `stopping` / `pinned` / 有 SSE / 未到 `idleMs` | `bridge/src/engines.mjs:263-276`；`isAlive()` 同样不把 streaming 当活着的理由 `bridge/src/engines.mjs:177-183` |
| F4 | CMD 探针（`/tmp/sweep-probe.mjs`，直接 import `engines.mjs`，不启桥、不占端口）：构造 `state=streaming` + `sseClients=∅` + `idle=66s` 的引擎 → `pool.sweep(now)` 返回 `["tab#c1"]`，`rpc.stop("engine-idle-sweep")` 被调用，池大小归 0 | 输出：`{"state":"streaming","sse":0,"idleSec":66,"removed":["tab#c1"],"stopped":[["stop","engine-idle-sweep"]],"poolSize":0,"isAlive":false}` |
| F5 | 回收每 5s 一轮；`idleMs` 默认 60000 且**无环境变量可调** | `bridge/src/index.mjs:497-507`；`bridge/src/engines.mjs:15`（`DEFAULT_IDLE_MS`） |
| F6 | `lastSeenAt` 只在两处刷新：**SSE 连接建立**（`engine.touch()`）与**操作型端点解析引擎**（`hit.touch()`） | `bridge/src/index.mjs:799`、`2087`、`2125`、`2133`；`grep -n "\.touch("` 全量命中仅此 4 处 |
| F7 | 流式期间**没有任何周期性请求会 touch 引擎**：`/api/health`、`/api/engines/stats`、`/api/git/diff` 都只读引擎（`/api/stats` 会 touch，但前端只在接管完成与轮末调用，不是轮询） | `bridge/src/index.mjs:662-682`（healthBody）、`363-384`（stats）、`949-957`/`991-998`（diff 走 cwd 白名单，不碰引擎）、`2450-2456`（`/api/stats` 用 `needsEngine`）；前端调用点仅 `web/src/column.js:224`、`764`、`804` |
| F8 | 回收 = `rpc.stop()`：SIGTERM → 2s → SIGKILL（按 PID，不按命令行匹配） | `bridge/src/rpc.mjs:403-425`、`436-470`；`KILL_GRACE_MS=2000` `bridge/src/rpc.mjs:18` |
| F9 | pi 收到 SIGTERM → `shutdown(143)` → `runtimeHost.dispose()` → `session.dispose()` → `agent.abort()` → **立刻 `process.exit`**（SIGTERM 分支还跳过 stdout flush） | `pi:dist/modes/rpc/rpc-mode.js:275-288`、`580-596`；`pi:dist/core/agent-session-runtime.js:296-303`；`pi:dist/core/agent-session.js:1024-1035`；`agent.abort()` 只是 `abortController.abort()`：`piagent:dist/agent.js:221-223` |

**F1+F3+F8 合起来就是当前缺陷的完整因果**：关标签 → SSE 断（不中止）→ 回合继续在子进程里跑 →
最迟 65s 后被 idle-sweep SIGTERM → 回合被砍 → `message_end` 没发生 → 这一段没落盘。
**INFERRED**：F9 的代码链说明 SIGTERM 时 abort 的收尾是异步的、而 `process.exit` 紧随其后，所以
半条消息**极可能落不了盘**（存在竞态，见 V-1）。

### 2.2 pi 侧能力（回来时能补回什么）

| # | 结论 | 证据 |
|---|---|---|
| F10 | `get_entries?since=<entryId>` 是**持久游标**（"durable cursor … even across client restarts"），返回 `{entries[], leafId}`；`since` 不命中 → `success:false` | `pi:docs/rpc-commands.md:689-717` |
| F11 | 会话是 append-only 树，entry 有稳定 `id`/`parentId`；assistant/user/toolResult 都是 message entry | `pi:docs/session-format.md` §Entry Types；`bridge/src/sessions.mjs`（桥已有文件读取器） |
| F12 | **落盘时机 = `message_end`**：`if (event.type === "message_end") → sessionManager.appendMessage(...)`，其它事件不落盘 | `pi:dist/core/agent-session.js:768-781` |
| F13 | 落盘是**每条 entry 一次 `appendFileSync`**（不是轮末整写），所以"已完成的消息"在文件里始终是最新的 | `pi:dist/core/session-manager.js:795-814` |
| F14 | **流式中的半条消息不在 `messages` 里**：`message_start/update` 只写 `state.streamingMessage`，`message_end` 才 `messages.push(...)` | `piagent:dist/agent.js:399-410`；`session.messages === agent.state.messages`：`pi:dist/core/agent-session.js:1248-1250` |
| F15 | `get_state` 只给 `isStreaming / sessionFile / messageCount / pendingMessageCount` 等元信息，**没有半条消息正文** | `pi:docs/rpc-commands.md:155-184` |
| F16 | 工具事件 `tool_execution_start/update/end` 是独立事件，`update` 带 `partialResult`；只有工具**结果消息**会被 `message_end` 落盘 | `pi:docs/json.md:101-114`；F12 同源 |
| F17 | 嵌套工具调用（`parentToolCallId`）**不落盘**（历史会话无法重建嵌套关系） | `bridge/src/turn-changes.mjs:19` |
| F18 | 流式增量是 delta-only（`assistantMessageEvent`），`text_end/thinking_end/toolcall_end` 带权威终值，`message_end.message` 整条覆盖 | `pi:docs/json.md:91-99`；前端已按此实现 `web/src/stream.js:1-10` |

**由此回答任务卡问题 2**：

- **已完成的部分**：`get_entries?since` + 会话 jsonl 足够，且**不重启也能取**（`get_entries` 读的是
  sessionManager 的内存 entries，落盘只是持久化）。桥已经有这条通路：
  `bridge/src/index.mjs:1375-1402`（`/api/session/entries?since=`）+ 前端补齐
  `web/src/column.js:704-733`（含 `resync` 全量重载）。
- **正在生成的那一段**：取不到（F14/F15）。所以"只从会话文件补"必然缺最后一截。
- **思考块**：已完成消息里的 thinking 块随 message entry 落盘，可回放；**进行中的**思考块取不到。
- **工具块**：已完成工具的 `toolResult` entry 可回放（输出、isError）；**执行中的** `tool_execution_update`
  产物取不到；嵌套关系永久丢失（F17）。

### 2.3 桥侧现有机制（可复用的零件）

| # | 机制 | 现状 | 证据 |
|---|---|---|---|
| F19 | 按引擎分组广播 | `broadcast(engine, payload)` 只写 `engine.extra.sseClients` | `bridge/src/index.mjs:525-532` |
| F20 | 帧带单调 `seq`，但**没有 `id:` 行**（EventSource 的 `Last-Event-ID` 因此不可用） | 帧体 `{seq, engine, ...payload}`，body 只有 `data: ...` | `bridge/src/index.mjs:517-523`、`529-531` |
| F21 | **桥不缓存任何事件**（"断开期间产生的事件不补发"），补齐靠 `session/open` + `entries?since` | 注释即契约 | `bridge/src/index.mjs:509-511` |
| F22 | 前端断线策略：1s/2s/4s，3 次失败后停手 + 横幅（需手动「重试」） | `scheduleReconnect()` | `web/src/column.js:684-702` |
| F23 | 前端重连即 `backfill()`（`entries?since=lastEntryId`），`resync` → `openSession` 全量重载 | `backfill()` | `web/src/column.js:704-733`、`739-743` |
| F24 | SSE 每次连接先发一帧 `bridge_state` 快照（含 `pi.state`/session），并 `engine.touch()` | `openEventStream()` | `bridge/src/index.mjs:781-812` |
| F25 | 引擎归属：`pool.own()` 改名 + `pinned=false`；`claimEngine()` 只在本 clientId 没有引擎时新建 | `bridge/src/engines.mjs:219-232`；`bridge/src/index.mjs:2080-2103` |
| F26 | 同会话保护：`sessionOwner()` 比对 `lastGetState.sessionFile` **和** `extra.claim`（attach 占位），命中即 409 | `bridge/src/engines.mjs:279-288`；`bridge/src/index.mjs:1732-1738` |
| F27 | 409 的另外三处用途（**必须保持**）：streaming 中新建会话、streaming 中改 MCP、streaming 中切工作区 | `bridge/src/index.mjs:1913-1921`、`1199-1210`、`1072` |
| F28 | 打开会话是"两段式"：409 检查在**读文件之前**执行 → 409 时前端**拿不到任何 entries** | `bridge/src/index.mjs:1732-1738` 在 `1770`（`readSessionEntries`）之前；前端 409 分支只提示、不渲染：`web/src/column.js:231-247`。**INFERRED**：所以 409 文案里的"只读浏览"在当前实现下是空承诺 |
| F29 | `turn-changes` 快照按「会话内第 N 条 user 消息」编号，基数从文件里数；进程被杀 → 该轮只留 `-before`、没有 `-after`，下一轮重新数 | `bridge/src/turn-changes.mjs:87-107`、`211-221` |
| F30 | 扩展对话框（权限确认等）在**无 SSE 10s 后自动 `cancelled:true`** | `bridge/src/index.mjs:472-495`（`EXT_CANCEL_AFTER_MS=10000`） |
| F31 | 关一列 = 断开该列 SSE + 移除 DOM，**不调 release**；streaming 时弹确认框（文案断言"关闭会中止它"） | `web/src/main.js:3215-3230`；`web/src/column.js:826-834` |
| F32 | 关标签不调 release（`/api/engine/release` 只有资源面板用） | CMD `grep -rn "engine/release" web/src/` → 仅 `resources.js:169`、`238` |
| F33 | 资源面板口径 `pinned / live / idleSec` 来自 `isAlive()`，所以"孤儿流式引擎"现在会显示 `live:false`（与事实不符） | `bridge/src/index.mjs:363-384`；F3 |

---

## 3. 时间线（以"关标签"为例，当前实现）

```
t0   prompt POST 200（disposition=started）→ lastSeenAt=t0，state=streaming
t0+? 关标签 → SSE close → cleanup 只删集合（F1）→ 回合继续跑
t0+60s  sweep 看到：无 SSE、无 pinned、now-lastSeenAt>60s → release("idle-sweep")
t0+60..65s  SIGTERM → pi shutdown → agent.abort() → process.exit(143)
         → 流式中的 assistant 消息没有 message_end → 不落盘（F9 / V-1）
         → 前端下次打开只能看到"用户那条"，AI 那段凭空消失
```

三个可直接校验的推论：

1. **回合短于 60s 不会丢**（在 sweep 之前就 `message_end` 落盘了）——与「流式中关标签会被回收」的已知行为一致。
2. **SSE 断开时刻不重要，`lastSeenAt` 才重要**：t0+50s 关标签与 t0+5s 关标签，被杀时刻都在 t0+60~65s。
3. **切走（另一窗口）在桌面端不丢**（SSE 不断）；**手机锁屏/后台 suspend 会丢**（EventSource 断 + 页面被冻结，
   错过的事件也不在缓冲里，F21）。

---

## 4. 方案对比

### 方案 A：流式期间禁止回收（pin）+ 回来后补

- **A1 pin**：`isAlive()` 把 `state==="streaming"` 当作活着；`sweep()` streaming 直接跳过；
  回合结束（`agent_settled`）时 `touch()` 给一个 linger 窗口（默认沿用 60s），再按普通引擎回收。
- **A2 尾巴回放**：桥为每条引擎维护一个**"当前未落盘尾巴"**缓冲（`message_end` 时清空并记 `baseSeq`），
  SSE 重连时按 `?since=`（同页）或缓冲起点（新页面）回放；帧加 `id:` 行，先发一帧
  `{type:"resume", from, to, truncated}`。
- **A3 孤儿接管**：新页面打开会话时，如果 `sessionOwner()` 命中一个**无 SSE ≥30s** 且会话文件相同的引擎，
  则把它 `own()` 过来（先释放本客户端那条空闲空引擎），返回 `adopted:true`，前端随后重连 SSE。

| 维度 | 评估 |
|---|---|
| 改动面 | S1 两处判定 + 状态钩子（`engines.mjs`/`index.mjs`）；S2 新模块 + 缓冲接线 + 前端 `since`；S3 `openSession` 接管分支 |
| 回合是否继续 | ✅ 是（原话要求） |
| 回来是否补齐 | ✅ 已完成部分走 entries（已有），未落盘尾巴走回放；执行中的工具从 `tool_execution_*` 回放 |
| 风险 | 内存驻留（无 MCP ≈90MB / 带 MCP ≈540MB）；409 语义局部放宽（§9 D1）；多标签接管竞态（V-5）；容量占用（§9 D2） |
| 代价 | **中**（≈6.5h 后端+前端，不含 E2E 脚本） |

### 方案 B：只延长回收窗口 / 保活

- 做法：`idleMs` 提到 30min，或流式期间前端每 10s 打一次 `/api/engine/claim` 保活；或加
  `PI_SHELL_IDLE_MS` 环境变量让用户自己调。
- 问题：**只改变丢失的阈值，不改变"关标签后回合没人要"的事实**；超过窗口照样砍；
  关标签后没有前端可保活；suspend/断线期间错过的事件依旧不补。
- 改动面：1 个常量/环境变量（`bridge/src/engines.mjs:15`，+ 前端保活定时器）。
- 风险：内存驻留时间变长但**不可预期**（用户不知道什么时候丢）；保活会掩盖"关标签释放"的既有语义。
- 代价：**小**（≈0.5h），但**不满足需求**。可作为 A 的兜底参数（不单独实施）。

### 方案 C：照常回收，回来时从会话文件补

- 事实：能补的只有 `message_end` 过的消息（F12/F13）；半条 assistant、执行中的工具、
  嵌套工具关系都补不回来（F14/F15/F17）。而且**回合本身已经没了**（与"继续运行"冲突）。
- 现状其实已经实现了一半（`session/open` 直接读文件立即返回 + `entries?since` + `resync`），
  即"只读兜底"路线；它是 A 的**降级路径**，不该是主方案。
- 改动面：几乎为零（已经存在）。
- 风险：把"丢失"说成"补齐"（用户看到 AI 那一段凭空截断）；半条消息丢失不可提示。
- 代价：**小**（0h），但**不满足需求**。

### 对比小结

| | 回合继续 | 补齐完整 | 内存 | 409 影响 | 代价 |
|---|---|---|---|---|---|
| A（pin+回放+接管） | ✅ | ✅（含尾巴） | 回合期间驻留 | 仅"无人看管"一处放宽 | 中 |
| B（延长窗口） | 窗口内 ✅ | ❌ | 驻留时间失控 | 无 | 小 |
| C（文件兜底） | ❌ | ❌（缺尾部） | 无 | 无 | 小 |

**推荐 A**；B 的参数化（`PI_SHELL_IDLE_MS`）作为 A1 的附带产物（E2E 需要把窗口调小才跑得快），
C 保留为 A 的降级路径（`resync` + 只读浏览）。

---

## 5. 推荐方案的机制细节

### 5.1 生命周期（pin）

```
state: streaming  → isAlive=true（无论有无 SSE）；sweep 跳过；资源面板 live=true
state: streaming 且 now - streamStartedAt > MAX_TURN_MS（默认 2h，待回填）
                  → 允许回收 + log warn engine_pin_expired（防"永远卡住"）
agent_settled     → touch()（linger 一个 idleMs），streamStartedAt 清空；之后按普通引擎回收
```

- `MAX_TURN_MS` 只是**兜底**，正常路径靠 pi 自己的 `agent_settled`；取保守值并记日志，
  不静默降级（用户可在资源面板看到 `streaming` 并手动释放）。
- 显式 `/api/engine/release`、`/api/abort`、切会话、新建会话、改 MCP **不受 pin 影响**（F27/F31）。

### 5.2 尾巴回放（不重复、不乱序的关键）

缓冲的边界用**落盘点**切，而不是"整轮"：

| 时机 | 动作 |
|---|---|
| 每个 `message_end` 帧广播后 | 清空该引擎缓冲，`baseSeq = seq`（这批内容已经在 entries 里了） |
| 其它帧（`message_start` / `message_update` / `tool_execution_*` / `bridge_state` …） | 追加 `{seq, payload}`；字节上限 `PI_SHELL_TAIL_MAX_BYTES`（默认 2MB，单帧 >512KB 记 `truncated` 跳过） |
| SSE 连接 | 读 `?since=`（前端内存里的 `lastSeq`）或 `Last-Event-ID`；回放窗口 = `max(since, baseSeq)+1 .. now`（`since` 更老的部分由 `backfill()` 用 entries 补）；首帧发 `{type:"resume", from, to, truncated}` |
| 无 `since`（新页面/刷新） | 从 `baseSeq+1` 回放（= 只有未落盘的尾巴），已完成内容由 `openSession` 的 entries 渲染 |
| 缓冲被截断 | `resume.truncated=true` → 前端提示"部分输出未能补齐" + 回合结束后强制一次权威重载 |

为什么这样就**不会重复**：

1. 回放起点永远是 `max(since, baseSeq)+1`，即**只在落盘点之后**；`baseSeq` 之前（以及 `since` 与 `baseSeq` 之间）的消息都已落盘，会被 `openSession`/`backfill` 用
   **真实 entry id** 渲染；
2. 回放的帧只会进「live 容器」，`backfill` 只会进「entries 容器」，两者在 DOM 里天然有先后
   （`ensureLiveContainer()` 追加在 `el.log` 末尾 `web/src/column.js:374-382`，`renderSession` 的
   `[data-role=entries]` 在其之前）；
3. 回合 `agent_settled` 后前端做一次**权威重载**（已有 `backfill`/`openSession` 路径，加一个
   `needsAuthoritativeReload` 标志），把 live 合成节点换成正式 entry 节点（顺带修正 fork 锚点）。

### 5.3 孤儿接管（让"回来"能真的看到在跑的那一轮）

```
POST /api/session/open {path}
  ├─ 本客户端已有引擎（正常路径）→ 现状不变
  └─ sessionOwner(path) 命中别的引擎 E
       ├─ E 有 SSE 或 noClientSince < 30s          → 409（现状不变；parallel-ui P6 / multi P5 仍须 PASS）
       ├─ E 的 sessionFile/claim ≠ path（别的会话）→ 409（现状不变）
       ├─ 本客户端那条引擎正在 streaming 或非空会话 → 409（不抢）
       └─ 否则：await release(本客户端空闲空引擎, "adopt-swap")
                pool.own(E, clientId)              ← 注意 F25：同键覆盖会静默丢旧引擎，必须先 release
                E.touch()；broadcast bridge_state；返回 {adopted:true, mode:"live", entries, state}
```

前端拿到 `adopted:true` 后 `c.connect()` 重连 SSE（`claimEngine` 会 `find()` 到已被 own 的 E），
于是回放 + 实时帧都落在正确的引擎上。

**为什么必须先 release 旧引擎**：`pool.own()` 直接 `_engines.delete(previous)` 再
`_engines.set(clientId, engine)`（`bridge/src/engines.mjs:219-232`）——同一 clientId 若已有一条引擎，
记录会被**静默覆盖**，旧子进程再也不会被 stop（孤儿 pi + MCP shim 泄漏）。这是实现里最容易踩的坑。

### 5.4 前端三处"说谎"要一起改

| 现状 | 改成 |
|---|---|
| 关列确认框："关闭会中止它（已生成的内容会保留在会话文件里）" `web/src/main.js:3223` | "关闭不会中止它，会继续在后台运行；回来打开这条会话就能看到继续生长/最终的结果"（前半句由 S1 保证，后半句由 S2/S3 保证）。**不要**再沿用"已生成的内容会保留在会话文件里"：半条消息不落盘（F14/F15），今天这句话是不成立的 |
| 断线 3 次后停手、只留横幅 `web/src/column.js:684-702` | `visibilitychange` 回来时若 `es.readyState !== OPEN` → `manualRetry()`（手机 suspend 场景） |
| 引擎换了会话但页面不知道（引擎被回收后重建 = 空会话） | 用 `bridge_state.session.sessionId` 与 `c.sessionId` 比对（`attachState==="attached"` 时才判），不一致就先 `openSession` 再允许发送 —— 防"prompt 发进空会话" |

---

## 6. 实施拆解（每片 ≤3h，均含验收命令）

> 统一前置：所有临时验证都用 `PI_SHELL_SESSIONS_DIR=<tmp>` + 独立端口（7831/7832），不碰 7788、
> 不碰真实会话；跑完按 PID 清理自己起的桥/Edge。
> 新增套件要登记到 `scripts/test-gate.mjs` 的 `SUITES`（`scripts/test-gate.mjs:39-53`）。

### S1 · 流式中不回收（≈1.5h）

- 文件：`bridge/src/engines.mjs`（`isAlive`/`sweep` + `streamStartedAt`/`MAX_PIN_MS`）、
  `bridge/src/index.mjs`（state 钩子：streaming 记 `streamStartedAt`、idle 时 `touch()`；读 `PI_SHELL_IDLE_MS`
  传进 `EnginePool`，默认 60000 不变）、`bridge/test/engines.test.mjs`
- DoD：
  - streaming + 无 SSE + 超过 idleMs → `sweep()` 返回空、`isAlive` 为 true、资源面板行 `live:true`；
  - streaming 超过 `MAX_PIN_MS` → 允许回收并记 `engine_pin_expired`；
  - `agent_settled` 后引擎在一个 `idleMs` 内仍可取（linger），随后被正常回收；
  - 非 streaming 的既有用例全绿（含 `pinned`/`stopping`/有 SSE）。
- 验收：`cd bridge && npm test`（期望 `pass` 全绿，新增 ≥4 条用例）；
  `node scripts/test-gate.mjs --only unit`
- 证据脚本：无（纯单测即可，确定性最高）

### S2 · SSE 尾巴回放（≈3h）

- 文件：新增 `bridge/src/sse-tail.mjs`（纯模块：`reset(baseSeq)` / `push(frame)` / `since(seq)` / `truncated`）、
  `bridge/src/index.mjs`（`broadcast` 追加缓冲、`message_end` 后 reset、`openEventStream` 回放 + `id:` 行 +
  `resume` 帧、`sseWrite` 支持 id）、`bridge/test/sse-tail.test.mjs`
- DoD：
  - `id:` 行存在，`?since=` 与 `Last-Event-ID` 都能命中；
  - 回放顺序严格递增、无空洞（除 `truncated`）；`resume` 帧在数据帧之前；
  - `message_end` 后 buffered 归零、`baseSeq` = 该帧 seq；
  - 超上限时 `truncated=true` 且仍能回放已保留部分。
- 验收：`cd bridge && npm test`；`node scripts/test-gate.mjs --only unit`
- 证据脚本：`scripts/evidence/sse-tail-api.mjs`（新，端口 7831）——起桥 + 夹具会话，连 SSE 收到
  `bridge_state` → 断开 → `?since=` 重连断言不重不漏（用 `seq` 序列做集合比较，不需要真实模型）

### S3 · 孤儿接管（≈2.5h）

- 文件：`bridge/src/index.mjs`（`handleSessionOpen` 接管分支：`ADOPT_GRACE_MS=30000`、先 release 再 own、
  `adopted` 字段、`engine_adopted` 日志）、`bridge/src/engines.mjs`（`adoptable(sessionFile,{now,graceMs})`）、
  `bridge/test/engines.test.mjs`（接管/拒接管矩阵）
- DoD：
  - 无 SSE ≥30s + 同会话 → 200 `adopted:true`，池内引擎数**不增**、owner 变更、`extra.claim` 不变；
  - 有 SSE / <30s / 不同会话 / 本客户端引擎忙碌 → 409 或 503，语义与今天一致；
  - 接管后旧引擎记录不残留（无重复 pid、shim 目录不增）。
- 验收：`cd bridge && npm test`；`node scripts/test-gate.mjs --only unit,multi`
- 证据脚本：`scripts/evidence/background-continue-api.mjs`（新，端口 7831，`PI_SHELL_IDLE_MS=3000`）：
  无 SSE 打 prompt → 等 8s → `health.engines[0].state==="streaming"` 且未被回收 → 新 client `open` 同会话 →
  `adopted:true` + 引擎数 1 → 另一条**有 SSE 的** client `open` 同会话 → 409。
  需要可用模型（同 `m0.mjs` 口径），**V-1/V-2 在这里一并取证**。

### S4 · 前端真相 + E2E（≈2h）

- 文件：`web/src/column.js`（`lastSeq` 跟踪、`?since=`、`resume` 处理、`needsAuthoritativeReload`、
  `visibilitychange` 重连、会话身份守卫）、`web/src/main.js`（关列文案）、
  `scripts/test-gate.mjs`（登记 `bg` 套件）、`scripts/evidence/background-continue-ui.mjs`（新，端口 7832）
- DoD（E2E）：headless Edge 发长任务 → 关掉标签（`Target.closeTarget`）→ 等 > idle 窗口 →
  新开页 → 会话列表点开该会话 → 断言：接管成功（无 409 提示）、文本与"实际生成内容"一致、
  条目数无重复、`health.engineCount===1`、资源面板显示 streaming 且可一键释放。
- 验收：`node scripts/test-gate.mjs --only bg`；回归 `--only unit,multi,mobile`
- 停点：E2E 若因模型抖动超时 >2 次，改为「两次运行取一次通过 + 附日志」并上报（不静默改判据）。

---

## 7. 不变量与回归清单（违反即回退）

| # | 不变量 | 怎么验 |
|---|---|---|
| I1 | **有活跃标签占用同一会话 → 仍然 409**（不因接管而放宽） | `node scripts/evidence/parallel-ui.mjs` P6、`multi-column-ui.mjs` P5 必须 PASS |
| I2 | 同一 clientId 被新标签顶掉，旧 tab 后续请求仍 409 | `bridge/test/engines.test.mjs` 的 `touchTab` 用例 |
| I3 | streaming 中 **新建会话 / 改 MCP / 切工作区** 仍拒绝（409/503） | `bridge/test/*` + `restart-ui.mjs`、`new-session-ui.mjs` |
| I4 | 显式 `abort` / `release`（资源面板）**立即生效**，不被 pin 保护 | `engines-resource-ui.mjs` |
| I5 | 断线补齐**不重复、不乱序**（回放起点在落盘点之后；entries 容器在 live 容器之前；settle 后权威重载） | `background-continue-ui.mjs` 的条目计数断言 + 内容顺序断言 |
| I6 | 移动端无新增横滚/安全区回归；列数上限 3、引擎上限 4 不变 | `mobile-ui.mjs`、`layout-split-ui.mjs` |
| I7 | MCP shim 只在引擎真正 `release` 时删；接管不重建 shim、不泄漏临时 agentDir | `engines.test.mjs` + `mcp-toggle-ui.mjs` |
| I8 | 断线/重连不重发 prompt；超时只代表回执超时（03 §10） | `m0.mjs` 的 disposition/超时断言 |
| I9 | 资源面板字段口径不撒谎（`state`/`live`/`idleSec`） | `engines-resource-ui.mjs` |

---

## 8. 待验证项（V）

| # | 待验证 | 怎么验 | 影响 |
|---|---|---|---|
| V-1 | SIGTERM 时 pi 是否会把半条 assistant 落盘（读码推断为"否/竞态"） | 夹具会话 + 长任务 → 等 idle-sweep 杀 → 读 jsonl 找末条 entry | 决定 C 兜底的成色；也决定"已生成内容会保留"这句文案是否成立 |
| V-2 | 长回合中桥不发任何请求，pi 自身是否会被空闲机制打断 | S3 证据脚本里跑一个 >2×idle 的回合 | 若被打断，pin 需要额外的 keepalive RPC |
| V-3 | 回放的 `tool_execution_start` 能否绑定到（尚未落盘的）assistant 富渲染工具行 | S2 证据脚本 + UI 截图 | 决定工具行是"独立展示"还是"就地绑定" |
| V-4 | 手机 suspend 后 EventSource 重连现实行为（iOS Safari / Android Chrome），3 次上限是否过早 | 手机手工 + 日志 `sse_open/sse_close` 计数 | 决定 S4 的 `visibilitychange` 策略是否够 |
| V-5 | 接管竞态：旧页网络抖动 30s 后回来 → 409；确认不存在"prompt 发进空会话"的路径 | S3 证据脚本 + 前端守卫单测 | 决定 `ADOPT_GRACE_MS` 取值 |
| V-6 | 单个 `tool_execution_update` 大输出下的 2MB 尾巴上限体验（截断提示是否够清楚） | 长 `bash` 输出夹具 | 决定上限默认值 |
| V-7 | 4 条孤儿流式引擎时新开列 → 503 的文案/可恢复性是否可接受 | 手工 + `MAX_ENGINES=4` | 决定 §9 D2 |
| V-8 | 后台回合若恰在等扩展权限确认，10s 无客户端即 `cancelled:true`（F30）——这一轮会以取消收场 | S3 证据脚本 + 扩展夹具 | 决定是否另开一条「后台期间延长确认窗口/发通知」 |

---

## 9. 自行决定与待回填参数（**不是**决策点）

> 按三条判据（改范围/预算/验收口径 + 不决定就无法继续 + 文档无既定答案）逐条对过：
> 下面两项都是「**由需求原话推导出的取舍**」和「**文档未定值的实现参数**」——前者文档已给边界
> （PLAN §2-1「回来时补齐输出」），后者按 §2 取保守值并标「待回填」。因此本任务卡**决策点 = 无**，
> 两项都记为台账决定（Owner 若不同意可直接改这一节，不需要回滚任何代码）。

### D1（已选）：回来时**自动接管**仍在后台跑的那一轮

- 选择：**自动接管**——`POST /api/session/open` 命中「同会话 + 无 SSE ≥ `ADOPT_GRACE_MS`(30s)」的孤儿引擎时，
  先 `release` 本客户端那条空闲空引擎，再 `pool.own(E, clientId)`，返回 `adopted:true`，前端重连 SSE 补尾巴。
- 被否的选项：
  - 手动（409 时给「接管」按钮）：S3 少 ≈0.5h，但"回来补齐"多一步，且 409 文案要再分叉；
  - 不接管：0h，但**不满足原话**（回合跑完前回来只能看到 409）。
- 依据：PLAN §2-1 要求"回来时补齐输出"；「活跃占用者仍 409」由 I1 保证（`parallel-ui` P6 必须 PASS）。
- 风险兜底：V-5（旧页抖动回来 → 409 只读，不存在把 prompt 发进空会话的路径）+ S4 会话身份守卫。

### D2（已选，**待回填**）：孤儿流式引擎计入 `MAX_ENGINES`

- 选择：**计入**（`isAlive()` 认 `state==="streaming"`；4 条孤儿 = 新列 503，文案沿用现有"已达并行上限"）。
- 被否的选项：不计入 + 孤儿上限 2（需新增"按最老 abort"的静默中止路径，0.5h + 告知文案）。
- 依据：不新增"静默 kill 用户回合"的路径；容量口径先诚实。
- **待回填**：若 V-7 实测"4 条孤儿 → 503"体验不可接受，再改成本项（属参数调整，不改 §6 的切片边界）。

---

## 10. 附录：本次取证用到的命令

```js
// /tmp/sweep-probe.mjs（F4 的探针；直接 import engines.mjs，不启桥、不占端口）
import { EnginePool, Engine } from "file:///C:/Users/user/pi-shell/bridge/src/engines.mjs";
let now = 1_000_000;
const stopped = [];
const pool = new EnginePool({ create: (id) => new Engine({ id, owner: id }), max: 4, idleMs: 60_000, now: () => now, log: () => {} });
const e = new Engine({ id: "tab#c1", owner: "tab#c1", now });
e.extra = { sseClients: new Set(), claim: "C:/s/session.jsonl" };
e.rpc = { state: "streaming", stop: async (r) => stopped.push(["stop", r]), lastGetState: { sessionFile: e.extra.claim } };
pool.add(e);
e.lastSeenAt = now - 61_000;
now += 5_000;
console.log(JSON.stringify({ removed: pool.sweep(now), stopped, poolSize: pool.size, isAlive: pool.isAlive(e, now) }));
```

```bash
# F3/F4：sweep 不看 streaming（上面那段直接 node 跑）

# 现状代码定位
grep -rn '"abort"' bridge/src/*.mjs                 # 唯一调用点 index.mjs:2033
grep -n "\.touch(" bridge/src/index.mjs             # 4 处：SSE open + 操作型端点
grep -rn "engine/release" web/src/                  # 只有资源面板调用
grep -rn "SIGTERM" pi:dist/modes/rpc/rpc-mode.js    # 275-288 / 592

# 既有关键证据脚本（本设计未改动、作为回归基线）
node scripts/evidence/parallel-ui.mjs               # 409 语义
node scripts/evidence/multi-column-ui.mjs           # 同会话 409
node scripts/evidence/engines-resource-ui.mjs       # release / 资源面板口径
```
