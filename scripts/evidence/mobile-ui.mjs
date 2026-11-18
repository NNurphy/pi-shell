#!/usr/bin/env node
// Q2 移动端布局证据（零第三方依赖，CDP 真实浏览器 + 真实点击）
//
// 取证目标（页面行为，不是函数返回值）：
//   390×844（手机竖屏）：
//     M1 ☰（#toggle-sidebar）可见且命中区 44×44
//     M2 点 ☰ → 抽屉滑入（body[data-sidebar=open]、sidebar 贴左、遮罩出现）
//     M3 抽屉里点一条会话 → 会话打开 + 抽屉自动关闭（遮罩消失）
//     M4 #log 无横向滚动（scrollWidth <= clientWidth + 1），长代码行在代码块内部滚动
//     M5 Composer 在视口内且固定（滚动 #log 后 rect.bottom 不变）
//     M6 树面板 = 全屏 sheet（rect.width >= viewport.width - 2）+ 关闭按钮 44px
//     M7 ⋯ 菜单不越界（right <= innerWidth + 1）
//     M8 触摸命中区：工具栏按钮 / 会话行 >= 44
//     M9 Esc 关抽屉；遮罩点击也关抽屉
//   768×1024（平板）：仍是单列（侧栏抽屉隐藏、正文占满、composer 在视口内）
//   1440×900（桌面）：三栏结构不变（侧栏可见 ~288、composer 非 fixed/sticky）
//
// 产物：docs/evidence/ui-mobile-390.png / ui-tablet-768.png / ui-desktop-1440.png
//
// 铁律：只用 %TEMP% 下的手写夹具会话（PI_SHELL_SESSIONS_DIR），绝不碰真实会话；
//      固定端口 7861（不碰用户真实实例的 7788）。
// 用法：node scripts/evidence/mobile-ui.mjs      （EDGE_PATH 可指定 msedge.exe）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_MOBILE_PORT || 7861);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1000;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-mobile-ui");
const SESSIONS = path.join(OUT_DIR, "sessions");
const AGENTS = path.join(OUT_DIR, "sessions-agents");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具 ----------

const MAIN_ID = "q2-mobile-0001";
const OTHER_ID = "q2-mobile-0002";

function jsonl(rows) {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}
function msg(id, parentId, at, role, content) {
  return { type: "message", id, parentId, timestamp: new Date(at).toISOString(), message: { role, content } };
}

// 故意塞超长不可断行字符串 + 超长代码行：证明横向溢出被代码块吃掉，而不是把 #log 撑宽
const LONG_TOKEN = "https://example.com/" + "a".repeat(160);
const LONG_CODE = `const sum = ${Array.from({ length: 24 }, (_, i) => `value_${i}`).join(" + ")}; // 24 项求和，单行很长`;

function writeFixture() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const dir = path.join(SESSIONS, "--C--Users-user-q2-mobile--");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(AGENTS, { recursive: true });

  const t0 = Date.now() - 1_800_000;
  const rows = [
    { type: "session", version: 3, id: MAIN_ID, timestamp: t0, cwd: REPO_ROOT },
    msg("u1", null, t0 + 1000, "user", "手机上打开这页，看看排版是不是还在。"),
    msg("a1", "u1", t0 + 9000, "assistant", [
      {
        type: "text",
        text:
          "## 移动端先看三件事\n\n" +
          "1. 侧栏不该占掉 280px —— 手机上它只能是抽屉\n" +
          "2. 正文左右留 12px，长 URL 必须断行：" + LONG_TOKEN + "\n" +
          "3. Composer 固定在底部，滚到哪儿都能直接发\n\n" +
          "```js\n" + LONG_CODE + "\n```\n",
      },
    ]),
    msg("u2", "a1", t0 + 12_000, "user", "代码块横向滚动就够了，别整页左右晃。"),
    msg("a2", "u2", t0 + 20_000, "assistant", [
      { type: "text", text: "明白。下面是长回答，用来把 #log 撑到可滚动的高度。\n\n" },
      ...Array.from({ length: 8 }, (_, i) => ({
        type: "text",
        text: `第 ${i + 1} 段：这一段故意写长一点，让会话流在 390×844 的视口里必须滚动，方便验证 composer 的底边在滚动前后不动。${LONG_TOKEN.slice(0, 60)}\n\n`,
      })),
    ]),
  ];
  fs.writeFileSync(path.join(dir, `${MAIN_ID}.jsonl`), jsonl(rows), "utf8");

  const otherRows = [
    { type: "session", version: 3, id: OTHER_ID, timestamp: t0 - 60_000, cwd: REPO_ROOT },
    msg("ou1", null, t0 - 60_000 + 1000, "user", "抽屉里点我就该打开我，并关掉抽屉。"),
    msg("oa1", "ou1", t0 - 60_000 + 3000, "assistant", [{ type: "text", text: "收到。" }]),
  ];
  fs.writeFileSync(path.join(dir, `${OTHER_ID}.jsonl`), jsonl(otherRows), "utf8");
  return path.join(dir, `${MAIN_ID}.jsonl`);
}

// ---------- bridge / Edge / CDP ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_AGENT_SESSIONS_DIR: AGENTS,
      PI_SHELL_LOG_FILE: LOG_FILE,
    },
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
    const m = JSON.parse(ev.data);
    if (m.id != null) {
      const entry = pending.get(m.id);
      if (!entry) return;
      pending.delete(m.id);
      m.error ? entry.reject(new Error(JSON.stringify(m.error))) : entry.resolve(m.result);
      return;
    }
    for (const fn of listeners) fn(m);
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
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 120000 });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function launchEdge(edgePath) {
  const edge = spawn(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${path.join(OUT_DIR, "edge-profile")}`,
      "--window-size=390,844",
      "--force-device-scale-factor=1",
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

async function shot(cdp, file) {
  const res = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  return file;
}

const PAGE_READY = `(() => {
  const v = (document.getElementById('version')?.textContent || '').trim();
  return !!document.getElementById('input') && !!v && v !== '—';
})()`;

async function waitPageReady(cdp, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(cdp, PAGE_READY, false).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

/** 视口 + 触摸模拟（手机/平板用 mobile:true + touch，桌面 false） */
async function setViewport(cdp, { width, height, mobile, touch }) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: !!touch, maxTouchPoints: touch ? 5 : 1 });
  await sleep(350);
}

async function expandAllGroups(cdp) {
  for (let i = 0; i < 8; i++) {
    const closed = await evaluate(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('[data-role=group-row][data-open=false]')];
        rows.forEach((g) => g.querySelector('[data-role=group-toggle]')?.click());
        return rows.length;
      })()`,
      false,
    ).catch(() => 0);
    if (!closed) break;
    await sleep(200);
  }
  await sleep(250);
}

async function pressEscape(cdp) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
  await sleep(300);
}

// ---------- 主流程 ----------

async function main() {
  const fixturePath = writeFixture();
  const normalized = fixturePath.replace(/\\/g, "/");

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
    const health = await waitHealth();
    if (!health) throw new Error(`bridge 未在 40s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · bind ${health.bind}`);

    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;
    const pageErrors = [];
    cdp.on((m) => {
      if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params?.exceptionDetails?.text || "exception");
      if (m.method === "Log.entryAdded" && m.params?.entry?.level === "error") {
        const e = m.params.entry;
        if (/favicon\.ico/.test(String(e.url || "") + " " + String(e.text || ""))) return;
        pageErrors.push(e.url ? `${e.text} (${e.url})` : e.text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");

    // ================= 390×844 手机竖屏 =================
    await setViewport(cdp, { width: 390, height: 844, mobile: true, touch: true });
    const ready = await waitPageReady(cdp);
    check("M0 页面可交互（桥就绪）", !!ready, ready ? `pi=${health.pi.version}` : "40s 未就绪");
    if (!ready) throw new Error("页面未就绪");

    // 主会话先走 API 打开（只读夹具），得到长内容用于横向滚动 / composer 检查
    const opened = await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(normalized)})`, true);
    check("M0b 夹具会话已渲染", (opened?.entries ?? 0) >= 4, `entries=${opened?.entries}`);
    await sleep(600);
    await expandAllGroups(cdp);

    // ---- M1 ☰ 可见 + 44×44 ----
    const toggle = await evaluate(
      cdp,
      `(() => {
        const b = document.getElementById('toggle-sidebar');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return {
          display: getComputedStyle(b).display,
          w: Math.round(r.width),
          h: Math.round(r.height),
          inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1,
          vw: innerWidth,
          vh: innerHeight,
        };
      })()`,
      false,
    );
    check(
      "M1 390：☰ 可达且 44×44",
      !!toggle && toggle.display !== "none" && toggle.w === 44 && toggle.h === 44 && toggle.inViewport,
      toggle ? `${toggle.w}×${toggle.h} display=${toggle.display} vp=${toggle.vw}×${toggle.vh}` : "未找到 #toggle-sidebar",
    );

    // ---- M2 点 ☰ → 抽屉滑入 ----
    await evaluate(cdp, `document.getElementById('toggle-sidebar').click()`, false);
    await sleep(420);
    const drawer = await evaluate(
      cdp,
      `(() => {
        const sb = document.querySelector('.sidebar');
        const r = sb.getBoundingClientRect();
        const scrim = document.getElementById('sidebar-scrim');
        return {
          state: document.body.dataset.sidebar,
          left: Math.round(r.left),
          width: Math.round(r.width),
          expanded: document.getElementById('toggle-sidebar').getAttribute('aria-expanded'),
          scrimVisible: !!scrim && scrim.hidden === false && getComputedStyle(scrim).display !== 'none',
          rows: document.querySelectorAll('[data-role=session-row]').length,
          rowH: Math.round(document.querySelector('[data-role=session-row]')?.getBoundingClientRect().height || 0),
        };
      })()`,
      false,
    );
    check(
      "M2 390：点 ☰ → 抽屉贴左滑入 + 遮罩出现",
      drawer.state === "open" && drawer.left === 0 && drawer.width >= 250 && drawer.scrimVisible && drawer.expanded === "true",
      `state=${drawer.state} left=${drawer.left} width=${drawer.width} scrim=${drawer.scrimVisible}`,
    );

    // ---- M3 抽屉里点一条会话 → 打开 + 抽屉自动关闭 ----
    const clicked = await evaluate(
      cdp,
      `(async () => {
        const rows = [...document.querySelectorAll('[data-role=session-row]')];
        const target = rows.find((r) => r.dataset.sessionId !== window.__piShell.currentSessionId) || rows[0];
        if (!target) return { ok: false, reason: 'no rows' };
        const id = target.dataset.sessionId;
        target.click();
        await new Promise((r) => setTimeout(r, 1200));
        return { ok: true, clicked: id, current: window.__piShell.currentSessionId, drawer: document.body.dataset.sidebar };
      })()`,
      true,
    );
    const scrimAfter = await evaluate(
      cdp,
      `(() => { const s = document.getElementById('sidebar-scrim'); return !!s && s.hidden; })()`,
      false,
    );
    check(
      "M3 390：选中会话后抽屉自动关闭（内容已切换）",
      clicked.ok && clicked.current === clicked.clicked && clicked.drawer === "closed" && scrimAfter,
      `clicked=${clicked.clicked} current=${clicked.current} drawer=${clicked.drawer} scrimHidden=${scrimAfter}`,
    );

    // 回到主会话（长内容）
    await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(normalized)})`, true);
    await sleep(500);

    // ---- M4 #log 无横向滚动 ----
    const overflow = await evaluate(
      cdp,
      `(() => {
        const log = document.getElementById('log');
        const codePre = [...log.querySelectorAll('.code-pre')].map((e) => ({
          overflowX: getComputedStyle(e).overflowX,
          scrollable: e.scrollWidth > e.clientWidth,
        }));
        return {
          scrollWidth: log.scrollWidth,
          clientWidth: log.clientWidth,
          codePre,
          codeBlocks: log.querySelectorAll('.code-block').length,
          vw: innerWidth,
        };
      })()`,
      false,
    );
    check(
      "M4 390：#log 无横向滚动（scrollWidth ≤ clientWidth + 1）",
      overflow.scrollWidth <= overflow.clientWidth + 1,
      `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} codeBlocks=${overflow.codeBlocks}`,
    );
    check(
      "M4b 390：代码块内部横向滚动（overflow-x:auto）",
      overflow.codePre.length > 0 && overflow.codePre.every((c) => c.overflowX === "auto" || c.overflowX === "scroll"),
      overflow.codePre.map((c) => `${c.overflowX}${c.scrollable ? "/超宽" : ""}`).join(" "),
    );

    // ---- M5 Composer 固定底部 ----
    const composerBefore = await evaluate(
      cdp,
      `(() => {
        const form = document.getElementById('composer');
        const r = form.getBoundingClientRect();
        const log = document.getElementById('log');
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          vh: innerHeight,
          position: getComputedStyle(form).position,
          scrollable: log.scrollHeight > log.clientHeight,
          textareaMin: getComputedStyle(document.getElementById('input')).minHeight,
          textareaH: Math.round(document.getElementById('input').getBoundingClientRect().height),
          toolbarButtons: [...document.querySelectorAll('#composer .composer-toolbar button, #composer .composer-toolbar .file-label')].map((b) =>
            Math.round(b.getBoundingClientRect().height),
          ),
        };
      })()`,
      false,
    );
    await evaluate(cdp, `(() => { const l = document.getElementById('log'); l.scrollTop = 0; })()`, false);
    await sleep(400);
    const composerAfter = await evaluate(
      cdp,
      `(() => { const r = document.getElementById('composer').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()`,
      false,
    );
    check(
      "M5 390：Composer 在视口内且固定（滚动 log 后 bottom 不变）",
      composerBefore.bottom <= composerBefore.vh + 1 &&
        composerBefore.top >= 0 &&
        Math.abs(composerAfter.bottom - composerBefore.bottom) <= 1 &&
        JSON.stringify(["sticky", "fixed"]).includes(JSON.stringify(composerBefore.position)),
      `bottom ${composerBefore.bottom}→${composerAfter.bottom} vh=${composerBefore.vh} position=${composerBefore.position} scrollable=${composerBefore.scrollable}`,
    );
    check(
      "M5b 390：输入框最小 2 行 + 工具栏命中区 ≥44",
      parseFloat(composerBefore.textareaMin) <= 52 &&
        composerBefore.textareaH >= 40 &&
        composerBefore.textareaH <= 56 &&
        composerBefore.toolbarButtons.every((h) => h >= 44),
      `min-h=${composerBefore.textareaMin} h=${composerBefore.textareaH} buttons=[${composerBefore.toolbarButtons.join(",")}]`,
    );

    // ---- M7 ⋯ 菜单不越界 ----
    await evaluate(cdp, `document.getElementById('open-menu').click()`, false);
    await sleep(250);
    const menu = await evaluate(
      cdp,
      `(() => {
        const m = document.getElementById('overflow-menu');
        const r = m.getBoundingClientRect();
        return { hidden: m.hidden, left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, items: m.querySelectorAll('.menu-item').length };
      })()`,
      false,
    );
    check(
      "M7 390：⋯ 菜单不越界（left ≥ 0 且 right ≤ innerWidth）",
      !menu.hidden && menu.left >= 0 && menu.right <= menu.vw + 1 && menu.items >= 5,
      `left=${menu.left} right=${menu.right} vw=${menu.vw} items=${menu.items}`,
    );

    // ---- M6 树面板 = 全屏 sheet ----
    await evaluate(cdp, `document.getElementById('open-tree').click()`, false);
    await sleep(700);
    const panel = await evaluate(
      cdp,
      `(() => {
        const p = document.getElementById('panel');
        if (!p || p.hidden) return { hidden: true };
        const r = p.getBoundingClientRect();
        const close = document.getElementById('panel-close').getBoundingClientRect();
        return {
          hidden: false,
          width: Math.round(r.width),
          height: Math.round(r.height),
          left: Math.round(r.left),
          vw: innerWidth,
          vh: innerHeight,
          closeW: Math.round(close.width),
          closeH: Math.round(close.height),
          title: document.getElementById('panel-title').textContent,
        };
      })()`,
      false,
    );
    check(
      "M6 390：树面板全屏 sheet（宽 ≥ 视口-2，带 44px 关闭）",
      panel.hidden === false && panel.width >= panel.vw - 2 && panel.height >= panel.vh - 2 && panel.closeW >= 44 && panel.closeH >= 44,
      panel.hidden ? "panel 未打开" : `panel=${panel.width}×${panel.height} vp=${panel.vw}×${panel.vh} close=${panel.closeW}×${panel.closeH} title=${panel.title}`,
    );
    await evaluate(cdp, `document.getElementById('panel-close').click()`, false);
    await sleep(300);

    // ---- M6b 设置 = 全屏 sheet（同一套降级：模态也铺满） ----
    await evaluate(cdp, `document.getElementById('open-menu').click()`, false);
    await sleep(200);
    await evaluate(cdp, `document.getElementById('open-settings').click()`, false);
    await sleep(500);
    const settings = await evaluate(
      cdp,
      `(() => {
        const s = document.getElementById('settings');
        if (!s || s.hidden) return { hidden: true };
        const box = s.querySelector('.settings-box').getBoundingClientRect();
        const close = document.getElementById('settings-close').getBoundingClientRect();
        return {
          hidden: false,
          width: Math.round(box.width),
          height: Math.round(box.height),
          vw: innerWidth,
          vh: innerHeight,
          closeH: Math.round(close.height),
        };
      })()`,
      false,
    );
    check(
      "M6b 390：设置也是全屏 sheet（宽/高 ≥ 视口-2，关闭按钮 44）",
      settings.hidden === false && settings.width >= settings.vw - 2 && settings.height >= settings.vh - 2 && settings.closeH >= 44,
      settings.hidden ? "settings 未打开" : `settings=${settings.width}×${settings.height} vp=${settings.vw}×${settings.vh} closeH=${settings.closeH}`,
    );
    await evaluate(cdp, `document.getElementById('settings-close').click()`, false);
    await sleep(300);

    // ---- M8 触摸命中区 ----
    const hits = await evaluate(
      cdp,
      `(() => {
        document.getElementById('toggle-sidebar').click();
        const sb = document.querySelector('.sidebar');
        const rows = [...sb.querySelectorAll('[data-role=session-row]')].map((r) => Math.round(r.getBoundingClientRect().height));
        const del = sb.querySelector('[data-role=session-delete]');
        const delRect = del ? del.getBoundingClientRect() : null;
        return {
          rows,
          delOpacity: del ? getComputedStyle(del).opacity : null,
          delW: delRect ? Math.round(delRect.width) : 0,
          delH: delRect ? Math.round(delRect.height) : 0,
        };
      })()`,
      false,
    );
    check(
      "M8 390：会话行 ≥44、删除按钮常显且 44×44",
      hits.rows.length > 0 &&
        hits.rows.every((h) => h >= 44) &&
        hits.delOpacity === "1" &&
        hits.delW >= 44 &&
        hits.delH >= 44,
      `rows=[${hits.rows.join(",")}] del=${hits.delW}×${hits.delH} opacity=${hits.delOpacity}`,
    );

    // ---- M9 Esc 关抽屉 ----
    const drawerOpenNow = await evaluate(cdp, `document.body.dataset.sidebar`, false);
    await pressEscape(cdp);
    const afterEsc = await evaluate(
      cdp,
      `(() => ({ state: document.body.dataset.sidebar, scrim: document.getElementById('sidebar-scrim').hidden }))()`,
      false,
    );
    check(
      "M9 390：Esc 关抽屉（不触发中止）",
      drawerOpenNow === "open" && afterEsc.state === "closed" && afterEsc.scrim === true,
      `before=${drawerOpenNow} after=${afterEsc.state} scrimHidden=${afterEsc.scrim}`,
    );

    // 遮罩点击也关
    await evaluate(cdp, `document.getElementById('toggle-sidebar').click()`, false);
    await sleep(350);
    await evaluate(cdp, `document.getElementById('sidebar-scrim').click()`, false);
    await sleep(350);
    const afterScrim = await evaluate(cdp, `document.body.dataset.sidebar`, false);
    check("M9b 390：点遮罩关抽屉", afterScrim === "closed", `state=${afterScrim}`);

    // ---- 手机截图（抽屉关闭、主会话、composer 可见）----
    await evaluate(cdp, `document.getElementById('log').scrollTop = 0`, false);
    await sleep(400);
    const mobileShot = await shot(cdp, path.join(SHOT_DIR, "ui-mobile-390.png"));
    check("S1 390 截图产出", fs.existsSync(mobileShot) && fs.statSync(mobileShot).size > 0, mobileShot);

    // ================= 768×1024 平板 =================
    await setViewport(cdp, { width: 768, height: 1024, mobile: false, touch: true });
    await sleep(500);
    const tablet = await evaluate(
      cdp,
      `(() => {
        const sb = document.querySelector('.sidebar');
        const sbr = sb.getBoundingClientRect();
        const main = document.querySelector('.main').getBoundingClientRect();
        const log = document.getElementById('log');
        const cs = getComputedStyle(document.getElementById('composer'));
        const cr = document.getElementById('composer').getBoundingClientRect();
        return {
          vw: innerWidth,
          sbRight: Math.round(sbr.right),
          sbWidth: Math.round(sbr.width),
          mainWidth: Math.round(main.width),
          mainLeft: Math.round(main.left),
          logScrollWidth: log.scrollWidth,
          logClientWidth: log.clientWidth,
          composerBottom: Math.round(cr.bottom),
          composerPosition: cs.position,
          vh: innerHeight,
          toggle: getComputedStyle(document.getElementById('toggle-sidebar')).display,
        };
      })()`,
      false,
    );
    check(
      "T1 768：仍是单列（侧栏抽屉在屏外、正文占满宽度）",
      tablet.sbRight <= 0 && tablet.mainWidth >= tablet.vw - 2 && tablet.mainLeft === 0 && tablet.logScrollWidth <= tablet.logClientWidth + 1,
      `sidebarRight=${tablet.sbRight} main=${tablet.mainLeft}+${tablet.mainWidth} vw=${tablet.vw} logOverflow=${tablet.logScrollWidth - tablet.logClientWidth}`,
    );
    check(
      "T2 768：☰ 仍在、Composer 在视口内",
      tablet.toggle !== "none" && tablet.composerBottom <= tablet.vh + 1 && tablet.composerPosition === "sticky",
      `toggle=${tablet.toggle} bottom=${tablet.composerBottom}/${tablet.vh} position=${tablet.composerPosition}`,
    );
    const tabletShot = await shot(cdp, path.join(SHOT_DIR, "ui-tablet-768.png"));
    check("S2 768 截图产出", fs.existsSync(tabletShot) && fs.statSync(tabletShot).size > 0, tabletShot);

    // ================= 1440×900 桌面（B8 不回退） =================
    await setViewport(cdp, { width: 1440, height: 900, mobile: false, touch: false });
    await sleep(700);
    const desktop = await evaluate(
      cdp,
      `(() => {
        const sb = document.querySelector('.sidebar');
        const sbr = sb.getBoundingClientRect();
        const main = document.querySelector('.main').getBoundingClientRect();
        const cs = getComputedStyle(document.getElementById('composer'));
        const toggle = getComputedStyle(document.getElementById('toggle-sidebar')).display;
        return {
          vw: innerWidth,
          vh: innerHeight,
          sidebarLeft: Math.round(sbr.left),
          sidebarWidth: Math.round(sbr.width),
          sidebarVisible: sbr.width > 0 && getComputedStyle(sb).position !== 'fixed',
          mainLeft: Math.round(main.left),
          mainWidth: Math.round(main.width),
          composerPosition: cs.position,
          toggle,
          docScrollWidth: document.documentElement.scrollWidth,
          docClientWidth: document.documentElement.clientWidth,
          logScrollWidth: document.getElementById('log').scrollWidth,
          logClientWidth: document.getElementById('log').clientWidth,
        };
      })()`,
      false,
    );
    check(
      "D1 1440：侧栏仍是固定三栏（左 0、宽 240–360、正文从侧栏右侧开始）",
      desktop.sidebarLeft === 0 &&
        desktop.sidebarVisible &&
        desktop.sidebarWidth >= 240 &&
        desktop.sidebarWidth <= 360 &&
        desktop.mainLeft === desktop.sidebarWidth,
      `sidebar=${desktop.sidebarLeft}+${desktop.sidebarWidth} mainLeft=${desktop.mainLeft} mainW=${desktop.mainWidth}`,
    );
    check(
      "D2 1440：Composer 非 fixed/sticky（桌面布局不变）+ ☰ 不显示",
      desktop.composerPosition !== "fixed" && desktop.composerPosition !== "sticky" && desktop.toggle === "none",
      `position=${desktop.composerPosition} toggle=${desktop.toggle}`,
    );
    check(
      "D3 1440：页面与 #log 均无横向滚动",
      desktop.docScrollWidth <= desktop.docClientWidth + 1 && desktop.logScrollWidth <= desktop.logClientWidth + 1,
      `doc=${desktop.docScrollWidth}/${desktop.docClientWidth} log=${desktop.logScrollWidth}/${desktop.logClientWidth}`,
    );
    const desktopShot = await shot(cdp, path.join(SHOT_DIR, "ui-desktop-1440.png"));
    check("S3 1440 截图产出", fs.existsSync(desktopShot) && fs.statSync(desktopShot).size > 0, desktopShot);

    // 页面无未捕获异常（网络 502 之类不计）
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_|Failed to load resource/.test(String(t)));
    check("E0 全程无未捕获 JS 异常", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");
  } finally {
    try {
      cdp?.close();
    } catch {}
    try {
      edge?.kill("SIGKILL");
    } catch {}
    try {
      bridge.kill("SIGTERM");
    } catch {}
    await sleep(1500);
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
