# 00 · 名词解释

写给"不想读技术文档但要知道自己在批什么"的读者。每条先给**一句人话**，再给**技术定义**。

---

## 1. pi / TUI

**人话**：pi 就是你平时在终端里用的那个 AI 助手程序。TUI = 它在终端里画出来的那个全屏界面。

**技术**：`@earendil-works/pi-coding-agent` 1.5.0，交互模式运行在终端（Terminal UI）。它负责：调模型、跑工具（read/write/edit/bash）、存会话、加载扩展与技能。

---

## 2. 会话（session）

**人话**：你和 AI 的一次完整对话记录，存成一个文件，关掉再开还能接着聊。

**技术**：`~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`，一行一个 JSON 条目（header、消息、工具调用、分支）。本机当前有 6 个工作目录的会话集合（随使用增长）。

**重要事实**：pi **不对会话文件加锁**（实测 1.5.0），所以任何工具都无法准确判断"这个会话是不是正被终端占用"。双端同写的实际后果是：追加交错出现半行（扫描时会被静默跳过）、分支分裂、双份压缩摘要；整文件重写只发生在两种罕见情形（打开"存在但解析为空"的显式路径会话、会话版本迁移）。本项目的对策是"打开前强制提示 + 备份"，不是自动检测。

---

## 3. 扩展（extension）与技能（skill）

**人话**：给 pi 加功能的插件（改提示词、加命令、加工具），装在 `~/.pi/agent` 里的那批（取决于你的配置）就是本壳要复用的东西。

**技术**：`~/.pi/agent/extensions/*.ts`，通过 pi 的扩展 API 注入系统提示、注册工具与 slash 命令、调用 `ctx.ui` 弹窗。技能的入口是 `/skill:名字`。

---

## 4. RPC（本项目的地基）

**人话**：pi 内置的一种"**可以被别的程序遥控**"的运行模式。你不用敲键盘，而是让另一个程序给它发指令："发这句话"、"停"、"换个模型"，pi 用一行行 JSON 回你："开始回答了"、"这里出来 3 个字"、"工具调完了"。

**技术**：`pi --mode rpc`。stdin 收命令（每行一个 JSON），stdout 发事件与响应（每行一个 JSON，严格按 LF 分行）。共 33 个命令，例如 `prompt` / `abort` / `set_model` / `get_commands` / `extension_ui_response`。当前 pi 1.5.0 与 1.3.0 的命令集**完全一致**（已实测 diff 无差异）。

**为什么用它**：
1. 它跑的就是你**已安装的官方 pi**（你的扩展、模型、会话全在）
2. 它是**独立子进程**，网页壳崩了不会拖死你的 TUI
3. 它是唯一能把**扩展弹窗**（`ctx.ui.select/confirm/input/editor`）转给网页的通道

---

## 5. 桥（bridge）

**人话**：中间那个**翻译 + 调度**的小程序。浏览器只会说 HTTP，pi 只会说 JSONL，桥蹲在中间两边转，同时负责：启动/重启 pi、给每个请求编号、把事件推给网页、网页断开时收拾残局。

**技术**：本项目的 `bridge/`，Node ESM，零第三方运行时依赖。监听 `127.0.0.1:7788`，对外暴露 23 个 HTTP 端点（M0 4 个 / M1 12 个 / M2 7 个，见 03-design.md §5），对内用 `node + <cli.js>` 直连启动 `pi --mode rpc`（Windows 下直接 `spawn("pi")` 会 ENOENT、`spawn("pi.cmd")` 会 EINVAL，已实测；`.cmd` 退路不实现）。

**它不是什么**：不是第二套 agent、不改 pi 的任何文件、不代理模型请求（模型请求仍由 pi 直接发给你配置的 provider）。

---

## 6. SSE（Server-Sent Events）

**人话**：服务器单方向不停往浏览器推消息，像直播弹幕。用来把"AI 正在一个字一个字往外蹦"实时显示出来。

**技术**：`GET /api/events`，`Content-Type: text/event-stream`，每条 `data: {...}\n\n`。比 WebSocket 简单（浏览器原生支持、自动重连、无需握手库），本项目只需要服务端→客户端单向流。

**代价**：浏览器→服务器的动作必须另走普通 HTTP POST（本项目即如此，命名 `/api/*`）。

---

## 7. JSONL

**人话**：一行一个 JSON 的文本格式，方便边收边处理。

**技术**：本项目所有与 pi 的通信、以及 pi 的会话文件都使用它。解析必须**只按换行符 `\n` 切分**，不能用 Node 的 `readline`（它会把 Unicode 的分隔符也当换行，导致消息被切坏）。

---

## 8. 请求-响应配对（id）

**人话**：你一次问好几件事，得知道哪个回复对应哪个问题。

**技术**：每个命令带 `{"id": "..."}`，pi 回的 `{"type":"response","command":"...","success":true/false,"data":{...}}` 带同一个 id。桥维护一张"待回复"表，匹配后回给对应 HTTP 请求。

---

## 9. 事件（event）

**人话**：pi 在干活过程中主动报告的事情，比如"开始回答"、"输出了一段文字"、"要调工具了"、"跑完了"。

**技术**：`agent_start` / `turn_start` / `message_start` / `message_update`（内含 `text_delta`、`thinking_delta`、`toolcall_*`）/ `message_end` / `turn_end` / `agent_end` / `agent_settled`，另有工具执行、压缩（compaction）、重试相关事件。`message_update` 是**增量**的，需要按 `contentIndex` 自己拼。

---

## 10. token / 成本

**人话**：AI 按字数（token）计费，这次对话花了多少。

**技术**：`get_session_stats` 返回 usage 与成本；`message_update.usage` 也会带累计用量。

---

## 11. 扩展 UI 桥

**人话**：扩展有时候要弹窗问你（"允许跑这条命令吗？"）。在本项目里，这些弹窗从终端**搬到网页**显示，你点完再送回去。

**技术**：pi 在 RPC 模式下把 `ctx.ui` 调用转成 `extension_ui_request`（`select`/`confirm`/`input`/`editor` 需回应；`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` 单向推送）。桥转发给前端，前端回 `extension_ui_response`（带同一 `id`）。

**能力上限（重要）**：`custom()`、`setFooter()`、`setHeader()`、`setWidget(组件)`、主题相关接口在 RPC 模式下是**降级或无效**的。也就是说，那些"在终端里画自定义面板"的扩展功能，在这个壳里不会原样出现。

---

## 12. 照妖镜（验收探针）

**人话**：八条一测就知道"这壳是不是真长在我的 pi 上"的检查。

**技术**：见 02-prd.md §6 的 A-01 ～ A-08。判定"扩展真的生效"的核心一条是 **A-02**：`get_commands` 里会出现你本机扩展注册的命令，并且用 `--no-extensions` 启动时它会消失。
> 注意：写在全局上下文文件（如 `~/.pi/agent/CLAUDE.md`）里的哨兵**不能**作为扩展探针——扩展全禁用时它依然生效。

---

## 13. 工作区（cwd）

**人话**："你现在在哪个项目目录里干活"。它决定新会话落到哪个分组，也决定 AI 默认能看见哪个项目的文件。

**技术**：pi 子进程的启动目录。RPC **没有** `set_cwd` 命令，`new_session` 也不接受 `cwd` 参数（实测 1.5.0），因此换工作区只能**重启子进程**（本项目 `POST /api/workspace`，代价 1–2 秒）。打开旧会话不受影响：`switch_session` 会采用会话自身记录的 cwd。

---

## 14. 扩展命令 / 技能 / 提示词模板（三者名字不同）

| 类型 | 来源 | 调用形态 | 名字示例 |
|---|---|---|---|
| 扩展命令 | 扩展 `registerCommand` | `/<命令名>` | `my-status`（来自你的某个扩展） |
| 技能 | `~/.pi/agent/skills/<name>` | `/skill:<name>` | `skill:ingest-video` |
| 提示词模板 | `~/.pi/agent/prompts/<name>.md` | `/<name>` | `write-review` |

`get_commands` 返回的 `name` 即为上表右列的形态，前端不要自己拼接。

---

## 15. 条目（entry）与消息（message）

**人话**：一"轮"对话在磁盘上不是一条记录，而是若干"条目"：模型切换、思考级别切换、你的消息、AI 的回复、工具结果……每条都有自己的编号。

**技术**：jsonl 每行是 `{type,id,parentId,timestamp,message?}`。**`id` 在条目层级，`message` 对象里没有 `id`**（只有 `responseId` 等）。所以"按 id 对账 / 按 id 去重 / 断点补齐"都必须用条目 id，接口是 `get_entries`（支持 `since` 游标）。这是 A-04 与断线补齐的依据。
