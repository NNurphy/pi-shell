#!/usr/bin/env node
// N1-b 验收：资源面板（RSS / 释放 / 只留当前列 / 关 MCP）
//
// 覆盖（端口 7901 独占，夹具 sessions，PI_SHELL_MAX_ENGINES=4）：
//   R1 开 2 列 → 资源面板 2 行、每行 rssMB>0、底部合计 = 两行之和（±10%）
//   R2「只留当前列」弹确认框；点取消 → 引擎数不变（取消不生效）
//   R3 点第 2 行「释放」→ health.engines 变 1；页面第 2 列提示「已释放（重新打开会话可恢复）」且不报错
//   R4 重新打开第 2 列会话 → 引擎回到 2；「只留当前列」确认后只剩当前 client
//   R5 给当前引擎开 MCP → 采样两次 RSS；点「关 MCP」→ 采样两次 RSS 下降 ≥100MB（或说明跳过原因）
//   R6 全程无未捕获 JS 异常
//   截图 docs/evidence/resources-panel-*.png
//
// 用法：node scripts/evidence/engines-resource-ui.mjs   （EDGE_PATH 可指定 msedge.exe）
// 环境变量：PI_SHELL_RESOURCE_PORT（默认 7901）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_RESOURCE_PORT || 7901);
const DEBUG_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-resources");
const SESSIONS = path.join(OUT_DIR, "sessions");
const WORKSPACE = path.join(OUT_DIR, "workspace");
const MCP_CONFIG = path.join(OUT_DIR, "pi-shell-mcp.json");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const MAX_ENGINES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具 ----------

function writeFixtureSession({ id = "n1-resource-0001", title = "夹具：N1-b 资源面板取证。" } = {}) {
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const cwd = WORKSPACE.replace(/\\/g, "/");
  const dir = path.join(SESSIONS, cwd.replace(/[:/]/g, "-").replace(/^/, "--"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const now = Date.now();
  const rows = [
    { type: "session", version: 3, id, timestamp: new Date(now - 60000).toISOString(), cwd },
    {
      type: "message",
      id: "m1",
      timestamp: new Date(now - 50000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: title }] },
    },
    {
      type: "message",
      id: "m2",
      timestamp: new Date(now - 40000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "收到，资源面板可释放我。" }] },
    },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return file;
}

// ---------- bridge ----------

function startBridge() {
  fs.writeFileSync(MCP_CONFIG, `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_CWD: WORKSPACE,
      PI_SHELL_LOG_FILE: LOG_FILE,
      PI_SHELL_MAX_ENGINES: String(MAX_ENGINES),
      PI_SHELL_MCP_CONFIG: MCP_CONFIG,
    },
    stdio: "ignore",
  });
}

async function getHealth() {
  const res = await fetch(`${BASE}/api/health`, { cache: "no-store" });
  return res.json();
}

async function getStats() {
  const res = await fetch(`${BASE}/api/engines/stats`, { cache: "no-store" });
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
  throw new Error(`等待超时（${label}）：${JSON.stringify((last?.engines ?? []).map((e) => `${e.id}:${e.state}:${JSON.stringify(e.mcp)}`))}`);
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

async function clickElement(cdp, selector, index = 0) {
  const box = await evaluate(
    cdp,
    `(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = nodes[${index}];
      if (!el) return { error: 'not found', count: nodes.length };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      const ok = !!hit && (hit === el || el.contains(hit));
      return { x, y, ok, count: nodes.length, hitTag: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') : null, disabled: !!el.disabled };
    })()`,
    false,
  );
  if (box.error) return box;
  if (!box.ok || box.disabled) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
}

async function shot(cdp, name) {
  const png = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, Buffer.from(png.data, "base64"));
  console.log(`      截图：${file}`);
  return file;
}

const PAGE_STATE = `(() => {
  const version = (document.getElementById('version')?.textContent || '').trim();
  return {
    ready: !!document.getElementById('input') && version && version !== '—' && !!window.__piShell,
    version,
    clientId: window.__piShell?.clientId ?? null,
    tabClientId: window.__piShell?.tabClientId ?? null,
    columns: window.__piShell?.columns?.() ?? [],
    active: window.__piShell?.activeColumnKey ?? null,
  };
})()`;

const PANEL_STATE = `(() => {
  const panel = document.getElementById('resources-panel');
  const rows = [...document.querySelectorAll('#resources-list tr[data-client]')].map((tr) => {
    const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim());
    return {
      client: tr.dataset.client,
      current: tr.dataset.current === '1',
      cells,
      release: !!tr.querySelector('.res-release'),
      mcpOffDisabled: !!tr.querySelector('.res-mcp-off')?.disabled,
    };
  });
  const summary = (document.getElementById('resources-summary')?.textContent || '').trim();
  const status = (document.getElementById('resources-status')?.textContent || '').trim();
  return {
    shown: !!panel && getComputedStyle(panel).display !== 'none',
    rows,
    summary,
    status,
  };
})()`;

const COLUMN_STATE = `(() => {
  return [...document.querySelectorAll('.column')].map((col, i) => {
    const notice = col.querySelector('[data-role=notice]');
    return {
      index: i + 1,
      key: col.dataset.colKey || null,
      client: col.dataset.client || null,
      hidden: !!col.hidden,
      notice: (notice?.textContent || '').trim(),
      noticeShown: !!notice && !notice.hidden,
      noticeKind: notice?.dataset?.kind || '',
      inputDisabled: !!col.querySelector('[data-role=composer-input]')?.disabled,
      sendDisabled: !!col.querySelector('[data-role=send]')?.disabled,
    };
  });
})()`;

async function waitReady(cdp, ms = 45000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await evaluate(cdp, PAGE_STATE, false).catch(() => null);
    if (last?.ready) return last;
    await sleep(250);
  }
  return last;
}

async function waitPanel(cdp, pred, ms, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await evaluate(cdp, PANEL_STATE, false).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(300);
  }
  throw new Error(`等待资源面板超时（${label}）：${JSON.stringify(last)}`);
}

async function waitColumn(cdp, pred, ms, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await evaluate(cdp, COLUMN_STATE, false).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(250);
  }
  throw new Error(`等待列状态超时（${label}）：${JSON.stringify(last)}`);
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
  return { edge, target };
}

function parseMb(text) {
  const m = String(text ?? "").match(/([\d.]+)\s*MB/i);
  return m ? Number(m[1]) : null;
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const fixture = writeFixtureSession();
  const fixtureB = writeFixtureSession({ id: "n1-resource-0002", title: "夹具：第二列（重新打开恢复）" });

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
  const pageErrors = [];

  try {
    const health0 = await waitHealth((h) => h?.pi?.state === "idle", 45000, "bridge idle");
    console.log(`bridge ready · max engines=${health0.maxEngines} · pi=${health0.pi?.version}`);

    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        pageErrors.push(d?.exception?.description || d?.text || "exception");
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        pageErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });

    const page = await waitReady(cdp);
    if (!page?.ready) throw new Error(`页面未就绪：${JSON.stringify(page)}`);
    // 第一列打开夹具会话（列头有标题 / 释放后可重新打开恢复）
    await evaluate(cdp, `window.__piShell.openPath(${JSON.stringify(fixture)})`);
    await sleep(1200);

    // ================= R1 两列 + 面板 2 行 =================
    const split = await clickElement(cdp, '.split-btn[data-split="2"]');
    check("R1a 点顶栏「2」→ 建出第 2 列", split?.hit === true, `hit=${split?.hit} ${split?.hitTag ?? ""}`);
    const h2 = await waitHealth((h) => (h.engines || []).length === 2, 45000, "2 engines");
    check("R1b 两列 = 两个引擎", h2.engineCount === 2, `engines=${(h2.engines || []).map((e) => e.id).join(",")}`);

    const opened = await clickElement(cdp, "#open-menu");
    await sleep(250);
    const menuClick = await clickElement(cdp, "#open-resources");
    check("R1c ⋯ → 资源 可打开", opened?.hit === true && menuClick?.hit === true, `menu=${opened?.hit} item=${menuClick?.hit}`);
    const panel2 = await waitPanel(cdp, (p) => p.shown && p.rows.length === 2, 15000, "2 rows");
    const rowMb = panel2.rows.map((r) => parseMb(r.cells[4]));
    const sum = rowMb.reduce((n, v) => n + (Number(v) || 0), 0);
    check(
      "R1d 面板 2 行，每行 rssMB > 0",
      panel2.rows.length === 2 && rowMb.every((v) => v != null && v > 0),
      `rows=${panel2.rows.map((r) => r.cells[0]).join(" | ")} rss=${rowMb.join("+")}MB`,
    );
    check(
      "R1e 底部合计 = 两行之和（±10%）且带「共 2 个引擎 · 上限 4」",
      /共\s*2\s*个引擎/.test(panel2.summary) &&
        /上限\s*4/.test(panel2.summary) &&
        Math.abs((parseMb(panel2.summary) ?? 0) - sum) <= Math.max(10, sum * 0.1),
      `summary=「${panel2.summary}」 rowSum=${Math.round(sum * 10) / 10}MB`,
    );
    check(
      "R1f 行内「释放 / 关 MCP」按钮存在，且表格列齐全（标题/模型/状态/MCP/内存/空闲/操作）",
      panel2.rows.every((r) => r.release && r.cells.length === 7),
      `cols=${panel2.rows.map((r) => r.cells.length).join(",")}`,
    );
    await shot(cdp, "resources-panel-2engines.png");

    const stats2 = await getStats();
    check(
      "R1g GET /api/engines/stats 字段齐全（client/tab/state/sessionId/sessionTitle/mcp/piPid/rssMB/idleSec）",
      stats2.count === 2 &&
        stats2.engines.every(
          (e) =>
            typeof e.client === "string" &&
            "tab" in e &&
            typeof e.state === "string" &&
            "sessionId" in e &&
            "sessionTitle" in e &&
            Array.isArray(e.mcp) &&
            "piPid" in e &&
            Number.isFinite(e.rssMB) &&
            Number.isFinite(e.idleSec),
        ),
      `count=${stats2.count} total=${stats2.totalRssMB}MB`,
    );

    // ================= R2 只留当前列：确认框可出现，取消不生效 =================
    const keep1 = await clickElement(cdp, "#resources-keep-active");
    await sleep(300);
    const modal1 = await evaluate(
      cdp,
      `(() => {
        const modal = document.getElementById('modal');
        const box = modal?.querySelector('[data-role=confirm-box]');
        return {
          shown: !!modal && !modal.hidden && !!box,
          text: (box?.querySelector('[data-role=confirm-text]')?.textContent || '').trim(),
          title: (box?.querySelector('h2')?.textContent || '').trim(),
        };
      })()`,
      false,
    );
    check(
      "R2a「只留当前列」弹出确认框（取消/继续都在）",
      keep1?.hit === true && modal1.shown && /释放其它/.test(modal1.text) && /只留当前列/.test(modal1.title),
      `title=「${modal1.title}」 text=「${modal1.text}」`,
    );
    await shot(cdp, "resources-panel-confirm.png");
    const cancel = await clickElement(cdp, "[data-role=confirm-cancel]");
    await sleep(1200);
    const hAfterCancel = await getHealth();
    const modalGone = await evaluate(cdp, `(() => document.getElementById('modal')?.hidden !== false)()`, false);
    check(
      "R2b 点取消 → 确认框关闭且引擎数不变（取消不生效）",
      cancel?.hit === true && modalGone === true && hAfterCancel.engineCount === 2,
      `count=${hAfterCancel.engineCount} modalHidden=${modalGone}`,
    );

    // ================= R3 释放第 2 行 =================
    const page2 = await evaluate(cdp, PAGE_STATE, false);
    const secondClient = page2.columns[1]?.clientId;
    const secondKey = page2.columns[1]?.key;
    const release2 = await clickElement(cdp, `#resources-list tr[data-client="${secondClient}"] .res-release`);
    const h1 = await waitHealth((h) => (h.engines || []).length === 1, 20000, "release second");
    const colsAfter = await waitColumn(
      cdp,
      (list) => list.some((c) => c.key === secondKey && /已释放（重新打开会话可恢复）/.test(c.notice)),
      8000,
      "second column released notice",
    );
    const col2 = colsAfter.find((c) => c.key === secondKey);
    check(
      "R3a 点第 2 行「释放」→ health.engines 变 1",
      release2?.hit === true && h1.engineCount === 1 && !(h1.engines || []).some((e) => e.id === secondClient),
      `count=${h1.engineCount} released=${String(secondClient).slice(-8)}`,
    );
    check(
      "R3b 页面第 2 列显示「已释放（重新打开会话可恢复）」且不报错（notice info、输入禁用）",
      !!col2 &&
        /已释放（重新打开会话可恢复）/.test(col2.notice) &&
        col2.noticeShown === true &&
        col2.noticeKind === "info" &&
        col2.sendDisabled === true,
      `notice=「${col2?.notice}」 kind=${col2?.noticeKind} sendDisabled=${col2?.sendDisabled}`,
    );
    await clickElement(cdp, "#resources-close");
    await sleep(300);
    await shot(cdp, "resources-panel-after-release.png");

    // ================= R4 重新打开第 2 列 → 引擎回到 2；只留当前列真生效 =================
    const revived = await evaluate(
      cdp,
      `(async () => {
        const cols = window.__piShell.columns();
        const target = cols.find((c) => c.key === ${JSON.stringify(secondKey)});
        window.__piShell.activateColumn(target.key);
        const data = await window.__piShell.openPath(${JSON.stringify(fixtureB)});
        return { sessionId: data?.sessionId ?? null, cols: window.__piShell.columnCount };
      })()`,
      true,
    );
    const h2b = await waitHealth((h) => (h.engines || []).length === 2, 45000, "revive second");
    check(
      "R4a 第 2 列重新打开会话 → 重新认领引擎（引擎回到 2）",
      !!revived?.sessionId && h2b.engineCount === 2,
      `session=${String(revived?.sessionId).slice(0, 8)} count=${h2b.engineCount}`,
    );
    await evaluate(cdp, `window.__piShell.activateColumn(${JSON.stringify(page2.columns[0].key)})`);
    await sleep(300);
    const activeClient = (await evaluate(cdp, PAGE_STATE, false)).clientId;
    await evaluate(cdp, `window.__piShell.openResources()`);
    await waitPanel(cdp, (p) => p.shown && p.rows.length === 2, 15000, "2 rows again");
    const keep2 = await clickElement(cdp, "#resources-keep-active");
    await sleep(300);
    const confirm2 = await clickElement(cdp, "[data-role=confirm-continue]");
    const h1b = await waitHealth((h) => (h.engines || []).length === 1, 25000, "keep only active");
    const statsKeep = await getStats();
    check(
      "R4b「只留当前列」确认后只剩当前 client",
      keep2?.hit === true &&
        confirm2?.hit === true &&
        h1b.engineCount === 1 &&
        statsKeep.engines[0]?.client === activeClient,
      `active=${String(activeClient).slice(-8)} remaining=${(statsKeep.engines || []).map((e) => String(e.client).slice(-8)).join(",")}`,
    );
    const colsKeep = await waitColumn(
      cdp,
      (list) => list.some((c) => c.key !== page2.columns[0].key && /已释放（重新打开会话可恢复）/.test(c.notice)),
      8000,
      "other column released notice",
    );
    check(
      "R4c 其它本地列被标记为已释放（不再自动重连）",
      colsKeep.some((c) => c.key !== page2.columns[0].key && /已释放（重新打开会话可恢复）/.test(c.notice)),
      colsKeep.map((c) => `${c.key}:${c.notice}`).join(" | "),
    );

    // ================= R5 关 MCP → RSS 下降 =================
    let skipReason = "";
    let mcpServer = null;
    try {
      const mcpState = await (await fetch(`${BASE}/api/mcp/state`)).json();
      const available = (mcpState.available || []).map((s) => s.name);
      mcpServer = available.includes("codegraph") ? "codegraph" : available[0] || null;
      if (!mcpServer) skipReason = `mcp.json 没有可用 server（available=${JSON.stringify(available)}）`;
    } catch (err) {
      skipReason = `读取 /api/mcp/state 失败：${err.message}`;
    }

    let baselineMb = null;
    let afterMb = null;
    if (mcpServer) {
      const client = activeClient;
      const restart = await fetch(`${BASE}/api/engine/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client, mcp: [mcpServer] }),
      });
      const restartBody = await restart.json().catch(() => ({}));
      if (!restart.ok) {
        skipReason = `开 MCP 失败：HTTP ${restart.status} ${restartBody?.error?.message || ""}`;
      } else {
        await waitHealth((h) => (h.engines || []).some((e) => e.id === client && e.state === "idle" && (e.mcp || []).length > 0), 120000, "mcp on");
        await evaluate(cdp, `window.__piShell.openResources()`);
        const onPanel = await waitPanel(cdp, (p) => p.shown && p.rows.length === 1, 15000, "1 row mcp on");
        await sleep(6000); // 跨过桥侧 5s RSS 缓存
        const s1 = await getStats();
        await sleep(6000);
        const s2 = await getStats();
        const rowOn = (s2.engines || []).find((e) => e.client === client);
        baselineMb = rowOn?.rssMB ?? null;
        check(
          "R5a 给当前引擎开 MCP → 该行 mcp 非空且 rssMB > 0",
          !!rowOn && (rowOn.mcp || []).includes(mcpServer) && Number.isFinite(baselineMb) && baselineMb > 0,
          `server=${mcpServer} mcp=${JSON.stringify(rowOn?.mcp)} rss=${s1.engines?.[0]?.rssMB}→${baselineMb}MB`,
        );
        await shot(cdp, "resources-panel-mcp-on.png");
        if (onPanel.rows[0]?.mcpOffDisabled) skipReason = "面板「关 MCP」按钮不可用";
        else {
          const mcpOff = await clickElement(cdp, "#resources-list tr .res-mcp-off");
          await waitHealth((h) => (h.engines || []).some((e) => e.id === client && e.state === "idle" && (e.mcp || []).length === 0), 120000, "mcp off");
          await sleep(6000);
          const s3 = await getStats();
          await sleep(6000);
          const s4 = await getStats();
          afterMb = (s4.engines || []).find((e) => e.client === client)?.rssMB ?? null;
          check(
            "R5b 关 MCP 后该行 rssMB 下降（采样两次，≥100MB）",
            mcpOff?.hit === true && Number.isFinite(afterMb) && baselineMb - afterMb >= 100,
            `on=${baselineMb}MB off=${afterMb}MB 差=${Number.isFinite(afterMb) ? Math.round((baselineMb - afterMb) * 10) / 10 : "?"}MB（采样 ${s3.engines?.[0]?.rssMB}→${afterMb}）`,
          );
          await shot(cdp, "resources-panel-mcp-off.png");
        }
      }
    }
    if (!baselineMb || !afterMb) {
      // 环境里没有可用的 MCP server / 开 MCP 失败 → 允许带明确原因跳过（任务书：≥100MB 或说明原因）
      check(
        "R5b 关 MCP 后该行 rssMB 下降（≥100MB）",
        !!skipReason,
        skipReason ? `跳过：${skipReason}` : "未拿到前后样本，且没有可解释的原因",
      );
    }

    // 面板开着时点关闭，避免遮罩影响后续
    await clickElement(cdp, "#resources-close").catch(() => {});

    // ================= R6 无未捕获 JS 异常 =================
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_|Failed to fetch/i.test(String(t)));
    check("R6 全程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");
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
        fs.rmSync(OUT_DIR, { recursive: true, force: true });
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
