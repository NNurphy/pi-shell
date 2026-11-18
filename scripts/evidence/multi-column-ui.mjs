#!/usr/bin/env node
// Q4 验收：同页多列并行（1–3 列，每列独立引擎 / 会话 / 滚动 / 输入）
//
// 为什么需要这个脚本：并行能力改造前只到「一个标签页一个引擎」（parallel-ui.mjs 用两个标签页取证）。
// Q4 把列作为引擎归属单位（clientId = 标签页标识 + #cN），同一个标签页里两列可以同时 streaming。
// 本脚本用真实 CDP 鼠标/键盘走用户路径，取证：
//   P1  桥就绪（夹具 sessions / PI_SHELL_MAX_ENGINES=4）+ 页面 1 列
//   P2  点顶栏「2」→ 两列，各有独立 Composer；health.engines 里两个 clientId 两两不同
//   P3  列 1 发长任务 + 列 2 发另一条 → 两列同时 streaming（health.engines ≥2，两列文本都在增长）
//   P4  列 1 中止（Esc）不影响列 2（列 2 继续增长，仍在 streaming）
//   P5  同一会话在列 2 打开 → 409 提示；列 1 不受影响（内容/条目数不变）
//   P6  关闭列 2 → 其引擎 60–75s 后被回收（health.engines 减少）
//   P7  窄屏 900px → 只显示 1 列 + 列切换器（display 断言 + 切换生效）
//   P8  3 列可用（PI_SHELL_MAX_ENGINES=4）；第 4 列提示上限（引擎数不变）
//   P9  截图：docs/evidence/ui-multi-column.png（2 列 streaming）/ ui-multi-column-narrow.png
//   P10 收尾：停桥、杀 Edge、清夹具
//
// 用法：node scripts/evidence/multi-column-ui.mjs      （EDGE_PATH 可指定 msedge.exe）
// 环境变量：PI_SHELL_MULTI_COL_PORT（默认 7881）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_MULTI_COL_PORT || 7881);
const DEBUG_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-multi-column");
const SESSIONS = path.join(OUT_DIR, "sessions");
const WORKSPACE = path.join(REPO_ROOT, ".tmp-evidence-multi-column", "workspace");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const SHOT_DESKTOP = path.join(SHOT_DIR, "ui-multi-column.png");
const SHOT_NARROW = path.join(SHOT_DIR, "ui-multi-column-narrow.png");

// 上限刻意钉成 4（桥默认值）：3 列要 3 个引擎，第 4 列由前端列上限挡住（不再 spawn 第 4 个 pi）
const MAX_ENGINES = 4;
const SWEEP_IDLE_MS = 60000;
const RECLAIM_DEADLINE_MS = 80000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 长度按「流够长」设计（不是判据）：2000 字在百炼的 deepseek 上约 4–5s 就写完，
// 而 P3 要观测「两列同时 streaming + 文本各自增长」、P4 还要在中止后再观测 2.5s 增长——
// 回复太短时列 1 会在采样窗口里写完，判据被时序误伤（2026-11-11 门禁 P3 FAIL 即此类）。
const PROMPT_A =
  "请写一篇约 4000 字的说明文，主题：本机小型服务的可观测性。分成 20 段，每段不少于 150 字，" +
  "段落之间用空行分隔。直接输出正文，不要标题、不要列表符号。";
const PROMPT_B =
  "请写一篇约 4000 字的说明文，主题：浏览器标签页、进程与内存模型。分成 20 段，每段不少于 150 字，" +
  "段落之间用空行分隔。直接输出正文，不要标题、不要列表符号。";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具 ----------

/** 一个最小会话文件（header + user + assistant），给 P5 的「同会话 409」用 */
function writeFixtureSession() {
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const cwd = WORKSPACE.replace(/\\/g, "/");
  const dir = path.join(SESSIONS, cwd.replace(/[:/]/g, "-").replace(/^/, "--"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "q4-multi-0001.jsonl");
  const now = Date.now();
  const lines = [
    { type: "session", version: 3, id: "q4-multi-0001", timestamp: new Date(now - 60000).toISOString(), cwd },
    {
      type: "message",
      id: "m1",
      timestamp: new Date(now - 50000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "夹具：这一条用于 Q4 同会话 409 取证。" }] },
    },
    {
      type: "message",
      id: "m2",
      timestamp: new Date(now - 40000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "收到，这是夹具里的助手回复。" }] },
    },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
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

async function getHealth() {
  const res = await fetch(`${BASE}/api/health`, { cache: "no-store" });
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
  throw new Error(`等待超时（${label}，${ms}ms）engines=${JSON.stringify((last?.engines ?? []).map((e) => `${e.id}:${e.state}`))}`);
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

async function shot(cdp, file) {
  const res = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  return file;
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
  const click = await clickSelector(cdp, "#new-session");
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
    picked = await clickSelector(cdp, `#picker-list .picker-dir:nth-child(${idx})`);
  } else {
    // 列表里没有该目录 → 走「其他目录…」手输（真实键入，不注入 value）
    await clickSelector(cdp, '[data-role="picker-other"]');
    await clickSelector(cdp, '[data-role="picker-path"]');
    await cdp.send("Input.insertText", { text: dir });
    picked = { hit: true };
  }
  const confirm = await clickSelector(cdp, '[data-role="picker-confirm"]');
  const gone = await waitFor(cdp, `(() => {
    const p = document.getElementById('project-picker');
    return (p && p.hidden === true) ? true : null;
  })()`, 60000);
  return { hit: click.hit === true, picker: true, picked: picked.hit === true, confirm: confirm.hit === true, gone: !!gone };
}

async function setViewport(cdp, { width, height, mobile = false }) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  await sleep(350);
}

async function clickSelector(cdp, selector) {
  const box = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "not found" };
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      const ok = !!hit && (hit === el || el.contains(hit));
      return { x, y, ok };
    })()`,
    false,
  );
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(120);
  return { ...box, hit: true };
}

/** 列内元素选择器：第 n 列（0 基）里的第一个匹配 */
function inColumn(index, selector) {
  return `.column:nth-of-type(${index + 1}) ${selector}`;
}

/** 聚焦第 n 列的 Composer（真实点击 → 触发列激活） */
async function clickColumnInput(cdp, index) {
  return clickSelector(cdp, inColumn(index, "textarea"));
}

/** 真实键入 + Ctrl+Enter 发送（只作用于被聚焦的那一列） */
async function typeAndSend(cdp, index, text) {
  const clicked = await clickColumnInput(cdp, index);
  if (!clicked.hit) throw new Error(`列 ${index + 1} 的输入框点不中`);
  const focused = await evaluate(
    cdp,
    `(() => { const t = document.querySelectorAll('.column')[${index}]?.querySelector('textarea'); return !!t && document.activeElement === t; })()`,
    false,
  );
  if (!focused) throw new Error(`列 ${index + 1} 的输入框无法聚焦`);
  await cdp.send("Input.insertText", { text });
  await sleep(120);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2, text: "\r", unmodifiedText: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 });
  return clicked;
}

async function pressEscape(cdp) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  await sleep(250);
}

// ---------- 页面探针 ----------

const COLUMNS_INFO = `(() => [...document.querySelectorAll('.column')].map((n, i) => {
  const log = n.querySelector('.log');
  const input = n.querySelector('textarea');
  const head = n.querySelector('.col-head');
  return {
    i,
    key: n.dataset.colKey || null,
    client: n.dataset.client || null,
    hidden: !!n.hidden,
    display: getComputedStyle(n).display,
    active: n.classList.contains('is-active'),
    hasInput: !!input,
    inputValue: input ? input.value : null,
    logLen: log ? (log.innerText || '').length : 0,
    engineState: n.dataset.state || null,
    headDisplay: head ? getComputedStyle(head).display : 'none',
    headNo: n.querySelector('[data-role=col-no]')?.textContent || '',
    headTitle: n.querySelector('[data-role=col-title]')?.textContent || '',
    headModel: n.querySelector('[data-role=col-model]')?.textContent || '',
    hasClose: !!n.querySelector('[data-role=col-close]'),
    entries: n.querySelectorAll('[data-role=entries] [data-entry-id]').length,
    welcomeNew: !!n.querySelector('[data-role=welcome-new]'),
    notice: (n.querySelector('[data-role=notice]')?.textContent || '').trim(),
    noticeShown: (() => { const b = n.querySelector('[data-role=notice]'); return !!b && !b.hidden; })(),
    streamingAttrs: n.dataset.streaming || null,
  };
}))()`;

const columnsInfo = (cdp) => evaluate(cdp, COLUMNS_INFO, false);

const SWITCHER_INFO = `(() => {
  const s = document.getElementById('col-switcher');
  return {
    exists: !!s,
    display: s ? getComputedStyle(s).display : 'none',
    buttons: s ? [...s.querySelectorAll('button')].map((b) => ({ key: b.dataset.colKey, selected: b.getAttribute('aria-selected'), streaming: b.dataset.streaming })) : [],
  };
})()`;

async function waitColumns(cdp, count, ms = 20000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await columnsInfo(cdp).catch(() => null);
    if (last?.length === count) return last;
    await sleep(200);
  }
  throw new Error(`等待 ${count} 列超时（当前 ${last?.length}）`);
}

/** 某列进入「可发送」的新会话态（welcome-new 出现 = POST /api/session/new 回执到） */
async function waitNewSession(cdp, index, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await evaluate(
      cdp,
      `(() => { const n = document.querySelectorAll('.column')[${index}]; return !!n?.querySelector('[data-role=welcome-new]'); })()`,
      false,
    ).catch(() => false);
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

/** 在第 n 列点「新会话」（顶栏按钮作用于当前列 → 先聚焦该列；A1 后还需在弹层里选目录） */
async function newSessionInColumn(cdp, index) {
  await clickColumnInput(cdp, index);
  await sleep(250);
  const pick = await newSessionInDir(cdp, WORKSPACE);
  if (!pick.gone) throw new Error(`列 ${index + 1} 选目录弹层未关闭（picker=${pick.picker} confirm=${pick.confirm}）`);
  if (!(await waitNewSession(cdp, index))) {
    const info = await columnsInfo(cdp);
    throw new Error(`列 ${index + 1} 新会话未完成：hit=${pick.hit} notice=${info?.[index]?.notice} state=${info?.[index]?.engineState}`);
  }
  return pick;
}

async function waitEngineState(clientId, state, ms, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await getHealth();
    const engine = (last.engines || []).find((e) => e.id === clientId);
    if (engine?.state === state) return last;
    await sleep(250);
  }
  throw new Error(`等待 ${label} = ${state} 超时（${ms}ms）`);
}

async function waitGrow(cdp, index, baseline, ms, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = (await columnsInfo(cdp))[index];
    if (last && last.logLen > baseline + 20) return last;
    await sleep(250);
  }
  throw new Error(`等待 ${label} 文本增长超时（${ms}ms）baseline=${baseline} now=${last?.logLen}`);
}

/**
 * P3 取证：找一对「同步采样点」——两次采样时两列都在 streaming，且两次之间两列文本都严格增长。
 *
 * 判据没有放宽（仍然是「两列同时 streaming + 两列文本各自增长」），只是把「取一次固定 2.5s 窗口」
 * 换成「一路连续采样再挑出满足条件的一对」：固定窗口要么撞上某列已经写完（logLen 不再增长 →
 * 被误判成没同时 streaming），要么撞上采样点之间的抖动；连续采样不依赖运气。
 * 每一对采样点的 health 与页面列文本相距只有几毫秒，仍然构成「同一时刻」的证据；
 * 配对要求相隔 ≥1s，避免把 400ms 内的抖动当成「文本在增长」。
 */
async function watchBothStreaming(cdp, deadlineMs = 25000, interval = 400, minSpan = 1000) {
  const t0 = Date.now();
  const history = []; // 最近的采样点（保留 ~8s，够找到 minSpan 之前的那个）
  let seen = { states: [], from: [], to: [], dt: 0 }; // 失败时回报最近一对，便于定位
  while (Date.now() - t0 < deadlineMs) {
    const health = await getHealth().catch(() => null);
    const cols = await columnsInfo(cdp).catch(() => null);
    if (health && cols && cols.length >= 2) {
      const engines = health.engines || [];
      const now = {
        at: Date.now(),
        states: cols.slice(0, 2).map((c) => engines.find((e) => e.id === c.client)?.state ?? null),
        len: cols.slice(0, 2).map((c) => c.logLen),
      };
      // 跟「至少 minSpan 之前」的采样点配对：窗口够长，增长不是抖动
      const base = history.find((s) => now.at - s.at >= minSpan);
      if (base) {
        const bothStreaming = now.states.every((s) => s === "streaming") && base.states.every((s) => s === "streaming");
        const bothGrew = now.len.every((n, i) => n > base.len[i]);
        seen = { states: [...base.states, ...now.states], from: base.len, to: now.len, dt: now.at - base.at };
        if (bothStreaming && bothGrew) return { ok: true, ...seen };
      }
      history.push(now);
      while (history.length > 1 && now.at - history[0].at > 8000) history.shift();
    }
    await sleep(interval);
  }
  return { ok: false, ...seen };
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(path.dirname(WORKSPACE), { recursive: true, force: true });
  const fixture = writeFixtureSession().replace(/\\/g, "/");

  // 端口必须独占（绝不打断用户真实实例）
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  let edge = null;
  let cdp = null;

  try {
    const health0 = await waitHealth((h) => h?.pi?.state === "idle", 45000, "bridge idle");
    check("P1a 桥就绪（夹具 sessions · PI_SHELL_MAX_ENGINES=4）", health0.maxEngines === MAX_ENGINES && health0.engineCount === 1, `engines=${health0.engineCount} max=${health0.maxEngines} pi=${health0.pi.version}`);

    edge = spawn(
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
    for (let i = 0; i < 120 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch {}
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("Edge CDP 未就绪");

    cdp = cdpConnect(target.webSocketDebuggerUrl);
    await cdp.ready;
    const pageErrors = [];
    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
      if (msg.method === "Inspector.targetCrashed") pageErrors.push("targetCrashed");
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const e = msg.params.entry;
        if (!/favicon\.ico/.test(String(e.url || "") + " " + String(e.text || ""))) pageErrors.push(e.text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Inspector.enable").catch(() => {});
    await setViewport(cdp, { width: 1440, height: 900 });

    // 页面就绪：主界面在 + 版本回填（= 已认领到自己的引擎）
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      ready = await evaluate(
        cdp,
        `(() => !!document.getElementById('input') && (document.getElementById('version')?.textContent || '—') !== '—' && !!window.__piShell)()`,
        false,
      ).catch(() => false);
      if (!ready) await sleep(200);
    }
    if (!ready) throw new Error("页面未在 30s 内就绪");
    const base = await columnsInfo(cdp);
    check("P1b 页面就绪：默认 1 列 + 1 个引擎", base.length === 1 && base[0].hasInput, `columns=${base.length} client=${String(base[0].client).slice(-3)}…`);

    // ================= P2 分栏 → 2 列 =================
    const clickSplit2 = await clickSelector(cdp, '#split-control [data-split="2"]');
    const cols2 = await waitColumns(cdp, 2);
    const h2 = await waitHealth((h) => (h.engines || []).length >= 2, 40000, "2 engines");
    const ids = (h2.engines || []).map((e) => e.id);
    const pageClients = cols2.map((c) => c.client);
    check(
      "P2 点「2」→ 两列 + 两个不同 clientId 的引擎",
      clickSplit2.hit === true && cols2.length === 2 && ids.length >= 2 && new Set(ids).size === ids.length && new Set(pageClients).size === 2,
      `columns=${cols2.length} clients=${pageClients.map((c) => String(c).slice(-4)).join(",")} engines=${ids.map((i) => String(i).slice(-4)).join(",")}`,
    );
    check(
      "P2b 两列各有独立 Composer（不同 textarea 元素，输入互不影响）",
      cols2[0].hasInput && cols2[1].hasInput &&
        (await evaluate(
          cdp,
          `(() => {
            const t = [...document.querySelectorAll('.column textarea')];
            if (t.length !== 2 || t[0] === t[1]) return false;
            t[0].value = 'COL1-ONLY';
            const ok = t[1].value === '';
            t[0].value = '';
            return ok;
          })()`,
          false,
        )) === true,
      `inputs=${cols2.filter((c) => c.hasInput).length}`,
    );
    check(
      "P2c 列头显示序号 + 标题 + 模型 + 关闭（多列时才出现）",
      cols2[0].headDisplay !== "none" && cols2[1].headDisplay !== "none" &&
        cols2.map((c) => c.headNo).join("/") === "01/02" && cols2.every((c) => c.hasClose) && cols2.every((c) => !!c.headModel),
      `head=${cols2.map((c) => `${c.headNo}:${c.headTitle}:${c.headModel}`).join(" | ")}`,
    );

    // ================= P3 两列同时 streaming =================
    await newSessionInColumn(cdp, 0);
    await newSessionInColumn(cdp, 1);

    const clientA = (await columnsInfo(cdp))[0].client;
    const clientB = (await columnsInfo(cdp))[1].client;
    const beforeA = (await columnsInfo(cdp))[0].logLen;
    await typeAndSend(cdp, 0, PROMPT_A);
    await waitEngineState(clientA, "streaming", 40000, "列 1");
    await waitGrow(cdp, 0, beforeA, 60000, "列 1 首字");

    const beforeB = (await columnsInfo(cdp))[1].logLen;
    await typeAndSend(cdp, 1, PROMPT_B);
    await waitEngineState(clientB, "streaming", 40000, "列 2");
    await waitGrow(cdp, 1, beforeB, 60000, "列 2 首字");

    // 两列都在出字了：从这一刻开始连续采样，挑一对「两列都 streaming 且两列都在长」的采样点
    const both = await watchBothStreaming(cdp, 25000);
    check(
      "P3 两列同时 streaming（health.engines ≥2 且两列文本各自增长）",
      both.ok,
      both.ok
        ? `A ${both.from[0]}→${both.to[0]} · B ${both.from[1]}→${both.to[1]} · 采样间隔=${both.dt}ms · states=${both.states.join(",")} · clients=${clientA.slice(-4)},${clientB.slice(-4)}`
        : `未取到「两列同时 streaming 且都在增长」的采样对（最近一对 states=${both.states.join(",")} · A ${both.from[0] ?? "?"}→${both.to[0] ?? "?"} · B ${both.from[1] ?? "?"}→${both.to[1] ?? "?"} · dt=${both.dt}ms）`,
    );

    const desktopShot = await shot(cdp, SHOT_DESKTOP);
    check("P9a 截图：2 列同时 streaming（docs/evidence/ui-multi-column.png）", fs.existsSync(desktopShot) && fs.statSync(desktopShot).size > 0, desktopShot);

    // ================= P4 列 1 中止，不影响列 2 =================
    await clickColumnInput(cdp, 0);
    await sleep(150);
    await pressEscape(cdp);
    await waitEngineState(clientA, "idle", 25000, "列 1 中止后");
    const bDuring = (await columnsInfo(cdp))[1].logLen;
    const hAfterAbort = await getHealth();
    const bEngine = (hAfterAbort.engines || []).find((e) => e.id === clientB);
    await sleep(2500);
    const bGrow = (await columnsInfo(cdp))[1];
    const hAfterGrow = await getHealth();
    const bEngine2 = (hAfterGrow.engines || []).find((e) => e.id === clientB);
    check(
      "P4 列 1 中止不影响列 2（列 2 继续增长且仍在 streaming）",
      bGrow.logLen > bDuring && bEngine2?.state === "streaming" && bEngine?.state === "streaming",
      `B ${bDuring}→${bGrow.logLen} · B.state=${bEngine?.state}→${bEngine2?.state} · A.state=idle`,
    );

    // ================= P5 同会话在列 2 打开 → 409 =================
    await clickColumnInput(cdp, 1); // 先切到列 2（列 1 打开夹具会话时列 2 要是活动列）
    await sleep(200);
    // 列 1 打开夹具会话（列 2 保持自己的会话/内容）
    await clickColumnInput(cdp, 0);
    await sleep(200);
    const open1 = await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(fixture)})`, true);
    await sleep(600);
    const col1AfterOpen = (await columnsInfo(cdp))[0];
    await clickColumnInput(cdp, 1);
    await sleep(200);
    const open2 = await evaluate(cdp, `(() => window.__piShell.openSessionPath(${JSON.stringify(fixture)}))()`, true).catch((err) => ({ error: String(err.message) }));
    await sleep(700);
    const afterConflict = await columnsInfo(cdp);
    check(
      "P5 同一会话在列 2 打开 → 409 提示，列 1 不受影响",
      open1?.entries > 0 && afterConflict[1].noticeShown === true && /409|已在另一个标签页打开/.test(afterConflict[1].notice) &&
        afterConflict[0].logLen === col1AfterOpen.logLen,
      `列 1 entries=${open1?.entries} len=${col1AfterOpen.logLen}→${afterConflict[0].logLen} · 列 2 notice=「${afterConflict[1].notice}」`,
    );

    // ================= P6 关闭列 2 → 引擎回收 =================
    // 先等列 2 收敛到 idle（回收判据是「无 SSE + 60s 无请求」）
    await waitHealth((h) => (h.engines || []).find((e) => e.id === clientB)?.state === "idle", 60000, "列 2 idle");
    const enginesBeforeClose = (await getHealth()).engines || [];
    const closedAt = Date.now();
    const clickClose = await clickSelector(cdp, inColumn(1, "[data-role=col-close]"));
    const colsAfterClose = await waitColumns(cdp, 1, 15000);
    let reclaimedMs = null;
    let enginesAfter = [];
    while (Date.now() - closedAt < RECLAIM_DEADLINE_MS) {
      enginesAfter = (await getHealth()).engines || [];
      if (!enginesAfter.some((e) => e.id === clientB)) {
        reclaimedMs = Date.now() - closedAt;
        break;
      }
      await sleep(500);
    }
    check(
      "P6 关闭列 2 → 该列引擎 60–75s 后回收（health.engines 减少）",
      clickClose.hit === true && colsAfterClose.length === 1 && reclaimedMs != null && reclaimedMs >= SWEEP_IDLE_MS - 10000 && reclaimedMs <= RECLAIM_DEADLINE_MS,
      `列=${colsAfterClose.length} · engines ${enginesBeforeClose.length}→${enginesAfter.length} · 回收耗时=${reclaimedMs == null ? "超时" : `${Math.round(reclaimedMs / 1000)}s`}`,
    );

    // ================= P7 窄屏 900px → 单列 + 切换器 =================
    const clickSplit2b = await clickSelector(cdp, '#split-control [data-split="2"]');
    await waitColumns(cdp, 2);
    await waitHealth((h) => (h.engines || []).length >= 2, 40000, "重新 2 引擎");
    await setViewport(cdp, { width: 900, height: 800 });
    // 视口变化 → main.js 的 resize 监听重算列布局；轮询等它稳定（不等就断言等于测时序）
    let narrowCols = await columnsInfo(cdp);
    for (let i = 0; i < 25 && narrowCols.filter((c) => c.display !== "none").length !== 1; i++) {
      await sleep(200);
      narrowCols = await columnsInfo(cdp);
    }
    const viewportWidth = await evaluate(cdp, "innerWidth", false);
    const narrowSwitcher = await evaluate(cdp, SWITCHER_INFO, false);
    const visible = narrowCols.filter((c) => c.display !== "none");
    const activeKey = visible[0]?.key;
    const otherKey = narrowCols.find((c) => c.display === "none")?.key;
    // 用切换器切到另一列 → 可见列真的换了（后台列不销毁，仍在收事件）
    let switchedTo = null;
    if (otherKey) {
      const idx = narrowCols.findIndex((c) => c.key === otherKey);
      const btnClick = await clickSelector(cdp, `#col-switcher button:nth-of-type(${idx + 1})`);
      await sleep(500);
      const afterSwitch = await columnsInfo(cdp);
      switchedTo = afterSwitch.find((c) => c.display !== "none")?.key ?? null;
      if (!btnClick.hit) switchedTo = null;
    }
    check(
      "P7 窄屏 900px：只显示 1 列 + 列切换器（display 断言 / 切换生效）",
      clickSplit2b.hit === true && narrowCols.length === 2 && visible.length === 1 && narrowSwitcher.display !== "none" &&
        narrowSwitcher.buttons.length === 2 && switchedTo === otherKey,
      `vw=${viewportWidth} columns=${narrowCols.length} visible=${visible.length}(${activeKey}) switcher=${narrowSwitcher.display}/${narrowSwitcher.buttons.length} 切换后=${switchedTo}`,
    );
    const narrowShot = await shot(cdp, SHOT_NARROW);
    check("P9b 截图：窄屏单列 + 切换器（docs/evidence/ui-multi-column-narrow.png）", fs.existsSync(narrowShot) && fs.statSync(narrowShot).size > 0, narrowShot);

    // ================= P8 3 列可用；第 4 列提示上限 =================
    await setViewport(cdp, { width: 1440, height: 900 });
    await sleep(400);
    const clickSplit3 = await clickSelector(cdp, '#split-control [data-split="3"]');
    const cols3 = await waitColumns(cdp, 3, 25000);
    const h3 = await waitHealth((h) => (h.engines || []).length >= 3, 40000, "3 engines");
    const thirdNotice = await evaluate(cdp, `(() => { const r = window.__piShell.addColumn(); return { pending: !!r }; })()`, false);
    await sleep(900);
    const afterFourth = await columnsInfo(cdp);
    const noticeText = afterFourth.map((c) => c.notice).filter(Boolean).join(" | ");
    const h4 = await getHealth();
    check(
      "P8 3 列可用（上限 4 引擎）；第 4 列提示上限（列数/引擎数不增）",
      clickSplit3.hit === true && cols3.length === 3 && (h3.engines || []).length >= 3 &&
        afterFourth.length === 3 && /上限|最多/.test(noticeText) && (h4.engines || []).length === (h3.engines || []).length,
      `columns=${afterFourth.length} engines=${(h3.engines || []).length}→${(h4.engines || []).length} notice=「${noticeText}」`,
    );

    // ================= P10 收尾检查 =================
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_|Failed to load resource/.test(String(t)));
    check("P10 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");
  } finally {
    try {
      cdp?.close();
    } catch {}
    try {
      edge?.kill("SIGKILL");
    } catch {}
    // 先记下所有 pi 的 pid（停桥后它们可能还活着，会占住夹具目录 → Windows 上 rmSync EPERM）
    let enginePids = [];
    try {
      enginePids = ((await getHealth()).engines || []).map((e) => e.pid).filter(Boolean);
    } catch {}
    try {
      bridge.kill("SIGTERM");
    } catch {}
    await sleep(2500);
    for (const pid of enginePids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(path.dirname(WORKSPACE), { recursive: true, force: true });
        break;
      } catch {
        await sleep(500);
      }
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log(`FAIL 清单：${failed.map((r) => r.name).join(" | ")}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
