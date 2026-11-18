#!/usr/bin/env node
// 「streaming 中点另一条会话 → 静默中止」修复的 E2E（零第三方依赖，CDP 真实鼠标/键盘）
//
// 缺陷（负责人实测，端口 7824 / 7826）：桥只有一个 pi 子进程、一个当前会话。
// 用户在 A 点了长任务（streaming），再点左侧会话 B：POST /api/session/open 返回 200，
// 桥日志 `pi_state from=streaming to=idle ... aborted=true` —— A 的回答被静默中止，
// 已生成的部分留在 A 的 .jsonl 里，但用户没被提示一句。
//
// 本脚本走用户路径取证（全程真实点击，不调 window.__piShell.openSessionPath）：
//   S0 桥就绪 + 页面可交互（version 已回填）
//   S1 用 #new-session + 选目录 + 短消息造会话 A（脚本自己新建，收尾可安全删除）
//   S2 同样造会话 B（两条都是真实会话：真实 pi、真实落盘 .jsonl）
//   S3 点 A 行（state=idle）→ 不弹框、直接切到 A，记录对话区基线
//   S4 A 里发长任务 → state=streaming 且出现首字（60s；抖动容许重试一次）
//   S5 真实点击 B 行 → 出现确认框（#modal 可见 + 文案含「会中止」），且 state 仍 streaming、
//      A 的对话区条数未变（没被清空）
//   S6 点「取消」→ 模态消失、仍在 A（sessionId 未变）、still streaming、对话区条数仍不变
//   S7 再点 B → 按 Esc（键盘取消路径）→ 模态消失、仍在 A
//   S8 再点 B → 点「继续」→ 切到 B（sessionId 变化），A 被 abort（state 回 idle）
//   S9 收尾：停桥、端口释放、pi 子进程不残留、只删本脚本新建的会话文件
// 截图存 <tmp>/pi-shell-switch-confirm/switch-confirm.png
//
// 口径：A/B 都由本脚本新建（#new-session + 短消息，新会话必须发一条消息才落盘 → H-5），
// 因此**不会**污染任何既有会话；收尾按「本次新出现的文件 + 含本脚本 prompt 原文」双条件删除。
//
// 用法：node scripts/evidence/switch-confirm-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7825;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-switch-confirm");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_MODAL = path.join(OUT_DIR, "switch-confirm.png");
// 真实 agent 目录（不隔离）：本脚本要跑真 pi、真落盘
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本脚本用到的 prompt 原文：既是「长任务」，也是收尾识别「本脚本新建的会话文件」的安全阀。
const SHORT_A = "只回答两个字：收到（脚本A）";
const SHORT_B = "只回答两个字：收到（脚本B）";
const LONG_PROMPT = "请写一篇 2000 字的文章，题目《长江航运史话》，不要使用任何工具，直接输出正文。";
const MARKERS = [SHORT_A, SHORT_B, LONG_PROMPT];
const CONFIRM_TEXT = "当前回答正在生成，切换会话会中止它（这一轮未落盘的部分不会保留）。继续？";

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

async function postJson(pathname, body = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

// ---------- Edge + CDP（同 first-load / composer-e2e / new-session-ui 口径）----------

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

async function waitFor(cdp, expr, ms = 20000, interval = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await evaluate(cdp, expr).catch(() => null);
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

// 页面快照：本脚本全部断言都从这里取（modal 用 computedStyle，不看 hidden 属性）
const PAGE = `(() => {
  const modal = document.getElementById('modal');
  const cs = modal ? getComputedStyle(modal) : null;
  const entries = document.querySelector('#log [data-role="entries"]');
  const live = document.querySelector('#log [data-role="live"]');
  const log = document.getElementById('log');
  return {
    state: document.getElementById('state')?.dataset.state || '',
    sessionId: window.__piShell?.currentSessionId ?? null,
    attach: window.__piShell?.attachState ?? null,
    meta: (document.getElementById('session-meta')?.textContent || '').trim(),
    modalHidden: modal ? modal.hidden === true : true,
    modalDisplay: cs ? cs.display : 'none',
    modalText: (modal?.textContent || '').trim(),
    hasConfirmBox: !!document.querySelector('#modal [data-role="confirm-box"]'),
    hasCancelBtn: !!document.querySelector('#modal [data-role="confirm-cancel"]'),
    hasContinueBtn: !!document.querySelector('#modal [data-role="confirm-continue"]'),
    entryCount: entries ? entries.children.length : 0,
    liveCount: live ? live.children.length : 0,
    logChildren: log ? log.children.length : 0,
    assistantLen: [...document.querySelectorAll('#log .msg-assistant .msg-body, #log .entry-assistant .text-block')].map(b => b.textContent).join('').trim().length,
    firstEntryText: (entries?.firstElementChild?.textContent || '').slice(0, 40),
    notice: (document.getElementById('notice')?.textContent || '').trim(),
  };
})()`;

async function snapshot(cdp) {
  return evaluate(cdp, PAGE);
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

const rowSelector = (id) => `[data-role="session-row"][data-session-id="${id}"]`;

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
 * B8 后左侧分组**默认收起**（产品刻意行为：打开页面不自动展开，见 list.js load()）。
 * 会话行只有在其分组展开后才会渲染，所以「点某条会话」必须先展开它所在的分组。
 * 虚拟列表只有可视行在 DOM → 找不到组头时逐屏向下滚。
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

/** 会话 id → 所属分组 dir（Q3：origin=agent 的会话被上提到「AGENT 会话」板块） */
async function groupDirOf(id) {
  const { flat } = await getSessions();
  const hit = flat.find((s) => s.id === id);
  if (!hit) return null;
  return hit.origin === "agent" ? "__agent__" : hit.groupDir;
}

async function clickRow(cdp, id) {
  const dir = await groupDirOf(id);
  if (dir) {
    const open = await expandGroupByDir(cdp, dir);
    if (!open) return { hit: false, error: `group ${dir} not expandable` };
  }
  // 会话列表是虚拟化的：先把滚动条归零，逐屏找目标行
  await evaluate(cdp, `(() => {
    const vp = document.querySelector('[data-role="list-viewport"]');
    if (vp) vp.scrollTop = 0;
    return true;
  })()`).catch(() => {});
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    found = await evaluate(cdp, `!!document.querySelector(${JSON.stringify(rowSelector(id))})`).catch(() => false);
    if (found) break;
    await evaluate(cdp, `(() => {
      const vp = document.querySelector('[data-role="list-viewport"]');
      if (vp) vp.scrollTop = Math.min(vp.scrollTop + Math.round(vp.clientHeight * 0.8), vp.scrollHeight);
      return true;
    })()`).catch(() => {});
    await sleep(200);
  }
  if (!found) return { hit: false, error: "row not rendered" };
  return clickElement(cdp, rowSelector(id));
}

// 发送快捷键：第五批起 Enter = 换行，发送改为 Ctrl+Enter（modifiers: 2）
async function pressCtrlEnter(cdp) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2, text: "\r", unmodifiedText: "\r" };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 });
}

async function pressEscape(cdp) {
  const base = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function typePrompt(cdp, text) {
  await clickElement(cdp, "#input");
  await cdp.send("Input.insertText", { text });
  await pressCtrlEnter(cdp);
}

async function shot(cdp, file) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(s.data, "base64"));
  return file;
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");
  if (!fs.existsSync(SESSIONS_DIR)) throw new Error(`真实会话目录不存在：${SESSIONS_DIR}`);

  await assertPortFree();
  // 快照：收尾只删「本次新出现」且含本脚本 prompt 原文的文件，既有会话一律不动
  const filesBefore = new Set(listSessionFiles(SESSIONS_DIR));

  let bridge = null;
  let edge = null;
  let cdp = null;
  let health = null;
  const created = { a: null, b: null };
  let retriedFirstToken = false;

  try {
    bridge = startBridge();
    health = await waitHealth();
    if (!health) throw new Error(`桥未在 40s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid} · cwd ${health.pi.cwd}`);

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

    // ---- S0 ----
    const ready = await waitFor(cdp, `(() => { const v = ${READY}; return (v.input && v.version && v.version !== '—') ? v : null; })()`, 25000);
    check("S0 桥就绪 + 页面可交互（version 已回填）", !!ready, ready ? `pi=${ready.version} state=${ready.state}` : "25s 未就绪");
    if (!ready) throw new Error("页面未就绪，后续断言无意义");
    await sleep(700);

    // ---- S1/S2 用 #new-session 造两条真实会话（脚本自建，收尾可安全删除）----
    // 注意：新会话在发第一条消息前没有 id（H-5），页面上的 currentSessionId 也保持 null，
    // 所以「这条会话是 A 还是 B」只能靠文件内容里的 marker 认领，再由 /api/sessions 映射成 id。
    const claimSession = async (mark, label, exclude) => {
      for (let i = 0; i < 60; i++) {
        const fresh = listSessionFiles(SESSIONS_DIR).filter((p) => !filesBefore.has(p) && p !== exclude);
        const mine = fresh.find((p) => {
          try { return fs.readFileSync(p, "utf8").includes(mark); } catch { return false; }
        });
        if (mine) {
          const { flat } = await getSessions();
          const norm = (p) => path.resolve(p).toLowerCase();
          const hit = flat.find((s) => norm(s.path) === norm(mine));
          if (hit) return { id: hit.id, path: hit.path };
        }
        await sleep(250);
      }
      throw new Error(`${label}：15s 内没认领到会话文件（marker 未落盘）`);
    };

    const makeSession = async (mark, label, exclude) => {
      // 先给现存 welcome 节点打标：newSession 是 async POST，光看「sessionId===null」会抢在
      // POST 返回前就发送，导致消息落到上一条会话里（第一版脚本就栽在这）。
      await evaluate(cdp, `(() => {
        document.querySelectorAll('#log [data-role="welcome-new"]').forEach((n) => (n.dataset.old = '1'));
        return true;
      })()`);
      // A1：点完还要在弹层里选目录并确认。选桥自己的 cwd（health.pi.cwd）= 不切 cwd，
      // 与 A1 之前行为等价（本脚本验的是切换确认框，不是切 cwd）。
      const clickNew = await newSessionInDir(cdp, (health && health.pi && health.pi.cwd) || REPO_ROOT);
      if (!clickNew.gone) throw new Error(`${label}：选目录弹层未关闭（picker=${clickNew.picker} confirm=${clickNew.confirm}）`);
      const blank = await waitFor(cdp, `(() => {
        const fresh = document.querySelector('#log [data-role="welcome-new"]:not([data-old="1"])');
        const s = ${PAGE};
        return (fresh && s.state === 'idle' && s.meta.indexOf('新会话') === 0 && s.entryCount === 0) ? s : null;
      })()`, 20000);
      if (!blank) throw new Error(`${label}：#new-session 后 20s 内未出现新的空会话页`);
      await typePrompt(cdp, mark);
      const done = await waitFor(cdp, `(() => { const s = ${PAGE}; return (s.state === 'idle' && s.assistantLen > 0) ? s : null; })()`, 120000);
      if (!done) throw new Error(`${label}：短消息一轮没跑完（120s）`);
      const claimed = await claimSession(mark, label, exclude);
      return { ...claimed, clickHit: clickNew.hit === true };
    };

    created.a = await makeSession(SHORT_A, "建会话 A", null);
    check("S1 #new-session + 短消息 → 会话 A 落盘并出现在 /api/sessions",
      !!created.a.id && fs.existsSync(created.a.path),
      `id=${created.a.id} · ${created.a.path}`);

    created.b = await makeSession(SHORT_B, "建会话 B", created.a.path);
    check("S2 同样造出会话 B（与 A 不同）",
      !!created.b.id && created.b.id !== created.a.id && fs.existsSync(created.b.path),
      `A=${created.a.id} · B=${created.b.id}`);

    // ---- S3 点 A 行（idle）→ 不该弹框，直接切到 A ----
    const clickA = await clickRow(cdp, created.a.id);
    const atA = await waitFor(cdp, `(() => { const s = ${PAGE}; return (s.sessionId === ${JSON.stringify(created.a.id)} && s.attach === 'attached' && s.entryCount > 0) ? s : null; })()`, 40000);
    check("S3 点 A 行（state=idle）→ 不弹框、直接打开 A",
      clickA.hit === true && !!atA && atA.modalHidden === true,
      `点中=${clickA.hit} · 模态=${atA?.modalHidden ? "未出现" : "意外出现"} · 条目 ${atA?.entryCount} · attach=${atA?.attach}`);
    if (!atA) throw new Error("S3 没打开成功，后续无意义");
    const baseline = { entryCount: atA.entryCount, liveCount: atA.liveCount, logChildren: atA.logChildren, firstEntryText: atA.firstEntryText, id: atA.sessionId };
    // ---- S4 A 里发长任务 → streaming + 首字 ----
    let streaming = null;
    for (let attempt = 1; attempt <= 2 && !streaming; attempt++) {
      await typePrompt(cdp, LONG_PROMPT);
      const t0 = Date.now();
      streaming = await waitFor(cdp, `(() => { const s = ${PAGE}; return (s.state === 'streaming' && s.assistantLen > 0) ? s : null; })()`, 60000, 200);
      if (streaming) streaming.firstMs = Date.now() - t0;
      else {
        // 首字抖动：abort 掉残局再重试一次（60s 口径）
        await postJson("/api/abort").catch(() => {});
        await waitFor(cdp, `(() => { const s = ${PAGE}; return s.state === 'idle' ? s : null; })()`, 20000);
        retriedFirstToken = attempt === 1;
      }
    }
    check("S4 A 里发长任务 → state=streaming 且出现首字（≤60s，抖动允许重试 1 次）",
      !!streaming,
      streaming ? `首字 ${streaming.firstMs}ms${retriedFirstToken ? " · 重试 1 次" : ""} · 已生成 ${streaming.assistantLen} 字` : "两次 60s 都没等到首字");
    if (!streaming) throw new Error("拿不到 streaming，无法验证切换守卫");
    // S5 的对比基线 = 「正在跑的时候」的快照（此刻 #log 里已多出 live 容器，不能拿打开时的基线比）
    const whileStreaming = {
      entryCount: streaming.entryCount,
      logChildren: streaming.logChildren,
      liveCount: streaming.liveCount,
      assistantLen: streaming.assistantLen,
      firstEntryText: streaming.firstEntryText,
    };

    // ---- S5 真实点击 B → 必须出现确认框，且 A 未被清空、仍在 streaming ----
    const clickB1 = await clickRow(cdp, created.b.id);
    const modalUp = await waitFor(cdp, `(() => { const s = ${PAGE}; return (!s.modalHidden && s.modalDisplay !== 'none') ? s : null; })()`, 5000);
    await shot(cdp, SHOT_MODAL);
    const afterB1 = await snapshot(cdp);
    // 流式期间 delta 会持续追加，所以不能把「字数不变」当口径；「未被清空」= 会话未变 +
    // 已落盘条目数与容器结构未变 + 已生成字数不减少 + 首条既有消息文本未变。
    const notCleared = afterB1.entryCount === whileStreaming.entryCount &&
      afterB1.logChildren === whileStreaming.logChildren &&
      (afterB1.assistantLen ?? 0) >= (whileStreaming.assistantLen ?? 0) &&
      afterB1.firstEntryText === whileStreaming.firstEntryText;
    check("S5 点 B → 出现确认框（#modal 可见 + 文案含「会中止」），state 仍 streaming",
      clickB1.hit === true && !!modalUp && modalUp.modalText.includes("会中止") && modalUp.hasCancelBtn && modalUp.hasContinueBtn &&
        afterB1.state === "streaming" && afterB1.hasConfirmBox === true,
      `点中=${clickB1.hit} · 文案「${afterB1.modalText}」· state=${afterB1.state} · 取消钮=${afterB1.hasCancelBtn} · 继续钮=${afterB1.hasContinueBtn}`);
    check("S5b 确认框出现期间 A 的对话区未被清空（会话/条目数/容器结构/已生成字数不回退）",
      notCleared && afterB1.sessionId === baseline.id,
      `sessionId=${afterB1.sessionId} · entries ${whileStreaming.entryCount}→${afterB1.entryCount} · children ${whileStreaming.logChildren}→${afterB1.logChildren} · live ${whileStreaming.liveCount}→${afterB1.liveCount}（仅参考）· 已生成 ${whileStreaming.assistantLen}→${afterB1.assistantLen} 字`);

    // ---- S6 点「取消」→ 模态消失、仍在 A、still streaming、渲染不变 ----
    const clickCancel = await clickElement(cdp, '[data-role="confirm-cancel"]');
    const afterCancel = await waitFor(cdp, `(() => { const s = ${PAGE}; return (s.modalHidden === true && s.sessionId === ${JSON.stringify(created.a.id)}) ? s : null; })()`, 8000);
    check("S6 点「取消」→ 模态消失、仍在 A、still streaming、A 的对话区未被改动",
      clickCancel.hit === true && !!afterCancel && afterCancel.state === "streaming" &&
        afterCancel.entryCount === whileStreaming.entryCount &&
        afterCancel.logChildren === whileStreaming.logChildren &&
        afterCancel.assistantLen >= whileStreaming.assistantLen &&
        afterCancel.firstEntryText === whileStreaming.firstEntryText,
      `点中=${clickCancel.hit} · 模态=${afterCancel?.modalHidden ? "已消失" : "仍在"} · sessionId=${afterCancel?.sessionId} · state=${afterCancel?.state} · entries ${whileStreaming.entryCount}→${afterCancel?.entryCount} · 已生成 ${whileStreaming.assistantLen}→${afterCancel?.assistantLen} 字`);

    // ---- S7 再点 B → 按 Esc（键盘取消路径）----
    const clickB2 = await clickRow(cdp, created.b.id);
    const modalUp2 = await waitFor(cdp, `(() => { const s = ${PAGE}; return (!s.modalHidden && s.modalDisplay !== 'none') ? s : null; })()`, 5000);
    await pressEscape(cdp);
    const afterEsc = await waitFor(cdp, `(() => { const s = ${PAGE}; return (s.modalHidden === true && s.sessionId === ${JSON.stringify(created.a.id)}) ? s : null; })()`, 8000);
    check("S7 再点 B → 按 Esc → 模态消失、仍在 A 且仍在 streaming（Esc 未误触发中止）",
      clickB2.hit === true && !!modalUp2 && !!afterEsc && afterEsc.state === "streaming" && afterEsc.notice.indexOf("已中止") < 0,
      `点中=${clickB2.hit} · 模态出现=${!!modalUp2} · Esc 后 sessionId=${afterEsc?.sessionId} · state=${afterEsc?.state} · notice「${afterEsc?.notice ?? ""}」`);

    // ---- S8 再点 B → 点「继续」→ 切到 B，A 被 abort（state 回 idle）----
    const clickB3 = await clickRow(cdp, created.b.id);
    const modalUp3 = await waitFor(cdp, `(() => { const s = ${PAGE}; return (!s.modalHidden && s.modalDisplay !== 'none') ? s : null; })()`, 5000);
    const clickContinue = await clickElement(cdp, '[data-role="confirm-continue"]');
    const switched = await waitFor(cdp, `(() => { const s = ${PAGE}; return (s.sessionId === ${JSON.stringify(created.b.id)} && s.modalHidden === true) ? s : null; })()`, 30000);
    const idled = await waitFor(cdp, `(() => { const s = ${PAGE}; return (s.state === 'idle') ? s : null; })()`, 30000);
    check("S8 再点 B → 点「继续」→ 切到 B（sessionId 变化），A 被 abort（state 回 idle）",
      clickB3.hit === true && !!modalUp3 && clickContinue.hit === true && !!switched && !!idled &&
        switched.sessionId !== baseline.id,
      `点中=${clickB3.hit} · 继续钮点中=${clickContinue.hit} · sessionId ${baseline.id} → ${switched?.sessionId} · state=${idled?.state}`);

    // 收尾前把 B 的短会话留干净：不强杀，等 pi idle（S8 已 idle）
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("S9 全流程无未捕获 JS 异常 / 控制台 error",
      realErrors.length === 0, realErrors.length ? realErrors.slice(0, 3).join(" | ") : "无");
  } finally {
    try { cdp?.close(); } catch {}
    try { edge?.kill("SIGKILL"); } catch {}
    try { bridge?.kill("SIGTERM"); } catch {}
    await sleep(1500);
    if (health?.pi?.pid) { try { process.kill(health.pi.pid, "SIGKILL"); } catch {} }
    await sleep(500);

    // S9 收尾：端口已释放、pi 子进程已退出
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
    check("S10 收尾：端口已释放、pi 子进程不残留", portFree && piGone,
      `port ${PORT} free=${portFree} · pi pid ${health?.pi?.pid} gone=${piGone}`);

    // 只删「本脚本新建」的会话文件：①不在打开前快照里 ②含本脚本 prompt 原文。
    // 双条件互为安全阀：同时刻别的 pi 实例新建的会话不会含这些标记，绝不能被误删。
    const candidates = new Set(listSessionFiles(SESSIONS_DIR).filter((p) => !filesBefore.has(p)));
    if (created.a?.path && !filesBefore.has(created.a.path)) candidates.add(created.a.path);
    if (created.b?.path && !filesBefore.has(created.b.path)) candidates.add(created.b.path);
    const removed = [];
    for (const p of candidates) {
      let text = "";
      try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (MARKERS.some((m) => text.includes(m))) removed.push(p);
    }
    for (const p of removed) {
      try { await fsp.rm(p, { force: true }); } catch {}
    }
    // S8 之前唯一可能的残留：pi 在 A 的 .jsonl 里写了半截回答 —— 文件本身就在 removed 里
    const leftovers = listSessionFiles(SESSIONS_DIR).filter((p) => {
      if (filesBefore.has(p)) return false;
      try { return MARKERS.some((m) => fs.readFileSync(p, "utf8").includes(m)); } catch { return false; }
    });
    check("S11 清理：本脚本新建的会话文件已删除，既有会话未动",
      removed.length >= 2 && leftovers.length === 0,
      `删除 ${removed.length} 个（${removed.map((p) => path.basename(p)).join(", ") || "无"}）· 残留 ${leftovers.length} · 既有文件未触碰`);

    await fsp.rm(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true }).catch(() => {});
    console.log(`      日志：${LOG_FILE}`);
    console.log(`      截图：${SHOT_MODAL}`);
    if (retriedFirstToken) console.log("      备注：provider 首字抖动，S4 重试过 1 次（60s 口径）");
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
