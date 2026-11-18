#!/usr/bin/env node
// B-07「新会话」按钮 + POST /api/session/new 的 E2E（零第三方依赖，CDP 真实点击）
//
// 为什么存在：03 §5 早就写了 `POST /api/session/new`，但桥里没有这个路由、界面上也没有入口
// （用户只能靠「切换工作区」绕路，代价是重启 pi ≈3s）。本脚本走用户路径取证：
//   N0 桥就绪 + 页面可交互
//   N1 打开列表第一项真实会话（#log 有条目、#session-meta 非空）
//   N2 真实鼠标点 #new-session → 弹「选择项目」层选目录确认 → 对话区只剩 welcome、#session-meta 显示新项目
//   N3 键入并按 Ctrl+Enter → 回复首字 ≤3s；/api/sessions 里出现**新的** sessionId（≠ N1 的）
//   N4 旧会话文件行数未变（打开前后对比真实 .jsonl）
//   N5 附件区图片 label 文本 == 「图片」，且 document.body.innerText 不含 `{type:`
//   N6 streaming 中点 #new-session 被拒绝（提示「正在运行中」，对话区未被清空）
//   N7 收尾：桥/pi 进程与端口都不残留
// 截图存 <tmp>/pi-shell-new-session/new-session.png
//
// 口径说明（H-5）：新会话**不落盘**，发第一条消息后 pi 才创建 .jsonl；
// 因此本脚本必须发一条真实消息才能断言「新的会话文件」。
//
// 用法：node scripts/evidence/new-session-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7823;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-new-session");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_MAIN = path.join(OUT_DIR, "new-session.png");
const SHOT_CONFLICT = path.join(OUT_DIR, "new-session-conflict.png");
// 真实 agent 目录（不隔离）：本脚本要打开一条**真实**会话，新会话也落在同一扫描根
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 本脚本发出的第一条消息：只用来识别「本脚本新建的会话文件」，收尾清理时当安全阀
const PROMPT_MARK = "只回答两个字：收到";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 会话文件（只读统计；收尾只删本脚本新建的那些）----------

function listSessionFiles(dir) {
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
  walk(dir);
  return out;
}

function countLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return -1;
  }
}

// ---------- bridge ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_LOG_FILE: LOG_FILE,
    },
    // H-15：子进程 stdio 必须 ignore/inherit，接管道不消费会把桥堵死
    stdio: "ignore",
  });
}

async function waitHealth(ms = 40000) {
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

async function assertPortFree() {
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口（避免给出假证据）`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }
}

async function getSessions() {
  const res = await fetch(`${BASE}/api/sessions`, { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/sessions HTTP ${res.status}`);
  const data = await res.json();
  const flat = [];
  for (const g of data.groups ?? []) for (const s of g.sessions ?? []) flat.push({ ...s, groupCwd: g.cwd, groupDir: g.dir });
  return { groups: data.groups ?? [], flat };
}

// ---------- Edge + CDP（同 first-load / composer-e2e 口径）----------

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
    on(fn) { listeners.push(fn); },
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
    sleep(45000).then(() => { throw new Error("evaluate 超时 45000ms"); }),
  ]);
}

async function launchEdge(edgePath) {
  fs.rmSync(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true });
  const debugPort = PORT + 1000;
  const edge = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(OUT_DIR, "edge-profile")}`,
    "--window-size=1440,900",
    `${BASE}/`,
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge CDP 未就绪");
  return { edge, target };
}

const READY = `(() => {
  const v = (document.getElementById('version')?.textContent || '').trim();
  return { version: v, input: !!document.getElementById('input'), state: (document.getElementById('state')?.dataset.state || '') };
})()`;

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

/** 真实鼠标点 (x,y)；elementFromPoint 没东西就视为未命中 */
async function clickPoint(cdp, x, y) {
  const at = await evaluate(cdp, `(() => {
    const el = document.elementFromPoint(${x}, ${y});
    return el ? { tag: el.tagName, role: (el.closest('[data-role]')?.dataset.role) || null } : null;
  })()`);
  if (!at) return { x, y, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return { x, y, hit: true, at };
}

/**
 * B8 后左侧分组**默认收起**（产品刻意行为：打开页面不自动展开，见 list.js load()）；
 * Q3 又把 origin=agent 的会话上提到独立的「AGENT 会话」板块。
 * 所以「点 API 第一项会话」= 先展开它所在的板块/分组，再点那一行。
 * 虚拟列表只有可视行在 DOM → 找不到组头时逐屏向下滚。
 * 返回 true = 该分组已展开。
 */
async function expandGroupByDir(cdp, dir, maxSteps = 40) {
  for (let i = 0; i < maxSteps; i++) {
    const st = await evaluate(cdp, `(() => {
      const dir = ${JSON.stringify(dir)};
      const row = [...document.querySelectorAll('[data-role="group-row"]')].find((r) => r.dataset.dir === dir);
      if (!row) {
        const v = document.querySelector('[data-role="list-viewport"]');
        if (v && v.scrollTop + v.clientHeight < v.scrollHeight - 1) {
          v.scrollTop = Math.min(v.scrollTop + Math.round(v.clientHeight * 0.8), v.scrollHeight);
          return { state: 'scrolling' };
        }
        return { state: 'missing' };
      }
      if (row.dataset.open === 'true') return { state: 'open' };
      row.scrollIntoView({ block: 'center' });
      return { state: 'closed' };
    })()`);
    if (st?.state === "open") return true;
    if (st?.state === "missing") return false;
    if (st?.state === "scrolling") { await sleep(220); continue; }
    // 滚动会触发重渲染 → 等稳定后重新量坐标，避免用旧位置点空
    await sleep(220);
    const box = await evaluate(cdp, `(() => {
      const dir = ${JSON.stringify(dir)};
      const row = [...document.querySelectorAll('[data-role="group-row"]')].find((r) => r.dataset.dir === dir);
      if (!row) return null;
      const r = row.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, ok: !!hit && (hit === row || row.contains(hit)) };
    })()`);
    if (!box?.ok) { await sleep(180); continue; }
    await clickPoint(cdp, box.x, box.y); // 真实鼠标展开组头
    await sleep(280);
  }
  return false;
}

/** 点指定 sessionId 的会话行（真实鼠标 + elementFromPoint 自证没被遮挡） */
async function clickSessionRow(cdp, sessionId, maxSteps = 60) {
  // 虚拟列表：目标行不一定已渲染 → 逐屏找（Q3 后 AGENT 板块可能把目标排到很深）
  let located = false;
  for (let i = 0; i < maxSteps && !located; i++) {
    const st = await evaluate(cdp, `(() => {
      const id = ${JSON.stringify(sessionId)};
      const row = [...document.querySelectorAll('[data-role="session-row"]')].find((r) => r.dataset.sessionId === id);
      if (row) { row.scrollIntoView({ block: 'center' }); return 'found'; }
      const v = document.querySelector('[data-role="list-viewport"]');
      if (v && v.scrollTop + v.clientHeight < v.scrollHeight - 1) {
        v.scrollTop = Math.min(v.scrollTop + Math.round(v.clientHeight * 0.8), v.scrollHeight);
        return 'scrolling';
      }
      return 'missing';
    })()`);
    if (st === "found") located = true;
    else if (st === "missing") break;
    else await sleep(200);
  }
  if (!located) return { error: "not found", hit: false };
  await sleep(200); // 等 scrollIntoView + 重渲染稳定
  const box = await evaluate(cdp, `(() => {
    const row = [...document.querySelectorAll('[data-role="session-row"]')].find((r) => r.dataset.sessionId === ${JSON.stringify(sessionId)});
    if (!row) return { error: "not found" };
    const r = row.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === row || row.contains(hit));
    return { x, y, ok, path: row.dataset.path || null };
  })()`);
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
}

// 发送快捷键：第五批起 Enter = 换行，发送改为 Ctrl+Enter（modifiers: 2）
async function pressCtrlEnter(cdp) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2, text: "\r", unmodifiedText: "\r" };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 });
}

async function shot(cdp, file) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(s.data, "base64"));
  return file;
}

const PAGE_STATE = `(() => {
  const log = document.getElementById('log');
  return {
    state: document.getElementById('state')?.dataset.state || '',
    logKids: log.children.length,
    logText: (log.textContent || '').slice(0, 200),
    hasWelcomeNew: !!log.querySelector('[data-role="welcome-new"]'),
    entryCount: log.querySelectorAll('[data-role="entries"] > *').length,
    meta: (document.getElementById('session-meta')?.textContent || '').trim(),
    barHidden: document.getElementById('session-bar')?.hidden === true,
    statsHidden: document.getElementById('stats')?.hidden === true,
    notice: (document.getElementById('notice')?.textContent || '').trim(),
    noticeHidden: document.getElementById('notice')?.hidden === true,
    currentId: window.__piShell?.currentSessionId ?? null,
    attach: window.__piShell?.attachState ?? null,
    assistantLen: [...document.querySelectorAll('#log .msg-assistant .msg-body, #log .entry-assistant .text-block')].map(b => b.textContent).join('').trim().length,
  };
})()`;

async function waitRoundEnd(cdp, maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await evaluate(cdp, PAGE_STATE).catch(() => null);
    if (s && s.assistantLen > 0 && s.state === "idle") return Date.now() - t0;
    await sleep(250);
  }
  return -1;
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");
  if (!fs.existsSync(SESSIONS_DIR)) throw new Error(`真实会话目录不存在：${SESSIONS_DIR}（本脚本需要一个真实会话样本）`);

  await assertPortFree();
  // 快照：只用来在收尾时删除**本脚本新建**的会话文件，绝不碰既有会话
  const filesBefore = new Set(listSessionFiles(SESSIONS_DIR));

  let bridge = null;
  let edge = null;
  let cdp = null;
  let health = null;
  let openedSessionId = null;
  let createdSession = null;

  try {
    bridge = startBridge();
    health = await waitHealth();
    if (!health) throw new Error(`桥未在 40s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid} · cwd ${health.pi.cwd}`);

    const first = (await getSessions()).flat[0];
    if (!first) throw new Error("真实会话列表为空：本脚本需要至少一条已落盘会话");
    console.log(`      API 列表第一项：${first.path}`);

    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;

    const pageErrors = [];
    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const e = msg.params.entry;
        if (/favicon\.ico/.test(String(e.url || "") + " " + String(e.text || ""))) return;
        pageErrors.push(e.url ? `${e.text} (${e.url})` : e.text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");

    // ---- N0 页面就绪 ----
    const ready = await waitFor(cdp, `(() => { const v = ${READY}; return (v.input && v.version && v.version !== '—') ? v : null; })()`, 25000);
    check("N0 桥就绪 + 页面可交互（version 已回填）", !!ready, ready ? `pi=${ready.version} state=${ready.state}` : "25s 未就绪");
    if (!ready) throw new Error("页面未就绪，后续断言无意义");
    await sleep(700);

    // ---- N1 打开列表第一项真实会话 ----
    // 分组默认收起（B8 刻意行为）→ 先展开它所在的板块/分组，再点那一行
    const revealed = await waitFor(cdp, `(() => !!document.querySelector('[data-role="group-row"]'))()`, 15000);
    if (!revealed) throw new Error("15s 内左侧列表没有渲染出任何分组行");
    // Q3：origin=agent 的会话被上提到「AGENT 会话」板块；其余留在 cwd 分组
    const targetDir = first.origin === "agent" ? "__agent__" : first.groupDir;
    const expanded = await expandGroupByDir(cdp, targetDir);
    if (!expanded) throw new Error(`展开分组 ${targetDir} 失败（API 第一项 id=${first.id}）`);
    const oldPath = first.path;
    const oldLines = countLines(oldPath);
    const opened = await clickSessionRow(cdp, first.id);
    const pageOpened = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return (s.entryCount > 0 && s.meta) ? s : null; })()`, 25000);
    // 两段式：等接管结束（attached / failed），避免与后台 switch_session 抢 pi
    const settled = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return (s.attach === 'attached' || s.attach === 'failed') ? s : null; })()`, 40000);
    openedSessionId = pageOpened?.currentId ?? null;
    check(
      "N1 打开真实会话：#log 有条目 + #session-meta 非空",
      opened.hit === true && !!pageOpened && pageOpened.entryCount > 0 && pageOpened.meta.length > 0,
      `点中=${opened.hit} · 条目 ${pageOpened?.entryCount} · meta「${pageOpened?.meta}」· 接管=${settled?.attach ?? "超时"} · sessionId=${openedSessionId}`,
    );
    {
      // UI 第一行 = API 第一项（同一个数据源）；对不上就直接失败，避免拿错文件当「旧会话」
      const same = openedSessionId === first.id;
      check("N1b 打开的就是 /api/sessions 的第一项", same,
        same ? `id=${first.id}` : `UI=${openedSessionId} / API=${first.id} / row=${oldPath}`);
      if (!same) throw new Error(`打开的不是列表第一项：UI=${openedSessionId} / API=${first.id}`);
    }

    // ---- N2 点 #new-session + 在弹层里选目录：对话区清空、meta 立即显示新项目 ----
    const newBtn = await evaluate(cdp, `(() => {
      const b = document.getElementById('new-session');
      const p = document.getElementById('open-palette');
      if (!b) return null;
      return {
        text: b.textContent.trim(),
        beforePalette: !!p && (b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        prev: b.previousElementSibling?.id || b.previousElementSibling?.tagName || null,
        next: b.nextElementSibling?.id || b.nextElementSibling?.tagName || null,
        disabled: b.disabled,
      };
    })()`);
    // A1：点「新会话」先弹「选择项目」层 → 选当前列所在目录（= 引擎当前 cwd，不触发 cwd 切换/引擎重启）→ 确认
    const curCwd = (await evaluate(cdp, `(() => (document.getElementById('ws-path')?.title || '').trim())()`)) || REPO_ROOT;
    const clickNew = await newSessionInDir(cdp, curCwd);
    if (!clickNew.gone) throw new Error(`选目录弹层未关闭（picker=${clickNew.picker} confirm=${clickNew.confirm}）`);
    const afterNew = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.hasWelcomeNew ? s : null; })()`, 15000);
    check("N2 头部 #new-session（文字「新会话」，在 #open-palette 之前）",
      newBtn?.text === "新会话" && newBtn?.beforePalette === true && newBtn?.disabled === false,
      newBtn ? `text=${newBtn.text} · 位于 #open-palette 之前=${newBtn.beforePalette} · pre=${newBtn.prev} / next=${newBtn.next}` : "按钮不存在");
    check(
      "N2b 点击 + 确认目录后：对话区只剩 welcome / #session-meta 显示新项目 / #session-bar 可见 / stats 隐藏",
      clickNew.hit === true && !!afterNew && afterNew.logKids === 1 && afterNew.hasWelcomeNew &&
        /^新会话/.test(afterNew.meta) && afterNew.barHidden === false && afterNew.statsHidden === true &&
        afterNew.currentId === null && afterNew.notice.includes("已新建会话"),
      `点中=${clickNew.hit} · children=${afterNew?.logKids} · welcome=${afterNew?.hasWelcomeNew} · meta「${afterNew?.meta}」 · barHidden=${afterNew?.barHidden} · statsHidden=${afterNew?.statsHidden} · currentId=${afterNew?.currentId} · notice「${afterNew?.notice}」`,
    );
    await shot(cdp, SHOT_MAIN);

    // ---- N3 键入 + Ctrl+Enter → 回复出现（≤3s 首字）→ 产生新的会话文件 ----
    await clickElement(cdp, "#input");
    await cdp.send("Input.insertText", { text: PROMPT_MARK });
    const tSend = Date.now();
    await pressCtrlEnter(cdp);
    let firstMs = -1;
    for (let i = 0; i < 40; i++) {
      const len = await evaluate(cdp, `(${PAGE_STATE}).assistantLen`).catch(() => 0);
      if (len > 0) { firstMs = Date.now() - tSend; break; }
      await sleep(100);
    }
    const roundMs = await waitRoundEnd(cdp);
    const stateAfterRound = await evaluate(cdp, PAGE_STATE);

    // 列表最新一条（按 updatedAt 倒序）必须是一个新文件，且不属于打开前快照
    let newest = null;
    for (let i = 0; i < 40 && !newest; i++) {
      const { flat } = await getSessions();
      const sorted = flat.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const top = sorted[0];
      if (top && top.id !== first.id && !filesBefore.has(top.path) && fs.existsSync(top.path)) newest = top;
      else await sleep(250);
    }
    createdSession = newest ?? null;
    const newLines = newest ? countLines(newest.path) : 0;
    check(
      "N3 键入 Ctrl+Enter：回复首字 ≤3s，且 /api/sessions 出现**新的** sessionId（≠ N1）",
      firstMs >= 0 && firstMs <= 3000 && !!newest && newest.id !== openedSessionId &&
        newest.id !== first.id && stateAfterRound.state === "idle" && newLines > 0,
      `首字 ${firstMs}ms · 整轮 ${roundMs}ms · 新 sessionId=${newest?.id} · 旧=${first.id} · 新文件行数=${newLines} · 文件=${newest?.path}`,
    );

    // ---- N4 旧会话文件条目数未变 ----
    const oldLinesAfter = countLines(oldPath);
    check("N4 旧会话文件条目数未变（打开前后对比真实 .jsonl 行数）", oldLines === oldLinesAfter,
      `打开前 ${oldLines} 行 → 发送后 ${oldLinesAfter} 行`);

    // ---- N5 图片 label == 「图片」，全页不含 {type: ----
    const labels = await evaluate(cdp, `(() => {
      const ls = [...document.querySelectorAll('#attach-buttons .file-label')];
      return {
        list: ls.map((l) => l.textContent.trim()),
        bodyHasTypeImage: document.body.innerText.includes('{type:'),
        diffBtn: !!document.getElementById('open-diff'),
      };
    })()`);
    check(
      "N5 附件区图片 label 文本 == 「图片」，且 body.innerText 不含 `{type:`",
      labels.list[0] === "图片" && labels.bodyHasTypeImage === false,
      `labels=${JSON.stringify(labels.list)} · body 含 {type: = ${labels.bodyHasTypeImage}`,
    );

    // ---- N6 streaming 中点 #new-session 被拒绝，且对话区未被清空 ----
    const LONG = "请用不少于 800 字详细讲解秦汉时期的政治制度，分点展开，不要提前结束。";
    let conflict = null;
    for (let attempt = 1; attempt <= 2 && !conflict; attempt++) {
      await clickElement(cdp, "#input");
      await cdp.send("Input.insertText", { text: LONG });
      await pressCtrlEnter(cdp);
      const streaming = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.state === 'streaming' ? s : null; })()`, 20000);
      if (!streaming) continue;
      const kidsBefore = streaming.logKids;
      const clickConflict = await clickElement(cdp, "#new-session");
      const noticeOk = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.notice.includes('正在运行中') ? s : null; })()`, 3000);
      const kidsAfter = await evaluate(cdp, `(${PAGE_STATE}).logKids`);
      conflict = { click: clickConflict, notice: noticeOk, kidsBefore, kidsAfter, streaming: true };
    }
    await shot(cdp, SHOT_CONFLICT);
    check(
      "N6 streaming 中点 #new-session → 提示「正在运行中」且对话区未被清空",
      !!conflict && conflict.click.hit === true && !!conflict.notice &&
        conflict.kidsAfter === conflict.kidsBefore && conflict.kidsBefore > 1,
      conflict
        ? `点中=${conflict.click.hit} · notice「${conflict.notice?.notice}」 · 对话区 children ${conflict.kidsBefore} → ${conflict.kidsAfter}`
        : "20s 内没观察到 streaming（无法验证拒绝路径）",
    );

    // 收尾：中止长任务，等 pi 回到 idle
    await fetch(`${BASE}/api/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.state === 'idle' ? s : null; })()`, 20000);

    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("N6b 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0,
      realErrors.length ? realErrors.slice(0, 3).join(" | ") : "无");
  } finally {
    try { cdp?.close(); } catch {}
    try { edge?.kill("SIGKILL"); } catch {}
    try { bridge?.kill("SIGTERM"); } catch {}
    await sleep(1500);
    if (health?.pi?.pid) { try { process.kill(health.pi.pid, "SIGKILL"); } catch {} }
    await sleep(500);

    // N7 收尾：端口已释放、pi 子进程已退出
    let portFree = false;
    try {
      await fetch(`${BASE}/api/health`, { cache: "no-store" });
    } catch {
      portFree = true;
    }
    let piGone = true;
    if (health?.pi?.pid) {
      try { process.kill(health.pi.pid, 0); piGone = false; } catch { piGone = true; }
    }
    check("N7 收尾：端口已释放、pi 子进程不残留", portFree && piGone,
      `port ${PORT} free=${portFree} · pi pid ${health?.pi?.pid} gone=${piGone}`);

    // 只删本脚本新建的会话文件（真实 agent 目录里不留测试垃圾），既有会话一律不动。
    // 安全阀：只删「打开前不存在」且**含本脚本 prompt 原文**的文件——同时刻别的 pi 实例
    // 新建的会话不会含该标记，绝不能被误删。
    const candidates = new Set(listSessionFiles(SESSIONS_DIR).filter((p) => !filesBefore.has(p)));
    if (createdSession?.path && !filesBefore.has(createdSession.path)) candidates.add(createdSession.path);
    const created = [];
    for (const p of candidates) {
      let text = "";
      try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (text.includes(PROMPT_MARK)) created.push(p);
    }
    for (const p of created) {
      try { await fsp.rm(p, { force: true }); } catch {}
    }
    if (created.length) console.log(`      已清理本脚本新建的会话文件 ${created.length} 个（既有会话未动）`);
    await fsp.rm(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true }).catch(() => {});
    console.log(`      日志：${LOG_FILE}`);
    console.log(`      截图：${SHOT_MAIN}\n            ${SHOT_CONFLICT}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
