#!/usr/bin/env node
// B6「会话树」崩溃修复验收 E2E（零第三方依赖，CDP 真实点击，端口 7836）
//
// 为什么存在：真实用户会话树 949 节点 / 最大深度 949，旧实现每层一个 <ul> +
// padding-left:14px 递归嵌套 → 第 949 层缩进 ≈ 13,286px（面板看起来空白），
// 同时 949 层嵌套让布局爆炸，几秒后渲染进程卡死。
//
// 本脚本用 1200 条的**线性夹具会话**（深度 1200）验收扁平渲染：
//   T1 点「树」→ ≤3s 出现 .tree-node，数量 == 接口树节点数（1200）
//   T2 #panel-body.scrollWidth ≤ 560（不再出现横向 1 万像素）
//   T3 15s 内页面不崩、无未捕获异常、JSHeapUsedSize < 300MB
//   T4 深层行的 padding-left ≤ 480px（缩进封顶），且没有嵌套 <ul>
//   T5 fork 按钮仍在 user 行上（>0），点一个会发出 POST /api/session/fork
//      （用 Fetch 域在请求阶段拦下，不真的分叉）
//   T6 截图存档
//   T8 桥返回 502（/api/session/tree 错误体）时，面板必须出现 .panel-error 而不是静默空白（D1）
//      （用 CDP Fetch 域把 tree 请求 fulfil 成 502 + {error:{code,message}}，不改桥、不改引擎）
//
// 铁律：只用 %TEMP% 下的夹具会话（PI_SHELL_SESSIONS_DIR 指向它），绝不碰真实会话。
//
// 用法：node scripts/evidence/tree-flat-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe；TREE_FIXTURE_NODES 覆盖节点数（默认 1200）；
// TREE_FIXTURE_SHAPE=wide 生成「一根 + N 个并列子节点」的宽树（节点数 > 2000，
// 用来验折叠护栏；pi 引擎自身的 get_tree 递归深度 ~2000+ 会栈溢出，所以不能在深度维度过 2000）
// 退出码：0 = 全部通过；有 FAIL（或运行异常）= 1（与 first-load.mjs 约定一致，证据脚本不得「失败仍 0」）

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 端口可被门禁顺延：PI_SHELL_TREE_FLAT_PORT（默认 7836）
const PORT = Number(process.env.PI_SHELL_TREE_FLAT_PORT || 7836);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1000;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-tree-fixture");
const SESSIONS = path.join(OUT_DIR, "sessions");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT = path.join(REPO_ROOT, "docs", "evidence", "tree-flat-ui.png");
const NODES = Number(process.env.TREE_FIXTURE_NODES || 1200);
const SHAPE = process.env.TREE_FIXTURE_SHAPE === "wide" ? "wide" : "linear";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具：线性链（每条 message 的 parentId = 上一条 id → 深度 = NODES）----------

const SESSION_ID = "tree-fixture-0001";
const FIXTURE_FILE = () => path.join(SESSIONS, `${SESSION_ID}.jsonl`);

function writeFixture() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  fs.mkdirSync(SESSIONS, { recursive: true });
  const t0 = Date.now() - NODES * 1000;
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: new Date(t0).toISOString(), cwd: REPO_ROOT }),
  ];
  let parentId = null;
  for (let i = 0; i < NODES; i++) {
    const id = `n${i}`;
    // linear：n(i).parent = n(i-1) → 深度 = NODES；wide：全部挂在 n0 下 → 深度 = 1
    const rowParent = SHAPE === "wide" && i > 0 ? "n0" : parentId;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId: rowParent,
        timestamp: new Date(t0 + i * 1000).toISOString(),
        message: { role: i % 2 === 0 ? "user" : "assistant", content: `夹具消息 #${i}` },
      }),
    );
    parentId = id;
  }
  fs.writeFileSync(FIXTURE_FILE(), `${lines.join("\n")}\n`, "utf8");
}

// ---------- bridge ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS, // 会话根 = 夹具（真实会话完全不可见）
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

async function treeNodeCountFromApi() {
  const res = await fetch(`${BASE}/api/session/tree`, { cache: "no-store" });
  const data = await res.json();
  let n = 0;
  const stack = [...(Array.isArray(data?.tree) ? data.tree : [])];
  while (stack.length) {
    const node = stack.pop();
    n++;
    if (Array.isArray(node?.children)) stack.push(...node.children);
  }
  return { nodes: n, leafId: data?.leafId ?? null };
}

/** switch_session 是异步的：刚 open 完 get_tree 可能还是旧快照，必须等到节点数到位 */
async function waitTreeNodes(expected, ms = 30000) {
  const t0 = Date.now();
  let last = { nodes: 0, leafId: null };
  while (Date.now() - t0 < ms) {
    last = await treeNodeCountFromApi().catch(() => last);
    if (last.nodes >= expected) return last;
    await sleep(300);
  }
  return last;
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
  const edge = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${path.join(OUT_DIR, "edge-profile")}`,
    "--window-size=1440,900",
    `${BASE}/`,
  ], { stdio: "ignore" });

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

// 真实鼠标点击：先取元素中心，再用 elementFromPoint 证明没被遮挡
async function clickSelector(cdp, selector) {
  const box = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: "not found" };
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === el || el.contains(hit));
    return { x, y, ok, hitTag: hit ? hit.tagName : null };
  })()`, false);
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
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

// ---------- 主流程 ----------

async function main() {
  writeFixture();
  console.log(`      fixture: ${FIXTURE_FILE()} · ${NODES} 条 message（${SHAPE === "wide" ? "宽树，深度 2" : `线性链，深度 ${NODES}`}）`);

  // 端口独占
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口（避免给出假证据）`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  let edge = null;
  let cdp = null;
  const pageErrors = [];
  const forkRequests = [];
  let mockTreeError = false; // T8：把 /api/session/tree 拦成 502 错误体

  try {
    const health = await waitHealth();
    if (!health) throw new Error(`bridge 未在 40s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid}`);

    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;
    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params?.exceptionDetails?.text || JSON.stringify(msg.params?.exceptionDetails).slice(0, 200));
      }
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const e = msg.params.entry;
        if (/favicon\.ico/.test(String(e.url || "") + " " + String(e.text || ""))) return;
        pageErrors.push(e.url ? `${e.text} (${e.url})` : e.text);
      }
      if (msg.method === "Fetch.requestPaused") {
        const req = msg.params?.request ?? {};
        if (mockTreeError && req.url?.includes("/api/session/tree")) {
          // 模拟桥的 502：{error:{code,message}}，状态码与格式跟 sendRpcError 一致
          cdp.send("Fetch.fulfillRequest", {
            requestId: msg.params.requestId,
            responseCode: 502,
            responseHeaders: [{ name: "Content-Type", value: "application/json" }],
            body: Buffer.from(JSON.stringify({ error: { code: "PI_ERROR", message: "E2E 模拟 get_tree 失败（502）" } })).toString("base64"),
          }).catch(() => {});
          return;
        }
        if (req.url?.includes("/api/session/fork")) {
          forkRequests.push({ method: req.method, url: req.url, body: req.postData ?? null });
          // 拦下（不真的分叉），断言只看「请求发出去了」
          cdp.send("Fetch.failRequest", { requestId: msg.params.requestId, errorReason: "Aborted" }).catch(() => {});
        } else {
          cdp.send("Fetch.continueRequest", { requestId: msg.params.requestId }).catch(() => {});
        }
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Performance.enable");

    const ready = await waitPageReady(cdp);
    check("T0 页面可交互（夹具桥就绪）", !!ready, ready ? `pi=${health.pi.version}` : "30s 未就绪");
    if (!ready) throw new Error("页面未就绪");

    // 打开夹具会话（1200 条；只读打开，不发消息）
    const opened = await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(FIXTURE_FILE().replace(/\\/g, "/"))})`);
    check("T0b 夹具会话已附着", !!opened?.sessionId, `sessionId=${opened?.sessionId} · entries=${opened?.entries}`);
    await sleep(1200);

    const api = await waitTreeNodes(NODES);
    // pi 在 attach 时会往会话里追加一条 thinking_level_change → 树节点数 ≈ 消息数 + 1~5
    check("T0c 接口树节点数 ≈ 夹具消息数", api.nodes >= NODES && api.nodes <= NODES + 5, `api.nodes=${api.nodes} · 夹具 ${NODES} 条 · ${SHAPE}`);
    const collapsedMode = api.nodes > 2000;

    // ---- T1 点「树」→ ≤3s 出现扁平行，数量 == 接口节点数（>2000 时走折叠视图）----
    // B8：顶栏收敛后「树」在 ⋯ 溢出菜单里 → 先开菜单（真实用户路径）
    await clickSelector(cdp, "#open-menu");
    await sleep(250);
    const clickTree = await clickSelector(cdp, "#open-tree");
    const t0 = Date.now();
    let count = 0;
    while (Date.now() - t0 < 3000) {
      count = await evaluate(cdp, `document.querySelectorAll('.tree-node').length`, false).catch(() => 0);
      if (count >= (collapsedMode ? 1 : api.nodes) && api.nodes > 0) break;
      await sleep(100);
    }
    const elapsed = Date.now() - t0;
    check("T1 点「树」→ ≤3s 渲染出 .tree-node",
      clickTree.hit && elapsed <= 3000 && (collapsedMode ? count > 0 : count === api.nodes),
      `hit=${clickTree.hit} · ${count} 个 .tree-node · 接口 ${api.nodes} 节点 · ${elapsed}ms${collapsedMode ? " (折叠视图)" : ""}`);

    const domShape = await evaluate(cdp, `(() => ({
      ul: document.querySelectorAll('.tree ul, .tree-flat ul, .tree-node ul').length,
      rows: document.querySelectorAll('.tree-flat > .tree-row').length,
      leaf: document.querySelectorAll('.tree-node.is-leaf').length,
      leafId: document.querySelector('[data-role=tree]')?.dataset.leafId || '',
      deepest: Math.max(0, ...[...document.querySelectorAll('.tree-node')].map((el) => Number(el.dataset.depth || 0))),
    }))()`, false);
    check("T1b 扁平结构（无嵌套 <ul>）且 leaf 高亮",
      domShape.ul === 0 && domShape.rows === count && domShape.leaf === 1 && (collapsedMode || domShape.deepest >= 1000),
      `ul=${domShape.ul} rows=${domShape.rows} leaf=${domShape.leaf} 最大 depth=${domShape.deepest}`);

    // ---- T2 面板内容宽度 ≤ 560px ----
    const widthInfo = await evaluate(cdp, `(() => {
      const body = document.getElementById('panel-body');
      return { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, treeWidth: document.querySelector('.tree-flat')?.getBoundingClientRect().width ?? 0 };
    })()`, false);
    check("T2 面板内容宽度 ≤ 560px（无横向 1 万像素）", widthInfo.scrollWidth <= 560,
      `scrollWidth=${widthInfo.scrollWidth} · clientWidth=${widthInfo.clientWidth}`);

    // ---- T4 深层行 padding-left ≤ 480px ----
    const padding = await evaluate(cdp, `(() => {
      const rows = [...document.querySelectorAll('.tree-node')];
      const deep = rows.filter((el) => Number(el.dataset.depth) > 40);
      const maxPad = rows.reduce((m, el) => Math.max(m, parseFloat(getComputedStyle(el).paddingLeft) || 0), 0);
      const sample = deep.length ? { depth: Number(deep[deep.length - 1].dataset.depth), pad: parseFloat(getComputedStyle(deep[deep.length - 1]).paddingLeft), text: deep[deep.length - 1].querySelector('.tree-label')?.textContent?.slice(0, 16) } : null;
      return { rows: rows.length, deep: deep.length, maxPad, sample };
    })()`, false);
    check("T4 深层行缩进封顶（padding-left ≤ 480px）",
      collapsedMode ? padding.deep === 0 && padding.maxPad <= 480 : padding.deep > 0 && padding.maxPad <= 480,
      `深层行=${padding.deep} · 最大 padding-left=${padding.maxPad}px · 最深处 depth=${padding.sample?.depth}「${padding.sample?.text}」`);

    // ---- T7 超大树的折叠护栏（仅节点数 > 2000 时）----
    if (collapsedMode) {
      const readBanner = () => evaluate(cdp, `(() => {
        const b = document.querySelector('[data-role=tree-banner]');
        const btn = document.querySelector('[data-role=tree-expand]');
        return { rows: document.querySelectorAll('.tree-node').length, text: b ? b.textContent : '', btn: btn ? btn.textContent : '', disabled: !!btn?.disabled };
      })()`, false);
      const b0 = await readBanner();
      check("T7a 超大树的初始折叠视图（通向 leaf 的路径 + 分支第一层）",
        b0.rows > 0 && b0.rows < 200 && /完整树 \d+ 个节点/.test(b0.text) && /已折叠/.test(b0.text) && b0.btn === "展开完整树",
        `rows=${b0.rows} · 横幅「${b0.text}」· 按钮「${b0.btn}」`);
      const expand1 = await clickSelector(cdp, "[data-role=tree-expand]");
      await sleep(600);
      const b1 = await readBanner();
      check("T7b 「展开完整树」→ 懒渲染首页 500 条",
        expand1.hit && b1.rows === Math.min(500, api.nodes) && /继续展开/.test(b1.btn),
        `hit=${expand1.hit} · rows=${b1.rows} · 按钮「${b1.btn}」`);
      const expand2 = await clickSelector(cdp, "[data-role=tree-expand]");
      await sleep(600);
      const b2 = await readBanner();
      check("T7c 继续展开 → 再加 500 条（分页懒渲染）",
        expand2.hit && b2.rows === Math.min(1000, api.nodes) && /继续展开/.test(b2.btn),
        `hit=${expand2.hit} · rows=${b2.rows} · 按钮「${b2.btn}」`);
    }

    // ---- T5 fork 按钮（先拦网络，再点一个浅层 fork）----
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/session/fork", requestStage: "Request" }] });
    const forkInfo = await evaluate(cdp, `(() => {
      const btns = [...document.querySelectorAll('.tree-node [data-fork-entry], .tree-node[data-fork-entry]')];
      // Q3：树顶加了 sticky 工具条 + 自动跟随叶子，必须排除被遮挡/部分越界的按钮
      const visible = btns.filter((b) => { const r = b.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0 && r.right <= window.innerWidth && r.left >= 0 && r.top >= 0 && r.bottom <= window.innerHeight)) return false; const h = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); return !!h && (h === b || b.contains(h)); });
      const pick = visible[0];
      if (pick) pick.dataset.e2eFork = 'picked';
      const rows = btns.map((b) => b.closest('.tree-node') || b.parentElement);
      return { total: btns.length, visible: visible.length, userRows: rows.filter((r) => r?.dataset?.entryId).length, picked: !!pick };
    })()`, false);
    const clickFork = forkInfo.picked ? await clickSelector(cdp, "[data-e2e-fork='picked']") : { hit: false };
    for (let i = 0; i < 30 && forkRequests.length === 0; i++) await sleep(100);
    await cdp.send("Fetch.disable").catch(() => {});
    const forkReq = forkRequests[0];
    check("T5 user 行仍有 fork 按钮，点击发出 POST /api/session/fork",
      forkInfo.total > 0 && clickFork.hit && !!forkReq && forkReq.method === "POST" && /"entryId"\s*:/.test(String(forkReq.body || "")),
      `按钮=${forkInfo.total}（可见 ${forkInfo.visible}）· hit=${clickFork.hit} · 请求=${forkReq ? `${forkReq.method} ${new URL(forkReq.url).pathname} body=${String(forkReq.body).slice(0, 40)}` : "未捕获"}`);

    // ---- T3 15s 稳定性 + 堆内存 ----
    const tStart = Date.now();
    let alive = true;
    while (Date.now() - tStart < 15000) {
      await sleep(1000);
      alive = await evaluate(cdp, `!!document.querySelector('.tree-flat') && document.visibilityState !== 'crash'`, false).catch(() => false);
      if (!alive) break;
    }
    const metrics = await cdp.send("Performance.getMetrics");
    const heap = Number(metrics.metrics.find((m) => m.name === "JSHeapUsedSize")?.value || 0);
    const realErrors = pageErrors.filter((t) => !/net::ERR_|ERR_ABORTED|Failed to load resource/.test(String(t)));
    check("T3 15s 内页面不崩、无未捕获异常、堆 < 300MB",
      alive && realErrors.length === 0 && heap < 300 * 1024 * 1024,
      `alive=${alive} · heap=${(heap / 1024 / 1024).toFixed(1)}MB · 异常=${realErrors.length ? realErrors.slice(0, 2).join(" | ") : "无"}`);

    // ---- T6 截图 ----
    await shot(cdp, SHOT);
    check("T6 截图存档", fs.existsSync(SHOT) && fs.statSync(SHOT).size > 0, SHOT);

    // 附：折叠阈值现状（必须在 T8 换掉面板内容前读）
    const banner = await evaluate(cdp, `!!document.querySelector('[data-role=tree-banner]')`, false);
    console.log(`      info: 接口 ${api.nodes} 节点（阈值 2000）→ 折叠横幅${banner ? "出现" : "未出现"}${collapsedMode === banner ? "（符合预期）" : "（异常）"}`);

    // ---- T8 502 不静默（D1）：拦 tree 请求回 502 错误体 → 必须出现 .panel-error ----
    mockTreeError = true;
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*api/session/tree*", requestStage: "Request" }] });
    await clickSelector(cdp, "#open-menu");
    await sleep(250);
    const clickTree502 = await clickSelector(cdp, "#open-tree");
    let errProbe = null;
    for (let i = 0; i < 50; i++) {
      errProbe = await evaluate(cdp, `(() => {
        const err = document.querySelector('#panel-body .panel-error');
        const body = document.getElementById('panel-body');
        return { error: err ? err.textContent.trim() : null, rows: document.querySelectorAll('.tree-node').length, text: (body?.textContent || '').trim() };
      })()`, false);
      if (errProbe.error) break;
      await sleep(100);
    }
    await cdp.send("Fetch.disable").catch(() => {});
    mockTreeError = false;
    check("T8 tree 接口 502 → 面板出现 .panel-error（含 code + message），不是空白",
      clickTree502.hit && !!errProbe?.error && /PI_ERROR/.test(errProbe.error) && /502/.test(errProbe.error) && errProbe.rows === 0 && errProbe.text.length > 0,
      `hit=${clickTree502.hit} · .panel-error=「${errProbe?.error}」· tree-node=${errProbe?.rows} · 面板文字 ${errProbe?.text.length} 字`);
  } finally {
    try { cdp?.close(); } catch {}
    try { edge?.kill(); } catch {}
    try { bridge.kill(); } catch {}
    await sleep(500);
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) console.log(`FAIL 清单：${failed.map((r) => r.name).join(" | ")}`);
    // D3：有 FAIL 则退出码 1（与 first-load.mjs 的 process.exitCode 约定一致）
    process.exitCode = failed.length ? 1 : 0;
    if (failed.length) process.exit(1); // 子进程/WS 句柄可能仍在，显式退以确保退出码生效
  })
  .catch((err) => {
    console.error(`运行异常：${err.message}`);
    process.exit(1);
  });
