# 06 · 追溯矩阵与测试细则

版本 **v1.0.0**（2026-11-12，回填门禁套件与证据脚本；§1/§2/§3 原有条目未改口径）

---

## 1. 追溯矩阵

| 需求 | 阶段 | 任务 | 验收手段 | 备注 |
|---|---|---|---|---|
| F-00a 启动桥 | M0 | T-02, T-03 | `/api/health` 字段比对 | 版本 1.5.0 |
| F-00b 流式 | M0 | T-05 | 首字 ≤3s；增量 ≥2 次 | 手记时 |
| F-00c 中止 | M0 | T-05 | ≤2s 停写；`isStreaming` ≤5s | — |
| F-01 会话列表 | M1 | T-06, T-07 | A-01 | title 规则见 03 §7 |
| F-02 会话渲染 | M1 | T-08 | 03 §14.1 清单（样本 A + B） | 12 项 |
| F-03 发送（文本/图片/文件注入） | M1 | T-09 | 各一次，复述特定字符串 | `@` 不适用 |
| F-04 中止/steer/followUp/清队列 | M1 | T-09 | 回归 #2 | Esc = clear+abort |
| F-05 模型与思考级别 | M1 | T-10 | A-03（自动 + 人工） | 直通 + TUI 抽查 |
| F-06 命令面板 | M1 | T-11 | A-05 | 三类形态 |
| F-07 扩展对话框桥 | M1（可顺延） | T-12 | A-06 | — |
| F-08 通知桥 | M1（可顺延） | T-12 | 回归 #8 | **在 G1 或 G2 门内** |
| F-09 工作区切换 | M1 | T-15 | A-07 | 需先发消息 |
| B-07 新会话（`POST /api/session/new` + 头部按钮） | M1 | T-08 | `scripts/evidence/new-session-ui.mjs`（N0–N7） | 空会话不落盘（H-5）；streaming 中 409 且不清空对话区 |
| F-16 断线重连 | M1 | T-13 | A-08（游标补齐、无重复） | — |
| F-10 分支 | M2 | T-16 | 新文件 + `get_state.sessionFile` 变化 | entryId 必填 |
| F-11 文件树与预览 | M2 | T-17 | 越界 403 + 渲染正确 | 只读 |
| F-12 Git diff | M2 | T-18 | 与 `git diff --stat` 一致 | 只读 |
| F-13 会话过滤 | M2 | T-20 | 命中/不命中各 1 例 | 标题+摘要 |
| F-14 Token/成本 | M2 | T-19 | 与 `get_session_stats` **完全一致** + TUI 人工核对一次 | 不做自造复算 |
| F-15 桌面快捷方式 | M2 | T-22 | 双击可启动；卸载手删 | 无自启 |
| F-17 偏好与懒加载 | M2 | T-17, T-21 | 刷新保持；500 消息 ≤2s | — |
| B-08 新会话选目录（`POST /api/session/new {cwd}`） | v1.0.0 | — | `scripts/evidence/new-session-dir-api.mjs` + `new-session-dir-ui.mjs` | 先校验再停进程；换目录只重启本列；非法 cwd 拒绝且不落盘 |
| B-09 顶栏跟随会话（`GET /api/session/view?client=` + `models/commands?client=`） | v1.0.0 | — | 门禁 `sessionView`（`session-view-api.mjs`）+ `sessionHeader`（`session-header-follow-ui.mjs`）；`cwd-truth-api.mjs` | 顶栏唯一事实源；cwd 取会话 header 回写值；未知 client：`session/view` 404、`models/commands` 回落主引擎 |
| B-10 后台不中断（S1 pin / S2 尾巴回放 / S3 孤儿接管 / S4 前端真相） | v1.0.0 | — | 门禁 `sseTail`（`sse-tail-api.mjs`）+ `bgContinue`（`background-continue-api.mjs`）+ `bgUi`（`background-continue-ui.mjs`） | 尾巴总上限 2MB / 单帧 512KB；先发 `resume` 帧；`message_end` 是落盘点；孤儿接管先 release 再 own |

**非功能**

| 需求 | 任务 | 手段 |
|---|---|---|
| N-01 | T-02 | `netstat -ano \| findstr 7788` |
| N-02 | T-06 | 合成 1000 条 + `PI_SHELL_SESSIONS_DIR`（同时作为 `--session-dir`） |
| N-03 | T-14 | 每 30 分钟记录 bridge RSS 与标签内存，M1 收尾 |
| N-04 | T-14 | 代码审查 + 快照对照白名单（`settings.json`/`models-store.json`/`state/`/`sessions/`/`trust.json`/`logs/`） |
| N-05 | T-14 | 断网 + Network 面板 |
| N-06 | T-03 | kill 子进程 |
| N-07 | T-14 | 正则扫描日志 |
| N-08 | T-14 | 中文/空格 cwd；`--session-dir` 含空格路径；`PI_SHELL_EXTRA_ARGS` 用 **JSON 数组**形式携带含空格路径（如 `["-e","C:/…/my ext/a.ts"]`） |
| N-09 | T-13 | kill node → 横幅 + 重试 |

---

## 2. 手工回归（带阶段与门禁）

| # | 阶段 | 步骤 | 期望 | 门禁 |
|---|---|---|---|---|
| 1 | M1 | 新会话发"你好" + 一张图 | 回复含图片理解；页面显示图片 | G1 |
| 2 | M1 | 回答中"打断"；再"排队" | 打断 ≤2s 停；排队在当前回合后执行 | G1 |
| 3 | M1 | 打开样本 A（工具密集） | 03 §14.1 清单 ①~⑨⑪⑫ 全中 | G1 |
| 3b | M1 | 打开样本 B（含图片） | 清单 ⑩ 图片渲染通过 | G1 |
| 4 | M1 | 切走再切回 | 折叠状态与滚动位置保持 | G1 |
| 5 | M1 | 切换模型与思考级别 | `get_state` 立即反映 | G1 |
| 6 | M1 | 执行任一扩展命令 | disposition=handled；页面不卡在 streaming | G1 |
| 7 | M1 | 用中文关键字过滤会话列表 | 命中标题或摘要 | G1 |
| 8 | M1* | 触发 `notify`/`setStatus`/`setWidget` | toast / 状态条 / 编辑区上块；传空可清除 | **G1（未止损）或 G2（止损后）** |
| 9 | M1 | kill bridge 后重启 | ≤15s 恢复或出现重试按钮且点击恢复；无重复条目 | G1 |
| 10 | M2 | fork 与 clone | 新文件 / 条目增加 + 树出现分支 | G2 |
| 11 | M2 | 预览 md 与图片；`..\..\Windows\win.ini` 试探 | 正常渲染；越界 403 | G2 |
| 12 | M2 | 改文件后看 diff | 与 `git diff --stat` 一致 | G2 |

\* 第 8 条必在某一道门禁内，不允许悬空（见 04 §4/§5）。

---

## 3. 照妖镜规格（`scripts/smoke-check.mjs`）

| ID | 自动化 | 判定 | 失败输出 |
|---|---|---|---|
| A-01 | 全自动 | 分组数 == **含有 `.jsonl` 的目录数**；至少一个分组；四项字段非空 | 实际/期望、空字段项 |
| A-02 | 全自动 | `get_commands` 含本机扩展注册的命令；`--no-extensions` 实例中该命令消失 | 两实例命令集差 |
| A-03 | 自动 + 人工 | `/api/models` 与 `get_available_models` 集合相等；人工抽查 3 项与 TUI `/model` 一致 | 差集 / 抽查截图 |
| A-04 | 全自动 | 发送后 5s 出现新 `.jsonl`；最后一条 assistant 的 **entry id** 在该文件中 | 缺失 id |
| A-05 | 全自动 | 命令集合非空（含本机配置的扩展命令/技能/提示词模板） | 命令数 |
| A-06 | 半自动 | `-e` 加载 `test-ext/select-demo.ts` → 触发 `select` → 回执后 pi 收到值 | 30s 超时 |
| A-07 | 全自动 | 切到任一已存在目录 → 新建会话 → **发送一条消息** → 文件落在对应 `--<编码 cwd>--` | 实际路径 |
| A-08 | 半自动 | kill bridge → 重启 → ≤15s 恢复或重试可用；`get_entries?since` 补齐后条目无重复 | 耗时 / 重复项 |

约定：A-04/A-07 会真实产生会话文件；其余只读。

---

## 3b. 首启黄金路径（`scripts/evidence/first-load.mjs`，B1~B7）

> 存在理由：v1.0.0 的 A 类断言只看 `el.hidden`，看不到「属性改了、画面没变」。
> 本节的唯一口径是 **`getComputedStyle(el).display`**，且所有交互用 **CDP 真实鼠标/键盘事件**（`Input.dispatchMouseEvent` / `dispatchKeyEvent`），
> 并用 `document.elementFromPoint` 证明点击命中了目标元素（没被遮罩吃掉）。

| ID | 判定 | 反例特征 |
|---|---|---|
| B0 | 页面可交互：`#version` 已回填且非 `—`，`#state` 为 idle | 桥没起来 / JS 报错 |
| B1 | 首屏 16 个浮层（settings/palette/modal/panel/toast/reconnect/attach-*/notice/widget/session-bar/stats/ext-status/behavior/search-clear/panel-action）`display` 全为 `none` | 缺 `[hidden]` 规则 → 多个 `shown` |
| B1b | 输入框中心 `elementFromPoint` 落在 composer 内；输入框/sidebar 非 `display:none` | 遮罩挡住主界面 → `hit=false` |
| B2a | 真实点击 `#open-settings` → `#settings` 为 `shown` | 点击被遮罩吃掉 → `hit=false` |
| B2b | 真实点击 `#settings-close` → `#settings` 为 `none` | `hit=true` 但 `display=shown`（**只改属性的典型症状**） |
| B3a/B3b | Ctrl+K → `#palette` `shown`；Esc → `none` | — |
| B4 | `Page.reload` 后 B1 仍全 `none` | 刷新后依旧被遮 |
| B5 | `#reconnect`（断线横幅）`none` | 事件流没连上 |
| B6 | 无 `Runtime.exceptionThrown` / 控制台 `error`（favicon 404 豁免） | — |
| B7 | 桥日志里除 `favicon.ico` 外无 404 | 静态资源/接口路径错 |

**Composer 键盘路径（`scripts/evidence/composer-e2e.mjs`，C1~C5，第五批改回终端习惯）**：Enter 只换行不发送 / Shift+Enter 换行 / Ctrl+Enter 发送 / 输入法组词不发送（`isComposing`）/ 一轮结束后 DOM 只有一条用户气泡且无空 system 块。
> 存在理由：v1.0.0 的 F-03 只用 `requestSubmit()` / `button.click()` 验证，所以「Enter 不发送」「用户气泡重复」「空 system 块」三个缺陷全绿通过。

**反向验证（必须做）**：临时删掉 `[hidden]{display:none !important}` 再跑，应得 **4/11 PASS** 且 B2b 为 `hit=true display=shown`。
若删了规则仍然全绿 → 说明断言又回到了属性层，测试无效。

---

## 3c. 测试门套件（`node scripts/test-gate.mjs --full`，18 套件）

> 发版主门：`--full` 按 `SUITES` 顺序全跑，任一 FAIL 不发版；迭代期用 `--only <名>` 定点复跑。
> 环境口径：测试模型由 **`scripts/model-config.mjs`** 统一解析（会话顶栏所选模型 > `scripts/model.json`），`test-gate` 自动注入 `PI_SHELL_PROVIDER` / `PI_SHELL_MODEL`，**不要手工设**；MCP 一律用空配置（`PI_SHELL_MCP_CONFIG` 指向临时文件），会话目录用 `PI_SHELL_SESSIONS_DIR` 夹具，测试桥不占 7788。

| # | 套件 | 脚本 | 端口 | 覆盖点 | 在 `--full` 内 |
|---|---|---|---|---|---|
| 1 | `unit` | `cd bridge && npm test` | — | 桥单测，**216 例**（v1.0.0 实测） | 是 |
| 2 | `firstLoad` | `first-load.mjs` | 7794 | 首启黄金路径 B0–B7（见 §3b） | 是 |
| 3 | `composer` | `composer-e2e.mjs` | 7810 | C1–C5 键盘路径 / 气泡 / 滚动不抢 | 是 |
| 4 | `origin` | `origin-ui.mjs` | 脚本默认 | 会话来源分类（user / agent / test） | 是 |
| 5 | `del` | `delete-session-ui.mjs` | 脚本默认 | 真删除 + 可撤销备份 | 是 |
| 6 | `treeFlat` | `tree-flat-ui.mjs` | 脚本默认 | 扁平树渲染 + 折叠阈值 | 是 |
| 7 | `treeView` | `tree-view-ui.mjs` | 脚本默认 | 树视图展开上限 | 是 |
| 8 | `models` | `models-config-ui.mjs` | 脚本默认 | 模型只列已配置 | 是 |
| 9 | `b8` | `ui-b8-shots.mjs` | 脚本默认 | B8 视觉 / 顶栏收敛 + 截图 | 是 |
| 10 | `mobile` | `mobile-ui.mjs` | 脚本默认 | 窄屏 390 / 768 / 1440 | 是 |
| 11 | `multi` | `multi-column-ui.mjs` | 脚本默认 | 多列并行 + 引擎上限 | 是 |
| 12 | `mcp` | `mcp-toggle-ui.mjs` | 7898 | MCP 按列勾选 + cwd 规则 | 是 |
| 13 | `layout` | `layout-split-ui.mjs` | 脚本默认 | 分栏 / 侧栏拖拽 | 是 |
| 14 | `sessionView` | `session-view-api.mjs` | **7834** | 顶栏跟随会话——`/api/session/view?client=` 为唯一事实源，`models/commands` 按 client 取引擎 | 是 |
| 15 | `sseTail` | `sse-tail-api.mjs` | **7831** | 尾巴回放——`?since=` 补齐未落盘帧、首个数据帧是 `resume`、无重复、`message_end` 是落盘点 | 是 |
| 16 | `bgContinue` | `background-continue-api.mjs` | **7831** | 后台不中断 S1–S3——流式中 pin 不回收、孤儿引擎接管（先 release 再 own）、同会话冲突 | 是 |
| 17 | `bgUi` | `background-continue-ui.mjs` | **7836** | S4 前端真相——`lastSeq` 重连、`resume.truncated` 提示、settle 后按权威记录重载 | 是 |
| 18 | `sessionHeader` | `session-header-follow-ui.mjs` | **7835** | 列头跟随——切列时顶栏（模型 / 思考级别 / MCP / 目录）跟随当前列会话，cwd 与 `session/view` 一致 | 是 |

> **模型注入**：所有 E2E 套件走 **`scripts/model-config.mjs`** 统一注入（会话顶栏所选模型 > `scripts/model.json`），**依赖真实模型出字**。模型不可用会让套件假失败：`402 Insufficient Balance` 时引擎 471ms 返回空回合，表现为 `composer` / `multi` FAIL（不是代码回归）。排查先看 `.dev/logs/gate-*.log` 里的该套件末尾 4 行输出，再看 `402` / 余额。
- 端口列的 5 个 **后加套件**端口来自 `scripts/test-gate.mjs` 的 `SUITES`（`test-gate` 用 `PI_SHELL_PORT` 注入）；其余未列端口的套件用脚本自身默认值，**都不占 7788**。

- 每个 E2E 套件自报 `N/N PASS`；逐套件的实测数字以**当次门禁日志**为准（`.dev/logs/gate-*.log`；v1.0.0 实测：`unit` 216/216）。
- 门禁套件与独立证据脚本是**同一批脚本**：`sessionView` / `sseTail` / `bgContinue` / `bgUi` / `sessionHeader` 既在门禁内，也可单跑取证；`new-session-dir-api|ui`、`cwd-truth-api`、`tree-graph-ui`、`turn-changes-ui`、`tab-independence-ui`、`engines-resource-ui`、`parallel-ui`、`restart-ui` 等按需跑，不在发版主门内。

---

## 4. 测试数据

| 用途 | 方式 |
|---|---|
| 1000 条会话（N-02） | 合成 JSONL 到临时目录；启动桥设 `PI_SHELL_SESSIONS_DIR`（桥会同时把它作为 `--session-dir` 传给子进程，读写一致） |
| 长会话（F-17） | 合成 500 条消息，同上 |
| 渲染样本 A（工具密集） | `2026-10-30T05-11-50-210Z_*.jsonl`（78 消息 / 37 工具条目） |
| 渲染样本 B（含图片） | `2026-10-23T01-59-42-143Z_*.jsonl`（5 条含图片消息） |
| 中文 cwd | `~/pi-shell-测试项目\`（脚本自建） |
| 含空格 cwd | `~/pi-shell test project\`（脚本自建） |

---

## 5. 测试缺口

| 缺口 | 原因 | 处理 |
|---|---|---|
| 双端同开 | 无锁，无法检测 | 提示 + 备份（03 §9） |
| 页面关闭时未回执弹窗 | 协议无取消通道 | 已知限制 |
| 桥自动拉起 | 不做 daemon | 横幅 + 手动重试 |
| 扩展 `custom()`/`setFooter` 等 | RPC 不支持 | 列入 03 §16 |
| macOS / Linux | 目标平台仅 Windows | 不做 |
| 多标签一致性 | v1 不保证 | 仅提示 |
