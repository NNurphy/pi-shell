#!/usr/bin/env node
// A1 前端证据：新会话先选项目目录（零第三方依赖 · headless Edge/CDP · 独立端口 7833）
//
// 为什么存在：点「新会话」不再立刻建会话，而是先弹「选择项目」；选完在**该目录**开新会话，
// 且只影响本列。本脚本走用户路径取证：
//   N0 桥就绪 + 页面可交互（version 回填）
//   N1 点 #new-session → 弹层打开；/api/sessions 里已有的 cwd 出现在列表（data-cwd）
//   N2 选脚本自建目录（TARGET）→ 确认 → #ws-path 显示该目录（title=规范化路径）、弹层关闭、
//      会话 meta 立即显示新项目
//   N3 Ctrl+Enter 发一条真实消息 → 夹具 sessions/ 下出现**新** .jsonl（fs 断言：header.cwd == TARGET）
//   N4 400 分支：「其他目录…」填不存在的路径 → 弹层内显示「目录不存在或不是目录」，弹层保持、不新建
//   N5 Esc 关弹层（不新建，会话文件数不变）
//   N6 390 宽：弹层是底部抽屉（贴底、占满宽度、停在 Composer 上方，不遮输入区）
//   N7 收尾：端口释放、pi 子进程不残留
//
// 隔离口径：PI_SHELL_SESSIONS_DIR = %TEMP% 夹具（不碰真实会话目录），独立端口 7833（不占 7788）。
// 截图：docs/evidence/new-session-dir.png（辅助证据；主证据是 N1–N4 的断言）
//
// 用法：node scripts/evidence/new-session-dir-ui.mjs       （EDGE_PATH 可指定 msedge.exe）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_EVIDENCE_PORT || 7833);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1000;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-new-session-dir-ui");
const SESSIONS = path.join(OUT_DIR, "sessions");
const AGENTS = path.join(OUT_DIR, "sessions-agents");
const HOME = path.join(OUT_DIR, "home"); // 桥启动时的初始 cwd（不是被测目录）
const LOG_FILE = path.join(OUT_DIR, "logs", "bridge.log");
const SHOT = path.join(REPO_ROOT, "docs", "evidence", "new-session-dir.png");
const TARGET = path.join(os.tmpdir(), "pi-shell-new-session-target", "target-project"); // N2 要选的目录（脚本自建；只切引擎 cwd，不写库）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT_MARK = "只回答两个字：收到"; // 只用来识别本脚本新建的会话文件

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const norm = (p) => String(p || "").trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

// ---------- 夹具 ----------

const OLD_ID = "a1-existing-0001";

function jsonl(rows) {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}
function msg(id, parentId, at, role, content) {
  return { type: "message", id, parentId, timestamp: new Date(at).toISOString(), message: { role, content } };
}

/** 夹具里放一条「已存在」的会话：header.cwd = TARGET → N1 的列表必须出现该目录 */
function writeFixture() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(TARGET, { recursive: true }); // N2 要选的目标目录（自建，不依赖特定真实目录）
  const dir = path.join(SESSIONS, "--C--Users-user-pi-shell--");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(AGENTS, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const t0 = Date.now() - 600_000;
  const rows = [
    { type: "session", version: 3, id: OLD_ID, timestamp: t0, cwd: TARGET },
    msg("ou1", null, t0 + 1000, "user", "这条会话用来让 /api/sessions 里出现 TARGET（target-project）这个 cwd。"),
    msg("oa1", "ou1", t0 + 3000, "assistant", [{ type: "text", text: "收到。" }]),
  ];
  fs.writeFileSync(path.join(dir, `${OLD_ID}.jsonl`), jsonl(rows), "utf8");
  fs.writeFileSync(
    path.join(OUT_DIR, "pi-shell-mcp.json"),
    `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`,
    "utf8",
  );
}

function listSessionFiles(root) {
  const out = [];
  const walk = (cur) => {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** 读 .jsonl 第一行（session header）的 cwd；坏文件返回 null */
function headerCwd(file) {
  try {
    const first = fs.readFileSync(file, "utf8").split("\n").find((l) => l.trim());
    if (!first) return null;
    const rec = JSON.parse(first);
    return rec?.type === "session" ? rec.cwd ?? null : null;
  } catch {
    return null;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

// ---------- bridge ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_AGENT_SESSIONS_DIR: "", // 隔离：不扫真实 agent 会话根
      PI_SHELL_MCP_CONFIG: path.join(OUT_DIR, "pi-shell-mcp.json"),
      PI_SHELL_ORIGINS_FILE: path.join(OUT_DIR, "sessions-origins.json"),
      PI_SHELL_LOG_DIR: path.join(OUT_DIR, "logs"),
      PI_SHELL_LOG_FILE: LOG_FILE,
      PI_SHELL_CWD: HOME,
      PI_SHELL_MAX_ENGINES: "3",
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

// ---------- Edge + CDP（同 first-load / composer-e2e / new-session-ui 口径） ----------

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

/** 点弹层里 data-cwd == 目标目录 的那一行（按归一化路径匹配，避免分隔符差异） */
async function clickDirRow(cdp, cwd) {
  const idx = await evaluate(cdp, `(() => {
    const want = ${JSON.stringify(norm(cwd))};
    const norm = (p) => String(p || "").trim().replace(/[\\\\/]+$/, "").replace(/\\\\/g, "/").toLowerCase();
    const rows = [...document.querySelectorAll('[data-role="picker-dir"]')];
    const i = rows.findIndex((r) => norm(r.dataset.cwd) === want);
    return i < 0 ? null : i + 1;
  })()`);
  if (!idx) return { hit: false, error: "row not found" };
  return clickElement(cdp, `#picker-list .picker-dir:nth-child(${idx})`);
}

async function shot(cdp, file) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(s.data, "base64"));
  return file;
}

async function pressCtrlEnter(cdp) {
  const base = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 2,
    text: "\r",
    unmodifiedText: "\r",
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 2,
  });
}

async function pressEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

const PAGE_STATE = `(() => {
  const picker = document.getElementById('project-picker');
  return {
    state: document.getElementById('state')?.dataset.state || '',
    ws: (document.getElementById('ws-path')?.textContent || '').trim(),
    wsTitle: document.getElementById('ws-path')?.title || '',
    meta: (document.getElementById('session-meta')?.textContent || '').trim(),
    barHidden: document.getElementById('session-bar')?.hidden === true,
    pickerHidden: !picker || picker.hidden === true,
    pickerError: (document.getElementById('picker-error')?.textContent || '').trim(),
    pickerErrorHidden: document.getElementById('picker-error')?.hidden === true,
    notice: (document.getElementById('notice')?.textContent || '').trim(),
  };
})()`;

// ---------- 主流程 ----------

async function main() {
  if (!fs.existsSync(TARGET) || !fs.statSync(TARGET).isDirectory()) {
    throw new Error(`目标目录不存在（证据脚本只验证真实目录）：${TARGET}`);
  }
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（不按命令行批量杀，先确认是谁）`);

  writeFixture();
  const filesBefore = new Set(listSessionFiles(SESSIONS));

  let bridge = null;
  let edge = null;
  let cdp = null;
  let health = null;
  const pageErrors = [];

  try {
    bridge = startBridge();
    health = await waitHealth();
    if (!health) throw new Error(`桥未在 45s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid} · cwd ${health.pi.cwd}`);
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
        if (/favicon\.ico/.test(url + " " + String(e.text || ""))) return;
        // 意料之中的网络拒绝（不是 JS 异常）：夹具 home 不是 git 仓库（/api/git/diff 403）、
        // N4 故意发的不存在目录（/api/session/new 400）。只放行这两个端点 + 已知状态码。
        if (/Failed to load resource/.test(String(e.text || "")) && (/\/api\/git\/diff/.test(url) || /\/api\/session\/new/.test(url))) return;
        pageErrors.push(url ? `${e.text} (${url})` : e.text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");

    // ---- N0 页面就绪 ----
    const ready = await waitFor(
      cdp,
      `(() => {
        const v = (document.getElementById('version')?.textContent || '').trim();
        return v && v !== '—' && !!document.getElementById('input') ? { version: v } : null;
      })()`,
      30000,
    );
    check("N0 桥就绪 + 页面可交互（version 已回填）", !!ready, ready ? `pi=${ready.version}` : "30s 未就绪");
    if (!ready) throw new Error("页面未就绪，后续断言无意义");
    await sleep(600);

    // 等列表加载完（N1 的候选目录来自 /api/sessions）
    const listed = await waitFor(cdp, `(() => !!document.querySelector('[data-role="group-row"]'))()`, 15000);
    if (!listed) throw new Error("15s 内左侧列表没有渲染出任何分组行");

    // ---- N1 点 #new-session → 弹层打开，列表含夹具里的 cwd ----
    const clickNew = await clickElement(cdp, "#new-session");
    const opened = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.pickerHidden ? null : s; })()`, 8000);
    const rowInfo = await evaluate(cdp, `(() => {
      const want = ${JSON.stringify(norm(TARGET))};
      const norm = (p) => String(p || '').trim().replace(/[\\\\/]+$/, '').replace(/\\\\/g, '/').toLowerCase();
      const rows = [...document.querySelectorAll('[data-role="picker-dir"]')];
      const hit = rows.find((r) => norm(r.dataset.cwd) === want);
      return {
        count: rows.length,
        cwds: rows.map((r) => r.dataset.cwd),
        selected: rows.filter((r) => r.classList.contains('is-selected')).map((r) => r.dataset.cwd),
        hitText: hit ? hit.textContent.trim() : null,
      };
    })()`);
    check(
      "N1 点 #new-session → 「选择项目」弹层打开，且夹具里已有的 cwd 出现在列表",
      clickNew.hit === true && !!opened && rowInfo.count > 0 && rowInfo.hitText !== null,
      `点中=${clickNew.hit} · 行数=${rowInfo.count} · 命中「${rowInfo.hitText}」· 预选=${JSON.stringify(rowInfo.selected)}`,
    );
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    await shot(cdp, SHOT);

    // ---- N2 选 TARGET → 确认 → #ws-path 显示 target-project ----
    const picked = await clickDirRow(cdp, TARGET);
    const selectedAfter = await evaluate(
      cdp,
      `(() => [...document.querySelectorAll('[data-role="picker-dir"].is-selected')].map((r) => r.dataset.cwd))()`,
    );
    const confirm = await clickElement(cdp, '[data-role="picker-confirm"]');
    // 换目录会重启本列引擎（1–3s）→ 先等弹层关闭，再等顶栏/状态回填
    const closed = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.pickerHidden ? s : null; })()`, 60000);
    const settled = await waitFor(
      cdp,
      `(() => { const s = ${PAGE_STATE}; return (s.ws === 'target-project' && s.state === 'idle') ? s : null; })()`,
      60000,
    );
    check(
      "N2 选 TARGET（target-project）新建 → 弹层关闭 + #ws-path 显示 target-project（只影响本列）",
      picked.hit === true && selectedAfter.some((p) => norm(p) === norm(TARGET)) && confirm.hit === true &&
        !!closed && !!settled && norm(settled.wsTitle) === norm(TARGET),
      `点中=${picked.hit} · 预选=${JSON.stringify(selectedAfter)} · 确认=${confirm.hit} · ws「${settled?.ws}」· title=${settled?.wsTitle} · state=${settled?.state}`,
    );
    check(
      "N2b 会话 meta 立即显示新项目（新会话 · <cwd>），不必等第一条消息",
      !!settled && /target-project/i.test(settled.meta) && settled.barHidden === false,
      `meta「${settled?.meta}」· barHidden=${settled?.barHidden}`,
    );

    // ---- N3 发一条真实消息 → 夹具里出现新 .jsonl（fs 断言） ----
    await clickElement(cdp, "#input");
    await cdp.send("Input.insertText", { text: PROMPT_MARK });
    const tSend = Date.now();
    await pressCtrlEnter(cdp);
    let created = null;
    for (let i = 0; i < 240 && !created; i++) {
      const now = listSessionFiles(SESSIONS).filter((p) => !filesBefore.has(p));
      created = now.find((p) => norm(headerCwd(p)) === norm(TARGET)) ?? null;
      if (!created) await sleep(250);
    }
    const createdSize = created ? fs.statSync(created).size : 0;
    check(
      "N3 Ctrl+Enter 发消息 → 夹具 sessions/ 下出现新 .jsonl，且 header.cwd == TARGET",
      !!created && createdSize > 0 && norm(headerCwd(created)) === norm(TARGET),
      created ? `新文件=${path.relative(SESSIONS, created)} · ${createdSize}B · ${Date.now() - tSend}ms` : "60s 内没有新会话文件",
    );

    // 等这一轮收尾（N4 要弹层，弹层在 streaming 中是拒绝的）
    const idle = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.state === 'idle' ? s : null; })()`, 90000);
    if (!idle) console.log("      ⚠ 本轮 90s 内未回到 idle（后续 N4/N5 仍可执行，弹层只在 idle 打开）");

    // ---- N4 400 分支：不存在的目录 → 弹层内报错、不新建 ----
    const filesBeforeBad = new Set(listSessionFiles(SESSIONS));
    const wsBeforeBad = idle?.ws ?? "";
    await clickElement(cdp, "#new-session");
    await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.pickerHidden ? null : s; })()`, 8000);
    const other = await clickElement(cdp, '[data-role="picker-other"]');
    const pathShown = await evaluate(cdp, `(() => document.getElementById('picker-path')?.hidden === false)()`);
    await clickElement(cdp, '[data-role="picker-path"]');
    const missing = path.join(OUT_DIR, "definitely-not-a-dir");
    await cdp.send("Input.insertText", { text: missing.replace(/\\/g, "/") });
    const confirmBad = await clickElement(cdp, '[data-role="picker-confirm"]');
    const errored = await waitFor(
      cdp,
      `(() => { const s = ${PAGE_STATE}; return (!s.pickerHidden && !s.pickerErrorHidden && s.pickerError) ? s : null; })()`,
      15000,
    );
    const filesAfterBad = listSessionFiles(SESSIONS);
    check(
      "N4 400 目录 → 弹层就地显示「目录不存在或不是目录」，弹层保持、不新建（会话文件数不变）",
      other.hit === true && pathShown === true && confirmBad.hit === true && !!errored &&
        /不存在或不是目录/.test(errored.pickerError) && filesAfterBad.length === filesBeforeBad.size,
      `手输入口=${pathShown} · 错误「${errored?.pickerError}」· 弹层开着=${!errored?.pickerHidden} · 文件 ${filesBeforeBad.size} → ${filesAfterBad.length}`,
    );
    const wsAfterBad = (await evaluate(cdp, `(${PAGE_STATE}).ws`)) || "";
    check("N4b 400 不改当前列目录（#ws-path 仍是 pi-shell）", wsAfterBad === wsBeforeBad && wsAfterBad === "pi-shell", `ws「${wsBeforeBad}」→「${wsAfterBad}」`);

    // ---- N5 Esc 关弹层（不新建） ----
    const beforeEsc = listSessionFiles(SESSIONS).length;
    await pressEscape(cdp);
    const escClosed = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.pickerHidden ? s : null; })()`, 5000);
    const afterEsc = listSessionFiles(SESSIONS).length;
    check(
      "N5 Esc 关闭弹层，不新建（会话文件数不变）",
      !!escClosed && afterEsc === beforeEsc,
      `弹层关闭=${!!escClosed} · 文件 ${beforeEsc} → ${afterEsc}`,
    );

    // ---- N6 390 宽：底部抽屉（不遮 Composer）。走移动端真实入口：
    //      ≤768 时 #new-session 是 display:none，用户入口是顶栏品牌标（brand-home）→ 有会话时先确认 ----
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(400);
    const viaBrand = await clickElement(cdp, "#brand-home");
    await waitFor(cdp, `(() => !!document.querySelector('[data-role="confirm-continue"]'))()`, 3000);
    const viaConfirm = await clickElement(cdp, '[data-role="confirm-continue"]');
    const mobileOpen = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.pickerHidden ? null : s; })()`, 8000);
    const drawer = await evaluate(cdp, `(() => {
      const box = document.querySelector('#project-picker .picker-box');
      const composer = document.getElementById('composer');
      if (!box || !composer) return null;
      const b = box.getBoundingClientRect();
      const c = composer.getBoundingClientRect();
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        boxLeft: Math.round(b.left), boxRight: Math.round(b.right), boxBottom: Math.round(b.bottom), boxWidth: Math.round(b.width),
        composerTop: Math.round(c.top),
      };
    })()`);
    check(
      "N6 390×844：品牌标进入 → 弹层是底部抽屉（占满宽度、贴底、停在 Composer 上方不遮输入区）",
      viaBrand.hit === true && viaConfirm.hit === true && !!mobileOpen && !!drawer &&
        drawer.boxWidth === drawer.vw && drawer.boxLeft === 0 && drawer.boxRight === drawer.vw &&
        drawer.boxBottom <= drawer.composerTop + 1 && drawer.composerTop < drawer.vh,
      drawer
        ? `brand=${viaBrand.hit} 确认=${viaConfirm.hit} · 宽 ${drawer.boxWidth}/${drawer.vw} · 左 ${drawer.boxLeft} 右 ${drawer.boxRight} · 抽屉底 ${drawer.boxBottom} · Composer 顶 ${drawer.composerTop}`
        : "量不到抽屉/Composer 矩形",
    );
    await pressEscape(cdp);
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});

    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("N6b 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");
  } finally {
    // 收尾：先停长任务，再按 PID 杀进程（不按命令行批量杀）
    try {
      await fetch(`${BASE}/api/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch {}
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
    if (health?.pi?.pid) {
      try {
        process.kill(health.pi.pid, "SIGKILL");
      } catch {}
    }
    await sleep(800);

    const free = await portFree(PORT);
    let piGone = true;
    if (health?.pi?.pid) {
      try {
        process.kill(health.pi.pid, 0);
        piGone = false;
      } catch {
        piGone = true;
      }
    }
    check("N7 收尾：端口释放、pi 子进程不残留", free && piGone, `port ${PORT} free=${free} · pi pid ${health?.pi?.pid} gone=${piGone}`);
    await fsp.rm(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true }).catch(() => {});
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
