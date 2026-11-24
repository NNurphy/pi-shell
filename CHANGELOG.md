# CHANGELOG

> 适用范围：pi-shell 发布记录
> 维护约定：格式 `## vX.Y.Z · YYYY-MM-DD`，只记"能力 / 限制 / 不兼容变更"，细节见 `RELEASE-NOTES.md`。

## v1.1.0 · 2026-11-25

**桌面化 + 超大会话接管修复**：LOGO 图标、一键快捷方式与托盘模式，打开超大历史会话不再超时。

### 能力

1. **LOGO 图标与桌面快捷方式安装器**：`web/favicon.svg` 栅格化为两个 `.ico`（浅色 / 深色背景变体，各含 16/32/48/256 四尺寸；`node scripts/make-icon.mjs` 零 npm 依赖可复现）。`scripts\setup-windows.ps1` 一键创建 / 更新桌面快捷方式：`pi-shell.lnk`（托盘模式入口）与 `重启 pi-shell.lnk`；幂等可重复执行，`-Remove` 一键移除，只动名单里的两个文件。
2. **系统托盘模式（Windows）**：双击快捷方式启动后**无常驻终端窗口**，右下角托盘图标右键控制（打开页面 / 重启 / 停止）；tooltip 实时显示引擎数（如 `引擎 2/4`）；图标随系统浅 / 深色主题自动切换；单实例（已在跑只开页面，不起第二个）；桥崩溃自愈（1s/2s/4s 退避）保留，自愈放弃时托盘气泡提醒。控制台入口 `scripts\start-pi-shell.cmd` 仍保留（调试用）。
3. **超大会话接管修复**：打开超大历史会话时，引擎 RPC 响应（get_entries 把全部 entries 装一行）可超过 JSONL 单行上限旧值 8MiB → 该行被丢弃 → 桥等不到应答 → 30s 超时、接管失败。现在单行上限提高到 **32MiB**（`PI_SHELL_MAX_LINE_BYTES` 可按需再调大；非法值回退默认并记 warn）；「超限丢弃 + `pi_line_skipped` 日志」的保护底线不变。

### 限制（明确不承诺的）

- 托盘模式为 Windows 专属（PowerShell 5.1 + WinForms）；其他平台沿用控制台 / 直接 `node bridge/src/index.mjs`。
- 单行仍超 32MiB 的极端会话依旧无法接管（保护底线），需调 `PI_SHELL_MAX_LINE_BYTES`。

### 测试

- `cd bridge && npm test` → **223/223**（`node --test`，纯夹具，不碰真实 `~/.pi/agent`；本版新增 7 条：32MiB 默认值、`PI_SHELL_MAX_LINE_BYTES` 合法 / 非法 / 超限场景等）。
- 新增证据脚本：[`scripts/evidence/logo-shortcut.mjs`](scripts/evidence/logo-shortcut.mjs)（图标与快捷方式 7 项断言）、[`scripts/evidence/tray-host.mjs`](scripts/evidence/tray-host.mjs)（托盘 8 项断言，夹具端口独立）、[`scripts/evidence/oversize-entries.mjs`](scripts/evidence/oversize-entries.mjs)（4 场景复刻修复）。

## v1.0.0 · 2026-11-18

**首个公开发布**：给本机 pi 编码代理（`@earendil-works/pi-coding-agent`）的浏览器壳。

### 能力

1. **多列会话并行**：同页 1–3 列，每列一个独立 pi 引擎、独立会话、独立 Composer / SSE，可同时生成；引擎上限默认 4（`PI_SHELL_MAX_ENGINES` 可调），60s 空闲回收；标签页身份自愈（复制标签页不抢引擎）。
2. **SSE 断线重连与恢复**：每列一条事件流；断线每 15s 自动重试 + `?since=` / `Last-Event-ID` 回放未落盘输出（默认上限 2MB，超出提示「部分输出未能补齐」）；重连 / 重启桥后自动接回上次会话（桥侧元数据记忆落盘 `<agentDir>/pi-shell-last-sessions.json`），模型与思考级别跟回；恢复失败不静默——明确提示并拦住发送。
3. **后台不中断**：流式中的引擎不被空闲回收（pin，2h 兜底强收）；关标签 / 切列 / 断网不中止本轮；回来可接管孤儿引擎（30s 静默门槛）并补齐尾巴；回合结束以落盘 entries 权威重载。
4. **会话管理**：列表按 cwd 分组 + AGENT 会话独立板块 + >200 项虚拟化 + 关键词过滤；真删除（先备份到 `backups/deleted-sessions/`）；新会话可选项目目录（`POST /api/session/new {cwd}`）；切换确认；fork / clone / 会话树主干视图（5000 节点懒渲染、选中 / 定位 / 从此处继续 / 降噪视图）。
5. **MCP 按列勾选**：引擎默认 `--no-mcp` 启动（单引擎整棵树 ≈90MB、切换会话 ≈0.15s）；`⋯` → MCP 面板按列勾选；`~/.pi/agent/pi-shell-mcp.json` 支持 `{default, rules:[{cwd, servers}]}` 按 cwd 通配自动启用；选择性加载由外置 agentDir shim 机制实现（目录 junction + 文件拷贝，只换 `mcp.json`）。
6. **工具可观测**：工具行完成耗时（运行中跳秒）、嵌套子调用折叠、失败标记；「本轮改动」面板（write/edit 类工具前后快照 + 内联 diff，`GET /api/turn-changes`，按会话保留最近 20 轮）；工作区 git 只读（`status` / `diff --stat` / `diff`）；文件树与只读预览（越界 / 符号链接 403）。
7. **模型配置 UI**：只列已配置凭据的模型（`auth.json` / `credentials.env`，环境变量假 key 不当真）；⟳ 热刷新；思考级别按会话真实值回填；顶栏配置跟随当前列会话（`GET /api/session/view?client=`）。
8. **界面**：`tokens.css` 单一来源视觉系统（light / dark 双主题、零远程资源）；顶栏 8 个可见入口 + `⋯` 菜单 + 状态胶囊（`streaming 12s` 跳秒）+ `引擎 1/4`；侧栏三行式可拖拽；移动端 ≤768px 抽屉 + `01/02/03` 列切换器 + 命中区 ≥44px；资源面板（每列 RSS 整棵进程树 / MCP / 状态 / 空闲，行内释放）；界面内重启桥 + 启动脚本崩溃自愈（1s/2s/4s 退避，5 分钟 3 次）；日志轮转（5MB × 5 份，`PI_SHELL_LOG_MAX_MB` / `PI_SHELL_LOG_KEEP` 可调）。
9. **安全边界**：默认只绑 `127.0.0.1`；Tailscale 双栈按需（`PI_SHELL_BIND=tailscale`，启动脚本检测 `100.x` 自动开，`PI_SHELL_NO_TAILSCALE=1` 关）；`0.0.0.0` 拒绝启动；会话文件只读（打开时先读文件渲染，零副作用）；git 只读（`GIT_OPTIONAL_LOCKS=0`，不写 `index.lock`）。

### 限制（明确不承诺的）

- 无会话锁：无法检测 / 阻止终端与网页同开同一会话，只能提示 + 备份（风险自担，见 `docs/05` D-08）。
- 桥进程重启（界面内「重启桥」/ 关启动窗口 / 崩溃自愈）会 `releaseAll`，正在跑的回合丢。
- 关列后约 30s 内回来同会话仍 `409`（孤儿接管静默门槛）。
- 新建会话在第一条消息落盘前没有会话文件，无法恢复（H-5 语义）。
- RPC 模式下部分扩展能力为 no-op（`custom()`、`setFooter` 等，见 `docs/03` §16-2）。
- 完整清单与排障见 `docs/USER-GUIDE.md` §14。

### 测试

- `cd bridge && npm test` → **216/216**（`node --test`，纯夹具，不碰真实 `~/.pi/agent`）。
- `node scripts/test-gate.mjs --full` → 20 套件全绿（unit 216 + 19 个 E2E：firstLoad / composer / origin / del / treeFlat / treeView / models / b8 / mobile / multi / mcp / layout / sessionView / sseTail / bgContinue / bgUi / sessionHeader / sessionMemory / thinkingOrder）；任一 FAIL 不发版。
- 证据脚本见 [`scripts/evidence/`](scripts/evidence)：全部 78xx/79xx 端口 + 夹具会话目录，真实桥（7788）与 `~/.pi/agent` 全程不碰。
