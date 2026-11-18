#!/usr/bin/env node
// 首启黄金路径 E2E（P0 回归，零第三方依赖）
//
// 为什么存在：v1.0.0 的验收用「el.hidden === true」代替「画面真的消失」，
// 结果 style.css 缺少 [hidden] 规则、首屏被「偏好设置」永久遮住，脚本却全绿。
// 本脚本只认两件事：
//   1) getComputedStyle(el).display —— 画面层面的可见性
//   2) 真实鼠标/键盘事件（CDP Input.*）—— 用户路径，不是 el.click()
//     并额外用 document.elementFromPoint 证明点击命中了预期元素（没被遮罩吃掉）
//
// 覆盖：
//   B1 首屏加载后所有浮层 display=none（设置/命令面板/模态/面板/横幅…）
//   B2 点「设置」→ 弹出；点「关闭」→ 真的消失
//   B3 Ctrl+K → 命令面板弹出；Esc → 消失
//   B4 刷新（F5）后仍然全部隐藏，无 JS 异常
//   B5 事件流已连上（断线横幅隐藏）、health 显示 pi 版本
//
// 用法：
//   node scripts/evidence/first-load.mjs            # 默认端口 7794
//   PI_SHELL_PORT=7795 node scripts/evidence/first-load.mjs
// 环境变量：
//   EDGE_PATH  指定 msedge.exe
// 产出：
//   <repo>/docs/evidence/first-load-verified.png
//   <tmp>/pi-shell-first-load/（日志、profile）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7794);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-first-load");
const SESSIONS = path.join(OUT_DIR, "sessions");
const SHOT = path.join(REPO_ROOT, "docs", "evidence", "first-load-verified.png");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const OVERLAYS = [
  "settings", "palette", "modal", "panel", "toast", "reconnect",
  "attach-banner", "attach-bar", "notice", "widget", "session-bar",
  "stats", "ext-status", "behavior", "search-clear", "panel-action",
  "restart-overlay", // 第四批：重启遮罩（首屏必须不可见）
];

// ---------- bridge ----------

function startBridge() {
  const child = spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_LOG_FILE: LOG_FILE,
    },
    // H-15：subprocess stdio 必须 ignore/inherit，接管道不消费会把桥堵死
    stdio: "ignore",
  });
  return child;
}

async function waitHealth(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/api/health`, { cache: "no-store" });
      const body = await res.json();
      if (body?.ok && body?.pi?.state === "idle") return body;
    } catch {}
    await sleep(300);
  }
  return null;
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

async function evaluate(cdp, expression, awaitPromise = true) {
  const res = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise, returnByValue: true, timeout: 120000,
  });
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
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge CDP 未就绪");
  return { edge, target };
}

// 画面级别可见性（唯一口径）
const VISIBLE_SNAPSHOT = `(() => {
  const ids = ${JSON.stringify(OVERLAYS)};
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out[id] = "missing"; continue; }
    const cs = getComputedStyle(el);
    out[id] = cs.display === "none" ? "none" : (cs.visibility === "hidden" || cs.opacity === "0" ? "invisible" : "shown");
  }
  return out;
})()`;

const READY = `(() => {
  const v = (document.getElementById('version')?.textContent || '').trim();
  const st = (document.getElementById('state')?.textContent || '').trim();
  return { version: v, state: st, input: !!document.getElementById('input') };
})()`;

async function waitPageReady(cdp, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await evaluate(cdp, READY, false).catch(() => null);
    if (s?.input && s.version && s.version !== "—") return s;
    await sleep(200);
  }
  return null;
}

// 真实鼠标点击：先取元素中心，再用 elementFromPoint 证明没被别的东西挡住
async function clickElement(cdp, selector) {
  const box = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: "not found" };
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === el || el.contains(hit));
    return { x, y, ok, hitTag: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') : null };
  })()`, false);
  if (box.error) return box;
  if (!box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
}

async function pressKey(cdp, { key, code, keyCode, modifiers = 0 }) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  });
}

const onlyShown = (snap, allow = []) =>
  Object.entries(snap).filter(([k, v]) => v !== "none" && !allow.includes(k));

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });

  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口（避免给出假证据）`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  const health = await waitHealth();
  if (!health) throw new Error("bridge 未在 30s 内就绪（看 " + path.join(OUT_DIR, "bridge.log") + "）");
  console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid}`);

  const { edge, target } = await launchEdge(edgePath);
  const cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.ready;

  const pageErrors = [];
  cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
    }
    if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
      const e = msg.params.entry;
      if (/favicon.ico/.test(String(e.url || '') + ' ' + String(e.text || ''))) return; // 图标缺失不算加载异常
      pageErrors.push(e.url ? `${e.text} (${e.url})` : e.text);
    }
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");

  try {
    // ---- B1 首屏 ----
    const ready = await waitPageReady(cdp);
    check("B0 页面可交互（health 已回填 version）", !!ready, ready ? `pi=${ready.version} state=${ready.state}` : "20s 未就绪");
    await sleep(1000); // 让懒加载的 /api/sessions、/api/stats 落地（它们会切换若干 hidden）
    const snap1 = await evaluate(cdp, VISIBLE_SNAPSHOT, false);
    const leaked1 = onlyShown(snap1);
    check("B1 首屏：无任何浮层可见（getComputedStyle）", leaked1.length === 0,
      leaked1.length ? `仍可见：${leaked1.map(([k, v]) => `${k}=${v}`).join(", ")}` : `${OVERLAYS.length} 个浮层全为 none`);

    const mainVisible = await evaluate(cdp, `(() => {
      const input = document.getElementById('input');
      const side = document.querySelector('.sidebar');
      const r = input.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + 20), Math.round(r.top + 20));
      return { inputDisplay: getComputedStyle(input).display, sidebarDisplay: getComputedStyle(side).display,
               inputHit: !!top && (top === input || input.contains(top) || top.closest('#composer') !== null) };
    })()`, false);
    check("B1b 首屏：主界面可命中（输入框未被遮罩吃掉）", mainVisible.inputHit && mainVisible.inputDisplay !== "none" && mainVisible.sidebarDisplay !== "none",
      `input=${mainVisible.inputDisplay} sidebar=${mainVisible.sidebarDisplay} hit=${mainVisible.inputHit}`);

    // ---- B2 设置：打开 → 关闭（真实点击） ----
    // B8：顶栏收敛后「设置」在 ⋯ 溢出菜单里 → 先开菜单再点设置（真实用户路径）
    const openMenu = await clickElement(cdp, "#open-menu");
    await sleep(250);
    const menuShown = await evaluate(cdp, `(() => { const m = document.getElementById('overflow-menu'); return !!m && getComputedStyle(m).display !== 'none'; })()`, false);
    check("B2a-1 点「⋯」→ 溢出菜单可见（设置/树/文件/Diff 都在里面）", openMenu.hit && menuShown === true, `hit=${openMenu.hit} menu=${menuShown}`);
    const openSettings = await clickElement(cdp, "#open-settings");
    await sleep(300);
    const afterOpen = await evaluate(cdp, VISIBLE_SNAPSHOT, false);
    check("B2a 点「设置」→ 面板可见（真实鼠标点中按钮）", openSettings.hit && afterOpen.settings === "shown",
      `hit=${openSettings.hit} display=${afterOpen.settings}`);

    const closeSettings = await clickElement(cdp, "#settings-close");
    await sleep(300);
    const afterClose = await evaluate(cdp, VISIBLE_SNAPSHOT, false);
    check("B2b 点「关闭」→ 面板真的消失（不是只改了 hidden 属性）", closeSettings.hit && afterClose.settings === "none",
      `hit=${closeSettings.hit} display=${afterClose.settings}`);

    // ---- B3 命令面板：Ctrl+K → Esc ----
    await evaluate(cdp, `document.getElementById('input').focus()`, false);
    await pressKey(cdp, { key: "k", code: "KeyK", keyCode: 75, modifiers: 2 });
    await sleep(600);
    const afterCtrlK = await evaluate(cdp, VISIBLE_SNAPSHOT, false);
    check("B3a Ctrl+K → 命令面板可见", afterCtrlK.palette === "shown", `display=${afterCtrlK.palette}`);

    await pressKey(cdp, { key: "Escape", code: "Escape", keyCode: 27 });
    await sleep(300);
    const afterEsc = await evaluate(cdp, VISIBLE_SNAPSHOT, false);
    check("B3b Esc → 命令面板消失", afterEsc.palette === "none", `display=${afterEsc.palette}`);

    // ---- B5 事件流 ----
    const sse = await evaluate(cdp, `(() => {
      const b = document.getElementById('reconnect');
      return { banner: getComputedStyle(b).display, text: document.getElementById('reconnect-text').textContent };
    })()`, false);
    check("B5 事件流已连通（断线横幅隐藏）", sse.banner === "none", `banner=${sse.banner}` + (sse.banner === "none" ? "" : ` text=${sse.text}`));

    // ---- B4 刷新后仍然正常 ----
    await cdp.send("Page.reload", { ignoreCache: true });
    const ready2 = await waitPageReady(cdp);
    await sleep(1200);
    const snap2 = await evaluate(cdp, VISIBLE_SNAPSHOT, false);
    const leaked2 = onlyShown(snap2);
    check("B4 刷新（F5）后：仍无浮层可见", !!ready2 && leaked2.length === 0,
      leaked2.length ? `仍可见：${leaked2.map(([k, v]) => `${k}=${v}`).join(", ")}` : "全部 none");

    // ---- B6 无 JS 异常 ----
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("B6 加载期无未捕获 JS 异常 / 控制台 error", realErrors.length === 0,
      realErrors.length ? realErrors.slice(0, 3).join(" | ") : "无");

    // ---- B7 桥侧印证：本轮只有 favicon.ico 是 404（没有别的资源缺失） ----
    const notFound = [...new Set(
      fs.readFileSync(LOG_FILE, "utf8").split("\n")
        .filter((l) => l.includes("status=404"))
        .map((l) => (l.match(/path=(\S+)/) || [])[1])
        .filter(Boolean),
    )];
    const unexpected404 = notFound.filter((p) => !/favicon\.ico$/.test(p));
    check("B7 桥日志：除 favicon.ico 外无 404", unexpected404.length === 0,
      notFound.length ? `404: ${notFound.join(", ")}` : "无 404");

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
    console.log(`      截图：${SHOT}`);
  } finally {
    cdp.close();
    try { edge.kill("SIGKILL"); } catch {}
    try { bridge.kill("SIGTERM"); } catch {}
    await sleep(1500);
    try { process.kill(health.pi.pid, "SIGKILL"); } catch {}
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
