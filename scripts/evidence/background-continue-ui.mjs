#!/usr/bin/env node
// S4 证据：前端断线补齐与「真相」（设计 §5.2 / §5.4 / §6-S4）
//
// 做法：起真实桥 + 假 pi RPC CLI（不 spawn 真 pi、不碰真实会话目录、不占 7788），独立端口 7836。
// 假 pi 的流式输出由「控制文件」驱动（测试脚本 append JSONL → 假 pi 每 80ms 读新行），
// 所以断线/重连时序全在测试手里，不依赖模型抖动：
//   {"op":"chunk","target":"<sessionId>","count":3,"prefix":"tok"}  → 3 帧 message_update（text_delta）
//   {"op":"finish","target":"<sessionId>","text":"..."}            → 落盘 + message_end + agent_settled
//
// 覆盖：
//   1) 打开夹具会话 → 发 prompt → 流式帧进 live 容器
//   2) 关列确认框文案 = 「关闭不会中止它，会继续在后台运行」，且**不再**出现「已生成的内容会保留」
//   3) 断线（forceDisconnect）→ 断线期间继续产生 tok3..tok5 → 1s 退避自动重连 →
//      ?since=lastSeq 回放：每个 token 在 DOM 里恰好出现 1 次（不重不漏）；桥日志有 sse_replay 且 since>0
//   4) 再断线 → 期间发一帧 > 512KB（单帧上限，被跳过）→ 重连 resume.truncated=true →
//      提示「部分输出未能补齐」；回合结束强制一次权威重载
//   5) agent_settled 后权威重载：live 合成节点被换成正式 entries（entries=2、live 容器空、正文只出现 1 次）
//   6) 另一 client（无 SSE）打开第二条会话并在后台跑一轮 → 等 > ADOPT_GRACE → 本页新列 openPath →
//      adopted:true、无错误提示、attachState=attached、SSE 自动接到被接管的引擎（新 token 进该列 DOM）
//
// 隔离：端口 7836；PI_SHELL_SESSIONS_DIR / PI_SHELL_AGENT_DIR 全在 %TEMP% 夹具；不碰真实会话。
// 收尾：按端口/PID 关自己起的桥与 Edge（不按命令行批量杀），夹具目录整个删掉。
// 用法：node scripts/evidence/background-continue-ui.mjs      （EDGE_PATH 可指定 msedge.exe）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_BG_UI_PORT || 7836);
const DEBUG_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-bg-continue-ui");
const HOME = path.join(OUT_DIR, "home");
// 项目目录必须在系统临时目录之外（同 session-header-follow-ui 口径：%TEMP% 会被判成 test origin）
const PROJECT = path.join(REPO_ROOT, ".tmp-evidence-bg-continue", "project-a");
const SESSIONS = path.join(OUT_DIR, "sessions");
const AGENT_DIR = path.join(OUT_DIR, "agent");
const MCP_CONFIG = path.join(OUT_DIR, "pi-shell-mcp.json");
const CONTROL = path.join(OUT_DIR, "control.jsonl");
const LOG_FILE = path.join(OUT_DIR, "logs", "bridge.log");
const SESSION_1 = path.join(SESSIONS, "bg-ui-session.jsonl");
const SESSION_2 = path.join(SESSIONS, "bg-ui-session-2.jsonl");
const SHOT = path.join(OUT_DIR, "background-continue-ui.png");
const ORPHAN_CLIENT = "orphan-client#c1";
const ADOPT_GRACE_MS = 1500; // 与桥的 PI_SHELL_ADOPT_GRACE_MS 一致（默认 30000，夹具里调小）
const BIG_PAD = 600_000; // > 512KB 单帧上限 → 桥 tail 置 truncated 并跳过该帧

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const norm = (p) => String(p || "").trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

// ---------- 假 pi（流式输出由控制文件驱动） ----------
const FAKE_PI = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const CONTROL = ${JSON.stringify(CONTROL)};

const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const respond = (msg, data) =>
  process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");

// 真实 pi 启动时是全新空会话（没有 sessionFile）——不能冒充夹具里别人那条，
// 否则新建的列会把别人会话“占”住（sessionOwner 命中 → 接管被 session-busy 拦住）
let sessionFile = null;
let sessionId = "fresh-" + process.pid;
let streaming = false;
let armed = false; // 没被 open/prompt 认领过的引擎不消费控制指令（后建的列不会重放别人的剧本）
let acc = "";
let counter = 0;

function readLines() {
  try {
    return fs.readFileSync(CONTROL, "utf8").split("\\n").filter(Boolean);
  } catch {
    return [];
  }
}
let consumed = readLines().length; // 只认启动之后追加的指令

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

function appendMessage(role, text) {
  const row = {
    type: "message",
    id: sessionId + "-" + role + "-" + (readEntries().length + 1),
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }] },
  };
  try {
    fs.appendFileSync(sessionFile, JSON.stringify(row) + "\\n", "utf8");
  } catch {}
  return row;
}

function apply(op) {
  if (!op || !op.target) return;
  if (op.target !== sessionId && path.basename(String(op.target || "")) !== path.basename(sessionFile)) return;
  if (op.op === "chunk") {
    const n = Math.max(1, Number(op.count) || 1);
    const prefix = String(op.prefix || "tok");
    const pad = String(op.pad || "");
    for (let i = 0; i < n; i++) {
      counter += 1;
      const token = prefix + counter + pad;
      const delta = (acc ? " " : "") + token;
      acc += delta;
      out({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: acc }] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
    }
    return;
  }
  if (op.op === "finish") {
    const text = String(op.text || acc || "done");
    appendMessage("assistant", text);
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_settled" });
    acc = "";
    streaming = false;
  }
}

setInterval(() => {
  const lines = readLines();
  while (consumed < lines.length) {
    // 还没被 open/prompt 认领 → 先攒着，不丢不乱序（防止「指令先到、引擎还没 armed」这条竞态）
    if (!armed) return;
    const line = lines[consumed];
    consumed += 1;
    let op = null;
    try { op = JSON.parse(line); } catch { op = null; }
    apply(op);
  }
}, 80).unref?.();

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
        isStreaming: streaming,
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
      armed = true;
      return respond(msg, { cancelled: false });
    case "new_session":
      armed = true;
      return respond(msg, { cancelled: false });
    case "prompt":
      armed = true;
      streaming = true;
      acc = "";
      respond(msg, { disposition: "started" });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      return;
    case "abort":
      streaming = false;
      return respond(msg, { cancelled: true });
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

function sessionRows(id, cwd, userText) {
  const t0 = Date.now() - 60_000;
  return [
    { type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd: cwd.replace(/\\/g, "/") },
    {
      type: "message",
      id: `${id}-u1`,
      timestamp: new Date(t0 + 1000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: userText }] },
    },
  ];
}

function buildFixture() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(path.dirname(PROJECT), { recursive: true, force: true });
  for (const dir of [HOME, PROJECT, SESSIONS, AGENT_DIR, path.dirname(LOG_FILE)]) fs.mkdirSync(dir, { recursive: true });
  writeFakePi();
  fs.writeFileSync(CONTROL, "", "utf8");
  fs.writeFileSync(SESSION_1, `${sessionRows("bg-ui-session", PROJECT, "断线补齐夹具：第一轮").map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  fs.writeFileSync(SESSION_2, `${sessionRows("bg-ui-session-2", PROJECT, "接管夹具：后台那一轮").map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  fs.writeFileSync(MCP_CONFIG, `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");
}

function appendOp(op) {
  fs.appendFileSync(CONTROL, `${JSON.stringify(op)}\n`, "utf8");
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
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_IDLE_MS: "600000", // 本片不验空闲回收（S1 已有证据），别让退避窗口里引擎被收走
      PI_SHELL_ADOPT_GRACE_MS: String(ADOPT_GRACE_MS),
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

async function api(pathname, { method = "GET", client = null, body } = {}) {
  const headers = {};
  if (client) headers["x-pi-shell-client"] = client;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

function bridgeLog() {
  try {
    return fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    return "";
  }
}

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

async function clickElement(cdp, selector) {
  const box = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: "not found" };
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === el || el.contains(hit));
    return { x, y, ok, disabled: el.disabled === true };
  })()`);
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
}

async function pressCtrlEnter(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
    modifiers: 2, // Ctrl
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
    modifiers: 2,
  });
}

async function shot(cdp) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(s.data, "base64"));
}

// 该列对话区的可见文本 + 容器结构（去重断言用）
const DOM_PROBE = `(() => {
  const key = window.__piShell?.activeColumnKey || null;
  const col = document.querySelector('.column[data-col-key="' + key + '"]') || document;
  const log = col.querySelector('[data-role=log]');
  const live = col.querySelector('[data-role=live]');
  const entries = col.querySelector('[data-role=entries]');
  return {
    key,
    text: log ? log.innerText : '',
    liveText: live ? live.innerText : '',
    liveKids: live ? live.children.length : 0,
    entryCount: entries ? entries.querySelectorAll('[data-entry-id]').length : 0,
    liveNodeCount: window.__piShell?.liveNodeCount ?? -1,
    notice: (col.querySelector('[data-role=notice]')?.innerText || '').trim(),
    noticeError: col.querySelector('[data-role=notice]')?.dataset?.kind === 'error',
    reconnectHidden: col.querySelector('[data-role=reconnect]')?.hidden === true,
    reconnectText: (col.querySelector('[data-role=reconnect-text]')?.textContent || '').trim(),
    attachState: window.__piShell?.attachState ?? null,
    sessionId: window.__piShell?.currentSessionId ?? null,
    connection: window.__piShell?.connection ?? null,
  };
})()`;

const countOf = (haystack, needle) => String(haystack || "").split(needle).length - 1;

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

    // ---- A1 页面就绪 ----
    const ready = await waitFor(
      cdp,
      `(() => {
        const v = (document.getElementById('version')?.textContent || '').trim();
        return v && v !== '—' && window.__piShell && document.getElementById('input') ? { version: v } : null;
      })()`,
      30000,
    );
    check("A1 桥就绪 + 页面可交互（__piShell / version 已就绪）", !!ready, ready ? `pi=${ready.version}` : "30s 未就绪");
    if (!ready) throw new Error("页面未就绪，后续断言无意义");

    // ---- A2 打开夹具会话（真实接管路径）----
    const opened = await evaluate(cdp, `(() => window.__piShell.openPath(${JSON.stringify(SESSION_1)}))()`, true);
    const attached = await waitFor(cdp, `(() => (window.__piShell.attachState === 'attached' ? (${DOM_PROBE}) : null))()`, 20000);
    check(
      "A2 打开夹具会话 → attached（输入框可用）",
      !!opened && !!attached && attached.entryCount === 1 && attached.sessionId === "bg-ui-session",
      `open=${JSON.stringify(opened && { sessionId: opened.sessionId, entries: opened.entries })} attach=${attached?.attachState} entries=${attached?.entryCount}`,
    );
    if (!attached) throw new Error("会话未接管成功");

    // ---- A3 发 prompt → 流式帧进 live 容器 ----
    await clickElement(cdp, "#input");
    await cdp.send("Input.insertText", { text: "断线补齐：直接输出" });
    await pressCtrlEnter(cdp);
    // 先等桥/引擎真的进 streaming（prompt 被 pi 认领 → armed），再下发剧本，避免竞态
    const streamingUp = await waitFor(cdp, `(() => document.getElementById('state')?.dataset.state === 'streaming')()`, 15000);
    appendOp({ op: "chunk", target: "bg-ui-session", count: 2, prefix: "tok" });
    const firstChunks = await waitFor(
      cdp,
      `(() => { const p = (${DOM_PROBE}); return p.liveText.includes('tok2') ? p : null; })()`,
      15000,
    );
    check(
      "A3 发 prompt → 流式帧进 live 容器（tok1/tok2 都在 live 里）",
      streamingUp === true &&
        !!firstChunks &&
        firstChunks.liveText.includes("tok1") &&
        firstChunks.liveText.includes("tok2") &&
        firstChunks.liveKids > 0,
      `streaming=${streamingUp} ` + (firstChunks ? `live 子节点=${firstChunks.liveKids} liveText=${JSON.stringify(firstChunks.liveText.slice(0, 60))}` : "15s 未见流式帧"),
    );

    // ---- A4 关列确认框文案（真话）+ 取消不关列 ----
    const split = await clickElement(cdp, '[data-split="2"]');
    const twoCols = await waitFor(cdp, `(() => (window.__piShell.columnCount === 2 ? window.__piShell.columns() : null))()`, 20000);
    const keys = twoCols ?? [];
    const col1Key = keys[0]?.key ?? null;
    await evaluate(cdp, `(() => window.__piShell.activateColumn(${JSON.stringify(col1Key)}))()`);
    const closeBtn = await clickElement(cdp, `.column[data-col-key="${col1Key}"] [data-role=col-close]`);
    const modalUp = await waitFor(
      cdp,
      `(() => { const t = (document.querySelector('[data-role=confirm-text]')?.textContent || '').trim(); return t ? t : null; })()`,
      8000,
    );
    const modalText = String(modalUp || "");
    await clickElement(cdp, '[data-role="confirm-cancel"]').catch(() => {});
    await sleep(400);
    const afterCancel = await evaluate(cdp, `({ cols: window.__piShell.columnCount, modalHidden: document.getElementById('modal')?.hidden === true })`);
    check(
      "A4 关列确认框说真话（「关闭不会中止…会继续在后台运行」，且无「已生成的内容会保留」）",
      split.hit === true &&
        keys.length === 2 &&
        closeBtn.hit === true &&
        modalText.includes("关闭不会中止") &&
        /继续在后台运行/.test(modalText) &&
        !modalText.includes("已生成的内容会保留") &&
        afterCancel.cols === 2 &&
        afterCancel.modalHidden === true,
      `列=${keys.length} 点关闭=${closeBtn.hit} 文案=${JSON.stringify(modalText.slice(0, 70))} 取消后列=${afterCancel.cols}`,
    );
    await evaluate(cdp, `(() => window.__piShell.activateColumn(${JSON.stringify(col1Key)}))()`);

    // ---- A5 断线 → 期间继续产出 → 自动重连 → 不重不漏 ----
    await evaluate(cdp, `(() => { window.__piShell.forceDisconnect(); return true; })()`);
    appendOp({ op: "chunk", target: "bg-ui-session", count: 3, prefix: "tok" }); // tok3..tok5（断线期间）
    await sleep(1800); // 断线期间确实没有 SSE 消费这些帧（只可能在尾巴缓冲里）
    const reconnected = await waitFor(
      cdp,
      `(() => { const p = (${DOM_PROBE}); return p.reconnectHidden && p.text.includes('tok5') ? p : null; })()`,
      25000,
    );
    const log1 = bridgeLog();
    const replayLine = (log1.split("\n").filter((l) => l.includes("|sse_replay|")).pop() || "").trim();
    const sinceMatch = /since=(\d+)/.exec(replayLine);
    const counts = ["tok1", "tok2", "tok3", "tok4", "tok5"].map((t) => countOf(reconnected?.text || "", t));
    check(
      "A5 断线→1s 退避自动重连：?since=lastSeq 回放，tok1..tok5 各出现 1 次（不重不漏）",
      !!reconnected && counts.every((n) => n === 1) && !!sinceMatch && Number(sinceMatch[1]) > 0,
      `重连=${!!reconnected} 计数=${JSON.stringify(counts)} · 桥日志=${replayLine || "无 sse_replay"}`,
    );

    // ---- A6 truncated：断线期间一帧超单帧上限 → resume.truncated → 明确提示 ----
    await evaluate(cdp, `(() => { window.__piShell.forceDisconnect(); return true; })()`);
    appendOp({ op: "chunk", target: "bg-ui-session", count: 1, prefix: "huge", pad: "x".repeat(BIG_PAD) });
    const truncatedNotice = await waitFor(
      cdp,
      `(() => { const p = (${DOM_PROBE}); return p.notice.includes('部分输出未能补齐') ? p : null; })()`,
      30000,
    );
    const truncLogLine = (bridgeLog().split("\n").filter((l) => l.includes("|sse_replay|")).pop() || "").trim();
    const truncResume = truncatedNotice?.connection?.lastResume ?? null;
    check(
      "A6 断线期间输出超上限（单帧 >512KB）→ resume.truncated → 提示「部分输出未能补齐」",
      !!truncatedNotice && truncResume?.truncated === true && !String(truncatedNotice?.text || "").includes("huge"),
      `提示=${JSON.stringify(truncatedNotice?.notice || "")} · resume=${JSON.stringify(truncResume)} · 上一条回放=${truncLogLine || "无"}`,
    );

    // ---- A7 回合结束 → 权威重载（live 合成节点换成正式 entries）----
    const FINAL_TEXT = "权威重载后的正文：tok1 tok2 tok3 tok4 tok5";
    appendOp({ op: "finish", target: "bg-ui-session", text: FINAL_TEXT });
    const reloaded = await waitFor(
      cdp,
      `(() => {
        const p = (${DOM_PROBE});
        const ok = p.entryCount === 2 && p.text.includes('权威重载后的正文');
        return ok ? p : null;
      })()`,
      30000,
    );
    const finalCounts = countOf(reloaded?.text || "", FINAL_TEXT);
    check(
      "A7 agent_settled → 权威重载：entries=2、live 合成节点清空、正文只出现 1 次",
      !!reloaded && finalCounts === 1 && reloaded.liveKids === 0 && reloaded.entryCount === 2 && !/会自动重新加载/.test(reloaded.notice),
      reloaded
        ? `entries=${reloaded.entryCount} live 子节点=${reloaded.liveKids} 正文出现 ${finalCounts} 次 · notice=${JSON.stringify(reloaded.notice)}`
        : "30s 未完成权威重载",
    );

    // ---- A8 孤儿接管：另一个 client（无 SSE）跑着 → 本页新列 openPath → adopted + 自动重连 ----
    const openOrphan = await api("/api/session/open", { method: "POST", client: ORPHAN_CLIENT, body: { path: SESSION_2 } });
    const promptOrphan = await api("/api/prompt", { method: "POST", client: ORPHAN_CLIENT, body: { message: "后台继续跑" } });
    appendOp({ op: "chunk", target: "bg-ui-session-2", count: 1, prefix: "bg" });
    await sleep(600);
    const orphanEngine = (await health())?.engines?.find?.((e) => e.id === ORPHAN_CLIENT) ?? null;
    await sleep(ADOPT_GRACE_MS + 800); // 越过 ADOPT_GRACE_MS（无 SSE + 静默）

    const col2Key = keys[1]?.key ?? null;
    await evaluate(cdp, `(() => window.__piShell.activateColumn(${JSON.stringify(col2Key)}))()`);
    const adopted = await evaluate(cdp, `(() => window.__piShell.openPath(${JSON.stringify(SESSION_2)}))()`, true);
    const adoptedView = await waitFor(
      cdp,
      `(() => { const p = (${DOM_PROBE}); return p.attachState === 'attached' && p.sessionId === 'bg-ui-session-2' ? p : null; })()`,
      20000,
    );
    // 接管后实时帧：允许重连竞态（最多补发 3 次），但必须真的落到这一列的 live 容器
    let adoptedLive = null;
    for (let i = 0; i < 3 && !adoptedLive; i++) {
      appendOp({ op: "chunk", target: "bg-ui-session-2", count: 1, prefix: "bg" });
      adoptedLive = await waitFor(cdp, `(() => { const p = (${DOM_PROBE}); return /bg\\d/.test(p.liveText) ? p : null; })()`, 8000);
    }
    const afterAdoptHealth = await health();
    const adoptedLog = /session_open_adopted\|/.test(bridgeLog());
    const adoptedEngine = (afterAdoptHealth?.engines ?? []).find((e) => e.id === keys[1]?.clientId) ?? null;
    check(
      "A8 孤儿接管：adopted:true → 无错误提示 + SSE 自动接到被接管的引擎（新帧进该列）",
      openOrphan.status === 200 &&
        promptOrphan.status === 200 &&
        !!orphanEngine &&
        adopted?.adopted === true &&
        !!adoptedView &&
        adoptedView.noticeError === false &&
        !!adoptedLive &&
        adoptedLog &&
        (afterAdoptHealth?.engines ?? []).length === 2 &&
        adoptedEngine?.pid === orphanEngine?.pid,
      `orphan open=${openOrphan.status} prompt=${promptOrphan.status} adopted=${JSON.stringify(adopted?.adopted)} attach=${adoptedView?.attachState} 实时帧=${JSON.stringify(adoptedLive?.liveText || "").slice(0, 40)} 日志 adopted=${adoptedLog} engines=${(afterAdoptHealth?.engines ?? []).map((e) => e.id).join(",")} pid=${adoptedEngine?.pid}/${orphanEngine?.pid}`,
    );

    await shot(cdp);

    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("A9 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");
    check("A10 不占 7788：全程使用独立端口", PORT !== 7788, `port=${PORT}`);
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
      "A11 收尾：端口释放、pi 子进程不残留（按 PID 清理，不按命令行批量杀）",
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
