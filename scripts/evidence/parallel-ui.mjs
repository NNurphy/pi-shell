#!/usr/bin/env node
// 第三批验收：多会话并行（每个浏览器标签页一个 pi 引擎）
//
// 为什么要这个脚本：单引擎时「标签页 A 跑长任务」与「标签页 B 跑另一个会话」互斥
// （switch_session / 新 prompt 都会 abort 当前回合）。本脚本用两个真实 CDP 标签页取证：
//   P1 起桥（夹具 sessions / 上限 2，PI_SHELL_MAX_ENGINES 显式钉为 2 —— 见下方 MAX_ENGINES 注释）+ 页面 A 就绪（认领到自己的引擎）
//   P2 页面 A：点「新会话」（+ 选目录）→ 发长任务 → 等到 streaming 且出现首字
//   P3 页面 B（新 target）：点「新会话」（+ 选目录）→ 发另一个长任务 → 也进入 streaming
//   P4 **核心断言**：/api/health.engines 里同时有 2 个 state=streaming，
//      且 A 的页面在 B 开始后 5s 内字数仍在增长（= A 没被 B 中止）
//   P5 两边都回 idle → 两个会话文件都在磁盘上，内容不同
//   P6 同会话保护：B 打开 A 正在用的会话 → 409 CONFLICT + 页面提示（不白屏）
//   P7 第三个页面（max=2）→ 页面显示「已达并行上限」，不白屏；claim 接口 503
//   P8 关掉 B 的 target → 60s 空闲回收 → health.engines 只剩 1 个（sweep 生效）
//   P9 回收后新页面能重新认领（恢复正常）
//   P10 收尾：停桥、清夹具、清 sidecar/backups、截图（A/B 同时 streaming）
//
// 口径说明：P8 必须在 P7 之前不行、之后才行——「达上限」只有在 2 个引擎都活着的时刻才有意义，
// 所以脚本顺序是 P6 → P7 → P8（与任务书的编号顺序不同，理由写在上面）。
//
// 用法：node scripts/evidence/parallel-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PARALLEL_UI_PORT || 7830);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-parallel-ui");
const SESSIONS = path.join(OUT_DIR, "sessions");
// 工作区不能放系统临时目录：桥会把 header.cwd 在临时目录下的会话归为 test，列表默认不显示，
// 就没办法用真实鼠标点列表行来验证 409 冲突提示。所以用仓库内的可丢弃目录（收尾删除）。
const WORKSPACE_ROOT = path.join(REPO_ROOT, ".tmp-evidence-parallel-ui");
const WORKSPACE = path.join(WORKSPACE_ROOT, "workspace");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const SHOT_A = path.join(SHOT_DIR, "parallel-ui-a-streaming.png");
const SHOT_B = path.join(SHOT_DIR, "parallel-ui-b-streaming.png");
const BACKUP_ROOT = path.join(REPO_ROOT, "backups", "deleted-sessions");
// 上限**刻意钉死为 2**（不跟随桥的默认值 4）：本脚本的核心场景是「第 3 个标签页撞上限」，
// 用 2 只需 2 个 pi 子进程即可取证；用 4 要开到第 5 页、多 spawn 3 个 pi。
// 桥的默认值 4 由 bridge/test/engines.test.mjs（resolveMaxEngines 默认 4）守。
const MAX_ENGINES = 2;
const SWEEP_IDLE_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT_A =
  "请写一篇约 2000 字的说明文，主题：本机小型服务的可观测性。分成 10 段，每段不少于 150 字，" +
  "段落之间用空行分隔。直接输出正文，不要标题、不要列表符号。";
const PROMPT_B =
  "请写一篇约 2000 字的说明文，主题：浏览器标签页、进程与内存模型。分成 10 段，每段不少于 150 字，" +
  "段落之间用空行分隔。直接输出正文，不要标题、不要列表符号。";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- bridge ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_CWD: WORKSPACE,
      PI_SHELL_LOG_FILE: LOG_FILE,
      PI_SHELL_MAX_ENGINES: String(MAX_ENGINES),
    },
    stdio: "ignore", // H-15：子进程 stdio 必须 ignore，接管道不消费会把桥堵死
  });
}

async function getHealth(clientId) {
  const headers = clientId ? { "X-Pi-Shell-Client": clientId } : {};
  const res = await fetch(`${BASE}/api/health`, { cache: "no-store", headers });
  return res.json();
}

async function waitHealth(pred, ms, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try {
      last = await getHealth();
      if (pred(last)) return last;
    } catch {}
    await sleep(250);
  }
  throw new Error(`等待超时（${label}，${ms}ms）last=${JSON.stringify(last?.pi ?? null)}`);
}

/** 带客户端标识的请求（headless 脚本自己就是「一个客户端」） */
async function api(clientId, pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    cache: "no-store",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(clientId ? { "X-Pi-Shell-Client": clientId } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
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

async function evaluate(cdp, expression, awaitPromise = true) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 180000 });
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "";
    throw new Error(`页面脚本抛错：${detail.split("\n")[0]}`);
  }
  return res.result?.value;
}

const READY = `(() => ({
  version: (document.getElementById('version')?.textContent || '').trim(),
  state: (document.getElementById('state')?.textContent || '').trim(),
  input: !!document.getElementById('input'),
  client: window.__piShell?.clientId || null,
  notice: (document.getElementById('notice')?.textContent || '').trim(),
  noticeShown: (() => { const n = document.getElementById('notice'); return !!n && getComputedStyle(n).display !== 'none'; })(),
}))()`;

async function waitPageReady(cdp, ms = 25000, { requireReady = true } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await evaluate(cdp, READY, false).catch(() => null);
    if (requireReady) {
      if (s?.input && s?.client && s.version && s.version !== "—") return s;
    } else if (s?.input) {
      // 达并行上限的页面不会拿到引擎 → 不会轮询 health → version 永远是「—」，只要求主界面在
      return s;
    }
    await sleep(200);
  }
  return null;
}

/** 点「新会话」后等到桥真的切完（POST /api/session/new 回执后页面会重建对话区） */
async function waitNewSessionDone(cdp, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const done = await evaluate(cdp, `!!document.querySelector('[data-role=welcome-new]')`, false).catch(() => false);
    if (done) return true;
    await sleep(150);
  }
  return false;
}

/** 新开一个标签页（同一 Edge 实例的第二个 target；sessionStorage 天然按标签页隔离） */
async function newPage(debugPort, { requireReady = true } = {}) {
  let res = await fetch(`http://127.0.0.1:${debugPort}/json/new?url=about:blank`, { method: "PUT" }).catch(() => null);
  if (!res || !res.ok) res = await fetch(`http://127.0.0.1:${debugPort}/json/new?url=about:blank`).catch(() => null);
  if (!res || !res.ok) throw new Error("无法新建标签页（/json/new 不可用）");
  const target = await res.json();
  const cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: `${BASE}/` });
  const ready = await waitPageReady(cdp, 25000, { requireReady });
  if (!ready) throw new Error(`标签页未就绪：${target.id}`);
  return { id: target.id, cdp, ready };
}

async function closePage(debugPort, targetId) {
  try {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/close/${targetId}`);
    if (r.ok) return true;
  } catch {}
  try {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/close/${targetId}`, { method: "PUT" });
    return r.ok;
  } catch {
    return false;
  }
}

async function clickElement(cdp, selector) {
  const box = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "not found" };
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      const ok = !!hit && (hit === el || el.contains(hit));
      return { x, y, ok };
    })()`,
    false,
  );
  if (box.error) return box;
  if (!box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
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

/**
 * A1（新会话先选项目目录）：点 #new-session 不再立即建会话，会先弹「选择项目」层。
 * 这里走完整用户路径：点 #new-session → 选/填目标目录 → 点「新建会话」→ 等弹层关闭。
 * 页面还没有弹层（旧版）时退化为原行为（picker=false）。
 */
async function newSessionInDir(cdp, dir) {
  const click = await clickElement(cdp, "#new-session");
  const opened = await waitFor(cdp, `(() => {
    const p = document.getElementById('project-picker');
    return (p && p.hidden === false) ? true : null;
  })()`, 15000);
  if (!opened) return { hit: click.hit === true, picker: false, gone: true };
  const idx = await evaluate(cdp, `(() => {
    const norm = (p) => String(p || '').trim().replace(/[\\\\/]+$/, '').replace(/\\\\/g, '/').toLowerCase();
    const want = norm(${JSON.stringify(dir)});
    const rows = [...document.querySelectorAll('[data-role="picker-dir"]')];
    const i = rows.findIndex((r) => norm(r.dataset.cwd) === want);
    return i < 0 ? null : i + 1;
  })()`);
  let picked;
  if (idx) {
    picked = await clickElement(cdp, `#picker-list .picker-dir:nth-child(${idx})`);
  } else {
    // 列表里没有该目录 → 走「其他目录…」手输（真实键入，不注入 value）
    await clickElement(cdp, '[data-role="picker-other"]');
    await clickElement(cdp, '[data-role="picker-path"]');
    await cdp.send("Input.insertText", { text: dir });
    picked = { hit: true };
  }
  const confirm = await clickElement(cdp, '[data-role="picker-confirm"]');
  const gone = await waitFor(cdp, `(() => {
    const p = document.getElementById('project-picker');
    return (p && p.hidden === true) ? true : null;
  })()`, 60000);
  return { hit: click.hit === true, picker: true, picked: picked.hit === true, confirm: confirm.hit === true, gone: !!gone };
}

/** 真实键入 + 发送快捷键（走页面自己的 composer 路径，不用 el.value 注入）
 *  第五批：Enter = 换行，发送改为 Ctrl+Enter（modifiers: 2 = Ctrl）。 */
async function typeAndSend(cdp, text) {
  const focused = await evaluate(
    cdp,
    `(() => { const el = document.getElementById('input'); if (!el) return false; el.focus(); return document.activeElement === el; })()`,
    false,
  );
  if (!focused) throw new Error("输入框无法聚焦");
  await cdp.send("Input.insertText", { text });
  await sleep(120);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2, text: "\r", unmodifiedText: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 });
}

/** 点「新会话」+ 选目录，直到桥切完（页面报「正在运行中」或点击未命中时重试） */
async function newSessionViaUi(cdp, clientId, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await waitHealth(
      (h) => (h.engines || []).some((e) => e.id === clientId && e.state === "idle"),
      30000,
      `${label} idle before new-session`,
    );
    await sleep(400); // 页面自己的 state 要靠 SSE 帧跟上（帧到即 paintStatus）
    const click = await newSessionInDir(cdp, WORKSPACE); // A1：点完还要在弹层里选目录并确认
    if (await waitNewSessionDone(cdp, 20000)) return { ...click, picker: click.picker };
    const info = await evaluate(
      cdp,
      `(() => ({ state: (document.getElementById('state')?.textContent || '').trim(),
                 notice: (document.getElementById('notice')?.textContent || '').trim() }))()`,
      false,
    ).catch(() => ({}));
    console.log(`      [${label}] 新会话未完成（第 ${attempt} 次）hit=${click?.hit} state=${info?.state} notice=${info?.notice}`);
    await sleep(1000);
  }
  throw new Error(`页面 ${label} 的「新会话」未完成`);
}

/** 页面进度：日志文本长度 + 是否仍在运行（页面口径） */
const PROGRESS = `(() => {
  const log = document.getElementById('log');
  const txt = log ? (log.innerText || '') : '';
  return {
    len: txt.length,
    state: (document.getElementById('state')?.textContent || '').trim(),
    maxScroll: log ? log.scrollHeight : 0,
  };
})()`;

async function progress(cdp) {
  return evaluate(cdp, PROGRESS, false);
}

/** 用真实鼠标点侧边栏里「指定会话文件」那一行（用户路径，不是直接调接口） */
async function clickSessionRow(cdp, filePath) {
  const box = await evaluate(
    cdp,
    `(() => {
      const bs = String.fromCharCode(92); // 反斜杠（避免模板字符串里的转义地狱）
      const norm = (p) => String(p || '').split(bs).join('/').toLowerCase();
      const target = norm(${JSON.stringify(filePath)});
      const rows = [...document.querySelectorAll('[data-role=session-row]')];
      const row = rows.find((n) => norm(n.dataset.path) === target);
      if (!row) return { error: 'row not found', rows: rows.length };
      row.scrollIntoView({ block: 'center' });
      const r = row.getBoundingClientRect();
      const x = Math.round(r.left + Math.min(80, r.width / 2));
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, ok: !!hit && (hit === row || row.contains(hit)) };
    })()`,
    false,
  );
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
}

async function waitStreaming(clientId, ms, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await getHealth();
    const engine = (last.engines || []).find((e) => e.id === clientId);
    if (engine?.state === "streaming") return last;
    await sleep(300);
  }
  throw new Error(`等待 ${label} 进入 streaming 超时（${ms}ms）last=${JSON.stringify(last?.engines ?? null)}`);
}

async function waitFirstChars(cdp, baseline, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = await progress(cdp);
    if (p.len > baseline + 20) return p;
    await sleep(250);
  }
  throw new Error(`等待 ${label} 首字超时（${ms}ms）`);
}

function engineIds(health) {
  return (health.engines || []).map((e) => e.id);
}

/** 列表默认收起：先展开所有分组（等分组行出现后再点） */
async function expandAllIn(cdp) {
  await evaluate(cdp, `(async () => {
    for (let w = 0; w < 60; w++) {
      if (document.querySelectorAll('[data-role=group-row]').length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (let i = 0; i < 6; i++) {
      const closed = [...document.querySelectorAll('[data-role=group-row][data-open=false]')];
      if (!closed.length) break;
      closed.forEach((g) => g.querySelector('[data-role=group-toggle]')?.click());
      await new Promise((r) => setTimeout(r, 200));
    }
  })()`, true).catch(() => {});
  await sleep(300);
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  // 端口独占（避免给出假证据）
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  const debugPort = PORT + 1000;
  let edge = null;
  let pageA = null;
  let pageB = null;
  let pageC = null;
  let health = null;
  // 快照删除备份目录：本轮结束时只清「本脚本新创建」的子项（不碰既存备份）
  const backupsBefore = fs.existsSync(BACKUP_ROOT) ? new Set(fs.readdirSync(BACKUP_ROOT)) : null;

  try {
    health = await waitHealth((h) => h?.pi?.state === "idle", 45000, "bridge idle");
    check("P1a 桥就绪（夹具 sessions / 上限 2）", health.engineCount === 1 && health.maxEngines === MAX_ENGINES,
      `engines=${health.engineCount} max=${health.maxEngines} pi=${health.pi.version}`);

    // Edge（第一个标签页 = 页面 A）
    fs.rmSync(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true });
    edge = spawn(edgePath, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${path.join(OUT_DIR, "edge-profile")}`,
      "--window-size=1440,900",
      `${BASE}/`,
    ], { stdio: "ignore" });

    let firstTarget = null;
    for (let i = 0; i < 100 && !firstTarget; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
        firstTarget = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch {}
      if (!firstTarget) await sleep(250);
    }
    if (!firstTarget) throw new Error("Edge CDP 未就绪");

    const cdpA = cdpConnect(firstTarget.webSocketDebuggerUrl);
    await cdpA.ready;
    const pageErrors = [];
    const crashes = [];
    cdpA.on((msg) => {
      if (msg.method === "Inspector.targetCrashed") crashes.push("A:targetCrashed");
      if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const e = msg.params.entry;
        if (!/favicon\.ico/.test(String(e.url || "") + " " + String(e.text || ""))) pageErrors.push(e.text);
      }
    });
    await cdpA.send("Runtime.enable");
    await cdpA.send("Log.enable");
    await cdpA.send("Page.enable");
    await cdpA.send("Inspector.enable").catch(() => {});

    const readyA = await waitPageReady(cdpA);
    pageA = { id: firstTarget.id, cdp: cdpA, client: readyA?.client };
    const clientA = readyA?.client;
    check("P1b 页面 A 就绪并认领到自己的引擎", !!clientA && readyA.state !== "断开",
      `client=${String(clientA).slice(0, 8)}… state=${readyA?.state}`);

    // ---- P2 页面 A：新会话 + 长任务 ----
    const clickNewA = await newSessionViaUi(cdpA, clientA, "A");
    const baseA = (await progress(cdpA)).len;
    await typeAndSend(cdpA, PROMPT_A);
    await waitStreaming(clientA, 30000, "A");
    const firstA = await waitFirstChars(cdpA, baseA, 60000, "A");
    check("P2 页面 A：新会话 + 长任务已进入 streaming 并出现首字", true,
      `hit=${clickNewA.hit} len=${firstA.len}`);

    // ---- P3 页面 B（新标签页）：另一个会话 + 另一个长任务 ----
    const b = await newPage(debugPort);
    pageB = { id: b.id, cdp: b.cdp, client: b.ready.client };
    const clientB = b.ready.client;
    check("P3a 页面 B 就绪（独立标签页 / 独立引擎）", !!clientB && clientB !== clientA,
      `clientB=${String(clientB).slice(0, 8)}…  A=${String(clientA).slice(0, 8)}…`);

    const clickNewB = await newSessionViaUi(b.cdp, clientB, "B");
    const baseB = (await progress(b.cdp)).len;
    await typeAndSend(b.cdp, PROMPT_B);
    await waitStreaming(clientB, 40000, "B");
    const firstB = await waitFirstChars(b.cdp, baseB, 60000, "B");
    check("P3b 页面 B：新会话 + 长任务已进入 streaming 并出现首字（A 仍在跑）", true, `hit=${clickNewB.hit} len=${firstB.len}`);

    // ---- P4 核心断言：两个引擎同时在 streaming，且 A 的字数仍在增长 ----
    const both = await getHealth();
    const streamingNow = (both.engines || []).filter((e) => e.state === "streaming");
    check("P4a 两个引擎同时在 streaming（互不中止）",
      streamingNow.length === 2 && new Set(streamingNow.map((e) => e.id)).size === 2 &&
        streamingNow.some((e) => e.id === clientA) && streamingNow.some((e) => e.id === clientB),
      `streaming=${streamingNow.map((e) => e.id.slice(0, 8)).join(",")} engines=${both.engineCount}`);

    const beforeA = (await progress(cdpA)).len;
    await sleep(5000);
    const afterA = (await progress(cdpA)).len;
    const afterB = (await progress(b.cdp)).len;
    const diagA = await evaluate(
      cdpA,
      `(() => ({ href: location.href, readyState: document.readyState, client: window.__piShell?.clientId || null,
                 head: (document.getElementById('log')?.innerText || '').slice(0, 80) }))()`,
      false,
    ).catch((err) => ({ error: err.message }));
    check("P4b B 开始后 5s 内 A 的字数仍在增长（A 没被中止）", afterA > beforeA,
      `A ${beforeA} → ${afterA}（+${afterA - beforeA}） B=${afterB} diagA=${JSON.stringify(diagA)} crashes=${crashes.length}`);

    // A/B 同时 streaming 的截图（此刻两页都在跑）
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const shotA = await cdpA.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_A, Buffer.from(shotA.data, "base64"));
    const shotB = await b.cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_B, Buffer.from(shotB.data, "base64"));
    console.log(`      截图：${SHOT_A} / ${SHOT_B}`);

    // ---- P5 两边都回 idle → 两个会话文件存在且内容不同 ----
    // 自然跑完（长文 ~2000 字）；超过 150s 则点「中止」收敛，避免脚本无界���行
    let idleBoth = null;
    try {
      idleBoth = await waitHealth(
        (h) => (h.engines || []).length === 2 && (h.engines || []).every((e) => e.state === "idle"),
        150000,
        "A+B idle",
      );
    } catch {
      console.log("      150s 仍未跑完 → 点「中止」收敛（内容已落盘，断言不变）");
      await clickElement(cdpA, "#abort").catch(() => {});
      await clickElement(b.cdp, "#abort").catch(() => {});
      idleBoth = await waitHealth(
        (h) => (h.engines || []).length === 2 && (h.engines || []).every((e) => e.state === "idle"),
        60000,
        "A+B idle after abort",
      );
    }
    const fileA = idleBoth.engines.find((e) => e.id === clientA)?.sessionFile;
    const fileB = idleBoth.engines.find((e) => e.id === clientB)?.sessionFile;
    const existsA = !!fileA && fs.existsSync(fileA);
    const existsB = !!fileB && fs.existsSync(fileB);
    const sameFile = !!fileA && !!fileB && path.resolve(fileA).toLowerCase() === path.resolve(fileB).toLowerCase();
    const bodyA = existsA ? fs.readFileSync(fileA, "utf8") : "";
    const bodyB = existsB ? fs.readFileSync(fileB, "utf8") : "";
    check("P5 两个会话文件都在磁盘上且内容不同", existsA && existsB && !sameFile && bodyA !== bodyB,
      `A=${existsA ? path.basename(fileA) : "缺失"}(${bodyA.length}B) B=${existsB ? path.basename(fileB) : "缺失"}(${bodyB.length}B)`);

    // ---- P6 同会话保护：B 打开 A 正在用的会话 → 409 CONFLICT ----
    const conflict = await api(clientB, "/api/session/open", { method: "POST", body: { path: fileA } });
    check("P6a B 打开 A 的会话 → 409 CONFLICT", conflict.status === 409 && conflict.data?.error?.code === "CONFLICT",
      `HTTP ${conflict.status} code=${conflict.data?.error?.code} msg=${conflict.data?.error?.message || ""}`);

    // 页面侧同样要看得到提示（走真实鼠标点侧边栏 → 用户路径，不是只测接口）
    let rowsInfo = [];
    let clickRow = { hit: false };
    let noticeB = { shown: false, text: "" };
    let stillRendered = false;
    let clickError = null;
    try {
      await expandAllIn(b.cdp);
      rowsInfo = await evaluate(
        b.cdp,
        `(() => [...document.querySelectorAll('[data-role=session-row]')].map((n) => n.dataset.path))()`,
        false,
      );
      clickRow = await clickSessionRow(b.cdp, fileA);
      const t6 = Date.now();
      while (Date.now() - t6 < 8000) {
        noticeB = await evaluate(
          b.cdp,
          `(() => { const n = document.getElementById('notice'); return { shown: !!n && getComputedStyle(n).display !== 'none', text: (n?.textContent || '').trim() }; })()`,
          false,
        );
        if (noticeB.shown && /已在另一个标签页打开|409/.test(noticeB.text)) break;
        await sleep(250);
      }
      stillRendered = await evaluate(
        b.cdp,
        `!!document.getElementById('log') && (document.getElementById('log').innerText || '').length > 20`,
        false,
      );
    } catch (err) {
      clickError = err.message;
    }
    check(
      "P6b 页面（点侧边栏那一行）显示冲突提示且对话区仍在（不白屏）",
      clickRow.hit && noticeB.shown && /已在另一个标签页打开/.test(noticeB.text) && stillRendered && !clickError,
      `rows=${(rowsInfo || []).length} hit=${clickRow.hit} notice="${String(noticeB.text).slice(0, 60)}" log=${stillRendered}${clickError ? ` err=${clickError}` : ""}`,
    );

    // ---- P7 第三个页面：达并行上限 ----
    const c = await newPage(debugPort, { requireReady: false });
    pageC = { id: c.id, cdp: c.cdp, client: c.ready.client };
    // 页面在启动即 claim；达上限时认领失败 → showNotice + 3s 重试
    let thirdNotice = null;
    const t3 = Date.now();
    while (Date.now() - t3 < 10000) {
      thirdNotice = await evaluate(
        c.cdp,
        `(() => { const n = document.getElementById('notice'); return { shown: !!n && getComputedStyle(n).display !== 'none', text: (n?.textContent || '').trim(), input: !!document.getElementById('input') }; })()`,
        false,
      );
      if (thirdNotice?.shown && /并行上限/.test(thirdNotice.text)) break;
      await sleep(300);
    }
    const claimC = await api(pageC.client, "/api/engine/claim", { method: "POST" });
    const notWhite = await evaluate(
      c.cdp,
      `(() => {
        const main = document.getElementById('log') || document.body;
        return { bodyText: (document.body.innerText || '').trim().length, logDisplay: getComputedStyle(main).display, input: !!document.getElementById('input') };
      })()`,
      false,
    );
    check("P7 第三个页面达上限：显示「已达并行上限」且不白屏",
      /并行上限/.test(String(thirdNotice?.text)) && claimC.status === 503 && notWhite.bodyText > 50 && notWhite.input,
      `notice="${String(thirdNotice?.text).slice(0, 40)}" claim=${claimC.status} bodyText=${notWhite.bodyText}`);

    // 关掉被拒的页面（不占引擎）
    await closePage(debugPort, pageC.id);
    pageC = null;

    // ---- P8 关掉 B 的 target → 60s 空闲回收 ----
    const closedAt = Date.now();
    await closePage(debugPort, pageB.id);
    pageB = null;
    const afterClose = await getHealth();
    check("P8a 关掉 B 后引擎仍在（未立即释放）", (afterClose.engines || []).length === 2,
      `engines=${(afterClose.engines || []).length}`);

    let swept = null;
    const t8 = Date.now();
    while (Date.now() - t8 < SWEEP_IDLE_MS + 45000) {
      const h = await getHealth();
      if ((h.engines || []).length === 1) {
        swept = h;
        break;
      }
      await sleep(1000);
    }
    const sweepMs = Date.now() - closedAt;
    check("P8b 60s 空闲回收生效（health.engines 只剩 1 个）",
      !!swept && swept.engines[0]?.id === clientA && sweepMs >= 50000,
      swept ? `剩 ${swept.engines[0]?.id.slice(0, 8)}… 用时 ${Math.round(sweepMs / 1000)}s` : `超时未回收（${Math.round(sweepMs / 1000)}s）`);

    // 桥日志里应有回收事件
    const logText = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
    check("P8c 桥日志记录了 engine_swept", /engine_swept/.test(logText) && /engine_release/.test(logText), "");

    // ---- P9 回收后新页面能重新认领（恢复正常） ----
    const d = await newPage(debugPort);
    const healthD = await getHealth();
    const claimD = await api(d.ready.client, "/api/engine/claim", { method: "POST" });
    check("P9 回收后新标签页能重新认领（恢复正常）", claimD.status === 200 && (healthD.engines || []).length === 2,
      `claim=${claimD.status} engines=${(healthD.engines || []).length}`);
    await closePage(debugPort, d.id);

    check("P10 页面无未捕获 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "无");
  } finally {
    try {
      pageA?.cdp.close();
    } catch {}
    try {
      pageB?.cdp.close();
    } catch {}
    try {
      pageC?.cdp.close();
    } catch {}
    try {
      edge?.kill("SIGKILL");
    } catch {}
    // 先记下所有 pi 的 pid（停桥后它们可能还在），再 SIGTERM 桥
    let pids = [];
    try {
      pids = (await getHealth()).engines.map((e) => e.pid).filter(Boolean);
    } catch {}
    try {
      bridge.kill("SIGTERM");
    } catch {}
    await sleep(2500);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    // 清夹具 & 只清本轮新产生的删除备份（本脚本不删会话，纯保险）
    if (!process.env.PI_SHELL_KEEP_TMP) {
      try {
        fs.rmSync(OUT_DIR, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
      } catch {}
    } else {
      console.log(`      保留现场：${OUT_DIR} / ${WORKSPACE_ROOT}`);
    }
    if (backupsBefore) {
      try {
        for (const name of fs.readdirSync(BACKUP_ROOT)) {
          if (!backupsBefore.has(name)) fs.rmSync(path.join(BACKUP_ROOT, name), { recursive: true, force: true });
        }
      } catch {}
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
