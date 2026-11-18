#!/usr/bin/env node
// PIX-2「会话图」交互验收 E2E（零第三方依赖，CDP 真实点击/双击/按键，端口 7894）
//
// 目标：树面板从「主干优先列表 + fork 按钮」升级为可操作的「图」：
//   单击 = 选中（高亮 + 节点信息条），不切换/滚动主对话
//   双击 = 定位（滚主对话到该条目 + 高亮 3s；不在当前分支 → 提示「从此处继续」）
//   节点操作：user 节点「从此处继续」可用；assistant/工具节点禁用 + tooltip「只能从你的消息处分叉」
//   键盘：j/k 移动选中 · Enter 定位 · f 从此处继续 · / 聚焦搜索
//   工具条：跳到当前叶子 / 展开折叠全部 / 搜索 / 仅看分支点
//
// 夹具（%TEMP%，PI_SHELL_SESSIONS_DIR 隔离，绝不碰真实会话）：
//   G1 12 条线性（user/assistant 交替、长正文把主对话撑到可滚动）+ 在第 5 条 user 处挂 2 条分叉
//      （分叉行写在中间，最后一行仍是 e12 → pi 的 leafId 落在主干末端）
//   G2 5000 节点（1600 主干 + 8×425 浅分支）→ 首屏 ≤1s、DOM 行 ≤4000
//
// 断言编号对应任务书 1–7（+ 8 性能）。
// 用法：node scripts/evidence/tree-graph-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部通过；FAIL / 运行异常 = 1

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7894;
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1000;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-tree-graph");
const SESSIONS = path.join(OUT_DIR, "sessions");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const ROW_CAP = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GRAPH_SESSION = "tree-graph-0001";
const PERF_SESSION = "tree-graph-big-0001";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具 ----------

const LONG = "这一段用来把主对话撑到需要滚动的真实高度，模拟长文回答的排版。";

function resetOutDir() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  fs.mkdirSync(SESSIONS, { recursive: true });
}

const line = (entry) => JSON.stringify(entry);

/** G1：12 条线性 + 第 5 条 user 处的 2 条分叉（直接写 jsonl，parentId 指向该 user 条目） */
function writeGraphFixture() {
  const rows = [];
  const t0 = Date.now() - 3600 * 1000;
  let stamp = t0;
  const at = () => {
    stamp += 60 * 1000;
    return new Date(stamp).toISOString();
  };
  const msg = (id, parentId, role, text, extra = {}) => {
    const ts = at();
    return line({
      type: "message",
      id,
      parentId,
      timestamp: ts,
      message: { role, content: [{ type: "text", text }], timestamp: ts, ...extra },
    });
  };
  rows.push(line({ type: "session", version: 3, id: GRAPH_SESSION, timestamp: new Date(t0).toISOString(), cwd: REPO_ROOT }));

  const ROLES = ["user", "assistant"]; // e1 user … e12 assistant
  const body = (i) => `第 ${i} 条消息的正文。${LONG.repeat(16)}`;
  const assistantMeta = { durationMs: 1500, usage: { input: 19920, output: 464, totalTokens: 20384 } };

  for (let i = 1; i <= 5; i++) {
    const role = ROLES[(i - 1) % 2];
    rows.push(msg(`e${i}`, i === 1 ? null : `e${i - 1}`, role, body(i), role === "assistant" ? assistantMeta : {}));
  }
  // 分叉：e5（user）的两个「从此处继续」结果
  rows.push(msg("f1a", "e5", "user", "分叉一：换个方向继续", {}));
  rows.push(msg("f1b", "f1a", "assistant", "分叉一的回答。", assistantMeta));
  rows.push(msg("f2a", "e5", "user", "分叉二：再试一次", {}));
  rows.push(msg("f2b", "f2a", "assistant", "分叉二的回答。", assistantMeta));
  for (let i = 6; i <= 12; i++) {
    const role = ROLES[(i - 1) % 2];
    rows.push(msg(`e${i}`, `e${i - 1}`, role, body(i), role === "assistant" ? assistantMeta : {}));
  }
  const file = path.join(SESSIONS, `${GRAPH_SESSION}.jsonl`);
  fs.writeFileSync(file, `${rows.join("\n")}\n`, "utf8");
  return { file, total: 16, mainRows: 12, users: ["e1", "e3", "e5", "e7", "e9", "e11"] };
}

/** G2：5000 节点（1600 主干 + 根上 8×425 浅分支；pi get_tree 递归深度 ~2000 上限，不能用 5000 线性链） */
function writePerfFixture() {
  const rows = [];
  const t0 = Date.now() - 6000 * 1000;
  let stamp = 0;
  const msg = (id, parentId, text) => line({
    type: "message",
    id,
    parentId,
    timestamp: new Date(t0 + stamp++ * 1000).toISOString(),
    message: { role: stamp % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
  });
  rows.push(line({ type: "session", version: 3, id: PERF_SESSION, timestamp: new Date(t0).toISOString(), cwd: REPO_ROOT }));
  const main = 1600;
  const chains = 8;
  const branchSize = 425;
  rows.push(msg("n0", null, "长链消息 #0"));
  for (let b = 0; b < chains; b++) {
    for (let j = 0; j < branchSize; j++) rows.push(msg(`b${b}_${j}`, j === 0 ? "n0" : `b${b}_${j - 1}`, `侧枝 ${b}/${j}`));
  }
  for (let i = 1; i < main; i++) rows.push(msg(`n${i}`, `n${i - 1}`, `长链消息 #${i}`));
  const file = path.join(SESSIONS, `${PERF_SESSION}.jsonl`);
  fs.writeFileSync(file, `${rows.join("\n")}\n`, "utf8");
  return { file, total: main + chains * branchSize };
}

// ---------- bridge ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_LOG_FILE: LOG_FILE,
    },
    stdio: "ignore",
  });
}

async function waitHealth(ms = 60000) {
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

async function waitPortFree(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      await fetch(`${BASE}/api/health`, { cache: "no-store" });
    } catch {
      return true;
    }
    await sleep(300);
  }
  return false;
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

async function waitFor(cdp, expression, ms = 5000, interval = 50, awaitPromise = false) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await evaluate(cdp, expression, awaitPromise).catch(() => null);
    if (last) return { ok: true, value: last, elapsed: Date.now() - t0 };
    await sleep(interval);
  }
  return { ok: false, value: last, elapsed: Date.now() - t0 };
}

async function launchEdge(edgePath, profile) {
  fs.rmSync(path.join(OUT_DIR, profile), { recursive: true, force: true });
  const edge = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${path.join(OUT_DIR, profile)}`,
    "--window-size=1440,900",
    `${BASE}/`,
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 160 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge CDP 未就绪");
  return { edge, target };
}

/** 行是否被 sticky 信息条挡住 → 先滚到视口中线，再算坐标 */
async function scrollSelectorIntoView(cdp, selector) {
  await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const body = el.closest('.panel-body');
    if (!body) { el.scrollIntoView({ block: 'center' }); return true; }
    const eb = el.getBoundingClientRect();
    const bb = body.getBoundingClientRect();
    const delta = (eb.top - bb.top) - (body.clientHeight - eb.height) / 2;
    body.scrollTop = Math.max(0, body.scrollTop + delta);
    return true;
  })()`, false);
  await sleep(120);
}

async function boxOf(cdp, selector) {
  return evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: "not found" };
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      x, y,
      w: Math.round(r.width), h: Math.round(r.height),
      ok: !!hit && (hit === el || el.contains(hit)),
      hitTag: hit ? (hit.className || hit.tagName) : null,
    };
  })()`, false);
}

async function clickSelector(cdp, selector) {
  await scrollSelectorIntoView(cdp, selector);
  const box = await boxOf(cdp, selector);
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(120);
  return { ...box, hit: true };
}

async function doubleClickSelector(cdp, selector) {
  await scrollSelectorIntoView(cdp, selector);
  const box = await boxOf(cdp, selector);
  if (box.error || !box.ok) return { ...box, hit: false };
  const { x, y } = box;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 2 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 2 });
  await sleep(150);
  return { ...box, hit: true };
}

const KEYS = {
  j: { key: "j", code: "KeyJ", vk: 74, text: "j" },
  k: { key: "k", code: "KeyK", vk: 75, text: "k" },
  f: { key: "f", code: "KeyF", vk: 70, text: "f" },
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  "/": { key: "/", code: "Slash", vk: 191, text: "/" },
};

async function press(cdp, name) {
  const k = KEYS[name];
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
  });
  await sleep(120);
}

async function shot(cdp, file) {
  const res = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
}

const PAGE_READY = `(() => {
  const v = (document.getElementById('version')?.textContent || '').trim();
  return !!document.getElementById('open-tree') && !!v && v !== '—';
})()`;

async function waitPageReady(cdp, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(cdp, PAGE_READY, false).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}

const LOG_EXPR = `(document.getElementById('log') || document.querySelector('[data-role=log]'))`;

async function logState(cdp) {
  return evaluate(cdp, `(() => {
    const log = ${LOG_EXPR};
    if (!log) return null;
    return {
      top: Math.round(log.scrollTop),
      max: Math.round(log.scrollHeight - log.clientHeight),
      located: [...log.querySelectorAll('.is-located')].map((el) => el.dataset.entryId || 'live'),
    };
  })()`, false);
}

/** 打开 ⋯ 菜单 → 点「树」，返回首屏耗时 */
async function openTreePanel(cdp) {
  await clickSelector(cdp, "#open-menu");
  await sleep(200);
  const clicked = await clickSelector(cdp, "#open-tree");
  const t0 = Date.now();
  let first = null;
  while (Date.now() - t0 < 5000) {
    first = await evaluate(cdp, `(() => {
      const rows = document.querySelectorAll('.tree-flat .tree-node').length;
      const stats = document.querySelector('[data-role=tree-stats]');
      return rows > 0 && stats ? { rows, stats: stats.textContent } : null;
    })()`, false).catch(() => null);
    if (first) break;
    await sleep(20);
  }
  return { clicked, first, elapsed: Date.now() - t0 };
}

const nodeSel = (id) => `.tree-flat .tree-node[data-entry-id="${id}"]`;
const infoBar = `[data-role=tree-nodeinfo]`;

// ---------- 主流程 ----------

async function main() {
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口（避免给出假证据）`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  resetOutDir();
  const graph = writeGraphFixture();
  const perf = writePerfFixture();
  console.log(`夹具 G1 ${graph.file} · 节点 ${graph.total}`);
  console.log(`夹具 G2 ${perf.file} · 节点 ${perf.total}`);

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  let edge = null;
  let cdp = null;
  const pageErrors = [];
  const forkRequests = [];
  try {
    const health = await waitHealth();
    if (!health) throw new Error(`bridge 未在 60s 内就绪（看 ${LOG_FILE}）`);
    console.log(`bridge ready · pi ${health.pi.version} · pid ${health.pi.pid}`);

    const launched = await launchEdge(edgePath, "edge-profile");
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;

    // 网络拦截：POST /api/session/fork 在请求阶段截下（断言 + 不真的分叉）
    cdp.on((msg) => {
      if (msg.method === "Fetch.requestPaused") {
        const p = msg.params;
        if (/\/api\/session\/fork/.test(p.request.url)) {
          forkRequests.push({ url: p.request.url, method: p.request.method, postData: p.request.postData || "" });
          const body = JSON.stringify({
            cancelled: false,
            text: "",
            sessionId: "pix2fork-0000-0000-0000-000000000000",
            sessionFile: null,
          });
          cdp.send("Fetch.fulfillRequest", {
            requestId: p.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "application/json" }],
            body: Buffer.from(body).toString("base64"),
          }).catch(() => {});
        } else {
          cdp.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
        }
      }
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params?.exceptionDetails?.text || JSON.stringify(msg.params?.exceptionDetails).slice(0, 200));
      }
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const e = msg.params.entry;
        if (/favicon\.ico/.test(String(e.url || "") + " " + String(e.text || ""))) return;
        pageErrors.push(e.url ? `${e.text} (${e.url})` : e.text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Performance.enable");
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*api/session/fork*", requestStage: "Request" }] });

    const ready = await waitPageReady(cdp);
    check("A0 页面可交互（夹具桥就绪）", !!ready, ready ? `pi=${health.pi.version}` : "30s 未就绪");
    if (!ready) throw new Error("页面未就绪");

    await evaluate(cdp, `(() => {
      const log = document.getElementById('log');
      return true;
    })()`, false);
    const opened = await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(graph.file.replace(/\\/g, "/"))})`);
    check("A0b 夹具会话已附着", !!opened?.sessionId, `sessionId=${opened?.sessionId} · entries=${opened?.entries}`);
    await sleep(800);

    const api = await waitFor(cdp, `fetch('/api/session/tree', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      let n = 0; const stack = [...(d.tree || [])];
      while (stack.length) { const x = stack.pop(); n++; if (x.children) stack.push(...x.children); }
      return n >= ${graph.total} ? { nodes: n, leafId: d.leafId } : null;
    })`, 20000, 300, true);
    check("A0c 接口树节点数到位", api.ok && api.value.nodes >= graph.total,
      `api.nodes=${api.value?.nodes} · 夹具 ${graph.total} · leaf=${api.value?.leafId}`);

    const panel = await openTreePanel(cdp);
    check("A0d 打开树面板出首屏", !!panel.first, `rows=${panel.first?.rows} · ${panel.first?.stats}`);
    const fullRows = await evaluate(cdp, `document.querySelectorAll('.tree-flat > .tree-row.tree-node').length`, false);
    console.log(`     全量主干行=${fullRows}`);

    const log0 = await logState(cdp);
    check("A0e 主对话可滚动（夹具长文生效）", !!log0 && log0.max > 200, `scrollTop=${log0?.top} · 可滚 ${log0?.max}px`);

    // ============ 断言 1：单击 = 选中（高亮 + 信息条），主对话不动 ============
    const clickAssistant = await clickSelector(cdp, nodeSel("e2"));
    const sel1 = await evaluate(cdp, `(() => {
      const row = document.querySelector(${JSON.stringify(nodeSel("e2"))});
      const bar = document.querySelector(${JSON.stringify(infoBar)});
      const btn = bar?.querySelector('[data-role=tree-continue]');
      return {
        selected: row?.getAttribute('aria-selected'),
        cls: row?.classList.contains('is-selected') || false,
        rowsSelected: document.querySelectorAll('.tree-flat .tree-node.is-selected').length,
        barHidden: !bar || bar.hidden,
        barEntry: bar?.dataset.entryId || null,
        role: bar?.querySelector('[data-role=tree-nodeinfo-role]')?.textContent || '',
        time: bar?.querySelector('[data-role=tree-nodeinfo-time]')?.textContent || '',
        dur: bar?.querySelector('[data-role=tree-nodeinfo-dur]')?.textContent || '',
        tokens: bar?.querySelector('[data-role=tree-nodeinfo-tokens]')?.textContent || '',
        text: (bar?.querySelector('[data-role=tree-nodeinfo-text]')?.textContent || '').slice(0, 24),
        continueDisabled: !!btn?.disabled,
        continueTitle: btn?.title || '',
        continueH: Math.round(btn?.getBoundingClientRect().height || 0),
        continueW: Math.round(btn?.getBoundingClientRect().width || 0),
        active: document.activeElement?.dataset?.entryId || null,
        sessionMeta: document.getElementById('session-meta')?.textContent || '',
      };
    })()`, false);
    const log1 = await logState(cdp);
    check("A1 单击节点 → aria-selected + .is-selected（唯一），主对话 scrollTop 不变（±2px）",
      clickAssistant.hit && sel1.selected === "true" && sel1.cls && sel1.rowsSelected === 1
        && Math.abs((log1?.top ?? 0) - (log0?.top ?? 0)) <= 2,
      `hit=${clickAssistant.hit} · aria=${sel1.selected} · 选中行=${sel1.rowsSelected} · scrollTop ${log0?.top}→${log1?.top}`);
    check("A1b 节点信息条出现且字段齐全（角色/时间/耗时/token/正文）+ 按钮命中区 ≥32px",
      !sel1.barHidden && sel1.barEntry === "e2" && /pi/.test(sel1.role) && /^\d\d:\d\d:\d\d$/.test(sel1.time)
        && /耗时/.test(sel1.dur) && /tokens/.test(sel1.tokens) && sel1.text.length > 0
        && sel1.continueH >= 32 && sel1.continueW >= 32,
      `条=${sel1.role} · ${sel1.time} · ${sel1.dur || "无耗时"} · ${sel1.tokens || "无 token"} · 「${sel1.text}…」· 按钮 ${sel1.continueW}×${sel1.continueH}px`);

    // ============ 断言 4：assistant 节点「从此处继续」禁用 + tooltip ============
    check("A4 assistant 节点「从此处继续」禁用 + tooltip「只能从你的消息处分叉」",
      sel1.continueDisabled && sel1.continueTitle === "只能从你的消息处分叉",
      `disabled=${sel1.continueDisabled} · tooltip「${sel1.continueTitle}」`);

    // ============ 补充：任意节点的「复制消息」/「在对话中定位」 ============
    await evaluate(cdp, `(() => {
      window.__copied = null;
      if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
      navigator.clipboard.writeText = async (t) => { window.__copied = t; };
      return true;
    })()`, false);
    const copyClick = await clickSelector(cdp, '[data-role=tree-nodeinfo] [data-role=tree-copy]');
    const copyToast = await waitFor(cdp, `(() => {
      const el = document.getElementById('toast');
      return el && !el.hidden && /已复制消息/.test(el.textContent) ? true : null;
    })()`, 2000, 60);
    const copied = await evaluate(cdp, `({ text: window.__copied || '' })`, false);
    check("A4b 「复制消息」把节点文本写进剪贴板（toast 确认）",
      copyClick.hit && copyToast.ok && /第 2 条消息的正文/.test(copied.text),
      `hit=${copyClick.hit} · 复制 ${copied.text.length} 字「${copied.text.slice(0, 18)}…」`);

    const beforeGoto = await logState(cdp);
    const gotoClick = await clickSelector(cdp, '[data-role=tree-nodeinfo] [data-role=tree-goto]');
    const gotoState = await waitFor(cdp, `(() => {
      const log = ${LOG_EXPR};
      const el = log?.querySelector('[data-entry-id="e2"]');
      return el?.classList.contains('is-located') ? { top: Math.round(log.scrollTop) } : null;
    })()`, 2500, 60);
    check("A4c 「在对话中定位」= 与双击同一条定位路径",
      gotoClick.hit && gotoState.ok && Math.abs((gotoState.value?.top ?? 0) - beforeGoto.top) > 10,
      `hit=${gotoClick.hit} · scrollTop ${beforeGoto.top}→${gotoState.value?.top}`);

    // ============ 断言 3：user 节点「从此处继续」→ POST /api/session/fork + toast ============
    const beforeFork = forkRequests.length;
    const selectUser = await clickSelector(cdp, nodeSel("e5"));
    const userBtn = await evaluate(cdp, `(() => {
      const btn = document.querySelector('[data-role=tree-nodeinfo] [data-role=tree-continue]');
      return { disabled: !!btn?.disabled, title: btn?.title || '', label: btn?.textContent || '' };
    })()`, false);
    const continueClick = await clickSelector(cdp, `[data-role=tree-nodeinfo] [data-role=tree-continue]`);
    const forkSeen = await waitFor(cdp, `(() => {
      const el = document.getElementById('toast');
      return el && !el.hidden ? { text: el.textContent, kind: el.dataset.kind } : null;
    })()`, 4000, 80);
    const forkReq = forkRequests[beforeFork] || null;
    let forkBody = null;
    try { forkBody = forkReq ? JSON.parse(forkReq.postData || "{}") : null; } catch {}
    check("A3 user 节点「从此处继续」可点 → 发出 POST /api/session/fork（entryId 正确）",
      selectUser.hit && !userBtn.disabled && userBtn.label === "从此处继续" && continueClick.hit
        && forkRequests.length === beforeFork + 1 && forkReq?.method === "POST" && forkBody?.entryId === "e5",
      `hit=${selectUser.hit}→${continueClick.hit} · 请求 ${forkReq?.method} entryId=${forkBody?.entryId} · 总请求 ${forkRequests.length}`);
    check("A3b fork 后 UI 出现 toast（新会话 id）",
      forkSeen.ok && /已 fork 到新会话/.test(forkSeen.value.text) && /pix2fork/.test(forkSeen.value.text),
      `toast「${forkSeen.value?.text || "无"}」kind=${forkSeen.value?.kind}`);

    // ============ 断言 2：双击 = 定位（主对话滚动 + 高亮） ============
    const beforeDbl = await logState(cdp);
    const dbl = await doubleClickSelector(cdp, nodeSel("e1"));
    const located = await waitFor(cdp, `(() => {
      const log = ${LOG_EXPR};
      const el = log?.querySelector('[data-entry-id="e1"]');
      return el?.classList.contains('is-located') ? { top: Math.round(log.scrollTop), cls: true } : null;
    })()`, 3000, 50);
    const afterDbl = await logState(cdp);
    check("A2 双击节点 → 主对话滚动到该条目并高亮（.is-located）",
      dbl.hit && located.ok && Math.abs(afterDbl.top - beforeDbl.top) > 40 && afterDbl.located.includes("e1"),
      `hit=${dbl.hit} · scrollTop ${beforeDbl.top}→${afterDbl.top}（可滚 ${afterDbl.max}）· located=${afterDbl.located.join(",")}`);

    const shotSelected = path.join(SHOT_DIR, "tree-graph-selected.png");
    const shotLocated = path.join(SHOT_DIR, "tree-graph-located.png");
    await shot(cdp, shotLocated);
    check("A2b 双击定位截图存档", fs.existsSync(shotLocated) && fs.statSync(shotLocated).size > 0, shotLocated);

    // 不在当前分支的节点（分叉里的 f1a）→ 仍定位高亮，但要额外提示可「从此处继续」
    await evaluate(cdp, `(() => {
      const s = document.querySelector('[data-role=tree-branch-summary]');
      if (s && s.getAttribute('aria-expanded') !== 'true') s.click();
      return !!s;
    })()`, false);
    await sleep(300);
    const offExists = await evaluate(cdp, `!!document.querySelector(${JSON.stringify(nodeSel("f1a"))})`, false);
    const beforeToast = await evaluate(cdp, `(document.getElementById('toast')?.textContent || '')`, false);
    const offDbl = await doubleClickSelector(cdp, nodeSel("f1a"));
    const offToast = await waitFor(cdp, `(() => {
      const el = document.getElementById('toast');
      const t = el && !el.hidden ? el.textContent : '';
      return t && t !== ${JSON.stringify(beforeToast)} && /不在当前分支/.test(t) ? t : null;
    })()`, 3000, 60);
    const offState = await logState(cdp);
    check("A2c 不在当前分支的节点：提示「不在当前分支，可用「从此处继续」」（仍定位并高亮）",
      offExists && offDbl.hit && offToast.ok && offState.located.includes("f1a"),
      offExists ? `提示「${offToast.value}」· located=${offState.located.join(",")}· scrollTop=${offState.top}` : "分支行未渲染出来");

    // ============ 断言 5：键盘 j / k / Enter / f / ============
    await clickSelector(cdp, nodeSel("e1"));
    const kbStart = await evaluate(cdp, `document.querySelector('.tree-flat').dataset.selectedId || null`, false);
    await evaluate(cdp, `(() => { const r = document.querySelector(${JSON.stringify(nodeSel("e1"))}); if (r) { r.focus(); return document.activeElement === r; } return false; })()`, false);
    await press(cdp, "j");
    const afterJ = await evaluate(cdp, `document.querySelector('.tree-flat').dataset.selectedId || null`, false);
    await press(cdp, "j");
    const afterJJ = await evaluate(cdp, `document.querySelector('.tree-flat').dataset.selectedId || null`, false);
    await press(cdp, "k");
    const afterK = await evaluate(cdp, `document.querySelector('.tree-flat').dataset.selectedId || null`, false);
    const focusRing = await evaluate(cdp, `(() => {
      const row = document.querySelector('.tree-flat .tree-node.is-selected');
      if (!row) return null;
      const cs = getComputedStyle(row);
      return { outline: cs.outlineStyle + ' ' + cs.outlineWidth, active: document.activeElement === row, entry: row.dataset.entryId };
    })()`, false);
    check("A5a j 下移 / k 上移选中（焦点跟着走，选中行可见焦点环）",
      kbStart === "e1" && afterJ === "e2" && afterJJ === "e3" && afterK === "e2"
        && focusRing?.active === true && focusRing?.entry === "e2" && /solid/.test(String(focusRing?.outline)),
      `选中 ${kbStart}→${afterJ}→${afterJJ}→${afterK} · 焦点在选中行=${focusRing?.active} · outline=${focusRing?.outline}`);

    const beforeEnter = await logState(cdp);
    await press(cdp, "Enter");
    const enterLocate = await waitFor(cdp, `(() => {
      const log = ${LOG_EXPR};
      const el = log?.querySelector('[data-entry-id="e2"]');
      return el?.classList.contains('is-located') ? { top: Math.round(log.scrollTop) } : null;
    })()`, 3000, 50);
    check("A5b Enter = 定位（与双击同一条路径）",
      enterLocate.ok && Math.abs((enterLocate.value?.top ?? 0) - beforeEnter.top) > 10,
      `选中 e2 · scrollTop ${beforeEnter.top}→${enterLocate.value?.top} · located=${enterLocate.ok}`);

    // f 在 assistant 上不 fork；移到 user（e1）再 f → 第 2 个 fork 请求
    const forkBeforeF = forkRequests.length;
    await press(cdp, "f");
    await sleep(250);
    const forkAfterAssistant = forkRequests.length;
    await press(cdp, "k");
    const onUser = await evaluate(cdp, `document.querySelector('.tree-flat').dataset.selectedId || null`, false);
    await press(cdp, "f");
    await sleep(500);
    const forkFinal = forkRequests.length;
    check("A5c f = 从此处继续（assistant 不触发；user 触发 POST /api/session/fork）",
      forkAfterAssistant === forkBeforeF && onUser !== "e2" && forkFinal === forkBeforeF + 1,
      `assistant 上 f：${forkBeforeF}→${forkAfterAssistant} · 选中 ${onUser} 上 f：→${forkFinal}`);

    await press(cdp, "/");
    const searchFocus = await evaluate(cdp, `(() => ({
      active: document.activeElement?.dataset?.role || document.activeElement?.id || '',
      isSearch: document.activeElement === document.querySelector('[data-role=tree-search]'),
    }))()`, false);
    check("A5d / = 聚焦搜索框", searchFocus.isSearch, `activeElement=${searchFocus.active}`);
    await evaluate(cdp, `(() => { const i = document.querySelector('[data-role=tree-search]'); i.value = ''; i.blur(); return true; })()`, false);

    // 选中态截图（回到 e5 user 节点，信息条有可用按钮）
    await clickSelector(cdp, nodeSel("e5"));
    await sleep(150);
    await shot(cdp, shotSelected);
    check("A6 选中态截图存档", fs.existsSync(shotSelected) && fs.statSync(shotSelected).size > 0, shotSelected);

    // ============ 断言 6：仅看分支点 ============
    const rowsBefore = await evaluate(cdp, `document.querySelectorAll('.tree-flat > .tree-row.tree-node').length`, false);
    const toggle = await clickSelector(cdp, "[data-role=tree-branch-only]");
    const branchOnly = await waitFor(cdp, `(() => {
      const rows = [...document.querySelectorAll('.tree-flat > .tree-row.tree-node')];
      const stats = document.querySelector('[data-role=tree-stats]')?.textContent || '';
      const btn = document.querySelector('[data-role=tree-branch-only]');
      if (!/仅分支点/.test(stats)) return null;
      return {
        rows: rows.length,
        users: rows.filter((r) => r.querySelector('.tree-kind')?.textContent === '○').length,
        stats,
        pressed: btn?.getAttribute('aria-pressed'),
        label: btn?.textContent,
      };
    })()`, 3000, 60);
    const shotBranch = path.join(SHOT_DIR, "tree-graph-branch-only.png");
    await shot(cdp, shotBranch);
    check("A7 「仅看分支点」行数 < 全量行数（只留 user / 分叉点 / 叶子），可切回",
      toggle.hit && branchOnly.ok && branchOnly.value.rows < rowsBefore && branchOnly.value.rows < fullRows
        && branchOnly.value.users >= graph.users.length - 1
        && branchOnly.value.pressed === "true" && branchOnly.value.label === "看全部节点",
      `hit=${toggle.hit} · 行 ${rowsBefore}→${branchOnly.value?.rows}（user ${branchOnly.value?.users}）· ${branchOnly.value?.stats} · 按钮「${branchOnly.value?.label}」`);
    await clickSelector(cdp, "[data-role=tree-branch-only]");
    const backToAll = await waitFor(cdp, `(() => {
      const rows = document.querySelectorAll('.tree-flat > .tree-row.tree-node').length;
      const btn = document.querySelector('[data-role=tree-branch-only]');
      return rows >= ${fullRows} && btn?.getAttribute('aria-pressed') === 'false' ? rows : null;
    })()`, 3000, 60);
    check("A7b 再点切回全量视图", backToAll.ok, `行=${backToAll.value}`);
    check("A7c 仅分支点截图存档", fs.existsSync(shotBranch) && fs.statSync(shotBranch).size > 0, shotBranch);

    // ============ 断言 7：无未捕获异常 ============
    const realErrors = pageErrors.filter((t) => !/net::ERR_|ERR_ABORTED|Failed to load resource/.test(String(t)));
    check("A8 页面无未捕获异常", realErrors.length === 0, realErrors.length ? realErrors.slice(0, 2).join(" | ") : "无");

    // ============ 断言 8：5000 节点性能（首屏 ≤1s、DOM ≤4000） ============
    await clickSelector(cdp, "#panel-close");
    await sleep(200);
    const openBig = await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(perf.file.replace(/\\/g, "/"))})`);
    await sleep(1000);
    const bigApi = await waitFor(cdp, `fetch('/api/session/tree', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      let n = 0; const stack = [...(d.tree || [])];
      while (stack.length) { const x = stack.pop(); n++; if (x.children) stack.push(...x.children); }
      return n >= ${perf.total} ? n : null;
    })`, 40000, 400, true);
    const bigPanel = await openTreePanel(cdp);
    const bigShape = await evaluate(cdp, `(() => {
      const rows = [...document.querySelectorAll('.tree-flat > .tree-row')];
      return {
        rows: rows.length,
        nodes: rows.filter((r) => r.classList.contains('tree-node')).length,
        stats: document.querySelector('[data-role=tree-stats]')?.textContent || '',
      };
    })()`, false);
    check("A9 5000 节点：首屏 ≤1s、DOM 行 ≤4000（懒渲染，选中态不增加行）",
      openBig?.sessionId && bigApi.ok && bigPanel.clicked.hit && !!bigPanel.first
        && bigPanel.elapsed <= 1000 && bigShape.nodes <= ROW_CAP && bigShape.rows <= ROW_CAP,
      `sessionId=${openBig?.sessionId} · api=${bigApi.value} · 首屏 ${bigPanel.elapsed}ms · rows=${bigShape.rows}（节点 ${bigShape.nodes}）· ${bigShape.stats}`);

    const hiErrors = pageErrors.filter((t) => !/net::ERR_|ERR_ABORTED|Failed to load resource/.test(String(t)));
    check("A9b 5000 节点视图无未捕获异常", hiErrors.length === 0, hiErrors.length ? hiErrors.slice(0, 2).join(" | ") : "无");
    const shotBig = path.join(SHOT_DIR, "tree-graph-5000.png");
    await shot(cdp, shotBig);
    check("A9c 5000 节点截图存档", fs.existsSync(shotBig) && fs.statSync(shotBig).size > 0, shotBig);
  } finally {
    try { cdp?.close(); } catch {}
    try { edge?.kill(); } catch {}
    try { bridge.kill(); } catch {}
    await sleep(500);
    await waitPortFree();
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) console.log(`FAIL 清单：${failed.map((r) => r.name).join(" | ")}`);
    process.exitCode = failed.length ? 1 : 0;
    if (failed.length) process.exit(1);
  })
  .catch((err) => {
    console.error(`运行异常：${err.message}`);
    process.exit(1);
  });
