#!/usr/bin/env node
// B-12「真删除会话（带可撤销备份）」E2E（零第三方依赖，CDP 真实点击）
//
// 取证目标（页面 + 接口 + 磁盘三面对齐，不靠函数返回值）：
//   D0 桥就绪 + 页面可交互；列表 3 条（全部是**夹具**会话）
//   D1 点第 2 条的「删」→ 出现确认框，文案含该会话标题（且没有顺带打开会话）
//   D2 点「取消」→ 模态消失、文件仍在、列表仍 3 条
//   D3 再点「删」→「删除」→ 文件消失、列表变 2 条、
//      backups/deleted-sessions/<YYYYMMDD-HHmmss>/<相对路径> 下有同名备份且字节数一致
//   D4 刷新页面 → 仍 2 条（列表缓存已失效，不复活）
//   D5 越界：DELETE /api/session?path=C:\Windows\win.ini → 403 FORBIDDEN
//      （附带：根内非 .jsonl → 400 BAD_REQUEST）
//   D6 活动会话保护：#new-session + 选目录 + 发一条消息造出「当前会话」（会落盘）→ 对它 DELETE → 409 CONFLICT，
//      且文件仍在磁盘上
//   D7 日志有 session_deleted（路径 + 备份位置），且不含会话正文
//   D8 收尾：停桥、端口释放、pi 子进程不残留、清 fixture、清本次产生的 backups 目录
//
// 铁律：**绝不移动/删除任何真实会话文件**。桥用 PI_SHELL_SESSIONS_DIR 指向
// %TEMP%/pi-shell-delete-fixture/sessions，会话的创建与删除全部发生在夹具里；
// 本脚本只统计/备份这些夹具文件与仓库内 backups/deleted-sessions/<本次时间戳>。
//
// 用法：node scripts/evidence/delete-session-ui.mjs   （固定端口 7829）
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 端口可被门禁顺延：PI_SHELL_DEL_PORT（默认 7829）
const PORT = Number(process.env.PI_SHELL_DEL_PORT || 7829);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-delete-fixture");
const SESSIONS = path.join(OUT_DIR, "sessions");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT = path.join(OUT_DIR, "delete-session.png");
const SHOT_CONFIRM = path.join(OUT_DIR, "delete-session-confirm.png");
const BACKUP_ROOT = path.join(REPO_ROOT, "backups", "deleted-sessions");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 夹具正文（同时作为「日志不得含正文」的检查串）
const BODY_MARK = "夹具正文不该进日志";
const PROMPT_MARK = "只回答两个字：收到（删除脚本）";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具：3 个最小 jsonl（header + 1 user + 1 assistant，标题各不相同）----------

const NOW = Date.now();
// 夹具 header.cwd 必须**不**是系统临时目录：临时 cwd 会被分类为 test，默认列表不返回它
// （bridge/src/origins.mjs · isTempCwd）。这里用仓库根，纯元数据，脚本从不打开会话。
const FIXTURE_CWD = REPO_ROOT;
const FIXTURE = [
  { id: "del-fixture-0001", title: "夹具会话甲", at: NOW - 3000 },
  { id: "del-fixture-0002", title: "夹具会话乙", at: NOW - 2000 },
  { id: "del-fixture-0003", title: "夹具会话丙", at: NOW - 1000 },
];

function writeFixture() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });
  for (const item of FIXTURE) {
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: item.id, timestamp: item.at - 500, cwd: FIXTURE_CWD }),
      JSON.stringify({
        type: "message",
        id: `${item.id}-e1`,
        parentId: null,
        timestamp: item.at,
        message: { role: "user", content: `${item.title}（${BODY_MARK}）` },
      }),
      JSON.stringify({
        type: "message",
        id: `${item.id}-e2`,
        parentId: `${item.id}-e1`,
        timestamp: item.at + 100,
        message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
      }),
    ];
    fs.writeFileSync(path.join(SESSIONS, `${item.id}.jsonl`), lines.join("\n") + "\n", "utf8");
  }
}

const fixturePath = (id) => path.join(SESSIONS, `${id}.jsonl`);
const statSafe = (p) => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};

/** 递归列出备份根下的文件（不存在 → 空） */
function listBackupFiles(root = BACKUP_ROOT) {
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
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

// ---------- bridge ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS, // 会话根 = 夹具（创建与删除都在这里）
      PI_SHELL_LOG_FILE: LOG_FILE,
    },
    // H-15：管道不消费会把桥堵死
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
  return { flat: (data.groups ?? []).flatMap((g) => g.sessions ?? []), groups: data.groups ?? [] };
}

async function deleteViaApi(target) {
  const res = await fetch(`${BASE}/api/session?path=${encodeURIComponent(target)}`, { method: "DELETE" });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

// ---------- Edge + CDP（同 first-load / origin-ui 口径）----------

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
 * 页面还没有弹层（旧版）时退化为原行为（picker=false），不让本脚本假失败。
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
  const modal = document.getElementById('modal');
  const del = document.querySelector('[data-role="session-delete"]');
  return {
    state: document.getElementById('state')?.dataset.state || '',
    version: (document.getElementById('version')?.textContent || '').trim(),
    rows: document.querySelectorAll('[data-role="session-row"]').length,
    rowIds: [...document.querySelectorAll('[data-role="session-row"]')].map((r) => r.dataset.sessionId),
    hasDeleteBtn: !!del,
    deleteBtnInRow: !!document.querySelector('[data-role="session-row"] [data-role="session-delete"]'),
    deleteTitleAttr: del?.title || '',
    modalHidden: modal?.hidden === true,
    modalTitle: (modal?.querySelector('h2')?.textContent || '').trim(),
    modalText: (modal?.querySelector('[data-role="confirm-text"]')?.textContent || '').trim(),
    toast: (document.getElementById('toast')?.textContent || '').trim(),
    toastHidden: document.getElementById('toast')?.hidden === true,
    notice: (document.getElementById('notice')?.textContent || '').trim(),
    noticeHidden: document.getElementById('notice')?.hidden === true,
    meta: (document.getElementById('session-meta')?.textContent || '').trim(),
    currentId: window.__piShell?.currentSessionId ?? null,
    attach: window.__piShell?.attachState ?? null,
    entryCount: document.querySelectorAll('#log [data-role="entries"] > *').length,
  };
})()`;

async function waitRows(cdp, n, ms = 15000) {
  return waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.rows === ${n} ? s : null; })()`, ms);
}

const SELECTORS = {
  row2: '[data-role="session-row"][data-session-id="del-fixture-0002"]',
  del2: '[data-role="session-row"][data-session-id="del-fixture-0002"] [data-role="session-delete"]',
  cancel: '[data-role="confirm-cancel"]',
  confirm: '[data-role="confirm-continue"]',
};

/** 列表默认收起：测试前展开所有分组 */
async function expandAll(cdp) {
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
  writeFixture();

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");
  await assertPortFree();

  const backupsBefore = new Set(listBackupFiles());
  let bridge = null;
  let edge = null;
  let cdp = null;
  let health = null;
  let createdBackupRoots = [];

  try {
    bridge = startBridge();
    health = await waitHealth();
    if (!health) throw new Error(`桥未在 40s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid} · sessionsDir=${SESSIONS}`);

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

    // ---- D0 桥就绪 + 页面 3 条夹具会话 + 每行都有「删」 ----
    await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return (s.version && s.version !== '—') ? s : null; })()`, 25000);
    await expandAll(cdp); // 列表默认收起：先展开分组
    const ready = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return (s.version && s.version !== '—' && s.rows === 3) ? s : null; })()`, 25000);
    const api0 = await getSessions();
    check(
      "D0 页面可交互且列表为 3 条夹具会话，行内有「删」按钮",
      !!ready && ready.hasDeleteBtn && ready.deleteBtnInRow && api0.flat.length === 3 &&
        api0.flat.every((s) => s.path.startsWith(SESSIONS)),
      ready
        ? `rows=${ready.rows} ids=${JSON.stringify(ready.rowIds)} · 行内按钮=${ready.deleteBtnInRow} · API=${api0.flat.length}（全在夹具根内）`
        : "25s 内未渲染出 3 条",
    );
    if (!ready) throw new Error("列表未就绪，后续断言无意义");
    check(
      "D0b 第 2 条按更新时间倒序是 del-fixture-0002（点它才符合「点第 2 条」）",
      ready.rowIds[1] === "del-fixture-0002" && ready.rows === 3,
      `rowIds=${JSON.stringify(ready.rowIds)}`,
    );
    await shot(cdp, SHOT);

    const beforeStat = statSafe(fixturePath("del-fixture-0002"));
    if (!beforeStat) throw new Error("夹具文件缺失：del-fixture-0002.jsonl");

    // ---- D1 点「删」→ 确认框（标题 + 文案含会话标题），且没有顺带打开会话 ----
    const clickDel = await clickElement(cdp, SELECTORS.del2);
    const modal = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return !s.modalHidden ? s : null; })()`, 5000);
    check(
      "D1 点第 2 条的「删」→ 确认框标题「删除会话」+ 文案含该会话标题/时间/可恢复说明",
      clickDel.hit === true && !!modal && modal.modalTitle === "删除会话" &&
        modal.modalText.includes("夹具会话乙") && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(modal.modalText) &&
        /backups\/deleted-sessions/.test(modal.modalText),
      modal ? `标题「${modal.modalTitle}」· 文案「${modal.modalText}」` : "5s 内没有确认框",
    );
    check(
      "D1b 点「删」没有顺带打开会话（currentId 仍为空 / 对话区仍空）",
      !!modal && modal.currentId === null && modal.entryCount === 0 && modal.meta === "",
      modal ? `currentId=${modal.currentId} · entries=${modal.entryCount} · meta「${modal.meta}」` : "无确认框",
    );
    await shot(cdp, SHOT_CONFIRM);

    // ---- D2 点「取消」→ 文件仍在、列表仍 3 条 ----
    const clickCancel = await clickElement(cdp, SELECTORS.cancel);
    const afterCancel = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return s.modalHidden ? s : null; })()`, 5000);
    const cancelStat = statSafe(fixturePath("del-fixture-0002"));
    check(
      "D2 点「取消」→ 模态消失、夹具文件仍在、列表仍 3 条",
      clickCancel.hit === true && !!afterCancel && afterCancel.rows === 3 && !!cancelStat && cancelStat.size === beforeStat.size,
      `rows=${afterCancel?.rows} · 文件存在=${!!cancelStat} · 字节 ${cancelStat?.size}/${beforeStat.size}`,
    );

    // ---- D3 再点「删」→「删除」→ 文件消失、列表 2 条、备份同名同字节 ----
    const targetFile = fixturePath("del-fixture-0002");
    const sizeBefore = beforeStat.size;
    const clickDel2 = await clickElement(cdp, SELECTORS.del2);
    await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return !s.modalHidden ? s : null; })()`, 5000);
    const clickConfirm = await clickElement(cdp, SELECTORS.confirm);
    const gone = await waitFor(cdp, `(() => { const s = ${PAGE_STATE}; return (s.rows === 2 && s.toast.includes('已删除')) ? s : null; })()`, 15000);
    const afterStat = statSafe(targetFile);
    const api1 = await getSessions();

    const newBackups = listBackupFiles().filter((p) => !backupsBefore.has(p));
    const backupHit = newBackups.find((p) => path.basename(p) === "del-fixture-0002.jsonl") ?? null;
    createdBackupRoots = [...new Set(newBackups.map((p) => path.dirname(p)))];
    const backupStat = backupHit ? statSafe(backupHit) : null;
    const tsSegment = backupHit ? path.relative(BACKUP_ROOT, backupHit).split(path.sep)[0] : "";

    check(
      "D3 点「删除」→ 原文件消失 + 列表变 2 条 + toast 显示备份位置",
      clickDel2.hit === true && clickConfirm.hit === true && !!gone && afterStat === null &&
        api1.flat.length === 2 && !api1.flat.some((s) => s.id === "del-fixture-0002") &&
        gone.toast.includes("已删除（备份："),
      `文件存在=${!!afterStat} · rows=${gone?.rows} · API=${api1.flat.length} · toast「${gone?.toast}」`,
    );
    check(
      "D3b backups/deleted-sessions/<YYYYMMDD-HHmmss>/ 下有同名备份且字节数一致",
      !!backupHit && /^\d{8}-\d{6}(-\d+)?$/.test(tsSegment) && backupStat?.size === sizeBefore &&
        backupHit.startsWith(path.join(BACKUP_ROOT, tsSegment)),
      backupHit
        ? `${path.relative(REPO_ROOT, backupHit)} · ${backupStat?.size}/${sizeBefore} 字节 · ts=${tsSegment}`
        : `未找到本次新增备份（新增 ${newBackups.length} 个）`,
    );

    // ---- D4 刷新页面 → 仍 2 条（缓存已失效，不复活） ----
    await cdp.send("Page.reload", { ignoreCache: false });
    await expandAll(cdp); // 刷新后默认收起：先展开再数
    const afterReload = await waitRows(cdp, 2, 25000);
    const api2 = await getSessions();
    check(
      "D4 刷新页面后仍为 2 条（列表缓存失效，已删会话不复活）",
      !!afterReload && afterReload.rows === 2 && api2.flat.length === 2,
      afterReload ? `rows=${afterReload.rows} · API=${api2.flat.length}` : "刷新后 25s 内不是 2 条",
    );

    // ---- D5 越界 403 / 根内非 .jsonl 400 ----
    const forbidden = await deleteViaApi("C:\\Windows\\win.ini");
    const winStat = statSafe("C:\\Windows\\win.ini");
    const notJsonl = await deleteViaApi(path.join(SESSIONS, "not-a-session.txt"));
    check(
      "D5 越界 DELETE C:\\Windows\\win.ini → 403 FORBIDDEN（且文件未被碰）",
      forbidden.status === 403 && forbidden.body?.error?.code === "FORBIDDEN" && !!winStat,
      `HTTP ${forbidden.status} · code=${forbidden.body?.error?.code} · win.ini 仍在=${!!winStat}`,
    );
    check(
      "D5b 会话根内非 .jsonl → 400 BAD_REQUEST",
      notJsonl.status === 400 && notJsonl.body?.error?.code === "BAD_REQUEST",
      `HTTP ${notJsonl.status} · code=${notJsonl.body?.error?.code}`,
    );

    // ---- D6 活动会话保护：#new-session + 发一条消息 → 当前会话落盘 → DELETE → 409 ----
    // 必须等「新会话真的建完」再发消息：D4 之后 rows 已经是 2，用 rows===2 当等待条件等于不等，
    // prompt 会和 /api/session/new 抢时序（实测 pi 侧会把这一轮取消掉 → 会话不落盘 → D6 假失败）。
    // 这里改用磁盘真相：桥日志里 session_created 出现新的一行。
    const countCreated = () => {
      const text = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
      return (text.match(/\|session_created\|/g) || []).length;
    };
    const createdBefore = countCreated();
    // A1：先选目录 → 确认后才 POST /api/session/new。
    // 这里刻意选「桥自己的 cwd」（health.pi.cwd），与 A1 之前的行为等价：D6 验的是活动会话保护，
    // 不是切 cwd（切 cwd 的页面路径由 scripts/evidence/new-session-dir-ui.mjs 取证）。
    const pickerNew = await newSessionInDir(cdp, health.pi.cwd);
    if (!pickerNew.gone) throw new Error(`选目录弹层未关闭（confirm=${pickerNew.confirm}）`);
    for (let i = 0; i < 80 && countCreated() <= createdBefore; i++) await sleep(250);
    await sleep(500); // 新会话落地后回到 idle 再发消息
    await clickElement(cdp, "#input");
    await cdp.send("Input.insertText", { text: PROMPT_MARK });
    await pressCtrlEnter(cdp);

    let attached = null;
    for (let i = 0; i < 120 && !attached; i++) {
      const { flat } = await getSessions();
      attached = flat.find((s) => s.status === "attached" && fs.existsSync(s.path)) ?? null;
      if (!attached) await sleep(500);
    }
    let conflict = { status: 0, body: null };
    let attachedStill = null;
    if (attached) {
      conflict = await deleteViaApi(attached.path);
      attachedStill = statSafe(attached.path);
    }
    const attachedInFixture = !!attached && attached.path.startsWith(SESSIONS);
    check(
      "D6 对当前已附着会话 DELETE → 409 CONFLICT「请先中止或切走」，文件仍在",
      !!attached && attachedInFixture && conflict.status === 409 && conflict.body?.error?.code === "CONFLICT" &&
        /请先中止或切走/.test(conflict.body?.error?.message || "") && !!attachedStill,
      attached
        ? `当前会话 ${attached.id.slice(0, 8)} · 落盘在夹具内=${attachedInFixture} · HTTP ${conflict.status} · code=${conflict.body?.error?.code} · 文件仍在=${!!attachedStill}`
        : "120 次轮询内没有出现 attached 会话（无法验证保护路径）",
    );

    // ---- D7 日志：session_deleted 有路径与备份位置，且不含正文 ----
    const logText = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
    const deleteLines = logText.split("\n").filter((l) => l.includes("session_deleted"));
    const deletedLog = deleteLines.find((l) => l.includes("del-fixture-0002.jsonl")) ?? null;
    check(
      "D7 日志有 session_deleted（含原路径 + 备份位置），且不含会话正文",
      !!deletedLog && deletedLog.includes("backup=") && deletedLog.includes("deleted-sessions") &&
        !logText.includes(BODY_MARK) && !logText.includes("夹具会话乙（"),
      deletedLog ? deletedLog.slice(0, 260) : `未找到 session_deleted 行（共 ${deleteLines.length} 行）`,
    );

    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("D7b 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0,
      realErrors.length ? realErrors.slice(0, 3).join(" | ") : "无");
  } finally {
    try { cdp?.close(); } catch {}
    try { edge?.kill("SIGKILL"); } catch {}
    try { bridge?.kill("SIGTERM"); } catch {}
    await sleep(1500);
    if (health?.pi?.pid) { try { process.kill(health.pi.pid, "SIGKILL"); } catch {} }
    await sleep(500);

    // ---- D8 收尾：端口释放 + pi 不残留 ----
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
    check("D8 收尾：端口已释放、pi 子进程不残留", portFree && piGone,
      `port ${PORT} free=${portFree} · pi pid ${health?.pi?.pid} gone=${piGone}`);

    // 清 fixture（含 pi 在夹具根里新建的那个「当前会话」）
    await fsp.rm(SESSIONS, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true }).catch(() => {});

    // 清本次测试产生的备份目录（只删本脚本新增的那些，<ts> 目录整棵；真实 backups 一概不动）
    let removed = 0;
    for (const dir of createdBackupRoots) {
      if (!dir.startsWith(BACKUP_ROOT + path.sep)) continue;
      const ts = path.relative(BACKUP_ROOT, dir).split(path.sep)[0];
      if (!/^\d{8}-\d{6}(-\d+)?$/.test(ts)) continue; // 只认备份时间戳目录，防手滑
      const whole = path.join(BACKUP_ROOT, ts);
      await fsp.rm(whole, { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
    const leftovers = listBackupFiles().filter((p) => !backupsBefore.has(p));
    check("D8b 收尾：fixture 目录已清、本次产生的 backups 目录已清", !fs.existsSync(SESSIONS) && leftovers.length === 0,
      `fixture 存在=${fs.existsSync(SESSIONS)} · 残留备份=${leftovers.length} · 清理目录 ${removed} 个`);
  }

  await fsp.rm(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true }).catch(() => {});
  console.log(`      日志：${LOG_FILE}`);
  console.log(`      截图：${SHOT}\n            ${SHOT_CONFIRM}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
