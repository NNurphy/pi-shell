#!/usr/bin/env node
// P0 前端证据：重连必须重新接管会话 + 模型跟回 + 身份不明要拦住
//
// 事故（2026-11-14，同一根因）：页面离开/断网 → 引擎被 idle-sweep 回收 → 回来重连，
// 桥起了一个新引擎 + 空会话（cwd=家目录），页面仍显示旧历史 → 看起来连续、实际 AI 失忆，
// 模型也退回默认。用户要求：这种场景下会话必须连续。
//
// 做法：真 pi + **夹具会话目录**（从 ~/.pi/agent/sessions 只读复制一条会话）+ 真 Edge（CDP）。
//   1) 页面打开夹具会话，记下消息数（.jsonl 行数）与 cwd；
//   2) 用真实用户路径改模型/思考级别（顶栏 select change）→ 记下「本列意图」；
//   3) 断开本列 SSE 且**不自动重连**（模拟页面离开/长时间断网）→ 等 idle-sweep 回收引擎（engine_swept）；
//   4) __piShell.reconnect()（与用户点「重试」同一个入口）→ 前端自动重新接管；
//   5) 断言：#ws-path == 会话 cwd、顶栏模型 == 会话模型/本列意图、notice 有「已恢复上次会话」、
//      日志 engine_restored；发一条消息后**原会话文件增长**，且家目录映射的 --C--Users-user-- 下没有新会话；
//   6) 反例（身份不明）：把会话文件删掉再让前端「身份未知」→ 发送被拦住并提示「未能确认当前会话」
//      （输入框内容保留，不许把消息发进空会话）。
//
// 纪律：端口固定 7838（被占直接 FAIL，不换端口）；PI_SHELL_IDLE_MS=3000；
//       不碰真实会话目录（只读复制一条）；收尾按 PID 关自己起的桥/浏览器，夹具目录整个删掉。
//
// 用法：node scripts/evidence/reconnect-restore-ui.mjs        （EDGE_PATH 可指定 msedge.exe）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRIDGE_ENTRY = path.join(ROOT, "bridge", "src", "index.mjs");
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SESSIONS_ROOT = path.join(AGENT_DIR, "sessions");
const PORT = 7838;
const DEBUG_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_MS = 3000;
const HOME = os.homedir(); // PI_SHELL_CWD：事故里「空会话」会落在它的映射目录 --C--Users-user--
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const norm = (p) => String(p || "").trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
const samePath = (a, b) => typeof a === "string" && typeof b === "string" && a && b && norm(a) === norm(b);
const lineCount = (file) => {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split("\n").filter((l) => l.trim()).length;
  } catch {
    return -1;
  }
};

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function api(pathname, { method = "GET", client = null, body } = {}) {
  const headers = {};
  if (client) headers["x-pi-shell-client"] = client;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function waitFor(fn, ms, step = 200) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last?.ok) return last;
    await sleep(step);
  }
  return last ?? { ok: false };
}

/** 会话根下找一条「header cwd 仍然存在」的真实会话（只读，按 mtime 从新到旧；避开 HOME） */
function pickSourceSession(excludeCwd = null) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(SESSIONS_ROOT, 0);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    try {
      const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
      if (typeof header?.cwd !== "string" || !header.cwd) continue;
      if (excludeCwd && samePath(header.cwd, excludeCwd)) continue; // 夹具 cwd 必须 ≠ 初始工作区
      if (!fs.statSync(header.cwd).isDirectory()) continue;
      return { file, cwd: header.cwd };
    } catch {
      // 坏文件/被移动的会话：跳过
    }
  }
  return null;
}

/** pi 的会话目录名：非字母数字逐字换 '-'，首尾各包一层 '--'（C:\Users\user → --C--Users-user--） */
function sessionsDirNameForCwd(cwd) {
  return `--${String(cwd).replace(/[^A-Za-z0-9]/g, "-")}--`;
}

// ---------- Edge + CDP（同 first-load / session-header-follow-ui 口径） ----------

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

async function evaluate(cdp, expression, awaitPromise = false) {
  const call = cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 120000 });
  const res = await Promise.race([
    call,
    sleep(45000).then(() => {
      throw new Error("evaluate 超时 45000ms");
    }),
  ]);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function waitEval(cdp, expr, ms = 20000, interval = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await evaluate(cdp, expr).catch(() => null);
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/** 真实回车（Ctrl+Enter 才会发送：项目是终端习惯，Enter 只换行） */
async function pressEnter(cdp, modifiers = 0) {
  const base = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers,
    text: "\r",
    unmodifiedText: "\r",
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers,
  });
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

const READY = `(() => {
  const v = (document.getElementById('version')?.textContent || '').trim();
  return { version: v, input: !!document.getElementById('input'), state: (document.getElementById('state')?.textContent || '').trim() };
})()`;

const PAGE_PROBE = `(() => {
  const sel = document.getElementById('model-select');
  const think = document.getElementById('thinking-select');
  const notice = document.querySelector('[data-role=notice]');
  const ws = document.getElementById('ws-path');
  const st = window.__piShell?.reconnectState ?? null;
  return {
    version: (document.getElementById('version')?.textContent || '').trim(),
    state: (document.getElementById('state')?.textContent || '').trim(),
    clientId: window.__piShell?.columnClientId ?? null,
    column: window.__piShell?.columns?.() ?? [],
    activeColumnKey: window.__piShell?.activeColumnKey ?? null,
    sessionId: window.__piShell?.currentSessionId ?? null,
    attachState: window.__piShell?.attachState ?? null,
    prefs: window.__piShell?.sessionPrefs ?? null,
    modelValue: sel ? sel.value : null,
    modelCurrent: sel ? (sel.dataset.current ?? null) : null,
    modelUnavailable: sel ? (sel.dataset.unavailable ?? null) : null,
    modelOptions: sel ? [...sel.options].map((o) => o.value) : [],
    thinkingValue: think ? think.value : null,
    thinkingCurrent: think ? (think.dataset.current ?? null) : null,
    thinkingOptions: think ? [...think.options].map((o) => o.value) : [],
    wsText: ws ? (ws.textContent || '').trim() : null,
    wsTitle: ws ? (ws.title || '') : null,
    notice: notice ? (notice.textContent || '').trim() : null,
    restoredTag: (document.querySelector('.session-bar [data-role=restored]')?.textContent || '').trim(),
    noticeKind: notice ? (notice.dataset.kind ?? null) : null,
    reconnectVisible: document.querySelector('[data-role=reconnect]')?.hidden === false,
    attachText: (document.querySelector('[data-role=attach-text]')?.textContent || '').trim(),
    attachRetryHidden: document.querySelector('[data-role=attach-banner] .attach-retry')?.hidden !== false,
    attachBannerHidden: document.querySelector('[data-role=attach-banner]')?.hidden !== false,
    reconnectText: (document.querySelector('[data-role=reconnect-text]')?.textContent || '').trim(),
    input: document.getElementById('input')?.value ?? null,
    users: document.querySelectorAll('#log .msg-user').length,
    restoredMark: st?.restoredMark ?? "",
    notices: st,
  };
})()`;

// ---------- 主流程 ----------

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-reconnect-ui-")));
let bridge = null;
let edge = null;
let cdp = null;
let exitCode = 1;

try {
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（不换端口，先清掉占用者）`);
  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const source = pickSourceSession(HOME);
  if (!source) throw new Error(`找不到可用会话：${SESSIONS_ROOT}（可读且 header.cwd 存在）`);
  const sessionCwd = source.cwd;
  check("挑到夹具来源会话", true, `${path.basename(source.file)} → cwd=${sessionCwd}`);

  const sessionsDir = path.join(tmpRoot, "sessions");
  const fixtureDir = path.join(sessionsDir, path.basename(path.dirname(source.file)));
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixtureSession = path.join(fixtureDir, path.basename(source.file));
  await fsp.copyFile(source.file, fixtureSession);
  const linesBefore = lineCount(fixtureSession);
  check("夹具会话已复制（只读复制，不碰真实目录）", linesBefore > 0, `${path.basename(fixtureSession)} · ${linesBefore} 行`);
  check("初始工作区（PI_SHELL_CWD）≠ 会话 cwd", !samePath(HOME, sessionCwd), `${HOME} vs ${sessionCwd}`);

  const mcpConfig = path.join(tmpRoot, "pi-shell-mcp.json");
  fs.writeFileSync(mcpConfig, `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");
  const logFile = path.join(tmpRoot, "logs", "bridge.log");
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");

  bridge = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_AGENT_DIR: AGENT_DIR,
      PI_SHELL_SESSIONS_DIR: sessionsDir,
      PI_SHELL_AGENT_SESSIONS_DIR: "",
      PI_SHELL_MCP_CONFIG: mcpConfig,
      PI_SHELL_ORIGINS_FILE: path.join(tmpRoot, "sessions-origins.json"),
      PI_SHELL_LOG_DIR: path.join(tmpRoot, "logs"),
      PI_SHELL_LOG_FILE: logFile,
      PI_SHELL_CWD: HOME,
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_IDLE_MS: String(IDLE_MS),
    },
    // H-15：子进程 stdio 必须 ignore/inherit，接管道不消费会把桥堵死
    stdio: "ignore",
  });

  const ready = await waitFor(async () => {
    try {
      const { status, json } = await api("/api/health");
      return { ok: status === 200 && json?.pi?.state === "idle", json };
    } catch {
      return { ok: false };
    }
  }, 60000);
  check("桥就绪（pi idle）", ready.ok, `pi.state=${ready.json?.pi?.state ?? "n/a"} pid=${ready.json?.pi?.pid ?? "n/a"}`);
  if (!ready.ok) throw new Error("桥未就绪，后续断言无意义");

  // ---- 起 Edge（真浏览器，headless） ----
  fs.rmSync(path.join(tmpRoot, "edge-profile"), { recursive: true, force: true });
  edge = spawn(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${path.join(tmpRoot, "edge-profile")}`,
      "--window-size=1440,900",
      `${BASE}/`,
    ],
    { stdio: "ignore" },
  );

  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge CDP 未就绪");
  cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const pageReady = await waitEval(
    cdp,
    `(() => { const r = ${READY}; return r.input && r.version && r.version !== '—' ? r : null; })()`,
    30000,
  );
  check("页面可交互（版本号已就绪）", Boolean(pageReady), pageReady ? `version=${pageReady.version}` : "超时");

  let probe = await evaluate(cdp, PAGE_PROBE);
  const clientId = probe.clientId;
  check("拿到本列引擎标识", typeof clientId === "string" && clientId.includes("#"), String(clientId));

  // 1) 打开夹具会话（与左侧列表点击同一个入口 → col.openSession）
  await evaluate(cdp, `window.__piShell.openPath(${JSON.stringify(fixtureSession)})`, true);
  const opened = await waitEval(
    cdp,
    `(() => {
      const st = window.__piShell;
      return st.attachState === 'attached' && st.currentSessionId ? ${PAGE_PROBE} : null;
    })()`,
    60000,
  );
  check("打开夹具会话并接管完成", Boolean(opened) && opened.attachState === "attached", opened ? `sessionId=${opened.sessionId}` : "超时");
  if (!opened) throw new Error("夹具会话未接管，后续断言无意义");
  const sessionId = opened.sessionId;
  check("#ws-path == 会话 header cwd", samePath(opened.wsTitle, sessionCwd), `title=${opened.wsTitle} 期望=${sessionCwd}`);

  // 2) 真实用户路径改模型 / 思考级别（记下「本列意图」）
  const modelList = (await api(`/api/models?client=${encodeURIComponent(clientId)}`)).json?.models ?? [];
  const currentModel = opened.modelValue;
  const targetModel =
    modelList.map((m) => `${m.provider}/${m.id}`).find((v) => v !== currentModel && /deepseek/i.test(v)) ??
    modelList.map((m) => `${m.provider}/${m.id}`).find((v) => v !== currentModel) ??
    null;
  if (!targetModel) throw new Error(`模型清单里没有可切换的第二个模型（当前 ${currentModel}）`);
  const modelOptionsReady = await waitEval(
    cdp,
    `(() => [...document.getElementById('model-select').options].some((o) => o.value === ${JSON.stringify(targetModel)}))()`,
    30000,
  );
  check("顶栏模型下拉已装好本列候选清单", Boolean(modelOptionsReady), `目标 ${targetModel}`);
  await evaluate(
    cdp,
    `(() => {
      const sel = document.getElementById('model-select');
      const opt = [...sel.options].find((o) => o.value === ${JSON.stringify(targetModel)});
      if (!opt) return false;
      sel.value = ${JSON.stringify(targetModel)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  const modelApplied = await waitEval(
    cdp,
    `(() => { const r = ${PAGE_PROBE}; return r.prefs?.model === ${JSON.stringify(targetModel)} ? r : null; })()`,
    30000,
  );
  // 顶栏可能被「上一列 session/view 缓存」延迟回填（既有 B1/T6 行为，不属本切片）→ 强制一次权威同步再断言
  await evaluate(cdp, `window.__piShell.syncHeader({ force: true })`, true).catch(() => {});
  const headerApplied = await waitEval(
    cdp,
    `(() => { const r = ${PAGE_PROBE}; return r.modelValue === ${JSON.stringify(targetModel)} ? r : null; })()`,
    20000,
  );
  check(
    "改模型（顶栏 select 真实 change 路径）→ 本列记住该模型，顶栏显示它",
    Boolean(modelApplied) && Boolean(headerApplied),
    modelApplied
      ? `prefs=${JSON.stringify(modelApplied.prefs)} · header=${headerApplied ? headerApplied.modelValue : "未回填"}`
      : `超时（目标 ${targetModel}）`,
  );

  const thinkNow = modelApplied?.thinkingValue;
  const targetThinking = (modelApplied?.thinkingOptions ?? []).find((l) => l && l !== thinkNow && l !== "off") ?? null;
  if (targetThinking) {
    // 换模型后 main.js 会 loadThinkingLevels()：等选项真到位再走 change
    await waitEval(
      cdp,
      `(() => [...document.getElementById('thinking-select').options].some((o) => o.value === ${JSON.stringify(targetThinking)}))()`,
      20000,
    );
    await evaluate(
      cdp,
      `(() => {
        const sel = document.getElementById('thinking-select');
        const opt = [...sel.options].find((o) => o.value === ${JSON.stringify(targetThinking)});
        if (!opt) return false;
        sel.value = ${JSON.stringify(targetThinking)};
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
  }
  const thinkApplied = targetThinking
    ? await waitEval(
        cdp,
        `(() => { const r = ${PAGE_PROBE}; return r.thinkingValue === ${JSON.stringify(targetThinking)} && r.prefs?.thinkingLevel === ${JSON.stringify(targetThinking)} ? r : null; })()`,
        30000,
      )
    : modelApplied;
  check(
    "改思考级别 → 本列记住该级别",
    Boolean(thinkApplied),
    thinkApplied ? `thinking=${thinkApplied.thinkingValue}` : `超时（目标 ${targetThinking ?? "n/a"}）`,
  );

  // 3) 断开本列 SSE 且不自动重连（模拟页面离开/长时间断网）→ 引擎被 idle-sweep 回收
  const dropped = await evaluate(cdp, `window.__piShell.dropConnection({ autoRetry: false })`);
  check("断开本列 SSE（不排退避）", dropped === true, `dropped=${dropped}`);
  const swept = await waitFor(async () => {
    const { json } = await api("/api/health");
    return { ok: (json?.engineCount ?? -1) === 0, json };
  }, 60000, 500);
  check("引擎被 idle-sweep 回收（engineCount=0）", swept.ok, `engineCount=${swept.json?.engineCount}`);
  check("日志出现 engine_swept", /\|engine_swept\|/.test(readLog()), "");
  const logMark = readLog().length;

  // 4) 重连（用户点「重试」同一个入口）→ 前端自动重新接管
  const genBefore = (await evaluate(cdp, PAGE_PROBE)).notices?.restoreAttempts ?? 0;
  await evaluate(cdp, `window.__piShell.reconnect()`);
  const restored = await waitEval(
    cdp,
    `(() => {
      const r = ${PAGE_PROBE};
      const st = r.notices;
      if (!st) return null;
      // 引擎真就绪 + 已接管回原会话（bridgeSessionId 只能来自本次连接的快照/回执）
      if (r.state !== 'idle') return null;
      if (r.attachState !== 'attached') return null;
      if (String(st.bridgeSessionId ?? '') !== ${JSON.stringify(sessionId)}) return null;
      if (String(st.restoreTriedFor ?? '') !== String(st.sessionPath ?? '')) return null;
      return r;
    })()`,
    90000,
  );
  check(
    "重连后重新接管原会话（bridgeSessionId == 原 sessionId，attached）",
    Boolean(restored),
    restored ? `sessionId=${restored.sessionId} attach=${restored.attachState}` : "超时",
  );
  if (!restored) {
    const dbg = await evaluate(cdp, PAGE_PROBE);
    console.log("DEBUG reconnect:", JSON.stringify({ attach: dbg.attachState, sessionId: dbg.sessionId, state: dbg.notices, notice: dbg.notice, reconnect: dbg.reconnectText, model: dbg.modelValue }));
    console.log("DEBUG health:", JSON.stringify((await api("/api/health")).json?.engines ?? null));
    console.log("DEBUG log tail:\n" + readLog().split("\n").slice(-25).join("\n"));
  }
  if (!restored) throw new Error("重连未接管回原会话，后续断言无意义");

  check("#ws-path == 会话 cwd（不是 PI_SHELL_CWD=家目录）", samePath(restored.wsTitle, sessionCwd), `title=${restored.wsTitle} 期望=${sessionCwd}`);
  check(
    "顶栏模型 == 会话模型（跟回本列意图）",
    restored.modelValue === targetModel && restored.modelCurrent === targetModel,
    `value=${restored.modelValue} current=${restored.modelCurrent} 期望=${targetModel}`,
  );
  check(
    "顶栏思考级别跟回",
    !targetThinking || restored.thinkingValue === targetThinking,
    `thinking=${restored.thinkingValue} 期望=${targetThinking ?? "n/a"}`,
  );
  check(
    "notice 或列头状态行有「已恢复上次会话」（恢复过程可见，不静默）",
    /已恢复上次会话/.test(`${restored.notice || ""} ${restored.restoredMark || ""}`),
    `notice=${JSON.stringify(restored.notice)} · 列头=${JSON.stringify(restored.restoredMark)}`,
  );
  check(
    "列头持久状态行存在（[data-role=restored]，不只靠 toast）",
    /已恢复上次会话/.test(restored.restoredTag || ""),
    `tag=${JSON.stringify(restored.restoredTag)}`,
  );
  check(
    "同一重连只自动接管一次（防抖：restoreAttempts +1）",
    restored.notices?.restoreAttempts === genBefore + 1,
    `restoreAttempts=${restored.notices?.restoreAttempts}（重连前 ${genBefore}）`,
  );
  const postLog = readLog().slice(logMark);
  check(
    "日志出现 session_attached（接管完成回执）",
    /\|session_attached\|/.test(postLog),
    (postLog.split("\n").find((l) => l.includes("|session_attached|")) ?? "").slice(0, 200),
  );
  check(
    "桥侧恢复被前端接管取代时留下 engine_restore_superseded（可追溯）",
    /\|(engine_restored|engine_restore_superseded)\|/.test(postLog),
    (postLog.split("\n").find((l) => /\|(engine_restored|engine_restore_superseded)\|/.test(l)) ?? "").slice(0, 200),
  );

  // 5) 发一条消息 → 原会话文件增长；家目录映射目录下不得出现新会话
  const beforeSend = lineCount(fixtureSession);
  await waitEval(cdp, `(document.getElementById('send')?.disabled === false ? true : false)`, 20000);
  const clickBox = await clickElement(cdp, "#input");
  await cdp.send("Input.insertText", { text: "重连恢复验收：只回复两个字「收到」" });
  const typed = await evaluate(
    cdp,
    `({ active: document.activeElement?.id ?? null, value: document.getElementById('input')?.value ?? null, sendDisabled: document.getElementById('send')?.disabled === true })`,
  );
  await pressEnter(cdp, MOD.ctrl);
  const sentState = await evaluate(
    cdp,
    `({ users: document.querySelectorAll('#log .msg-user').length, entries: document.querySelectorAll('#log .entry-user').length })`,
  );
  console.log("INFO send:", JSON.stringify({ clickBox, typed, sentState, beforeSend, after: lineCount(fixtureSession) }));
  const grew = await waitFor(async () => ({ ok: lineCount(fixtureSession) > beforeSend }), 120000, 500);
  check(
    "发送后原会话文件增长（消息落在原会话，不是空会话）",
    grew.ok,
    `${path.basename(fixtureSession)}：${beforeSend} → ${lineCount(fixtureSession)} 行`,
  );
  await evaluate(
    cdp,
    `fetch('/api/abort', { method: 'POST', headers: { 'X-Pi-Shell-Client': ${JSON.stringify(clientId)} } }).then(() => true)`,
    true,
  ).catch(() => {});
  const homeCwdDir = path.join(sessionsDir, sessionsDirNameForCwd(HOME));
  const strayFiles = () =>
    fs.existsSync(homeCwdDir)
      ? fs
          .readdirSync(homeCwdDir, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
          .map((e) => e.name)
      : [];
  check(
    `家目录映射目录下无新会话文件（${path.basename(homeCwdDir)}）`,
    strayFiles().length === 0,
    strayFiles().length ? strayFiles().join(" · ") : "无",
  );

  // 6) 反例（身份不明不放行）：引擎身份未知 + 原会话文件已删 → 发送必须被拦住并提示
  const usersBeforeBlock = lineCount(fixtureSession); // 仅用于日志；真正判定看 DOM
  void usersBeforeBlock;
  const usersBefore = (await evaluate(cdp, PAGE_PROBE)).users;
  await evaluate(
    cdp,
    `(() => {
      window.__piShell.applyFrame({ type: 'bridge_state', session: { sessionId: null }, pi: { state: 'idle', mcp: [] } });
      return window.__piShell.reconnectState;
    })()`,
  );
  await fsp.rm(fixtureSession, { force: true });
  await evaluate(cdp, `(document.getElementById('input').value = '')`);
  await clickElement(cdp, "#input");
  await cdp.send("Input.insertText", { text: "这条不许发出去" });
  await pressEnter(cdp, MOD.ctrl);
  const blocked = await waitEval(
    cdp,
    `(() => { const r = ${PAGE_PROBE}; return /未能确认当前会话/.test(r.notice || '') ? r : null; })()`,
    45000,
  );
  check(
    "身份不明时拦截发送并提示「未能确认当前会话」",
    Boolean(blocked) && blocked.input === "这条不许发出去",
    blocked ? `notice=${JSON.stringify(blocked.notice)} · 输入框=${JSON.stringify(blocked.input)}` : "超时",
  );
  check(
    "拦截后没有发出消息（无新用户气泡 / 家目录下也没有新会话文件）",
    Boolean(blocked) && blocked.users === usersBefore && strayFiles().length === 0,
    blocked ? `用户气泡=${blocked.users}（拦截前 ${usersBefore}）` : "n/a",
  );

  // 7) 合成帧（__piShell.applyFrame）：不依赖桥是否真的广播回执 —— 直接验前端的帧处理
  //    7a 别的会话的回执不许改这一列；7b 失败回执要显式“接管失败 + 可点重试接管”；7c 成功回执把身份写成引擎真相
  const beforeForeign = await evaluate(cdp, PAGE_PROBE);
  await evaluate(
    cdp,
    `window.__piShell.applyFrame({ type: 'session_attached', sessionFile: ${JSON.stringify(fixtureSession + '.other')}, sessionId: 'other-session-id', leafId: null, ms: 1 })`,
  );
  const afterForeign = await evaluate(cdp, PAGE_PROBE);
  check(
    "合成帧：别的会话的 session_attached 被忽略（不串列）",
    afterForeign.attachState === beforeForeign.attachState && afterForeign.sessionId === beforeForeign.sessionId,
    `attach=${afterForeign.attachState}/${beforeForeign.attachState} · sessionId=${afterForeign.sessionId}/${beforeForeign.sessionId}`,
  );

  await evaluate(
    cdp,
    `window.__piShell.applyFrame({ type: 'session_attach_failed', sessionFile: ${JSON.stringify(fixtureSession)}, code: 'NOT_FOUND', reason: '原会话文件已删除或移动', ms: 1 })`,
  );
  const failedFrame = await waitEval(cdp, `(() => { const r = ${PAGE_PROBE}; return r.attachState === 'failed' ? r : null; })()`, 15000);
  check(
    "合成帧 session_attach_failed：显示「接管失败」+ 可点「重试接管」（不静默）",
    Boolean(failedFrame) &&
      /接管失败/.test(failedFrame.attachText) &&
      /NOT_FOUND/.test(failedFrame.notice) &&
      failedFrame.attachBannerHidden === false &&
      failedFrame.attachRetryHidden === false,
    failedFrame
      ? `attach=${failedFrame.attachState} banner=${JSON.stringify(failedFrame.attachText)} 重试按钮隐藏=${failedFrame.attachRetryHidden} notice=${JSON.stringify(failedFrame.notice)}`
      : "超时",
  );

  await evaluate(
    cdp,
    `window.__piShell.applyFrame({ type: 'session_attached', sessionFile: ${JSON.stringify(fixtureSession)}, sessionId: ${JSON.stringify(sessionId)}, leafId: null, ms: 1, restored: true })`,
  );
  const attachedFrame = await waitEval(
    cdp,
    `(() => {
      const r = ${PAGE_PROBE};
      if (r.attachState !== 'attached') return null;
      if (String(r.notices?.bridgeSessionId ?? '') !== ${JSON.stringify(sessionId)}) return null;
      return r;
    })()`,
    15000,
  );
  check(
    "合成帧 session_attached(restored)：attachment 恢复 + 身份以回执为准",
    Boolean(attachedFrame) && attachedFrame.attachRetryHidden === true,
    attachedFrame
      ? `attach=${attachedFrame.attachState} bridgeSessionId=${attachedFrame.notices?.bridgeSessionId}`
      : "超时",
  );

  const nonRequest = readLog()
    .split("\n")
    .filter((l) => l && !l.includes("|request|") && !l.includes("|sse_open|"));
  console.log("INFO 日志（非 request 行，尾部）:\n" + nonRequest.slice(-30).join("\n"));

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  check("脚本执行", false, err?.message || String(err));
  exitCode = 1;
} finally {
  // 进程清理：只按自己记录的 PID（禁止按命令行模式批量杀）
  try {
    cdp?.close();
  } catch {}
  if (edge && edge.exitCode === null) {
    const pid = edge.pid;
    edge.kill();
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      edge.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
    if (edge.exitCode === null) edge.kill("SIGKILL");
    console.log(`INFO  收尾：已按 PID 关闭 Edge（pid=${pid}）`);
  }
  if (bridge && bridge.exitCode === null) {
    const pid = bridge.pid;
    bridge.kill();
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 8000);
      bridge.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
    if (bridge.exitCode === null) bridge.kill("SIGKILL");
    console.log(`INFO  收尾：已按 PID 关闭桥（pid=${pid}）`);
  }
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} PASS · 夹具 ${tmpRoot} 已清理`);
  process.exit(exitCode);
}