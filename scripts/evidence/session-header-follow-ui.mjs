#!/usr/bin/env node
// B1 / T6 前端证据：顶栏（模型 / 思考级别 / 项目目录 / MCP）跟随当前会话
//
// 为什么存在：切列后顶栏曾停在上一个会话的值（design F12/F13/B3-1~B3-3）；B1 规定
// 数据只从 GET /api/session/view?client=<本列> 取，前端单一入口 syncHeaderFromSession()。
//
// 做法：假 pi RPC（model/thinkingLevel/可用模型都由「自己的 cwd」派生）→ 三列各切到
// 不同项目（project-a / project-b / project-gone），全程真实鼠标 + 用户路径（新会话 → 选项目）：
//   H0 桥就绪 + 页面可交互（1 列）
//   H1 点顶栏「3」→ 三列，clientId 两两不同
//   H2 列 1 新建会话到 project-a → #model / #thinking / #ws-path / 列头 MCP 徽标 == 该列 view
//   H3 列 2 新建会话到 project-b → 同上；模型/思考级别与列 1 不同（证明不是沿用上一列）
//   H4 切回列 1 → 顶栏回到列 1 的真实值（按列各一份真相）
//   H5 列 3（project-gone：会话模型不在该列候选清单）→ 下拉显示「该模型不可用」，
//      不是列 2 的旧模型（F14：不静默保留）
//   H6 切回列 2 → 恢复列 2 的模型（不可用选项不残留）
//   H7 新建会话切目录期间没有 403 /api/git/diff?cwd=<旧目录>（T6 的 403 修复）
//   H8 收尾：端口释放、pi 子进程不残留（按 PID 清理，不按命令行批量杀）
//
// 隔离：端口 7835；PI_SHELL_SESSIONS_DIR = %TEMP% 夹具；不碰真实会话目录。
// 用法：node scripts/evidence/session-header-follow-ui.mjs      （EDGE_PATH 可指定 msedge.exe）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_HEADER_PORT || 7835);
const DEBUG_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-session-header-follow");
const HOME = path.join(OUT_DIR, "home");
// 项目目录必须在系统临时目录之外：header.cwd 落在 %TEMP% 会被 origins 判为 test，
// 而 /api/sessions 默认不返回 test → 「选择项目」弹层里看不到它们（同 multi-column-ui 口径）。
const PROJECTS = path.join(REPO_ROOT, ".tmp-evidence-session-header");
const DIR_A = path.join(PROJECTS, "project-a");
const DIR_B = path.join(PROJECTS, "project-b");
const DIR_GONE = path.join(PROJECTS, "project-gone");
const SESSIONS = path.join(OUT_DIR, "sessions");
const AGENT_DIR = path.join(OUT_DIR, "agent");
const MCP_CONFIG = path.join(OUT_DIR, "pi-shell-mcp.json");
const LOG_FILE = path.join(OUT_DIR, "logs", "bridge.log");
const SHOT = path.join(OUT_DIR, "session-header-follow.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const norm = (p) => String(p || "").trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
const base = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";

// ---------- 假 pi（与 session-view-api.mjs 同口径，额外按目录给出模型/思考级别/MCP） ----------
// 关键点：get_state 与 get_available_models 故意可不同（project-gone 目录放 .models-gone 标记），
// 用来验证「会话模型不在候选清单 → 显示该模型不可用」而不是保留上一列的值。
const FAKE_PI = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const cwd = process.cwd();
const name = path.basename(cwd) || "root";
const gone = fs.existsSync(path.join(cwd, ".models-gone"));
const currentModel = { provider: "fake", id: "model-" + name, name: "Fake " + name };
const available = gone ? [{ provider: "fake", id: "available-only", name: "Available Only" }] : [currentModel];
const thinkingLevel = gone ? "medium" : (name.endsWith("b") ? "low" : "high");
let seq = 0;
let sessionId = "fake-" + name + "-0";
let sessionFile = path.join(cwd, ".fake-session-0.jsonl");

// 真实落一个 header-only .jsonl：桥的 /api/git/diff 白名单会读会话 header 的 cwd，
// 文件不存在时会把该 cwd 当越界（403），与本脚本要验证的「切目录 403」混在一起。
function writeHeader() {
  try {
    fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }) + "\\n", "utf8");
  } catch {}
}
writeHeader();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.id === "undefined") return;
  const reply = (data) =>
    process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");
  switch (msg.type) {
    case "get_state":
      return reply({ sessionId, sessionFile, cwd, isStreaming: false, thinkingLevel, model: currentModel });
    case "get_entries":
      return reply({ entries: [], leafId: null });
    case "new_session":
      seq += 1;
      sessionId = "fake-" + name + "-" + seq;
      sessionFile = path.join(cwd, ".fake-session-" + seq + ".jsonl");
      writeHeader();
      return reply({ cancelled: false });
    case "get_available_models":
      return reply({ models: available });
    case "get_available_thinking_levels":
      return reply({ levels: ["off", "low", "medium", "high"] });
    case "get_commands":
      return reply({ commands: [{ name: "cmd-" + name, description: "cwd=" + cwd }] });
    default:
      return reply({});
  }
});
`;

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
  // provider "fake" 必须算「已配置」，否则 /api/models 的 configured 过滤会把假模型滤掉
  fs.writeFileSync(path.join(AGENT_DIR, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fixture" } }, null, 2), "utf8");
  // MCP 候选 server（假 pi 不真的连接；桥只把名单写到 shim 的 mcp.json）
  fs.writeFileSync(
    path.join(AGENT_DIR, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          alpha: { command: "node", args: ["-e", ""], description: "fixture alpha" },
          beta: { command: "node", args: ["-e", ""], description: "fixture beta" },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** 会话夹具：让「选择项目」弹层里出现三个项目目录（picker 的候选来自 /api/sessions groups） */
function writeFixtureSessions() {
  const rows = (id, cwd) => {
    const t0 = Date.now() - 600_000;
    return [
      { type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd: cwd.replace(/\\/g, "/") },
      {
        type: "message",
        id: `${id}-u`,
        timestamp: new Date(t0 + 1000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "夹具会话：只用于让 picker 列出该项目目录。" }] },
      },
      {
        type: "message",
        id: `${id}-a`,
        parentId: `${id}-u`,
        timestamp: new Date(t0 + 2000).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "收到。" }] },
      },
    ];
  };
  fs.mkdirSync(SESSIONS, { recursive: true });
  const fixtures = [
    ["fixture-project-a", DIR_A],
    ["fixture-project-b", DIR_B],
    ["fixture-project-gone", DIR_GONE],
  ];
  for (const [id, dir] of fixtures) {
    fs.writeFileSync(path.join(SESSIONS, `${id}.jsonl`), `${rows(id, dir).map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  }
}

function buildFixture() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  for (const dir of [HOME, DIR_A, DIR_B, DIR_GONE, SESSIONS, AGENT_DIR, path.dirname(LOG_FILE)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(DIR_GONE, ".models-gone"), "1\n", "utf8");
  writeFakePi();
  writeFixtureSessions();
  fs.writeFileSync(
    MCP_CONFIG,
    `${JSON.stringify(
      {
        default: [],
        rules: [
          { cwd: DIR_A.replace(/\\/g, "/"), servers: ["alpha"] },
          { cwd: DIR_B.replace(/\\/g, "/"), servers: ["beta"] },
          { cwd: DIR_GONE.replace(/\\/g, "/"), servers: ["alpha", "beta"] },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
      PI_SHELL_CWD: HOME,
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_PI_BIN: "",
    },
    // H-15：子进程 stdio 必须 ignore/inherit，接管道不消费会把桥堵死
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
    await sleep(300);
  }
  return null;
}

async function view(clientId) {
  const res = await fetch(`${BASE}/api/session/view?client=${encodeURIComponent(clientId)}`, { cache: "no-store" });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

// ---------- Edge + CDP（同 first-load / new-session-dir-ui 口径） ----------

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

async function rawEvaluate(cdp, expression, awaitPromise = false) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 120000 });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function evaluate(cdp, expression, awaitPromise = false) {
  return Promise.race([
    rawEvaluate(cdp, expression, awaitPromise),
    sleep(45000).then(() => {
      throw new Error("evaluate 超时 45000ms");
    }),
  ]);
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

/** 真实鼠标点击（elementFromPoint 自证没被遮挡） */
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

/** 点弹层里 data-cwd == 目标目录 的那一行（归一化路径匹配，避免分隔符差异） */
async function clickDirRow(cdp, cwd) {
  const idx = await evaluate(cdp, `(() => {
    const want = ${JSON.stringify(norm(cwd))};
    const norm = (p) => String(p || '').trim().replace(/[\\\\/]+$/, '').replace(/\\\\/g, '/').toLowerCase();
    const rows = [...document.querySelectorAll('[data-role="picker-dir"]')];
    const i = rows.findIndex((r) => norm(r.dataset.cwd) === want);
    return i < 0 ? null : i + 1;
  })()`);
  if (!idx) return { hit: false, error: "row not found" };
  return clickElement(cdp, `#picker-list .picker-dir:nth-child(${idx})`);
}

async function shot(cdp) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(s.data, "base64"));
}

// 顶栏探针：模型 / 思考级别 / 目录 / 当前列列头 MCP 徽标
const HEADER_PROBE = `(() => {
  const sel = document.getElementById('model-select');
  const think = document.getElementById('thinking-select');
  const opt = sel ? [...sel.options].find((o) => o.value === sel.value) : null;
  const col = document.querySelector('.column[data-col-key="' + (window.__piShell?.activeColumnKey || '') + '"]');
  const mcp = col ? col.querySelector('[data-role=col-mcp]') : null;
  return {
    key: window.__piShell?.activeColumnKey || null,
    model: sel ? sel.value : null,
    modelText: opt ? opt.textContent : null,
    modelCurrent: sel ? (sel.dataset.current ?? null) : null,
    unavailable: sel ? (sel.dataset.unavailable ?? null) : null,
    thinking: think ? think.value : null,
    thinkingCurrent: think ? (think.dataset.current ?? null) : null,
    ws: (document.getElementById('ws-path')?.textContent || '').trim(),
    wsTitle: document.getElementById('ws-path')?.title || '',
    mcpText: mcp ? (mcp.textContent || '').trim() : null,
    mcpTitle: mcp ? (mcp.title || '') : '',
    pickerHidden: document.getElementById('project-picker')?.hidden === true,
    pickerError: (document.getElementById('picker-error')?.textContent || '').trim(),
  };
})()`;

async function activateColumn(cdp, key) {
  return evaluate(cdp, `(() => window.__piShell.activateColumn(${JSON.stringify(key)}))()`);
}

async function newSessionIn(cdp, cwd) {
  const clickNew = await clickElement(cdp, "#new-session");
  const opened = await waitFor(cdp, `(() => !document.getElementById('project-picker')?.hidden)()`, 8000);
  if (!opened) return { ok: false, step: "picker not open", clickNew };
  const picked = await clickDirRow(cdp, cwd);
  if (!picked.hit) {
    const rows = await evaluate(cdp, `(() => [...document.querySelectorAll('[data-role="picker-dir"]')].map((r) => r.dataset.cwd))()`);
    return { ok: false, step: "dir row not found", picked, rows, want: cwd };
  }
  const confirm = await clickElement(cdp, '[data-role="picker-confirm"]');
  const closed = await waitFor(cdp, `(() => document.getElementById('project-picker')?.hidden === true)()`, 30000);
  const probe = await evaluate(cdp, HEADER_PROBE).catch(() => null);
  return { ok: !!closed, clickNew, picked, confirm, probe };
}

/** 等顶栏 == 该列 session/view 的期望值（模型/思考/目录/MCP 徽标） */
function headerMatcher(expected) {
  return `(() => {
    const p = (${HEADER_PROBE});
    const norm = (x) => String(x || '').trim().replace(/[\\\\/]+$/, '').replace(/\\\\/g, '/').toLowerCase();
    const ok = p.model === ${JSON.stringify(expected.model)} &&
      p.thinking === ${JSON.stringify(expected.thinking)} &&
      norm(p.wsTitle) === ${JSON.stringify(norm(expected.cwd))} &&
      p.mcpText === ${JSON.stringify(expected.mcpText)};
    return ok ? p : null;
  })()`;
}

// ---------- 主流程 ----------

async function main() {
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（不按命令行批量杀，先确认是谁）`);

  buildFixture();
  let bridge = null;
  let edge = null;
  let cdp = null;
  let health = null;
  const pageErrors = [];
  const diff403 = []; // 新建会话切目录期间（H2–H3）的 403 /api/git/diff

  try {
    bridge = startBridge();
    health = await waitHealth();
    if (!health) throw new Error(`桥未在 45s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid}`);
    console.log(`      fixture=${OUT_DIR}`);

    const edgePath = findEdge();
    if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");
    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;
    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
      if (msg.method === "Network.responseReceived") {
        const r = msg.params?.response || {};
        if (r.status === 403 && /\/api\/git\/diff/.test(String(r.url || ""))) {
          diff403.push({ url: r.url, at: Date.now() });
        }
      }
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const e = msg.params.entry;
        const url = String(e.url || "");
        if (/favicon\.ico/.test(url + " " + String(e.text || ""))) return;
        // 意料之中的网络拒绝（不是 JS 异常）：夹具 home 不是 git 仓库时 /api/git/diff 403。
        // H7 用 Network 事件单独断言「新建会话期间不得出现 403」。
        if (/Failed to load resource/.test(String(e.text || "")) && /\/api\/git\/diff/.test(url)) return;
        // 建列瞬间引擎还在握手：/api/session/view 503 是预期（不是 JS 异常）
        if (/Failed to load resource/.test(String(e.text || "")) && /\/api\/session\/view/.test(url) && /503/.test(String(e.text || ""))) return;
        pageErrors.push(url ? `${e.text} (${url})` : e.text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");

    // ---- H0 页面就绪 ----
    const ready = await waitFor(
      cdp,
      `(() => {
        const v = (document.getElementById('version')?.textContent || '').trim();
        return v && v !== '—' && window.__piShell && document.getElementById('input') ? { version: v } : null;
      })()`,
      30000,
    );
    check("H0 桥就绪 + 页面可交互（__piShell / version 已就绪）", !!ready, ready ? `pi=${ready.version}` : "30s 未就绪");
    if (!ready) throw new Error("页面未就绪，后续断言无意义");
    await sleep(500);

    // ---- H1 点顶栏「3」→ 三列 ----
    const clickThree = await clickElement(cdp, '[data-split="3"]');
    const three = await waitFor(cdp, `(() => (window.__piShell.columnCount === 3 ? window.__piShell.columns() : null))()`, 30000);
    const ids = (three ?? []).map((c) => c.clientId);
    check(
      "H1 点「3」→ 三列，clientId 两两不同",
      clickThree.hit === true && !!three && ids.length === 3 && new Set(ids).size === 3,
      `点中=${clickThree.hit} · 列=${ids.join(" / ") || "—"}`,
    );
    if (!three) throw new Error("未能建出三列");

    const [col1, col2, col3] = three;

    // 清空 H2/H3 观察窗（H1 的点按可能带出一枪工作区根 diff：不计入切目录修复的证据）
    diff403.length = 0;

    // ---- H2 列 1 → project-a ----
    await activateColumn(cdp, col1.key);
    await waitFor(cdp, `(() => document.getElementById('state')?.dataset.state === 'idle')()`, 30000);
    const createdA = await newSessionIn(cdp, DIR_A);
    const viewA = await view(col1.clientId);
    const expA = {
      model: `${viewA.body?.model?.provider}/${viewA.body?.model?.id}`,
      thinking: viewA.body?.thinkingLevel,
      cwd: viewA.body?.cwd,
      mcpText: (viewA.body?.mcp ?? []).length ? `MCP·${viewA.body.mcp.length}` : "",
    };
    const headerA = await waitFor(cdp, headerMatcher(expA), 25000);
    check(
      "H2 列 1 新建会话到 project-a → #model/#thinking/#ws-path/列头 MCP == 该列 session/view",
      createdA.ok && viewA.status === 200 && !!headerA &&
        headerA.modelCurrent === expA.model &&
        viewA.body?.mcp?.every((name) => String(headerA.mcpTitle).includes(name)),
      `view=${viewA.status} ${JSON.stringify(expA)} · 顶栏=${headerA ? JSON.stringify({ model: headerA.model, thinking: headerA.thinking, ws: headerA.ws, mcp: headerA.mcpText }) : "未匹配"} · 建会话=${createdA.ok} step=${createdA.step || ""} rows=${JSON.stringify(createdA.rows || null)} want=${createdA.want || ""}`,
    );

    // ---- H3 列 2 → project-b（模型/思考级别必须跟着换，不能沿用列 1） ----
    await activateColumn(cdp, col2.key);
    await waitFor(cdp, `(() => document.getElementById('state')?.dataset.state === 'idle')()`, 30000);
    const createdB = await newSessionIn(cdp, DIR_B);
    const viewB = await view(col2.clientId);
    const expB = {
      model: `${viewB.body?.model?.provider}/${viewB.body?.model?.id}`,
      thinking: viewB.body?.thinkingLevel,
      cwd: viewB.body?.cwd,
      mcpText: (viewB.body?.mcp ?? []).length ? `MCP·${viewB.body.mcp.length}` : "",
    };
    const headerB = await waitFor(cdp, headerMatcher(expB), 25000);
    if (!createdB.ok) console.log(`      列 2 建会话失败：step=${createdB.step || ""} rows=${JSON.stringify(createdB.rows || null)}`);
    check(
      "H3 列 2 新建会话到 project-b → 顶栏 == 列 2 view（模型/思考/目录/MCP 都不是列 1 的值）",
      createdB.ok && viewB.status === 200 && !!headerB &&
        headerB.model !== expA.model && headerB.thinking !== expA.thinking &&
        headerB.mcpText === `MCP·${(viewB.body?.mcp ?? []).length}`,
      `view=${viewB.status} ${JSON.stringify(expB)} · 顶栏=${headerB ? JSON.stringify({ model: headerB.model, thinking: headerB.thinking, ws: headerB.ws, mcp: headerB.mcpText }) : "未匹配"} · 列 1 模型=${expA.model}`,
    );

    // ---- H4 切回列 1 → 顶栏跟着回来 ----
    await activateColumn(cdp, col1.key);
    const backA = await waitFor(cdp, headerMatcher(expA), 25000);
    check(
      "H4 切回列 1 → 顶栏恢复列 1 的真实值（按列各一份真相）",
      !!backA && backA.model === expA.model && backA.thinking === expA.thinking,
      backA ? `model=${backA.model} thinking=${backA.thinking} ws=${backA.ws}` : "未回到列 1 的值",
    );

    // H7 只统计「新建会话切目录」窗口（H2–H3）；H5 的 403 是夹具 fake session 的另一个原因。
    const diff403AfterNewSession = diff403.slice();
    diff403.length = 0;

    // ---- H5 列 3（project-gone）→ 模型不在候选清单：显示「该模型不可用」 ----
    await activateColumn(cdp, col3.key);
    await waitFor(cdp, `(() => document.getElementById('state')?.dataset.state === 'idle')()`, 30000);
    const createdC = await newSessionIn(cdp, DIR_GONE);
    const viewC = await view(col3.clientId);
    const expC = `${viewC.body?.model?.provider}/${viewC.body?.model?.id}`;
    const unavailable = await waitFor(
      cdp,
      `(() => {
        const p = (${HEADER_PROBE});
        return p.unavailable === ${JSON.stringify(expC)} && p.model === ${JSON.stringify(expC)} && p.modelText === '该模型不可用' ? p : null;
      })()`,
      25000,
    );
    if (!unavailable) {
      const dbg = await evaluate(cdp, `({ probe: (${HEADER_PROBE}), modelClientId: window.__piShell.modelClientId, active: window.__piShell.activeColumnKey, opts: [...document.querySelectorAll('#model-select option')].map((o) => ({ v: o.value, t: o.textContent, u: o.dataset.unavailable || null })) })`).catch(() => null);
      console.log(`      H5 调试：${JSON.stringify(dbg)}`);
    }
    check(
      "H5 列 3 会话模型不在候选清单 → 下拉显示「该模型不可用」（不是列 2 的旧模型）",
      createdC.ok && !!unavailable && viewC.body?.model?.id === "model-project-gone" &&
        unavailable.model !== expB.model,
      `view=${viewC.status} 会话模型=${expC} · 下拉 value=${unavailable?.model} 文案=${JSON.stringify(unavailable?.modelText)} 标记=${unavailable?.unavailable} · 列 2 模型=${expB.model}`,
    );

    // ---- H6 切回列 2 → 恢复正常模型，不可用项不残留 ----
    await activateColumn(cdp, col2.key);
    const backB = await waitFor(cdp, headerMatcher(expB), 25000);
    const residual = backB ? [...(await evaluate(cdp, `(() => [...document.querySelectorAll('#model-select option[data-unavailable]')].map((o) => o.value))()`))] : [];
    check(
      "H6 切回列 2 → 恢复列 2 模型，且下拉里没有残留的不可用项",
      !!backB && backB.unavailable === null && residual.length === 0,
      backB ? `model=${backB.model} unavailable=${backB.unavailable} 残留=${JSON.stringify(residual)}` : "未恢复列 2",
    );

    // ---- H7 新建会话切目录期间没有 403 /api/git/diff（T6 修复） ----
    check(
      "H7 H2–H3 新建会话切目录期间无 403 /api/git/diff?cwd=<旧目录>",
      diff403AfterNewSession.length === 0,
      diff403AfterNewSession.length ? diff403AfterNewSession.slice(0, 3).map((x) => x.url).join(" | ") : "0 次",
    );

    await shot(cdp);

    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("H7b 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");

    check(
      "H8 不占 7788：全程使用独立端口",
      PORT !== 7788,
      `port=${PORT}`,
    );
  } finally {
    let enginePids = [];
    let engineIds = [];
    try {
      const live = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
      enginePids = (live?.engines ?? []).map((e) => e.pid).filter((p) => Number.isInteger(p));
      engineIds = (live?.engines ?? []).map((e) => e.id).filter(Boolean);
    } catch {
      enginePids = (health?.engines ?? []).map((e) => e.pid).filter((p) => Number.isInteger(p));
      engineIds = (health?.engines ?? []).map((e) => e.id).filter(Boolean);
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
    if (health?.pi?.pid) {
      try {
        process.kill(health.pi.pid, "SIGKILL");
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
      "H9 收尾：端口释放、pi 子进程不残留（按 PID 清理）",
      free && alive.length === 0,
      `port ${PORT} free=${free} · 残留 pid=${JSON.stringify(alive)}`,
    );
    // 桥被 SIGTERM 直接结束时不会跑 process.on("exit") → MCP shim 临时目录可能留下：
    // 只删本次客户端前缀的目录（不扫别人的 shim）。
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
    await fsp.rm(PROJECTS, { recursive: true, force: true }).catch(() => {});
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
