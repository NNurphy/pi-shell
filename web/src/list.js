// pi-shell · T-07：会话列表（分组可折叠 + 四字段 + 虚拟化 >200 项）
// 虚拟化策略：把「组头 + 会话行」摊平成固定高度的行数组，只渲染可视窗口 ± 缓冲行；
// 行高来自 tokens.css 的 --row-group-h / --row-session-h（B8：组 32 / 会话 56，三行密度），
// 切换密度后由 main.js 调 relayout() 重算。
// 可断言标记：data-role=session-row / group-row / list-spacer / warnings / empty / error。

const BUFFER = 6;
const AGENT_SECTION = "__agent__"; // 「AGENT 会话」独立板块的折叠键（与真实 cwd 分组不冲突）

/** 行高从 token 读（密度切换只需改 CSS 变量，不要在两处维护数字） */
function readRowHeights() {
  let styles = null;
  try {
    styles = getComputedStyle(document.documentElement);
  } catch {}
  const num = (name, fallback) => {
    const raw = styles?.getPropertyValue(name) || "";
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { group: num("--row-group-h", 32), session: num("--row-session-h", 56) };
}

/**
 * 把服务端分组拆成两部分：
 * - agentSessions：origin=agent 的会话（跨 cwd 合并，按更新时间倒序）→ 顶部独立板块
 * - groups：其余会话，保持原有 cwd 分组（**不重新分组**，只把 agent 会话移走；空组丢掉）
 */
export function partitionGroups(groups) {
  const agentSessions = [];
  const rest = [];
  for (const group of groups ?? []) {
    const keep = [];
    for (const session of group.sessions ?? []) {
      if (session.origin === "agent") agentSessions.push(session);
      else keep.push(session);
    }
    if (keep.length) rest.push({ ...group, sessions: keep });
  }
  agentSessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { agentSessions, groups: rest };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, "0");
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function createSessionList({ root, onOpen, onDelete, fetchJson }) {
  const warningsBar = el("div", "warnings");
  warningsBar.dataset.role = "warnings";
  warningsBar.hidden = true;

  const viewport = el("div", "list-viewport");
  viewport.dataset.role = "list-viewport";
  const spacer = el("div", "list-spacer");
  spacer.dataset.role = "list-spacer";
  const layer = el("div", "list-layer");
  layer.dataset.role = "list-layer";
  viewport.appendChild(spacer);
  viewport.appendChild(layer);

  const placeholder = el("div", "list-placeholder");
  placeholder.dataset.role = "list-placeholder";

  root.replaceChildren(warningsBar, placeholder, viewport);

  const model = {
    groups: [],
    agentSessions: [],
    warnings: [],
    expanded: new Set(),
    currentId: null,
    rows: [],
    totalHeight: 0,
    loading: false,
    error: null,
    lastLoadedAt: null,
  };

  function rebuildRows() {
    const rows = [];
    const H = readRowHeights();
    // 1) 顶部独立板块：AGENT 会话（N）——跨 cwd 合并，按更新时间倒序
    if (model.agentSessions.length) {
      const open = model.expanded.has(AGENT_SECTION);
      const group = { dir: AGENT_SECTION, cwd: "AGENT 会话", agent: true, sessions: model.agentSessions };
      rows.push({ kind: "group", group, open, height: H.group });
      if (open) {
        for (const session of group.sessions) rows.push({ kind: "session", group, session, height: H.session });
      }
    }
    // 2) 用户会话照旧按 cwd 分组（test 已在服务端默认过滤）
    for (const group of model.groups) {
      const open = model.expanded.has(group.dir);
      rows.push({ kind: "group", group, open, height: H.group });
      if (open) {
        for (const session of group.sessions) rows.push({ kind: "session", group, session, height: H.session });
      }
    }
    let top = 0;
    for (const row of rows) {
      row.top = top;
      top += row.height;
    }
    model.rows = rows;
    model.totalHeight = top;
    spacer.style.height = `${top}px`;
  }

  function groupRow(row) {
    const node = el("div", "group-row");
    node.dataset.role = "group-row";
    node.dataset.dir = row.group.dir;
    node.dataset.open = row.open ? "true" : "false";
    const caret = el("span", "caret", row.open ? "▾" : "▸");
    caret.dataset.role = "group-toggle";
    node.appendChild(caret);
    if (row.group.agent) {
      // 独立板块标题（B8：文字徽标「AGENT 会话」+ 计数，不用 emoji）
      node.dataset.agent = "true";
      node.classList.add("agent-group");
      node.appendChild(el("span", "group-cwd", "AGENT 会话"));
      node.appendChild(el("span", "group-count", String(row.group.sessions.length)));
    } else {
      node.appendChild(el("span", "group-cwd", row.group.cwd || row.group.dir));
      node.appendChild(el("span", "group-count", String(row.group.sessions.length)));
    }
    if (row.group.flat) {
      const badge = el("span", "badge", "flat");
      badge.title = "--session-dir 扁平目录（按 header.cwd 分组）";
      node.appendChild(badge);
    }
    node.addEventListener("click", () => {
      if (model.expanded.has(row.group.dir)) model.expanded.delete(row.group.dir);
      else model.expanded.add(row.group.dir);
      rebuildRows();
      renderWindow();
    });
    return node;
  }

  function sessionRow(row) {
    const s = row.session;
    const isAgent = s.origin === "agent";
    const node = el("div", "session-row");
    node.dataset.role = "session-row";
    node.dataset.path = s.path;
    node.dataset.sessionId = s.id;
    node.dataset.attached = s.status === "attached" ? "true" : "false";
    // 只有 agent 会话打 origin 标记（用户会话不加，避免把「默认值」当特征）
    if (isAgent) node.dataset.origin = "agent";
    if (model.currentId && s.id === model.currentId) node.dataset.current = "true";

    const dot = el("span", "dot");
    dot.dataset.role = "attached-dot";
    dot.title = s.status === "attached" ? "本壳正在使用" : "未在本壳打开";
    node.appendChild(dot);

    const main = el("div", "session-main");
    const titleLine = el("div", "session-title-line");
    const title = el("div", "session-title", s.title || "(无标题)");
    title.dataset.field = "title";
    titleLine.appendChild(title);
    if (isAgent) {
      const badge = el("span", "origin-badge", "AGENT");
      badge.dataset.role = "origin-badge";
      badge.title = "由 PI AI / 派出的开发 Agent 发起";
      titleLine.appendChild(badge);
    }
    main.appendChild(titleLine);

    // 三行密度：标题 / 元数据（时间 · 状态）/ 摘要。缺失的维度不占位（不编数字）。
    const metaRow = el("div", "session-meta-row");
    const time = el("span", "session-time", fmtTime(s.updatedAt));
    time.dataset.field = "updatedAt";
    metaRow.appendChild(time);
    const phase = s.status === "attached" ? "本壳打开" : "未打开";
    metaRow.appendChild(el("span", "sep", "·"));
    metaRow.appendChild(el("span", "session-phase", phase));
    main.appendChild(metaRow);

    const snippet = el("div", "session-snippet", s.lastSnippet || "(无摘要)");
    snippet.dataset.field = "lastSnippet";
    main.appendChild(snippet);
    node.appendChild(main);

    // B-12：删除按钮。独立按钮（不叠在标题上）→ 点标题仍然是「打开会话」。
    // agent 会话同样可删（分类不影响删除，只影响归属展示）。
    const del = el("button", "session-delete", "删");
    del.type = "button";
    del.dataset.role = "session-delete";
    del.title = `删除「${s.title || "(无标题)"}」（移到 backups/deleted-sessions，可从磁盘恢复）`;
    del.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // 关键：不要顺带触发外层 session-row 的「打开」
      onDelete?.(s);
    });
    node.appendChild(del);

    node.addEventListener("click", () => onOpen?.(s));
    return node;
  }

  function renderWindow() {
    const top = viewport.scrollTop;
    const height = viewport.clientHeight || 600;
    const overscan = BUFFER * readRowHeights().session;
    const from = Math.max(0, top - overscan);
    const to = top + height + overscan;
    const visible = model.rows.filter((r) => r.top + r.height >= from && r.top <= to);
    const nodes = visible.map((row) => {
      const node = row.kind === "group" ? groupRow(row) : sessionRow(row);
      node.style.position = "absolute";
      node.style.top = `${row.top}px`;
      node.style.left = "0";
      node.style.right = "0";
      node.style.height = `${row.height}px`;
      return node;
    });
    layer.replaceChildren(...nodes);
    viewport.dataset.rendered = String(nodes.length);
    viewport.dataset.total = String(model.rows.length);
  }

  function renderStates() {
    warningsBar.hidden = model.warnings.length === 0;
    warningsBar.textContent = model.warnings.length
      ? `⚠ ${model.warnings.length} 条提示：${model.warnings.slice(0, 2).map((w) => w.reason).join("；")}${model.warnings.length > 2 ? " …" : ""}`
      : "";

    placeholder.replaceChildren();
    viewport.hidden = false;
    if (model.loading) {
      placeholder.dataset.state = "loading";
      placeholder.textContent = "正在扫描会话…";
      placeholder.hidden = false;
    } else if (model.error) {
      placeholder.dataset.state = "error";
      const text = el("div", "state-text", `读取会话失败：${model.error}`);
      const retry = el("button", "state-retry", "重试");
      retry.dataset.role = "retry";
      retry.addEventListener("click", () => load());
      placeholder.appendChild(text);
      placeholder.appendChild(retry);
      placeholder.hidden = false;
    } else if (model.rows.length === 0) {
      placeholder.dataset.state = "empty";
      placeholder.textContent = "没有会话（空会话不落盘：先发一条消息才会出现在这里）";
      placeholder.hidden = false;
    } else {
      delete placeholder.dataset.state;
      placeholder.hidden = true;
    }
  }

  let query = "";
  let baseGroups = []; // 最近一次「未过滤」的全量分组（用于本地即时过滤，不重读文件）

  /** 用内存里的索引做一次本地过滤（0 网络），供输入即时反馈；服务端 ?q= 稍后校正 */
  function filterLocally(q) {
    const needle = String(q || "").trim().toLowerCase();
    const source = baseGroups.length ? baseGroups : model.groups;
    const filtered = !needle
      ? source
      : source
          .map((g) => ({
            ...g,
            sessions: g.sessions.filter(
              (s) => String(s.title || "").toLowerCase().includes(needle) || String(s.lastSnippet || "").toLowerCase().includes(needle),
            ),
          }))
          .filter((g) => g.sessions.length > 0);
    const parts = partitionGroups(filtered);
    model.groups = parts.groups;
    model.agentSessions = parts.agentSessions;
    rebuildRows();
    renderStates();
    renderWindow();
    return model.rows.filter((r) => r.kind === "session").length;
  }

  async function load(nextQuery) {
    if (nextQuery !== undefined) query = nextQuery;
    model.loading = true;
    model.error = null;
    renderStates();
    try {
      const data = await fetchJson(`/api/sessions${query ? `?q=${encodeURIComponent(query)}` : ""}`);
      const parts = partitionGroups(data.groups ?? []);
      model.groups = parts.groups;
      model.agentSessions = parts.agentSessions;
      if (!query) baseGroups = data.groups ?? []; // 只把未过滤结果作为本地过滤基准（分区每次都重算）
      model.warnings = data.warnings ?? [];
      model.currentId = findCurrent(data.groups) ?? model.currentId;
      // 首次加载：分组**默认收起**（用户要求：每次打开页面左侧不要自动展开）。
      // 用户点组头展开后，selection 记在 model.expanded 里，后续刷新/过滤保持。
      model.loading = false;
      model.lastLoadedAt = Date.now();
      rebuildRows();
      renderStates();
      renderWindow();
    } catch (err) {
      model.loading = false;
      model.error = err?.message || String(err);
      model.rows = [];
      model.totalHeight = 0;
      spacer.style.height = "0px";
      layer.replaceChildren();
      renderStates();
    }
    return model;
  }

  function findCurrent(groups) {
    for (const g of groups ?? []) for (const s of g.sessions ?? []) if (s.status === "attached") return s.id;
    return null;
  }

  viewport.addEventListener("scroll", renderWindow);
  window.addEventListener("resize", renderWindow);

  return {
    model,
    load,
    setQuery: (q) => load(q),
    filterLocally,
    renderStates,
    renderWindow,
    setCurrent(sessionId) {
      model.currentId = sessionId;
      renderWindow();
    },
    /** 密度切换（CSS 变量变了）→ 重算行高与行表 */
    relayout() {
      rebuildRows();
      renderWindow();
    },
    stateText: () => placeholder.dataset.state || (model.rows.length ? "rows" : "none"),
    rowSummary: () => ({ rows: model.rows.length, rendered: Number(viewport.dataset.rendered || 0), total: model.totalHeight }),
  };
}
