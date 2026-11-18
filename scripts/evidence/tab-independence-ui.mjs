#!/usr/bin/env node
// N1-a 验收：复制标签页不再抢同一个后台（clientId 冲突检测 + 独立引擎 + 长任务互不中止 + 回收）
//
// 现场：clientId 存 sessionStorage，浏览器「复制标签页」会把它一起复制 → 两个页面认领同一个
// 引擎，互相顶掉，还容易误报「引擎上限」。
//
// 断言（端口 7899 独占，夹具 sessions，PI_SHELL_MAX_ENGINES=4）：
//   T1 页 A 就绪，拿到它的 tabClientId
//   T2 新开页 B 并在文档脚本里注入 A 的 clientId（模拟复制标签页）→ B 的 clientId 变了
//   T3 health.engines 有 2 个，clientId 互不相同，分别属于 A / B，tab 字段互不相同
//   T4 两页同时各发一条长任务 → 两边输出都在增长（互不中止），两个引擎都到过 streaming
//   T5 关掉 B → 60–75s 后 engines 回到 1，A 不受影响（clientId / 可交互）
//
// 用法：node scripts/evidence/tab-independence-ui.mjs   （EDGE_PATH 可指定 msedge.exe）
// 环境变量：PI_SHELL_TAB_PORT（默认 7899）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_TAB_PORT || 7899);
const DEBUG_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-tab-independence");
const SESSIONS = path.join(OUT_DIR, "sessions");
const WORKSPACE = path.join(OUT_DIR, "workspace");
const MCP_CONFIG = path.join(OUT_DIR, "pi-shell-mcp.json");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const MAX_ENGINES = 4;
const RECLAIM_DEADLINE_MS = 80000;
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
  const file = path.join(dir, "n1-tab-0001.jsonl");
  const now = Date.now();
  const rows = [
    { type: "session", version: 3, id: "n1-tab-0001", timestamp: new Date(now - 60000).toISOString(), cwd },
    {
      type: "message",
      id: "m1",
      timestamp: new Date(now - 50000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "夹具：N1-a 标签页独立取证。" }] },
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
  throw new Error(`等待超时（${label}）：count=${last?.engineCount} engines=${JSON.stringify((last?.engines ?? []).map((e) => `${String(e.id).slice(-8)}:${e.state}`))}`);
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

const PAGE_STATE = `(() => {
  const col = document.querySelector('.column');
  const notice = col?.querySelector('[data-role=notice]');
  return {
    ready: !!document.getElementById('input') && (document.getElementById('version')?.textContent || '—') !== '—' && !!window.__piShell,
    version: document.getElementById('version')?.textContent || '—',
    clientId: window.__piShell?.clientId ?? null,
    tabClientId: window.__piShell?.tabClientId ?? null,
    tabId: window.__piShell?.tabId ?? null,
    columns: window.__piShell?.columnCount ?? 0,
    notice: (notice?.textContent || '').trim(),
    noticeShown: !!notice && !notice.hidden,
    logLen: (col?.querySelector('[data-role=log]')?.textContent || '').length,
  };
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

async function newTab(url) {
  const endpoint = `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`;
  let res = await fetch(endpoint, { method: "PUT" });
  if (!res.ok) res = await fetch(endpoint, { method: "GET" });
  if (!res.ok) throw new Error(`新建标签页失败：HTTP ${res.status}`);
  return res.json();
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

/** 直接走桥的 prompt：每页一个自己的 clientId + tabId（显式头，不依赖全局 fetch 的当前列） */
async function sendPrompt(cdp, clientId, tabId, text) {
  return evaluate(
    cdp,
    `fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Shell-Client': ${JSON.stringify(clientId)}, 'X-Pi-Shell-Tab': ${JSON.stringify(tabId)} },
      body: JSON.stringify({ message: ${JSON.stringify(text)} })
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`,
    true,
  );
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
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

    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdpA = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdpA.ready;
    await cdpA.send("Runtime.enable");
    await cdpA.send("Page.enable");

    const pageA = await waitReady(cdpA);
    if (!pageA?.ready) throw new Error(`标签页 A 未就绪：${JSON.stringify(pageA)}`);
    check(
      "T1 页 A 就绪，tabClientId 已生成",
      typeof pageA.tabClientId === "string" && pageA.tabClientId.length >= 8,
      `A client=${pageA.clientId} tab=${String(pageA.tabId).slice(0, 8)}`,
    );

    // ================= 模拟「复制标签页」：新页 B 注入 A 的 sessionStorage clientId =================
    const tab = await newTab("about:blank");
    cdpB = cdpConnect(tab.webSocketDebuggerUrl);
    await cdpB.ready;
    await cdpB.send("Runtime.enable");
    await cdpB.send("Page.enable");
    // 在文档任何脚本之前写入同一个 clientId（sessionStorage 在复制标签页时正是这样被带过去的）
    await cdpB.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { sessionStorage.setItem('pi-shell.client', ${JSON.stringify(pageA.tabClientId)}); } catch (e) {}`,
    });
    await cdpB.send("Page.navigate", { url: `${BASE}/` });

    const pageB = await waitReady(cdpB);
    if (!pageB?.ready) throw new Error(`标签页 B 未就绪：${JSON.stringify(pageB)}`);
    check(
      "T2 注入同一 clientId 的页 B 启动后换成了新 clientId（复制标签页不再共用引擎）",
      pageB.tabClientId !== pageA.tabClientId && pageB.tabId !== pageA.tabId,
      `A=${String(pageA.tabClientId).slice(0, 8)} B=${String(pageB.tabClientId).slice(0, 8)} idsDifferent=${pageB.tabClientId !== pageA.tabClientId}`,
    );

    const h2 = await waitHealth((h) => (h.engines || []).length >= 2, 30000, "2 engines");
    const engineA = (h2.engines || []).find((e) => e.id === pageA.clientId);
    const engineB = (h2.engines || []).find((e) => e.id === pageB.clientId);
    check(
      "T3 health.engines 有 2 个引擎，clientId 不同且各自属于 A/B，tab 字段不同",
      h2.engineCount === 2 &&
        !!engineA &&
        !!engineB &&
        engineA.id !== engineB.id &&
        engineA.tab &&
        engineB.tab &&
        engineA.tab !== engineB.tab,
      `engines=${(h2.engines || []).map((e) => `${String(e.id).slice(-8)}(tab:${String(e.tab).slice(0, 8)})`).join(",")}`,
    );

    // ================= 两页同时各发一条长任务 → 两边都在增长 =================
    const beforeA = (await evaluate(cdpA, PAGE_STATE, false)).logLen;
    const beforeB = (await evaluate(cdpB, PAGE_STATE, false)).logLen;
    const prompt = "请从 1 数到 300，每行一个数字，只输出数字，不要任何解释。";
    const [sendA, sendB] = await Promise.all([
      sendPrompt(cdpA, pageA.clientId, pageA.tabId, prompt),
      sendPrompt(cdpB, pageB.clientId, pageB.tabId, prompt),
    ]);
    check(
      "T4a 两页的 prompt 都被桥接受（互不 409/中止）",
      sendA?.status === 200 && sendB?.status === 200,
      `A=${sendA?.status} B=${sendB?.status}`,
    );

    const growth = { A: 0, B: 0, sawStreamingA: false, sawStreamingB: false, states: [] };
    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
      const [stateA, stateB, health] = await Promise.all([
        evaluate(cdpA, PAGE_STATE, false).catch(() => null),
        evaluate(cdpB, PAGE_STATE, false).catch(() => null),
        getHealth().catch(() => null),
      ]);
      if (stateA) growth.A = Math.max(growth.A, stateA.logLen - beforeA);
      if (stateB) growth.B = Math.max(growth.B, stateB.logLen - beforeB);
      const eA = (health?.engines || []).find((e) => e.id === pageA.clientId);
      const eB = (health?.engines || []).find((e) => e.id === pageB.clientId);
      if (eA?.state === "streaming") growth.sawStreamingA = true;
      if (eB?.state === "streaming") growth.sawStreamingB = true;
      growth.states.push(`${eA?.state || "?"}/${eB?.state || "?"}`);
      // 两边都已有实质输出且都已落定 → 结束
      if (growth.A > 150 && growth.B > 150 && eA?.state !== "streaming" && eB?.state !== "streaming") break;
      await sleep(500);
    }
    const stateAEnd = await evaluate(cdpA, PAGE_STATE, false).catch(() => null);
    const stateBEnd = await evaluate(cdpB, PAGE_STATE, false).catch(() => null);
    check(
      "T4b 两页的输出同时增长（互不中止）",
      growth.A > 100 && growth.B > 100,
      `A 增长 ${growth.A} 字符 · B 增长 ${growth.B} 字符 · 采样状态最后=${growth.states.slice(-4).join(",")}`,
    );
    check(
      "T4c 两个引擎都进入过 streaming（并行而非排队）",
      growth.sawStreamingA && growth.sawStreamingB,
      `A streaming=${growth.sawStreamingA} B streaming=${growth.sawStreamingB}`,
    );
    check(
      "T4d 长任务结束后两页都没有错误提示（未被对方顶掉）",
      !stateAEnd?.noticeShown && !stateBEnd?.noticeShown,
      `A notice=「${stateAEnd?.notice || ""}」 B notice=「${stateBEnd?.notice || ""}」`,
    );

    // ================= 关掉 B → ≤80s 回到 1 个引擎，A 不受影响 =================
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
      "T5 关掉 B → 60–75s 后引擎剩 1 个，A 的 clientId 未变且页面仍可用",
      reclaimedMs != null &&
        hAfter.engineCount === 1 &&
        pageAAfter?.ready === true &&
        pageAAfter.clientId === pageA.clientId &&
        !pageAAfter.noticeShown,
      `count=${lastCount} 回收耗时=${reclaimedMs == null ? "超时" : `${Math.round(reclaimedMs / 1000)}s`} 剩余=${(hAfter.engines || []).map((e) => String(e.id).slice(-8)).join(",")}`,
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
