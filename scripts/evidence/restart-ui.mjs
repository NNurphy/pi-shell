#!/usr/bin/env node
// 第四批验收：Composer 布局（输入卡片 + 底部工具栏）+ 界面内「重启桥」
//
// 两个用户报障一起取证：
//   A. `发送/中止/图片/文件` 四个按钮竖着一列堆在输入框右侧、尺寸不一 → 现在是
//      一整张卡片：上面 textarea，下面一行工具栏（左 ghost 附件 + behavior，右中止+发送）。
//   B. 用户没法自己重启桥（改了代码要关窗口/双击桌面快捷方式）→ 现在头部有「重启」，
//      点击 → 确认 → POST /api/restart（桥回 200 后 exit(75)）→ 启动脚本 1s 内拉起新代码。
//
// 守护方式（关键）：必须由启动脚本守护才测得到自愈，所以本脚本**直接**
//   spawn("cmd.exe", ["/c", "scripts\\start-pi-shell.cmd"])
// （不是 `start /min`）——理由是它给我们一个可 taskkill /T 的守护进程句柄，
// 收尾能连 node 桥 + pi 子进程整棵树一起杀；窗口由 stdio:ignore 吞掉，不会弹到桌面。
// 环境：PI_SHELL_PORT=7832（默认）、PI_SHELL_MAX_ENGINES=1、PI_SHELL_NO_BROWSER=1。
//
// 覆盖：
//   R1 启动脚本守护起桥（health idle）+ 页面就绪
//   R2 Composer 布局：#send 与 #abort 同一水平线；两个 label 同一行且不与发送/中止相交；
//      四个控件高度差 ≤4px；卡片结构（.composer-card > textarea + .composer-toolbar）
//   R3 截图 composer-light.png / composer-dark.png（Emulation.setEmulatedMedia 切 dark）
//   R4 真实点击 #restart-bridge → 确认框 → 遮罩出现「桥正在重启」
//   R5 ≤10s 内 health 出现**新 pi pid**，页面自动 reload 后可用（#pid 更新 + 会话列表可加载）
//   R6 收尾：守护树已杀、端口释放、pi 不残留、fixture 清空
//
// 用法：node scripts/evidence/restart-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe
// 产出：<repo>/docs/evidence/composer-light.png、composer-dark.png；<tmp>/pi-shell-restart-ui/
// 退出码：0 = 全部通过

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 端口不用 PI_SHELL_PORT：本机运行中的真 pi-shell 就在 7788，脚本必须固定自己的端口，
// 否则（例如 shell 里 export 了 PI_SHELL_PORT=7788）会把用户的真实桥重启掉。
const PORT = Number(process.env.PI_SHELL_TEST_PORT || 7832);
const PROD_PORT = 7788;
if (PORT === PROD_PORT) throw new Error(`PI_SHELL_TEST_PORT 不能是真 pi-shell 的端口 ${PROD_PORT}`);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-restart-ui");
const SESSIONS = path.join(OUT_DIR, "sessions"); // fixture：不碰真实 ~/.pi/agent/sessions
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- fixture（一条假会话，证明重启后「列表可加载」） ----------

const FIXTURE_ID = "fixture0-1111-2222-3333-444455556666";

function writeFixture() {
  const dir = path.join(SESSIONS, "--C--Users-user-pi-shell--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-11-07T10-00-00-000Z_${FIXTURE_ID}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: FIXTURE_ID,
    timestamp: "2026-11-07T10:00:00.000Z",
    cwd: REPO_ROOT,
  };
  const message = {
    type: "message",
    id: "fixture-msg-1",
    parentId: null,
    timestamp: "2026-11-07T10:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "fixture：重启验收用的会话行" }] },
  };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, "utf8");
  return file;
}

// ---------- 启动脚本守护（真守护：exit 75 → 1s 后重启） ----------

function startLauncher() {
  return spawn("cmd.exe", ["/c", "scripts\\start-pi-shell.cmd"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT), // 显式覆盖（父 shell 里的 7788 不得漏进来）
      PI_SHELL_MAX_ENGINES: "1",
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_LOG_FILE: LOG_FILE,
      PI_SHELL_NO_BROWSER: "1", // 不开浏览器窗口（我们用 headless Edge + CDP）
    },
    // H-15：子进程 stdio 必须 ignore/inherit，接管道不消费会把桥堵死
    stdio: "ignore",
  });
}

/** 杀守护整棵树：cmd → node 桥 → pi 子进程（Windows 上 child.kill 只杀 cmd 本身） */
function killTree(pid) {
  if (!pid) return [];
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  return [pid];
}

/**
 * 兜底：按端口找 LISTENING 的进程并杀树。
 * 为什么需要：守护循环在 taskkill 的同一瞬间可能刚好把 node 重新拉起来（run 里实测见过一条
 * 逃过 /T 的 node），所以收尾必须再按端口补一刀，否则「端口已释放」会给出假证据。
 */
function killPort(port) {
  const out = spawnSync("cmd.exe", ["/c", `netstat -ano | findstr LISTENING | findstr :${port}`], {
    encoding: "utf8",
  }).stdout || "";
  const pids = new Set(
    out
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/).pop())
      .filter((p) => /^[1-9]\d*$/.test(p)),
  );
  for (const pid of pids) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
  return [...pids];
}

async function healthOnce(timeoutMs = 2000) {
  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${BASE}/api/health`, { cache: "no-store", signal: ctl });
  return res.json();
}

async function waitHealth(ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const body = await healthOnce();
      if (body?.ok && body?.pi?.state === "idle") return body;
    } catch {}
    await sleep(300);
  }
  return null;
}

async function assertPortFree() {
  try {
    await healthOnce(1500);
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口（避免给出假证据）`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
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

async function evaluate(cdp, expression, timeoutMs = 20000) {
  const res = await Promise.race([
    cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 15000 }),
    sleep(timeoutMs).then(() => {
      throw new Error(`evaluate 超时 ${timeoutMs}ms`);
    }),
  ]);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
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
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { cache: "no-store" })).json();
      target = (list || []).find((t) => t.type === "page" && String(t.url).startsWith(BASE));
    } catch {}
  }
  if (!target) throw new Error(`Edge 未在 20s 内就绪（debug port ${debugPort}）`);
  return { edge, target };
}

async function waitFor(cdp, expr, ms = 15000, interval = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const value = await evaluate(cdp, expr, 8000);
      if (value) return value;
    } catch {}
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
    const ok = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    return { x, y, ok, disabled: el.disabled === true };
  })()`);
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
}

async function shot(cdp, file) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(s.data, "base64"));
  return file;
}

// ---------- 页面快照 ----------

const PAGE = `(() => {
  const rect = (sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const display = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).display : null;
  };
  const labels = [...document.querySelectorAll('#attach-buttons .file-label')];
  const overlay = document.getElementById('restart-overlay');
  const pidText = (document.getElementById('pid')?.textContent || '').trim();
  return {
    state: document.getElementById('state')?.dataset.state || '',
    pid: pidText,
    pidNum: Number(pidText) || null,
    version: (document.getElementById('version')?.textContent || '').trim(),
    rows: document.querySelectorAll('[data-role="session-row"]').length,
    hasCard: !!document.querySelector('#composer .composer-card'),
    hasToolbar: !!document.querySelector('#composer .composer-card > .composer-toolbar'),
    toolbarButtons: [...document.querySelectorAll('#composer .composer-toolbar > button')].map((b) => b.id),
    send: rect('#send'),
    abort: rect('#abort'),
    labelRects: labels.map((l) => ({ text: l.textContent.trim(), ...rect(l) })),
    inputRect: rect('#input'),
    hasImageInput: !!document.getElementById('image-input'),
    hasFileInput: !!document.getElementById('file-input'),
    behaviorDisplay: display('#behavior'),
    behaviorInsideToolbar: !!document.querySelector('#composer .composer-toolbar #behavior'),
    behaviorAfterAttach: (() => {
      const attach = document.getElementById('attach-buttons');
      const behavior = document.getElementById('behavior');
      if (!attach || !behavior) return false;
      return !!(attach.compareDocumentPosition(behavior) & Node.DOCUMENT_POSITION_FOLLOWING);
    })(),
    overlayHidden: overlay ? overlay.hidden === true : true,
    overlayDisplay: overlay ? getComputedStyle(overlay).display : 'none',
    restartTitle: (document.getElementById('restart-title')?.textContent || '').trim(),
    restartNote: (document.getElementById('restart-note')?.textContent || '').trim(),
    hasConfirm: !!document.querySelector('#modal [data-role="confirm-box"]'),
    toast: (document.getElementById('toast')?.textContent || '').trim(),
    toastHidden: document.getElementById('toast')?.hidden !== false,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
})()`;

/** 两个矩形是否相交（含 0 面积退化为不交） */
function overlaps(a, b) {
  if (!a || !b) return false;
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** 列表默认收起：展开所有分组 */
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
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  await assertPortFree();
  const fixtureFile = writeFixture();

  let launcher = null;
  let edge = null;
  let cdp = null;
  let health0 = null;
  let latestPid = null;
  let portFreeAtEnd = false;
  let piGoneAtEnd = false;

  try {
    // ---- R1：启动脚本守护起桥 ----
    launcher = startLauncher();
    health0 = await waitHealth(45000);
    latestPid = health0?.pi?.pid ?? null;
    check(
      "R1 启动脚本（守护循环）起桥成功：health idle、maxEngines=1",
      !!health0 && health0.pi.state === "idle" && health0.maxEngines === 1,
      health0
        ? `pi ${health0.pi.version} · pid ${health0.pi.pid} · state ${health0.pi.state} · maxEngines ${health0.maxEngines} · 守护 cmd pid ${launcher.pid}`
        : `45s 内未就绪（看 ${LOG_FILE}）`,
    );
    if (!health0) throw new Error("桥未就绪，后续断言无意义");

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
        if (/net::ERR_CONNECTION|Failed to load resource/i.test(String(e.text || ""))) return; // 桥退出期的预期断连
        pageErrors.push(e.url ? `${e.text} (${e.url})` : e.text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");

    const ready = await waitFor(
      cdp,
      `(() => { const s = ${PAGE}; return (s.version && s.version !== '—' && s.pidNum) ? s : null; })()`,
      30000,
    );
    check("R1b 页面就绪（#pid / #version 已回填）", !!ready, ready ? `pid ${ready.pid} · pi ${ready.version}` : "30s 未就绪");
    if (!ready) {
      const dbg = await evaluate(
        cdp,
        `({ ver: document.getElementById('version')?.textContent, pid: document.getElementById('pid')?.textContent, notice: (document.getElementById('notice')?.textContent || '').trim() })`,
      ).catch((e) => ({ err: String(e.message) }));
      throw new Error(`页面未就绪：${JSON.stringify(dbg)} errors=${pageErrors.slice(0, 3).join(" | ")}`);
    }
    await sleep(800);

    // ---- R2：Composer 布局 ----
    const snap = await evaluate(cdp, PAGE);
    const hDiff = snap.send && snap.abort ? Math.abs(snap.send.top - snap.abort.top) : 999;
    const label = snap.labelRects || [];
    const labelTopDiff = label.length === 2 ? Math.abs(label[0].top - label[1].top) : 999;
    const heights = [snap.send?.h, snap.abort?.h, label[0]?.h, label[1]?.h].filter((h) => typeof h === "number");
    const heightSpread = heights.length === 4 ? Math.max(...heights) - Math.min(...heights) : 999;
    const noOverlap =
      !overlaps(label[0], snap.send) &&
      !overlaps(label[1], snap.send) &&
      !overlaps(label[0], snap.abort) &&
      !overlaps(label[1], snap.abort) &&
      !overlaps(label[0], label[1]);

    check(
      "R2a 结构：#composer > .composer-card > textarea + .composer-toolbar；toolbar 内只有 中止/发送，附件与 behavior 在左侧",
      snap.hasCard === true && snap.hasToolbar === true &&
        JSON.stringify(snap.toolbarButtons) === JSON.stringify(["abort", "send"]) &&
        snap.behaviorInsideToolbar === true && snap.behaviorAfterAttach === true &&
        snap.hasImageInput === true && snap.hasFileInput === true,
      `card=${snap.hasCard} · toolbar=${snap.hasToolbar} · 右侧按钮=${JSON.stringify(snap.toolbarButtons)} · behavior 在工具栏=${snap.behaviorInsideToolbar} · 在附件之后=${snap.behaviorAfterAttach}`,
    );

    check(
      "R2b #send 与 #abort 同一水平线（top 差 <6px）",
      hDiff < 6,
      `#send top ${snap.send?.top?.toFixed(1)} / #abort top ${snap.abort?.top?.toFixed(1)} → 差 ${hDiff.toFixed(1)}px`,
    );

    check(
      "R2c 「图片」「文件」label 在同一行（top 差 <6px），且与发送/中止矩形不相交",
      labelTopDiff < 6 && noOverlap,
      `labels=${JSON.stringify(label.map((l) => ({ t: l.text, top: Number(l.top.toFixed(1)), left: Number(l.left.toFixed(1)) })))} · top 差 ${labelTopDiff.toFixed(1)}px · 不相交=${noOverlap}`,
    );

    check(
      "R2d 四个控件（发送/中止/图片/文件）高度一致（极差 ≤4px）",
      heightSpread <= 4,
      `高度 ${JSON.stringify(heights.map((h) => Number(h.toFixed(1))))} · 极差 ${heightSpread.toFixed(1)}px`,
    );

    check(
      "R2e 行为不变：#behavior 在 idle 时隐藏、#image-input/#file-input 仍在 DOM、重启遮罩默认隐藏",
      snap.behaviorDisplay === "none" && snap.hasImageInput === true && snap.hasFileInput === true &&
        snap.overlayHidden === true && snap.overlayDisplay === "none",
      `#behavior display=${snap.behaviorDisplay} · #restart-overlay display=${snap.overlayDisplay}`,
    );

    // ---- R3：截图（浅色 / 深色） ----
    // 必须显式模拟 prefers-color-scheme：本机系统是深色，不模拟的话「light」截图也是黑的（第一版栽在这）。
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await sleep(400);
    const lightSnap = await evaluate(cdp, PAGE);
    const lightShot = await shot(cdp, path.join(SHOT_DIR, "composer-light.png"));

    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await sleep(400);
    const darkSnap = await evaluate(cdp, PAGE);
    const darkShot = await shot(cdp, path.join(SHOT_DIR, "composer-dark.png"));
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await sleep(200);

    const rgb = (s) => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number);
    const sum = (c) => c[0] + c[1] + c[2];
    const hDiffDark = darkSnap.send && darkSnap.abort ? Math.abs(darkSnap.send.top - darkSnap.abort.top) : 999;
    const hDiffLight = lightSnap.send && lightSnap.abort ? Math.abs(lightSnap.send.top - lightSnap.abort.top) : 999;
    check(
      "R3 浅色/深色都可读且布局一致（同一水平线）+ 两张截图已落盘",
      hDiffDark < 6 && hDiffLight < 6 &&
        sum(rgb(lightSnap.bodyBg)) > sum(rgb(darkSnap.bodyBg)) + 300 && // 浅色确实比深色亮
        fs.existsSync(lightShot) && fs.existsSync(darkShot) &&
        fs.statSync(lightShot).size > 10000 && fs.statSync(darkShot).size > 10000,
      `body bg 浅 ${lightSnap.bodyBg} → 深 ${darkSnap.bodyBg} · top 差 浅 ${hDiffLight.toFixed(1)} / 深 ${hDiffDark.toFixed(1)}px`,
    );

    // ---- R4：真实点击「重启」→ 确认 → 遮罩 ----
    const oldPid = Number(health0.pi.pid);
    const clickRestart = await clickElement(cdp, "#restart-bridge");
    const modalUp = await waitFor(cdp, `(() => { const s = ${PAGE}; return s.hasConfirm ? s : null; })()`, 5000);
    const clickYes = modalUp ? await clickElement(cdp, '#modal [data-role="confirm-continue"]') : { hit: false };

    let sawRestarting = null;
    const tClick = Date.now();
    for (let i = 0; i < 25 && !sawRestarting; i++) {
      await sleep(120);
      try {
        const s = await evaluate(cdp, PAGE);
        if (s.restartTitle.includes("桥正在重启")) sawRestarting = s;
      } catch {}
    }
    check(
      "R4 点「重启」→ 出现确认框 → 点「重启」→ 遮罩「桥正在重启」",
      clickRestart.hit === true && !!modalUp && clickYes.hit === true && !!sawRestarting,
      `按钮点中=${clickRestart.hit} · 确认框=${!!modalUp} · 确认点中=${clickYes.hit} · 遮罩文案「${sawRestarting?.restartTitle ?? ""}」/「${sawRestarting?.restartNote ?? ""}」（${Date.now() - tClick}ms）`,
    );

    // ---- R5：≤10s 新 pid + 页面可用 ----
    let newPid = null;
    let newPidAt = null;
    let reloadSeen = false;
    let sawRestartedToast = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000 && !(newPid && reloadSeen)) {
      // 页面上「桥已重启」toast / 遮罩文案（reload 前抓，抓不到也不影响结论）
      if (!sawRestartedToast) {
        try {
          const s = await evaluate(cdp, PAGE, 5000);
          if (s.restartTitle.includes("桥已重启") || (!s.toastHidden && s.toast.includes("桥已重启"))) sawRestartedToast = s;
        } catch {
          reloadSeen = true; // 导航中执行上下文被销毁 = 已经 reload
        }
      }
      if (!newPid) {
        try {
          const body = await healthOnce(1500);
          const pid = body?.pi?.pid ?? null;
          if (body?.ok && pid != null && pid !== oldPid) {
            newPid = pid;
            latestPid = pid;
            newPidAt = Date.now();
          }
        } catch {}
      }
      await sleep(400);
    }
    const pidMs = newPidAt ? newPidAt - tClick : -1;

    // 页面自己 reload 后重新就绪：pid 变了 + 会话列表能加载（fixture 行必须出现）
    await waitFor(
      cdp,
      `(() => { const s = ${PAGE}; return (s.version && s.version !== '—' && s.pidNum && s.pidNum !== ${oldPid}) ? s : null; })()`,
      25000,
    );
    await expandAllIn(cdp); // 刷新后列表默认收起
    const afterRestart = await waitFor(
      cdp,
      `(() => { const s = ${PAGE}; return (s.version && s.version !== '—' && s.pidNum && s.pidNum !== ${oldPid} && s.rows > 0) ? s : null; })()`,
      15000,
    );
    check(
      "R5 重启自愈：≤10s 出现新 pi pid，页面 reload 后可用（新 pid + 列表加载出 fixture 行）",
      !!newPid && pidMs > 0 && pidMs <= 10000 && !!afterRestart,
      `旧 pid ${oldPid} → 新 pid ${newPid ?? "无"}（${pidMs}ms）· reload 后 #pid=${afterRestart?.pid} state=${afterRestart?.state} 列表行=${afterRestart?.rows} · toast=${sawRestartedToast?.toast || sawRestartedToast?.restartTitle || "未捕获"}`,
    );

    // ---- R5b：新桥上的 health / 引擎池干净（maxEngines=1，只有 1 条引擎） ----
    const healthNew = await healthOnce().catch(() => null);
    check(
      "R5b 新桥状态：health ok、engineCount=1、旧 pi 不残留",
      !!healthNew && healthNew.ok === true && healthNew.engineCount === 1 && healthNew.pi.pid === newPid,
      healthNew
        ? `engineCount ${healthNew.engineCount}/${healthNew.maxEngines} · pid ${healthNew.pi.pid} · state ${healthNew.pi.state}`
        : "health 不可达",
    );

    // ---- R9：无守护进程时（手动起的桥）不谎报成功 ----
    // 手法：只杀守护 cmd（**不带 /T**，node 桥存活 → 等价于「手动 node 起的桥」），再点一次「重启」。
    // 桥 exit(75) 后没人拉起 → 遮罩 32s 后必须提示「未能自动恢复，请双击桌面上的「重启 pi-shell」」。
    // 这一段是「用户无法自己重启」场景的兜底文案，没有守护进程时必须能看懂怎么恢复。
    const launcherPid = launcher?.pid;
    spawnSync("taskkill", ["/PID", String(launcherPid), "/F"], { stdio: "ignore" }); // 只杀 cmd，不杀树
    await sleep(1200);
    const unguarded = await healthOnce().catch(() => null);
    const stillAlive = !!unguarded?.ok;
    const clickRestart2 = stillAlive ? await clickElement(cdp, "#restart-bridge") : { hit: false };
    const modalUp2 = stillAlive
      ? await waitFor(cdp, `(() => { const s = ${PAGE}; return s.hasConfirm ? s : null; })()`, 5000)
      : null;
    const clickYes2 = modalUp2 ? await clickElement(cdp, '#modal [data-role="confirm-continue"]') : { hit: false };
    const failUi = stillAlive
      ? await waitFor(
          cdp,
          `(() => { const s = ${PAGE}; return s.restartTitle.includes('未能自动恢复') ? s : null; })()`,
          45000,
        )
      : null;
    check(
      "R9 无守护进程（手动起桥）时不谎报成功：遮罩提示「未能自动恢复，请双击桌面上的「重启 pi-shell」」",
      stillAlive && clickRestart2.hit === true && clickYes2.hit === true && !!failUi &&
        failUi.restartNote.includes("未检测到守护进程") && failUi.overlayDisplay !== "none",
      `守护已杀但桥仍活=${stillAlive} · 二次点击=${clickRestart2.hit}/${clickYes2.hit} · 遮罩「${failUi?.restartTitle ?? "超时未出现"}」/「${failUi?.restartNote ?? ""}」`,
    );

    // 重启后再点一次「取消」的路径不测（会再重启一次桥），只测一次自愈
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_|Failed to load resource/.test(t));
    check("R6 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0,
      realErrors.length ? realErrors.slice(0, 3).join(" | ") : "无");
  } finally {
    try { cdp?.close(); } catch {}
    try { edge?.kill("SIGKILL"); } catch {}
    killTree(launcher?.pid); // 守护整棵树：cmd → node 桥 → pi
    await sleep(1200);
    const portPids = killPort(PORT); // 兜底：守护刚好把 node 拉起来时 /T 可能漏一条
    await sleep(1500);

    // 兜底：任何仍活着的 pi 都杀掉（脚本自己的证据链必须干净）
    for (const pid of [latestPid, health0?.pi?.pid]) {
      if (!pid) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await sleep(800);

    try {
      await healthOnce(1500);
    } catch {
      portFreeAtEnd = true;
    }
    const pids = [latestPid, health0?.pi?.pid].filter(Boolean);
    piGoneAtEnd = pids.every((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });

    check(
      "R7 收尾：守护进程树已杀、端口 7832 已释放、pi 子进程不残留",
      portFreeAtEnd && piGoneAtEnd,
      `port free=${portFreeAtEnd} · 端口补杀 ${JSON.stringify(portPids)} · pi pids ${JSON.stringify(pids)} 全退出=${piGoneAtEnd}`,
    );

    // 清 fixture（独占的临时会话目录，不碰真实 ~/.pi/agent/sessions）
    await fsp.rm(OUT_DIR, { recursive: true, force: true }).catch(() => {});
    check(
      "R8 fixture 已清理（临时 sessions 目录 + Edge profile 删除，真实会话目录未被触碰）",
      !fs.existsSync(OUT_DIR) && !fs.existsSync(fixtureFile),
      `${OUT_DIR} 已删除 · 真实目录未触碰`,
    );

    console.log(`      截图：${path.join(SHOT_DIR, "composer-light.png")}`);
    console.log(`      截图：${path.join(SHOT_DIR, "composer-dark.png")}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
