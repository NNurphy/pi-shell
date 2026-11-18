// pi-shell · Q4：一列 = 一个引擎 + 一个会话 + 独立的会话流 / Composer / 滚动 / 输入
//
// 为什么一列一个 clientId：桥的引擎池按 X-Pi-Shell-Client 归属（bridge/src/engines.mjs），
// 一列一个标识 → 一列一个 pi 子进程，同标签页内两列可以同时 streaming。
//   · 所有 HTTP 请求带该列的 X-Pi-Shell-Client；
//   · SSE 用 /api/events?client=<列标识>（EventSource 不能自定义请求头）。
// 列标识由 shell 生成：base#c1 / base#c2 / …（base 是标签页标识，见 main.js）。
//
// 本模块只放「列内状态与列内 DOM」；顶栏（模型/思考级别/Changes/引擎计数）、侧栏、面板、
// 偏好、确认框、扩展对话框等全局 UI 由 main.js 通过 shell 回调提供。

import { renderEntry, fmtDuration, seedToolMeta, noteToolMeta } from "./render.js";
import { createTranscript } from "./stream.js";

const LAZY_CHUNK = 100; // 长会话先渲染末 100 条，向上滚动追加
const NEAR_BOTTOM = 60;

/** 统一带列标识的 fetch：这一列的请求只认这一列的引擎 */
function apiFetch(clientId, url, init = {}) {
  const headers = new Headers(init.headers || undefined);
  headers.set("X-Pi-Shell-Client", clientId);
  return fetch(url, { ...init, headers });
}

/**
 * @param {object} opts
 * @param {string} opts.key    稳定列键（c1 / c2 …）
 * @param {string} opts.clientId 该列的引擎标识（base#cN）
 * @param {HTMLElement} opts.root 列根节点（.column）
 * @param {object} opts.shell  全局服务：toast / confirm / list / columnUpdated / setActive /
 *                             showExtDialog / submitExt / refreshChanges
 */
export function createColumn({ key, clientId: initialClientId, root, shell }) {
  let clientId = initialClientId;
  const q = (sel) => root.querySelector(sel);
  const el = {
    root,
    head: q(".col-head"),
    no: q("[data-role=col-no]"),
    title: q("[data-role=col-title]"),
    mcp: q("[data-role=col-mcp]"),
    model: q("[data-role=col-model]"),
    close: q("[data-role=col-close]"),
    log: q("[data-role=log]"),
    jumpBottom: q("[data-role=jump-bottom]"),
    sessionBar: q("[data-role=session-bar]"),
    sessionMeta: q("[data-role=session-meta]"),
    stats: q("[data-role=stats]"),
    widget: q("[data-role=widget]"),
    form: q("[data-role=composer]"),
    input: q("[data-role=composer-input]"),
    send: q("[data-role=send]"),
    abort: q("[data-role=abort]"),
    behavior: q("[data-role=behavior]"),
    imageInput: q("[data-role=image-input]"),
    fileInput: q("[data-role=file-input]"),
    attachBar: q("[data-role=attach-bar]"),
    notice: q("[data-role=notice]"),
    attachBanner: q("[data-role=attach-banner]"),
    attachText: q("[data-role=attach-text]"),
    attachRetry: q(".attach-retry"),
    reconnect: q("[data-role=reconnect]"),
    reconnectText: q("[data-role=reconnect-text]"),
    reconnectBtn: q(".reconnect-btn"),
  };

  const c = {
    key,
    clientId,
    el,
    // ---- 会话 ----
    sessionId: null,
    sessionPath: null,
    cwd: "",
    cwdPending: false, // B1/T6：createSession 切目录期间为 true（refreshChanges 不得用旧 cwd 查 diff）
    title: "新会话",
    attachState: "idle", // idle | viewing | attached | failed
    attachSessionRef: null,
    lastEntryId: null,
    lastSessionState: null, // 最近一次 get_state / SSE session（模型/思考级别真相）
    model: null, // `${provider}/${id}`（顶栏模型下拉显示这一列的值）
    thinkingLevel: null,
    // ---- 引擎状态 ----
    state: "not_started",
    mcp: [], // 该列引擎实际启用的 MCP server 名单（空 = 不带，默认）
    released: false, // N1-b：用户从资源面板释放了本列引擎（重新打开会话可恢复）
    streamStartedAt: null,
    // ---- 实时消息 ----
    liveNodes: null,
    liveView: new Map(),
    liveSeq: 0,
    expandedTools: new Set(), // PIX-3：展开的父工具（子调用默认折叠）
    durTimer: null, // PIX-3：200ms 跳秒定时器
    lastTurn: null, // PIX-4：桥广播的当前轮号（turn_changes 帧）
    transcript: createTranscript(),
    lazy: { entries: [], renderedFrom: 0, sessionId: null, body: null, more: null },
    // ---- 滚动跟随 ----
    pinned: true,
    pinScrollAt: 0,
    pinScrollTop: -1,
    // ---- 输入 ----
    attachments: [],
    // ---- SSE ----
    es: null,
    lastSeq: null, // S4：已应用的最后一个 SSE seq（断线重连带 ?since=，桥只回放落盘点之后的尾巴）
    needsAuthoritativeReload: false, // S4：回放过尾巴 / truncated → 本回合结束后做一次权威重载
    reloadPending: false, // 重载进行中又来了一次「必须重载」→ 结束后再补一次
    reloading: false,
    lastResume: null, // S4：最后一帧 resume（truncated 取证位）
    truncatedNotice: false, // S4：「部分输出未能补齐」提示还在生效（重载成功后改成实话）
    bridgeSessionId: null, // S4：bridge_state.session.sessionId（引擎当前真正持有的会话）
    // P0（2026-11-14 事故）：引擎被 idle-sweep 回收后重连，桥会起新引擎 + 空会话。
    // 前端必须能把「本列这条会话」重新接管回来，并把模型/思考级别跟回 —— 见 restoreSession()。
    wantModel: null, // 本列记住的模型：只由会话真相 / 用户主动选择更新，引擎的临时状态不许覆盖
    wantThinking: null, // 同上：本列记住的思考级别
    restoreInflight: null, // 同一次接管只跑一次（并发触发共用同一个 promise）
    restoreTriedFor: null, // 本次连接已自动恢复过的 sessionPath（防抖；「重试」会清掉）
    restorePrefsPending: false, // 接管回执到达后再对齐模型/思考级别
    applyingWanted: false, // applyWanted 防重入
    restoreCheckPending: false, // 重连后等「连接快照 bridge_state」再判定引擎身份（缓存值可能是旧引擎的）
    restoreCheckTimer: null,
    restoreAttempts: 0, // 本列真正发起过的「自动接管」次数（防抖证据）
    retryAttempt: 0,
    retryTimer: null,
    backfilling: false,
    // ---- 扩展 UI（该引擎的 widget/status 只影响这一列） ----
    widgetLines: [],
  };

  // ============================ 提示 / 接管状态 ============================

  c.showNotice = (text, isError = false) => {
    if (!el.notice) return;
    el.notice.textContent = text || "";
    el.notice.dataset.kind = isError ? "error" : "info";
    el.notice.hidden = !text;
  };

  c.setAttachState = (next, text = "") => {
    c.attachState = next;
    el.attachBanner.hidden = next === "idle" || next === "attached";
    el.attachText.textContent =
      text || (next === "viewing" ? "读取中…" : next === "failed" ? "接管失败：当前为只读浏览" : "");
    el.attachRetry.hidden = next !== "failed";
    applyComposerState();
    if (el.attachBanner) el.attachBanner.dataset.state = next;
    shell.columnUpdated(c);
  };

  /** composer / 按钮的可用性：由「引擎状态 + 接管进度」共同决定（一列一套，互不影响） */
  function applyComposerState() {
    if (c.released) {
      el.send.disabled = true;
      el.abort.disabled = true;
      el.behavior.hidden = true;
      el.form.dataset.streaming = "false";
      el.input.placeholder = "引擎已释放：从左侧重新打开会话即可恢复";
      return;
    }
    const canSend = c.attachState === "attached" || c.attachState === "idle";
    el.send.disabled = !canSend || ["starting", "failed", "stopping"].includes(c.state);
    el.abort.disabled = c.state !== "streaming";
    el.behavior.hidden = c.state !== "streaming";
    // 单列 Composer 只显示一个主按钮（idle=发送 / streaming=中止），靠 form 上的 data-streaming
    el.form.dataset.streaming = c.state === "streaming" ? "true" : "false";
    el.input.placeholder = canSend
      ? "输入消息（Enter 换行 · Ctrl+Enter 发送 · Ctrl+K 命令面板 · Ctrl+U 注入文件）"
      : "只读浏览中：等待接管完成或重试…";
  }

  // ============================ HTTP（带本列 clientId） ============================

  c.fetch = (url, init) => apiFetch(clientId, url, init);

  c.postJson = async (url, body) => {
    const res = await apiFetch(clientId, url, {
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
  };

  // ============================ 打开会话（两段式） ============================

  /** 会话列表点击的守卫：本列 streaming 时切会话会中止当前回合 → 先确认 */
  c.requestOpen = async (session) => {
    if (c.state !== "streaming") return c.openSession(session);
    const ok = await shell.confirm("当前回答正在生成，切换会话会中止它（这一轮未落盘的部分不会保留）。继续？", {
      title: "切换会话",
      confirmText: "继续",
      cancelText: "取消",
    });
    if (!ok) return; // 取消：本列的对话区/实时节点/滚动位置都保持原样
    return c.openSession(session);
  };

  c.openSession = async (session) => {
    // N1-b：本列引擎被释放后，重新打开会话 = 重新认领引擎（同 clientId）→ 恢复可发送
    if (c.released) {
      const ok = await shell.claimEngine?.(c);
      if (!ok) {
        c.showNotice("引擎未恢复：仍为已释放状态", true);
        return;
      }
      c.released = false;
      c.showNotice("");
      c.connect();
    }
    if (c.sessionId) shell.rememberScroll(c.sessionId, el.log.scrollTop);
    c.showNotice("");
    // 换到另一条会话：上一条的「已恢复」标记不再适用（同一条会话的重开保留它）
    if (c.sessionPath && !samePath(c.sessionPath, session.path)) markRestored("");
    c.attachSessionRef = session;
    c.setAttachState("viewing");
    try {
      const data = await c.postJson("/api/session/open", { path: session.path });
      c.sessionId = data.sessionId;
      c.lastTurn = null; // PIX-4：换会话后「本轮」由桥的新一轮/最近一轮决定
      c.bridgeSessionId = data.state?.sessionId ?? c.bridgeSessionId;
      // S4：接管（adopted）后这条引擎换了对象，SSE 的 seq 空间跟着重置 → 不带旧 lastSeq 重连，
      // 只收「落盘点之后的尾巴」（已完成内容由本次 entries 渲染）
      if (data.adopted) c.lastSeq = null;

      c.sessionPath = session.path;
      c.cwd = session.cwd || data.cwd || "";
      c.lastEntryId = data.leafId ?? null;
      c.title = session.title || String(data.sessionId || "").slice(0, 8) || "会话";
      renderSession(data);
      shell.list.setCurrent(data.sessionId);
      shell.setSidebarOpen(false); // 移动端：选中会话后抽屉自动关闭
      el.sessionMeta.textContent = `${String(data.sessionId || "?").slice(0, 8)} · ${c.cwd} · ${data.entries?.length ?? 0} 条条目`;
      el.sessionBar.hidden = false;
      shell.onCwd(c);
      applySessionState(data.state);
      // P0：这次「打开」是该会话的模型真相 —— 记下来，引擎被回收后据此跟回。
      // 恢复流程自己会快照 want（restoreInflight），不能被新引擎的默认值冲掉。
      if (!c.restoreInflight) rememberWanted(data.state);
      c.restoreTriedFor = null; // 用户/恢复显式打开过这条会话：下一轮重连可以再自动接管
      shell.refreshChanges();
      // B1/T6：打开会话成功 → 顶栏按该列 session/view 重新同步
      shell.syncHeaderFromSession?.(c, { delay: 0, force: true });
      if (data.attach === "attached") {
        c.setAttachState("attached");
        c.refreshStats();
      } else {
        c.setAttachState("viewing", "接管中…（内容已可读，可先向上滚动查看）");
      }
      // S4：孤儿接管成功 → 立刻把 SSE 挂到「被接管的那条引擎」上（回放 + 实时帧都要落在这条上）。
      // 无感：不弹错、不改文案；旧连接先关（connect 内部会关），重连失败由既有退避兜底。
      if (data.adopted) c.connect();
      shell.columnUpdated(c);
      return data;
    } catch (err) {
      if (err.status === 409) {
        // 同一文案覆盖两种 409：并台保护（另一个标签页/列已打开）/ cwd 丢失
        const taken = /已在另一个标签页打开/.test(err.message);
        c.setAttachState(
          "failed",
          taken ? "只读浏览：该会话已在另一个标签页打开" : "只读浏览：项目目录已移动或删除",
        );
        c.showNotice(
          taken
            ? `打开失败：${err.message.replace(/^CONFLICT:\s*/, "")}（当前为只读）`
            : `打开失败：项目目录已移动或删除（409 CONFLICT）—— ${err.message}`,
          true,
        );
        return;
      }
      c.showNotice(`打开失败：${err.message}`, true);
    }
  };

  // ============================ 渲染会话流 ============================

  function renderSession(data) {
    el.log.replaceChildren();
    const body = document.createElement("div");
    body.className = "entries";
    body.dataset.role = "entries";
    el.log.appendChild(body);

    const all = data.entries ?? [];
    // PIX-3：先扫一遍全量条目，拿到 toolCall ↔ toolResult 的耗时（历史会话用时间戳近似）
    seedToolMeta(data.sessionId, all);
    c.lazy = { entries: all, renderedFrom: Math.max(0, all.length - LAZY_CHUNK), sessionId: data.sessionId, body, more: null };

    if (c.lazy.renderedFrom > 0) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "load-more";
      more.dataset.role = "load-more";
      more.textContent = `加载更早的 ${Math.min(LAZY_CHUNK, c.lazy.renderedFrom)} 条（共 ${all.length} 条）`;
      more.addEventListener("click", () => loadEarlier());
      body.appendChild(more);
      c.lazy.more = more;
    }
    for (const entry of all.slice(c.lazy.renderedFrom)) {
      const node = renderEntry(entry, data.sessionId);
      if (node) body.appendChild(node);
    }
    body.dataset.entries = String(all.length - c.lazy.renderedFrom);
    body.dataset.total = String(all.length);
    body.dataset.leafId = data.leafId ?? "";

    c.liveNodes = null;
    resetLive();
    const saved = shell.recallScroll(data.sessionId);
    if (typeof saved === "number") {
      // 切回旧会话：恢复记忆位置（可能不在底部）；切换列同样不重置滚动
      el.log.scrollTop = saved;
      c.pinScrollAt = 0; // 这不是「贴底」动作，别让 self-guard 吞掉这次 scroll 事件
      syncPinned();
    } else {
      pinToBottom(); // 打开会话：定位到末尾
    }
  }

  /** 向上追加一整块（保持滚动位置不跳） */
  function loadEarlier() {
    const lazy = c.lazy;
    if (!lazy.body || lazy.renderedFrom <= 0) return;
    const from = Math.max(0, lazy.renderedFrom - LAZY_CHUNK);
    const before = el.log.scrollTop;
    const beforeHeight = el.log.scrollHeight;
    const nodes = [];
    for (const entry of lazy.entries.slice(from, lazy.renderedFrom)) {
      noteToolMeta(lazy.sessionId, entry);
      const node = renderEntry(entry, lazy.sessionId);
      if (node) nodes.push(node);
    }
    const anchor = lazy.more ? lazy.more.nextSibling : lazy.body.firstChild;
    for (const node of nodes) lazy.body.insertBefore(node, anchor);
    lazy.renderedFrom = from;
    if (lazy.more) {
      if (from === 0) {
        lazy.more.remove();
        lazy.more = null;
      } else {
        lazy.more.textContent = `加载更早的 ${Math.min(LAZY_CHUNK, from)} 条（共 ${lazy.entries.length} 条）`;
      }
    }
    el.log.scrollTop = before + (el.log.scrollHeight - beforeHeight); // 视觉上不跳动
    lazy.body.dataset.entries = String(lazy.entries.length - lazy.renderedFrom);
  }

  // ---------- 滚动跟随（只有用户本来就在底部时才自动跟随） ----------

  function isNearBottom(node, threshold = NEAR_BOTTOM) {
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
  }

  function setJumpVisible(visible) {
    if (el.jumpBottom) el.jumpBottom.hidden = !visible;
  }

  function syncPinned() {
    c.pinned = isNearBottom(el.log);
    setJumpVisible(!c.pinned);
    return c.pinned;
  }

  function pinToBottom() {
    el.log.scrollTop = el.log.scrollHeight;
    c.pinScrollAt = performance.now();
    c.pinScrollTop = el.log.scrollTop;
    c.pinned = true;
    setJumpVisible(false);
  }

  function autoScrollIfPinned(force = false) {
    if (force) {
      pinToBottom();
      return true;
    }
    if (!c.pinned) return false;
    el.log.scrollTop = el.log.scrollHeight;
    setJumpVisible(false);
    return true;
  }

  el.jumpBottom?.addEventListener("click", () => {
    pinToBottom();
    el.input.focus();
  });

  el.log.addEventListener("scroll", () => {
    if (el.log.scrollTop < 80 && c.lazy.renderedFrom > 0) loadEarlier();
    // 自己贴底触发的 scroll 事件不算「用户离开底部」：否则内容和事件之间的间隙会让跟随永久断掉
    const selfPin = performance.now() - c.pinScrollAt < 300 && Math.abs(el.log.scrollTop - c.pinScrollTop) < 1;
    if (selfPin) return;
    syncPinned();
  });

  // ---------- 实时消息（富渲染替换） ----------

  function ensureLiveContainer() {
    if (c.liveNodes && c.liveNodes.isConnected) return c.liveNodes;
    c.liveNodes = document.createElement("div");
    c.liveNodes.className = "live";
    c.liveNodes.dataset.role = "live";
    el.log.appendChild(c.liveNodes);
    // 新容器只清「DOM 映射」，**不清 transcript.items**：
    // items 是调用方（applyFrame 刚算出的本轮状态）刚建好的，在这里清会把 message_start
    // 和首个 delta 的条目连根拔掉 —— 直播态「思考排在正文之后」「富渲染重复」都源于这一刀。
    c.liveView = new Map();
    c.expandedTools.clear();
    stopDurationTicker();
    return c.liveNodes;
  }

  function resetLive() {
    c.transcript.items.length = 0;
    if (c.liveNodes && c.liveNodes.isConnected) c.liveNodes.replaceChildren();
    c.liveView = new Map();
    c.expandedTools.clear();
    stopDurationTicker();
  }

  const KIND_CLASS = { user: "msg-user", assistant: "msg-assistant", thinking: "msg-thinking", tool: "msg-tool", notice: "msg-notice" };

  function liveElapsed(item) {
    if (item?.durationMs != null) return fmtDuration(item.durationMs);
    if (item?.startedAt != null) return fmtDuration(performance.now() - item.startedAt);
    return "";
  }

  /** 工具参数摘要（工具行的命令位）：优先常见字段，单行省略交给 CSS */
  function toolArgSummary(args) {
    if (!args || typeof args !== "object") return "";
    for (const key of ["command", "cmd", "path", "file_path", "pattern", "query"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
    }
    return Object.entries(args)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v)}`)
      .join(" ")
      .slice(0, 120);
  }

  /** PIX-3：子调用默认折叠 —— 只让「已展开的父工具」的子行可见（按 parentKey 递归） */
  function applyToolNesting() {
    const container = c.liveNodes;
    if (!container) return;
    const visibility = new Map();
    for (const node of container.querySelectorAll('[data-pix-tool], [data-role="live-tool"]')) {
      const key = node.dataset.toolKey || "";
      const depth = Number(node.dataset.depth || 0);
      const parentKey = node.dataset.parentKey || "";
      let visible = true;
      if (depth > 0 && parentKey) {
        const parentVisible = visibility.has(parentKey) ? visibility.get(parentKey) : true;
        visible = parentVisible && c.expandedTools.has(parentKey);
      }
      visibility.set(key, visible);
      node.hidden = !visible;
    }
  }

  /** PIX-3：运行中工具行的跳秒（200ms 一次，只改文本，不重排） */
  function refreshLiveDurations() {
    let running = 0;
    for (const item of c.transcript.items) {
      if (item.kind !== "tool") continue;
      const node = c.liveView.get(item.key);
      const bound = node?.dataset?.bound === "1";
      const durEl = node?.firstChild?.querySelector?.(bound ? '[data-role="tool-duration"]' : ".turn-dur");
      if (!durEl) continue;
      if (item.durationMs != null) continue;
      if (item.startedAt != null && (item.status === "运行中" || item.status === "调用中")) {
        running += 1;
        durEl.textContent = bound ? liveElapsed(item) : ` · ${liveElapsed(item)}`;
      }
    }
    if (!running) stopDurationTicker();
  }

  function startDurationTicker() {
    if (c.durTimer) return;
    c.durTimer = setInterval(refreshLiveDurations, 200);
    c.durTimer.unref?.();
  }

  function stopDurationTicker() {
    if (!c.durTimer) return;
    clearInterval(c.durTimer);
    c.durTimer = null;
  }

  // 父工具的「+N 个子调用」点击：展开/折叠子行（事件委托，节点被替换也不丢）
  el.log.addEventListener("click", (ev) => {
    const btn = ev.target.closest?.('[data-role="tool-children"]');
    if (!btn) return;
    const row = btn.closest('[data-pix-tool], [data-role="live-tool"]');
    const key = row?.dataset.toolKey;
    if (!key) return;
    if (c.expandedTools.has(key)) c.expandedTools.delete(key);
    else c.expandedTools.add(key);
    btn.dataset.expanded = c.expandedTools.has(key) ? "1" : "0";
    btn.title = c.expandedTools.has(key) ? "收起子调用" : "展开子调用";
    applyToolNesting();
  });

  /**
   * 兜底不变量：同一轮里 thinking 节点永远排在 assistant 正文节点之前。
   * 只在「思考比正文晚到」时搬一次 —— 回溯到本轮起点（上一条 user）找最近的 assistant 节点，
   * 把 thinking 插到它前面；不动 user / tool 的相对顺序。
   */
  function ensureThinkingBeforeTurnText(node, item) {
    const items = c.transcript.items;
    const idx = items.indexOf(item);
    if (idx < 0 || !node.isConnected) return;
    let ref = null;
    for (let i = idx - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "user") break; // 本轮起点
      if (it.kind !== "assistant") continue;
      const n = c.liveView.get(it.key);
      if (n && n.isConnected) {
        ref = n;
        break;
      }
    }
    if (!ref || ref === node) return;
    // ref 已经在 node 之后 → 顺序已对，不动（避免每帧搬节点）
    if (node.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING) return;
    ref.before(node);
  }

  function paintLive(items, changed, forceScroll = false) {
    // 容器刚重建（刚重载过 entries / 首次直播）时 liveView 是空的：必须把整份 items 重画，
    // 只画 changed 会漏掉本轮已经存在的节点（思考/正文顺序就靠这份完整状态）。
    const reused = !!c.liveNodes?.isConnected;
    const container = ensureLiveContainer();
    const list = reused && changed && changed.length ? changed : items;
    let hasRunningTool = false;
    for (const item of list) {
      let node = c.liveView.get(item.key);
      if (!node && item.kind === "tool") {
        // 还没执行（参数流式阶段）：这一行由 assistant 富渲染里的 toolCall 块承担，不重复插行
        if (item.status === "调用中") continue;
        // PIX-3：执行开始 → 就地绑定已经渲染好的 toolCall 行（跳秒/失败/子调用都改这一行）
        if (item.toolCallId) {
          for (const candidate of container.querySelectorAll("[data-pix-tool]")) {
            if (candidate.dataset.toolId === item.toolCallId) {
              node = candidate;
              node.dataset.bound = "1";
              c.liveView.set(item.key, node);
              break;
            }
          }
        }
      }
      if (!node) {
        node = document.createElement("div");
        node.className = `msg ${KIND_CLASS[item.kind] || ""}`;
        node.dataset.role = `live-${item.kind}`;
        const label = document.createElement("div");
        label.className = "msg-label";
        label.textContent = { user: "我", assistant: "pi", thinking: "思考", tool: "工具", notice: "提示" }[item.kind] || "";
        const dur = document.createElement("span");
        dur.className = "turn-dur";
        dur.dataset.role = item.kind === "tool" ? "tool-duration" : "live-duration";
        const body = document.createElement("div");
        body.className = "msg-body";
        label.appendChild(dur);
        if (item.kind === "tool") {
          const fail = document.createElement("span");
          fail.className = "tool-fail";
          fail.dataset.role = "tool-fail";
          fail.textContent = "失败";
          fail.hidden = true;
          const kids = document.createElement("button");
          kids.type = "button";
          kids.className = "tool-children";
          kids.dataset.role = "tool-children";
          kids.hidden = true;
          label.append(fail, kids);
        }
        node.appendChild(label);
        node.appendChild(body);
        container.appendChild(node);
        c.liveView.set(item.key, node);
      }
      const body = node.lastChild;
      const bound = node.dataset.bound === "1";
      if (item.kind === "tool") {
        const depth = item.depth ?? 0;
        node.dataset.pixTool = "1";
        node.dataset.toolKey = item.key;
        node.dataset.toolId = item.toolCallId || "";
        node.dataset.depth = String(depth);
        node.dataset.parentKey = item.parentKey || "";
        node.dataset.status = item.status || "";
        node.dataset.failed = item.isError ? "1" : "0";
        if (!bound) node.dataset.role = "live-tool";
        node.style.setProperty("--tool-indent", `${depth * 20}px`);
        const summary = node.firstChild;
        if (!bound) {
          const cmd = toolArgSummary(item.args);
          body.textContent = [item.toolName, item.status, cmd].filter(Boolean).join(" · ");
        }
        // 失败标记（危险色，只占耗时位旁边）
        let failEl = summary?.querySelector?.('[data-role="tool-fail"]');
        if (!failEl && summary) {
          failEl = document.createElement("span");
          failEl.className = "tool-fail";
          failEl.dataset.role = "tool-fail";
          summary.appendChild(failEl);
        }
        if (failEl) {
          failEl.hidden = !item.isError;
          failEl.textContent = "失败";
        }
        // 子调用开关（父行）
        let kidsEl = summary?.querySelector?.('[data-role="tool-children"]');
        const n = item.childCount ?? 0;
        if (!kidsEl && summary && n > 0) {
          kidsEl = document.createElement("button");
          kidsEl.type = "button";
          kidsEl.className = "tool-children";
          kidsEl.dataset.role = "tool-children";
          summary.appendChild(kidsEl);
        }
        if (kidsEl) {
          kidsEl.hidden = n <= 0;
          kidsEl.textContent = `+${n} 个子调用`;
          kidsEl.dataset.expanded = c.expandedTools.has(item.key) ? "1" : "0";
          kidsEl.title = c.expandedTools.has(item.key) ? "收起子调用" : "展开子调用";
        }
        if (item.durationMs == null && item.startedAt != null) hasRunningTool = true;
      } else {
        body.textContent = item.text || "";
      }
      // 兜底不变量（回合没重载成功也成立）：同一轮里思考行永远排在正文行之前。
      // 直播态思考**保持展开**（用户坐在电脑前要看思考过程），折叠只在回合落定后由 entries 承担。
      if (item.kind === "thinking") ensureThinkingBeforeTurnText(node, item);
      const durEl = bound
        ? node.firstChild?.querySelector?.('[data-role="tool-duration"]')
        : node.firstChild?.querySelector?.(".turn-dur");
      if (durEl) {
        const text = item.kind === "tool" || item.kind === "assistant" ? liveElapsed(item) : "";
        durEl.textContent = bound ? text : text ? ` · ${text}` : "";
        durEl.dataset.source = item.kind === "tool" ? (item.durationMs == null ? "live" : item.durationSource || "local") : "";
      }
    }
    if (hasRunningTool) startDurationTicker();
    applyToolNesting();
    autoScrollIfPinned(forceScroll);
  }

  /** message_end：把同一条实时消息就地替换为 render.js 的富渲染（不新增节点，不重复插入） */
  function richifyMessage(message) {
    if (!message) return false;
    const container = ensureLiveContainer();
    const role = message.role;
    const kind = role === "assistant" ? "assistant" : role === "toolResult" ? "tool" : role === "user" ? "user" : null;
    const item = kind ? [...c.transcript.items].reverse().find((it) => it.kind === kind) : null;
    const node = item ? c.liveView.get(item.key) : null;
    const entry = { type: "message", id: `live-${++c.liveSeq}`, timestamp: new Date().toISOString(), message };
    const rich = renderEntry(entry, c.sessionId || "live");
    if (!rich) return false;
    // 富渲染已经把同一条消息里的 thinking 块出来了 → 撤掉直播态那条重复的思考行（不重复、不留残影）
    const richHasThinking = Array.isArray(message?.content) && message.content.some((b) => b?.type === "thinking");
    if (message?.role === "assistant" && item && richHasThinking) {
      for (const t of c.transcript.dropThinking(item.key)) {
        const tn = c.liveView.get(t.key);
        if (tn?.isConnected) tn.remove();
        c.liveView.delete(t.key);
      }
    }
    rich.classList.add("live-rich");
    rich.dataset.live = "rich";
    // PIX-3：结果行不重复显示耗时（耗时位在对应的工具调用行上）
    if (message?.role === "toolResult" && message.toolCallId) {
      const callRow = [...container.querySelectorAll("[data-pix-tool]")].find((n) => n.dataset.toolId === message.toolCallId);
      if (callRow) {
        const dur = rich.querySelector('.collapse-toolResult [data-role="tool-duration"]');
        const callDur = callRow.querySelector('[data-role="tool-duration"]');
        if (dur) {
          // 工具没执行（被拦截）时调用行没绑到实时耗时 → 用结果的 durationMs 补上
          if (callDur && !String(callDur.textContent || "").trim()) callDur.textContent = String(dur.textContent || "").replace(/^[\s·]+/, "");
          dur.textContent = "";
        }
        if (message.isError === true) {
          let fail = callRow.querySelector('[data-role="tool-fail"]');
          if (!fail) {
            fail = document.createElement("span");
            fail.className = "tool-fail";
            fail.dataset.role = "tool-fail";
            callRow.querySelector("summary")?.appendChild(fail);
          }
          fail.hidden = false;
          fail.textContent = "失败";
        }
      }
    }
    if (node && node.isConnected) {
      if (node.dataset?.bound === "1") {
        // PIX-3：绑定的是 assistant 富渲染里的 toolCall 行 —— 结果行追加在 article 之后，
        // 不能 replaceWith（会把 <article> 塞进另一个 <article>，DOM 结构坏掉）
        const host = node.closest(".entry") || node;
        host.after(rich);
      } else {
        node.replaceWith(rich);
      }
      c.liveView.delete(item.key);
      const idx = c.transcript.items.indexOf(item);
      if (idx >= 0) c.transcript.items.splice(idx, 1);
    } else {
      container.appendChild(rich);
    }
    autoScrollIfPinned();
    return true;
  }

  // ============================ 模型 / 思考级别（本列真相） ============================

  /** 记住并在「本列是活动列」时交给顶栏下拉显示；选项未就绪时由 main.js 重放 */
  function applySessionState(session) {
    if (!session) return;
    c.lastSessionState = session;
    // P0：引擎刚被重建、还没接管回原会话时，它的模型/思考级别是「新空会话的默认值」——
    // 不能拿它覆盖本列记住的值（事故里「模型退回默认」就是这么被当成真相显示的）。
    if (isForeignEngineSession(session)) {
      shell.columnUpdated(c);
      return;
    }
    if (session.model?.provider && session.model?.id) c.model = `${session.model.provider}/${session.model.id}`;
    if (session.thinkingLevel) c.thinkingLevel = session.thinkingLevel;
    shell.columnUpdated(c);
  }

  c.applySessionState = applySessionState;

  /** 引擎当下持有的会话 ≠ 本列会话（重连到空引擎 / 引擎被切到别的会话） */
  function isForeignEngineSession(session) {
    const engineId = session?.sessionId ?? null;
    if (!engineId || !c.sessionId || !c.sessionPath) return false;
    return String(engineId) !== String(c.sessionId);
  }

  /** 记住本列「该用的」模型/思考级别（引擎被回收后跟回用）：只认会话真相 / 用户主动选择 */
  function rememberWanted(state) {
    if (!state) return;
    if (state.model?.provider && state.model?.id) c.wantModel = `${state.model.provider}/${state.model.id}`;
    if (typeof state.thinkingLevel === "string" && state.thinkingLevel) c.wantThinking = state.thinkingLevel;
  }
  c.rememberWanted = rememberWanted;

  /** 引擎状态（SSE bridge_state / health 轮询共用） */
  c.paintStatus = (pi, from, to, session) => {
    if (pi) {
      c.state = pi.state;
      if (Array.isArray(pi.mcp)) c.mcp = [...pi.mcp];
      if (pi.state === "streaming" && c.streamStartedAt == null) c.streamStartedAt = Date.now();
      if (pi.state !== "streaming") c.streamStartedAt = null;
    } else if (from && to) {
      c.state = to;
      if (to === "streaming" && c.streamStartedAt == null) c.streamStartedAt = Date.now();
      if (to !== "streaming") c.streamStartedAt = null;
    }
    applyComposerState();
    applySessionState(session);
    shell.columnUpdated(c);
  };

  // ============================ SSE ============================

  function setConnection(ok, text) {
    el.reconnect.hidden = ok;
    if (!ok) el.reconnectText.textContent = text;
  }

  // 断线不退让（S4 / 设计 §5.4）：前三次 1s/2s/4s，之后固定 15s 一次一直重试；
  // 「回到可见页面」时（visibilitychange）还会立即 manualRetry 一次，手机 suspend 回来不用等退避。
  const RECONNECT_SLOW_MS = 15000;

  function scheduleReconnect() {
    const fast = [1000, 2000, 4000];
    const delay = c.retryAttempt < fast.length ? fast[c.retryAttempt] : RECONNECT_SLOW_MS;
    c.retryAttempt += 1;
    setConnection(
      false,
      c.retryAttempt <= fast.length
        ? `事件流断开：${delay / 1000}s 后第 ${c.retryAttempt} 次重连…`
        : `事件流断开：已重试 ${c.retryAttempt} 次，仍在后台重试（每 ${RECONNECT_SLOW_MS / 1000}s 一次，可用「重试」立即重连）…`,
    );
    clearTimeout(c.retryTimer);
    c.retryTimer = setTimeout(() => c.connect(), delay);
  }

  c.manualRetry = () => {
    if (c.released) return;
    c.retryAttempt = 0;
    c.restoreTriedFor = null; // 用户主动重试：允许再自动接管一次（否则重连成功后永远不重试）
    clearTimeout(c.retryTimer);
    setConnection(true, "");
    c.connect();
  };

  /**
   * S4（设计 §5.2）：桥在数据帧之前先发一帧 resume={from,to,truncated}。
   *  · truncated=true → 断线期间输出超缓冲上限，明确提示「部分输出未能补齐」，并在回合结束后强制一次权威重载；
   *  · 有回放窗口（to>=from）→ 这些帧只进 live 容器（合成节点），回合结束后同样重载成正式 entries；
   *  · 无回放（新页面/刚满落盘点）→ 什么都不做（entries 已经是权威的）。
   */
  function handleResume(frame) {
    const from = Number(frame.from);
    const to = Number(frame.to);
    const replayed = Number.isFinite(from) && Number.isFinite(to) && to >= from;
    if (frame.truncated === true) {
      c.lastResume = { ...frame };
      c.needsAuthoritativeReload = true;
      c.truncatedNotice = true;
      c.showNotice("断线期间部分输出未能补齐（超过缓冲上限）：本轮结束后会自动重新加载权威内容", true);
      return;
    }
    if (replayed) c.needsAuthoritativeReload = true;
  }

  // S4：手机/后台标签回来时（suspend 可能已把 SSE 悄悄掐断）—— 只要不在 OPEN 就立即重连一次，不等退避。
  // 列已从 DOM 移除（关列）时自行退出，不留下悬空监听。
  function onVisibilityChange() {
    if (!el.root.isConnected) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      return;
    }
    if (document.visibilityState !== "visible") return;
    if (c.released) return;
    const open = c.es && c.es.readyState === 1; // EventSource.OPEN
    if (open) return;
    if (!c.es && !c.sessionPath) return; // 还没真正接过会话：交给建列/打开会话的常规路径
    c.manualRetry();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  /** 重连后用 entry id 游标补齐；since 失效由桥返回 resync 触发全量重载 */
  async function backfill() {
    if (!c.lastEntryId || !c.sessionPath) return;
    try {
      const res = await c.fetch(`/api/session/entries?since=${encodeURIComponent(c.lastEntryId)}`);
      const data = await res.json();
      if (!res.ok) return;
      if (data.resync) {
        await c.openSession({ path: c.sessionPath, cwd: c.cwd });
        return;
      }
      const container = el.log.querySelector("[data-role=entries]");
      if (!container) return;
      const seen = new Set([...container.querySelectorAll("[data-entry-id]")].map((n) => n.dataset.entryId));
      let appended = 0;
      for (const entry of data.entries ?? []) {
        if (!entry?.id || seen.has(entry.id)) continue;
        noteToolMeta(c.sessionId || "live", entry);
        const node = renderEntry(entry, c.sessionId || "live");
        if (node) {
          container.appendChild(node);
          appended += 1;
        }
      }
      if (data.leafId) c.lastEntryId = data.leafId;
      if (appended) shell.toast(`补齐 ${appended} 条断线期间条目`);
    } catch (err) {
      console.warn("backfill failed", err);
    }
  }

  /**
   * S4（设计 §5.2/§5.4）：回合结束后做一次权威重载 —— 用 openSession 的 entries 重建对话区，
   * 把断线回放/truncated 期间用合成帧拼出来的 live 节点换成正式 entry 节点（不重复、顺带修正 fork 锚点）。
   * 失败不静默：保留 needsAuthoritativeReload，下次 settle / 队列事件再试。
   */
  async function authoritativeReload(reason = "settled") {
    if (c.reloading) {
      // 正在进行的那次重载结束后再补一次：回合结束的顺序必须回到权威
      c.reloadPending = true;
      return false;
    }
    if (!c.sessionPath) return false;
    c.reloading = true;
    c.needsAuthoritativeReload = false;
    const scrollBefore = el.log.scrollTop;
    const wasPinned = c.pinned;
    try {
      const data = await c.postJson("/api/session/open", { path: c.sessionPath });
      if (!data) return false;
      c.sessionId = data.sessionId ?? c.sessionId;
      c.bridgeSessionId = data.state?.sessionId ?? c.bridgeSessionId;
      c.lastEntryId = data.leafId ?? c.lastEntryId;
      renderSession(data); // entries 容器重建 + live 容器清空（回放帧的合成节点不再留存）
      if (data.attach === "attached") c.setAttachState("attached");
      // 重载成功后不再承诺「会自动重新加载」：缺口仍然存在，把话说成现在的真相
      if (c.truncatedNotice) {
        c.truncatedNotice = false;
        c.showNotice("已按会话文件重新加载（断线期间仍有输出未能补齐）");
      }
      el.sessionMeta.textContent = `${String(c.sessionId || "?").slice(0, 8)} · ${c.cwd} · ${data.entries?.length ?? 0} 条条目`;
      if (wasPinned) pinToBottom();
      else {
        el.log.scrollTop = scrollBefore;
        syncPinned();
      }
      c.refreshStats();
      return true;
    } catch (err) {
      c.needsAuthoritativeReload = true;
      console.warn(`authoritative reload failed (${reason})`, err);
      return false;
    } finally {
      c.reloading = false;
      if (c.reloadPending) {
        c.reloadPending = false;
        void authoritativeReload(`${reason}:pending`);
      }
    }
  }
  c.authoritativeReload = authoritativeReload;

  // ============================ 重连恢复（P0） ============================
  //
  // 事故（2026-11-14）：页面离开/断网 → 引擎被 idle-sweep 回收 → 回来重连，桥起了一个空会话；
  // 页面仍显示旧历史 → 看起来连续、实际 AI 失忆，模型也退回默认。
  // 桥侧已能按 lastSessionByClient 恢复（广播 session_attached{restored:true}），这里是**前端兜底**：
  // 不依赖桥的版本/时序，自己按本列记住的会话路径重新接管，并把模型/思考级别跟回。

  /** 本列是否需要「重新接管」：有会话路径，但引擎当前持有的会话不是它（或未知） */
  function needsRestore() {
    if (!c.sessionPath || c.released) return false;
    if (c.restoreInflight) return false; // 已经在内
    if (c.attachState === "viewing") return false; // 正在接管：由那次 openSession 负责
    if (!c.bridgeSessionId) return true; // 引擎身份未知：按本列会话恢复一次再判断
    if (!c.sessionId) return true;
    return String(c.bridgeSessionId) !== String(c.sessionId);
  }
  c.needsRestore = needsRestore;

  /**
   * 重连后的自动接管入口（同一次连接只做一次，失败给按钮重试）。
   * 判据必须是「引擎连接快照里的 sessionId」，不能用前端缓存：缓存是本列上次看到的身份，
   * 引擎被回收重建后缓存仍等于原 sessionId —— 拿它判会让事故原样复现。
   */
  function maybeAutoRestore(reason) {
    if (!needsRestore()) return false;
    if (c.restoreTriedFor === c.sessionPath) return false;
    // 引擎还没就绪（starting/not_started）或正在跑一轮（streaming）：等下一帧状态，不抢接管
    if (["starting", "not_started", "streaming"].includes(c.state)) return false;
    c.restoreTriedFor = c.sessionPath;
    c.restoreAttempts += 1;
    void restoreSession(reason);
    return true;
  }
  c.maybeAutoRestore = maybeAutoRestore;

  /** 列头状态：显示「已恢复上次会话」（持久一行，不只靠 toast/notice —— 恢复得发生过的证据） */
  function markRestored(text) {
    c.restoredMark = text || "";
    if (!el.sessionBar) return;
    let tag = el.sessionBar.querySelector("[data-role=restored]");
    if (!c.restoredMark) {
      tag?.remove();
      return;
    }
    if (!tag) {
      tag = document.createElement("span");
      tag.className = "restored";
      tag.dataset.role = "restored";
      el.sessionMeta?.after(tag);
    }
    tag.textContent = c.restoredMark;
    tag.title = "引擎被空闲回收后，已按上次的会话文件重新接管（模型/思考级别已跟回）";
  }
  c.markRestored = markRestored;

  /**
   * 重新接管本列会话 + 跟回模型/思考级别。同一时刻只跑一次（并发触发共用同一个 promise）。
   * 失败不静默：notice + 连接提示条（用户可点「重试」/「重试接管」再来一次）。
   * @returns {Promise<object|null>} openSession 的响应（成功）或 null（失败/无需）
   */
  async function restoreSession(reason = "reconnect") {
    if (!c.sessionPath || c.released) return null;
    if (c.restoreInflight) return c.restoreInflight;
    const path = c.sessionPath;
    const cwd = c.cwd;
    const task = (async () => {
      try {
        const data = await c.openSession({ path, cwd });
        if (!data) {
          c.showNotice("会话恢复失败：未能重新接管上次的会话（点上方「重试接管」或刷新页面）", true);
          setConnection(false, "会话未接管：点「重试」重新接管");
          return null;
        }
        // 接管回执还没到（读文件先返回）→ 等 session_attached 到达后再对齐模型/思考级别
        c.restorePrefsPending = data.attach !== "attached";
        if (data.attach === "attached") await applyWanted();
        c.showNotice("已恢复上次会话（引擎曾被回收，已重新接管）");
        markRestored("已恢复上次会话");
        shell.toast("已恢复上次会话");
        return data;
      } catch (err) {
        c.showNotice(`会话恢复失败：${err.message}（点上方「重试接管」或刷新页面）`, true);
        setConnection(false, "会话未接管：点「重试」重新接管");
        return null;
      }
    })();
    c.restoreInflight = task;
    try {
      return await task;
    } finally {
      if (c.restoreInflight === task) c.restoreInflight = null;
    }
  }
  c.restoreSession = restoreSession;

  /**
   * 把本列记住的模型/思考级别写回引擎（恢复会话 / 收到 session_attached 之后）。
   * 模型不可用（404/400）→ 顶栏显示「该模型不可用」并提示，**绝不静默退回默认**。
   */
  async function applyWanted() {
    if (c.applyingWanted) return;
    if (!c.wantModel && !c.wantThinking) return;
    c.applyingWanted = true;
    try {
      const state = c.lastSessionState ?? {};
      const engineModel = state.model?.provider && state.model?.id ? `${state.model.provider}/${state.model.id}` : null;
      if (c.wantModel && c.wantModel !== engineModel) {
        const [provider, ...rest] = String(c.wantModel).split("/");
        const modelId = rest.join("/");
        if (provider && modelId) {
          try {
            const data = await c.postJson("/api/model", { provider, modelId });
            applySessionState(data?.state);
            rememberWanted(data?.state);
          } catch (err) {
            const unavailable = err.status === 404 || err.status === 400;
            if (unavailable) shell.modelUnavailable?.(c, c.wantModel, err);
            c.showNotice(
              `${unavailable ? "该模型不可用" : "模型未跟回"}：${c.wantModel}${err.message ? `（${err.message}）` : ""}`,
              true,
            );
          }
        }
      }
      const engineThinking = c.lastSessionState?.thinkingLevel ?? c.thinkingLevel;
      if (c.wantThinking && c.wantThinking !== engineThinking) {
        try {
          const data = await c.postJson("/api/thinking", { level: c.wantThinking });
          applySessionState(data?.state);
          rememberWanted(data?.state);
        } catch (err) {
          c.showNotice(`思考级别未跟回：${c.wantThinking}（${err.message}）`, true);
        }
      }
    } finally {
      c.applyingWanted = false;
    }
  }
  c.applyWanted = applyWanted;

  /** 验收/排障用：本列的重连恢复状态（只读） */
  c.restoreDebug = () => ({
    sessionPath: c.sessionPath,
    sessionId: c.sessionId,
    bridgeSessionId: c.bridgeSessionId,
    wantModel: c.wantModel,
    wantThinking: c.wantThinking,
    attachState: c.attachState,
    restoreInflight: Boolean(c.restoreInflight),
    restoreTriedFor: c.restoreTriedFor,
    restoreAttempts: c.restoreAttempts,
    restoredMark: c.restoredMark ?? "",
    notice: el.notice?.textContent || "",
  });

  c.connect = () => {
    if (c.released) return null; // 已释放：不自动重连（否则会悄悄把引擎重新拉起来）
    // 重连/接管后不叠一条旧连接（旧 EventSource 连着旧引擎，接管后那条已不属于本列）
    try {
      c.es?.close();
    } catch {}
    // EventSource 不能自定义请求头 → 用 ?client= 告诉桥「我是哪一列」；?tab= 让桥能拒绝旧标签页；
    // ?since= 是「已收到的最后一个 seq」→ 桥只回放落盘点之后的尾巴（不重不漏）
    const since = Number.isFinite(c.lastSeq) ? `&since=${c.lastSeq}` : "";
    // P0：新连接 = 引擎身份未知（可能是被空闲回收后重建的新引擎，也可能换了会话）；
    // 以本次连接自带的 bridge_state 快照为准，旧缓存不能当真相（否则事故原样复现）。
    c.bridgeSessionId = null;
    const es = new EventSource(`/api/events?client=${encodeURIComponent(clientId)}&tab=${encodeURIComponent(shell.tabId ?? "")}${since}`);
    c.es = es;
    // 每条连接的处理器只认自己（es 闭包）：旧连接迟到的 onerror 不得关掉刚建的新连接
    es.onopen = () => {
      if (c.es !== es) return;
      c.retryAttempt = 0;
      setConnection(true, "");
      backfill();
      // P0：重连回来要先知道「引擎手里现在是哪条会话」——桥每次连接都会现发一帧 bridge_state 快照，
      // 等它到了再判（缓存里的 bridgeSessionId 是上一个引擎的身份，不能拿它判）。
      // 快照没来（旧桥/被掐）→ 1.5s 后按『身份不可信』兑底尝试一次。
      c.restoreCheckPending = true;
      clearTimeout(c.restoreCheckTimer);
      c.restoreCheckTimer = setTimeout(() => {
        if (!c.restoreCheckPending) return;
        c.restoreCheckPending = false;
        maybeAutoRestore("reconnect-snapshot-timeout");
      }, 1500);
    };
    es.onerror = () => {
      try {
        es.close();
      } catch {}
      if (c.es !== es) return; // 已经被更新的连接取代：不碰它，也不排退避
      scheduleReconnect();
    };
    // 帧处理抽成 applyFrame：SSE 用它，验收脚本也能用 __piShell.applyFrame 注入合成事件
    c.applyFrame = (frame) => {
      if (!frame || typeof frame !== "object") return;
      if (Number.isFinite(frame.seq)) c.lastSeq = frame.seq; // S4：重连游标（?since=）
      if (frame.type === "resume") {
        handleResume(frame);
        return;
      }
      if (frame.type === "bridge_state") {
        // S4：引擎当前真正持有的会话（发送前的身份校验用）
        if (frame.session && "sessionId" in frame.session) c.bridgeSessionId = frame.session.sessionId ?? null;
        c.paintStatus(frame.pi, frame.from, frame.to, frame.session);
        // P0：重连后以「本次连接的快照」判引擎手里的会话是不是本列的（防抖：latch 保证一次）。
        // 引擎还在 starting/not_started 时不抢（等状态帧；否则会撞上 PI_NOT_READY 白报错）。
        if (c.restoreCheckPending) {
          c.restoreCheckPending = false;
          clearTimeout(c.restoreCheckTimer);
          c.restoreCheckTimer = null;
        }
        maybeAutoRestore("bridge-state");
        // S4 兜底：重连时回合已经结束（settle 帧可能被缓冲截断），此时也要把合成节点换成权威 entries
        if (c.needsAuthoritativeReload) {
          const st = frame.pi?.state ?? frame.to ?? null;
          if (st && st !== "streaming") void authoritativeReload("reconnect-idle");
        }
        return;
      }
      if (frame.type === "session_attached") {
        // 接管回执只认本列当前会话（别的会话的回执不能改这一列的状态）
        if (c.sessionPath && frame.sessionFile && !samePath(frame.sessionFile, c.sessionPath)) return;
        if (c.sessionPath) {
          c.sessionId = frame.sessionId ?? c.sessionId;
          // 接管回执就是这个引擎此刻的身份（重连到新引擎时它跟缓存不同，必须以回执为准）
          if (frame.sessionId) c.bridgeSessionId = frame.sessionId;
          c.lastEntryId = frame.leafId ?? c.lastEntryId;
          c.restoreTriedFor = c.sessionPath; // 已经接管过：本次连接不再自动重试
          c.setAttachState("attached");
          c.refreshStats();
          shell.refreshChanges();
          // B1/T6：接管回执到达 → 顶栏模型/思考/目录/MCP 以会话视图为准
          shell.syncHeaderFromSession?.(c, { delay: 0, force: true });
          // P0：接管/恢复成功 → 把本列记住的模型与思考级别跟回（桥侧也会尽量带回，这里是兜底）
          if (frame.restored === true || c.restorePrefsPending) {
            c.restorePrefsPending = false;
            void applyWanted();
          }
          // 桥侧先恢复完（我们没有抢到）也要在列头留下一行「已恢复过」的状态
          if (frame.restored === true) markRestored("已恢复上次会话");
          shell.toast(frame.restored ? "已恢复上次会话，可以继续发送" : `接管完成（${frame.ms}ms），现在可以发送`);
          shell.list.load();
        }
        return;
      }
      if (frame.type === "session_attach_failed") {
        if (c.sessionPath && frame.sessionFile && !samePath(frame.sessionFile, c.sessionPath)) return;
        c.setAttachState("failed", `接管失败（${frame.code}）：${frame.reason || ""} — 仍可只读浏览`);
        c.showNotice(`接管失败：${frame.code} ${frame.reason || ""}（内容仍可浏览，点上方「重试接管」）`, true);
        return;
      }
      if (frame.type === "turn_changes") {
        // PIX-4：桥广播的当前轮号（写文件的一轮结束时会再推一次 update）
        if (Number.isInteger(frame.turn)) c.lastTurn = frame.turn;
        if (frame.phase !== "start") shell.refreshChanges?.();
        return;
      }
      if (frame.type === "resync") {
        if (c.sessionPath) c.openSession({ path: c.sessionPath, cwd: c.cwd });
        return;
      }
      if (frame.type === "extension_ui_request") {
        c.handleExtRequest(frame);
        return;
      }
      if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") {
        c.deltaCount += 1;
        if (c.firstDeltaAt == null) c.firstDeltaAt = performance.now();
      }
      if (frame.type === "message_end") {
        if (richifyMessage(frame.message)) {
          c.transcript.apply(frame); // 保持内部状态一致（用户/工具条目不重复插入由 stream.js 处理）
          return;
        }
      }
      const { changed } = c.transcript.apply(frame);
      paintLive(c.transcript.items, changed);
      if (frame.type === "agent_settled") {
        c.refreshStats();
        shell.refreshChanges();
        c.deltaCount = 0;
        c.firstDeltaAt = null;
        // 一轮结束后会话才落盘/有标题：刷新列表并把真实标题带回列头（拿不到就保持原样）
        void shell.list.load().then(() => c.refreshTitle());
        // 回合结束一律回到权威顺序（落盘顺序 = thinking → text）：把本轮 live 合成节点
        // 换成正式 entries。S4 的回放/truncated 走同一个入口，不另开分支。
        void authoritativeReload(c.needsAuthoritativeReload ? "agent_settled" : "agent_settled-order");
      }
    };
    c.es.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (c.es !== es) return;
      c.applyFrame(frame);
    };
    return es;
  };

  c.scheduleReconnect = scheduleReconnect;

  c.disconnect = () => {
    clearTimeout(c.retryTimer);
    clearTimeout(c.restoreCheckTimer);
    c.restoreCheckTimer = null;
    c.restoreCheckPending = false;
    // P0：没连接就不再担保「引擎手里是哪条会话」——下一个连接的快照到达前一律视为未知
    c.bridgeSessionId = null;
    stopDurationTicker();
    try {
      c.es?.close();
    } catch {}
    c.es = null;
  };

  /** N1-b：资源面板「释放」后的本列状态（disconnect 阻止自动重建；重新打开会话可恢复） */
  c.markReleased = (text = "已释放（重新打开会话可恢复）") => {
    c.released = true;
    c.disconnect();
    c.state = "released";
    c.streamStartedAt = null;
    c.setAttachState("idle");
    c.showNotice(text);
    applyComposerState();
    shell.columnUpdated(c);
  };

  /** N1-a：标签页换号后，本列引擎标识跟着换（请求/SSE 都读闭包里的 clientId） */
  c.setClientId = (next) => {
    if (!next || next === clientId) return;
    clientId = next;
    c.clientId = next;
    el.root.dataset.client = next;
  };

  // ============================ 扩展 UI ============================

  c.handleExtRequest = (req) => {
    const method = req?.method;
    if (method === "notify") {
      shell.toast(req.message || "", req.notifyType || "info");
      return;
    }
    if (method === "setStatus") {
      const text = String(req.statusText || "").replace(/\u001b\[[0-9;]*m/g, "");
      c.extStatus = text;
      shell.columnUpdated(c);
      return;
    }
    if (method === "setWidget") {
      const lines = Array.isArray(req.widgetLines) ? req.widgetLines : Array.isArray(req.lines) ? req.lines : [];
      c.widgetLines = lines;
      el.widget.textContent = lines.join("\n");
      el.widget.hidden = lines.length === 0;
      return;
    }
    if (["select", "confirm", "input", "editor"].includes(method)) {
      shell.showExtDialog(req, c);
    }
  };

  // ============================ 附件 ============================

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve({ data: comma >= 0 ? result.slice(comma + 1) : result, mimeType: file.type || "application/octet-stream" });
      };
      reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
      reader.readAsDataURL(file);
    });
  }

  async function readTextFile(file) {
    const MAX = 200 * 1024;
    if (file.size > MAX) throw new Error(`文件超过 200KB（${file.size} 字节）：${file.name}`);
    const text = await file.text();
    if (text.includes("\u0000")) throw new Error(`二进制文件不支持注入：${file.name}`);
    return { path: file.webkitRelativePath || file.name, text, size: file.size };
  }

  function paintAttachments() {
    el.attachBar.replaceChildren();
    el.attachBar.hidden = c.attachments.length === 0;
    c.attachments.forEach((att, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.dataset.role = "attachment";
      chip.dataset.kind = att.kind;
      chip.textContent =
        att.kind === "image" ? `图片 ${Math.round((att.data.length * 3) / 4 / 1024)}KB` : `${att.path} · ${Math.round(att.size / 1024)}KB`;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.addEventListener("click", () => {
        c.attachments.splice(i, 1);
        paintAttachments();
      });
      chip.appendChild(x);
      el.attachBar.appendChild(chip);
    });
  }

  el.imageInput.addEventListener("change", async () => {
    for (const file of el.imageInput.files ?? []) {
      if (!file.type.startsWith("image/")) {
        c.showNotice(`不是图片文件：${file.name}`, true);
        continue;
      }
      try {
        const { data, mimeType } = await fileToBase64(file);
        c.attachments.push({ kind: "image", data, mimeType });
      } catch (err) {
        c.showNotice(err.message, true);
      }
    }
    el.imageInput.value = "";
    paintAttachments();
  });

  el.fileInput.addEventListener("change", async () => {
    for (const file of el.fileInput.files ?? []) {
      try {
        const { path, text, size } = await readTextFile(file);
        c.attachments.push({ kind: "file", path, text, size });
      } catch (err) {
        c.showNotice(err.message, true);
      }
    }
    el.fileInput.value = "";
    paintAttachments();
  });

  /** 命令面板的 Ctrl+U 注入文件也落到「当前列」 */
  c.openFilePicker = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "text/*,.md,.json,.jsonl,.txt,.js,.mjs,.ts,.py,.css,.html,.yml,.yaml";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const { path, text, size } = await readTextFile(file);
        c.attachments.push({ kind: "file", path, text, size });
        paintAttachments();
      } catch (err) {
        c.showNotice(err.message, true);
      }
    });
    input.click();
  };

  function composeMessage(text) {
    let message = text;
    for (const att of c.attachments) {
      if (att.kind === "file") message += `\n\n[File: ${att.path}]\n${att.text}`;
    }
    return message;
  }

  // ============================ 发送 / 中止 ============================

  /**
   * S4（设计 §5.4）：发送前对齐会话身份。
   * 引擎被回收后重建 = 空会话（bridge_state.session.sessionId 与本列记住的不一致），
   * 此时直接发生 prompt 会落进空会话。attached 且不一致 → 先 openSession，再允许发送。
   * @returns {Promise<boolean>} true = 可以发（身份一致或已对齐）
   */
  async function ensureSessionIdentity() {
    if (c.attachState !== "attached") return true; // 接管中/只读：由 attachState 自己拦发送
    let bridgeId = c.bridgeSessionId;
    // P0：身份未知不能凭「大概没事」放行 —— 有会话路径就先按它恢复一次，恢复不了就拦住发送。
    if (!bridgeId && c.sessionPath) {
      const data = await restoreSession("identity");
      bridgeId = c.bridgeSessionId;
      if (!data || !bridgeId || c.attachState !== "attached") {
        c.showNotice("未能确认当前会话，请刷新或重试接管（避免把消息发进空会话）", true);
        setConnection(false, "未能确认当前会话：点「重试」重新接管");
        return false;
      }
    }
    if (!bridgeId || !c.sessionId) return true; // 真·新会话（未落盘）：不凭猜疑拦用户
    if (String(bridgeId) === String(c.sessionId)) return true;
    if (!c.sessionPath) {
      c.showNotice("引擎已在另一个会话上：先重新打开这条会话再发送", true);
      return false;
    }
    const data = await c.openSession({ path: c.sessionPath, cwd: c.cwd });
    if (!data) {
      c.showNotice("引擎已在另一个会话上，重新打开本会话失败：暂不发送（避免发进空会话）", true);
      return false;
    }
    return true;
  }
  c.ensureSessionIdentity = ensureSessionIdentity;

  c.submitPrompt = async (streamingBehavior) => {
    const text = el.input.value.trim();
    const images = c.attachments.filter((a) => a.kind === "image").map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
    if (!text && images.length === 0) return;
    // 先验身份再清输入框：失败时用户还能接着改/重试，不用重打
    if (!(await ensureSessionIdentity())) return;
    const message = composeMessage(text);
    el.input.value = "";
    c.attachments.length = 0;
    paintAttachments();
    c.transcript.addUser(message);
    paintLive(c.transcript.items, null, true); // 用户自己发消息 → 强制滚到底部
    c.showNotice("");
    try {
      const body = { message };
      if (images.length) body.images = images;
      if (streamingBehavior) body.streamingBehavior = streamingBehavior;
      const data = await c.postJson("/api/prompt", body);
      console.info(`[pi-shell] disposition = ${data?.disposition}`);
    } catch (err) {
      if (err.status === 504) {
        // 扩展命令（如弹对话框的 /select-demo）会让 pi 的 prompt 回执延后 → 504 属预期
        const waitingDialog = shell.modalOpen();
        c.showNotice(
          waitingDialog
            ? "扩展命令正在等待你的输入（回执超时属预期，对话框仍在）"
            : "命令回执超时（504）：pi 可能仍在处理，请不要重复发送；等待事件流更新。",
          true,
        );
        return;
      }
      if (err.status === 503) {
        c.showNotice("pi 未就绪（503）：正在重启或已停止。", true);
        return;
      }
      c.showNotice(err.message, true);
    }
  };

  c.abort = async () => {
    try {
      const cleared = await c.postJson("/api/clear-queue");
      const restored = [...(cleared?.steering ?? []), ...(cleared?.followUp ?? [])].join("\n");
      if (restored) {
        el.input.value = [el.input.value, restored].filter(Boolean).join("\n");
        shell.toast("已清空队列并把内容放回输入框");
      }
    } catch (err) {
      console.warn("clear_queue failed", err);
    }
    try {
      await c.postJson("/api/abort");
      c.showNotice("已中止（pi 会执行完队列里剩余的已排队消息）");
    } catch (err) {
      c.showNotice(`中止失败：${err.message}`, true);
    }
  };

  el.form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    c.submitPrompt(el.behavior.hidden ? undefined : el.behavior.value);
  });

  // 键盘语义 = 终端习惯：Enter 换行；Ctrl(⌘)+Enter 发送；只作用于本列输入框
  el.input.addEventListener("keydown", (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key !== "Enter") return;
    if (!(ev.ctrlKey || ev.metaKey)) return;
    if (el.send.disabled) return;
    ev.preventDefault();
    c.submitPrompt(el.behavior.hidden ? undefined : el.behavior.value);
  });

  el.abort.addEventListener("click", () => c.abort());

  el.attachRetry.addEventListener("click", () => {
    // P0：接管失败/引擎被回收 → 「重试接管」走同一条恢复路径（会话 + 模型/思考级别）
    if (needsRestore()) {
      c.restoreTriedFor = null;
      void restoreSession("retry-attach");
      return;
    }
    if (c.attachSessionRef) c.openSession(c.attachSessionRef);
  });
  el.reconnectBtn.addEventListener("click", () => c.manualRetry());

  // 点/聚焦/输入都算「切到这一列」（顶栏、侧栏、面板跟着走）
  for (const type of ["pointerdown", "focusin", "input"]) {
    root.addEventListener(type, () => shell.setActive(c), { passive: true });
  }

  // ============================ 新建会话 ============================

  /**
   * 新建会话（A1）：先选项目目录 → 在所选目录建新会话（只影响本列）。
   * streaming 中拒绝（桥 409）：切会话会 abort 当前回合，不能静默清空对话区。
   * 返回值：true = 已新建；false = 取消/失败（对话区原样保留）。
   */
  c.newSession = async () => {
    if (c.state !== "idle") {
      c.showNotice("正在运行中：请先中止再新建会话", true);
      return false;
    }
    // 弹层归外壳（main.js）：列表/最近目录/错误显示都在那里；POST 仍回到本列
    return shell.pickCwd ? shell.pickCwd(c) : c.createSession(c.cwd || null);
  };

  /**
   * 真正建会话（不含选目录）：POST /api/session/new {cwd}。
   * - cwd 与当前相同/为空时桥不重启进程；不同时只重启本列引擎（1–3s，MCP 名单按新 cwd 重算）。
   * - 失败一律 throw（400 目录不存在 / 409 streaming），由弹层就地显示并保持打开。
   * 不落盘：发第一条消息才产生 .jsonl。
   */
  c.createSession = async (cwd) => {
    // B1/T6：切目录期间旧 cwd 还没被桥替换，SSE 帧先到的 refreshChanges 只能跳过（否则 403）
    c.cwdPending = true;
    try {
      const data = await c.postJson("/api/session/new", cwd ? { cwd } : {});
      c.sessionId = null; // 新会话未落盘，尚未有稳定 id
      c.sessionPath = null;
      c.title = "新会话";
      // A1：响应顶层 cwd 是引擎切目录后的真相（state.cwd 兼容旧桥）
      c.cwd = data?.cwd || data?.state?.cwd || c.cwd;
      c.lastEntryId = null;
      resetLive();
      el.log.replaceChildren();
      const welcome = document.createElement("div");
      welcome.className = "welcome";
      welcome.dataset.role = "welcome-new";
      const p1 = document.createElement("p");
      p1.textContent = "从左侧选择一个会话，或直接在下方输入消息开始新会话。";
      const p2 = document.createElement("p");
      p2.className = "muted";
      p2.textContent = "空会话不落盘：发出第一条消息后才会出现在左侧列表（H-5）。";
      welcome.append(p1, p2);
      el.log.appendChild(welcome);
      // 列头/会话 meta 立即显示新项目（顶栏 #ws-path 由 session/view 同步）
      el.sessionMeta.textContent = c.cwd ? `新会话 · ${c.cwd}` : "新会话";
      el.sessionBar.hidden = false;
      el.stats.hidden = true;
      shell.list.setCurrent(null);
      c.setAttachState("attached"); // 桥已切到全新空会话：可以发送
      applySessionState(data?.state); // 新会话也有模型真相 → 列头/顶栏不空着
      rememberWanted(data?.state); // 新会话的模型就是本列此刻的意图（下次回收按它跟回）
      c.restoreTriedFor = null;
      c.showNotice("已新建会话：发出第一条消息后才会出现在左侧列表");
      markRestored(""); // 新会话：上一条会话的「已恢复」标记清掉
      shell.onCwd(c);
      // 顺序很关键：先更新 c.cwd（上面），再查 diff —— 否则会按旧目录发 /api/git/diff → 403
      shell.refreshChanges();
      shell.syncHeaderFromSession?.(c, { delay: 0, force: true });
      shell.columnUpdated(c);
      return data;
    } finally {
      c.cwdPending = false;
    }
  };

  /** 「回到新会话」：有内容时先确认（避免误触清空对话区） */
  c.brandHome = async () => {
    if (c.state !== "idle") {
      c.showNotice("正在运行中：请先中止再新建会话", true);
      return;
    }
    const hasConversation = !!c.sessionId || el.log.querySelector(".entry, .entry-user, .msg") !== null;
    if (hasConversation) {
      const ok = await shell.confirm("回到新会话会清空当前对话区（会话本身仍保留在左侧列表，可随时点回来）。", {
        title: "回到新会话？",
        confirmText: "新会话",
        cancelText: "取消",
      });
      if (!ok) return;
    }
    await c.newSession();
  };

  // ============================ 成本 / 上下文 ============================

  c.refreshStats = async () => {
    try {
      const res = await c.fetch("/api/stats", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(`${data?.error?.code || res.status}`);
      const tokens = data.tokens ?? {};
      const ctx = data.contextUsage ?? null;
      const ctxText = ctx
        ? ctx.tokens == null
          ? `ctx ${ctx.contextWindow ? `?/${Math.round(ctx.contextWindow / 1000)}k` : "?"}`
          : `ctx ${Math.round(ctx.tokens / 1000)}k${ctx.contextWindow ? `/${Math.round(ctx.contextWindow / 1000)}k` : ""}${ctx.percent != null ? ` (${ctx.percent}%)` : ""}`
        : "ctx ?";
      el.stats.textContent = `${Number(tokens.total ?? 0).toLocaleString()} tok · ${fmtCost(data.cost)} · ${ctxText}`;
      el.stats.dataset.tokens = String(tokens.total ?? 0);
      el.stats.dataset.cost = String(data.cost ?? 0);
      el.stats.dataset.contextTokens = ctx?.tokens == null ? "null" : String(ctx.tokens);
      el.stats.hidden = false;
      el.stats.title = `in ${tokens.input ?? 0} / out ${tokens.output ?? 0} / cacheRead ${tokens.cacheRead ?? 0} / cacheWrite ${tokens.cacheWrite ?? 0}`;
    } catch {
      el.stats.hidden = true;
    }
  };

  // ============================ 列头 / 生命周期 ============================

  /** 列头：序号（稳定身份）+ 标题 + 模型 + 关闭 */
  /** 列头标题：会话落盘后从左侧列表取真实标题（拿不到就保留当前标题） */
  c.refreshTitle = () => {
    const title = shell.titleFor(c.sessionId);
    if (title && title !== c.title) {
      c.title = title;
      shell.columnUpdated(c);
    }
  };

  c.paintHead = (index) => {
    if (el.no) el.no.textContent = String(index + 1).padStart(2, "0");
    if (el.title) {
      el.title.textContent = c.title;
      el.title.title = `${c.title}${c.sessionId ? ` · ${String(c.sessionId).slice(0, 8)}` : ""}`;
    }
    if (el.mcp) {
      const list = c.mcp ?? [];
      el.mcp.hidden = list.length === 0;
      el.mcp.textContent = list.length ? `MCP·${list.length}` : "";
      el.mcp.title = list.length ? `本列已启用：${list.join(" · ")}` : "";
    }
    if (el.model) {
      const short = c.model ? String(c.model).split("/").pop() : "—";
      el.model.textContent = short;
      el.model.title = c.model || "";
    }
    el.root.dataset.state = c.state;
    el.root.dataset.client = c.clientId;
  };

  c.refreshHeadStreaming = () => {
    el.root.dataset.streaming = c.state === "streaming" ? "true" : "false";
  };

  c.focus = () => {
    el.input.focus();
  };

  c.paintAttachments = paintAttachments;
  applyComposerState();
  paintAttachments();
  c.paintHead(0);

  return c;
}

function samePath(a, b) {
  const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

function fmtCost(n) {
  const v = Number(n ?? 0);
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}
