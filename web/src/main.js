// pi-shell · Q4：同页多列（1–3 列并行），每列一个引擎 + 一个会话 + 独立滚动/输入
//   列内逻辑在 column.js；本文件是外壳：侧栏 / 顶栏 / 面板 / 偏好 / 引擎认领 / 列管理。
// 硬约束：消息正文一律 DOM API / textContent，禁 innerHTML。

import { createSessionList } from "./list.js";
import { getCollapseState } from "./render.js";
import { renderMarkdown } from "./markdown.js";
import { createColumn } from "./column.js";
import { createTabIdentity } from "./tab-identity.js";
import { createResourcesPanel } from "./resources.js";

// N1-a：标签页身份（复制标签页会复制 sessionStorage → 启动时用 BroadcastChannel + localStorage
// 心跳锁检测同 id 冲突并换新号）。**必须在任何 claim 之前 await 完成**。
const tabIdentity = await createTabIdentity();
let BASE_CLIENT_ID = tabIdentity.clientId;
const TAB_ID = tabIdentity.tabId;

/**
 * 全局 fetch 标注：全局请求（列表/模型/树/文件/Diff…）按「当前列」的引擎走。
 * 列内请求自己显式带 X-Pi-Shell-Client（column.js），这里不覆盖已显式设置的标识。
 */
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (!headers.has("X-Pi-Shell-Client")) headers.set("X-Pi-Shell-Client", currentClientId());
  if (!headers.has("X-Pi-Shell-Tab")) headers.set("X-Pi-Shell-Tab", TAB_ID);
  return nativeFetch(input, { ...init, headers });
};

const $ = (id) => document.getElementById(id);
const els = {
  list: $("sidebar-body"),
  columns: $("columns"),
  switcher: $("col-switcher"),
  split: $("split-control"),
  colHead: $("col-head"),
  state: $("state"),
  stateEngines: $("engines"),
  changes: $("changes"),
  changesCount: $("changes-count"),
  changesLines: $("changes-lines"),
  wsPath: $("ws-path"),
  openMenu: $("open-menu"),
  menu: $("overflow-menu"),
  pid: $("pid"),
  version: $("version"),
  cwd: $("cwd"),
  searchClear: $("search-clear"),
  reload: $("reload-list"),
  model: $("model-select"),
  reloadModels: $("reload-models"),
  thinking: $("thinking-select"),
  openPalette: $("open-palette"),
  newSession: $("new-session"),
  brandHome: $("brand-home"),
  openSettings: $("open-settings"),
  settings: $("settings"),
  prefTheme: $("pref-theme"),
  prefDensity: $("pref-density"),
  prefFont: $("pref-font"),
  prefHints: $("pref-hints"),
  settingsReset: $("settings-reset"),
  settingsClose: $("settings-close"),
  search: $("session-search"),
  toggleSidebar: $("toggle-sidebar"),
  sidebarScrim: $("sidebar-scrim"),
  sidebarResizer: $("sidebar-resizer"),
  openTree: $("open-tree"),
  openFiles: $("open-files"),
  openDiff: $("open-diff"),
  panel: $("panel"),
  panelTitle: $("panel-title"),
  panelBody: $("panel-body"),
  panelClose: $("panel-close"),
  panelAction: $("panel-action"),
  toast: $("toast"),
  extStatus: $("ext-status"),
  modal: $("modal"),
  picker: $("project-picker"),
  pickerList: $("picker-list"),
  pickerOther: $("picker-other"),
  pickerPath: $("picker-path"),
  pickerError: $("picker-error"),
  pickerCancel: $("picker-cancel"),
  pickerConfirm: $("picker-confirm"),
  restartBridge: $("restart-bridge"),
  restartOverlay: $("restart-overlay"),
  restartTitle: $("restart-title"),
  restartNote: $("restart-note"),
  restartClose: $("restart-close"),
};

// ---------- 移动端抽屉（≤768px）----------
// 侧栏在 ≤768 变成固定定位的抽屉（style.css）：开合只切 body[data-sidebar]，
// 默认关闭。桌面宽度下这些调用都是 no-op（CSS 不生效），不改变 1440 的布局。
const MOBILE_MAX = 768;
const isMobileLayout = () => window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).matches;
function sidebarOpen() {
  return document.body.dataset.sidebar === "open";
}
function setSidebarOpen(open) {
  const next = Boolean(open) && isMobileLayout();
  document.body.dataset.sidebar = next ? "open" : "closed";
  if (els.sidebarScrim) els.sidebarScrim.hidden = !next;
  if (els.toggleSidebar) els.toggleSidebar.setAttribute("aria-expanded", next ? "true" : "false");
  return next;
}
els.toggleSidebar?.addEventListener("click", () => setSidebarOpen(!sidebarOpen()));
els.sidebarScrim?.addEventListener("click", () => setSidebarOpen(false));
window.addEventListener("resize", () => {
  if (!isMobileLayout() && sidebarOpen()) setSidebarOpen(false);
});
setSidebarOpen(false);

// ---------- 侧栏宽度（Q6）：拖拽分割线 + localStorage 记忆 ----------
// 宽度写在 <html> 的内联 --sidebar-w 上（压过 tokens 的两个主题/两个密度档），
// 刷新后从 localStorage['pi-shell.sidebarWidth'] 恢复；双击回默认 320。
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 320;
const SIDEBAR_KEY = "pi-shell.sidebarWidth";

function clampSidebarWidth(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SIDEBAR_DEFAULT;
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(n)));
}

let sidebarWidth = SIDEBAR_DEFAULT;

function applySidebarWidth(raw, { persist = false } = {}) {
  sidebarWidth = clampSidebarWidth(raw);
  document.documentElement.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
  if (els.sidebarResizer) {
    els.sidebarResizer.setAttribute("aria-valuenow", String(sidebarWidth));
    els.sidebarResizer.setAttribute("aria-valuemin", String(SIDEBAR_MIN));
    els.sidebarResizer.setAttribute("aria-valuemax", String(SIDEBAR_MAX));
  }
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth));
    } catch {} // 隐私模式禁 localStorage：拖拽仍生效，只是不记忆
  }
  return sidebarWidth;
}

function readSidebarWidth() {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    return raw == null ? SIDEBAR_DEFAULT : clampSidebarWidth(raw);
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

applySidebarWidth(readSidebarWidth());

// 拖拽用 pointer 事件（鼠标/触控笔同一套）；触摸设备的分割线被 CSS 隐藏，不会走到这里。
(() => {
  const handle = els.sidebarResizer;
  if (!handle) return;
  let dragging = false;
  let startX = 0;
  let startWidth = SIDEBAR_DEFAULT;

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    applySidebarWidth(sidebarWidth, { persist: true }); // 拖拽结束才写盘（拖动过程不刷 localStorage）
  };

  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    startX = ev.clientX;
    startWidth = sidebarWidth;
    document.body.classList.add("resizing");
    try {
      handle.setPointerCapture(ev.pointerId);
    } catch {}
    ev.preventDefault();
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    applySidebarWidth(startWidth + (ev.clientX - startX)); // 实时跟手，不持久化
    ev.preventDefault();
  });
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  // 指针在窗口外松开：pointercapture 理论上会补 pointerup，这里再兜一层
  window.addEventListener("pointerup", finish);

  handle.addEventListener("dblclick", () => applySidebarWidth(SIDEBAR_DEFAULT, { persist: true }));

  // 键盘可达：← / → 每次 16px，Home/0 回默认（桌面无障碍，不抢既有快捷键）
  handle.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? 48 : 16;
    if (ev.key === "ArrowLeft") applySidebarWidth(sidebarWidth - step, { persist: true });
    else if (ev.key === "ArrowRight") applySidebarWidth(sidebarWidth + step, { persist: true });
    else if (ev.key === "Home" || ev.key === "0") applySidebarWidth(SIDEBAR_DEFAULT, { persist: true });
    else return;
    ev.preventDefault();
  });
})();
let workspaceRoot = ""; // 桥的工作区根（/api/health 的 pi.cwd），无会话时给它取 diff
let lastPiPid = null; // 最近一次 /api/health 的 pi.pid（重启流程用它判「换了个新 pi」）
let healthMaxEngines = 0; // /api/health 的 maxEngines（并行上限，用于「引擎 1/4」）

/** 已流式秒数（等宽不抖）：null → 0s */
function fmtElapsed(start) {
  if (!start) return "0s";
  return `${Math.max(0, Math.round((Date.now() - start) / 1000))}s`;
}

/** 顶栏工作区：只显最后一段（中间省略的简化版），完整路径在 title */
function shortWorkspace(cwd) {
  const s = String(cwd || "").replace(/[\\/]+$/, "");
  if (!s) return "";
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

const STATE_LABELS = {
  not_started: "未启动",
  starting: "启动中…",
  idle: "空闲",
  streaming: "运行中",
  crashed: "已崩溃，等待重启",
  failed: "重启超限（请重启桥）",
  stopping: "停止中",
};

// ---------- 顶栏溢出菜单（B8：10 个平铺按钮收敛成 会话/模型/思考级别/⋯）----------
// 树/文件/Diff/命令面板/设置/重启 + pid/版本/cwd 全在 ⋯ 里；id 一个不改（E2E 依赖）。

function menuOpen() {
  return !!els.menu && els.menu.hidden === false;
}

function setMenu(open) {
  if (!els.menu || !els.openMenu) return;
  els.menu.hidden = !open;
  els.openMenu.setAttribute("aria-expanded", open ? "true" : "false");
}

if (els.openMenu) {
  els.openMenu.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setMenu(!menuOpen());
  });
  // 点菜单里的任何一项都关菜单（含被复用的复杂面板入口）
  els.menu.addEventListener("click", (ev) => {
    if (ev.target.closest("button")) setMenu(false);
  });
  // 点别处关菜单（用 pointerdown，避免和按钮自己的 click 抢顺序）
  document.addEventListener("pointerdown", (ev) => {
    if (!menuOpen()) return;
    if (els.menu.contains(ev.target) || els.openMenu.contains(ev.target)) return;
    setMenu(false);
  });
}

// ---------- Changes 计数（B8.1）：文件数 + 行数（N +X −Y） ----------
// 数据源仍是只读的 /api/git/diff：status 给文件数（含未跟踪），stat 汇总行给插入/删除行数。
// stat 不可用（非 git / 只改了未跟踪文件 / 解析失败）→ 隐藏行数块，退回纯文件数，不编数字。

let changesToken = 0;

/** 解析 `git diff --stat` 的汇总行：`3 files changed, 128 insertions(+), 37 deletions(-)` */
function parseStatTotals(stat) {
  const text = typeof stat === "string" ? stat : "";
  const line = text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /changed|insertion|deletion/i.test(s))
    .pop();
  if (!line) return null;
  const files = /(\d+) files? changed/.exec(line);
  const add = /(\d+) insertions?\(\+\)/.exec(line);
  const del = /(\d+) deletions?\(-\)/.exec(line);
  if (!files && !add && !del) return null;
  return { add: add ? Number(add[1]) : 0, del: del ? Number(del[1]) : 0 };
}

async function refreshChanges() {
  if (!els.changes) return;
  const token = ++changesToken;
  const col = activeColumn();
  const cwd = col?.cwd || workspaceRoot;
  // B1/T6：新建会话切目录期间（POST 未回）SSE 帧可能抢先触发 → 旧 cwd 的 diff 会 403。
  // 等 createSession 拿到新 cwd 并主动调一次 refreshChanges 再查。
  if (col && col.cwdPending) {
    els.changes.hidden = true;
    return;
  }
  // 桥的白名单 = 主工作区 root + 已附着会话的 cwd（bridge/src/index.mjs resolveDiffCwd）。
  // 打开一个 cwd ≠ 工作区 root 的会话时，接管回执还没到 → 这一枪必然 403，
  // 浏览器控制台会留一行 error（看着像故障），而结果也确实被丢弃。
  // 所以未接管完就先跳过；接管回执 / 一轮结束都会再调一次（column.js），不会永远不显示。
  if (col && col.attachState !== "attached" && workspaceRoot && cwd && !sameCwd(cwd, workspaceRoot)) {
    els.changes.hidden = true;
    return;
  }
  // PIX-4：「本轮改动」也算改动 —— 工作区干净 / 不是 git 仓库时，入口仍要能打开本轮面板
  let turnFiles = 0;
  try {
    const sid = currentSessionId();
    const tRes = await fetch(`/api/turn-changes${sid ? `?session=${encodeURIComponent(sid)}` : ""}`, { cache: "no-store" });
    if (tRes.ok) {
      const tData = await tRes.json();
      turnFiles = Array.isArray(tData?.files) ? tData.files.length : 0;
      if (Number.isInteger(tData?.turn) && activeColumn()) activeColumn().lastTurn = activeColumn().lastTurn ?? tData.turn;
    }
  } catch {}
  if (token !== changesToken) return;
  if (turnFiles > 0) {
    els.changesCount.textContent = String(turnFiles);
    if (els.changesLines) {
      els.changesLines.replaceChildren();
      els.changesLines.hidden = true;
    }
    els.changes.title = `本轮改动 ${turnFiles} 个文件（点击看本轮改动 / 工作区 diff）`;
    els.changes.hidden = false;
    void refreshTurnPanelIfOpen();
    return;
  }
  try {
    const res = await fetch(`/api/git/diff${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { cache: "no-store" });
    const data = await res.json();
    if (token !== changesToken) return; // 老请求不覆盖新状态
    if (!res.ok || data?.available === false) {
      els.changes.hidden = true;
      return;
    }
    const status = Array.isArray(data.status) ? data.status : [];
    if (!status.length) {
      els.changes.hidden = true; // 工作区干净：入口整体退场
      return;
    }
    els.changesCount.textContent = String(status.length);
    const totals = parseStatTotals(data.stat);
    if (els.changesLines) {
      els.changesLines.replaceChildren();
      els.changesLines.hidden = !totals;
      if (totals) {
        const add = document.createElement("span");
        add.className = "add";
        add.textContent = `+${totals.add}`;
        const del = document.createElement("span");
        del.className = "del";
        del.textContent = `−${totals.del}`;
        els.changesLines.append(add, del);
      }
    }
    const linesText = totals ? ` · +${totals.add} −${totals.del}` : "";
    els.changes.title = `工作区有 ${status.length} 个文件改动${linesText}（点击看本轮改动 / 工作区 diff）`;
    els.changes.hidden = false;
  } catch {
    if (token === changesToken) els.changes.hidden = true;
  }
  // PIX-4：面板开着「本轮」时按签名刷新（内容没变不动，避免打断已展开的 diff）
  void refreshTurnPanelIfOpen();
}


// ---------- 提示 ----------

/** 全局提示 → 落到「当前列」的提示条（每列一条，互不覆盖） */
function showNotice(text, isError = false) {
  activeColumn()?.showNotice(text, isError);
}

function toast(text, type = "info") {
  if (!text) return;
  els.toast.textContent = text;
  els.toast.dataset.kind = type;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (els.toast.hidden = true), 4000);
}

// ---------- 全局 JSON 请求（列表/面板/重启这类「外壳」操作按当前列的引擎走） ----------
// 列内请求另有一套带列标识的实现（column.js），不要混用。

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(`${data?.error?.code || `HTTP_${res.status}`}: ${data?.error?.message || ""}`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** B-12：DELETE（会话删除）。错误码/状态照 POST 同一套口径，供 showNotice 显示 code + message */
async function deleteJson(url) {
  const res = await fetch(url, { method: "DELETE", cache: "no-store" });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(`${data?.error?.code || `HTTP_${res.status}`}: ${data?.error?.message || ""}`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- 列表 ----------

const list = createSessionList({
  root: els.list,
  fetchJson: async (url) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  // 唯一的「用户点会话列表」入口：在当前列打开（该列 streaming 时先确认，见 column.requestOpen）。
  onOpen: (session) => activeColumn()?.requestOpen(session),
  // B-12：删除（移到 backups/deleted-sessions，可撤销）
  onDelete: (session) => requestDeleteSession(session),
});

/** 会话时间戳展示（删除确认框用；“更新于 …”要和列表一致可读） */
function fmtSessionTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "时间未知";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 删除会话（B-12）：先确认（标题 + 时间 + 可恢复提示）→ DELETE /api/session?path=…
 * 409 = 当前会话正在使用 → 明确提示先中止或切走，不动列表。
 */
async function requestDeleteSession(session) {
  const title = session.title || "(无标题)";
  const ok = await confirmModal(
    `会话「${title}」（${fmtSessionTime(session.updatedAt)}）会移到 backups/deleted-sessions，可从磁盘恢复。`,
    { title: "删除会话", confirmText: "删除", cancelText: "取消" },
  );
  if (!ok) return;
  try {
    const data = await deleteJson(`/api/session?path=${encodeURIComponent(session.path)}`);
    toast(`已删除（备份：${data.backup}）`);
    await list.load();
  } catch (err) {
    if (err.status === 409) showNotice("删除失败（409 CONFLICT）：会话正在使用，请先中止或切走", true);
    else showNotice(`删除失败：${err.code || "ERROR"} ${err.message}`, true);
  }
}

els.reload.addEventListener("click", () => list.load());
// T-20：250ms 防抖（≥250ms 要求），清空按钮，命中数；只走索引缓存（?q=），不读文件正文
let searchTimer = null;
function updateSearchUi(count) {
  els.searchClear.hidden = !els.search.value;
  if (typeof count === "number") {
    els.search.dataset.hits = String(count);
    els.search.title = count >= 0 ? `命中 ${count} 条` : "";
  }
}
els.search.addEventListener("input", () => {
  // 即时反馈：用内存索引本地过滤（0 网络、不读文件正文）
  const hitsNow = list.filterLocally(els.search.value.trim());
  updateSearchUi(hitsNow);
  // 250ms 防抖后再让服务端 ?q= 校正（走索引缓存）
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    await list.setQuery(els.search.value.trim());
    updateSearchUi(list.model.rows.filter((r) => r.kind === "session").length);
  }, 250);
});
els.searchClear.addEventListener("click", async () => {
  els.search.value = "";
  updateSearchUi();
  await list.setQuery("");
});
updateSearchUi();

// ============================ 顶栏：模型 / 思考级别 / 目录 / MCP（跟随当前会话） ============================
// B1/T6：顶栏的唯一事实来源是 GET /api/session/view?client=<本列>。
// 单一入口 syncHeaderFromSession(col)：setActive / columnUpdated / openSession / newSession /
// SSE session_attached 都调它；不在这里手拼多个端点。
// 模型候选按 client 缓存（modelsByClient）：切列时先清掉上一列的选项再装本列的，
// 当前模型不在清单里时显示「该模型不可用」——绝不静默保留上一列的值（design F14）。
let modelCount = 0;
const MODEL_EMPTY_TEXT = "未检测到已配置的模型，点 ⟳ 重试";
const MODEL_LOADING_TEXT = "模型清单加载中…";
const MODEL_UNAVAILABLE_TEXT = "该模型不可用";
let pendingModel = null;
let pendingThinking = null;
let modelClientId = null; // 下拉里当前装的是哪一列的候选清单（null = 还没装）

const sessionViews = new Map(); // clientId → 最近一次 session/view（切列先用缓存回填，不闪上一列）
const modelsByClient = new Map(); // clientId → 候选模型数组（按列缓存；⟳ 才失效）
const headerSync = { timers: new Map(), inflight: new Map(), again: new Set(), fetchedAt: new Map() };
const warnedUnavailable = new Set(); // `${clientId}\n${model}`：同一列同一模型只提示一次

function paintWsPath(cwd) {
  if (!els.wsPath) return;
  els.wsPath.textContent = shortWorkspace(cwd) || "—";
  els.wsPath.title = cwd || "";
}

function applyThinkingToSelect(level) {
  if (!level) return false;
  pendingThinking = level;
  window.__lastThinkingLevel = level; // 回归断言用（composer-e2e T6b）
  const opt = [...els.thinking.options].find((o) => o.value === level);
  if (!opt) return false;
  els.thinking.dataset.current = level;
  if (els.thinking.value !== level) els.thinking.value = level;
  return true;
}

/** 把「本列真实模型」写进下拉；清单里没有它时显式标注「该模型不可用」并提示一次 */
function applyModelToSelect(model) {
  pendingModel = model ?? null;
  if (!model) {
    delete els.model.dataset.current;
    delete els.model.dataset.unavailable;
    els.model.selectedIndex = -1;
    return false;
  }
  window.__lastModel = model; // 回归断言用：页面从会话视图认定的当前模型（composer-e2e T6）
  els.model.dataset.current = model;
  const opt = [...els.model.options].find((o) => o.value === model);
  if (opt) {
    if (els.model.value !== model) els.model.value = model;
    // 追加的「不可用」占位项再次命中时，标记必须留着（否则第二次同步就把提示抹掉）
    if (opt.dataset.unavailable) els.model.dataset.unavailable = model;
    else delete els.model.dataset.unavailable;
    return !opt.dataset.unavailable;
  }
  // 清单还没取到（加载中）时先记住真实值；等 loadModels 回来后由 renderModelOptions 再回填
  if (!modelsByClient.has(modelClientId)) return false;
  const miss = document.createElement("option");
  miss.value = model;
  miss.textContent = MODEL_UNAVAILABLE_TEXT;
  miss.title = `${model} 不在本列可用模型清单里（可能已被删除，或凭据失效）`;
  miss.dataset.unavailable = "1";
  els.model.appendChild(miss);
  els.model.dataset.unavailable = model;
  if (els.model.value !== model) els.model.value = model;
  const key = `${modelClientId}\n${model}`;
  if (!warnedUnavailable.has(key)) {
    warnedUnavailable.add(key);
    toast(`模型不可用：${model} 不在本列的模型清单里`, "warning");
  }
  return false;
}

/**
 * P0：前端兜底恢复模型时被引擎拒绝（404/400）→ 顶栏显式标注「该模型不可用」并提示一次。
 * 「清单里没有」的情况由 applyModelToSelect 自己追加占位项并提示；这里补上
 * 「清单里有、但引擎拒绝了（凭据失效/模型下线）」的同一种真相，绝不静默退回默认。
 */
function reportModelUnavailable(col, model, err) {
  if (!model) return;
  if (col && col !== activeColumn()) return; // 只在顶栏正在显示这一列时改下拉
  const inList = [...els.model.options].some((o) => o.value === model && !o.dataset.unavailable);
  pendingModel = model;
  applyModelToSelect(model);
  els.model.dataset.unavailable = model; // 清单里有也被拒：同样标注，不装作已生效
  const key = `${col?.clientId ?? ""}\n${model}\nrejected`;
  if (inList && !warnedUnavailable.has(key)) {
    warnedUnavailable.add(key);
    toast(`该模型不可用：${model}${err?.message ? `（${err.message}）` : ""}`, "warning");
  }
}

/** 按「本列」的候选清单重建模型下拉（同一 client 重建时保留选择，换列时不保留） */
function renderModelOptions(clientId) {
  const sameClient = modelClientId === clientId;
  const keep = sameClient ? els.model.value : "";
  const models = modelsByClient.get(clientId);
  els.model.replaceChildren();
  delete els.model.dataset.empty;
  delete els.model.dataset.loading;
  delete els.model.dataset.unavailable;
  modelClientId = clientId;

  if (!models) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = MODEL_LOADING_TEXT;
    opt.disabled = true;
    els.model.appendChild(opt);
    els.model.dataset.loading = "1";
    modelCount = 0;
    return;
  }
  if (models.length === 0) {
    // 空态：保留 dataset.current，不把占位项当成当前模型
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = MODEL_EMPTY_TEXT;
    opt.disabled = true;
    els.model.appendChild(opt);
    els.model.dataset.empty = "1";
    modelCount = 0;
    return;
  }

  // 按 provider 分组（optgroup 按 provider 名排序，保证顺序稳定、便于查找）
  const groups = new Map();
  for (const m of models) {
    const provider = m.provider || "unknown";
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(m);
  }
  for (const [provider, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const group = document.createElement("optgroup");
    group.label = provider;
    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = `${m.provider}/${m.id}`;
      opt.textContent = m.name || m.id;
      group.appendChild(opt);
    }
    els.model.appendChild(group);
  }
  modelCount = models.length;

  // 回填「本列真实模型」：同一 client 重建可沿用原选择；换列只认 pendingModel，
  // 绝不把上一列的下拉值带过来。没有真实值时也不假选首项（selectedIndex = -1）。
  const wanted = pendingModel ?? keep ?? null;
  if (wanted) applyModelToSelect(wanted);
  else {
    els.model.selectedIndex = -1;
    delete els.model.dataset.current;
  }
}

/** 切列/刷新时先用本列已知值回填（不显示上一列的模型/目录） */
function paintHeaderOptimistic(col) {
  if (!col) return;
  const clientId = col.clientId;
  pendingModel = col.model ?? null;
  pendingThinking = col.thinkingLevel ?? null;
  if (modelClientId !== clientId) renderModelOptions(clientId);
  else if (pendingModel) applyModelToSelect(pendingModel);
  else applyModelToSelect(null);
  if (pendingThinking) applyThinkingToSelect(pendingThinking);
  else els.thinking.selectedIndex = -1;
  paintWsPath(col.cwd);
  paintMcpBadges();
}

/** 把一次 session/view 响应写进顶栏（只在它仍是活动列时调用） */
function paintHeaderFromSession(col, view) {
  if (!col || !view) return;
  if (view.model?.provider && view.model?.id) applyModelToSelect(`${view.model.provider}/${view.model.id}`);
  else applyModelToSelect(null);
  if (typeof view.thinkingLevel === "string" && view.thinkingLevel) applyThinkingToSelect(view.thinkingLevel);
  else els.thinking.selectedIndex = -1;
  paintWsPath(view.cwd || col.cwd || "");
  paintMcpBadges();
}

/** 把 view 缓存到列上（切列时可直接回填，不必等下一次请求） */
function rememberSessionView(col, view) {
  if (!col || !view) return;
  const prev = sessionViews.get(col.clientId);
  // 引擎换了 cwd（新会话切目录/打开别的项目会话）→ 该列的模型候选清单已失效，
  // 必须重取；否则下拉会继续展示旧引擎的模型（本列真相被缓存绑架）。
  if (prev && prev.cwd && view.cwd && !sameCwd(prev.cwd, view.cwd)) modelsByClient.delete(col.clientId);
  sessionViews.set(col.clientId, view);
  if (typeof view.cwd === "string" && view.cwd) col.cwd = view.cwd;
  if (Array.isArray(view.mcp)) col.mcp = [...view.mcp];
  if (view.model?.provider && view.model?.id) col.model = `${view.model.provider}/${view.model.id}`;
  if (typeof view.thinkingLevel === "string" && view.thinkingLevel) col.thinkingLevel = view.thinkingLevel;
}

/**
 * 顶栏唯一同步入口（B1/T6）。数据只来自 /api/session/view?client=<本列>。
 * @param {object} [col] 默认活动列
 * @param {{delay?:number, force?:boolean}} [opts] delay 用于合并 columnUpdated 的抖动；
 *        force=true（openSession/newSession/session_attached）绕过 250ms 新鲜度复用。
 */
function syncHeaderFromSession(col = activeColumn(), { delay = 100, force = false } = {}) {
  const target = col ?? activeColumn();
  if (!target) return Promise.resolve(null);
  const clientId = target.clientId;

  // 切列先用本列缓存回填；没有缓存就用本列自己的已知值。两者都不会显示上一列的值。
  if (target === activeColumn()) {
    const cached = sessionViews.get(clientId);
    if (cached) paintHeaderFromSession(target, cached);
    else paintHeaderOptimistic(target);
  }

  const fresh = Date.now() - (headerSync.fetchedAt.get(clientId) ?? 0) < 250 && !force;
  if (fresh) return Promise.resolve(sessionViews.get(clientId) ?? null);

  const prevTimer = headerSync.timers.get(clientId);
  if (prevTimer) clearTimeout(prevTimer);
  const run = () => {
    headerSync.timers.delete(clientId);
    return runHeaderSync(target);
  };
  if (!delay) return run();
  const timer = setTimeout(run, delay);
  headerSync.timers.set(clientId, timer);
  return Promise.resolve(null);
}

async function runHeaderSync(col) {
  if (!col) return null;
  const clientId = col.clientId;
  const inflight = headerSync.inflight.get(clientId);
  if (inflight) {
    headerSync.again.add(clientId); // 请求期间又被触发：完成后再补一次
    return inflight;
  }
  const task = (async () => {
    // 引擎还没完成握手（not_started/starting）时视图必然 503：等 columnUpdated 再来，
    // 不去打一枪注定失败、只会污染控制台的请求。
    if (col.state === "not_started" || col.state === "starting") return null;
    let view = null;
    try {
      const res = await fetch(`/api/session/view?client=${encodeURIComponent(clientId)}`, { cache: "no-store" });
      if (res.ok) view = await res.json();
      // 404（列已释放/未知 client）/ 503（pi 未完成握手）：保持本列已知值，不弹错
    } catch (err) {
      console.warn("session/view failed", err);
    }
    if (col.clientId !== clientId) return null; // N1-a 换号：旧响应作废
    if (view) {
      rememberSessionView(col, view);
      headerSync.fetchedAt.set(clientId, Date.now());
      if (col === activeColumn()) paintHeaderFromSession(col, view);
    }
    if (col === activeColumn()) await loadModels(col);
    return view;
  })();
  headerSync.inflight.set(clientId, task);
  try {
    return await task;
  } finally {
    headerSync.inflight.delete(clientId);
    if (headerSync.again.delete(clientId)) void syncHeaderFromSession(col, { delay: 0, force: true });
  }
}

/** 模型候选按 client 取 + 缓存（切列不会串清单） */
async function loadModels(col = activeColumn(), { refresh = false } = {}) {
  if (!col) return;
  const clientId = col.clientId;
  if (!refresh && modelsByClient.has(clientId)) {
    if (col === activeColumn()) {
      if (modelClientId !== clientId) renderModelOptions(clientId);
      else if (pendingModel) applyModelToSelect(pendingModel);
    }
    return;
  }
  try {
    const data = await (await fetch(`/api/models?client=${encodeURIComponent(clientId)}`, { cache: "no-store" })).json();
    if (col.clientId !== clientId) return;
    modelsByClient.set(clientId, Array.isArray(data?.models) ? data.models : []);
    if (col === activeColumn()) renderModelOptions(clientId);
  } catch (err) {
    console.warn("loadModels failed", err);
  }
}

async function loadThinkingLevels() {
  try {
    const { levels } = await (await fetch("/api/thinking-levels", { cache: "no-store" })).json();
    const previous = els.thinking.value; // 重建前的选中值（换模型时可能还适用）
    els.thinking.replaceChildren();
    for (const level of levels ?? []) {
      const opt = document.createElement("option");
      opt.value = level;
      opt.textContent = level;
      els.thinking.appendChild(opt);
    }
    // 回填：当前列的真实级别 > 重建前的选择。两者都没有时（冷启动、SSE 未到）
    // 才允许浏览器默认选中首项；有真实值但选项里找不到时显式不选，绝不假选首项。
    const wanted = pendingThinking ?? previous;
    if (wanted && applyThinkingToSelect(wanted)) return;
    if (wanted) els.thinking.selectedIndex = -1; // 找不到对应 option：不落到第一项（off）
  } catch (err) {
    console.warn("loadThinkingLevels failed", err);
  }
}

// 「⟳」重新检测已配置的模型：清桥侧缓存 + 重读 auth.json（不重启 pi）
els.reloadModels.addEventListener("click", async () => {
  if (els.reloadModels.disabled) return;
  els.reloadModels.disabled = true;
  try {
    const data = await postJson("/api/models/reload", {});
    modelsByClient.clear(); // 凭据变了：所有列的候选清单都失效
    await loadModels(activeColumn(), { refresh: true });
    toast(`已刷新（${data?.models ?? modelCount} 个可用）`);
    if (data?.needsEngineRestart) {
      showNotice("模型表已变，点头部「重启」生效");
    }
  } catch (err) {
    showNotice(`刷新模型失败：${err.message}`, true);
  } finally {
    els.reloadModels.disabled = false;
  }
});

els.model.addEventListener("change", async () => {
  const col = activeColumn();
  if (!col) return;
  const [provider, ...rest] = els.model.value.split("/");
  const modelId = rest.join("/");
  try {
    const data = await col.postJson("/api/model", { provider, modelId });
    els.model.dataset.current = els.model.value;
    // 用户选了清单里的模型：上一条「该模型不可用」占位项不再有意义
    for (const opt of [...els.model.options]) if (opt.dataset.unavailable) opt.remove();
    delete els.model.dataset.unavailable;
    col.applySessionState(data?.state);
    col.rememberWanted?.(data?.state); // P0：用户选的模型就是本列意图（引擎被回收后按它跟回）
    toast(`已切换模型：${provider} · ${modelId}`);
    await loadThinkingLevels(); // 换模型会改变可用思考级别
  } catch (err) {
    showNotice(`切换模型失败：${err.message}`, true);
  }
});

els.thinking.addEventListener("change", async () => {
  const col = activeColumn();
  if (!col) return;
  try {
    const data = await col.postJson("/api/thinking", { level: els.thinking.value });
    col.applySessionState(data?.state);
    col.rememberWanted?.(data?.state); // P0：用户选的思考级别同样是本列意图
    if (Array.isArray(data?.levels)) {
      els.thinking.replaceChildren();
      for (const level of data.levels) {
        const opt = document.createElement("option");
        opt.value = level;
        opt.textContent = level;
        els.thinking.appendChild(opt);
      }
      if (data.state?.thinkingLevel) applyThinkingToSelect(data.state.thinkingLevel);
    }
    toast(`思考级别：${els.thinking.value}`);
  } catch (err) {
    showNotice(`切换思考级别失败：${err.message}`, true);
  }
});

let extDialogResolve = null;

function showExtDialog(req, col = activeColumn()) {
  const box = document.createElement("div");
  box.className = "modal-box";
  const title = document.createElement("h2");
  title.textContent = req.title || req.method;
  box.appendChild(title);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "modal-body";
  let getValue = () => ({ cancelled: true });

  if (req.method === "select") {
    const list_ = document.createElement("div");
    list_.className = "modal-options";
    for (const option of req.options ?? []) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = option;
      b.addEventListener("click", () => {
        submitExt(req.id, { value: option }, col);
        close();
      });
      list_.appendChild(b);
    }
    bodyWrap.appendChild(list_);
  } else if (req.method === "confirm") {
    const msg = document.createElement("p");
    msg.textContent = req.message || "";
    bodyWrap.appendChild(msg);
    const yes = document.createElement("button");
    yes.textContent = "确定";
    yes.addEventListener("click", () => { submitExt(req.id, { confirmed: true }, col); close(); });
    const no = document.createElement("button");
    no.textContent = "否";
    no.addEventListener("click", () => { submitExt(req.id, { confirmed: false }, col); close(); });
    bodyWrap.append(yes, no);
  } else {
    const ta = document.createElement("textarea");
    ta.rows = req.method === "editor" ? 10 : 1;
    ta.value = req.prefill || "";
    ta.placeholder = req.placeholder || "";
    bodyWrap.appendChild(ta);
    getValue = () => ({ value: ta.value });
    const ok = document.createElement("button");
    ok.textContent = "提交";
    ok.addEventListener("click", () => { submitExt(req.id, getValue(), col); close(); });
    bodyWrap.appendChild(ok);
  }

  const cancel = document.createElement("button");
  cancel.textContent = req.timeout ? `取消（${Math.round(req.timeout / 1000)}s 自动）` : "取消";
  cancel.addEventListener("click", () => { submitExt(req.id, { cancelled: true }, col); close(); });
  box.appendChild(bodyWrap);
  box.appendChild(cancel);

  els.modal.replaceChildren(box);
  els.modal.hidden = false;

  function close() {
    els.modal.hidden = true;
    els.modal.replaceChildren();
    extDialogResolve = null;
  }
  extDialogResolve = close;
}

// ---------- 确认框（复用 #modal；不用 window.confirm：它会阻塞事件循环，且无头/有头行为不一致） ----------

let confirmResolve = null; // 非 null 表示当前 #modal 上是本确认框（Esc 由全局 keydown 交给它）

/**
 * 最小确认框：Enter=确认 / Esc=取消。#modal 是单例容器，已有确认框在等时直接当「取消」返回。
 * @returns {Promise<boolean>}
 */
function confirmModal(text, { title = "请确认", confirmText = "继续", cancelText = "取消" } = {}) {
  if (confirmResolve) return Promise.resolve(false);
  if (extDialogResolve) extDialogResolve(); // #modal 是单例：扩展对话框让位（等同按 Esc，不改变它自己的行为）
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "modal-box";
    box.dataset.role = "confirm-box";

    const heading = document.createElement("h2");
    heading.textContent = title;

    const bodyWrap = document.createElement("div");
    bodyWrap.className = "modal-body";
    const msg = document.createElement("p");
    msg.dataset.role = "confirm-text";
    msg.textContent = text;
    const options = document.createElement("div");
    options.className = "modal-options";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.dataset.role = "confirm-continue";
    yes.textContent = confirmText;
    const no = document.createElement("button");
    no.type = "button";
    no.dataset.role = "confirm-cancel";
    no.textContent = cancelText;
    options.append(yes, no);
    bodyWrap.append(msg, options);
    box.append(heading, bodyWrap);

    els.modal.replaceChildren(box);
    els.modal.hidden = false;

    function onKey(ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault(); // 压掉按钮的默认 Enter 激活，保证「Enter=继续」只有一条路径
      done(true);
    }
    function done(value) {
      document.removeEventListener("keydown", onKey, true);
      if (confirmResolve !== done) return;
      confirmResolve = null;
      els.modal.hidden = true;
      els.modal.replaceChildren();
      resolve(value);
    }

    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    document.addEventListener("keydown", onKey, true); // 捕获阶段：先于 composer 的 Ctrl+Enter 发送
    confirmResolve = done;
    yes.focus();
  });
}

/** 扩展对话框回执：必须回到「弹出它的那一列」的引擎（clientId 决定 pi 进程） */
async function submitExt(id, payload, col = activeColumn()) {
  try {
    if (!col) throw new Error("没有活动列");
    await col.postJson("/api/ext-ui-response", { id, ...payload });
  } catch (err) {
    showNotice(`回执失败：${err.message}`, true);
  }
}

// ---------- A1：新会话 · 选项目目录（桌面居中卡片 / ≤768 底部抽屉） ----------
// 列表来源：/api/sessions 各分组 cwd（去重，最近使用优先）+ localStorage 最近 5 个；
// 「其他目录…」手输（C:\... 与 C:/... 都原样交给桥，桥自己 resolve）。
// 弹层单例：开着时再点「新会话」不叠第二层（直接返回 false）。

const RECENT_DIRS_KEY = "pi-shell.recentDirs";
const RECENT_DIRS_MAX = 5;
let pickerState = null; // { resolve, col } —— 非 null 表示弹层开着

/** 只用于去重/比较（尾部分隔符 + 分隔符方向 + 大小写）；回传给桥的是原串 */
function normDir(p) {
  return String(p || "").trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

function readRecentDirs() {
  try {
    const raw = localStorage.getItem(RECENT_DIRS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => typeof p === "string" && p.trim()).slice(0, RECENT_DIRS_MAX);
  } catch {
    return []; // 隐私模式/坏数据：当作没有最近记录，不影响选目录
  }
}

function rememberDir(dir) {
  const clean = String(dir || "").trim();
  if (!clean) return;
  const key = normDir(clean);
  const next = [clean, ...readRecentDirs().filter((p) => normDir(p) !== key)].slice(0, RECENT_DIRS_MAX);
  try {
    localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(next));
  } catch {}
}

/** 候选目录：会话分组里的 cwd（按最近会话时间倒序）+ 最近用过的目录（去重） */
function projectDirCandidates() {
  const seen = new Map(); // normDir → { cwd, at }
  const touch = (cwd, at) => {
    if (typeof cwd !== "string" || !cwd.trim()) return;
    const key = normDir(cwd);
    const prev = seen.get(key);
    if (!prev) seen.set(key, { cwd, at: at || 0 });
    else if ((at || 0) > prev.at) {
      prev.cwd = cwd;
      prev.at = at || 0;
    }
  };
  for (const group of list.model.groups ?? []) {
    const at = (group.sessions ?? []).reduce((max, s) => Math.max(max, Date.parse(s.updatedAt) || 0), 0);
    touch(group.cwd, at);
  }
  // Q3：origin=agent 的会话被上提到独立板块，分组里没有它们 → 单条也带 cwd
  for (const session of list.model.agentSessions ?? []) touch(session.cwd, Date.parse(session.updatedAt) || 0);
  const fromSessions = [...seen.values()].sort((a, b) => b.at - a.at).map((x) => x.cwd);
  const recents = readRecentDirs();
  const recentKeys = new Set(recents.map(normDir));
  return [...recents, ...fromSessions.filter((cwd) => !recentKeys.has(normDir(cwd)))];
}

function setPickerError(text) {
  if (!els.pickerError) return;
  els.pickerError.textContent = text || "";
  els.pickerError.hidden = !text;
}

function selectDirRow(row) {
  for (const r of els.pickerList.querySelectorAll('[data-role="picker-dir"]')) {
    const on = r === row;
    r.classList.toggle("is-selected", on);
    r.setAttribute("aria-selected", on ? "true" : "false");
  }
  if (row) setPickerError("");
}

/** 打开弹层；resolve(true) = 已在选定目录建好新会话，resolve(false) = 取消 */
function pickProjectDir(col) {
  if (!els.picker || pickerState) return Promise.resolve(false);

  const dirs = projectDirCandidates();
  const current = String(col?.cwd || "").trim();
  if (current && !dirs.some((d) => normDir(d) === normDir(current))) dirs.unshift(current);

  els.pickerList.replaceChildren();
  els.pickerPath.value = "";
  els.pickerPath.hidden = true;
  els.pickerOther.setAttribute("aria-expanded", "false");
  els.pickerConfirm.disabled = false;
  els.pickerCancel.disabled = false;
  setPickerError("");

  const rows = [];
  for (const dir of dirs) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "picker-dir";
    row.dataset.role = "picker-dir";
    row.dataset.cwd = dir;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.title = dir;
    const name = document.createElement("span");
    name.className = "picker-dir-name";
    name.textContent = shortWorkspace(dir) || dir;
    const full = document.createElement("span");
    full.className = "picker-dir-path";
    full.textContent = dir;
    row.append(name, full);
    row.addEventListener("click", () => {
      els.pickerPath.hidden = true; // 点已有目录 = 退出「其他目录」手输模式
      els.pickerOther.setAttribute("aria-expanded", "false");
      selectDirRow(row);
    });
    els.pickerList.appendChild(row);
    rows.push(row);
  }
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "picker-empty";
    empty.textContent = "还没有用过任何项目目录：点「其他目录…」填一个路径。";
    els.pickerList.appendChild(empty);
  }

  els.picker.hidden = false;
  const promise = new Promise((resolve) => {
    pickerState = { resolve, col };
  });
  // 默认选中当前列所在目录；没有当前目录（或不在列表里）时选第一个
  const preferred = rows.find((r) => normDir(r.dataset.cwd) === normDir(current)) ?? rows[0];
  if (preferred) selectDirRow(preferred);
  preferred?.focus();
  return promise;
}

function closePicker(ok) {
  if (!pickerState) return;
  const { resolve, col } = pickerState;
  pickerState = null;
  els.picker.hidden = true;
  els.pickerList.replaceChildren();
  els.pickerPath.value = "";
  els.pickerPath.hidden = true;
  els.pickerOther.setAttribute("aria-expanded", "false");
  els.pickerConfirm.disabled = false;
  els.pickerCancel.disabled = false;
  setPickerError("");
  col?.focus?.(); // 回到该列输入框（桌面；移动端同理）
  resolve(ok);
}

/** 确认：由列自己发 POST（clientId 决定是哪一列的引擎），失败停在弹层并就地显示原因 */
async function submitPicker() {
  if (!pickerState) return;
  const { col } = pickerState;
  if (!col) return closePicker(false);
  const manual = els.pickerPath.hidden === false;
  const cwd = manual
    ? els.pickerPath.value.trim().replace(/^"(.*)"$/, "$1")
    : els.pickerList.querySelector('.picker-dir.is-selected')?.dataset.cwd || "";
  if (!cwd) {
    setPickerError(manual ? "请填写目录路径" : "请选择项目目录");
    return;
  }
  els.pickerConfirm.disabled = true;
  els.pickerCancel.disabled = true;
  try {
    const data = await col.createSession(cwd);
    rememberDir(data?.cwd || cwd);
    closePicker(true);
  } catch (err) {
    els.pickerConfirm.disabled = false;
    els.pickerCancel.disabled = false;
    if (err?.status === 400) setPickerError("目录不存在或不是目录");
    else if (err?.status === 409) setPickerError("正在运行中：请先中止再新建会话");
    else if (err?.status === 503) setPickerError("pi 未就绪（503）：正在重启或已停止。");
    else setPickerError(`新建失败：${err?.message || err}`);
  }
}

els.picker?.addEventListener("pointerdown", (ev) => {
  if (ev.target === els.picker) closePicker(false); // 点遮罩 = 取消
});
els.pickerCancel?.addEventListener("click", () => closePicker(false));
els.pickerConfirm?.addEventListener("click", () => void submitPicker());
els.pickerOther?.addEventListener("click", () => {
  const revealed = els.pickerPath.hidden;
  els.pickerPath.hidden = !revealed;
  els.pickerOther.setAttribute("aria-expanded", revealed ? "true" : "false");
  if (revealed) {
    selectDirRow(null); // 手输模式 = 不选列表里的目录
    els.pickerPath.focus();
  }
});
els.pickerPath?.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault(); // 不要冒到 composer 的发送路径
  void submitPicker();
});

// ---------- 重启桥（第四批）：POST /api/restart → 桥 process.exit(75) → 启动脚本 1s 内拉起 ----------

/** 遮罩文案：只有「重启中 / 成功 / 失败」三种，测试按文本断言 */
function setRestartText(title, note = "", kind = "info") {
  els.restartTitle.textContent = title;
  els.restartNote.textContent = note;
  els.restartNote.dataset.kind = kind;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 重启流程：确认 → POST /api/restart（桥先回 200 再退出）→ 遮罩 → 每 400ms 探 health。
 *
 * 为什么必须輪询而不是只看 SSE：桥退出时 SSE 直接断开，客户端拿不到任何「已重启」信号；
 * 只有 health 里出现一个**新** pi pid 才能证明桥 + pi 真的起来了。
 * 32s 内没有新 pid → 说明没有启动脚本守护（手动 node 起的桥不会自己回来）→ 告诉用户用桌面快捷方式。
 */
async function restartBridge() {
  const ok = await confirmModal(
    "重启会先停掉所有 pi 子进程再退出。启动脚本（桌面「pi-shell」）会在 1s 内拉起新代码。继续？",
    { title: "重启桥", confirmText: "重启", cancelText: "取消" },
  );
  if (!ok) return;

  const oldPid = lastPiPid;
  els.restartClose.hidden = true;
  els.restartOverlay.hidden = false;
  setRestartText("桥正在重启…", "正在等待新代码启动（最多 35 秒）");

  try {
    await postJson("/api/restart");
  } catch {
    // 桥可能在响应写完前就 exit(75)：这不算失败，下面的 health 輪询才是判据
  }

  const deadline = Date.now() + 32000;
  while (Date.now() < deadline) {
    await sleep(400);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const body = await res.json();
      const pid = body?.pi?.pid ?? null;
      const fresh = pid != null && pid !== oldPid;
      if (body?.ok && fresh) {
        setRestartText("桥已重启", `新 pi pid ${pid}，正在刷新页面…`);
        toast("桥已重启");
        await sleep(600); // 让遮罩/ toast 看得到，再刷新（刷新后本轮事件全断，不依赖它）
        location.reload();
        return;
      }
    } catch {
      // 桥还没回来：继续等
    }
  }

  // 超时：手动起的桥没有守护进程，退出后不会自己回来
  setRestartText(
    "未能自动恢复，请双击桌面上的「重启 pi-shell」",
    "未检测到守护进程（重启循环）：手动用 node 起的桥退出后不会自动回来。",
    "error",
  );
  els.restartClose.hidden = false;
}

els.restartBridge.addEventListener("click", () => restartBridge());
els.restartClose.addEventListener("click", () => {
  els.restartOverlay.hidden = true;
});

// ---------- 斜杠命令（v1.3.0）：数据层在这里，面板 DOM/交互在每列内（column.js） ----------
// 为什么拆开：命令数据是全局的（/api/commands），面板必须作用于「触发它的那一列」的输入框。
// 旧实现（居中模态 #palette）已删除：选中即发送、× 与 ⋯ 菜单项从未绑定事件。

let commandCache = [];
let commandInflight = null;
let commandFetchedAt = 0;
// 每敲一个字符都会走一次「保持面板」→ 命令清单不该每键一次 RPC（1s 内的重复请求直接吃缓存）
const COMMAND_TTL_MS = 1000;

/** 取命令列表：并发只跑一次，失败回退上次缓存（不 reject，面板自己显示空态） */
function loadCommands() {
  if (commandInflight) return commandInflight;
  if (commandCache.length && Date.now() - commandFetchedAt < COMMAND_TTL_MS) return Promise.resolve(commandCache);
  commandInflight = (async () => {
    try {
      const res = await fetch("/api/commands", { cache: "no-store" });
      const body = await res.json();
      commandCache = Array.isArray(body?.commands) ? body.commands : [];
      commandFetchedAt = Date.now();
    } catch (err) {
      showNotice(`读取命令失败：${err.message}`, true);
    } finally {
      commandInflight = null;
    }
    return commandCache;
  })();
  return commandInflight;
}

if (els.openPalette) {
  // ⋯ 菜单 →「命令面板」：过去注册了元素但从未绑定（点了没反应）
  els.openPalette.addEventListener("click", () => {
    const col = activeColumn();
    if (!col) return;
    col.openCommandPanel({ query: "" });
  });
}

// ---------- 偏好（T-21）：localStorage + 降级 ----------

const PREFS_KEY = "pi-shell.prefs";
const DEFAULT_PREFS = { theme: "system", density: "comfortable", font: "normal", hints: true };
let prefs = { ...DEFAULT_PREFS };
let storageBroken = false;

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    storageBroken = true;
    return { ...DEFAULT_PREFS };
  }
}

function writePrefs(next) {
  prefs = { ...DEFAULT_PREFS, ...next };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    if (!storageBroken) {
      storageBroken = true;
      toast("浏览器禁用了 localStorage：偏好只在本次会话生效", "warning");
    }
  }
}

function applyPrefs() {
  const root = document.documentElement;
  const prevDensity = root.dataset.density;
  root.dataset.theme = prefs.theme; // system = 跟随 prefers-color-scheme
  root.dataset.density = prefs.density;
  root.dataset.font = prefs.font;
  document.body.dataset.hints = prefs.hints ? "on" : "off";
  els.prefTheme.value = prefs.theme;
  els.prefDensity.value = prefs.density;
  els.prefFont.value = prefs.font;
  els.prefHints.checked = !!prefs.hints;
  // B8：行高来自 CSS token（--row-session-h），密度换了要重算虚拟列表行表
  if (prevDensity && prevDensity !== prefs.density) list.relayout?.();
}

prefs = readPrefs();
applyPrefs();
if (storageBroken) toast("浏览器禁用了 localStorage：偏好只在本次会话生效", "warning");

els.openSettings.addEventListener("click", () => (els.settings.hidden = false));
els.settingsClose.addEventListener("click", () => (els.settings.hidden = true));
els.prefTheme.addEventListener("change", () => { writePrefs({ ...prefs, theme: els.prefTheme.value }); applyPrefs(); });
els.prefDensity.addEventListener("change", () => { writePrefs({ ...prefs, density: els.prefDensity.value }); applyPrefs(); });
els.prefFont.addEventListener("change", () => { writePrefs({ ...prefs, font: els.prefFont.value }); applyPrefs(); });
els.prefHints.addEventListener("change", () => { writePrefs({ ...prefs, hints: els.prefHints.checked }); applyPrefs(); });
els.settingsReset.addEventListener("click", () => { writePrefs({ ...DEFAULT_PREFS }); applyPrefs(); toast("偏好已恢复默认"); });

// ---------- MCP（按需）：⋯ → MCP 面板，逐个勾选本列要启用的 server ----------
// 语义：
//   · 默认不带任何 MCP（引擎 ≈90MB 对比全开 ≈480MB）；
//   · 勾选/取消 → POST /api/engine/restart（换子进程，pi 不支持进程内懒加载）→ 会话不变；
//   · 面板只作用于「当前活动列」，后台列各自独立。

const mcpPanel = { open: false, state: null, pending: false };

function mcpEls() {
  return {
    panel: $("mcp-panel"),
    sub: $("mcp-sub"),
    list: $("mcp-list"),
    status: $("mcp-status"),
    close: $("mcp-close"),
    open: $("open-mcp"),
    badge: $("open-mcp-badge"),
  };
}

function setMcpStatus(text, kind = "info") {
  const { status } = mcpEls();
  if (!status) return;
  status.textContent = text || "";
  status.dataset.kind = kind;
  status.hidden = !text;
}

/** 列头 / 菜单里的数量徽标（全列合计，一眼看出哪列带 MCP） */
function paintMcpBadges() {
  const total = columns.reduce((n, c) => n + (c.mcp?.length ?? 0), 0);
  const { badge } = mcpEls();
  if (badge) {
    badge.textContent = total ? String(total) : "";
    badge.hidden = total === 0;
  }
  for (const col of columns) col.paintHead(columns.indexOf(col));
}

function renderMcpList(col, state) {
  const { list, sub } = mcpEls();
  if (!list) return;
  const current = new Set(col?.mcp ?? []);
  const available = Array.isArray(state?.available) ? state.available : [];
  list.textContent = "";
  if (!available.length) {
    const empty = document.createElement("p");
    empty.className = "mcp-row-empty";
    empty.textContent = "mcp.json 里没有配置任何 server（在 ~/.pi/agent/mcp.json 添加后重开本面板）。";
    list.appendChild(empty);
  }
  for (const server of available) {
    const row = document.createElement("div");
    row.className = "mcp-row";
    row.dataset.server = server.name;

    const text = document.createElement("span");
    text.className = "mcp-row-text";
    const name = document.createElement("span");
    name.className = "mcp-row-name";
    name.textContent = server.name;
    const desc = document.createElement("span");
    desc.className = "mcp-row-desc";
    desc.textContent = server.description || (server.transport === "http" ? "HTTP server" : "stdio server");
    desc.title = desc.textContent;
    text.append(name, desc);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "mcp-switch";
    input.setAttribute("role", "switch");
    input.dataset.server = server.name;
    input.checked = current.has(server.name);
    input.disabled = mcpPanel.pending;
    input.setAttribute("aria-label", `启用 ${server.name}`);
    input.title = input.checked ? "已启用（取消会重启本列引擎）" : "未启用（勾选会重启本列引擎）";
    input.addEventListener("change", () => toggleMcpServer(col, server.name, input.checked));

    row.append(text, input);
    list.appendChild(row);
  }
  if (sub) {
    const ruleHit = state?.rules?.length ? ` · cwd 规则 ${state.rules.length} 条` : "";
    const def = state?.default?.length ? `默认 ${state.default.join("+")}` : "默认不带";
    sub.textContent = `列 ${columns.indexOf(col) + 1} · ${def}${ruleHit} · 已启用 ${current.size} 项`;
  }
}

async function openMcpPanel() {
  const col = activeColumn();
  const { panel } = mcpEls();
  if (!col || !panel) return;
  mcpPanel.open = true;
  panel.hidden = false;
  setMcpStatus("");
  let state = null;
  try {
    const res = await fetch("/api/mcp/state", {
      cache: "no-store",
      headers: { "X-Pi-Shell-Client": col.clientId },
    });
    state = await res.json();
    if (!res.ok) throw new Error(state?.error || `HTTP ${res.status}`);
  } catch (err) {
    setMcpStatus(`读取 MCP 配置失败：${err.message}`, "error");
  }
  mcpPanel.state = state;
  renderMcpList(col, state || {});
}

function closeMcpPanel() {
  const { panel } = mcpEls();
  mcpPanel.open = false;
  if (panel) panel.hidden = true;
}

/** 勾选/取消一个 server → 重启本列引擎（会话不变）；失败则回滚开关状态 */
async function toggleMcpServer(col, name, on) {
  const { list } = mcpEls();
  if (mcpPanel.pending) return;
  const next = new Set(col.mcp ?? []);
  if (on) next.add(name);
  else next.delete(name);
  const desired = [...next];
  mcpPanel.pending = true;
  for (const input of list?.querySelectorAll(".mcp-switch") ?? []) input.disabled = true;
  setMcpStatus("正在重启本列引擎…");
  try {
    const res = await fetch("/api/engine/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Shell-Client": col.clientId },
      body: JSON.stringify({ client: col.clientId, mcp: desired }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
    col.mcp = Array.isArray(data?.mcp) ? [...data.mcp] : desired;
    if (data?.sessionKept === false) {
      setMcpStatus("已重启，但没能恢复原会话（已落新会话）", "error");
      toast("MCP 已切换：会话未能恢复", "warning");
    } else {
      setMcpStatus("");
      toast(`MCP ${col.mcp.length ? `已启用 ${col.mcp.join(" + ")}` : "已全部关闭"}（本列）`);
    }
    paintMcpBadges();
    renderMcpList(col, mcpPanel.state);
    // 引擎换了子进程：重新接管事件流，避免 SSE 停在旧 pid 上
    col.manualRetry?.();
    pollHealth();
  } catch (err) {
    setMcpStatus(`切换失败：${String(err.message).replace(/^PI_NOT_READY:\s*/, "")}`, "error");
    toast("MCP 切换失败", "error");
    renderMcpList(col, mcpPanel.state); // 回滚开关到真实状态
  } finally {
    mcpPanel.pending = false;
    for (const input of list?.querySelectorAll(".mcp-switch") ?? []) input.disabled = false;
  }
}

{
  const { open, close, panel } = mcpEls();
  open?.addEventListener("click", () => openMcpPanel());
  close?.addEventListener("click", () => closeMcpPanel());
  panel?.addEventListener("pointerdown", (ev) => {
    if (ev.target === panel) closeMcpPanel(); // 点遮罩关闭
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && mcpPanel.open) closeMcpPanel();
  });
}

// ---------- 会话树（T-16）----------

function openPanel(title, { actionLabel, onAction } = {}) {
  // 其它面板接管时，「本轮改动」的刷新循环要停（避免往已卸载的节点里画）
  if (typeof changesPanel !== "undefined") {
    changesPanel.open = false;
    changesPanel.body = null;
  }
  els.panel.hidden = false;
  els.panelTitle.textContent = title;
  els.panelAction.hidden = !actionLabel;
  els.panelAction.textContent = actionLabel || "";
  els.panelAction.onclick = onAction || null;
  els.panelBody.replaceChildren();
}

els.panelClose.addEventListener("click", () => {
  els.panel.hidden = true;
  els.panelBody.replaceChildren();
});

function entryLabel(entry) {
  if (entry?.type !== "message") return `(${entry?.type || "entry"})`;
  const role = entry.message?.role || "?";
  const content = entry.message?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  const short = text.replace(/\s+/g, " ").slice(0, 48);
  return `${role}: ${short || "(无文本)"}`;
}

// ---------- 会话树：主干优先视图（docs/design/TREE-DISPLAY.md 方案 A）----------
// 默认只渲染「根 → 当前叶子」主干 + 每个主干节点的分支摘要行；分支 / 中间段 / 全树都按 500 行分页懒渲染。
// 缩进封顶 3 层（36px），真实深度交给等宽徽标 D<n>；DOM 行数硬上限 4000。
// 数据全部由 get_tree 的嵌套结构在客户端派生（不改桥）：父链 / depth / childCount / 子树节点数。
const TREE_INDENT_STEP = 12;
const TREE_INDENT_LEVELS = 3;
const TREE_ROW_CAP = 4000; // DOM 行数硬上限
const TREE_MAIN_ALL_MAX = 1500; // 主干超过它 → 根侧 300 + 叶子侧 1200，中间折叠
const TREE_MAIN_HEAD = 300;
const TREE_MAIN_TAIL = 1200;
const TREE_PAGE = 500; // 懒渲染分页

/** 从 get_tree 嵌套结构建客户端索引：父链 / 深度 / 子树节点数 / 搜索文本（O(n) 迭代，不递归） */
function buildSessionTreeIndex(tree) {
  const nodes = new Map();
  const order = [];
  const roots = Array.isArray(tree) ? tree : [];
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], parentId: null, depth: 0 });
  while (stack.length) {
    const { node, parentId, depth } = stack.pop();
    const entry = node?.entry || {};
    const id = entry.id || `__anon_${order.length}`;
    const record = { id, entry, parentId, depth, childIds: [], size: 1, text: "" };
    record.text = `${id} ${entryLabel(entry)}`.toLowerCase();
    nodes.set(id, record);
    order.push(id);
    if (parentId && nodes.has(parentId)) nodes.get(parentId).childIds.push(id);
    const kids = Array.isArray(node?.children) ? node.children : [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], parentId: id, depth: depth + 1 });
  }
  // 子树节点数：逆文档序累加（父永远先于子进入 order）
  for (let i = order.length - 1; i >= 0; i--) {
    const record = nodes.get(order[i]);
    for (const childId of record.childIds) record.size += nodes.get(childId)?.size || 0;
  }
  return { nodes, order };
}

/** leaf → root 回溯再倒序 = 时间正序的主干 */
function sessionMainPath(index, leafId) {
  let id = leafId && index.nodes.has(leafId) ? leafId : index.order[index.order.length - 1];
  const path = [];
  const seen = new Set();
  while (id && index.nodes.has(id) && !seen.has(id)) {
    seen.add(id);
    const record = index.nodes.get(id);
    path.push(record);
    id = record.parentId;
  }
  return path.reverse();
}

function treeKindSymbol(entry) {
  if (entry?.type !== "message") return "·";
  const role = entry.message?.role;
  if (role === "user") return "○";
  if (role === "assistant") return "◆";
  if (role === "tool" || role === "toolResult") return "▸";
  if (role === "system") return "▪";
  return "◇";
}

function treeClock(timestamp) {
  const date = timestamp ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 一行 = 一个 div（不嵌套）；缩进 = min(depth,3)*12px，分支行 +12px 且同样封顶 36px */
function treeRowElement(record, { branch = false, isLeaf = false } = {}) {
  const el = document.createElement("div");
  el.className = "tree-row tree-node";
  if (branch) el.classList.add("is-branch");
  el.dataset.entryId = record.id;
  el.dataset.depth = String(record.depth);
  const level = branch ? Math.min(record.depth, TREE_INDENT_LEVELS) + 1 : Math.min(record.depth, TREE_INDENT_LEVELS);
  el.style.paddingLeft = `${Math.min(level, TREE_INDENT_LEVELS) * TREE_INDENT_STEP}px`;
  el.dataset.leaf = isLeaf ? "true" : "false";
  if (isLeaf) el.classList.add("is-leaf");
  // PIX-2：行是可选中对象（roving tabindex：选中行 0，其余 -1，j/k 走真实焦点）
  el.tabIndex = -1;
  el.setAttribute("role", "option");
  el.setAttribute("aria-selected", "false");

  const time = document.createElement("span");
  time.className = "tree-time";
  time.textContent = treeClock(record.entry?.timestamp);
  const kind = document.createElement("span");
  kind.className = "tree-kind";
  kind.textContent = treeKindSymbol(record.entry);
  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = entryLabel(record.entry);
  label.title = label.textContent;
  el.append(time, kind, label);

  if (isLeaf) {
    const current = document.createElement("span");
    current.className = "tree-current";
    current.textContent = "当前";
    el.appendChild(current);
  }
  if (record.depth > TREE_INDENT_LEVELS) {
    const badge = document.createElement("span");
    badge.className = "tree-depth";
    badge.textContent = `D${record.depth}`;
    el.appendChild(badge);
  }
  if (record.entry?.type === "message" && record.entry?.message?.role === "user") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tree-fork";
    btn.textContent = "fork";
    btn.dataset.forkEntry = record.id;
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); forkAt(record.id); });
    el.appendChild(btn);
  }
  return el;
}

function renderTreeView(tree, leafId) {
  const index = buildSessionTreeIndex(tree);
  const total = index.order.length;

  const list = document.createElement("div");
  list.className = "tree tree-flat";
  list.dataset.role = "tree";
  list.dataset.leafId = leafId || "";
  els.panelBody.appendChild(list);

  if (!total) {
    const empty = document.createElement("p");
    empty.className = "panel-note";
    empty.textContent = "（这个会话还没有条目）";
    list.appendChild(empty);
    return;
  }

  const path = sessionMainPath(index, leafId);
  const mainIds = new Set(path.map((record) => record.id));
  const leafRecord = path[path.length - 1] || null;
  const rowsById = new Map();
  const branchStates = new Map();
  let rowCount = 0;
  let mode = "main";
  let fullLoaded = 0;
  let middleLoaded = 0;
  let middleStart = 0;
  let middleEnd = 0;
  let middleFold = null;
  let tailAnchor = null;

  // ---------- 工具条 + 搜索 ----------
  const toolbar = document.createElement("div");
  toolbar.className = "tree-toolbar";
  toolbar.dataset.role = "tree-toolbar";
  const stats = document.createElement("span");
  stats.className = "tree-stats";
  stats.dataset.role = "tree-stats";
  toolbar.appendChild(stats);
  const toolButton = (text, role) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tree-tool";
    btn.dataset.role = role;
    btn.textContent = text;
    toolbar.appendChild(btn);
    return btn;
  };
  const btnLocate = toolButton("跳到当前叶子", "tree-locate");
  const btnExpandAll = toolButton("展开全部（分页）", "tree-expand");
  const btnCollapseAll = toolButton("折叠全部", "tree-collapse");
  const btnBranchOnly = toolButton("仅看分支点", "tree-branch-only");
  btnBranchOnly.setAttribute("aria-pressed", "false");
  const btnSearchFocus = toolButton("搜索", "tree-search-focus");
  list.appendChild(toolbar);

  const searchRow = document.createElement("div");
  searchRow.className = "tree-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "tree-search-input";
  searchInput.placeholder = "搜索节点 id / 内容…";
  searchInput.dataset.role = "tree-search";
  const searchCount = document.createElement("span");
  searchCount.className = "tree-search-count";
  searchCount.dataset.role = "tree-search-count";
  searchRow.append(searchInput, searchCount);
  list.appendChild(searchRow);

  // ---------- PIX-2：节点信息条（选中节点的角色/时间/耗时/token + 三个操作）----------
  // 挂在 panel-body 末尾 + sticky bottom：只渲染一条，不随节点数增长（5000 节点也不加 DOM）。
  const nodeInfo = document.createElement("div");
  nodeInfo.className = "tree-nodeinfo";
  nodeInfo.dataset.role = "tree-nodeinfo";
  nodeInfo.hidden = true;
  const infoHead = document.createElement("div");
  infoHead.className = "tree-nodeinfo-head";
  const infoRole = document.createElement("span");
  infoRole.className = "tree-nodeinfo-role";
  infoRole.dataset.role = "tree-nodeinfo-role";
  const infoTime = document.createElement("span");
  infoTime.className = "tree-nodeinfo-time";
  infoTime.dataset.role = "tree-nodeinfo-time";
  const infoDur = document.createElement("span");
  infoDur.className = "tree-nodeinfo-dur";
  infoDur.dataset.role = "tree-nodeinfo-dur";
  const infoTokens = document.createElement("span");
  infoTokens.className = "tree-nodeinfo-tokens";
  infoTokens.dataset.role = "tree-nodeinfo-tokens";
  infoHead.append(infoRole, infoTime, infoDur, infoTokens);
  const infoText = document.createElement("div");
  infoText.className = "tree-nodeinfo-text";
  infoText.dataset.role = "tree-nodeinfo-text";
  const infoActions = document.createElement("div");
  infoActions.className = "tree-nodeinfo-actions";
  const actionButton = (label, role) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tree-nodeinfo-btn";
    btn.dataset.role = role;
    btn.textContent = label;
    infoActions.appendChild(btn);
    return btn;
  };
  const btnContinue = actionButton("从此处继续", "tree-continue");
  const btnCopy = actionButton("复制消息", "tree-copy");
  const btnGoto = actionButton("在对话中定位", "tree-goto");
  nodeInfo.append(infoHead, infoText, infoActions);
  els.panelBody.appendChild(nodeInfo);

  // ---------- DOM 行预算（硬上限 4000）----------
  const remaining = () => TREE_ROW_CAP - rowCount;
  const addRow = (el, before = null) => {
    if (remaining() <= 0) return false;
    if (before && before.parentNode === list) list.insertBefore(el, before);
    else list.appendChild(el);
    rowCount++;
    return true;
  };
  const addBatch = (els, before = null) => {
    let added = 0;
    if (before && before.parentNode === list) {
      for (const el of els) {
        if (remaining() <= 0) break;
        list.insertBefore(el, before);
        rowCount++;
        added++;
      }
      return added;
    }
    const fragment = document.createDocumentFragment();
    for (const el of els) {
      if (remaining() <= 0) break;
      fragment.appendChild(el);
      rowCount++;
      added++;
    }
    if (fragment.childNodes.length) list.appendChild(fragment);
    return added;
  };
  const removeRows = (els) => {
    for (const el of els) {
      if (!el || !el.parentNode) continue;
      el.remove();
      rowCount = Math.max(0, rowCount - 1);
      const id = el.dataset?.entryId;
      if (id && rowsById.get(id) === el) rowsById.delete(id);
    }
  };
  const clearRows = () => {
    for (const el of [...list.querySelectorAll(":scope > .tree-row")]) el.remove();
    rowCount = 0;
    rowsById.clear();
    branchStates.clear();
    middleFold = null;
    tailAnchor = null;
    middleLoaded = 0;
    middleStart = 0;
    middleEnd = 0;
    fullLoaded = 0;
  };

  const syncStats = () => {
    stats.textContent = mode === "branch"
      ? `仅分支点 ${branchList.length} / ${total} 节点 · 显示 ${rowCount}`
      : `共 ${total} 节点 · 显示 ${rowCount}`;
    if (mode === "full") {
      if (remaining() <= 0) {
        btnExpandAll.textContent = `已达 DOM 上限 ${TREE_ROW_CAP} 行`;
        btnExpandAll.disabled = true;
      } else if (fullLoaded >= total) {
        btnExpandAll.textContent = "已全部展开";
        btnExpandAll.disabled = true;
      } else {
        btnExpandAll.textContent = `继续展开（剩余 ${total - fullLoaded} 节点）`;
        btnExpandAll.disabled = false;
      }
    } else {
      btnExpandAll.textContent = "展开全部（分页）";
      btnExpandAll.disabled = remaining() <= 0;
    }
  };

  // ---------- 主干 + 分支摘要 ----------
  const mainRow = (record) => {
    const el = treeRowElement(record, { isLeaf: record.id === leafRecord?.id });
    rowsById.set(record.id, el);
    return el;
  };

  const branchRecords = (offs) => {
    const out = [];
    const stack = [];
    for (let i = offs.length - 1; i >= 0; i--) stack.push(offs[i]);
    while (stack.length) {
      const record = index.nodes.get(stack.pop());
      if (!record) continue;
      out.push(record);
      for (let i = record.childIds.length - 1; i >= 0; i--) stack.push(record.childIds[i]);
    }
    return out;
  };

  const loadBranchPage = (record, state) => {
    if (!state.records) state.records = branchRecords(state.offs);
    const room = Math.max(0, remaining());
    const chunk = state.records.slice(state.loaded, state.loaded + Math.min(TREE_PAGE, room));
    if (chunk.length) {
      const els = [];
      for (const node of chunk) {
        const el = treeRowElement(node, { branch: true });
        rowsById.set(node.id, el);
        state.rowEls.push(el);
        els.push(el);
      }
      addBatch(els, state.loadEl && state.loadEl.parentNode === list ? state.loadEl : null);
      state.loaded += chunk.length;
    }
    const left = state.records.length - state.loaded;
    if (state.loadEl) {
      if (left > 0 && remaining() > 0) {
        state.loadEl.hidden = false;
        state.loadEl.querySelector("button").textContent = `继续加载这层（还有 ${left} 行）`;
        state.loadEl.querySelector("button").disabled = false;
      } else if (left > 0) {
        state.loadEl.hidden = false;
        state.loadEl.querySelector("button").textContent = `已达 DOM 上限 ${TREE_ROW_CAP} 行`;
        state.loadEl.querySelector("button").disabled = true;
      } else {
        removeRows([state.loadEl]);
        state.loadEl = null;
      }
    }
    state.textEl.textContent = `−${state.offCount} 分支 · 展开 ${state.loaded}/${state.folded} 层`;
    syncStats();
  };

  const toggleBranch = (record, summaryEl, textEl, offs, folded) => {
    let state = branchStates.get(record.id);
    if (state?.expanded) {
      removeRows(state.rowEls);
      if (state.loadEl) removeRows([state.loadEl]);
      state.rowEls = [];
      state.loadEl = null;
      state.loaded = 0;
      state.expanded = false;
      summaryEl.setAttribute("aria-expanded", "false");
      textEl.textContent = `+${offs.length} 分支 · 折叠 ${folded} 层`;
      syncStats();
      return;
    }
    if (!state) {
      state = {
        expanded: false,
        records: null,
        offs,
        folded,
        offCount: offs.length,
        loaded: 0,
        rowEls: [],
        loadEl: null,
        summaryEl,
        textEl,
      };
      branchStates.set(record.id, state);
    }
    state.expanded = true;
    summaryEl.setAttribute("aria-expanded", "true");
    if (!state.records) state.records = branchRecords(offs);
    if (!state.loadEl && state.loaded < state.records.length && remaining() > 0) {
      const loadEl = document.createElement("div");
      loadEl.className = "tree-row tree-more";
      loadEl.dataset.role = "tree-more";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-more-btn";
      btn.textContent = "继续加载这层";
      btn.addEventListener("click", () => loadBranchPage(record, state));
      loadEl.appendChild(btn);
      summaryEl.after(loadEl);
      rowCount++;
      state.loadEl = loadEl;
    }
    loadBranchPage(record, state);
  };

  const summaryFor = (record) => {
    const offs = record.childIds.filter((id) => !mainIds.has(id));
    if (!offs.length) return null;
    const folded = offs.reduce((sum, id) => sum + (index.nodes.get(id)?.size || 0), 0);
    const el = document.createElement("div");
    el.className = "tree-row tree-branch-summary";
    el.dataset.role = "tree-branch-summary";
    el.dataset.branchOf = record.id;
    el.dataset.folded = String(folded);
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-expanded", "false");
    const text = document.createElement("span");
    text.className = "tree-branch-text";
    text.textContent = `+${offs.length} 分支 · 折叠 ${folded} 层`;
    el.appendChild(text);
    const activate = (ev) => {
      if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      toggleBranch(record, el, text, offs, folded);
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", activate);
    return el;
  };

  // ---------- 中间折叠区（超长主干）----------
  const syncMiddleFold = () => {
    if (!middleFold) return;
    const left = middleEnd - middleStart - middleLoaded;
    middleFold._text.textContent = left > 0 ? `… 折叠中间 ${left} 个主干节点` : "… 中间主干已全部展开";
    middleFold._btn.textContent = left <= 0 ? "已展开" : remaining() <= 0 ? `已达 DOM 上限 ${TREE_ROW_CAP} 行` : "展开 500";
    middleFold._btn.disabled = left <= 0 || remaining() <= 0;
  };

  const loadMiddlePage = () => {
    const left = middleEnd - middleStart - middleLoaded;
    if (left <= 0) return;
    const want = Math.min(TREE_PAGE, left);
    const els = [];
    let placed = 0;
    while (placed < want && rowCount + els.length < TREE_ROW_CAP) {
      const record = path[middleStart + middleLoaded + placed];
      if (!record) break;
      els.push(mainRow(record));
      const summary = summaryFor(record);
      if (summary && rowCount + els.length < TREE_ROW_CAP) els.push(summary);
      placed++;
    }
    if (!placed) { syncMiddleFold(); syncStats(); return; }
    addBatch(els, tailAnchor);
    middleLoaded += placed;
    syncMiddleFold();
    syncStats();
  };

  // ---------- 视图：主干 / 全树 ----------
  const buildMainView = () => {
    mode = "main";
    branchOnlyOn = false;
    syncBranchToggle();
    setSelected(null);
    clearRows();
    const longMain = path.length > TREE_MAIN_ALL_MAX;
    const headEnd = longMain ? Math.min(TREE_MAIN_HEAD, path.length) : path.length;
    middleStart = headEnd;
    middleEnd = longMain ? Math.max(headEnd, path.length - TREE_MAIN_TAIL) : headEnd;

    for (let i = 0; i < headEnd; i++) {
      const record = path[i];
      if (!addRow(mainRow(record))) break;
      const summary = summaryFor(record);
      if (summary) addRow(summary);
    }
    if (middleEnd > middleStart) {
      middleFold = document.createElement("div");
      middleFold.className = "tree-row tree-fold";
      middleFold.dataset.role = "tree-fold";
      const text = document.createElement("span");
      text.className = "tree-fold-text";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-more-btn";
      btn.dataset.role = "tree-fold-more";
      btn.addEventListener("click", () => loadMiddlePage());
      middleFold.append(text, btn);
      middleFold._text = text;
      middleFold._btn = btn;
      addRow(middleFold);
    }
    const tailEls = [];
    for (let i = middleEnd; i < path.length; i++) {
      const record = path[i];
      tailEls.push(mainRow(record));
      const summary = summaryFor(record);
      if (summary) tailEls.push(summary);
    }
    if (tailEls.length) {
      addBatch(tailEls);
      tailAnchor = tailEls[0];
    }
    syncMiddleFold();
    syncStats();
  };

  const loadFullPage = () => {
    const want = Math.min(TREE_PAGE, total - fullLoaded, Math.max(0, remaining()));
    if (want <= 0) { syncStats(); return; }
    const els = [];
    for (let i = 0; i < want; i++) {
      const record = index.nodes.get(index.order[fullLoaded + i]);
      const el = treeRowElement(record, { isLeaf: record.id === leafRecord?.id });
      rowsById.set(record.id, el);
      els.push(el);
    }
    addBatch(els);
    fullLoaded += want;
    syncStats();
  };

  const buildFullView = () => {
    mode = "full";
    branchOnlyOn = false;
    syncBranchToggle();
    setSelected(null);
    clearRows();
    loadFullPage();
  };

  // ---------- 仅看分支点：只留 user 节点 / 分叉点 / 当前叶子（降噪，仍是懒渲染分页）----------
  let branchOnlyOn = false;
  let branchList = [];
  let branchLoaded = 0;
  let branchIdSet = new Set();

  const branchKey = (record) => {
    const role = record.entry?.message?.role;
    if (record.entry?.type === "message" && role === "user") return true;
    if (record.childIds.length > 1) return true;
    return record.id === leafRecord?.id;
  };

  const syncBranchToggle = () => {
    btnBranchOnly.textContent = branchOnlyOn ? "看全部节点" : "仅看分支点";
    btnBranchOnly.setAttribute("aria-pressed", branchOnlyOn ? "true" : "false");
  };

  const loadBranchOnlyPage = () => {
    const want = Math.min(TREE_PAGE, branchList.length - branchLoaded, Math.max(0, remaining()));
    if (want <= 0) {
      syncStats();
      return;
    }
    const els = [];
    for (let i = 0; i < want; i++) {
      const record = branchList[branchLoaded + i];
      const el = treeRowElement(record, { isLeaf: record.id === leafRecord?.id });
      if (record.childIds.length > 1) el.dataset.branchPoint = "true";
      rowsById.set(record.id, el);
      els.push(el);
    }
    addBatch(els);
    branchLoaded += want;
    syncStats();
  };

  const buildBranchOnlyView = () => {
    mode = "branch";
    branchOnlyOn = true;
    branchList = index.order.map((id) => index.nodes.get(id)).filter(branchKey);
    branchIdSet = new Set(branchList.map((record) => record.id));
    const keep = selectedId;
    branchLoaded = 0;
    clearRows();
    loadBranchOnlyPage();
    syncBranchToggle();
    // 切换视图不掉选中：降噪视图里还能看到它，就把信息条接上（看不见才清空）
    setSelected(keep && branchIdSet.has(keep) ? keep : null);
  };

  // ---------- PIX-2：选中 / 定位 / 节点操作 / 键盘（树变成可操作对象）----------
  // 铁律：单击只选中（不切主对话、不滚主对话）；双击才滚动主对话并高亮 3s。
  let selectedId = null;
  let selectedRow = null;
  let selectedRecord = null;
  const ROLE_TEXT = { user: "你的消息", assistant: "pi 回复", tool: "工具结果", toolResult: "工具结果", system: "system" };

  const entryTextOf = (entry) => {
    const content = entry?.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block) => {
        if (block?.type === "text") return block.text || "";
        if (block?.type === "thinking") return `[思考] ${block.thinking || ""}`;
        if (block?.type === "toolCall") return `[工具] ${block.name || ""}`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  };

  const fmtMs = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n < 1000) return `${Math.round(n)}ms`;
    if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
    const total = Math.round(n / 1000);
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  };

  const nodeClock = (timestamp) => {
    const date = timestamp ? new Date(timestamp) : null;
    if (!date || Number.isNaN(date.getTime())) return "--:--:--";
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  };

  /** 本条耗时：实时条目带 durationMs；历史条目用「时间戳 − 最近 user 祖先时间戳」（≤30 分钟，否则不显示） */
  const nodeDuration = (record) => {
    const msg = record.entry?.message;
    if (msg?.durationMs != null) return fmtMs(msg.durationMs);
    const ts = Date.parse(String(record.entry?.timestamp ?? ""));
    if (!Number.isFinite(ts)) return "";
    let parent = record.parentId ? index.nodes.get(record.parentId) : null;
    let guard = 0;
    while (parent && guard++ < 20) {
      if (parent.entry?.message?.role === "user") {
        const start = Date.parse(String(parent.entry?.timestamp ?? ""));
        if (!Number.isFinite(start) || ts <= start) return "";
        const delta = ts - start;
        return delta <= 30 * 60 * 1000 ? fmtMs(delta) : "";
      }
      parent = parent.parentId ? index.nodes.get(parent.parentId) : null;
    }
    return "";
  };

  const isUserRecord = (record) => record?.entry?.type === "message" && record.entry.message?.role === "user";

  const paintNodeInfo = (record) => {
    if (!record) {
      nodeInfo.hidden = true;
      nodeInfo.removeAttribute("data-entry-id");
      return;
    }
    const msg = record.entry?.message;
    const role = msg?.role || record.entry?.type || "entry";
    nodeInfo.hidden = false;
    nodeInfo.dataset.entryId = record.id;
    infoRole.textContent = ROLE_TEXT[role] || role;
    infoTime.textContent = nodeClock(record.entry?.timestamp);
    const duration = nodeDuration(record);
    infoDur.textContent = duration ? `耗时 ${duration}` : "";
    infoDur.hidden = !duration;
    const tokens = Number(msg?.usage?.totalTokens);
    infoTokens.textContent = Number.isFinite(tokens) && tokens > 0 ? `${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : "";
    infoTokens.hidden = !infoTokens.textContent;
    const text = entryTextOf(record.entry).replace(/\s+/g, " ").trim();
    infoText.textContent = text ? (text.length > 140 ? `${text.slice(0, 140)}…` : text) : "（无文本）";
    // fork 只接受 user message（pi 实测）：非 user 节点给禁用态 + 文案说明，而不是隐藏
    const canFork = isUserRecord(record);
    btnContinue.disabled = !canFork;
    btnContinue.title = canFork ? "从此处继续：以这条消息为起点新建分支（POST /api/session/fork）" : "只能从你的消息处分叉";
    btnContinue.dataset.forkable = canFork ? "true" : "false";
  };

  const setSelected = (id, { focus = false } = {}) => {
    const row = id ? rowsById.get(id) : null;
    if (selectedRow && selectedRow !== row) {
      selectedRow.classList.remove("is-selected");
      selectedRow.setAttribute("aria-selected", "false");
      selectedRow.tabIndex = -1;
    }
    selectedId = row ? id : null;
    selectedRow = row || null;
    selectedRecord = row ? index.nodes.get(id) || null : null;
    list.dataset.selectedId = selectedId || "";
    if (!row) {
      paintNodeInfo(null);
      return;
    }
    row.classList.add("is-selected");
    row.setAttribute("aria-selected", "true");
    row.tabIndex = 0;
    if (focus) row.focus({ preventScroll: true });
    paintNodeInfo(selectedRecord);
  };

  const visibleRows = () => [...list.querySelectorAll(":scope > .tree-row.tree-node")];

  const moveSelection = (delta) => {
    const rows = visibleRows();
    if (!rows.length) return;
    const current = rows.findIndex((row) => row.dataset.entryId === selectedId);
    const next = current < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, current + delta));
    const row = rows[next];
    setSelected(row.dataset.entryId);
    row.scrollIntoView({ block: "nearest" });
    row.focus({ preventScroll: true });
  };

  const activeLog = () => activeColumn()?.root?.querySelector?.("[data-role=log]") || document.getElementById("log");

  /** 双击 = 定位：把主对话滚到该条目并高亮 3s；不在当前分支 → 额外提示可「从此处继续」 */
  const locateInConversation = (id) => {
    if (!id) return false;
    const log = activeLog();
    if (!log) return false;
    const node = log.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
    if (!node) {
      toast("该条目不在当前分支，可用「从此处继续」从它新建分支", "warning");
      return false;
    }
    // 主对话把整份 jsonl 按文件顺序渲染（含其它分支）→「不在当前分支」不能靠找不到节点判断，
    // 要用 get_tree 的当前叶子主干（mainIds）。
    if (!mainIds.has(id)) toast("该条目不在当前分支，可用「从此处继续」从它新建分支", "warning");
    for (const old of log.querySelectorAll(".is-located")) old.classList.remove("is-located");
    const logBox = log.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const target = log.scrollTop + (box.top - logBox.top) - Math.max(0, (log.clientHeight - box.height) / 2);
    log.scrollTop = Math.max(0, target);
    node.classList.add("is-located");
    clearTimeout(locateInConversation._t);
    locateInConversation._t = setTimeout(() => node.classList.remove("is-located"), 3000);
    return true;
  };

  const continueFrom = (id) => {
    const record = index.nodes.get(id);
    if (!record || !isUserRecord(record)) return false;
    forkAt(id); // 复用现有 fork 路径（成功 toast + refreshAfterBranch）
    return true;
  };

  const copySelected = async () => {
    if (!selectedRecord) return false;
    const text = entryTextOf(selectedRecord.entry).trim();
    try {
      await navigator.clipboard.writeText(text || entryLabel(selectedRecord.entry));
      toast("已复制消息");
      return true;
    } catch {
      toast("复制失败：浏览器拒绝了剪贴板访问", "warning");
      return false;
    }
  };

  const focusSearch = () => {
    searchInput.focus();
    searchInput.select();
  };

  btnContinue.addEventListener("click", () => continueFrom(selectedId));
  btnCopy.addEventListener("click", () => copySelected());
  btnGoto.addEventListener("click", () => locateInConversation(selectedId));
  btnBranchOnly.addEventListener("click", () => {
    if (branchOnlyOn) buildMainView();
    else buildBranchOnlyView();
  });
  btnSearchFocus.addEventListener("click", () => focusSearch());

  // 行级事件：单击选中（不碰主对话）/ 双击定位；按钮上的点击不参与选中
  list.addEventListener("click", (ev) => {
    if (ev.target.closest?.("button, [data-role=tree-branch-summary], .tree-more, .tree-fold")) return;
    const row = ev.target.closest?.(".tree-node");
    if (!row || !list.contains(row)) return;
    setSelected(row.dataset.entryId, { focus: true });
  });
  list.addEventListener("dblclick", (ev) => {
    if (ev.target.closest?.("button, [data-role=tree-branch-summary], .tree-more, .tree-fold")) return;
    const row = ev.target.closest?.(".tree-node");
    if (!row || !list.contains(row)) return;
    setSelected(row.dataset.entryId);
    locateInConversation(row.dataset.entryId);
  });

  // 键盘：j/k 上下移动选中 · Enter 定位 · f 从此处继续 · / 聚焦搜索
  list.addEventListener("keydown", (ev) => {
    if (ev.target === searchInput) return;
    if (ev.target.closest?.("[data-role=tree-branch-summary], .tree-more, .tree-fold")) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const key = ev.key;
    if (key === "j" || key === "ArrowDown") {
      ev.preventDefault();
      moveSelection(1);
    } else if (key === "k" || key === "ArrowUp") {
      ev.preventDefault();
      moveSelection(-1);
    } else if (key === "Enter") {
      ev.preventDefault();
      locateInConversation(selectedId);
    } else if (key === "f") {
      ev.preventDefault();
      continueFrom(selectedId);
    } else if (key === "/") {
      ev.preventDefault();
      focusSearch();
    }
  });

  // ---------- 搜索 / 定位 ----------
  const highlight = (el) => {
    el.scrollIntoView({ block: "center" });
    el.classList.add("is-search-hit");
    setTimeout(() => el.classList.remove("is-search-hit"), 1200);
  };

  const pathIndex = new Map(path.map((record, i) => [record.id, i]));

  const reveal = (id) => {
    const record = index.nodes.get(id);
    if (!record) return false;
    if (mode === "branch" && !branchIdSet.has(id)) buildMainView(); // 降噪视图里没这行 → 先回主干视图
    if (mode === "branch") {
      let guard = 0;
      while (!rowsById.has(id) && branchLoaded < branchList.length && remaining() > 0 && guard++ < 200) loadBranchOnlyPage();
    } else if (mode === "full") {
      let guard = 0;
      while (!rowsById.has(id) && fullLoaded < total && remaining() > 0 && guard++ < 200) loadFullPage();
    } else if (mainIds.has(id)) {
      const targetIndex = pathIndex.get(id);
      let guard = 0;
      while (!rowsById.has(id) && targetIndex >= middleStart + middleLoaded && middleLoaded < middleEnd - middleStart && remaining() > 0 && guard++ < 200) {
        loadMiddlePage();
      }
    } else {
      let ancestor = record;
      while (ancestor && !mainIds.has(ancestor.id)) ancestor = ancestor.parentId ? index.nodes.get(ancestor.parentId) : null;
      if (!ancestor) return false;
      const ancestorIndex = pathIndex.get(ancestor.id) ?? -1;
      let guard = 0;
      while (!rowsById.has(ancestor.id) && ancestorIndex >= middleStart + middleLoaded && middleLoaded < middleEnd - middleStart && remaining() > 0 && guard++ < 200) {
        loadMiddlePage();
      }
      const summaryEl = list.querySelector(`[data-branch-of="${CSS.escape(ancestor.id)}"]`);
      if (!summaryEl) return false;
      if (summaryEl.getAttribute("aria-expanded") !== "true") summaryEl.click();
      const state = branchStates.get(ancestor.id);
      guard = 0;
      while (state && !rowsById.has(id) && state.loaded < state.records.length && remaining() > 0 && guard++ < 200) {
        loadBranchPage(ancestor, state);
      }
    }
    const el = rowsById.get(id);
    if (!el) return false;
    highlight(el);
    return true;
  };

  let matches = [];
  let matchIndex = 0;
  const renderSearchCount = () => {
    searchCount.dataset.text = matches.length ? `${matchIndex + 1} / ${matches.length} 命中` : searchInput.value.trim() ? "没找到" : "";
    searchCount.textContent = searchCount.dataset.text;
  };
  const runSearch = (revealFirst) => {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      matches = [];
      matchIndex = 0;
      renderSearchCount();
      return;
    }
    matches = index.order.filter((id) => index.nodes.get(id).text.includes(query)).slice(0, 200);
    matchIndex = 0;
    if (revealFirst && matches.length) reveal(matches[0]);
    renderSearchCount();
  };
  let searchTimer = 0;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(true), 180);
  });
  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      searchInput.value = "";
      runSearch(false);
      return;
    }
    if (ev.key === "Enter" || ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      runSearch(false);
      if (!matches.length) return;
      if (ev.key === "ArrowUp") matchIndex = (matchIndex - 1 + matches.length) % matches.length;
      else if (ev.key === "ArrowDown") matchIndex = (matchIndex + 1) % matches.length;
      else matchIndex = Math.min(matchIndex + 1, matches.length - 1);
      reveal(matches[matchIndex]);
      renderSearchCount();
    }
  });

  btnLocate.addEventListener("click", () => {
    if (leafRecord) reveal(leafRecord.id);
  });
  btnExpandAll.addEventListener("click", () => {
    if (mode !== "full") buildFullView();
    else loadFullPage();
    syncStats();
  });
  btnCollapseAll.addEventListener("click", () => {
    searchInput.value = "";
    matches = [];
    matchIndex = 0;
    searchCount.dataset.text = "";
    renderSearchCount();
    buildMainView();
  });

  buildMainView();
  // 默认跟随当前 leaf：打开即把叶子滚进视野
  if (leafRecord) {
    const leafEl = rowsById.get(leafRecord.id);
    if (leafEl) requestAnimationFrame(() => leafEl.scrollIntoView({ block: "center" }));
  }
}

async function openTree() {
  openPanel("会话树", { actionLabel: "克隆当前会话", onAction: cloneSession });
  try {
    const data = await (await fetch("/api/session/tree", { cache: "no-store" })).json();
    // 桥出错时回 {error:{code,message}}（例如 RPC 502）：不校验就会 tree=undefined → 空白列表且无提示（D1）
    if (data.error) throw new Error(`${data.error.code}: ${data.error.message}`);
    renderTreeView(data.tree, data.leafId);
  } catch (err) {
    const el = document.createElement("div");
    el.className = "panel-error";
    el.textContent = `读取会话树失败：${err.message}`;
    els.panelBody.appendChild(el);
  }
}

async function forkAt(entryId) {
  const col = activeColumn();
  if (!col) return;
  try {
    const data = await col.postJson("/api/session/fork", { entryId });
    if (data?.cancelled) return showNotice("扩展取消了 fork", true);
    toast(`已 fork 到新会话 ${String(data.sessionId).slice(0, 8)}`);
    await refreshAfterBranch(data.sessionFile);
  } catch (err) {
    showNotice(`fork 失败：${err.message}`, true);
  }
}

async function cloneSession() {
  const col = activeColumn();
  if (!col) return;
  try {
    const data = await col.postJson("/api/session/clone");
    if (data?.cancelled) return showNotice("扩展取消了 clone", true);
    toast(`已 clone 到新会话 ${String(data.sessionId).slice(0, 8)}`);
    await refreshAfterBranch(data.sessionFile);
  } catch (err) {
    showNotice(`clone 失败：${err.message}`, true);
  }
}

/**
 * fork/clone 后：在当前列重新打开新会话（sessionFile）并刷新列表（缓存已由桥失效）。
 * 注：这条内部路径**不**走「会中止当前回答」的确认框（本次只修会话列表点击）。
 */
async function refreshAfterBranch(sessionFile) {
  const col = activeColumn();
  if (sessionFile && col) {
    try {
      await col.openSession({ path: sessionFile, cwd: col.cwd });
    } catch (err) {
      showNotice(`刷新分支会话失败：${err.message}`, true);
    }
  }
  await list.load();
}

// 注：会话树面板里的「克隆当前会话」会经 refreshAfterBranch 重新 open，streaming 时同样有中止风险；
// 本次只修「点左侧会话列表切会话」的确认，这里行为保持不变（仅注释说明）。
els.openTree.addEventListener("click", () => openTree());

// ---------- 文件面板（T-17）----------

let fileCwd = "";

async function openFiles(dirPath = "") {
  openPanel(dirPath ? `文件 · /${dirPath}` : "工作区文件", {});
  try {
    const data = await (await fetch(`/api/files?path=${encodeURIComponent(dirPath)}`, { cache: "no-store" })).json();
    if (data.error) throw new Error(`${data.error.code}: ${data.error.message}`);
    fileCwd = data.path || "";
    const list = document.createElement("div");
    list.className = "file-list";
    list.dataset.role = "file-list";
    list.dataset.path = fileCwd;

    if (fileCwd) {
      const up = document.createElement("button");
      up.type = "button";
      up.className = "file-row";
      up.dataset.role = "file-up";
      up.textContent = ".. （上一级）";
      up.addEventListener("click", () => openFiles(pathDirname(fileCwd)));
      list.appendChild(up);
    }
    for (const entry of data.entries ?? []) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "file-row";
      row.dataset.role = entry.type === "dir" ? "file-dir" : "file-item";
      row.dataset.path = entry.path;
      row.textContent = entry.type === "dir" ? `📁 ${entry.name}` : `📄 ${entry.name}${entry.size != null ? ` · ${fmtBytes(entry.size)}` : ""}`;
      row.addEventListener("click", () => (entry.type === "dir" ? openFiles(entry.path) : previewFile(entry.path)));
      list.appendChild(row);
    }
    els.panelBody.appendChild(list);
  } catch (err) {
    const e = document.createElement("div");
    e.className = "panel-error";
    e.textContent = `读取目录失败：${err.message}`;
    els.panelBody.appendChild(e);
  }
}

function pathDirname(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function fmtBytes(n) {
  return n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function previewFile(filePath) {
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(`${data?.error?.code || res.status}: ${data?.error?.message || ""}`);
    const box = document.createElement("div");
    box.className = "preview";
    box.dataset.role = "preview";
    box.dataset.mime = data.mime;
    const head = document.createElement("div");
    head.className = "preview-head";
    head.textContent = `/${filePath} · ${fmtBytes(data.size)} · ${data.mime}`;
    box.appendChild(head);

    if (String(data.mime).startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "msg-image";
      img.dataset.role = "preview-image";
      img.src = `data:${data.mime};base64,${data.content}`;
      box.appendChild(img);
    } else if (String(data.mime).startsWith("text/markdown")) {
      const md = document.createElement("div");
      md.className = "text-block";
      md.appendChild(renderMarkdown(data.content));
      box.appendChild(md);
    } else if (String(data.mime).startsWith("text/") || String(data.mime).includes("json")) {
      const pre = document.createElement("pre");
      pre.className = "preview-code";
      pre.dataset.role = "preview-code";
      pre.textContent = data.content;
      box.appendChild(pre);
    } else {
      const note = document.createElement("div");
      note.className = "panel-error";
      note.textContent = `该类型（${data.mime}）暂不支持预览`;
      box.appendChild(note);
    }
    els.panelBody.appendChild(box);
    return true;
  } catch (err) {
    showNotice(`预览失败：${err.message}`, true);
    return false;
  }
}

/**
 * v1.3.0 计划卡片「查看源文件」：复用既有文件面板，定位到该计划文件。
 * rel 是相对引擎 cwd 的路径（/api/file 的沙箱口径）；打开失败返回 false，由卡片降级为「复制路径 + toast」。
 */
async function openPlanSource(rel, abs) {
  if (!els.panelBody) return false;
  try {
    openPanel("文件", {});
    const head = document.createElement("div");
    head.className = "panel-note";
    head.textContent = abs ? `计划源文件：${abs}` : `计划源文件：${rel}`;
    els.panelBody.appendChild(head);
    return await previewFile(rel);
  } catch {
    return false;
  }
}

els.openFiles.addEventListener("click", () => openFiles(""));

// ---------- Git diff 面板（F-12）· 只读，不走任何写操作 ----------

/** 工作区路径比较（Bridge 口径：path.resolve 后不区分大小写） */
function sameCwd(a, b) {
  const norm = (v) => String(v || "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

/** 路径末段（兼容 Windows 反斜杠）；没有则返回空串 */
function pathBase(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  if (!s) return "";
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

async function openDiff() {
  const requestCwd = activeColumn()?.cwd || ""; // 当前列有会话才带 ?cwd=；没有就让桥用自己的工作区根
  const shownCwd = requestCwd || workspaceRoot;
  openPanel(`Git diff · ${pathBase(shownCwd) || "工作区"}`, { actionLabel: "刷新", onAction: () => openDiff() });

  const box = document.createElement("div");
  box.dataset.role = "git-diff";
  box.dataset.cwd = shownCwd;
  els.panelBody.appendChild(box);
  await fillWorkspaceDiff(box, requestCwd);
}

/** 工作区 diff 的取数 + 渲染（Diff 面板与「本轮改动」的「工作区」页共用） */
async function fillWorkspaceDiff(box, requestCwd) {
  const loading = document.createElement("div");
  loading.className = "preview-head";
  loading.dataset.role = "git-diff-loading";
  loading.textContent = "读取中…";
  box.replaceChildren(loading);
  try {
    const url = `/api/git/diff${requestCwd ? `?cwd=${encodeURIComponent(requestCwd)}` : ""}`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), { code: data?.error?.code || String(res.status) });
    box.replaceChildren();
    renderDiff(box, data);
  } catch (err) {
    box.replaceChildren();
    const e = document.createElement("div");
    e.className = "panel-error";
    e.dataset.role = "git-diff-error";
    e.textContent = `${err.code || "ERROR"}: ${err.message}`;
    box.appendChild(e);
  }
}

// ---------- PIX-4：「本轮改动」面板（本轮 / 工作区） ----------
//
// 「本轮」= 最近一次 user 消息起（桥侧快照，write/edit 类工具的前后内容）。
// 「工作区」= 现有 git diff（同一份只读数据，不新增写操作）。
// 默认「本轮」；没有快照（旧会话 / 没改文件）→ 明确空态，不拿工作区数据冒充。

const changesPanel = { open: false, mode: "turn", sessionId: null, turn: null, signature: "", body: null };

/** 当前列的会话 id（新会话还没落盘时为 null → 桥按「该引擎最近一轮」兜底） */
function currentSessionId() {
  return activeColumn()?.sessionId || null;
}

function fmtBytesShort(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function kindLabel(kind) {
  return { A: "新增", M: "修改", D: "删除" }[kind] || String(kind || "?");
}

async function openChanges() {
  const col = activeColumn();
  const cwdBase = col?.cwd ? pathBase(col.cwd) : "";
  changesPanel.mode = "turn";
  changesPanel.sessionId = currentSessionId();
  changesPanel.signature = "";
  openPanel(`本轮改动${cwdBase ? ` · ${cwdBase}` : ""}`, { actionLabel: "刷新", onAction: () => reloadChangesPanel() });
  changesPanel.open = true;

  const wrap = document.createElement("div");
  wrap.className = "changes-wrap";
  wrap.dataset.role = "changes-panel";
  const tabs = document.createElement("div");
  tabs.className = "changes-tabs";
  tabs.setAttribute("role", "tablist");
  for (const [mode, label] of [["turn", "本轮"], ["workspace", "工作区"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "changes-tab";
    btn.dataset.role = "changes-tab";
    btn.dataset.mode = mode;
    btn.textContent = label;
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => setChangesMode(mode));
    tabs.appendChild(btn);
  }
  const body = document.createElement("div");
  body.className = "changes-body";
  body.dataset.role = "changes-body";
  wrap.append(tabs, body);
  els.panelBody.appendChild(wrap);
  changesPanel.body = body;
  await setChangesMode("turn");
}

async function setChangesMode(mode) {
  if (!changesPanel.body) return;
  changesPanel.mode = mode;
  for (const btn of document.querySelectorAll('[data-role="changes-tab"]')) {
    const active = btn.dataset.mode === mode;
    btn.dataset.active = active ? "1" : "0";
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  changesPanel.body.replaceChildren();
  if (mode === "workspace") {
    const box = document.createElement("div");
    box.dataset.role = "git-diff";
    changesPanel.body.appendChild(box);
    await fillWorkspaceDiff(box, activeColumn()?.cwd || "");
    return;
  }
  await renderTurnChanges(changesPanel.body);
}

async function reloadChangesPanel() {
  if (!changesPanel.open) {
    openDiff();
    return;
  }
  changesPanel.signature = "";
  await setChangesMode(changesPanel.mode);
}

async function fetchTurnChanges() {
  const sessionId = currentSessionId() || changesPanel.sessionId || "";
  changesPanel.sessionId = sessionId || null;
  const turn = activeColumn()?.lastTurn ?? null;
  changesPanel.turn = turn;
  const params = new URLSearchParams();
  if (sessionId) params.set("session", sessionId);
  if (Number.isInteger(turn) && turn > 0) params.set("turn", String(turn));
  const qs = params.toString();
  const res = await fetch(`/api/turn-changes${qs ? `?${qs}` : ""}`, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), { code: data?.error?.code || String(res.status) });
  return data;
}

function diffSummaryText(file) {
  const add = file.additions;
  const del = file.deletions;
  if (add == null && del == null) {
    const before = file.before?.size;
    const after = file.after?.size;
    if (file.kind === "A" && Number.isFinite(after)) return `+${fmtBytesShort(after)}`;
    if (file.kind === "D" && Number.isFinite(before)) return `−${fmtBytesShort(before)}`;
    if (Number.isFinite(before) && Number.isFinite(after)) return `${fmtBytesShort(before)} → ${fmtBytesShort(after)}`;
    return "";
  }
  return `+${add ?? 0} −${del ?? 0}`;
}

function renderChangeRow(file) {
  const row = document.createElement("div");
  row.className = "change-item";
  row.dataset.role = "change-item";
  row.dataset.path = file.path;
  row.dataset.kind = file.kind;

  const head = document.createElement("button");
  head.type = "button";
  head.className = "change-row";
  head.dataset.role = "change-row";
  head.dataset.path = file.path;
  head.dataset.kind = file.kind;

  const badge = document.createElement("span");
  badge.className = "change-kind";
  badge.dataset.kind = file.kind;
  badge.dataset.role = "change-kind";
  badge.textContent = file.kind;
  badge.title = kindLabel(file.kind);

  const name = document.createElement("span");
  name.className = "change-path";
  name.dataset.role = "change-path";
  name.textContent = file.path;
  name.title = file.path;

  const summary = document.createElement("span");
  summary.className = "change-lines";
  summary.dataset.role = "change-lines";
  const add = document.createElement("span");
  add.className = "add";
  add.textContent = file.additions != null ? `+${file.additions}` : "";
  const del = document.createElement("span");
  del.className = "del";
  del.textContent = file.deletions != null ? `−${file.deletions}` : "";
  if (file.additions == null && file.deletions == null) {
    summary.textContent = file.note ? `— ${file.note}` : "—";
  } else {
    summary.append(add, del);
  }

  head.append(badge, name, summary);
  row.appendChild(head);

  const slot = document.createElement("div");
  slot.className = "change-diff-slot";
  slot.hidden = true;
  row.appendChild(slot);

  head.addEventListener("click", () => {
    const open = head.dataset.open === "1";
    head.dataset.open = open ? "0" : "1";
    slot.hidden = open;
    if (!open && !slot.dataset.rendered) {
      slot.dataset.rendered = "1";
      renderInlineDiff(slot, file);
    }
  });
  return row;
}

/** 内联 diff：复用 .preview-code；>2000 行折叠（只渲染前 2000 行 + 明确提示） */
function renderInlineDiff(slot, file) {
  const diff = String(file.diff || "");
  if (!diff.trim()) {
    const note = document.createElement("div");
    note.className = "preview-head";
    note.dataset.role = "change-diff-empty";
    note.textContent = file.note
      ? `没有 diff 文本（${file.note}）`
      : "没有可显示的 diff（内容未变化或前后内容未保存）";
    slot.appendChild(note);
    return;
  }
  const allLines = diff.replace(/\r\n/g, "\n").split("\n");
  const MAX_LINES = 2000;
  const shown = allLines.length > MAX_LINES ? allLines.slice(0, MAX_LINES).join("\n") : diff;
  const pre = document.createElement("pre");
  pre.className = "preview-code change-diff";
  pre.dataset.role = "change-diff";
  pre.textContent = shown;
  slot.appendChild(pre);
  if (allLines.length > MAX_LINES || file.diffTruncated) {
    const note = document.createElement("div");
    note.className = "preview-head";
    note.dataset.role = "change-diff-truncated";
    note.textContent = `diff 过长：仅显示前 ${MAX_LINES} 行（共 ${allLines.length} 行）`;
    slot.appendChild(note);
  }
}

async function renderTurnChanges(body) {
  const summary = document.createElement("div");
  summary.className = "changes-summary";
  summary.dataset.role = "changes-summary";
  summary.textContent = "读取中…";
  body.appendChild(summary);
  let data;
  try {
    data = await fetchTurnChanges();
  } catch (err) {
    summary.remove();
    const e = document.createElement("div");
    e.className = "panel-error";
    e.dataset.role = "changes-error";
    e.textContent = `${err.code || "ERROR"}: ${err.message}`;
    body.appendChild(e);
    return;
  }
  summary.remove();
  const files = Array.isArray(data.files) ? data.files : [];
  changesPanel.signature = `${data.turn}|${files.map((f) => `${f.path}:${f.kind}:${f.additions}:${f.deletions}`).join("|")}`;

  const head = document.createElement("div");
  head.className = "changes-summary";
  head.dataset.role = "changes-summary";
  head.dataset.turn = data.turn == null ? "" : String(data.turn);
  head.textContent =
    files.length === 0
      ? data.turn == null
        ? "本轮改动：没有记录"
        : `本轮（第 ${data.turn} 轮）：没有文件改动`
      : `第 ${data.turn ?? "?"} 轮 · ${files.length} 个文件${data.truncated ? "（部分只记路径）" : ""}`;
  body.appendChild(head);

  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "changes-empty";
    empty.dataset.role = "change-empty";
    empty.textContent = "这一轮没有文件改动";
    body.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "change-list";
  list.dataset.role = "change-list";
  for (const file of files) list.appendChild(renderChangeRow(file));
  body.appendChild(list);

  if (data.truncated) {
    const note = document.createElement("div");
    note.className = "changes-note";
    note.dataset.role = "changes-truncated";
    note.textContent = "本轮文件过多或过大：超出上限的文件只记录路径，不保存前后内容（无法生成 diff）。";
    body.appendChild(note);
  }
}

/** 面板开着「本轮」时，一轮结束/新事件后按签名判断是否需要重画（不打断展开状态） */
async function refreshTurnPanelIfOpen() {
  if (!changesPanel.open || changesPanel.mode !== "turn" || !changesPanel.body) return;
  let data;
  try {
    data = await fetchTurnChanges();
  } catch {
    return;
  }
  const files = Array.isArray(data.files) ? data.files : [];
  const signature = `${data.turn}|${files.map((f) => `${f.path}:${f.kind}:${f.additions}:${f.deletions}`).join("|")}`;
  if (signature === changesPanel.signature) return;
  changesPanel.body.replaceChildren();
  changesPanel.signature = "";
  await renderTurnChanges(changesPanel.body);
}

if (els.changes) els.changes.addEventListener("click", () => openChanges());
if (els.panelClose) {
  els.panelClose.addEventListener("click", () => {
    changesPanel.open = false;
    changesPanel.body = null;
  });
}

function renderDiff(box, data) {
  const cwd = data.cwd || box.dataset.cwd || "";
  box.dataset.cwd = cwd;

  if (data.available === false) {
    const p = document.createElement("div");
    p.className = "panel-error";
    p.dataset.role = "git-diff-unavailable";
    p.textContent = `当前目录不是 git 仓库：${cwd}（可以用「工作区」切到项目目录）`;
    box.appendChild(p);
    return;
  }

  const status = Array.isArray(data.status) ? data.status : [];
  const stat = String(data.stat || "");
  const patch = String(data.patch || "");
  if (!status.length && !stat.trim() && !patch.trim()) {
    const clean = document.createElement("div");
    clean.className = "preview-head";
    clean.dataset.role = "git-diff-clean";
    clean.textContent = "工作区干净，没有未提交改动";
    box.appendChild(clean);
    return;
  }

  if (status.length) {
    const list = document.createElement("div");
    list.className = "file-list";
    list.dataset.role = "git-diff-status";
    for (const row of status) {
      const item = document.createElement("div");
      item.className = "tree-label";
      item.dataset.role = "git-status-row";
      item.dataset.code = row.code;
      item.dataset.path = row.path;
      item.textContent = `${row.code} ${row.path}`;
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  if (stat.trim()) {
    const pre = document.createElement("pre");
    pre.className = "preview-code";
    pre.dataset.role = "git-diff-stat";
    pre.textContent = stat;
    box.appendChild(pre);
  }

  if (data.truncated) {
    const note = document.createElement("div");
    note.className = "preview-head";
    note.dataset.role = "git-diff-truncated";
    note.textContent = "patch 已截断（>2MiB）";
    box.appendChild(note);
  }

  if (patch.trim()) {
    const pre = document.createElement("pre");
    pre.className = "preview-code";
    pre.dataset.role = "git-diff-patch";
    pre.textContent = patch;
    box.appendChild(pre);
  }
}

els.openDiff.addEventListener("click", () => openDiff());
// ============================ 列管理（Q4：同页 1–3 列，每列独立引擎） ============================
//
// 一列 = 一个引擎（clientId = base#cN）+ 一个会话。列不是标签页：多列同时在线、同时 streaming。
// 列内状态（会话流/Composer/滚动/SSE）在 column.js；这里只管：建/关列、活动列、窄屏降级、
// 顶栏与列头跟随活动列、键盘归属。

const MAX_COLUMNS = 3; // 任务上限 1–3 列（第 4 列提示上限）
const NARROW_MAX = 900; // ≤900px：只显示当前列 + 列切换器（后台列继续收事件）
// 判「窄屏」用媒体查询而不是 innerWidth：resize 事件到达时 innerWidth 偶尔还是旧值，
// 拿它算列数会留下「两列都显示、切换器不出现」的错布局（只发生一次，之后没有事件来纠正）。
const NARROW_QUERY = window.matchMedia(`(max-width: ${NARROW_MAX}px)`);

const columns = [];
let activeKey = null;
let columnSeq = 0;
let desiredCount = 1; // 用户点 1/2/3 的意图；窄屏降级只影响「显示」，不销毁列

/** 会话滚动位置记忆（回归 #4：切走再切回，折叠状态与滚动位置保持） */
const scrollMemory = new Map();

function activeColumn() {
  return columns.find((c) => c.key === activeKey) || columns[0] || null;
}

function columnIndex(col) {
  return columns.indexOf(col);
}

function currentClientId() {
  return activeColumn()?.clientId || BASE_CLIENT_ID;
}

// 列模板：启动时从第一列克隆（此后第一列会被真实会话内容填充，模板保持空白）
const columnTemplate = (() => {
  const node = els.columns.querySelector(".column");
  const clone = node.cloneNode(true);
  clone.removeAttribute("id");
  for (const child of clone.querySelectorAll("[id]")) child.removeAttribute("id");
  return clone;
})();

const shell = {
  toast,
  confirm: confirmModal,
  list,
  modalOpen: () => !els.modal.hidden,
  setSidebarOpen,
  showExtDialog: (req, col) => showExtDialog(req, col),
  setActive: (col) => {
    if (col && col.key !== activeKey) setActive(col);
  },
  columnUpdated,
  refreshChanges,
  rememberScroll: (sessionId, top) => scrollMemory.set(sessionId, top),
  recallScroll: (sessionId) => scrollMemory.get(sessionId),
  titleFor: (sessionId) => titleForSession(sessionId),
  // N1-b：资源面板释放本列引擎后，列内「重新打开会话」需要重新认领
  claimEngine: (col) => claimEngineFor(col),
  onCwd: (col) => {
    if (col && col === activeColumn() && col.cwd) paintWsPath(col.cwd);
  },
  // B1/T6：列内 openSession / newSession / session_attached 成功后立刻重同步顶栏
  syncHeaderFromSession: (col, opts) => syncHeaderFromSession(col, opts),
  // A1：新会话前先选项目目录（弹层归外壳，POST 归列 → 只影响本列引擎）
  pickCwd: (col) => pickProjectDir(col),
  // v1.3.0 斜杠命令：命令数据一处取（每列面板共用），见 loadCommands()
  loadCommands,
  commandsCached: () => commandCache,
  // P0：前端兜底恢复模型被引擎拒绝（404/400）→ 顶栏标「该模型不可用」+ 提示（不静默退回默认）
  modelUnavailable: (col, model, err) => reportModelUnavailable(col, model, err),
  // v1.3.0 计划卡片「查看源文件」：复用文件面板（返回 false = 卡片降级为复制路径）
  openPlanSource: (rel, abs) => openPlanSource(rel, abs),
};

function setActive(col) {
  if (!col || col.key === activeKey) return;
  activeKey = col.key;
  // v1.3.0：切换列 → 其他列的命令面板关闭（面板只作用于触发它的那一列）
  for (const other of columns) if (other !== col) other.closeCommandPanel({ focus: false });
  maybeApplyLayout(); // 活动列变了：窄屏下可见列要跟着换
  syncHeaderFromSession(col, { delay: 0 });
  columnUpdated(col);
}

/** 顶栏 / 列头 / 切换器跟随「活动列」 */
let changesTimer = null;
function scheduleChanges() {
  clearTimeout(changesTimer);
  changesTimer = setTimeout(() => refreshChanges(), 250);
}

function columnUpdated(c) {
  if (c) c.refreshHeadStreaming();
  paintSwitcher();
  syncSplitButtons();
  const active = activeColumn();
  if (!active || (c && c !== active)) return;

  // 顶栏引擎状态（streaming 秒数由 tickStreamingClock 每秒刷新）
  els.state.textContent = active.state === "streaming" ? `streaming ${fmtElapsed(active.streamStartedAt)}` : active.state;
  els.state.dataset.state = active.state;
  els.state.title = STATE_LABELS[active.state] ?? active.state;
  const hardBlocked = ["not_started", "starting", "failed", "stopping"].includes(active.state);
  els.newSession.disabled = hardBlocked;
  els.newSession.setAttribute("aria-disabled", hardBlocked || active.state !== "idle" ? "true" : "false");

  // 模型 / 思考级别 / 扩展状态：都显示「当前列」的真相。
  // 下拉选项也必须换成这一列的候选清单（否则会拿上一列的清单去校验本列的模型）。
  if (modelClientId !== active.clientId) renderModelOptions(active.clientId);
  applyModelToSelect(active.model);
  applyThinkingToSelect(active.thinkingLevel);
  const ext = active.extStatus || "";
  els.extStatus.textContent = ext;
  els.extStatus.hidden = !ext;

  active.paintHead(columnIndex(active));
  paintMcpBadges();
  syncHeaderFromSession(active, { delay: 150 }); // B1/T6：顶栏以该列的 session/view 为准
  if (c) scheduleChanges(); // Changes 计数属于当前列（防抖：一次状态变化只查一次 git）
}

/** 会话标题（列头用）：从左侧列表的内存模型里找，找不到就返回空串 */
function titleForSession(sessionId) {
  if (!sessionId) return "";
  const model = list.model;
  const pools = [model.agentSessions ?? [], ...(model.groups ?? []).map((g) => g.sessions ?? [])];
  for (const pool of pools) {
    const hit = pool.find((s) => String(s.id) === String(sessionId));
    if (hit?.title) return hit.title;
  }
  return "";
}

/** 建一列（同步建 DOM；引擎认领由 claimEngineFor 完成）
 *  reuse = 首屏 HTML 里已存在的那一列（不额外克隆，避免留下一个「没人管的」死列） */
function createColumnEntry(reuse = null) {
  const seq = ++columnSeq;
  const node = reuse || columnTemplate.cloneNode(true);
  if (reuse) node.removeAttribute("hidden");
  else els.columns.appendChild(node);
  node.dataset.colKey = `c${seq}`;
  const col = createColumn({ key: `c${seq}`, clientId: `${BASE_CLIENT_ID}#c${seq}`, root: node, shell });
  columns.push(col);
  col.el.close?.addEventListener("click", () => closeColumn(col));
  col.paintHead(columns.length - 1);
  return col;
}

/** 列数布局：宽屏全部显示；≤900px 只显示当前列 + 切换器（不销毁后台列） */
function applyLayout() {
  const narrow = NARROW_QUERY.matches;
  const total = columns.length;
  for (let i = 0; i < total; i++) {
    const col = columns[i];
    col.el.root.hidden = narrow && col.key !== activeKey;
    col.el.root.classList.toggle("is-active", col.key === activeKey);
    if (col.el.head) col.el.head.hidden = total <= 1;
    col.paintHead(i);
  }
  document.body.dataset.cols = String(total);
  els.columns.dataset.count = String(total);
  if (els.switcher) els.switcher.hidden = !(narrow && total > 1);
  buildSwitcher();
  syncSplitButtons();
  lastLayoutSig = layoutSignature(); // 记住本次布局签名（maybeApplyLayout 的判据）
  lastLayoutWidth = Math.round(window.innerWidth || 0);
}

// Q6/P7 自愈：applyLayout 原来只由 resize + matchMedia change 两条信号驱动。
// 长时 streaming 的 headless/后台目标会被节流 → 视口真的变了却一次事件都不来，
// body[data-cols] 停在旧值（现场：900px 视口 mq.matches=true，但 body[data-cols] 仍是 "2"）。
// maybeApplyLayout 拿「布局签名」（宽度 / 窄屏阈值 / 列数 / 活动列）当判据，变量才重算；
// 调用点：健康轮询（2s）、visibilitychange、visualViewport.resize、每次列数/活动列变化。
let lastLayoutWidth = -1;
let lastLayoutSig = "";

function layoutSignature() {
  return [
    Math.round(window.innerWidth || 0),
    NARROW_QUERY.matches ? "narrow" : "wide",
    columns.length,
    activeKey ?? "",
  ].join("|");
}

/** 宽度变了、或列数/活动列/窄屏阈值变了，才重算（幂等）；返回是否真的重算了 */
function maybeApplyLayout() {
  const width = Math.round(window.innerWidth || 0);
  if (width === lastLayoutWidth && layoutSignature() === lastLayoutSig) return false;
  applyLayout();
  return true;
}

/** 窄屏列切换器：01 02 03 + 状态点（streaming 闪 accent） */
function buildSwitcher() {
  if (!els.switcher || els.switcher.hidden) return;
  const buttons = [...els.switcher.querySelectorAll("button")];
  const want = columns.map((c) => c.key).join(",");
  const have = buttons.map((b) => b.dataset.colKey).join(",");
  if (want !== have) {
    els.switcher.replaceChildren();
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.colKey = col.key;
      btn.setAttribute("role", "tab");
      btn.title = `切到列 ${String(i + 1).padStart(2, "0")}`;
      const label = document.createElement("span");
      label.textContent = String(i + 1).padStart(2, "0");
      const dot = document.createElement("span");
      dot.className = "col-dot";
      btn.append(label, dot);
      btn.addEventListener("click", () => setActive(col));
      els.switcher.appendChild(btn);
    }
  }
  for (const btn of [...els.switcher.querySelectorAll("button")]) {
    const col = columns.find((c) => c.key === btn.dataset.colKey);
    if (!col) continue;
    btn.setAttribute("aria-selected", col.key === activeKey ? "true" : "false");
    btn.dataset.streaming = col.state === "streaming" ? "true" : "false";
    btn.dataset.state = col.state === "failed" ? "error" : col.state;
  }
}

function paintSwitcher() {
  if (!els.switcher || els.switcher.hidden) return;
  buildSwitcher();
}

function syncSplitButtons() {
  if (!els.split) return;
  for (const btn of els.split.querySelectorAll("[data-split]")) {
    btn.setAttribute("aria-pressed", Number(btn.dataset.split) === desiredCount ? "true" : "false");
  }
}

const claimInFlight = new WeakMap(); // 列 → 正在进行的 claim Promise（同一列只认领一次）

// Q6：一列=一个 clientId（base#cN）。claim 必须幂等 —— 启动、SSE 重连、列数调整都可能
// 触发同一列的认领；并发两次 POST 会让桥建两个引擎（「2 个标签页却提示开太多」的根源）。
async function claimEngineFor(col) {
  const inflight = claimInFlight.get(col);
  if (inflight) return inflight;
  const task = (async () => {
    try {
      const data = await col.postJson("/api/engine/claim");
      if (col === activeColumn()) selfEngine = data?.engine ?? null;
      // 引擎给的真实 MCP 名单（默认空）→ 列头徽标
      if (Array.isArray(data?.mcp)) {
        col.mcp = [...data.mcp];
        col.paintHead(columns.indexOf(col));
      }
      return true;
    } catch (err) {
      const message = String(err.message || "引擎不可用").replace(/^PI_NOT_READY:\s*/, "");
      col.showNotice(err.code === "PI_NOT_READY" ? `引擎已达上限：${message}` : `引擎不可用：${message}`, true);
      return false;
    } finally {
      claimInFlight.delete(col);
    }
  })();
  claimInFlight.set(col, task);
  return task;
}

/**
 * N1-a：检测到「本页 clientId 被复制标签页占用」→ 换新 base，逐列重新认领并恢复原会话。
 * 旧 base 的引擎不主动释放：复制标签页的另一半仍在用同一批引擎，抢着关会把对方打断。
 */
async function handleTabClientChange(nextBase) {
  if (!nextBase || nextBase === BASE_CLIENT_ID) return;
  BASE_CLIENT_ID = nextBase;
  toast("检测到标签页标识冲突：已切换到独立引擎，正在恢复会话…", "warning");
  for (const col of columns) {
    const seq = String(col.key).replace(/^c/, "");
    const wasReleased = col.released;
    col.disconnect();
    col.setClientId(`${BASE_CLIENT_ID}#c${seq}`);
    // 已释放的列不在冲突时擅自恢复（否则用户主动释放的引擎又被拉起来）
    if (wasReleased) continue;
    const ok = await claimEngineFor(col);
    if (!ok) {
      col.markReleased?.("引擎认领失败：请稍后重新打开会话");
      continue;
    }
    if (col.sessionPath) {
      // 409（会话已被旧页占用）由 openSession 内部提示，并保持只读
      await col.openSession({ path: col.sessionPath, cwd: col.cwd, title: col.title });
    } else {
      col.connect();
    }
  }
  pollHealth();
}

/** 增一列（含引擎认领）。列数/引擎上限都在这里挡住，并给出明确提示。 */
async function addColumn() {
  if (columns.length >= MAX_COLUMNS) {
    showNotice(`已达列上限（最多 ${MAX_COLUMNS} 列${healthMaxEngines ? ` · 引擎上限 ${healthMaxEngines}` : ""}）`, true);
    return null;
  }
  const col = createColumnEntry();
  activeKey = col.key;
  maybeApplyLayout();
  if (!(await claimEngineFor(col))) {
    // 认领失败（引擎池满）：回滚这一列，不留下没有引擎的空列
    col.el.root.remove();
    columns.splice(columns.indexOf(col), 1);
    activeKey = activeColumn()?.key ?? null;
    desiredCount = columns.length;
    maybeApplyLayout();
    syncHeaderFromSession(activeColumn(), { delay: 0 });
    return null;
  }
  col.connect();
  syncHeaderFromSession(col, { delay: 0 });
  columnUpdated(col);
  return col;
}

/** 关一列：先断开该列 SSE（桥 60s 空闲后回收它的引擎），再移除 DOM */
async function closeColumn(col, { confirm = true } = {}) {
  if (!col) return false;
  if (columns.length <= 1) {
    showNotice("至少保留 1 列", true);
    return false;
  }
  if (confirm && col.state === "streaming") {
    const ok = await confirmModal("该列正在生成回答。关闭不会中止它，会继续在后台运行；回来打开这条会话就能看到继续生长/最终的结果。继续？", {
      title: "关闭列",
      confirmText: "关闭",
      cancelText: "取消",
    });
    if (!ok) return false;
  }
  col.disconnect();
  const idx = columnIndex(col);
  col.el.root.remove();
  columns.splice(idx, 1);
  if (activeKey === col.key) {
    const next = columns[Math.min(idx, columns.length - 1)];
    activeKey = next?.key ?? null;
  }
  desiredCount = Math.max(1, Math.min(desiredCount, columns.length));
  maybeApplyLayout();
  syncHeaderFromSession(activeColumn(), { delay: 0 });
  if (activeColumn()) columnUpdated(activeColumn());
  return true;
}

/** 分栏按钮：1/2/3（增列失败时回退显示，不谎报列数） */
async function setColumnCount(n) {
  const want = Math.max(1, Math.min(MAX_COLUMNS, Number(n) || 1));
  while (columns.length < want) {
    if (!(await addColumn())) break;
  }
  while (columns.length > want) {
    const last = columns[columns.length - 1];
    if (!(await closeColumn(last))) break;
  }
  desiredCount = columns.length;
  maybeApplyLayout(); // 列数变了（可能只是回退到实际列数）
  syncHeaderFromSession(activeColumn(), { delay: 0 });
  if (activeColumn()) activeColumn().focus();
}

els.split?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-split]");
  if (!btn) return;
  setColumnCount(Number(btn.dataset.split));
});

els.newSession.addEventListener("click", () => activeColumn()?.newSession());
els.brandHome?.addEventListener("click", () => activeColumn()?.brandHome());
window.__piShellNewSession = () => activeColumn()?.newSession();

// ---------- 全局键盘：Esc 中止「当前列」；Ctrl+K / Ctrl+U 也只作用于当前列 ----------

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    // A1：选目录弹层开着时，Esc 只关弹层（不中止回答）
    if (pickerState) {
      ev.preventDefault();
      closePicker(false);
      return;
    }
    if (!els.modal.hidden) {
      if (confirmResolve) confirmResolve(false); // 确认框：Esc = 取消（不触达下方 abort）
      else extDialogResolve?.();
      return;
    }
    // B8：溢出菜单开着时，Esc 只关菜单（不中止回答）
    if (menuOpen()) {
      ev.preventDefault();
      setMenu(false);
      els.openMenu.focus();
      return;
    }
    // Q2 移动端：抽屉开着时，Esc 只关抽屉（不中止回答）
    if (sidebarOpen()) {
      ev.preventDefault();
      setSidebarOpen(false);
      els.toggleSidebar?.focus();
      return;
    }
    // v1.3.0：斜杠命令面板开着时，Esc 只关面板（焦点回输入框，不中止回答）
    const colWithPanel = columns.find((c) => c.commandPanelOpen());
    if (colWithPanel) {
      ev.preventDefault();
      colWithPanel.closeCommandPanel();
      return;
    }
    ev.preventDefault();
    activeColumn()?.abort(); // Esc = clear_queue 后 abort（只中止当前列）
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    activeColumn()?.toggleCommandPanel(); // v1.3.0：行内面板（等价入口，已开则关）
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "u") {
    ev.preventDefault();
    activeColumn()?.openFilePicker();
  }
});

// ---------- v1.3.0：点面板外关闭斜杠命令面板 ----------
// 面板与 composer 卡片是同一组控件（点输入框/发送按钮不算面板外）；其他任何地方都算。
document.addEventListener("mousedown", (ev) => {
  for (const col of columns) {
    if (!col.commandPanelOpen()) continue;
    if (col.commandPanelContains(ev.target)) continue;
    col.closeCommandPanel({ focus: false });
  }
});

// ---------- 启动 ----------

let selfEngine = null; // 当前列认领到的引擎（health.engines 里的一条）
let enginesSnapshot = [];
let started = false;
let claimRetryTimer = null;

function paintEngineCount() {
  if (!els.stateEngines) return;
  const count = enginesSnapshot.length;
  const max = healthMaxEngines;
  els.stateEngines.textContent = count ? `引擎 ${count}${max ? `/${max}` : ""}` : "";
  els.stateEngines.hidden = count === 0;
  els.stateEngines.title = count ? `已认领 pi 引擎 ${count}${max ? ` / 上限 ${max}` : ""}` : "";
}

async function pollHealth() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const body = await res.json();
    enginesSnapshot = body.engines ?? [];
    healthMaxEngines = Number(body.maxEngines) || 0;
    const pi = body.pi;
    // 顶栏元数据（pid/版本/工作区）来自「当前列」的引擎
    if (pi) {
      els.pid.textContent = pi.pid == null ? "—" : String(pi.pid);
      if (pi.pid != null) lastPiPid = pi.pid;
      els.version.textContent = pi.version ?? "—";
      els.cwd.textContent = pi.cwd ?? "—";
      els.cwd.title = pi.cwd ?? "";
      workspaceRoot = pi.cwd ?? workspaceRoot;
    }
    // 每列从引擎池快照校准自身状态（SSE 是主通道，这里是兜底）。
    // 只在状态真的变了才重画：否则每 2s 会把顶栏/切换器/Changes 查询重跑一遍。
    for (const col of columns) {
      const engine = enginesSnapshot.find((e) => e.id === col.clientId);
      if (!engine) continue;
      const mcpChanged = Array.isArray(engine.mcp) && engine.mcp.join(",") !== (col.mcp ?? []).join(",");
      if (mcpChanged) col.mcp = [...engine.mcp];
      if (engine.state !== col.state || mcpChanged) {
        col.paintStatus({ state: engine.state, pid: engine.pid, mcp: engine.mcp });
        col.paintHead(columns.indexOf(col));
      }
    }
    paintEngineCount();
    // Q6/P7：健康轮询（2s）兼作布局自愈时钟 —— 不靠 resize/matchMedia，
    // 后台/被节流的标签页也能在 2s 内把 data-cols 拉回真实视口宽度。
    maybeApplyLayout();
  } catch {
    els.state.textContent = "disconnected";
    els.state.dataset.state = "disconnected";
    els.state.title = "桥不可达（已断开）";
  }
}

/** streaming 秒数每秒一跳（health 轮询是 2s，不够用） */
function tickStreamingClock() {
  const col = activeColumn();
  if (!col || col.state !== "streaming") return;
  els.state.textContent = `streaming ${fmtElapsed(col.streamStartedAt)}`;
}

function startUi() {
  if (started) return;
  started = true;
  pollHealth();
  setInterval(pollHealth, 2000);
  setInterval(tickStreamingClock, 1000);
  loadModels(activeColumn());
  loadThinkingLevels();
  list.load();
  refreshChanges();
  syncHeaderFromSession(activeColumn(), { delay: 0, force: true });
}

function scheduleClaimRetry() {
  clearTimeout(claimRetryTimer);
  claimRetryTimer = setTimeout(async () => {
    const col = columns[0];
    if (!col || !(await claimEngineFor(col))) return scheduleClaimRetry();
    col.connect();
    startUi();
  }, 3000);
}

// 视口跨过 900px 阈值要立刻重算列布局。只听 resize 会漏（尺寸替换/帧时序都可能不触发），
// 所以同时听 matchMedia 的阈值变化 —— 两个信号任一到达都重算（幂等）。
// Q6/P7：这两条信号本身也可能一次都不来（长时 streaming 的 headless/后台目标被节流）；
// 所以再加 visibilitychange + visualViewport.resize（移动端地址栏/缩放只动 visual viewport），
// 周期性兜底在 pollHealth 里的 maybeApplyLayout。
window.addEventListener("resize", () => maybeApplyLayout());
NARROW_QUERY.addEventListener?.("change", () => maybeApplyLayout());
document.addEventListener("visibilitychange", () => maybeApplyLayout());
window.visualViewport?.addEventListener("resize", () => maybeApplyLayout());

// N1-b：资源面板（⋯ → 资源）；N1-a：心跳/广播发现冲突时换号并逐列重认领
const resourcesPanel = createResourcesPanel({
  getColumns: () => columns,
  getActive: () => activeColumn(),
  confirm: confirmModal,
  toast,
  refreshHealth: () => pollHealth(),
});
tabIdentity.onConflict((nextId) => {
  void handleTabClientChange(nextId);
});

(async () => {
  const first = createColumnEntry(els.columns.querySelector(".column"));
  activeKey = first.key;
  maybeApplyLayout();
  first.setAttachState("idle");
  if (!(await claimEngineFor(first))) {
    scheduleClaimRetry();
    return;
  }
  first.connect();
  startUi();
})();

window.__piShell = {
  // clientId = 「当前列」的引擎标识（既有脚本/套件把它当本页引擎 id 用；单列时 = base#c1）。
  // 标签页标识（sessionStorage 里的 base）用 tabClientId。
  get clientId() {
    return currentClientId();
  },
  tabId: TAB_ID,
  get tabClientId() {
    return BASE_CLIENT_ID;
  },
  get columnClientId() {
    return currentClientId();
  },
  get columnCount() {
    return columns.length;
  },
  get activeColumnKey() {
    return activeColumn()?.key ?? null;
  },
  columns: () => columns.map((c) => ({ key: c.key, clientId: c.clientId, sessionId: c.sessionId, state: c.state })),
  setColumns: (n) => setColumnCount(n),
  addColumn: () => addColumn(),
  closeColumn: (key) => closeColumn(columns.find((c) => c.key === key) || columns[columns.length - 1]),
  activateColumn: (key) => {
    const col = columns.find((c) => c.key === key);
    if (col) setActive(col);
    return col?.key ?? null;
  },
  claim: async () => {
    const col = activeColumn();
    const ok = col ? await claimEngineFor(col) : false;
    if (ok) startUi();
    return { ok, engine: selfEngine };
  },
  get engine() {
    return selfEngine;
  },
  get engines() {
    return enginesSnapshot;
  },
  get transcript() {
    return activeColumn()?.transcript ?? null;
  },
  list,
  openSessionPath: async (p) => {
    const col = activeColumn();
    if (!col) return { sessionId: null, entries: 0 };
    const data = await col.openSession({ path: p, cwd: "" });
    return { sessionId: data?.sessionId ?? null, entries: data?.entries?.length ?? 0 };
  },
  collapseState: getCollapseState,
  // v1.3.0：旧的居中模态入口名保留（验收脚本/扩展可能还在调），行为 = 活动列的行内面板 toggle
  togglePalette: () => activeColumn()?.toggleCommandPanel(),
  // B1/T6：验收脚本强制重同步顶栏（与用户切列/开会话走的同一个入口）
  syncHeader: (opts) => syncHeaderFromSession(activeColumn(), { delay: 0, force: true, ...(opts || {}) }),
  get sessionView() {
    const col = activeColumn();
    return col ? sessionViews.get(col.clientId) ?? null : null;
  },
  get modelClientId() {
    return modelClientId;
  },
  ext: (frame) => activeColumn()?.handleExtRequest(frame),
  // 验收脚本：把一帧 SSE 事件注入当前列（PIX-3 合成嵌套/失败工具行，避免依赖模型行为）
  applyFrame: (frame) => activeColumn()?.applyFrame?.(frame),
  reconnect: () => activeColumn()?.manualRetry(),
  /**
   * P0 验收/排障：断开本列 SSE。autoRetry=false 时不排退避（用于让桥真的回收空闲引擎，
   * 然后由 reconnect() 走真实重连路径）。与 forceDisconnect 同一个用户语义，只多了「不自动重连」。
   */
  dropConnection: ({ autoRetry = true } = {}) => {
    const col = activeColumn();
    if (!col) return false;
    col.disconnect();
    if (autoRetry) col.scheduleReconnect();
    return true;
  },
  /** P0 验收/排障：本列的重连恢复状态（会话身份 / 记住的模型与思考级别 / notice） */
  get reconnectState() {
    return activeColumn()?.restoreDebug?.() ?? null;
  },
  get sessionPrefs() {
    const col = activeColumn();
    return { model: col?.wantModel ?? null, thinkingLevel: col?.wantThinking ?? null };
  },
  forceDisconnect: () => {
    const col = activeColumn();
    if (!col) return;
    try {
      col.es?.close();
    } catch {}
    col.scheduleReconnect();
  },
  get connection() {
    const col = activeColumn();
    return {
      retryAttempt: col?.retryAttempt ?? 0,
      lastEntryId: col?.lastEntryId ?? null,
      disconnected: col ? col.el.reconnect.hidden === false : false,
      // S4：断线补齐的证据位（最后一帧 resume / 重连游标）
      lastSeq: col?.lastSeq ?? null,
      lastResume: col?.lastResume ?? null,
    };
  },
  get currentSessionId() {
    return activeColumn()?.sessionId ?? null;
  },
  get liveNodeCount() {
    return activeColumn()?.liveView.size ?? 0;
  },
  get attachState() {
    return activeColumn()?.attachState ?? "idle";
  },
  // B-11：滚动跟随状态（回归脚本 T7 读取）
  get isPinned() {
    return activeColumn()?.pinned ?? true;
  },
  isNearBottom: () => {
    const col = activeColumn();
    if (!col) return true;
    const el = col.el.log;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
  },
  scrollInfo: () => {
    const col = activeColumn();
    if (!col) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0, pinned: true, jumpVisible: false };
    return {
      scrollTop: col.el.log.scrollTop,
      scrollHeight: col.el.log.scrollHeight,
      clientHeight: col.el.log.clientHeight,
      pinned: col.pinned,
      jumpVisible: !!(col.el.jumpBottom && !col.el.jumpBottom.hidden),
    };
  },
  jumpToBottom: () => activeColumn()?.el.jumpBottom.click(),
  openPath: async (p) => activeColumn()?.openSession({ path: p, cwd: "" }),
  retryAttach: () => {
    const col = activeColumn();
    if (col?.attachSessionRef) col.openSession(col.attachSessionRef);
  },
  refreshStats: () => activeColumn()?.refreshStats(),
  prefs: () => ({ ...prefs }),
  setPreference: (key, value) => {
    writePrefs({ ...prefs, [key]: value });
    applyPrefs();
    return { ...prefs };
  },
  get searchHits() {
    return Number(els.search.dataset.hits ?? -1);
  },
  // N1-b：验收脚本打开资源面板（与 ⋯ → 资源 同一入口）
  openResources: () => resourcesPanel.open(),
  closeResources: () => resourcesPanel.close(),
};
