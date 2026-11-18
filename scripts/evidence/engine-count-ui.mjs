#!/usr/bin/env node
// Q6 验收：引擎计数（1 个标签页只能占 1 个引擎；开着第 2 个标签页不该「提示开太多」）
//
// 现场：PI_SHELL_MAX_ENGINES=2 时，第 2 个标签页偶尔被 503「已达并行上限」拦住，
// 因为桥的 max 判定数的是池内记录（含关标签页后 60s 内还没被 sweep 到的僵尸引擎），
// 而前端一列可能因为 SSE + API 双请求并发认领出两个引擎。
//
// 断言（端口 7863 独占，夹具 sessions，PI_SHELL_MAX_ENGINES=2）：
//   E1 1 个标签页 → health.engineCount == 1，且该页 clientId 在 health.engines 里只有 1 条
//   E2 开第 2 个标签页 → engineCount == 2，两页 clientId 互不相同，第 2 页无「已达上限」提示
//   E3 5s 内反复采样：engineCount 从不超过 2（SSE/API 双请求不重复认领）
//   E4 关掉第 2 个标签页 → ≤75s 回到 1（空闲引擎被 sweep 掉），第 1 页仍可用
//
// 用法：node scripts/evidence/engine-count-ui.mjs      （EDGE_PATH 可指定 msedge.exe）
// 环境变量：PI_SHELL_ENGINE_PORT（默认 7863）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_ENGINE_PORT || 7863);
const DEBUG_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-engine-count");
const SESSIONS = path.join(OUT_DIR, "sessions");
const WORKSPACE = path.join(REPO_ROOT, ".tmp-evidence-engine-count", "workspace");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");

// 上限刻意钉成 2：两个标签页刚好占满 —— 任何重复认领 / 僵尸占位都会立刻暴露成 503 或 count > 2
const MAX_ENGINES = 2;
const RECLAIM_DEADLINE_MS = 80000; // 60s 空闲 + sweep 5s 周期 + 余量
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具 ----------

function writeFixtureSession() {
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const cwd = WORKSPACE.replace(/\\/g, "/");
  const dir = path.join(SESSIONS, cwd.replace(/[:/]/g, "-").replace(/^/, "--"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "q6-engine-0001.jsonl");
  const now = Date.now();
  const rows = [
    { type: "session", version: 3, id: "q6-engine-0001", timestamp: new Date(now - 60000).toISOString(), cwd },
    {
      type: "message",
      id: "m1",
      timestamp: new Date(now - 50000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "夹具：引擎计数取证（1 标签页 = 1 引擎）。" }] },
    },
    {
      type: "message",
      id: "m2",
      timestamp: new Date(now - 40000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "收到，夹具助手回复。" }] },
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
  throw new Error(
    `等待超时（${label}，${ms}ms）count=${last?.engineCount} engines=${JSON.stringify((last?.engines ?? []).map((e) => `${String(e.id).slice(-6)}:${e.state}`))}`,
  );
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

/** 页面就绪：主界面 + 版本回填（= 已认领引擎）+ engineNotice（认领失败时的提示条） */
const PAGE_STATE = `(() => {
  const col = document.querySelector('.column');
  return {
    ready: !!document.getElementById('input') && (document.getElementById('version')?.textContent || '—') !== '—' && !!window.__piShell,
    version: document.getElementById('version')?.textContent || '—',
    clientId: window.__piShell?.clientId ?? null,
    tabClientId: window.__piShell?.tabClientId ?? null,
    notice: (col?.querySelector('[data-role=notice]')?.textContent || '').trim(),
    noticeShown: (() => { const b = col?.querySelector('[data-role=notice]'); return !!b && !b.hidden; })(),
  };
})()`;

async function waitReady(cdp, ms = 40000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await evaluate(cdp, PAGE_STATE, false).catch(() => null);
    if (last?.ready) return last;
    await sleep(250);
  }
  return last;
}

async function newTab(url) {
  const endpoint = `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`;
  let res = await fetch(endpoint, { method: "PUT" });
  if (!res.ok) res = await fetch(endpoint, { method: "GET" });
  if (!res.ok) throw new Error(`新建标签页失败：HTTP ${res.status}`);
  return res.json();
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(path.dirname(WORKSPACE), { recursive: true, force: true });
  writeFixtureSession();

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
  let cdpA = null;
  let cdpB = null;

  try {
    const health0 = await waitHealth((h) => h?.pi?.state === "idle", 45000, "bridge idle");
    console.log(`bridge ready · max engines=${health0.maxEngines} · pi=${health0.pi?.version}`);
    if (health0.maxEngines !== MAX_ENGINES) throw new Error(`桥的 maxEngines=${health0.maxEngines}，本脚本要求 ${MAX_ENGINES}`);

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

    let targetA = null;
    for (let i = 0; i < 120 && !targetA; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
        targetA = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch {}
      if (!targetA) await sleep(250);
    }
    if (!targetA) throw new Error("Edge CDP 未就绪");

    cdpA = cdpConnect(targetA.webSocketDebuggerUrl);
    await cdpA.ready;
    await cdpA.send("Runtime.enable");
    await cdpA.send("Page.enable");

    const pageA = await waitReady(cdpA);
    if (!pageA?.ready) throw new Error(`标签页 1 未就绪：${JSON.stringify(pageA)}`);

    // ================= E1 1 个标签页 = 1 个引擎 =================
    await sleep(1500); // 给 SSE / 列表 / 模型等请求留出撞车窗口（重复认领会在这里冒出来）
    const h1 = await getHealth();
    const tabAEngines = (h1.engines || []).filter((e) => String(e.id).startsWith(pageA.tabClientId));
    check(
      "E1 1 个标签页 → engineCount == 1（该标签页只占 1 个引擎）",
      pageA.version !== "—" && h1.engineCount === 1 && tabAEngines.length === 1 && tabAEngines[0].id === pageA.clientId,
      `page=${pageA.clientId} engines=${(h1.engines || []).map((e) => String(e.id).slice(-6)).join(",")} count=${h1.engineCount} max=${h1.maxEngines}`,
    );

    // ================= E2 第 2 个标签页 → 2 个引擎（不报「开太多」） =================
    const tab = await newTab(`${BASE}/`);
    cdpB = cdpConnect(tab.webSocketDebuggerUrl);
    await cdpB.ready;
    await cdpB.send("Runtime.enable");
    await cdpB.send("Page.enable");
    const pageB = await waitReady(cdpB);
    if (!pageB?.ready) throw new Error(`标签页 2 未就绪：${JSON.stringify(pageB)}`);
    const h2 = await waitHealth((h) => (h.engines || []).length >= 2, 25000, "2 engines");
    const ids = (h2.engines || []).map((e) => e.id);
    check(
      "E2 开第 2 个标签页 → engineCount == 2（两个不同 clientId，无「已达上限」提示）",
      h2.engineCount === 2 && ids.length === 2 && new Set(ids).size === 2 && pageB.clientId !== pageA.clientId &&
        !pageB.noticeShown && pageB.version !== "—",
      `A=${String(pageA.clientId).slice(-6)} B=${String(pageB.clientId).slice(-6)} count=${h2.engineCount} notice=「${pageB.notice}」`,
    );

    // ================= E3 5s 采样：永不超过 2（SSE + API 不重复认领） =================
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const h = await getHealth();
      samples.push(h.engineCount);
      await sleep(500);
    }
    check(
      "E3 5s 内反复采样：engineCount 从不超过 2（SSE/API 双请求不重复 claim）",
      samples.every((n) => n <= 2) && samples[samples.length - 1] === 2,
      `samples=${samples.join(",")}`,
    );

    // ================= E4 关掉第 2 个标签页 → ≤75s 回到 1 =================
    const closedAt = Date.now();
    await cdpB.send("Page.close").catch(() => {});
    cdpB.close();
    cdpB = null;
    let reclaimedMs = null;
    let lastCount = null;
    while (Date.now() - closedAt < RECLAIM_DEADLINE_MS) {
      const h = await getHealth().catch(() => null);
      lastCount = h?.engineCount ?? lastCount;
      if (h && h.engineCount <= 1) {
        reclaimedMs = Date.now() - closedAt;
        break;
      }
      await sleep(500);
    }
    const hAfter = await getHealth();
    const pageAAfter = await evaluate(cdpA, PAGE_STATE, false);
    check(
      "E4 关掉第 2 个标签页 → ≤75s engineCount 回到 1，第 1 个标签页仍可用",
      reclaimedMs != null && hAfter.engineCount === 1 && pageAAfter?.ready === true && pageAAfter.clientId === pageA.clientId,
      `count=${lastCount} 回收耗时=${reclaimedMs == null ? "超时" : `${Math.round(reclaimedMs / 1000)}s`} 剩余=${(hAfter.engines || []).map((e) => String(e.id).slice(-6)).join(",")}`,
    );
  } finally {
    try {
      cdpA?.close();
    } catch {}
    try {
      cdpB?.close();
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
