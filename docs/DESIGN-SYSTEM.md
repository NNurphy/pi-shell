# pi-shell 设计系统 · Logbook

> B8 视觉重设计 · 第一阶段产物（只出规范与预览，不改产品代码）
> 版本 `v0.1-draft` ｜ 适用：pi-shell web 外壳（`web/`）全部界面 ｜ 配套：`docs/design/LAYOUT.md`、`docs/design/TREE-DISPLAY.md`
> 目标视觉截图：`docs/design/preview-desktop-single.png`（单列 + 树面板）、`preview-desktop-dual.png`（双列 / 暗色）、`preview-mobile.png`（移动单列）、`preview-mobile-drawer.png`（移动抽屉）

---

## 0. 系统身份：为什么叫 Logbook

**Logbook（工作日志 / 值班记录）**——不是"AI 聊天产品"的皮，而是**仪表化的工程记录**。

判断依据来自产品事实，不是审美偏好：

| 事实 | 设计推论 |
|---|---|
| 单人、Windows、重度使用、多项目并发 | 界面服务"持续盯盘"，不是服务"初次惊艳"；密度优先于留白式营销感 |
| 一次会话 949 / 5000 节点，长到必须靠结构导航 | 会话流必须像**文档/日志**一样可扫读，不能是气泡聊天流 |
| 每轮有模型、思考级别、耗时、工具、token 消耗 | 元数据必须**常驻可见但不抢戏** → 全部走等宽小号字 |
| 3 列并行、每列一个引擎 | 列是**第一等公民**，列头承担身份，不是"打开一个 tab" |
| 离线可用、零依赖、无构建 | 不引 webfont、不引图标库 → 风格必须靠**排版与分隔**立住 |
| 移动端为 Tailscale 远程备用 | 移动是同一套信息结构的降级，不是另一套产品 |

**一句话系统：** 纸感的底、红笔的强调、等宽的元数据、1px 的规则线。
**唯一签名细节：** 会话流的左轨（turn rail）——连续 1px 竖线 + 每轮等宽序号 + 流式时出现的锈色游标。它让 5000 条消息"有位置感"，也是本系统唯一允许的装饰性投入（一个细节做到 120%，其余 80%）。

> ⚠️ 与现有实现的关系：`web/src/style.css` 已有 `--bg/--fg/--muted/--line/--accent` 等 15 个变量，**本系统的 token 是它的超集与语义重命名**，不推翻重来。迁移映射见 §7。

---

## 1. 设计原则（5 条，全部可被评审）

### P1 · 结构先于装饰
分层只允许用两种手段：**1px 规则线**与**间距**。阴影只用于"浮在内容之上"的东西（下拉、面板、模态），内容区永远没有阴影、没有卡片堆叠、没有渐变。
→ 验收：截任意一屏，去掉所有颜色后层级仍成立。

### P2 · 强调有语义，不是装饰
锈色（accent）只允许出现在三类语义里：**① 可执行**（每屏最多 1 个 primary 按钮）、**② 正在进行**（streaming 状态点/竖条/游标）、**③ 当前定位**（选中行、当前叶子、活动列）。
同一元素最多叠两层 accent 表达（淡底 + 2px 直边，或直边 + 字），不允许三层（底 + 边 + 彩色字）；AGENT 徽标这类**分类标记**只能用 `--accent-soft` + `--accent-ink`（弱化），不得用实底。
→ 验收：截图里每个 accent 块都能说出属于哪一类；说不出 = 装饰，删掉。

### P3 · 长会话靠"轴"读，不靠"气泡"读
assistant 输出是**文档**（无容器、通栏阅读、可 68ch 行宽）；只有 user 输入是"气泡/卡片"。每轮在左轨上有序号与状态点，滚动时轴线不断。
→ 验收：随机滚动到会话中段，1 秒内能答出"这一轮是谁、在干什么、花了多久"。

### P4 · 元数据等宽、内容层比例字
模型名、耗时、token、路径、节点深度、diff 行号 → 等宽 + `--ink-2` + 11/12px。正文 → 比例字 + 15px/24px。
理由：等宽元数据在视觉上"退后可扫"，且数字对齐时能一眼比大小（949 vs 5000 这类判断）。
→ 验收：任何数字类信息不使用比例字。

### P5 · 同构降级，不做第二套产品
≤768px 只允许发生三件事：侧栏变抽屉、多列变单列 + 列切换、hover-only 操作变长按/常显。**信息结构与桌面完全一致**，不新增移动专属概念。
→ 验收：桌面截图与移动截图的信息项逐条能对上。

---

## 2. Token 表

命名规则：`--<语义>-<变体>`。**禁止**在业务样式里写十六进制色值；只允许引用 token。

### 2.1 色彩 · Light（纸）

| Token | 值 | 用途 | 对比度实测（on 底） |
|---|---|---|---|
| `--canvas` | `#FBFAF7` | 主内容底（暖纸） | — |
| `--surface` | `#F4F2EC` | 侧栏、面板底 | — |
| `--surface-hover` | `#EFEDE6` | 行 hover、次按钮 hover | — |
| `--surface-sunken` | `#EFEDE6` | 代码块、工具行、thinking | — |
| `--line` | `#E0DBD1` | 装饰性分隔线（1px） | 1.32 : 1（装饰，免 3:1） |
| `--line-strong` | `#C9C3B7` | 分组分界、面板外框 | 1.68 : 1 |
| `--line-control` | `#88857D` | **交互控件边框**（输入框、下拉、勾选） | 3.53 / 3.29 / 3.15 : 1 ✅ |
| `--ink` | `#1C1B19` | 正文 | **16.49** / 15.37 / 14.69 : 1 ✅ |
| `--ink-2` | `#57534B` | 次级正文、说明 | **7.33** / 6.84 / 6.53 : 1 ✅ |
| `--ink-3` | `#6E695E` | 元数据、时间戳、占位符 | **5.23** / 4.88 / 4.66 : 1 ✅ |
| `--ink-inverse` | `#FFFFFF` | 主按钮文字 | 5.90 : 1 on accent ✅ |
| `--accent` | `#A8461C` | 锈红：选中、主按钮、链接 | 5.65 / 5.27 / 5.04 : 1 ✅ |
| `--accent-ink` | `#96401A` | accent 文字（更暗一档） | 6.61 / 6.16 / 5.89 : 1 ✅ |
| `--accent-soft` | `#F7E9DF` | AGENT 徽标底、选中行淡底 | 其上 `--ink` 14.49 : 1 ✅ |
| `--role-user-bg` | `#F1EFE8` | user 气泡底（比 `--surface` 深一档） | 其上 `--ink` 14.96 : 1 ✅ |
| `--focus-ring` | `#A8461C` | 焦点环（2px + 外移 1px） | 5.65 : 1 ✅ |
| `--success` | `#2E6B3F` | 完成、idle、diff + | 6.11 : 1 ✅ |
| `--warning` | `#7E5A00` | 排队、耗尽、注意 | 6.01 : 1 ✅ |
| `--danger` | `#A3261B` | 错误、删除、diff − | 7.06 : 1 ✅ |
| `--danger-soft` | `#F9E7E4` | 错误条底 | 其上 ink 13.8 : 1 ✅ |
| `--scrim` | `rgba(28,27,25,0.42)` | 抽屉遮罩 | — |
| `--diff-add` / `--diff-del` | `#EAF3EA` / `#F9E7E4` | diff 行底 | 其上 ink ≥13 : 1 ✅ |

### 2.2 色彩 · Dark（夜班）

| Token | 值 | 对比度实测（on canvas / surface） |
|---|---|---|
| `--canvas` | `#181917` | — |
| `--surface` | `#151614` | — |
| `--surface-hover` | `#222320` | — |
| `--surface-sunken` | `#101110` | — |
| `--line` | `#2B2C28` | 1.25 : 1（装饰） |
| `--line-strong` | `#3B3C36` | 1.58 : 1 |
| `--line-control` | `#6A6B63` | 3.27 / 3.37 : 1 ✅ |
| `--ink` | `#E9E6DF` | **14.16 / 14.57** ✅ |
| `--ink-2` | `#ABA69B` | **7.28 / 7.49** ✅ |
| `--ink-3` | `#8A857C` | **4.81 / 4.95** ✅ |
| `--ink-inverse` | `#17181A` | 7.60 : 1 on accent ✅ |
| `--accent` | `#E3995F` | **7.55 / 7.77** ✅ |
| `--accent-ink` | `#EFA872` | 8.83 / 9.09 ✅ |
| `--accent-soft` | `#2A211B` | 其上 ink 12.65 ✅ |
| `--role-user-bg` | `#24251F` | 暗底下气泡要比画布**亮**一档，否则会“沉”进背景 | 其上 ink 12.39 ✅（与画布 1.14 : 1，面块分离非文字） |
| `--focus-ring` | `#E3995F` | 7.55 ✅ |
| `--success` / `--warning` / `--danger` | `#6FBF84` / `#D8A65A` / `#F08B80` | 7.95 / 8.00 / 7.32 ✅ |
| `--danger-soft` | `#2C1B1A` | 其上 ink 12.4 ✅ |
| `--scrim` | `rgba(0,0,0,0.55)` | — |
| `--diff-add` / `--diff-del` | `#16241A` / `#2A1A18` | 其上 ink ≥11 ✅ |

**硬约束**
- 所有正文/元数据文字 ≥ **4.5:1**（已逐项实测，数值见上表）。
- 达 3:1 但不到 4.5:1 的颜色**只允许**用于图标/图形边界/装饰线，不得承载文字。
- 状态色不做"发光"（无 `box-shadow: 0 0 8px`）——发光在这个系统里等于 slop。
- 色板之外**不允许**新增颜色。需要"更淡的强调"时用 `--accent-soft`，不要调低 opacity 造新色。

### 2.3 字体

```css
--font-ui: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
--font-mono: "Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", ui-monospace, monospace;
```

- **不用 webfont**：产品要离线、零依赖；Windows 上 `Segoe UI` + `Microsoft YaHei UI` 的中英混排是可靠的。
- 个性由**字号阶梯 + 等宽元数据 + 规则线**承担，不靠 display 字体伪装。这是本系统对"反 slop 的 display 字体"这条的**显式例外**，原因写在 §0（离线约束），并在预览中验证过观感。
- 中文标点用「」引号、`·` 分隔、数字半角。

**字号阶梯（px / 行高）**

| Token | 尺寸 | 行高 | 用途 |
|---|---|---|---|
| `--fs-display` | 24 | 32 | 空态标题（极少用） |
| `--fs-h1` | 19 | 28 | 面板标题、设置分区标题 |
| `--fs-h2` | 16 | 24 | 消息内 h2/h3 |
| `--fs-body` | 15 | 24 | 正文、输入框 |
| `--fs-sm` | 13 | 20 | 次级正文、侧栏标题、按钮 |
| `--fs-label` | 12 | 16 | 组件标签、列头副信息 |
| `--fs-micro` | 11 | 14 | 等宽徽标、耗时、序号（`letter-spacing: .06em`） |
| `--fs-code` | 13 | 20 | 代码块、工具命令（等宽） |

正文行宽上限 **68ch ≈ 720px**（`--measure: 72ch` 上限 + `text-wrap: pretty`）。
字号切换只允许三档整体缩放（`--ui-scale: 0.92 / 1 / 1.08`），不单独改某个字号。

### 2.4 间距刻度（4 基准）

| Token | px | 典型用途 |
|---|---|---|
| `--sp-1` | 2 | 徽标内边、序号与文字之间 |
| `--sp-2` | 4 | 图标与文字、等高控件之间 |
| `--sp-3` | 6 | 行内元素间隙 |
| `--sp-4` | 8 | 行 padding 垂直、紧凑按钮 |
| `--sp-5` | 12 | 列表行水平 padding、卡片内边 |
| `--sp-6` | 16 | 区块内边、列 gutter 起点 |
| `--sp-7` | 20 | 段落之间 |
| `--sp-8` | 24 | 消息之间（同一轮内 16） |
| `--sp-9` | 32 | 区块之间、阅读区左右留白 |
| `--sp-10` | 40 | 空态留白 |
| `--sp-11` | 56 | 大留白（设置页分区） |

**节奏规则**：轮与轮之间 24，轮内元素 8，关联元素 4。没有第三种间距——不允许 10/14/18 这类随手值。

### 2.5 圆角

| Token | px | 用途 |
|---|---|---|
| `--r-xs` | 3 | 徽标 AGENT、状态点外框 |
| `--r-sm` | 6 | 按钮、工具行、输入框、代码块 |
| `--r-md` | 8 | user 气泡、composer 卡片、面板、下拉菜单 |
| `--r-full` | 999 | 仅：状态点、滚动条滑块 |

**上限 8px。** 禁止 12/16/24 的"大圆角卡片"。行（session row / tree row / 工具行）默认 **0 圆角**——它们是列表项，不是卡片。

### 2.6 层级（阴影只给浮层）

| Token | 值 | 用途 |
|---|---|---|
| `--e0` | none（1px `--line` 代替） | 所有内容区 |
| `--e1` | `0 1px 2px rgba(28,27,25,.06), 0 8px 24px rgba(28,27,25,.10)` | 下拉、popover、右侧面板浮层 |
| `--e2` | `0 24px 64px rgba(28,27,25,.20)` | 模态、抽屉（移动） |

Dark 下把阴影的 alpha 提到 `.35 / .60`（暗底阴影几乎不可见，靠 `--line-strong` 描边承担边界）。
**不允许**用阴影表达"卡片浮起"。

### 2.7 动效

| Token | 值 | 用途 |
|---|---|---|
| `--dur-1` | 90ms | hover / 按下反馈 |
| `--dur-2` | 140ms | 展开折叠、菜单出现、状态色变化 |
| `--dur-3` | 180ms | 面板滑入、列宽变化 |
| `--dur-4` | 240ms | 抽屉、模态 |
| `--ease-std` | `cubic-bezier(.2,.7,.3,1)` | 进入与位移 |
| `--ease-exit` | `cubic-bezier(.3,0,.8,1)` | 退出 |
| `--blink` | `1060ms steps(2,start)` | 流式游标 |

规则：
- 只动 `transform` / `opacity` / `background-color` / `border-color`；**不动 `width/height`**（用 grid-template-columns 或 flex-basis 配合 `transition` 除外，且必须 ≤180ms）。
- 列表新行出现：`opacity 0→1`，不做位移（长会话里位移会破坏"轴"的连续感）。
- `prefers-reduced-motion: reduce` → 全部时长归零，游标改为静态方块。

---

## 3. 组件规范

> 状态矩阵列固定为：**default / hover / active(按下或选中) / focus / disabled / streaming**。
> 「—」= 该状态不适用。所有可交互元素必须显式声明 focus 态（`focus-visible`，不用 `:focus`，避免鼠标点击也出环）。

### 3.1 Header（应用头，44px）

**结构**：`产品标 · 工作区分组 | 状态胶囊 | ⋯ 溢出菜单 | 右侧：Changes / 面板入口`
高度 44px，左右 padding 16px，底部 1px `--line`，背景 `--canvas`（与内容同底，**不用**实心色块压头）。

```
pi-shell   pi-shell / B8 视觉重设计        ● idle 0s      [树][文件][Diff][⋯]      Changes 4 ↑
```

- 产品标：`--fs-sm` 600，字距 `-0.01em`。
- 工作区路径：等宽 `--fs-label` `--ink-3`，**中间省略**（`pi-shell / … / B8 视觉…`），hover 出完整路径 tip。
- 状态胶囊：8px 圆点 + 等宽文字（`idle / streaming 12s / crashed`），点色用 `--success` / `--accent` / `--danger`。**不做胶囊底色**，只有文字与点。
- 面板入口 4 个：`树 / 文件 / Diff / ⋯`，ghost 按钮。其余（重启桥、命令面板、设置）收进 `⋯`。
  → 现状 10 个按钮平铺是"信息密度高但没有层级"的直接来源，**必须收敛到 4 + 溢出**。
- Changes 入口：`Changes 4 · +128 −37`，数字等宽；有未读改动时数字位用 `--accent-ink`，无改动时整体 `--ink-3` 且不可点。

| 状态 | 表现 |
|---|---|
| default | 底 `--canvas`，下边 1px `--line` |
| hover（按钮） | 按钮底 `--surface-hover`，90ms |
| active（面板已打开） | 按钮文字 `--accent-ink` + 底部 2px accent 短线（**不**做整块底色） |
| focus | 2px `--focus-ring`，外移 1px |
| disabled | `--ink-3`，无 hover，`cursor: not-allowed`（如 streaming 中禁用"重启桥"） |
| streaming | 状态胶囊文字走 `streaming 12s`，秒数每 1s 更新（等宽避免抖动） |

尺寸：`--h-header: 44px`；移动 ≤768px 变 48px（触摸），右侧只留 `Changes` 与 `☰`。

### 3.2 侧栏分组行（group row，32px）

```
▾  C:\Users\user\pi-shell                    7
```

- caret 12px（`--ink-3`），路径等宽 `--fs-label`，计数等宽 `--fs-micro` 右对齐 `--ink-3`。
- 背景透明；hover `--surface-hover`；展开/收起 140ms（caret 旋转 90°）。
- 分组**不加**彩色条、不加图标、不加大圆角。
- 分组计数 = 会话数；有 streaming 会话时计数前加一个 4px accent 点（唯一允许的实时信号）。

**AGENT 板块**（置顶独立板块）：
- 组标签：`AGENT 会话` + 计数，`--fs-micro` 大写 + `letter-spacing:.08em`，色 `--accent-ink`；组下方 1px `--line` 与普通分组隔开。
- 会话行右侧 `AGENT` 徽标：`--accent-soft` 底 + `--accent-ink` 字 + `--r-xs`，10px 等宽。**用文字不用 🤖 emoji**（emoji 作图标是 slop，且与等宽元数据系统冲突）。

| 状态 | 分组行 |
|---|---|
| default | 文字 `--ink-2`，计数 `--ink-3` |
| hover | 底 `--surface-hover`，文字 `--ink` |
| active（当前会话所在组） | 文字 `--ink`，caret `--accent-ink` |
| focus | 2px 内缩焦点环（`outline-offset:-2px`） |
| disabled | — |
| streaming | 计数前 4px `--accent` 点（呼吸不做动画，仅静态点） |

> 侧栏底 = `--surface`（比内容区深一档的“轨道”），所以**选中会话行的底改用 `--canvas`**（在灰轨道上打一个“纸洞”），再配 2px accent 直边。

### 3.3 会话行（session row，52px 双行）

```
┃ B8 视觉重设计 · 设计系统            12:40
  962 节点 · 12 分支 · 2 引擎          AGENT
```

- 左 2px 选中条（0 圆角，仅选中时出现），行内 padding：左右 `--sp-5`(12px)。
- 标题：`--fs-sm`/500，单行 ellipsis；当前会话权重 600 + `--ink`，其余 `--ink-2`。
- 副行：等宽 `--fs-micro` `--ink-3`（节点数/分支数/耗时），右侧 AGENT 徽标或删除按钮。
- hover 时右侧出现**行内操作**（删除、克隆）：24×24，`--ink-3` → hover `--danger` / `--accent-ink`；按下 90ms。
- 触摸端（≤768px）行高 56px，行内操作改为**常显**（不做 hover-only）。

| 状态 | 表现 |
|---|---|
| default | 透明底，标题 `--ink-2`，副行 `--ink-3` |
| hover | 底 `--surface-hover`，标题 `--ink` |
| active（当前打开） | 底 `--canvas` + 左 2px `--accent` + 标题 `--ink` 600 |
| focus | 焦点环内缩 1px，整行 |
| disabled | （已删除/不可读）标题加删除线？**不**——用 `--ink-3` + 右侧 `不可读` 等宽小字，避免删除线噪音 |
| streaming | 标题前 5px accent 方块（静态）；行底不变（避免整片列表在闪） |

### 3.4 消息项（turn）

统一骨架（每轮）：

```
⌐ 01  你                                     14:20            [复制][分支]
│  ┌──────────────────────────────┐
│  │ user 气泡：--surface，r-md     │
│  └──────────────────────────────┘
│  02  dev · deepseek-v4.1-flash · 8.2s · ↑1.2k ↓340
│      assistant 正文（通栏，无容器，最大 68ch）
│  03  ▸ bash  rg -n "TODO" web/src      1.2s  ✓
│  04  ▸ 思考  4.1s                               ⌄
└ 05  ● streaming                               …
```

- **左轨**：`--line` 1px 竖线，距内容 12px；每轮序号等宽 `--fs-micro` `--ink-3`，序号下方一个小点（用户轮：空心，assistant 轮：实心 `--ink-3`，错误轮：`--danger`）。
- 序号在 hover 时变 `--accent-ink`，点击可复制锚点（`#t=12`），用于"定位到某一轮"。
- 轮间距 24px；同一轮内元素间距 8px。

**user 消息（唯一带容器的）**
- 底 `--role-user-bg`（light 比画布深一档、dark 比画布亮一档），`--r-md`(8)，padding 12/14，最大宽度 `min(100%, 56ch)`，**左对齐**（不做右侧对齐：右侧对齐会破坏左轨与扫读）。
- 无边框、无阴影。

**assistant 消息**
- **无容器**、无边框、无底色；正文 `--fs-body` `--ink`，段间距 `--sp-5`(12)。
- 标题层级：h2 16/24（上间距 20，下 8）、h3 15/24 600；列表缩进 20px，`marker: --ink-3`。
- 代码块：`--surface-sunken` 底 + `--r-sm` + `--fs-code` 等宽 + 顶部 `--line` 1px；右上角"复制"按钮 hover 出现。
- 超长正文：不折叠，靠滚动；但**连续 > 40 行**的代码块默认折叠为 12 行 + `展开 320 行`。

**thinking 消息**
- 默认**折叠**为一行：`▸ 思考 · 4.1s · 1.2k tokens`，`--fs-label` `--ink-3`。
- 展开后：`--surface-sunken` 底、`--r-sm`、`--fs-sm`、`--ink-2`、左内边 12px；**不加**斜体（中文斜体渲染差）。
- 流式思考时行尾持续显示 `…`，不逐 token 抖动布局。

**notice / error 行**
- `--danger-soft` 底 + 左侧 2px `--danger` + `--r-sm`，含"重试"ghost 按钮；不弹模态。

| 状态 | user | assistant | thinking | tool |
|---|---|---|---|---|
| default | 底 `--role-user-bg` | 无容器 | 折叠一行 | 折叠一行 |
| hover | 底 `--surface-hover` | 标题/链接可点，轮操作浮现 | 行底 `--surface-hover` | 行底 `--surface-hover`，复制按钮浮现 |
| active | 选中文本高亮 `--accent-soft` | 同左 | 展开态（箭头转向） | 展开态 |
| focus | 容器 2px 焦点环 | 正文区可聚焦（Tab 到轮操作） | 行焦点环 | 行焦点环 |
| disabled | — | — | — | — |
| streaming | — | 末尾 2px×1em 游标块 `--accent` + blink | 行尾 `…` + 秒数递增 | 左侧 2px 进度条（不定长）+ 耗时递增 |

### 3.5 工具行（关键组件，含耗时位）

单行（折叠，28px）：

```
▸ bash   rg -n "TODO" web/src            1.2s   ✓
▸ read   docs/03-design.md               18ms   ✓
▸ bash   npm test                         3.2s   ⏳    ← running，耗时递增
▸ bash   git push origin main             0.8s   ✕    ← exit 1
```

- 左：caret + 工具名（等宽，`--ink-2`，6ch 宽对齐）+ 命令/参数（等宽 `--ink-3`，单行 ellipsis，可用宽度自适应）。
- 右：**耗时位**（等宽 `--fs-micro`，右对齐，固定宽度 `5ch`，避免数字变化导致整行抖动）+ 状态符号。
- 图标用文本符号（`✓ ✕ ⏳`）或 8px 圆点，**不用彩色 emoji**，不给每个工具配不同颜色的 icon。
- 展开：结果区 `--surface-sunken` 底 + `--r-sm` + `--fs-code`，超过 12 行折叠，右上"展开全部 / 复制"。
- 失败：整行文字 `--danger`，展开后 stderr 段落用 `--danger-soft` 底。

| 状态 | 表现 |
|---|---|
| default | 透明底，耗时 `--ink-3` |
| hover | 底 `--surface-hover`，行尾出现"复制命令 / 展开输出" |
| active | 展开（caret 90°），结果区出现 |
| focus | 行焦点环，Enter 展开/收起 |
| disabled | 不适用（已结束的失败行仍可展开） |
| streaming | 左侧 2px `--accent` 竖条（宽度动画不做 loop，用静态 + 耗时递增表达"在进行"），耗时 `--accent-ink` |

耗时格式规范：`<1s` → `320ms`；`<60s` → `1.2s`；`≥60s` → `1m 04s`。全部等宽右对齐。

### 3.6 Composer 卡片

```
┌─────────────────────────────────────────────────────────────┐
│ 继续讨论树展示…（placeholder --ink-3）                        │
│                                                             │
│ 📎 图片  文件                         deepseek · V4.1 Flash ▾   │
│                                       思考 high ▾    [中止] [发送]│
└─────────────────────────────────────────────────────────────┘
```

- 容器：`--canvas` 底 + 1px `--line-control` 边框 + `--r-md`(8)，padding 12，**无阴影**（贴在内容底部，属于内容而非浮层）。
- 最小高 96px，最大 40vh；多行时内部滚动，工具栏始终可见。
- 输入：`--fs-body`，无边框无背景，`min-height 48px`，`resize:none`。
- 底部工具栏：左（附件，ghost 图标+文字），右（模型分组下拉、思考级别、发送/中止）。
- **发送按钮**：primary，宽 64，高 32（桌面）/ 44（移动），`--accent` 底 + `--ink-inverse` 字。streaming 时变"中止" danger ghost。
- 快捷键提示只在 placeholder 内，不单独占一行（省垂直空间）；`Ctrl+Enter` 发送、`Enter` 换行。

**模型分组下拉**（本系统的"身份控件"，必须分组而非平铺）：
```
┌──────────────────────────────┐
│ DEEPSEEK                     │ ← 组标签：--fs-micro，大写，--ink-3
│  ● V4.1 Flash   high   1M   │ ← 选中项：左侧 4px accent 点
│    V4.1 Pro     high   128k │
│ ANTHROPIC                    │
│    Claude 5     off    200k │
│    Claude 5 Haiku  off 200k │
│ ZAI                          │
│    GLM-5.3      high   128k │
└──────────────────────────────┘
```
- 菜单：`--canvas` 底 + 1px `--line-strong` + `--r-md` + `--e1`，`--ease-std` 140ms 从下方 4px 浮入。
- 每行 32px（移动 44px）：模型名 `--fs-sm`，右侧上下文长度等宽 `--fs-micro` `--ink-3`。
- 禁用项（未配置 key）：`--ink-3` + 右侧 `未配置` 等宽字，不可点。

| 状态 | composer 容器 | 发送按钮 |
|---|---|---|
| default | 1px `--line-control` | `--accent` 底 |
| hover | 边框 `--ink-3` | 底 `--accent-ink` |
| active | — | 按下 90ms 缩放 .98？**不缩放**（缩放是 slop），改为底加深 |
| focus（容器内任意控件） | 边框 `--accent` + `0 0 0 2px --accent-soft` | 焦点环 |
| disabled | 底 `--surface`，文字 `--ink-3`，边框 `--line` | `--surface-hover` 底 + `--ink-3` 字 |
| streaming | 左 2px accent 竖条；发送→"中止"（danger ghost） | 中止：透明底 + `--danger` 字 + 1px `--line-control` |

### 3.7 面板（树 / 文件 / Diff）

- 桌面：右侧 docked，宽 340（树）/ 420（文件、Diff），左侧 1px `--line-strong`；`<1280px` 变浮层（`--e1` + `--r-md` + 12px 外边距）。
- 移动：全屏 sheet，从底部 240ms 滑入，顶部有 36px 抓手区（拖动关闭）。
- 面板头 36px：标题 `--fs-sm` 600 + 右侧操作（`×` 32×32）。
- 面板内列表行 28px，等宽元数据；树行见 `TREE-DISPLAY.md`。
- 面板滚动区独立，**不吃**主会话滚动。

| 状态 | 面板 |
|---|---|
| default | 底 `--surface`，左 1px `--line-strong` |
| hover（行） | `--surface-hover` |
| active（当前节点） | 底 `--accent-soft` + 左 2px `--accent` |
| focus | 行内缩焦点环 |
| disabled | 空态说明 |
| streaming | 头部右侧小字 `跟随中`（树自动跟随 leaf），可点击冻结 |

### 3.8 按钮层级

| 层级 | 用法 | 外观 | 尺寸 |
|---|---|---|---|
| primary | 每屏**最多 1 个**（发送、确认） | `--accent` 底，`--ink-inverse` 字，`--r-sm` | h32 / pad 0 16 |
| ghost | 工具栏、行内操作、面板头 | 透明底，1px `--line-control` 或用 `--ink-2` 文字 | h28 / h32 |
| quiet（无边框 ghost） | 头部入口、列头操作 | 透明底 + `--ink-2` 文字，hover 出 `--surface-hover` | h28 |
| danger | 删除会话、强制中止 | 透明底 + `--danger` 字，hover 出 `--danger-soft` | h28 |

**按钮状态矩阵**

| 状态 | primary | ghost / quiet | danger |
|---|---|---|---|
| default | `--accent` 底 + `--ink-inverse` 字 | 透明底 + `--ink-2` 字（ghost 带 1px `--line-control`） | 透明底 + `--danger` 字 |
| hover | 底 `--accent-ink`（暗色下 `#F0AF7C`） | 底 `--surface-hover`，字 `--ink` | 底 `--danger-soft`，边框 `--danger` |
| active（按下） | 底再深一档，**不缩放、不位移** | 底 `--surface-sunken` | 底 `--danger-soft`（字保持 `--danger`） |
| focus | 2px `--focus-ring`，外移 2px | 同左 | 同左 |
| disabled | 底 `--surface-hover` + 字 `--ink-3` | 字 `--line-strong`，无 hover | 字 `--line-strong`，无 hover |
| streaming（发送/中止切换） | 发送态不适用（组件变中止） | — | 中止按钮在 streaming 时常显 |

尺寸：桌面 h28/h32（图标按钮 ≥28×28）；≤768px 全部 ≥44×44（视觉高度可保持 32，用伪元素向四周扩命中区至 48，如 `inset: -6px`）。

- 按钮不做渐变、不做投影、不做图标+文字混排的"胶囊"。
- 图标按钮必须 ≥28×28（触摸 44×44），并带 `title`/`aria-label`。

### 3.9 空态 / 加载态 / 错误态

**空态**（无会话 / 无节点 / 无 diff）
- 结构：一句标题（`--fs-h1`，`--ink-2`）+ 一句解释（`--fs-sm`，`--ink-3`，≤2 行）+ 可选 1 个 ghost 操作。
- 垂直居中于可用区，最大宽度 42ch，**不配插图**（插图 = slop，且离线无资产）。

**加载态**
- 列表加载：3 条**骨架行**（28px 高的 `--surface-hover` 条，`opacity` 呼吸 1.2s）；不做 spinner 转圈。
- 会话流加载历史：顶部一行 `加载更早的 120 条…`（quiet 按钮），点击后才请求。
- 桥重启 / 切工作区：全屏遮罩 `--scrim` + 居中卡片（`--fs-sm` + 进度文案），**不显示百分比**（无真实进度就别编）。

**错误态**
- 行内错误（单条消息失败）：`--danger-soft` 条 + 文案 + `重试` ghost。
- 会话级错误（接管失败 / 流断开）：会话顶部 sticky 条（`--danger-soft`，36px），右侧 `重试`；可手动关闭，关闭后不再重复弹出（同一错误码只提示一次）。
- 致命（桥不可达）：内容区替换为**错误空态**：标题 `连不上桥`，等宽诊断行（端口、pid、日志路径），`重试` primary + `看日志` ghost。

### 3.10 Toast / 确认框

**Toast**
- 位置：桌面右下（内容区上方 16px），移动底部 composer 上方 12px。
- 外观：`--ink` 反底（light 下深底白字才够对比）**或** `--surface` + `--line-strong` + `--e1`；二选一，**统一用后者**（反底太吵）。
- 结构：左侧 2px 状态色竖条 + 一句话（≤24 字）+ 可选 `撤销`（5s 内）。
- 时长 3.2s；同一时刻最多 1 条（新覆盖旧）；`--e1` + 从下 8px 浮入 140ms。

**确认框（危险操作）**
- 模态：`--scrim` + 居中卡片 400px 宽（`--r-md` + `--e2`），标题 `--fs-h1`，正文说明"不可撤销"的具体后果，按钮右对齐：`取消`（ghost）+ `删除`（danger 实底 `--danger`/白字）。
- 危险按钮**不用** accent 色（accent 是本系统的"行动"色，危险必须是红）。
- 破坏性操作不做 Enter 默认确认，默认焦点在"取消"。

---

## 4. Do / Don't

| # | ❌ Don't（AI slop 清单） | ✅ Do |
|---|---|---|
| 1 | 紫色/多色渐变背景、按钮渐变 | 单一 `--canvas` 与 1px 规则线分层 |
| 2 | 圆角 12–24px 的卡片套卡片 + 左彩色 border accent | 列表行 0 圆角；选中用 2px 直边 + 淡底 |
| 3 | 每行都配彩色 icon（文件/工具/模型各一色） | 只保留承载信息的符号（状态点、AGENT 文字徽标） |
| 4 | emoji 当图标（🤖📁⚙️🔥） | 文本徽标 / 极简符号 / 等宽字符 |
| 5 | 卡片投影营造"浮起" | 阴影只给下拉、面板、模态 |
| 6 | opacity 调淡来做次级色 | 用 `--ink-2/--ink-3`（对比度已实测） |
| 7 | hover 时元素位移 / 缩放（translateY(-2px)、scale(1.02)） | 只变底色与边框色，90ms |
| 8 | 装饰性统计条（"今日 128 条消息"大数字卡） | 元数据贴在它所属的那一行上（耗时在工具行尾） |
| 9 | 空态配大插图 / 3D 插画 | 一句标题 + 一句解释 + 一个动作 |
| 10 | 彩色 tag 堆叠（每个会话 3 个标签） | 最多 1 个状态徽标 + 1 个计数 |
| 11 | 用颜色区分"哪个模型回的"（彩虹） | 模型名等宽小字，颜色统一 |
| 12 | 加载转圈满屏 spinner | 骨架行 / 行内进度条 |
| 13 | 全屏 toast 居中弹 | 右下角单条、3.2s、可撤销 |
| 14 | 气泡左右交错对齐（微信式） | 全部左对齐，assistant 通栏 |

---

## 5. 无障碍与可用性硬约束

1. 对比度：正文/元数据 ≥4.5:1；控件边界 ≥3:1（`--line-control` 已按此设定）。
2. 触摸目标：≥44×44（≤768px 时；桌面最小 28×28）。
3. 键盘：全部交互可 Tab 到；焦点环 2px 且不被 `overflow:hidden` 裁掉；`Esc` 关闭最上层浮层；树支持 `↑↓←→` 展开/收起。
4. 动效：尊重 `prefers-reduced-motion`。
5. 文本缩放：`--ui-scale` 三档，200% 缩放下不出现横向滚动（长路径用中间省略）。
6. 屏幕阅读器：会话流 `aria-live="polite"`；流式时只播报"完成"而不是逐 token。
7. 颜色不是唯一信号：状态同时用文字（`streaming 12s`）或符号（`✓ ✕`）。

---

## 6. 密度两档（对齐现有"舒适/紧凑"设置）

| 维度 | 舒适（默认） | 紧凑 |
|---|---|---|
| 会话行高 | 52 | 40（副行隐藏，标题单行） |
| 轮间距 | 24 | 16 |
| 工具行高 | 28 | 24 |
| 正文字号 | 15/24 | 14/22 |
| 侧栏宽度 | 288 | 264 |

紧凑档**不改变**间距刻度体系，只应用预定义组合（禁止业务代码里临时改 padding）。

---

## 7. 与现有实现的 token 映射（迁移用）

| 现有 `style.css` | 新 token | 备注 |
|---|---|---|
| `--bg` | `--canvas` | 值改暖纸 `#FBFAF7` / `#181917` |
| `--fg` | `--ink` | |
| `--muted` | `--ink-3` | 现有 `#6b7280` 对比 4.83，新值 5.23，更稳 |
| `--line` | `--line` + `--line-control` | **拆两个**：装饰线用 `--line`，控件边框用 `--line-control`（现 `#d8dee6` 仅 1.4:1，控件边界不达标） |
| `--sidebar` | `--surface` | |
| `--user` | `--role-user-bg` | 取消蓝调，改纸色；暗色下需比画布**亮**一档 |
| `--thinking` / `--tool` | `--surface-sunken` | **合并**：不再用绿/灰区分角色，改用文字标签 + 等宽命令 |
| `--notice` | `--warning` 软底 | |
| `--error` | `--danger-soft` | |
| `--accent` | `--accent` | 蓝 `#0b6bcb` → 锈 `#A8461C`；需同批替换所有 `color-mix(... accent ...)` 派生 |
| `--card-shadow` | 删除 | 内容区不允许阴影 |

迁移红线：`style.css` 中 9 处 `color-mix(in srgb, var(--accent) …)` 依赖 accent 为蓝；换成锈色后必须先核对浅底选中行的可读性（`--accent-soft` 已给替代值）。

---

## 8. 待决（需 Owner 拍板，第二阶段再动）

1. accent 用锈红（本方案）还是保留蓝？（锈红承担"纸感日志"气质，但蓝更"工具中性"）
2. 消息是否允许右侧对齐的 user 气泡？（本方案定为左对齐通栏，理由是长会话扫读）
3. 顶栏是否彻底去掉 `pid / pi 版本 / cwd` 常显？（本方案收进 `⋯` 面板，改为 hover 才显示）
