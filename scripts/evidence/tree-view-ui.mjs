#!/usr/bin/env node
// Q3「会话树主干优先视图」验收 E2E（零第三方依赖，CDP 真实点击，端口 7870）
//
// 设计依据：docs/design/TREE-DISPLAY.md 方案 A
//   默认 = 根 → 当前叶子主干 + 每个主干节点的「+N 分支 · 折叠 M 层」摘要行
//   缩进 min(depth,3)*12px（≤36px），depth>3 用等宽徽标 D<depth>
//   分支 / 中间段 / 全树展开都按 500 行分页；DOM 行数硬上限 4000
//
// 两个夹具（都在 %TEMP%，PI_SHELL_SESSIONS_DIR 隔离，绝不碰真实会话）：
//   P1 1200 节点：主干 900 + 3 条各 100 节点的分支
//      - 首屏 ≤1s、DOM ≤4000、初始只有主干 + 3 条摘要（无分支行）
//      - 点摘要 → 行数增加；搜索分支深处的 id → 自动展开祖先并高亮
//      - D 徽标出现且缩进 ≤36px；15s 不崩、无未捕获异常
//   P2 5000 节点线性链
//      - 首屏 ≤1s（实测打印）、中间折叠、DOM ≤4000
//      - 「展开全部（分页）」每页 500，直到 4000 行硬上限后禁用
//
// 用法：node scripts/evidence/tree-view-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部通过；FAIL / 运行异常 = 1

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 端口可被门禁顺延：PI_SHELL_TREE_VIEW_PORT（默认 7870）
const PORT = Number(process.env.PI_SHELL_TREE_VIEW_PORT || 7870);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1000;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-tree-view");
const SESSIONS = path.join(OUT_DIR, "sessions");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const PAGE_SIZE = 500;
const ROW_CAP = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具 ----------

const SESSION_ID = "tree-view-0001";

function resetOutDir() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  fs.mkdirSync(SESSIONS, { recursive: true });
}

function line(entry) {
  return JSON.stringify(entry);
}

/**
 * 1200 节点分支夹具：主干 n0..n899 线性；在 n100/n400/n700 各挂一条 100 节点分支（b<at>_<i>）。
 * 分支行写在父节点之后、后续主干之前；最后一行是 n899 → 树的 leaf 落在主干末端。
 */
function writeBranchFixture() {
  resetOutDir();
  const main = 900;
  const branchSize = 100;
  const branchAt = new Set([100, 400, 700]);
  const t0 = Date.now() - 1200 * 1000;
  const rows = [line({ type: "session", version: 3, id: SESSION_ID, timestamp: new Date(t0).toISOString(), cwd: REPO_ROOT })];
  let stamp = t0;
  for (let i = 0; i < main; i++) {
    const id = `n${i}`;
    rows.push(line({
      type: "message",
      id,
      parentId: i === 0 ? null : `n${i - 1}`,
      timestamp: new Date(stamp).toISOString(),
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `主干消息 #${i}` },
    }));
    stamp += 1000;
    if (branchAt.has(i)) {
      for (let j = 0; j < branchSize; j++) {
        const bid = `b${i}_${j}`;
        rows.push(line({
          type: "message",
          id: bid,
          parentId: j === 0 ? id : `b${i}_${j - 1}`,
          timestamp: new Date(stamp).toISOString(),
          message: { role: j % 2 === 0 ? "assistant" : "user", content: `侧枝 ${i}/${j}` },
        }));
        stamp += 1000;
      }
    }
  }
  const file = path.join(SESSIONS, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, `${rows.join("\n")}\n`, "utf8");
  return { file, main, branchSize, branchAt, total: main + branchAt.size * branchSize };
}

/**
 * 5000 节点夹具：主干 n0..n1599（深度 1600；pi get_tree 递归上限 ~2000，不能 5000 线性链）
 * + 根节点上挂 8 条各 425 节点的浅分支，总计 5000。
 * 主干 1600 > TREE_MAIN_ALL_MAX(1500) → 触发中间折叠，覆盖 5000 节点场景。
 */
function writeWideFixture() {
  resetOutDir();
  const main = 1600;
  const branchChains = 8;
  const branchSize = 425;
  const t0 = Date.now() - 5000 * 1000;
  const rows = [line({ type: "session", version: 3, id: SESSION_ID, timestamp: new Date(t0).toISOString(), cwd: REPO_ROOT })];
  let stamp = 0;
  const msg = (id, parentId, text) => line({
    type: "message",
    id,
    parentId,
    timestamp: new Date(t0 + stamp++ * 1000).toISOString(),
    message: { role: stamp % 2 === 0 ? "user" : "assistant", content: text },
  });
  rows.push(msg("n0", null, "长链消息 #0"));
  for (let b = 0; b < branchChains; b++) {
    for (let j = 0; j < branchSize; j++) {
      rows.push(msg(`b${b}_${j}`, j === 0 ? "n0" : `b${b}_${j - 1}`, `侧枝 ${b}/${j}`));
    }
  }
  for (let i = 1; i < main; i++) rows.push(msg(`n${i}`, `n${i - 1}`, `长链消息 #${i}`));
  const file = path.join(SESSIONS, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, `${rows.join("\n")}\n`, "utf8");
  return { file, total: main + branchChains * branchSize, main, branchChains, branchSize };
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
    await sleep(200);
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

async function waitFor(cdp, expression, ms = 5000, interval = 50) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await evaluate(cdp, expression, false).catch(() => null);
    if (last) return { ok: true, value: last, elapsed: Date.now() - t0 };
    await sleep(interval);
  }
  return { ok: false, value: last, elapsed: Date.now() - t0 };
}

/** 打开 ⋯ 菜单 → 点「树」，返回首屏耗时（ms，从点击树开始到出现第一行 + 工具条） */
async function openTreePanel(cdp) {
  await clickSelector(cdp, "#open-menu");
  await sleep(250);
  const clicked = await clickSelector(cdp, "#open-tree");
  const t0 = Date.now();
  let first = null;
  while (Date.now() - t0 < 5000) {
    first = await evaluate(cdp, `(() => {
      const rows = document.querySelectorAll('.tree-flat .tree-row').length;
      const stats = document.querySelector('[data-role=tree-stats]');
      return rows > 0 && stats ? { rows, stats: stats.textContent } : null;
    })()`, false).catch(() => null);
    if (first) break;
    await sleep(20);
  }
  return { clicked, first, elapsed: Date.now() - t0 };
}

// ---------- 单个 phase ----------

async function runPhase({ label, writeFixture, run, shotName }) {
  const fixture = writeFixture();
  console.log(`\n=== ${label} ===`);
  console.log(`      fixture: ${fixture.file} · 节点 ${fixture.total}`);

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  let edge = null;
  let cdp = null;
  const pageErrors = [];
  try {
    const health = await waitHealth();
    if (!health) throw new Error(`bridge 未在 60s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid}`);

    const launched = await launchEdge(edgePath, `edge-profile-${label.replace(/\W+/g, "-")}`);
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
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Performance.enable");

    const ready = await waitPageReady(cdp);
    check(`${label} 页面可交互（夹具桥就绪）`, !!ready, ready ? `pi=${health.pi.version}` : "30s 未就绪");
    if (!ready) throw new Error("页面未就绪");

    const opened = await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(fixture.file.replace(/\\/g, "/"))})`);
    check(`${label} 夹具会话已附着`, !!opened?.sessionId, `sessionId=${opened?.sessionId} · entries=${opened?.entries}`);
    await sleep(1000);
    const api = await waitTreeNodes(fixture.total);
    check(`${label} 接口树节点数到位`, api.nodes >= fixture.total, `api.nodes=${api.nodes} · 夹具 ${fixture.total}`);

    const screenshot = path.join(SHOT_DIR, shotName);
    await run({ cdp, api, fixture, pageErrors, screenshot, health });
  } finally {
    try { cdp?.close(); } catch {}
    try { edge?.kill(); } catch {}
    try { bridge.kill(); } catch {}
    await sleep(500);
    await waitPortFree();
  }
}

// ---------- 主流程 ----------

async function main() {
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口（避免给出假证据）`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  // ---------- P1：1200 节点（主干 900 + 分支 300）----------
  await runPhase({
    label: "P1-1200分支",
    writeFixture: writeBranchFixture,
    shotName: "tree-view-1200.png",
    run: async ({ cdp, api, fixture, pageErrors, screenshot }) => {
      const opened = await openTreePanel(cdp);
      check("P1 V1 点开树 ≤1s 出首屏（主干 + 摘要）",
        opened.clicked.hit && !!opened.first && opened.elapsed <= 1000,
        `hit=${opened.clicked.hit} · 首屏 ${opened.elapsed}ms · rows=${opened.first?.rows} · ${opened.first?.stats}`);

      const initial = await evaluate(cdp, `(() => {
        const list = document.querySelector('.tree-flat');
        const rows = [...list.querySelectorAll(':scope > .tree-row')];
        const nodes = rows.filter((r) => r.classList.contains('tree-node'));
        const summaries = rows.filter((r) => r.classList.contains('tree-branch-summary'));
        const branchNodes = nodes.filter((r) => /^b/.test(r.dataset.entryId || ''));
        return {
          rows: rows.length,
          nodes: nodes.length,
          summaries: summaries.length,
          branchNodes: branchNodes.length,
          stats: document.querySelector('[data-role=tree-stats]')?.textContent || '',
          summaryText: summaries.map((s) => s.textContent),
          outerEls: list.querySelectorAll('*').length,
        };
      })()`, false);
      check("P1 V1b 初始只渲染主干 + 分支摘要（无分支行，DOM 行 ≤4000）",
        initial.branchNodes === 0 && initial.summaries >= 3 && initial.rows <= ROW_CAP && initial.nodes >= api.nodes - fixture.branchAt.size * fixture.branchSize && initial.nodes <= api.nodes - fixture.branchAt.size * fixture.branchSize + 10,
        `rows=${initial.rows} · 主干行=${initial.nodes} · 摘要=${initial.summaries}「${initial.summaryText.join(" / ")}」· 分支行=${initial.branchNodes}`);

      const badges = await evaluate(cdp, `(() => {
        const rows = [...document.querySelectorAll('.tree-flat .tree-node')];
        const bad = [];
        let maxPad = 0;
        let badgeCount = 0;
        let mismatched = 0;
        for (const r of rows) {
          const depth = Number(r.dataset.depth || 0);
          const pad = parseFloat(getComputedStyle(r).paddingLeft) || 0;
          maxPad = Math.max(maxPad, pad);
          const badge = r.querySelector('.tree-depth');
          if (depth > 3) {
            badgeCount++;
            if (!badge || badge.textContent !== 'D' + depth) mismatched++;
          } else if (badge) bad.push(r.dataset.entryId);
        }
        return { maxPad, badgeCount, mismatched, shallowBadge: bad.length, rows: rows.length };
      })()`, false);
      check("P1 V1c D 徽标与深度一致，缩进封顶 ≤36px",
        badges.mismatched === 0 && badges.shallowBadge === 0 && badges.badgeCount > 0 && badges.maxPad <= 36,
        `徽标=${badges.badgeCount} · 不匹配=${badges.mismatched} · 浅层误标=${badges.shallowBadge} · 最大缩进=${badges.maxPad}px`);

      // 自动跟随 leaf 会滚到底部；先把第一条摘要滚进视口再点（真实用户动作）
      await evaluate(cdp, `document.querySelector('[data-role=tree-branch-summary]')?.scrollIntoView({ block: 'center' })`, false);
      await sleep(150);
      const before = await evaluate(cdp, `document.querySelectorAll('.tree-flat .tree-node').length`, false);
      const clickSummary = await clickSelector(cdp, "[data-role=tree-branch-summary]");
      const expanded = await waitFor(cdp, `(() => {
        const s = document.querySelector('[data-role=tree-branch-summary]');
        const nodes = document.querySelectorAll('.tree-flat .tree-node').length;
        return nodes > ${before} ? { nodes, expanded: s?.getAttribute('aria-expanded') } : null;
      })()`, 3000);
      check("P1 V2 点摘要行 → 就地展开分支（行数增加、aria-expanded=true）",
        clickSummary.hit && expanded.ok && expanded.value.expanded === "true",
        `hit=${clickSummary.hit} · 展开前 ${before} → 展开后 ${expanded.value?.nodes} 行 · aria=${expanded.value?.expanded}`);

      const searchInfo = await evaluate(cdp, `(() => {
        const input = document.querySelector('[data-role=tree-search]');
        if (!input) return { error: 'no search input' };
        input.value = 'b400_50';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { value: input.value };
      })()`, false);
      const found = await waitFor(cdp, `(() => {
        const el = document.querySelector('.tree-flat .tree-node[data-entry-id="b400_50"]');
        const hit = el && el.classList.contains('is-search-hit');
        const ancestor = document.querySelector('[data-branch-of="n400"]');
        return el ? {
          exists: true, hit: !!hit, inView: (() => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })(),
          ancestorExpanded: ancestor?.getAttribute('aria-expanded') || null,
          count: document.querySelector('[data-role=tree-search-count]')?.textContent || '',
        } : null;
      })()`, 4000);
      check("P1 V3 搜索分支深处 id → 自动展开祖先、滚动并高亮",
        !searchInfo.error && found.ok && found.value.hit && found.value.ancestorExpanded === "true" && found.value.inView && /命中/.test(found.value.count),
        `输入=${searchInfo.value} · 命中=${found.value?.count} · 高亮=${found.value?.hit} · 在视口=${found.value?.inView} · n400 摘要=${found.value?.ancestorExpanded}`);

      const idPrefix = await evaluate(cdp, `(() => {
        const input = document.querySelector('[data-role=tree-search]');
        input.value = 'b700_';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`, false);
      const prefix = await waitFor(cdp, `(() => {
        const t = document.querySelector('[data-role=tree-search-count]')?.textContent || '';
        return /\\d+ \\/ \\d+ 命中/.test(t) ? t : null;
      })()`, 3000);
      check("P1 V3b 搜索支持 id 前缀匹配", !!idPrefix && prefix.ok, `结果条「${prefix.value}」`);

      // 15s 稳定性（回到主干视图，避免停留在展开态）
      await clickSelector(cdp, "[data-role=tree-collapse]");
      const tStart = Date.now();
      let alive = true;
      while (Date.now() - tStart < 15000) {
        await sleep(1000);
        alive = await evaluate(cdp, `!!document.querySelector('.tree-flat') && !!document.querySelector('[data-role=tree-stats]') && document.visibilityState !== 'crash'`, false).catch(() => false);
        if (!alive) break;
      }
      const metrics = await cdp.send("Performance.getMetrics");
      const heap = Number(metrics.metrics.find((m) => m.name === "JSHeapUsedSize")?.value || 0);
      const realErrors = pageErrors.filter((t) => !/net::ERR_|ERR_ABORTED|Failed to load resource/.test(String(t)));
      check("P1 V4 15s 内页面不崩、无未捕获异常、堆 < 300MB",
        alive && realErrors.length === 0 && heap < 300 * 1024 * 1024,
        `alive=${alive} · heap=${(heap / 1024 / 1024).toFixed(1)}MB · 异常=${realErrors.length ? realErrors.slice(0, 2).join(" | ") : "无"}`);

      await shot(cdp, screenshot);
      check("P1 V5 截图存档", fs.existsSync(screenshot) && fs.statSync(screenshot).size > 0, screenshot);
    },
  });

  // ---------- P2：5000 节点线性 ----------
  await runPhase({
    label: "P2-5000线性",
    writeFixture: writeWideFixture,
    shotName: "tree-view-5000.png",
    run: async ({ cdp, pageErrors, screenshot }) => {
      const opened = await openTreePanel(cdp);
      const shape = await evaluate(cdp, `(() => {
        const rows = [...document.querySelectorAll('.tree-flat > .tree-row')];
        const fold = document.querySelector('.tree-flat .tree-fold');
        return {
          rows: rows.length,
          nodes: rows.filter((r) => r.classList.contains('tree-node')).length,
          fold: fold ? fold.textContent : null,
          stats: document.querySelector('[data-role=tree-stats]')?.textContent || '',
          leafVisible: !!document.querySelector('.tree-flat .tree-node.is-leaf'),
        };
      })()`, false);
      check("P2 V6 5000 节点首屏 ≤1s（只渲染主干 + 中间折叠，DOM ≤4000）",
        opened.clicked.hit && !!opened.first && opened.elapsed <= 1000 && shape.rows <= ROW_CAP && shape.nodes > 0,
        `首屏实测 ${opened.elapsed}ms · rows=${shape.rows} · 主干行=${shape.nodes} · 叶子可见=${shape.leafVisible} · ${shape.stats}`);
      check("P2 V6b 超长主干中间折叠（保留根侧 300 + 叶子侧 1200）",
        !!shape.fold && /折叠中间 1\d{2} 个主干节点/.test(shape.fold) && shape.nodes === 1500,
        `折叠行「${shape.fold}」· 主干行=${shape.nodes}`);

      // 展开全部：每页 500，直到 4000 行硬上限
      let clicks = 0;
      let state = null;
      while (clicks < 14) {
        state = await evaluate(cdp, `(() => {
          const btn = document.querySelector('[data-role=tree-expand]');
          return { disabled: !!btn?.disabled, text: btn?.textContent || '', rows: document.querySelectorAll('.tree-flat > .tree-row').length };
        })()`, false);
        if (state.disabled) break;
        await clickSelector(cdp, "[data-role=tree-expand]");
        clicks++;
        await sleep(250);
      }
      state = await evaluate(cdp, `(() => {
        const btn = document.querySelector('[data-role=tree-expand]');
        const rows = [...document.querySelectorAll('.tree-flat > .tree-row')];
        return {
          disabled: !!btn?.disabled,
          text: btn?.textContent || '',
          rows: rows.length,
          nodes: rows.filter((r) => r.classList.contains('tree-node')).length,
        };
      })()`, false);
      check("P2 V7 「展开全部」按 500 分页并停在 DOM 硬上限 4000",
        clicks >= 1 && state.rows <= ROW_CAP && state.rows >= 3500 && state.disabled && /上限 4000/.test(state.text),
        `点击 ${clicks} 次 · rows=${state.rows}（节点 ${state.nodes}）· 按钮「${state.text}」`);

      const realErrors = pageErrors.filter((t) => !/net::ERR_|ERR_ABORTED|Failed to load resource/.test(String(t)));
      check("P2 V8 展开到上限过程中无未捕获异常",
        realErrors.length === 0,
        `异常=${realErrors.length ? realErrors.slice(0, 2).join(" | ") : "无"}`);

      await shot(cdp, screenshot);
      check("P2 V9 截图存档", fs.existsSync(screenshot) && fs.statSync(screenshot).size > 0, screenshot);
    },
  });
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
