#!/usr/bin/env node
// F-12 前端「Diff」面板 E2E（零第三方依赖，CDP 真实点击）
//
// 为什么存在：后端 /api/git/diff（T-18）早已实现，但前端口径从没调用过；
// 而且工作区默认用户主目录（~）通常不是 git 仓库，直接调必然是 available:false。
// 本脚本用「临时 git 仓库」做真实证据：
//   D1 头部 ⋯ 里有 #open-diff，真实鼠标点中（elementFromPoint 证明没被遮挡）；
//      B8 后入口收进 ⋯，所以先点 #open-menu 展开（产品刻意行为，非缺陷）
//   D2 面板可见，标题含仓库名
//   D3 status 行 == `git status --porcelain` 原文（同一仓库跑同一命令比对）
//   D4 stat 文本 == `git diff --stat` 输出
//   D5 patch 含 --- a/a.txt / +++ b/a.txt
//   D6 非 git 仓库（PI_SHELL_CWD=~）→ 「不是 git 仓库」提示
//   D7 越界 cwd → 403 FORBIDDEN；白名单内 cwd / 默认 cwd → 200
//   截图存档到临时目录
//
// 用法：node scripts/evidence/git-diff-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部通过

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT_REPO = 7817;
const PORT_PLAIN = 7818;
const BASE_REPO = `http://127.0.0.1:${PORT_REPO}`;
const BASE_PLAIN = `http://127.0.0.1:${PORT_PLAIN}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-gitdiff");
const REPO_DIR = path.join(OUT_DIR, "repo");
const SESSIONS = path.join(OUT_DIR, "sessions");
const SHOT = path.join(OUT_DIR, "diff-panel.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- git（临时仓库，绝不碰 pi-shell 自身）----------

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).trim()), { code: err.code }));
      else resolve(String(stdout));
    });
  });
}

async function makeRepo() {
  await fsp.mkdir(REPO_DIR, { recursive: true });
  await git(["-c", "init.defaultBranch=main", "init"], REPO_DIR);
  await fsp.writeFile(path.join(REPO_DIR, "a.txt"), "line1\n", "utf8");
  await git(["add", "a.txt"], REPO_DIR);
  // 本机可能没配 user.name/email，也可能开了 commit.gpgsign → 显式覆盖
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-m", "init"], REPO_DIR);
  // 未提交改动：改一个已跟踪文件 + 新增一个未跟踪文件
  await fsp.writeFile(path.join(REPO_DIR, "a.txt"), "line1\nline2\n", "utf8");
  await fsp.writeFile(path.join(REPO_DIR, "b.txt"), "bee\n", "utf8");
}

// ---------- bridge ----------

function startBridge({ port, cwd, logName }) {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(port),
      PI_SHELL_CWD: cwd,
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_LOG_FILE: path.join(OUT_DIR, logName),
    },
    // H-15：子进程 stdio 必须 ignore/inherit，接管道不消费会把桥堵死
    stdio: "ignore",
  });
}

async function waitHealth(base, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const body = await (await fetch(`${base}/api/health`, { cache: "no-store" })).json();
      if (body?.ok && body?.pi?.version) return body;
    } catch {}
    await sleep(300);
  }
  return null;
}

async function assertPortFree(base) {
  try {
    await fetch(`${base}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${base} 上已有实例在跑，本脚本必须独占端口（避免给出假证据）`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }
}

// ---------- Edge + CDP（同 first-load.mjs 口径：真实鼠标事件 + elementFromPoint）----------

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
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 120000 });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function launchEdge(edgePath, url) {
  const debugPort = PORT_REPO + 1000;
  const edge = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(OUT_DIR, "edge-profile")}`,
    "--window-size=1440,900",
    url,
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
  const st = (document.getElementById('state')?.textContent || '').trim();
  return { version: v, state: st, input: !!document.getElementById('input'),
           cwd: (document.getElementById('cwd')?.textContent || '').trim() };
})()`;

async function waitPageReady(cdp, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await evaluate(cdp, READY, false).catch(() => null);
    if (s?.input && s.version && s.version !== "—") return s;
    await sleep(200);
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
    return { x, y, ok };
  })()`, false);
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
}

/**
 * B8 视觉重设计后，Diff 入口从顶栏平铺按钮收进 ⋯（#overflow-menu，默认 hidden）。
 * 这是刻意的产品行为：顶栏可见入口收敛为 8 个，Diff 属低频诊断入口。
 * 所以点 #open-diff 之前必须先点 ⋯ 展开菜单（沿用真实鼠标事件，不改为 el.click()）。
 * 判定语义不变：仍然要求 elementFromPoint 命中目标元素（没被遮挡）。
 */
async function openOverflowMenu(cdp) {
  const r = await clickElement(cdp, "#open-menu");
  if (!r.hit) return { hit: false, step: "open-menu", ...r };
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const open = await evaluate(cdp, `(() => {
      const m = document.getElementById('overflow-menu');
      return !!m && m.hidden === false;
    })()`, false).catch(() => false);
    if (open) return { hit: true };
    await sleep(100);
  }
  return { hit: false, step: "menu-not-open" };
}

/** 展开 ⋯ → 点 Diff；返回真实命中结果（两步任一没命中都算没点中） */
async function clickDiffEntry(cdp) {
  const menu = await openOverflowMenu(cdp);
  if (!menu.hit) return { hit: false, via: "open-menu", detail: menu };
  const r = await clickElement(cdp, "#open-diff");
  return { ...r, via: "overflow-menu" };
}

/** 等面板里出现某个 data-role 节点（fetch 还没回来时不误判） */
async function waitRole(cdp, role, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const has = await evaluate(cdp, `!!document.querySelector('[data-role="${role}"]')`, false).catch(() => false);
    if (has) return true;
    await sleep(150);
  }
  return false;
}

const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n");

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });

  try {
    await git(["--version"], REPO_ROOT);
  } catch {
    throw new Error("找不到可用的 git（本脚本需要本地 git 建临时仓库）");
  }
  await assertPortFree(BASE_REPO);
  await assertPortFree(BASE_PLAIN);

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  await makeRepo();
  const expectedStatus = (await git(["status", "--porcelain"], REPO_DIR)).split("\n").filter(Boolean);
  const expectedStat = await git(["diff", "--stat"], REPO_DIR);

  const bridgeRepo = startBridge({ port: PORT_REPO, cwd: REPO_DIR, logName: "bridge-7817.log" });
  let bridgePlain = null;
  let edge = null;
  let cdp = null;
  let healthRepo = null;
  let healthPlain = null;

  try {
    healthRepo = await waitHealth(BASE_REPO);
    if (!healthRepo) throw new Error(`桥（${BASE_REPO}）未在 30s 内就绪（看 ${path.join(OUT_DIR, "bridge-7817.log")}）`);
    console.log(`      repo bridge ready · pi ${healthRepo.pi.version} · cwd ${healthRepo.pi.cwd}`);

    const launched = await launchEdge(edgePath, `${BASE_REPO}/`);
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

    // ---- D1 头部有 Diff 按钮，真实点中 ----
    const ready = await waitPageReady(cdp);
    check("D0 页面可交互（version 已回填）", !!ready, ready ? `pi=${ready.version} state=${ready.state} cwd=${ready.cwd}` : "25s 未就绪");
    await sleep(600);
    const hasBtn = await evaluate(cdp, `(() => {
      const b = document.getElementById('open-diff');
      return b ? { text: b.textContent.trim(), title: b.title } : null;
    })()`, false);
    check("D1 头部有 #open-diff（文字 Diff / title Git diff（只读））",
      hasBtn?.text === "Diff" && /Git diff（只读）/.test(hasBtn.title),
      hasBtn ? `text=${hasBtn.text} title=${hasBtn.title}` : "按钮不存在");

    const click = await clickDiffEntry(cdp);
    const gotStatus = await waitRole(cdp, "git-status-row");
    check("D1b 真实鼠标点中 #open-diff（先展开 ⋯；未被遮挡）", click.hit === true, `hit=${click.hit} via=${click.via}`);
    check("D2 面板可见且标题含仓库名", gotStatus, `title=${await evaluate(cdp, `document.getElementById('panel-title').textContent`, false)}`);

    const panel = await evaluate(cdp, `(() => {
      const p = document.getElementById('panel');
      return { display: getComputedStyle(p).display, title: document.getElementById('panel-title').textContent };
    })()`, false);
    check("D2b 面板 display ≠ none；标题含 repo", panel.display !== "none" && panel.title.includes("repo"),
      `display=${panel.display} title=${panel.title}`);

    // ---- D3 status 行 == git status --porcelain ----
    const statusRows = await evaluate(cdp, `[...document.querySelectorAll('[data-role="git-status-row"]')].map((el) => el.textContent)`, false);
    check("D3 status 行集合 == git status --porcelain 输出",
      JSON.stringify(statusRows) === JSON.stringify(expectedStatus),
      `UI=${JSON.stringify(statusRows)} / git=${JSON.stringify(expectedStatus)}`);

    // ---- D4 stat 文本 == git diff --stat ----
    const statText = await evaluate(cdp, `(document.querySelector('[data-role="git-diff-stat"]') || {}).textContent || ""`, false);
    check("D4 stat 文本 == git diff --stat 输出", norm(statText) === norm(expectedStat),
      `UI=${JSON.stringify(norm(statText))} / git=${JSON.stringify(norm(expectedStat))}`);

    // ---- D5 patch 内容 ----
    const patchText = await evaluate(cdp, `(document.querySelector('[data-role="git-diff-patch"]') || {}).textContent || ""`, false);
    check("D5 patch 含 --- a/a.txt 与 +++ b/a.txt",
      patchText.includes("--- a/a.txt") && patchText.includes("+++ b/a.txt"),
      `len=${patchText.length}`);

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
    console.log(`      截图：${SHOT}`);

    // ---- D6 非 git 仓库 ----
    bridgePlain = startBridge({ port: PORT_PLAIN, cwd: os.homedir(), logName: "bridge-7818.log" });
    healthPlain = await waitHealth(BASE_PLAIN);
    if (!healthPlain) throw new Error(`非仓库桥（${BASE_PLAIN}）未在 30s 内就绪（看 ${path.join(OUT_DIR, "bridge-7818.log")}）`);

    await cdp.send("Page.navigate", { url: `${BASE_PLAIN}/` });
    const ready2 = await waitPageReady(cdp);
    await sleep(600);
    const click2 = await clickDiffEntry(cdp);
    const gotUnavailable = await waitRole(cdp, "git-diff-unavailable");
    const unavailable = await evaluate(cdp, `(() => {
      const el = document.querySelector('[data-role="git-diff-unavailable"]');
      return el ? { text: el.textContent, hasStatus: !!document.querySelector('[data-role="git-status-row"]') } : null;
    })()`, false);
    check("D6 非 git 仓库 → 「不是 git 仓库」提示（且无 status 行）",
      !!ready2 && click2.hit === true && gotUnavailable && !!unavailable && /不是 git 仓库/.test(unavailable.text) && !unavailable.hasStatus,
      unavailable ? unavailable.text : "提示未出现");

    // ---- D7 后端白名单 ----
    const denied = await fetch(`${BASE_REPO}/api/git/diff?cwd=${encodeURIComponent("C:\\Windows")}`, { cache: "no-store" });
    const deniedBody = await denied.json().catch(() => ({}));
    check("D7a 越界 cwd → 403 FORBIDDEN", denied.status === 403 && deniedBody?.error?.code === "FORBIDDEN",
      `status=${denied.status} code=${deniedBody?.error?.code}`);

    const allowed = await fetch(`${BASE_REPO}/api/git/diff?cwd=${encodeURIComponent(REPO_DIR)}`, { cache: "no-store" });
    const allowedBody = await allowed.json().catch(() => ({}));
    check("D7b 工作区根 cwd → 200 且回显 cwd", allowed.status === 200 && allowedBody?.available === true && norm(allowedBody?.cwd).toLowerCase() === REPO_DIR.toLowerCase(),
      `status=${allowed.status} cwd=${allowedBody?.cwd} available=${allowedBody?.available}`);

    const dflt = await fetch(`${BASE_REPO}/api/git/diff`, { cache: "no-store" });
    const dfltBody = await dflt.json().catch(() => ({}));
    check("D7c 不带 cwd → 200（默认工作区根）", dflt.status === 200 && norm(dfltBody?.cwd).toLowerCase() === REPO_DIR.toLowerCase(),
      `status=${dflt.status} cwd=${dfltBody?.cwd}`);

    // ---- 页面无 JS 异常 ----
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("D8 全程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0,
      realErrors.length ? realErrors.slice(0, 3).join(" | ") : "无");
  } finally {
    try { cdp?.close(); } catch {}
    try { edge?.kill("SIGKILL"); } catch {}
    try { bridgeRepo.kill("SIGTERM"); } catch {}
    try { bridgePlain?.kill("SIGTERM"); } catch {}
    await sleep(1500);
    for (const h of [healthRepo, healthPlain]) {
      if (h?.pi?.pid) { try { process.kill(h.pi.pid, "SIGKILL"); } catch {} }
    }
    for (const pid of [healthRepo?.pi?.pid, healthPlain?.pi?.pid]) {
      if (!pid) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    // 只删临时仓库，保留截图与日志（证据）
    await fsp.rm(REPO_DIR, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
