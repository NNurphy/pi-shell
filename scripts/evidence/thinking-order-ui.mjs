#!/usr/bin/env node
// 证据（fix/thinking-order）：回答结束时页面底部必须是正文，思考折叠且排在正文之前。
//
// 现象（用户报告）：有些回合结束后最底部是展开的「思考」块，正文在上面，必须往上滚。
// 根因（本卡复核）：直播态收到 thinking_delta 时把 thinking 节点**追加到末尾**且展开
//   （stream.js / column.js paintLive），agent_settled 只在 needsAuthoritativeReload 时重载，
//   于是「先正文、后思考」的直播合成节点就留在了页面上。
//
// 做法：起真实桥 + 假 pi（不 spawn 真 pi、不碰真实会话目录、不占 7788），独立端口 7840；
// 用 __piShell.applyFrame 注入合成帧（不依赖模型抖动），夹具会话文件按落盘顺序追加条目，
// 于是 agent_settled 的权威重载读到的就是「thinking → text」。
//
// 覆盖：
//   A1 页面就绪 + 打开夹具会话（attached）
//   A2 直播态：思考块**展开可见**（streaming 中不折叠/不加遮罩），且排在同轮正文之前
//   A3 message_end → 富渲染不重复（同一条消息的思考只出现一次）
//   A4 agent_settled（无 resume/truncated）也做权威重载：live 清空、entries = 落盘条目数
//   A5 回合结束后：最后一个可见正文节点是 assistant 的 text 块；思考在它之前、折叠
//   A6 页面滚动到底时，可视区最后一行属于正文（getBoundingClientRect 与容器底边比较）
//   A7 反例保护：条目里 thinking 在前（正常顺序）→ 渲染顺序不变、不重复插入
//   A8 收尾：端口释放、进程不残留（按 PID 清理）+ 无未捕获 JS 异常
//
// 隔离：端口 7840；PI_SHELL_SESSIONS_DIR / PI_SHELL_AGENT_DIR 全在 %TEMP% 夹具；不改 bridge/。
// 用法：node scripts/evidence/thinking-order-ui.mjs      （EDGE_PATH 可指定 msedge.exe）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 端口：本套件自带 PI_SHELL_THINKING_UI_PORT（默认 7840，须与 test-gate SUITES.thinkingOrder.port 一致）。
// 注意：不读 PI_SHELL_PORT——那可能是真实桥（7788）占着的端口。
const PORT = Number(process.env.PI_SHELL_THINKING_UI_PORT || 7840);
const DEBUG_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-thinking-order-ui");
const HOME = path.join(OUT_DIR, "home");
// 项目目录必须在系统临时目录之外（%TEMP% 会被判成 test origin）
const PROJECT = path.join(REPO_ROOT, ".tmp-evidence-thinking-order", "project-a");
const SESSIONS = path.join(OUT_DIR, "sessions");
const AGENT_DIR = path.join(OUT_DIR, "agent");
const MCP_CONFIG = path.join(OUT_DIR, "pi-shell-mcp.json");
const LOG_FILE = path.join(OUT_DIR, "logs", "bridge.log");
const SESSION = path.join(SESSIONS, "thinking-order.jsonl");
const SESSION_ID = "thinking-order";
const SHOT = path.join(OUT_DIR, "thinking-order-ui.png");

const USER1 = "思考顺序夹具：第一轮";
const THINK1 = "第一轮思考：先想清楚再回答，这段应该折叠并且排在正文之前。";
// 正文要长到撐满可视区：A6 才能用「容器底边探针」判断最后一行属于正文，而不是「内容不够高」。
const ANSWER1 = "第一轮正文：答案在这里，回合结束后必须是页面最底部的内容。";
const FILLER1 = Array.from(
  { length: 26 },
  (_, i) => `第 ${i + 1} 段正文（固定填充，用来把对话区撐高）：这一段只用来占高度，不含其它断言用的标记。`,
).join("\n\n");
const ANSWER1_BODY = `${ANSWER1}\n\n${FILLER1}`;
const THINK2 = "第二轮思考：正常顺序（思考先到），渲染顺序不应被改动。";
const ANSWER2 = "第二轮正文：正常顺序的答案，不应重复插入。";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 假 pi（只提供 get_state / get_entries / switch_session） ----------
const FAKE_PI = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const respond = (msg, data) =>
  process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");

let sessionFile = null;
let sessionId = "fresh-" + process.pid;

function readEntries() {
  let rows = [];
  try {
    rows = fs.readFileSync(sessionFile, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
  return rows
    .filter((r) => r && r.type === "message")
    .map((r) => ({ type: "message", id: r.id, timestamp: r.timestamp, message: r.message }));
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.id === "undefined") return;
  switch (msg.type) {
    case "get_state":
      return respond(msg, {
        sessionId,
        sessionFile,
        cwd: process.cwd(),
        isStreaming: false,
        thinkingLevel: "off",
        model: { provider: "fake", id: "fake-1", name: "Fake" },
      });
    case "get_entries": {
      const entries = readEntries();
      return respond(msg, { entries, leafId: entries.length ? entries[entries.length - 1].id : null });
    }
    case "switch_session":
      sessionFile = String(msg.sessionPath || sessionFile);
      sessionId = path.basename(sessionFile).replace(/[.]jsonl$/i, "");
      return respond(msg, { cancelled: false });
    case "new_session":
      return respond(msg, { cancelled: false });
    default:
      return respond(msg, {});
  }
});
`;

// ---------- 夹具 ----------

function writeFakePi() {
  const pkgDir = path.join(AGENT_DIR, "install", "releases", "1.5.0", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(AGENT_DIR, "install", "current-version"), "1.5.0\n", "utf8");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pi-coding-agent", version: "1.5.0", bin: { pi: "cli.js" } }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(pkgDir, "cli.js"), FAKE_PI, "utf8");
  fs.writeFileSync(path.join(AGENT_DIR, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fixture" } }, null, 2), "utf8");
  fs.writeFileSync(path.join(AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2), "utf8");
}

function fixtureRows() {
  const t0 = Date.now() - 60_000;
  return [
    { type: "session", version: 3, id: SESSION_ID, timestamp: new Date(t0).toISOString(), cwd: PROJECT.replace(/\\/g, "/") },
    {
      type: "message",
      id: `${SESSION_ID}-u1`,
      timestamp: new Date(t0 + 1000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: USER1 }] },
    },
  ];
}

/** 按落盘顺序追加一条 assistant 条目（content: thinking → text） */
function appendAssistant({ thinking, text }, n) {
  const row = {
    type: "message",
    id: `${SESSION_ID}-a${n}`,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text },
      ],
    },
  };
  fs.appendFileSync(SESSION, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

function buildFixture() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(path.dirname(PROJECT), { recursive: true, force: true });
  for (const dir of [HOME, PROJECT, SESSIONS, AGENT_DIR, path.dirname(LOG_FILE)]) fs.mkdirSync(dir, { recursive: true });
  writeFakePi();
  fs.writeFileSync(SESSION, `${fixtureRows().map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  fs.writeFileSync(MCP_CONFIG, `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_AGENT_DIR: AGENT_DIR,
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_AGENT_SESSIONS_DIR: "",
      PI_SHELL_MCP_CONFIG: MCP_CONFIG,
      PI_SHELL_ORIGINS_FILE: path.join(OUT_DIR, "sessions-origins.json"),
      PI_SHELL_LOG_DIR: path.join(OUT_DIR, "logs"),
      PI_SHELL_LOG_FILE: LOG_FILE,
      PI_SHELL_TURN_SNAPSHOTS: path.join(OUT_DIR, "turn-snapshots"),
      PI_SHELL_CWD: HOME,
      PI_SHELL_MAX_ENGINES: "2",
      PI_SHELL_IDLE_MS: "600000", // 本片不验空闲回收，别让引擎在断言前被收走
      PI_SHELL_PI_BIN: "",
    },
    stdio: "ignore",
  });
}

async function waitHealth(ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const body = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
      if (body?.ok && body?.pi?.state === "idle") return body;
    } catch {}
    await sleep(250);
  }
  return null;
}

async function health() {
  try {
    return await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
  } catch {
    return null;
  }
}

function bridgeLog() {
  try {
    return fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    return "";
  }
}

const logCount = (needle) => bridgeLog().split(needle).length - 1;

// ---------- Edge + CDP ----------

function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  return [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => fs.existsSync(p)) || null;
}

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  return {
    ready,
    on(fn) {
      listeners.push(fn);
    },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const res = await Promise.race([
    cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 120000 }),
    sleep(45000).then(() => {
      throw new Error("evaluate 超时 45000ms");
    }),
  ]);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function launchEdge(edgePath) {
  fs.rmSync(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true });
  const edge = spawn(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${path.join(OUT_DIR, "edge-profile")}`,
      "--window-size=1440,900",
      `${BASE}/`,
    ],
    { stdio: "ignore" },
  );
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge CDP 未就绪");
  return { edge, target };
}

async function waitFor(cdp, expr, ms = 20000, interval = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await evaluate(cdp, expr).catch(() => null);
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

async function shot(cdp) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(s.data, "base64"));
}

// 注入合成帧（不依赖模型/桥的时序）
async function frames(cdp, list) {
  const payload = JSON.stringify(list);
  const res = await evaluate(
    cdp,
    `(() => { for (const f of ${payload}) window.__piShell.applyFrame(f); return true; })()`,
  );
  if (!res) throw new Error("applyFrame 注入失败");
}

const COL_PROBE = `(() => {
  const key = window.__piShell?.activeColumnKey;
  const col = document.querySelector('.column[data-col-key="' + key + '"]');
  const log = col?.querySelector('[data-role=log]');
  const live = col?.querySelector('[data-role=live]');
  const entries = col?.querySelector('[data-role=entries]');
  return { key, col, log, live, entries };
})()`;

/** 直播态探针：思考展开可见 + 同轮顺序（2026-11-17 口径：streaming 中不折叠） */
function liveProbe() {
  return `(() => {
    const { col, live } = (${COL_PROBE});
    if (!live) return { ok: false, why: 'no-live' };
    const thinkRow = live.querySelector('[data-role=live-thinking]');
    const textRow = live.querySelector('[data-role=live-assistant]');
    const thinkRect = thinkRow ? thinkRow.getBoundingClientRect() : null;
    const body = thinkRow ? thinkRow.querySelector('.msg-body') : null;
    return {
      ok: true,
      hasThinkingRow: !!thinkRow,
      // 展开可见：有可见高度、正文文本直出，且没有被套进任何折叠容器
      thinkingVisible: !!(thinkRow && thinkRect.height > 24 && body && body.offsetHeight > 0),
      thinkingTextVisible: !!(body && body.textContent.includes('先想清楚再回答') && body.offsetHeight > 0),
      thinkingInClosedDetails: !!(thinkRow && thinkRow.closest('details[data-collapse=thinking]')),
      thinkingBeforeText: !!(thinkRow && textRow && (thinkRow.compareDocumentPosition(textRow) & Node.DOCUMENT_POSITION_FOLLOWING)),
      thinkingCount: live.querySelectorAll('[data-role=live-thinking]').length,
      assistantCount: live.querySelectorAll('[data-role=live-assistant]').length,
      liveKids: live.children.length,
      text: live.innerText,
    };
  })()`;
}

/** 回合结束后的权威态探针 */
function finalProbe(needle) {
  return `(() => {
    const { log, live, entries } = (${COL_PROBE});
    if (!log || !entries) return { ok: false, why: 'no-entries' };
    const rows = [...entries.querySelectorAll(':scope > [data-entry-id]')];
    const last = rows.length ? rows[rows.length - 1] : null;
    const detailsInLast = last ? [...last.querySelectorAll('details[data-collapse=thinking]')] : [];
    const textsInLast = last ? [...last.querySelectorAll('[data-role=text-block]')] : [];
    const thinkRow = detailsInLast[0] || null;
    const textRow = textsInLast.length ? textsInLast[textsInLast.length - 1] : null;
    const thinkingBeforeText = !!(thinkRow && textRow && (thinkRow.compareDocumentPosition(textRow) & Node.DOCUMENT_POSITION_FOLLOWING));

    // 滚到底 → 用 getBoundingClientRect 跟容器底边比：可视区最下面的内容行属于谁
    log.scrollTop = log.scrollHeight;
    const logRect = log.getBoundingClientRect();
    const textRect = textRow ? textRow.getBoundingClientRect() : null;
    const thinkRect = thinkRow ? thinkRow.getBoundingClientRect() : null;
    // 容器里所有「可见的内容行」中底边最低的那个（容器自身 padding 不算）
    const candidates = [...log.querySelectorAll('[data-role=text-block], details[data-collapse=thinking], .entry-head')].filter(
      (n) => n.getBoundingClientRect().height > 0,
    );
    const bottomMost = candidates.reduce((a, b) => (a && a.getBoundingClientRect().bottom >= b.getBoundingClientRect().bottom ? a : b), null);
    const bottomMostIsText = !!(bottomMost && textRow && (bottomMost === textRow || textRow.contains(bottomMost)));
    const bottomMostTag = bottomMost
      ? bottomMost.dataset.role || bottomMost.dataset.collapse || bottomMost.className || bottomMost.tagName
      : null;
    // 正文底边必须贴着容器底边（只允许容器 padding：<= 40px），而不是思考块或标题行
    const textCoversBottom = !!(textRect && textRect.bottom >= logRect.bottom - 40 && textRect.top <= logRect.bottom - 6);
    // 像素探针：正文底边往上 4px 处点到的必须是正文自己（排掉遮罩/悬浮元素）
    const probeY = textRect ? textRect.bottom - 4 : logRect.bottom - 6;
    const hit = document.elementFromPoint(logRect.left + Math.round(logRect.width / 2), probeY);
    const bottomHitInText = !!(hit && textRow && (hit === textRow || textRow.contains(hit)));
    const bottomHitInThinking = !!(hit && hit.closest && hit.closest('details[data-collapse=thinking]'));
    const bottomHitTag = hit ? hit.dataset?.role || hit.className || hit.tagName : null;

    const allDetails = [...log.querySelectorAll('details[data-collapse=thinking]')];
    return {
      ok: true,
      entryCount: rows.length,
      liveKids: live ? live.children.length : 0,
      lastIsAssistant: !!(last && last.dataset.role === 'assistant'),
      lastChildIsText: !!(last && textRow && last.lastElementChild === textRow),
      hasThinking: !!thinkRow,
      hasText: !!textRow,
      thinkingBeforeText,
      thinkingOpen: allDetails.map((d) => d.open),
      thinkingCount: allDetails.length,
      thinkingPerAssistant: last ? detailsInLast.length : 0,
      textOccurrences: (log.textContent.split(${JSON.stringify(needle)}).length - 1),
      textBottomGap: textRect ? Math.round(logRect.bottom - textRect.bottom) : null,
      textBelowThinking: !!(textRect && thinkRect && textRect.top >= thinkRect.bottom - 1),
      textCoversBottom,
      bottomMostIsText,
      bottomMostTag,
      bottomHitInText,
      bottomHitInThinking,
      bottomHitTag,
      scrollGap: log.scrollHeight - log.scrollTop - log.clientHeight,
      innerText: log.innerText,
    };
  })()`;
}

// ---------- 主流程 ----------

async function main() {
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（不按命令行批量杀，先确认是谁）`);

  buildFixture();
  let bridge = null;
  let edge = null;
  let cdp = null;
  let healthAtStart = null;
  const pageErrors = [];

  try {
    bridge = startBridge();
    healthAtStart = await waitHealth();
    if (!healthAtStart) throw new Error(`桥未在 45s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${healthAtStart.pi.version} · port ${PORT}`);
    console.log(`      fixture=${OUT_DIR}`);

    const edgePath = findEdge();
    if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");
    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;
    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const e = msg.params.entry;
        const url = String(e.url || "");
        const text = String(e.text || "");
        if (/favicon\.ico/.test(url + " " + text)) return;
        // 夹具 home 不是 git 仓库：/api/git/diff 403 属预期（与本卡判据无关）
        if (/Failed to load resource/.test(text) && /\/api\/git\/diff/.test(url)) return;
        pageErrors.push(url ? `${text} (${url})` : text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");

    // ---- A1 页面就绪 + 打开夹具会话 ----
    const ready = await waitFor(
      cdp,
      `(() => {
        const v = (document.getElementById('version')?.textContent || '').trim();
        return v && v !== '—' && window.__piShell && document.getElementById('input') ? { version: v } : null;
      })()`,
      30000,
    );
    check("A1a 桥就绪 + 页面可交互（__piShell / version 已就绪）", !!ready, ready ? `pi=${ready.version}` : "30s 未就绪");
    if (!ready) throw new Error("页面未就绪，后续断言无意义");

    await evaluate(cdp, `(() => window.__piShell.openPath(${JSON.stringify(SESSION)}))()`, true);
    const attached = await waitFor(
      cdp,
      `(() => { const p = (${COL_PROBE}); return p.entries && window.__piShell.attachState === 'attached' && window.__piShell.currentSessionId === ${JSON.stringify(SESSION_ID)} ? { entries: p.entries.querySelectorAll('[data-entry-id]').length } : null; })()`,
      25000,
    );
    check("A1b 打开夹具会话 → attached（条目已渲染）", !!attached && attached.entries === 1, JSON.stringify(attached));

    // ---- A2 直播态：先正文、后思考（问题复现路径）----
    await frames(cdp, [
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: ANSWER1_BODY } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: THINK1 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: THINK1 } },
    ]);
    const live = await evaluate(cdp, liveProbe());
    check(
      "A2 直播态：思考块展开可见（不折叠、无遮罩），且排在同轮正文之前（不重复）",
      !!live?.ok &&
        live.hasThinkingRow === true &&
        live.thinkingVisible === true &&
        live.thinkingTextVisible === true &&
        live.thinkingInClosedDetails === false &&
        live.thinkingBeforeText === true &&
        live.thinkingCount === 1 &&
        live.assistantCount === 1,
      JSON.stringify({
        hasThinkingRow: live?.hasThinkingRow,
        thinkingVisible: live?.thinkingVisible,
        thinkingTextVisible: live?.thinkingTextVisible,
        thinkingInClosedDetails: live?.thinkingInClosedDetails,
        thinkingBeforeText: live?.thinkingBeforeText,
        thinkingCount: live?.thinkingCount,
        assistantCount: live?.assistantCount,
        liveKids: live?.liveKids,
      }),
    );

    // ---- A3 message_end：富渲染不重复（同一条消息的思考只出现一次）----
    appendAssistant({ thinking: THINK1, text: ANSWER1_BODY }, 1);
    await frames(cdp, [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: THINK1 },
            { type: "text", text: ANSWER1_BODY },
          ],
        },
      },
    ]);
    const afterEnd = await evaluate(
      cdp,
      `(() => {
        const { log, live } = (${COL_PROBE});
        return {
          thinkingCount: log.querySelectorAll('details[data-collapse=thinking]').length,
          open: [...log.querySelectorAll('details[data-collapse=thinking]')].map((d) => d.open),
          thinkTextOccurrences: (log.textContent.split('先想清楚再回答').length - 1),
          answerOccurrences: (log.textContent.split(${JSON.stringify(ANSWER1)}).length - 1),
          liveThinkingRows: live.querySelectorAll('[data-role=live-thinking]').length,
        };
      })()`,
    );
    check(
      "A3 message_end 富渲染：同一条消息的思考只渲染 1 次（直播态重复行已撤掉）、仍折叠",
      afterEnd?.thinkingCount === 1 &&
        afterEnd.answerOccurrences === 1 &&
        afterEnd.thinkTextOccurrences === 1 &&
        afterEnd.liveThinkingRows === 0 &&
        afterEnd.open.every((o) => o === false),
      JSON.stringify(afterEnd),
    );

    // ---- A4 agent_settled（无 resume/truncated）也必须做权威重载 ----
    const openReusedBefore = logCount("|session_open_reused|");
    await frames(cdp, [{ type: "agent_settled" }]);
    const reloaded = await waitFor(
      cdp,
      `(() => { const p = (${COL_PROBE}); if (!p.entries) return null; const n = p.entries.querySelectorAll('[data-entry-id]').length; const kids = p.live ? p.live.children.length : 0; return n === 2 && kids === 0 ? { entries: n, liveKids: kids } : null; })()`,
      25000,
    );
    const openReusedAfter = logCount("|session_open_reused|");
    check(
      "A4 agent_settled（无回放/truncated）→ 权威重载：live 清空、entries = 2（落盘口径）",
      !!reloaded && openReusedAfter > openReusedBefore,
      `entries=${reloaded?.entries} liveKids=${reloaded?.liveKids} session_open_reused ${openReusedBefore}→${openReusedAfter}`,
    );

    // ---- A5 / A6 回合结束后：正文收尾、思考在前且折叠、可视区最后一行是正文 ----
    const final1 = await waitFor(cdp, `(() => { const p = (${finalProbe(ANSWER1)}); return p.ok && p.entryCount === 2 ? p : null; })()`, 20000);
    check(
      "A5 回合结束后：最后一条可见正文是 assistant 的 text 块，思考在它之前且折叠（不重复）",
      !!final1 &&
        final1.lastIsAssistant === true &&
        final1.lastChildIsText === true &&
        final1.hasThinking === true &&
        final1.thinkingBeforeText === true &&
        final1.thinkingPerAssistant === 1 &&
        final1.thinkingOpen.every((o) => o === false) &&
        final1.textOccurrences === 1,
      final1
        ? JSON.stringify({
            entryCount: final1.entryCount,
            lastIsAssistant: final1.lastIsAssistant,
            lastChildIsText: final1.lastChildIsText,
            thinkingBeforeText: final1.thinkingBeforeText,
            thinkingOpen: final1.thinkingOpen,
            textOccurrences: final1.textOccurrences,
          })
        : "20s 未拿到权威态",
    );
    check(
      "A6 滚到底：可视区最后一行属于正文（底边最低的可见块是 text 块，正文底边贴容器底边）",
      !!final1 &&
        final1.scrollGap <= 2 &&
        final1.textBottomGap != null &&
        final1.textBottomGap >= 0 &&
        final1.textBottomGap <= 40 &&
        final1.textBelowThinking === true &&
        final1.textCoversBottom === true &&
        final1.bottomMostIsText === true &&
        final1.bottomHitInText === true &&
        final1.bottomHitInThinking === false,
      final1
        ? `scrollGap=${final1.scrollGap} textBottomGap=${final1.textBottomGap} textBelowThinking=${final1.textBelowThinking} textCoversBottom=${final1.textCoversBottom} bottomMost=${final1.bottomMostTag} bottomHit=${final1.bottomHitTag} bottomHitInText=${final1.bottomHitInText} bottomHitInThinking=${final1.bottomHitInThinking}`
        : "无数据",
    );

    // ---- A7 反例保护：条目里 thinking 在前（正常顺序）----
    await frames(cdp, [
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: THINK2 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: THINK2 } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: ANSWER2 } },
    ]);
    appendAssistant({ thinking: THINK2, text: ANSWER2 }, 2);
    await frames(cdp, [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: THINK2 },
            { type: "text", text: ANSWER2 },
          ],
        },
      },
      { type: "agent_settled" },
    ]);
    const final2 = await waitFor(cdp, `(() => { const p = (${finalProbe(ANSWER2)}); return p.ok && p.entryCount === 3 ? p : null; })()`, 25000);
    check(
      "A7 反例保护：thinking 在前（正常顺序）→ 顺序不变、不重复插入（思考/正文各 1 次，仍折叠）",
      !!final2 &&
        final2.entryCount === 3 &&
        final2.lastIsAssistant === true &&
        final2.lastChildIsText === true &&
        final2.thinkingBeforeText === true &&
        final2.thinkingPerAssistant === 1 &&
        final2.thinkingCount === 2 &&
        final2.thinkingOpen.every((o) => o === false) &&
        final2.textOccurrences === 1,
      final2
        ? JSON.stringify({
            entryCount: final2.entryCount,
            lastChildIsText: final2.lastChildIsText,
            thinkingBeforeText: final2.thinkingBeforeText,
            thinkingCount: final2.thinkingCount,
            thinkingPerAssistant: final2.thinkingPerAssistant,
            thinkingOpen: final2.thinkingOpen,
            textOccurrences: final2.textOccurrences,
          })
        : "25s 未完成第二轮权威重载",
    );

    await shot(cdp);

    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("A8 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");
  } finally {
    let enginePids = [];
    let engineIds = [];
    try {
      const live = await health();
      enginePids = (live?.engines ?? []).map((e) => e.pid).filter((p) => Number.isInteger(p));
      engineIds = (live?.engines ?? []).map((e) => e.id).filter(Boolean);
    } catch {
      enginePids = (healthAtStart?.engines ?? []).map((e) => e.pid).filter((p) => Number.isInteger(p));
    }
    try {
      cdp?.close();
    } catch {}
    try {
      edge?.kill("SIGKILL");
    } catch {}
    try {
      bridge?.kill("SIGTERM");
    } catch {}
    await sleep(1500);
    for (const pid of enginePids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    if (healthAtStart?.pi?.pid) {
      try {
        process.kill(healthAtStart.pi.pid, "SIGKILL");
      } catch {}
    }
    await sleep(800);
    const free = await portFree(PORT);
    const alive = enginePids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    check(
      "A9 收尾：端口释放、pi 子进程不残留（按 PID 清理，不按命令行批量杀）",
      free && alive.length === 0,
      `port ${PORT} free=${free} · 残留 pid=${JSON.stringify(alive)}`,
    );
    // MCP shim 目录：只删本次客户端前缀的（不扫别人的）
    const safeTag = (id) => String(id || "engine").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
    const tags = new Set(engineIds.map(safeTag));
    const shimRoot = path.join(os.tmpdir(), "pi-shell-mcp");
    if (tags.size && fs.existsSync(shimRoot)) {
      for (const entry of fs.readdirSync(shimRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (![...tags].some((tag) => entry.name.startsWith(`${tag}-`))) continue;
        await fsp.rm(path.join(shimRoot, entry.name), { recursive: true, force: true }).catch(() => {});
      }
    }
    await fsp.rm(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.dirname(PROJECT), { recursive: true, force: true }).catch(() => {});
    console.log(`      夹具/日志：${OUT_DIR}`);
    console.log(`      截图：${SHOT}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});