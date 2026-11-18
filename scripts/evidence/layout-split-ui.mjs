#!/usr/bin/env node
// Q6 验收：单列宽度自适应 + 侧栏可拖拽（真实页面 + CDP 鼠标，夹具会话，端口 7862 独占）
//
// 为什么需要这个脚本：用户实测单列宽屏下正文太窄（assistant 68ch < 工具块 < Composer 776），
// 侧栏 288px 的摘要被切太狠且不能调宽。这个脚本用几何断言把「同宽 / 居中 / 可拖拽 / 记忆」钉死。
//
// 断言：
//   L1  单列 1440×900：#log 有效内容宽度 820–900px；左右 padding ≤ 24px
//   L2  单列：assistant 段落宽度 == 工具块宽度（±2px）；Composer 宽度 == 内容宽度（±2px）
//   L3  双列 1920×900：内容宽度 > 600px + 按列铺满（== 列内容区宽度），max-width 不再是 860
//   L4  侧栏默认 320±2；拖拽到 420±6（拖拽中 body.resizing 生效，结束移除）；localStorage 记住
//   L5  刷新后侧栏仍 420±6；双击分割线恢复 320±2
//   L6  截图：docs/evidence/ui-layout-single.png / ui-layout-dual.png / ui-layout-sidebar-drag.png
//   L7  全流程无未捕获 JS 异常 / 控制台 error
//
// 用法：node scripts/evidence/layout-split-ui.mjs      （EDGE_PATH 可指定 msedge.exe）
// 环境变量：PI_SHELL_LAYOUT_PORT（默认 7862）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_LAYOUT_PORT || 7862);
const DEBUG_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-layout-split");
const SESSIONS = path.join(OUT_DIR, "sessions");
const WORKSPACE = path.join(REPO_ROOT, ".tmp-evidence-layout-split", "workspace");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const SHOT_SINGLE = path.join(SHOT_DIR, "ui-layout-single.png");
const SHOT_DUAL = path.join(SHOT_DIR, "ui-layout-dual.png");
const SHOT_DRAG = path.join(SHOT_DIR, "ui-layout-sidebar-drag.png");

const MAX_ENGINES = 4;
const SIDEBAR_DEFAULT = 320;
const SIDEBAR_TARGET = 420;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具（一条 user + 一条 assistant 长正文 + 一条 toolResult）----------

function writeFixtureSession() {
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const cwd = WORKSPACE.replace(/\\/g, "/");
  const dir = path.join(SESSIONS, cwd.replace(/[:/]/g, "-").replace(/^/, "--"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "q6-layout-0001.jsonl");
  const now = Date.now();
  const at = (ms) => new Date(now - 60000 + ms).toISOString();
  const rows = [
    { type: "session", version: 3, id: "q6-layout-0001", timestamp: at(0), cwd },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: at(1000),
      message: {
        role: "user",
        content: [{ type: "text", text: "夹具：这条用户消息用于 Q6 单列宽度取证（气泡应与容器等宽）。" }],
      },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: at(3000),
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "夹具助手正文第一段。这一段足够长，用来确认单列宽屏下正文不再被 68ch 卡成窄带——它的左右边界应该和下面的工具块完全重合，也和 Composer 的内容列对齐。\n\n" +
              "夹具助手正文第二段。宽度断言取的是段落的 getBoundingClientRect().width，块级元素（正文 / thinking / 工具块 / 代码块 / 用户气泡）一律等于内容容器宽度。",
          },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: 'rg -n "max-width" web/src/style.css' } },
        ],
      },
    },
    {
      type: "message",
      id: "t1",
      parentId: "m2",
      timestamp: at(4200),
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: 'web/src/style.css:1199:  max-width: none;\nweb/src/style.css:1235:  max-width: 68ch;' }],
      },
    },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
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
    stdio: "ignore",
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
  throw new Error(`等待超时（${label}，${ms}ms）state=${last?.pi?.state}`);
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

async function setViewport(cdp, { width, height }) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  });
  await sleep(400);
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
      return { x, y, ok: !!hit && (hit === el || el.contains(hit)) };
    })()`,
    false,
  );
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(150);
  return { ...box, hit: true };
}

async function resizerCenter(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const el = document.getElementById('sidebar-resizer');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), cursor: getComputedStyle(el).cursor };
    })()`,
    false,
  );
}

/** 真实鼠标拖拽分割线：按下 → 分步移动 → 抬起（中途读 body.resizing） */
async function dragResizer(cdp, deltaX) {
  const c = await resizerCenter(cdp);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await sleep(80);
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: c.x + Math.round((deltaX * i) / steps),
      y: c.y,
      button: "left",
      buttons: 1,
    });
    await sleep(45);
  }
  const during = await evaluate(cdp, `({ resizing: document.body.classList.contains('resizing'), select: getComputedStyle(document.body).userSelect })`, false);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x + deltaX, y: c.y, button: "left", clickCount: 1 });
  await sleep(250);
  const after = await evaluate(cdp, `document.body.classList.contains('resizing')`, false);
  return { center: c, during, after };
}

/** 真实双击（第一次 clickCount=1，第二次 clickCount=2 → dblclick） */
async function doubleClickResizer(cdp) {
  const c = await resizerCenter(cdp);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 2 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 2 });
  await sleep(300);
  return c;
}

/** 页面就绪：主界面 + 版本回填（= 已认领引擎） */
async function waitReady(cdp, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await evaluate(
      cdp,
      `(() => !!document.getElementById('input') && (document.getElementById('version')?.textContent || '—') !== '—' && !!window.__piShell)()`,
      false,
    ).catch(() => false);
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

const MEASURE = `(() => {
  const col = [...document.querySelectorAll('.column')].find((n) => !n.hidden && getComputedStyle(n).display !== 'none');
  if (!col) return { error: 'no visible column' };
  const log = col.querySelector('.log');
  const cs = getComputedStyle(log);
  const padL = parseFloat(cs.paddingLeft);
  const padR = parseFloat(cs.paddingRight);
  const inner = log.clientWidth - padL - padR;
  const entries = col.querySelector('.entries') || col.querySelector('.live');
  const card = col.querySelector('.composer-card');
  const para = col.querySelector('.entry-assistant .text-block .md-p');
  const tool = col.querySelector('.entry-toolResult .tool-result');
  const sb = document.querySelector('.sidebar');
  const resizer = document.getElementById('sidebar-resizer');
  const rect = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
  return {
    cols: document.body.dataset.cols,
    colWidth: Math.round(col.getBoundingClientRect().width),
    logInner: Math.round(inner),
    logPadL: Math.round(padL),
    logPadR: Math.round(padR),
    entries: rect(entries),
    entriesMaxWidth: entries ? getComputedStyle(entries).maxWidth : null,
    card: rect(card),
    cardMaxWidth: card ? getComputedStyle(card).maxWidth : null,
    para: rect(para),
    tool: rect(tool),
    sidebar: sb ? Math.round(sb.getBoundingClientRect().width) : null,
    resizerW: resizer ? Math.round(resizer.getBoundingClientRect().width) : 0,
    resizerCursor: resizer ? getComputedStyle(resizer).cursor : null,
    resizing: document.body.classList.contains('resizing'),
    stored: localStorage.getItem('pi-shell.sidebarWidth'),
  };
})()`;

const measure = (cdp) => evaluate(cdp, MEASURE, false);

async function waitEntries(cdp, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const n = await evaluate(
      cdp,
      `(() => {
        const col = [...document.querySelectorAll('.column')].find((n) => !n.hidden);
        if (!col) return 0;
        return col.querySelectorAll('.entry-assistant .text-block .md-p').length + col.querySelectorAll('.entry-toolResult .tool-result').length;
      })()`,
      false,
    ).catch(() => 0);
    if (n >= 2) return n;
    await sleep(250);
  }
  return 0;
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(path.dirname(WORKSPACE), { recursive: true, force: true });
  const fixture = writeFixtureSession().replace(/\\/g, "/");

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
    console.log(`bridge ready · max engines=${health0.maxEngines} · pi=${health0.pi?.version}`);

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

    if (!(await waitReady(cdp))) throw new Error("页面未在 30s 内就绪");

    // 打开夹具会话（真实会话流：一条 assistant 正文 + 一条 toolResult）
    await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(fixture)})`, true);
    const entryCount = await waitEntries(cdp);
    if (!entryCount) throw new Error("夹具会话的正文/工具块没有渲染出来");
    await sleep(400);

    // ================= L1/L2 单列 1440×900 =================
    const single = await measure(cdp);
    check(
      "L1 单列 1440×900：#log 有效内容宽度 820–900px，左右 padding ≤ 24px",
      single.cols === "1" && single.entries >= 820 && single.entries <= 900 && single.logPadL <= 24 && single.logPadR <= 24,
      `cols=${single.cols} 内容=${single.entries}px（log 内宽 ${single.logInner}px） pad=${single.logPadL}/${single.logPadR}`,
    );
    check(
      "L2 单列：assistant 段落 == 工具块（±2px），Composer == 内容宽度（±2px）",
      single.para != null && single.tool != null && Math.abs(single.para - single.tool) <= 2 && single.card != null && Math.abs(single.card - single.entries) <= 2,
      `段落=${single.para} 工具块=${single.tool} Composer=${single.card} 内容=${single.entries}`,
    );
    const shotSingle = await shot(cdp, SHOT_SINGLE);
    check("L6a 截图：单列宽度自适应（docs/evidence/ui-layout-single.png）", fs.existsSync(shotSingle) && fs.statSync(shotSingle).size > 0, shotSingle);

    // ================= L4/L5 侧栏宽度 =================
    const beforeDrag = await measure(cdp);
    check(
      "L4a 侧栏默认宽度 320±2，分割线 4px + cursor: col-resize",
      Math.abs(beforeDrag.sidebar - SIDEBAR_DEFAULT) <= 2 && beforeDrag.resizerW === 4 && beforeDrag.resizerCursor === "col-resize",
      `sidebar=${beforeDrag.sidebar} resizer=${beforeDrag.resizerW}px/${beforeDrag.resizerCursor} stored=${beforeDrag.stored}`,
    );

    const dragged = await dragResizer(cdp, SIDEBAR_TARGET - beforeDrag.sidebar);
    const afterDrag = await measure(cdp);
    check(
      "L4b 拖拽分割线 → 侧栏 420±6（拖拽中 body.resizing 生效，结束移除，localStorage 记住）",
      Math.abs(afterDrag.sidebar - SIDEBAR_TARGET) <= 6 && dragged.during.resizing === true && dragged.after === false && afterDrag.resizing === false && Number(afterDrag.stored) === afterDrag.sidebar,
      `sidebar ${beforeDrag.sidebar}→${afterDrag.sidebar} · resizing 拖拽中=${dragged.during.resizing}/结束后=${afterDrag.resizing} · stored=${afterDrag.stored}`,
    );
    const shotDrag = await shot(cdp, SHOT_DRAG);
    check("L6b 截图：侧栏拖宽（docs/evidence/ui-layout-sidebar-drag.png）", fs.existsSync(shotDrag) && fs.statSync(shotDrag).size > 0, shotDrag);

    // 刷新：宽度从 localStorage 恢复（同一 tab、同一 profile）
    await cdp.send("Page.reload", { ignoreCache: true }).catch(() => {});
    await sleep(600);
    if (!(await waitReady(cdp, 40000))) throw new Error("刷新后页面未就绪");
    await sleep(400);
    const afterReload = await measure(cdp);
    check(
      "L5a 刷新后侧栏仍 420±6（localStorage 持久化）",
      Math.abs(afterReload.sidebar - SIDEBAR_TARGET) <= 6,
      `sidebar=${afterReload.sidebar} stored=${afterReload.stored}`,
    );

    await doubleClickResizer(cdp);
    const afterDbl = await measure(cdp);
    check(
      "L5b 双击分割线恢复默认 320±2（并写回 localStorage）",
      Math.abs(afterDbl.sidebar - SIDEBAR_DEFAULT) <= 2 && Number(afterDbl.stored) === SIDEBAR_DEFAULT,
      `sidebar=${afterDbl.sidebar} stored=${afterDbl.stored}`,
    );

    // ================= L3 双列 1920×900 =================
    // 刷新后列 1 是空会话 → 重新打开夹具（双列几何要在有内容的那列上量）
    await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(fixture)})`, true);
    if (!(await waitEntries(cdp))) throw new Error("刷新后夹具会话没有渲染出来");
    await setViewport(cdp, { width: 1920, height: 900 });
    await sleep(400);
    const clickSplit2 = await clickSelector(cdp, '#split-control [data-split="2"]');
    const t0 = Date.now();
    let cols = null;
    while (Date.now() - t0 < 20000) {
      const info = await evaluate(cdp, `document.body.dataset.cols`, false);
      if (info === "2") {
        cols = info;
        break;
      }
      await sleep(200);
    }
    await sleep(800); // 等新列 DOM 完成首帧
    // 新列是活动列（且还没有内容）→ 先切回列 1（有夹具正文的那列）再量几何
    await clickSelector(cdp, ".column:nth-of-type(1) textarea");
    await sleep(400);
    const dual = await measure(cdp);
    check(
      "L3 双列 1920×900：内容宽 > 600px 且按列铺满（max-width 不再是 860）",
      clickSplit2.hit === true && cols === "2" && dual.entries != null && dual.entries > 600 && Math.abs(dual.entries - dual.logInner) <= 2 && dual.entriesMaxWidth === "none" && dual.cardMaxWidth === "none",
      `cols=${dual.cols} 列宽=${dual.colWidth} 内容=${dual.entries}（列内可用 ${dual.logInner}） max-width=${dual.entriesMaxWidth}/${dual.cardMaxWidth}`,
    );
    const shotDual = await shot(cdp, SHOT_DUAL);
    check("L6c 截图：双列按列铺满（docs/evidence/ui-layout-dual.png）", fs.existsSync(shotDual) && fs.statSync(shotDual).size > 0, shotDual);

    // ================= L7 无异常 =================
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_|Failed to load resource/.test(String(t)));
    check("L7 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");
  } finally {
    try {
      cdp?.close();
    } catch {}
    try {
      edge?.kill("SIGKILL");
    } catch {}
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
