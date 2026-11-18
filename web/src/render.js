// pi-shell · T-08：条目 → DOM（03 §14.1 的 ⑧⑨⑩⑫）
// B8：加「轮次元数据」（谁 · 耗时）+ 工具行耗时位；折叠/富渲染结构不变（E2E 依赖 class 名）。
// 规则：
// - thinking 默认折叠（<details data-collapse="thinking" open=false>），标题一行
// - 工具调用默认折叠为一行（工具名 + 命令 + 耗时位）；展开见**原始 JSON**
// - 图片用 data: URL 渲染（只来自会话内容，无远程资源）
// - 折叠状态按 `${sessionId}|${entryId}|${blockIndex}|${kind}` 记忆，跨会话切换保持（⑫）
// 硬约束：全部 textContent / DOM API，无 innerHTML。

import { renderMarkdown } from "./markdown.js";

const collapseState = new Map(); // key → boolean（true=展开）

const collapseKey = (sessionId, entryId, index, kind) => `${sessionId}|${entryId}|${index}|${kind}`;

// ---------- PIX-3：工具耗时（真实 durationMs 优先，历史缺失时用条目时间戳近似） ----------
// toolResult 消息在 1.5.0 里带 durationMs（真实 execute() 耗时）；老会话没有这个字段，
// 就用「toolResult 条目时间戳 − 对应 toolCall 所在 assistant 条目时间戳」近似。
// 误差：并行工具调用会把队列等待算进去，长工具调用误差可达秒级；超过 30 分钟视为不连续 → 不显示。
const MAX_TOOL_MS = 30 * 60 * 1000;
const toolMeta = new Map(); // `${sessionId}|${toolCallId}` → {durationMs|null, approx, isError, hasResult}

const metaKey = (sessionId, toolCallId) => `${sessionId}|${toolCallId}`;

function entryTime(entry) {
  const raw = entry?.message?.timestamp ?? entry?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const parsed = Date.parse(String(raw ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** 给整份会话做一次预扫描（打开会话时调用：assistant 在前、toolResult 在后） */
export function seedToolMeta(sessionId, entries) {
  const calls = new Map();
  const results = new Map();
  for (const entry of entries ?? []) {
    const msg = entry?.message;
    if (!msg) continue;
    const ts = entryTime(entry);
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "toolCall" && block.id && !calls.has(block.id)) calls.set(block.id, ts);
      }
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      results.set(msg.toolCallId, { ts, isError: msg.isError === true, durationMs: typeof msg.durationMs === "number" ? msg.durationMs : null });
    }
  }
  for (const [id, callTs] of calls) {
    const r = results.get(id);
    let durationMs = r?.durationMs ?? null;
    let approx = r?.durationMs == null;
    if (durationMs == null && r && callTs != null && r.ts != null && r.ts > callTs) {
      const delta = r.ts - callTs;
      durationMs = delta <= MAX_TOOL_MS ? delta : null;
    }
    toolMeta.set(metaKey(sessionId, id), { durationMs, approx, isError: r?.isError === true, hasResult: Boolean(r), paired: Boolean(r) });
  }
  for (const [id, r] of results) {
    if (calls.has(id)) continue; // 孤立结果（没有对应 toolCall）：只记错误态
    toolMeta.set(metaKey(sessionId, id), { durationMs: r.durationMs, approx: r.durationMs == null, isError: r.isError, hasResult: true, paired: false });
  }
  return toolMeta;
}

/** 增量：渲染某条 entry 前调用（backfill / 实时） */
export function noteToolMeta(sessionId, entry) {
  const msg = entry?.message;
  if (!msg) return;
  if (msg.role === "toolResult" && msg.toolCallId) {
    const key = metaKey(sessionId, msg.toolCallId);
    const prev = toolMeta.get(key);
    toolMeta.set(key, {
      durationMs: typeof msg.durationMs === "number" ? msg.durationMs : (prev?.durationMs ?? null),
      approx: typeof msg.durationMs !== "number" && prev?.approx !== false,
      isError: msg.isError === true,
      hasResult: true,
    });
  }
}

export function getToolMeta(sessionId, toolCallId) {
  return toolCallId ? toolMeta.get(metaKey(sessionId, toolCallId)) ?? null : null;
}

/** 本轮耗时（等宽小号）：<1s → 320ms，<60s → 1.2s，≥60s → 1m 04s */
export function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const total = Math.round(n / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * 历史条目的「本轮耗时」只能从条目时间戳推算（条目里没有 duration 字段）。
 * 规则：assistant 条目 − 上一条 user 条目，且 ≤30 分钟（超过就当成「跨天/不连续」，宁可不显示）。
 */
const turnStart = new Map(); // sessionId → 该轮 user 条目时间戳
const MAX_TURN_MS = 30 * 60 * 1000;

function noteTimestamp(sessionId, role, rawTs) {
  const ts = typeof rawTs === "number" ? rawTs : Date.parse(String(rawTs ?? ""));
  if (!Number.isFinite(ts)) return "";
  if (role === "user") {
    turnStart.set(sessionId, ts);
    return "";
  }
  if (role !== "assistant") return "";
  const start = turnStart.get(sessionId);
  turnStart.delete(sessionId);
  if (!start || ts < start) return "";
  const delta = ts - start;
  return delta > 0 && delta <= MAX_TURN_MS ? fmtDuration(delta) : "";
}

function btnSummary(label, meta, duration, { failed = false, durationTitle = "" } = {}) {
  const wrap = document.createElement("summary");
  wrap.className = "collapse-summary";
  const name = document.createElement("span");
  name.className = "collapse-label";
  name.textContent = label;
  wrap.appendChild(name);
  if (meta) {
    const m = document.createElement("span");
    m.className = "collapse-meta";
    m.textContent = meta;
    wrap.appendChild(m);
  }
  // 耗时位：有则显示（等宽右对齐），没有就不占位
  const d = document.createElement("span");
  d.className = "dur";
  d.dataset.role = "tool-duration";
  d.textContent = duration || "";
  if (durationTitle) d.title = durationTitle;
  wrap.appendChild(d);
  // PIX-3：失败标记只占耗时位旁边，不整行染色
  if (failed) {
    const f = document.createElement("span");
    f.className = "tool-fail";
    f.dataset.role = "tool-fail";
    f.textContent = "失败";
    wrap.appendChild(f);
    wrap.dataset.failed = "1";
  }
  return wrap;
}

function rawJsonBlock(value) {
  const pre = document.createElement("pre");
  pre.className = "raw-json";
  pre.dataset.role = "raw-json";
  pre.textContent = JSON.stringify(value, null, 2);
  return pre;
}

/** 折叠容器：details + 持久化状态 + 可断言标记 */
function collapsible({ kind, key, label, meta, duration, durationTitle = "", failed = false, attrs = null, defaultOpen = false, body }) {
  const details = document.createElement("details");
  details.className = `collapse collapse-${kind}`;
  details.dataset.collapse = kind;
  details.dataset.collapseKey = key;
  for (const [name, value] of Object.entries(attrs || {})) details.setAttribute(name, value);
  const open = collapseState.has(key) ? collapseState.get(key) : defaultOpen;
  details.open = open;
  details.dataset.state = open ? "open" : "closed";
  details.addEventListener("toggle", () => {
    collapseState.set(key, details.open);
    details.dataset.state = details.open ? "open" : "closed";
  });
  details.appendChild(btnSummary(label, meta, duration, { failed, durationTitle }));
  const content = document.createElement("div");
  content.className = "collapse-body";
  content.appendChild(body);
  details.appendChild(content);
  return details;
}

function imageNode(block) {
  const img = document.createElement("img");
  img.className = "msg-image";
  img.dataset.role = "image";
  img.src = `data:${block.mimeType};base64,${block.data}`;
  img.alt = "会话图片";
  return img;
}

function textBlock(block) {
  const wrap = document.createElement("div");
  wrap.className = "text-block";
  wrap.dataset.role = "text-block";
  wrap.appendChild(renderMarkdown(block.text ?? ""));
  return wrap;
}

function thinkingBlock(block, ctx) {
  const body = document.createElement("div");
  body.textContent = block.thinking ?? "";
  return collapsible({
    kind: "thinking",
    key: collapseKey(ctx.sessionId, ctx.entryId, ctx.index, "thinking"),
    label: "思考",
    meta: block.redacted ? "已加密" : "",
    body,
  });
}

/** 工具行的「命令/参数」摘要：优先常见字段，其次 key=value（单行省略交给 CSS） */
function toolCommand(args) {
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

function toolCallBlock(block, ctx) {
  const args = block.arguments ?? {};
  const body = rawJsonBlock(block); // 展开见原始 JSON
  const meta = getToolMeta(ctx.sessionId, block.id);
  const dur =
    block.durationMs != null
      ? fmtDuration(block.durationMs)
      : meta?.durationMs != null
        ? fmtDuration(meta.durationMs)
        : meta
          ? "—" // 有配对记录但无法可靠近似（或工具未执行）→ 按口径显示「—」
          : "";
  return collapsible({
    kind: "tool",
    key: collapseKey(ctx.sessionId, ctx.entryId, ctx.index, "tool"),
    label: block.name ?? "tool",
    meta: toolCommand(args),
    duration: dur,
    durationTitle: meta?.approx ? "按条目时间戳近似（历史会话没有 durationMs）" : "",
    failed: Boolean(meta?.isError),
    // PIX-3：工具行绑定 id（实时跳秒会就地更新这一行的耗时位，而不是再插一行）
    attrs: {
      "data-tool-id": block.id ?? "",
      "data-pix-tool": "1",
      "data-tool-name": block.name ?? "tool",
    },
    body,
  });
}

function toolResultEntry(entry, ctx) {
  const msg = entry.message ?? {};
  const texts = (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text);
  const images = (msg.content ?? []).filter((b) => b.type === "image");
  const wrap = document.createElement("div");
  wrap.className = "tool-result";
  // 图片是内容本身（样本 B 的图片都在 toolResult 里），直接可见；文本与原始 JSON 才折叠
  for (const img of images) wrap.appendChild(imageNode(img));
  const body = document.createElement("div");
  if (texts.length) {
    const pre = document.createElement("pre");
    pre.className = "tool-output";
    pre.dataset.role = "tool-output";
    pre.textContent = texts.join("\n");
    body.appendChild(pre);
  }
  body.appendChild(rawJsonBlock(msg));
  noteToolMeta(ctx.sessionId, entry);
  const meta = getToolMeta(ctx.sessionId, msg.toolCallId);
  let duration = msg.durationMs != null ? fmtDuration(msg.durationMs) : meta?.durationMs != null ? fmtDuration(meta.durationMs) : "";
  let durationTitle = meta?.approx ? "按条目时间戳近似（历史会话没有 durationMs）" : "";
  // 与之配对的 toolCall 行已经显示耗时 → 结果行不再重复（一行工具只有一个耗时位）
  if (meta?.paired === true) {
    duration = "";
    durationTitle = "耗时显示在对应的工具调用行";
  } else if (!duration) {
    // 无法可靠近似：按口径显示「—」，不编数字
    duration = "—";
    durationTitle = "无法从会话条目可靠推算耗时";
  }
  wrap.appendChild(
    collapsible({
      kind: "toolResult",
      key: collapseKey(ctx.sessionId, ctx.entryId, ctx.index, "toolResult"),
      label: `结果 · ${msg.toolName ?? "tool"}`,
      meta: images.length ? `${images.length} 张图` : "",
      duration,
      durationTitle,
      failed: msg.isError === true,
      attrs: { "data-tool-result-id": msg.toolCallId ?? "", "data-pix-tool-result": "1" },
      body,
    }),
  );
  return wrap;
}

function messageHasText(msg) {
  const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
  return content.some((block) => block?.type === "text" && String(block.text ?? "").trim().length > 0);
}

const ROLE_LABEL = { user: "我", assistant: "pi", system: "system" };

/** 渲染一条 entry；返回 DOM 节点（未知类型 / 正文为空的 system 返回 null） */
export function renderEntry(entry, sessionId) {
  if (entry?.type !== "message" || !entry.message) return null;
  const msg = entry.message;
  // 每轮附带的空 system 条目没有正文，渲染出来只是一条空块（回归：每轮多一个空 system）
  if (msg.role === "system" && !messageHasText(msg)) return null;
  const ctx = { sessionId, entryId: entry.id };
  const duration = noteTimestamp(sessionId, msg.role, entry.timestamp);

  const root = document.createElement("article");
  root.className = `entry entry-${msg.role}`;
  root.dataset.entryId = entry.id;
  root.dataset.role = msg.role;

  if (msg.role === "toolResult") {
    root.appendChild(toolResultEntry(entry, ctx));
    return root;
  }

  // 元数据行：谁 ·（耗时）。耗时只能从时间戳推算 → title 写明来源，避免被当成真实 duration。
  const head = document.createElement("div");
  head.className = "entry-head";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = ROLE_LABEL[msg.role] || msg.role;
  head.appendChild(who);
  if (duration) {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "·";
    const dur = document.createElement("span");
    dur.className = "turn-dur";
    dur.dataset.role = "turn-duration";
    dur.textContent = duration;
    dur.title = "本轮耗时（按条目时间戳推算）";
    head.append(sep, dur);
  }
  root.appendChild(head);

  const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
  content.forEach((block, index) => {
    const c = { ...ctx, index };
    if (block?.type === "text") root.appendChild(textBlock(block));
    else if (block?.type === "thinking") root.appendChild(thinkingBlock(block, c));
    else if (block?.type === "toolCall") root.appendChild(toolCallBlock(block, c));
    else if (block?.type === "image") root.appendChild(imageNode(block));
  });

  if (msg.role === "system") {
    root.appendChild(
      collapsible({ kind: "system", key: collapseKey(sessionId, entry.id, 0, "system"), label: "system 原文", body: rawJsonBlock(msg) }),
    );
  }
  return root;
}

/** 渲染整个会话（清空容器后逐条追加） */
export function renderEntries(container, entries, { sessionId, leafId } = {}) {
  container.replaceChildren();
  let rendered = 0;
  for (const entry of entries ?? []) {
    const node = renderEntry(entry, sessionId);
    if (node) {
      container.appendChild(node);
      rendered += 1;
    }
  }
  container.dataset.entries = String(rendered);
  container.dataset.leafId = leafId ?? "";
  return rendered;
}

/** 供测试/验收读取折叠状态 */
export function getCollapseState() {
  return Object.fromEntries(collapseState);
}
