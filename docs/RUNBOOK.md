# RUNBOOK · 运行 / 排障 / 发布 / 回滚

> 适用范围：pi-shell v1.0.0（Windows 11 + Node 24 + pi 1.5.0）
> 最后更新：2026-11-12（核对计数与模型注入口径）
> 维护者：开发 Agent（下一任）

---

## 1. 日常命令与耗时

| 目的 | 命令（项目根执行） | 耗时（实测） |
|---|---|---|
| 启动 | 双击桌面 `pi-shell.lnk` 或 `node bridge/src/index.mjs` | 1–2s 就绪 |
| 单元测试 | `cd bridge && npm test` | 秒级（216 例，v1.0.0 实测） |
| 单条证据 | `node scripts/evidence/<name>.mjs` | 30–130s（m1a/m2a 约 90–120s） |
| 全量照妖镜 | `node scripts/smoke-check.mjs` | 2–4 min（A-01~A-08 + N） |
| **首启黄金路径** | `node scripts/evidence/first-load.mjs`（独占 7794 端口） | 20–40s（12 项；真实鼠标/键盘 + `getComputedStyle`） |
| **分层测试门（发版门）** | `node scripts/test-gate.mjs --full` | 8–15 min（**18 套件**：unit 216 例 + 其余 17 个 E2E 套件，全绿才发版；测试模型由 `scripts/model-config.mjs` 自动注入，**无需**手工设 `PI_SHELL_PROVIDER` / `PI_SHELL_MODEL`） |
| 定点复跑 | `node scripts/test-gate.mjs --only composer,layout` | 单套件 30–180s |
| **日志整理** | `node scripts/rotate-logs.mjs --dry-run`（去掉 `--dry-run` 才落盘） | < 1s |
| 全量证据 | 依次 m0 → m1-sessions → m1a → m1b → m1c → m2a → m2b → m2c-prefs → p0 | 10–15 min |
| 2h 稳定性 | `node scripts/evidence/m1d-stability.mjs --hours 2 --interval-min 5 --port 7793 --out <dir>`（**分离进程**启动） | 2h |
| 真实任务 | `node scripts/evidence/m2c-real-task.mjs --only task1`（再 `--only task2`，最后 `--check`） | 各 0.5–2 min |

> 长时测量必须在一开始就以**分离进程**启动，不要挂在工具调用里等。

---

## 2. 排障（每条 ≤3 步）

### 2.0 页面突然「桥不可达」/ 打开是白页
1. 先看启动窗口是否还开着：桥是前台进程，**关窗即停**。
2. 看 `logs/launcher.log`：有 `bridge exit rc=… crash` + `bridge restart` 说明已在自愈；有 `giving up` 说明 5 分钟内崩了 4 次，按提示修因后重开。
3. 都没有记录 → 桥不是被脚本拉起的（例如我手工 kill 过），重开快捷方式即可。

### 2.1 端口 7788 被占
1. `Get-NetTCPConnection -LocalPort 7788 -State Listen | Select-Object OwningProcess`
2. 确认 PID 是旧 bridge → `taskkill /PID <pid> /F`
3. 重启；若占用者不是 bridge，改 `PI_SHELL_PORT` 启动（不自动换端口）。

### 2.2 页面打不开 / health 超时
1. 看 `logs/bridge.log` 末 20 行（非 TTY 下日志只写文件）。
2. 进程在但无响应 → 检查是否 `stderr` 被管道接入而未消费（H-15）；脚本请用 `stdio: "ignore"`。
3. 仍异常 → 按 PID 杀桥、重启；页面会显示"桥不可达"。

### 2.3 pi 连续崩溃（重启超限）
1. 页面/health 显示 `state=failed`（5 分钟内 >3 次）。
2. 看 `logs/bridge.log` 的 `pi_exit/pi_close` 与 `pi_stderr`。
3. 修因（模型凭证/配置）后**手动重启桥**（设计上不自动无限守护）。

### 2.4 SSE 断线
1. 页面横幅显示"事件流断开：Ns 后第 N 次重连…"（1s/2s/4s×3）。
2. 三次失败 → 横幅 + 「重试」按钮；点击后恢复。
3. 恢复后自动 `GET /api/session/entries?since=<最后 entryId>` 补齐；`resync` 帧触发全量重载。

### 2.5 扩展弹窗悬挂（页面已关闭）
1. 无 SSE 客户端持续 10s → 桥自动对未回执 id 发 `cancelled:true`。
2. 若仍挂着：看 `logs/bridge.log` 的 `ext_ui_auto_cancelled`；必要时 `/api/abort`。

### 2.6 日志暴涨
1. `logs/bridge.log` 只记事件与关键字段（不记正文/密钥）。
2. N2 起已按大小轮转（默认 5MB × 保留 5 份），参数与手动清理见 **§2.7**。
3. 需要独立日志文件：设 `PI_SHELL_LOG_FILE=<path>`。

### 2.7 日志与磁盘占用

> N2 起不再无限增长：`bridge.log` 写前检查大小，超限即轮转；`launcher.log` / `mcp.log` 在**桥启动时**整理一次（异步，不挡启动）。

| 文件 | 写入方 | 什么时候轮转 |
|---|---|---|
| `logs/bridge.log` | 桥（`bridge/src/log.mjs`） | 每次写日志前检查，**大于**上限就先轮转再写 |
| `logs/launcher.log` | `scripts/start-pi-shell.cmd` | 桥启动时整理一次 |
| `logs/mcp.log` | 预留（仓库内暂无写入方） | 文件存在时按同一规则整理 |

**默认值**（非法值自动回落默认）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `PI_SHELL_LOG_MAX_MB` | `5` | 单文件上限（MB）；文件**大于**上限才轮转 |
| `PI_SHELL_LOG_KEEP` | `5` | 保留历史份数：`.1` … `.5`，最旧一份删除 |
| `PI_SHELL_LOG_DIR` | `<项目>/logs` | 日志目录（启动整理的文件也在这里） |
| `PI_SHELL_LOG_FILE` | `<日志目录>/bridge.log` | 单独指定桥日志路径（该文件由写入路径自己轮转） |

**轮转规则**：`bridge.log` → `bridge.log.1` → `bridge.log.2` … → `bridge.log.5`（更旧的删除）。轮转完成后往**新文件**写一行 `log_rotated from=… to=… bytes=…`，可用 `Select-String log_rotated logs\*.log*` 追溯。把 `keep` 调小后，下次轮转会顺手删掉多余的 `.N`。

**手动清理 / 查看占用**（项目根执行）：

```powershell
node scripts/rotate-logs.mjs --dry-run          # 只看每个文件会发生什么，不落盘
node scripts/rotate-logs.mjs                    # 立即整理一次（默认 5MB × 5 份）
node scripts/rotate-logs.mjs --max-mb 10 --keep 3
node scripts/rotate-logs.mjs --dir ~/pi-shell/logs --file bridge.log
Get-ChildItem logs | Sort-Object Length -Descending | Select-Object Name, Length
```

- 手动整理建议**先停桥**（尤其 `bridge.log`），避免和正在写入的进程抢同一个文件。
- 彻底清空：停桥 → 删除 `logs\*.log`（含 `logs\*.log.N`）→ 重新启动，日志会自动重建。
- 定时任务示例（每天 03:00 整理一次）：`schtasks /Create /SC DAILY /ST 03:00 /TN pi-shell-rotate-logs /TR "node \"%USERPROFILE%\pi-shell\scripts\rotate-logs.mjs\""`
- 每个日志最多 `keep + 1` 个文件（当前 + 历史）；总占用上限 ≈ 文件数 × `maxMB` × (`keep` + 1)。

---

## 3. 发布流程

> **硬门禁**：发 `x.Y.0` 前必须同步 **`docs/ARCHITECTURE.md`（版本号 + 新增机制）**、**`docs/USER-GUIDE.md`（新功能 / 新快捷键 / 排障）**、**`docs/WHATS-NEW.md`（新增一节，用户语言）**、**`RELEASE-NOTES.md`**、**`CHANGELOG.md`**；**缺一项不得 tag**。
> 维护约定：每次小版本（`x.Y.0`）都要走这一步；只有补丁版（`x.y.Z`）可以只更新 CHANGELOG + RELEASE-NOTES（仍建议顺手修文档里已经过时的说明）。

1. `cd bridge && npm test` → 全绿（v1.0.0 实测：**216/216**）。
2. `node scripts/test-gate.mjs --full` → **18/18 套件全绿**（unit 216 例 + 其余 17 个 E2E 套件逐项 PASS；任一 FAIL 不发版，这是主门）。
   测试模型统一由 `scripts/model-config.mjs` 解析（会话顶栏所选模型 > `scripts/model.json`），`test-gate` 自动注入，**不要**再手工设 `PI_SHELL_PROVIDER` / `PI_SHELL_MODEL`（手工值会掩盖模型不可用的真问题）。套件清单见 `docs/06-traceability-and-test.md` §3c。
3. `node scripts/smoke-check.mjs` → 全绿（N-03 用最近一次 2h 采样 CSV）。
4. **文档同步（缺一项不得 tag）**：
   - `docs/ARCHITECTURE.md`：头部版本号 + 生效日期；新增/变更的机制必须有自己的小节（数据流、引擎池、MCP shim、来源分类、快照、绑定…），并刷新「模块地图」与「不变量」；
   - `docs/USER-GUIDE.md`：新功能按「我要做什么」补条目、快捷键总表补行、常见问题补现象；
   - `docs/WHATS-NEW.md`：**顶部新增一节**（3–6 条用户语言的变化 + 一条升级注意），不写模块名/函数名；
   - `RELEASE-NOTES.md`：本次版本的能力 / 限制 / 升级注意（写在文件顶部，旧版本保留在下）；
   - `CHANGELOG.md`：顶部加 `## vX.Y.Z · 日期`。
   - 截图引用只能指向 `docs/evidence/` 下**已存在**的文件；新增截图先跑对应证据脚本落盘再复制进来。
5. `git tag -a vX.Y.Z -m "<一句摘要>"`。

> **5b. 发版后回头核对**：本文件与 `docs/06-traceability-and-test.md` 里的套件数 / 断言数 / 环境变量是否仍成立（发现过期计数即视为发版未完成）。

6. `node scripts/evidence/first-load.mjs` → 12/12（首屏可见性回归门，v1.0.0 事故的根因在这里，**不许省**）。
7. 归档（可选）：`git bundle create ~/pi-shell/.dev/backups/pi-shell-vX.Y.Z.bundle --all`。

---

## 4. 回滚流程

1. 停桥（`Ctrl+C` 或按端口 PID `taskkill /PID <pid> /F`）。
2. 删除 `~/pi-shell`；删除桌面 `pi-shell.lnk`。
3. 从 bundle 恢复：`git clone ~/pi-shell/.dev/backups/pi-shell-vX.Y.Z.bundle ~/pi-shell`
4. `cd bridge && npm test` → 以**该版本 tag 的实测结果**为准；重建快捷方式（见 `scripts/evidence/m2c-prefs-shortcut.mjs` 内命令）。
5. `~/.pi/agent` 无需恢复（本项目不写；pi 自身写 `settings.json`/`models-store.json`/`state/`/`sessions/`/`logs/`）。

---

## 5. 发布前检查（逐条打勾）

- [ ] `cd bridge && npm test`（v1.0.0 实测：216/216）
- [ ] `node scripts/test-gate.mjs --full`（18/18 套件全绿）
- [ ] `node scripts/smoke-check.mjs`（15/15，含 N-03 采样）
- [ ] 6 个基线套件（**已核对 2026-11-12：均未被 `test-gate` 的 `SUITES` 收录，仍需手动跑，无重复项可删**）：`git-diff-ui`(13) `new-session-ui`(11) `switch-confirm-ui`(13) `m1a-list-render`(35) `m2b-git-stats-filter`(18) `m2c-prefs-shortcut`(9) —— 括号内是**正常路径断言数**（源码实算：`check(...)` 调用点 − 仅失败分支 `check(..., false, ...)`；2026-11-12 实算：13/11/13/35/18/9，与本节一致；6 个脚本都在 `scripts/evidence/`，该目录共 45 个脚本）
- [ ] **真人走一遍**：双击桌面快捷方式 → 浏览器自动打开 → 首屏无浮层 → 开/关设置 → Ctrl+K / Esc → 刷新仍正常
- [ ] 卸载演练（bundle → zip → 删 → 验证 → 恢复 → npm test）
- [ ] 文档同步（**x.Y.0 必做，缺一项不得 tag**）：01/02 变更记录 / 03 契约与限制 / 04 工时 / **ARCHITECTURE** / **USER-GUIDE** / **WHATS-NEW** / CHANGELOG / RELEASE-NOTES
- [ ] 文档里的截图引用全部指向 `docs/evidence/` 下**已存在**的文件（新增图先落盘）
- [ ] `git tag -a vX.Y.Z` 且 `git status` 干净

---

## 6. 手机访问（Tailscale）

> 目标：在手机上打开本机这台 PC 上跑的 pi-shell。
> **默认已开**：用 `scripts\start-pi-shell.cmd`（桌面快捷方式）启动时，只要本机装了 Tailscale 且 `tailscale ip -4` 拿到 `100.x`，就自动 `PI_SHELL_BIND=tailscale`（双栈：`127.0.0.1` + `100.x`，桌面照旧用 `127.0.0.1:7788`）。
> 想关掉自动绑定：`set PI_SHELL_NO_TAILSCALE=1`（或显式 `set PI_SHELL_BIND=127.0.0.1`）。直接 `node bridge\src\index.mjs` 启动**不会**自动绑定，仍是纯回环。
> 外露只走 Tailscale 的加密 tailnet，**不开公网、不做端口转发、不绑 `0.0.0.0`**。

### 6.1 前置条件

1. 本机与手机都装 Tailscale，且用**同一个账号**登录（或同一 tailnet 里共享了这台 PC）。
2. 本机能跑 `tailscale status` 且列出自己（`tailscale ip -4` 有 `100.x` 地址）。
3. 桥是前台进程（关窗即停）——手机依赖这台 PC 醒着、桥开着。

### 6.2 步骤

1. **自检 / 拿地址**（只读，不改系统）：
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailscale-setup.ps1`
   会打印本机 `100.x`、手机访问地址、启动命令、排查清单，以及防火墙现状。
2. **启动桥**（启动脚本已默认开启 Tailscale 绑定；想显式控制则用第二行）：
   - `scripts\start-pi-shell.cmd`（检测到 `tailscale` 命令且有 `100.x` 时自动设 `PI_SHELL_BIND=tailscale`；`PI_SHELL_NO_TAILSCALE=1` 可关）
   - 手动：`set PI_SHELL_BIND=tailscale && scripts\start-pi-shell.cmd`（或 `$env:PI_SHELL_BIND='tailscale'; node bridge\src\index.mjs`）
   也可写显式地址：`PI_SHELL_BIND=100.x.y.z`（此时只监听该地址）。
   解析顺序：`tailscale ip -4` → 扫网卡里的 `100.64.0.0/10`；拿不到就**回落 `127.0.0.1`**并记 `bind_adjusted`（桥不会因此启动失败）。
   **双栈**：`tailscale` 模式监听 `127.0.0.1` + `100.x`（同一端口、两个 http server 共享同一 handler），桌面快捷方式的 `http://127.0.0.1:7788` 仍然可用。
3. 启动横幅（TTY）与 `logs\bridge.log` 的 `bridge_start` / `bind_banner` 会给出 `bind=127.0.0.1,100.x.y.z`、`desktop http://127.0.0.1:7788`、`mobile http://100.x.y.z:7788` 两行地址；`/api/health` 的 `bind` 是逗号串（含 `127.0.0.1`），`hosts` 是数组。
4. 手机浏览器打开 `http://100.x.y.z:7788`。

**安全护栏**：`PI_SHELL_BIND=0.0.0.0` / `::` 会**拒绝启动**（退出码 1，文案写明理由与替代方案），除非显式 `PI_SHELL_ALLOW_LAN=1`；放行时日志记 `bind_adjusted reason=wildcard_allowed_by_env`，横幅也会告警。

### 6.3 验证（两条都要过）

1. **health 200**：手机上打开 `http://100.x.y.z:7788/api/health`（或手机终端 `curl`）→ 200，且 JSON 里 `"bind":"127.0.0.1,100.x.y.z"`、`"ok":true`。
   本机自检：`curl.exe --noproxy '*' http://127.0.0.1:7788/api/health` 与 `curl.exe --noproxy '*' http://100.x.y.z:7788/api/health` **两个都要 200**（默认不绑 Tailscale 时第二个不通，属正常）。
2. **能发一条消息**：在手机页面里发一句话，看到 AI 回复流式输出——只有这一步过了才算"真的能用"（health 只证明端口通）。

### 6.4 回滚（任一步都够）

1. **只回默认监听**：停桥（关窗口 / `Ctrl+C`）→ 不管（或删掉）`PI_SHELL_BIND` → 重新启动。日志里 `bind=127.0.0.1` 即已恢复。
   若曾用 `setx PI_SHELL_BIND tailscale` 写成用户级环境变量：`REG delete HKCU\Environment /v PI_SHELL_BIND /f`（或 `setx PI_SHELL_BIND ""`）后重开终端。
2. **撤销防火墙规则**（只在跑过 `-Apply` 时需要）：
   `Remove-NetFirewallRule -DisplayName "pi-shell Tailscale 7788"`（DisplayName 带端口，端口非 7788 时按实际填）。
3. **彻底断掉手机**：Tailscale 管理台 → Machines → 该手机 → Remove（本机 tailnet 里不再有它）。

### 6.5 风险与已知限制

- **同一会话勿双开**：手机和 PC 同时打开同一个会话会互相抢引擎（pi 没有会话锁），历史会错乱——同一时间只在一处用。
- **手机丢失 = 访问权丢失**：手机上的 Tailscale 登录态就是进入 pi-shell 的钥匙（能跑任意命令、读你的文件）。丢了立刻在管理台 Remove 该设备；必要时轮换 tailnet key。
- **桥本身没有账号体系**：tailnet 即边界。**不要**把 `100.x` 地址通过端口转发/公网 IP 暴露出去，也不要把别的设备随手分享进 tailnet。
- `PI_SHELL_BIND=100.x.y.z`（显式写单个地址）时只监听该地址，`127.0.0.1:7788` 会不通；默认的 `tailscale` 模式是**双栈**，回环照旧可用。两种模式下都**别在同一会话上双开**。
- 手机端 UI 是同一套网页，窄屏下表格/长代码块体验一般；这是网页布局限制，不是桥的问题。
- `scripts\tailscale-setup.ps1 -Apply` 只添加**一条**入站规则（TCP + 仅 `100.64.0.0/10`），不改 Tailscale 设置、不动公网；需要管理员 PowerShell。

---

## 7. MCP 按需与外置 shim

> 引擎**默认不带任何 MCP**（`--no-mcp`，单引擎整棵树 ≈90MB；全开时 ≈544MB）。
> 需要 codegraph / mcp-obsidian / bilibili 这类 server 时，按**列**勾选，或写 cwd 规则自动启用。

### 7.1 怎么勾选（日常用法）

1. 顶栏 `⋯` → **MCP**，面板列出 `~/.pi/agent/mcp.json` 里的 server（只读清单，不在面板里编辑定义）。
2. 逐项打开开关 → 本列引擎**重启 ≈1 秒**，**会话不变**（`switch_session` 回原会话文件），期间开关禁用、列头显示 `MCP·N`。
3. 关掉全部开关 → 回到 `--no-mcp`（旧 shim 目录同时删除）。
4. 新开的列默认**不带** MCP（除非命中规则）。

### 7.2 规则文件（按 cwd 自动启用）

路径：`~/.pi/agent/pi-shell-mcp.json`（`PI_SHELL_MCP_CONFIG` 可覆盖；**不是** `mcp.json`）。

```json
{
  "default": [],
  "rules": [
    { "cwd": "C:\Users\user\my-project*", "servers": ["codegraph"] },
    { "cwd": "D:\work\*", "servers": ["codegraph", "mcp-obsidian"] }
  ]
}
```

- `default`：都不命中时用；留 `[]` 就是「默认全关」。
- `rules`：按会话 cwd 通配（`*`）、**首条命中即止**、大小写不敏感；**手动勾选优先**于规则。
- 改完规则**不会热生效**：新开一列，或对本列点开关/重启引擎才应用。
- 也可用接口写（带校验，非法 400 不落盘）：
  `curl.exe -X POST -H "Content-Type: application/json" --data @rules.json http://127.0.0.1:7788/api/mcp/config`

### 7.3 排查（每条 ≤3 步）

| 症状 | 先看什么 | 处置 |
|---|---|---|
| 面板里没有想要的 server | `~/.pi/agent/mcp.json` 里 `mcpServers` 有没有这个名字、`node`/`npx` 命令是否可用 | 补定义后重启桥，再开面板 |
| 勾了但工具不可用 | `GET /api/health` → `engines[].mcp` 是否含该名字（数组） | 不含 = 没生效：重启本列引擎；含但工具缺 = server 自身起不来（看桥日志 `pi_stderr` / `mcp_shim_failed`） |
| 引擎内存又涨到几百 MB | `health.engines[].mcp` 是不是不自觉变成多 server | 关掉多余勾选；检查规则文件是否写得太宽（`C:\*` 之类） |
| 配置没生效/被忽略 | 桥日志有没有 `mcp=[...]`（`engine_claimed` / `mcp_shim_ready`） | 名单在**建引擎**时决定；没有这行说明走了 `--no-mcp` |
| shim 目录残留 | `%TEMP%\pi-shell-mcp\` 下是否有 `<client>-XXXX` | 桥被强杀会残留；下次启动自动兜底，可手删（里面的 junction 只删链接、不动真实目录） |

- shim 目录里的 `mcp.json` 是**生成的**（只含选中 server），`skills`/`install` 是 junction，`settings.json`/`auth.json` 是**拷贝**——排查「设置改了没生效」先确认是不是看错了目录。
- 相关日志事件：`mcp_shim_ready` / `mcp_shim_removed` / `mcp_shim_failed` / `mcp_shim_unknown_server` / `engine_restart_start` / `engine_restart_done`。
