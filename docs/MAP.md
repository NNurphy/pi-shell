# MAP · 「我要改 X，动哪里」

> 适用范围：pi-shell v1.0.0
> 最后更新：2026-11-06
> 维护者：开发 Agent（下一任）

用法：先跳到"先读"章节确认契约，再改文件，最后跑对应 evidence（命令统一为 `node scripts/evidence/<file>`，在项目根执行）。
所有 evidence 脚本都自带断言并以退出码表示结果（0 = 全过）。

| 我要改… | 先读 | 改这些文件 | 跑这个验证 | 涉及验收 |
|---|---|---|---|---|
| 会话列表的字段/排序/摘要 | 03 §7 | `bridge/src/sessions.mjs`、`web/src/list.js` | `m1-sessions.mjs` | A-01 |
| 会话列表虚拟化/折叠/空错态 | 03 §7、§12 | `web/src/list.js`、`web/src/style.css` | `m1a-list-render.mjs` | F-01 |
| 打开会话 / 两段式接管 | 03 §5 §8 §12 | `bridge/src/index.mjs`（`handleSessionOpen`/`attachSession`）、`bridge/src/sessions.mjs`（`readSessionEntries`）、`web/src/main.js` | `m2a-branch-files.mjs` | F-09、F-17 |
| Markdown / thinking / 工具折叠 | 03 §14.1 | `web/src/markdown.js`、`web/src/render.js` | `m1a-list-render.mjs` | F-02 |
| 实时流 / 富渲染替换 | 03 §4 | `web/src/stream.js`、`web/src/main.js`（`richifyMessage`） | `m1b-composer-models.mjs` | F-02、F-03 |
| 发消息 / 中止 / 队列 / 图片 / 文件注入 | 03 §4 §8 | `web/src/main.js`（Composer、`abortWithQueueRestore`）、`bridge/src/index.mjs`（`handlePrompt`/`handleAbort`/`handleClearQueue`） | `m1b-composer-models.mjs` | F-03/F-04 |
| 扩展弹窗 / 通知 / 自动取消 | 03 §16-2、H-15 | `bridge/src/index.mjs`（`handleExtUiResponse`、`pendingExtDialogs`）、`web/src/main.js`（`handleExtRequest`/`showExtDialog`）、`test-ext/select-demo.ts` | `m1c-ext-reconnect.mjs` | F-07/F-08、A-06 |
| SSE 重连 / 游标补齐 / resync | 03 §10 | `web/src/main.js`（`scheduleReconnect`/`backfill`）、`bridge/src/index.mjs`（`handleSessionEntries`） | `m1c-ext-reconnect.mjs` | F-16、A-08 |
| 模型 / 思考级别 | 03 §5 | `bridge/src/index.mjs`（`handleModels`/`handleSetModel`/`handleThinkingLevels`/`handleSetThinking`）、`web/src/main.js` | `m1b-composer-models.mjs` | F-05、A-03 |
| 命令面板 | 03 §5 | `bridge/src/index.mjs`（`handleCommands`）、`web/src/main.js`（`paintPalette`） | `m1b-composer-models.mjs` | F-06、A-05 |
| fork / clone / 会话树 | 03 §5、H-5 | `bridge/src/index.mjs`（`handleFork`/`handleClone`/`handleTree`、`afterBranchChange`）、`web/src/main.js`（`openTree`/`forkAt`） | `m2a-branch-files.mjs` | F-10、A-10 |
| 文件树 / 预览 / 大小限制 | 03 §5 §11 | `bridge/src/files.mjs`、`web/src/main.js`（`openFiles`/`previewFile`） | `m2a-branch-files.mjs` | F-11 |
| Git diff | 03 §5 | `bridge/src/git.mjs`、`bridge/src/index.mjs`（`handleGitDiff`） | `m2b-git-stats-filter.mjs` | F-12 |
| 成本 / 上下文 | 03 §5 §12 | `bridge/src/index.mjs`（`handleStats`）、`web/src/main.js`（`refreshStats`） | `m2b-git-stats-filter.mjs` | F-14 |
| 列表过滤 | 03 §7 | `web/src/list.js`（`filterLocally`）、`web/src/main.js`（搜索框/防抖） | `m2b-git-stats-filter.mjs` | F-13 |
| 偏好 / 主题 / 密度 / 字号 | 03 §5、§16-11 | `web/src/main.js`（`readPrefs`/`applyPrefs`）、`web/src/style.css` | `m2c-prefs-shortcut.mjs` | F-17 |
| 日志 / 脱敏 / stderr 策略 | 03 §15、H-15、C-05 | `bridge/src/index.mjs`（`log`/`redact`/`PI_SHELL_LOG_FILE`） | `p0-stderr-pipe.mjs`、smoke（N-07） | N-07 |
| 启动方式 / 工作区切换 | 03 §3 | `bridge/src/index.mjs`（`createRpc`/`handleWorkspace`）、`scripts/start-pi-shell.cmd` | `m1d-workspace-g1.mjs` | F-09、G1-6 |
| 协议分帧 / 请求配对 | 03 §1 H-6、§6 | `bridge/src/framing.mjs`、`bridge/src/rpc.mjs` | `cd bridge && npm test` | T-04 |

## 一次改动的标准动作

1. 改代码 → `cd bridge && npm test`（216 例，秒级）。
2. 跑上表对应 evidence（多数 30–120s）。
3. 若改了端点/契约：同步 `docs/03 §5`，并在 PR 描述里附验收证据（验收命令｜原始输出｜PASS/FAIL｜涉及文件）。
4. 若改了判据：先改 `docs/02` 并升版本，**不擅自改验收**。
