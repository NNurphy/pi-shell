// pi-shell · N1-b：「资源」面板（⋯ → 资源）
//
// 目标：用户能自己看见并释放资源，而不是只能杀标签页等 60s 空闲回收。
//   · 每行一个引擎：标题 / 模型 / 状态 / MCP / RSS / 空闲秒数
//   · 行内操作：释放（POST /api/engine/release）、关 MCP（复用 /api/engine/restart mcp=[]）
//   · 顶部：只留当前列（confirmModal 确认）、全部刷新（重读 stats）
//   · 底部：共 N 个引擎 · 合计 X MB · 上限 4
//
// 数据源是桥侧的 GET /api/engines/stats（RSS 已含 pi + MCP 子进程整棵树，桥侧 5s 缓存）。

const $ = (id) => document.getElementById(id);

function fmtMb(mb) {
  if (mb == null || !Number.isFinite(Number(mb))) return "—";
  const n = Number(mb);
  return `${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10}MB`;
}

function fmtIdle(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return "—";
  return `${Math.round(n)}s`;
}

function el(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {object} opts
 * @param {()=>Array} opts.getColumns 当前页的列（找本地列：标题/模型/释放后标记）
 * @param {()=>object|null} opts.getActive 当前活动列
 * @param {(text:string,cfg:object)=>Promise<boolean>} opts.confirm 确认框
 * @param {(text:string,kind?:string)=>void} opts.toast
 * @param {()=>void} opts.refreshHealth 释放后刷新顶栏引擎计数
 */
export function createResourcesPanel({ getColumns, getActive, confirm, toast, refreshHealth }) {
  const panel = $("resources-panel");
  const listEl = $("resources-list");
  const subEl = $("resources-sub");
  const summaryEl = $("resources-summary");
  const statusEl = $("resources-status");
  const closeBtn = $("resources-close");
  const refreshBtn = $("resources-refresh");
  const keepBtn = $("resources-keep-active");
  const openBtn = $("open-resources");

  const state = { open: false, rows: [], stats: null, busy: false };

  const localColumn = (client) => (getColumns() || []).find((col) => col.clientId === client) || null;

  function setStatus(text, kind = "info") {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.dataset.kind = kind;
    statusEl.hidden = !text;
  }

  function setBusy(busy) {
    state.busy = busy;
    for (const btn of [keepBtn, refreshBtn]) if (btn) btn.disabled = busy;
    for (const tr of listEl?.querySelectorAll("tr[data-client]") ?? []) {
      const row = state.rows.find((item) => item.client === tr.dataset.client);
      const release = tr.querySelector(".res-release");
      const mcpOff = tr.querySelector(".res-mcp-off");
      if (release) release.disabled = busy;
      if (mcpOff) mcpOff.disabled = busy || !(row?.mcp?.length > 0);
    }
  }

  function paintSummary() {
    if (!summaryEl) return;
    const total = Math.round((state.stats?.totalRssMB ?? 0) * 10) / 10;
    const count = state.stats?.count ?? state.rows.length;
    const max = state.stats?.max ?? "—";
    summaryEl.textContent = `共 ${count} 个引擎 · 合计 ${fmtMb(total)} · 上限 ${max}`;
  }

  function cell(text, className = "") {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = text;
    return td;
  }

  function paintRows() {
    if (!listEl) return;
    listEl.replaceChildren();
    const table = el("table", "resources-table");
    const thead = el("thead");
    const hr = el("tr");
    for (const label of ["标题", "模型", "状态", "MCP", "内存", "空闲", "操作"]) hr.appendChild(el("th", "", label));
    thead.appendChild(hr);
    const tbody = el("tbody");

    const active = getActive();
    for (const row of state.rows) {
      const tr = el("tr");
      tr.dataset.client = row.client;
      if (active && row.client === active.clientId) tr.dataset.current = "1";

      const col = localColumn(row.client);
      const title = row.sessionTitle || col?.title || String(row.sessionId || "").slice(0, 8) || "（新会话）";
      const model = col?.model || "—";

      tr.appendChild(cell(title, "res-title"));
      tr.appendChild(cell(model, "res-model"));
      tr.appendChild(cell(row.state || "—", "res-state"));
      tr.appendChild(cell(row.mcp?.length ? row.mcp.join(" + ") : "—", "res-mcp"));
      const rss = cell(fmtMb(row.rssMB), "res-rss");
      rss.title = row.piPid ? `pi pid ${row.piPid}（含 MCP 子进程整棵树）` : "进程未启动";
      tr.appendChild(rss);
      tr.appendChild(cell(fmtIdle(row.idleSec), "res-idle"));

      const ops = document.createElement("td");
      ops.className = "res-ops";
      const release = el("button", "res-btn res-release", "释放");
      release.type = "button";
      release.title = "关掉这个引擎（会话文件保留，重新打开会话可恢复）";
      release.addEventListener("click", () => releaseClient(row.client));
      const mcpOff = el("button", "res-btn res-mcp-off", "关 MCP");
      mcpOff.type = "button";
      mcpOff.disabled = state.busy || !(row.mcp?.length > 0);
      mcpOff.title = row.mcp?.length ? "重启该引擎并清空 MCP（会话不变）" : "该引擎未启用 MCP";
      mcpOff.addEventListener("click", () => closeMcp(row.client));
      ops.append(release, mcpOff);
      tr.appendChild(ops);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    listEl.appendChild(table);
    if (!state.rows.length) {
      listEl.appendChild(el("p", "resources-empty", "当前没有运行中的引擎。"));
    }
  }

  async function loadStats() {
    const res = await fetch("/api/engines/stats", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    state.stats = data;
    state.rows = Array.isArray(data.engines) ? data.engines : [];
    paintRows();
    paintSummary();
    return data;
  }

  async function refresh() {
    if (state.busy) return;
    setBusy(true);
    setStatus("");
    try {
      await loadStats();
    } catch (err) {
      setStatus(`读取资源失败：${err.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function releaseClient(client) {
    if (state.busy) return;
    setBusy(true);
    setStatus("正在释放引擎…");
    try {
      const res = await fetch("/api/engine/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const col = localColumn(client);
      if (col) col.markReleased?.("已释放（重新打开会话可恢复）");
      setStatus("");
      toast(data.released === false ? "引擎已不在运行" : "已释放引擎", "info");
    } catch (err) {
      setStatus(`释放失败：${err.message}`, "error");
      toast("释放引擎失败", "error");
    } finally {
      setBusy(false);
      refreshHealth?.();
      await refresh();
    }
  }

  async function closeMcp(client) {
    if (state.busy) return;
    setBusy(true);
    setStatus("正在关闭 MCP（重启该引擎，会话不变）…");
    try {
      const res = await fetch("/api/engine/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client, mcp: [] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const col = localColumn(client);
      if (col) {
        col.mcp = [];
        col.manualRetry?.(); // 引擎换了子进程：重新接事件流
      }
      setStatus("");
      toast("已关闭该引擎的 MCP（会话不变）", "info");
    } catch (err) {
      setStatus(`关闭 MCP 失败：${err.message}`, "error");
      toast("关闭 MCP 失败", "error");
    } finally {
      setBusy(false);
      refreshHealth?.();
      await refresh();
    }
  }

  async function keepOnlyActive() {
    if (state.busy) return;
    const active = getActive();
    if (!active) return;
    const others = state.rows.filter((row) => row.client !== active.clientId);
    if (!others.length) {
      toast("已经只有当前列在运行", "info");
      return;
    }
    const ok = await confirm(`释放其它 ${others.length} 个引擎，只保留当前列（会话文件都保留，可重新打开恢复）。继续？`, {
      title: "只留当前列",
      confirmText: "释放其它",
      cancelText: "取消",
    });
    if (!ok) return;
    setBusy(true);
    setStatus("正在释放其它引擎…");
    try {
      for (const row of others) {
        const res = await fetch("/api/engine/release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client: row.client }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
        const col = localColumn(row.client);
        if (col) col.markReleased?.("已释放（重新打开会话可恢复）");
      }
      setStatus("");
      toast(`已释放 ${others.length} 个引擎，只保留当前列`, "info");
    } catch (err) {
      setStatus(`释放失败：${err.message}`, "error");
      toast("只留当前列失败", "error");
    } finally {
      setBusy(false);
      refreshHealth?.();
      await refresh();
    }
  }

  async function open() {
    if (!panel) return;
    state.open = true;
    panel.hidden = false;
    if (subEl) subEl.textContent = "RSS 为整棵进程树（pi + MCP 子进程），桥侧 5s 缓存。";
    await refresh();
  }

  function close() {
    state.open = false;
    if (panel) panel.hidden = true;
    setStatus("");
  }

  // 事件绑定（只绑一次）
  openBtn?.addEventListener("click", () => open());
  closeBtn?.addEventListener("click", () => close());
  refreshBtn?.addEventListener("click", () => refresh());
  keepBtn?.addEventListener("click", () => keepOnlyActive());
  panel?.addEventListener("pointerdown", (ev) => {
    if (ev.target === panel) close();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.open) {
      // 确认框开着时 Esc 归 confirmModal（它自己处理），不要顺手关面板
      if (!$("modal") || $("modal").hidden) close();
    }
  });

  return { open, close, refresh, get state() { return state; } };
}
