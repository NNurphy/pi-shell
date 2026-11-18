#!/usr/bin/env node
// MCP 按需（默认关闭 + 按列勾选具体 MCP + cwd 规则）E2E 验收
//
// 为什么存在：MCP 一开就是 3 套子进程（pi + codegraph + npx/uvx/python），实测整棵树 480MB；
// 默认关闭后单引擎 ≈89MB。这套脚本要证明的是「关得住、按列开得起来、会话不丢、进程真消失」——
// 不看 DOM 属性，只看桥的 health、真实进程表（Get-CimInstance）和内存实测。
//
// 覆盖：
//   M1 起桥（空 MCP 配置）→ health.engines[*].mcp === []，且 pi 命令行含 --no-mcp，无 MCP 子进程
//   M2 ⋯ → MCP 面板 → 只开 codegraph：pid 变、mcp=["codegraph"]、obsidian 进程不存在、sessionFile 未变
//   M3 再开 mcp-obsidian：mcp 两项、obsidian 子进程出现
//   M4 全关：两套子进程都消失、pid 再变、mcp 回到 []
//   M5 内存：关态 vs 开态整棵树 RSS（各采样两次），差值 ≥ 200MB
//   M6 规则文件：rules 命中夹具 cwd → 新建列自动带 codegraph
//   M7 截图 docs/evidence/mcp-panel-{off,codegraph,both}.png
//
// 用法：node scripts/evidence/mcp-toggle-ui.mjs        （EDGE_PATH 可指定 msedge.exe）
// 环境变量：PI_SHELL_MCP_PORT（默认 7898）
// 退出码：0 = 全部通过

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_MCP_PORT || 7898);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-mcp-toggle");
const SESSIONS = path.join(OUT_DIR, "sessions");
const WORKSPACE = path.join(OUT_DIR, "workspace");
const MCP_CONFIG = path.join(OUT_DIR, "pi-shell-mcp.json");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具 ----------

/** 最小会话文件（header + user + assistant）：重启后 switch_session 必须有东西可回 */
function writeFixtureSession() {
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const cwd = WORKSPACE.replace(/\\/g, "/");
  const dir = path.join(SESSIONS, cwd.replace(/[:/]/g, "-").replace(/^/, "--"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "mcp-toggle-0001.jsonl");
  const now = Date.now();
  const lines = [
    { type: "session", version: 3, id: "mcp-toggle-0001", timestamp: new Date(now - 60000).toISOString(), cwd },
    {
      type: "message",
      id: "m1",
      timestamp: new Date(now - 50000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "夹具：MCP 开关要保住这一条。" }] },
    },
    {
      type: "message",
      id: "m2",
      timestamp: new Date(now - 40000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "收到，重启引擎后应当还在。" }] },
    },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

// ---------- bridge ----------

function writeMcpConfig(cfg) {
  fs.writeFileSync(MCP_CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_CWD: WORKSPACE,
      PI_SHELL_LOG_FILE: LOG_FILE,
      PI_SHELL_MCP_CONFIG: MCP_CONFIG, // 测试必须用自己的配置：不读真实候选名单
    },
    stdio: "ignore", // H-15：子进程 stdio 必须 ignore，接管道不消费会把桥堵死
  });
}

async function getHealth(client = null) {
  const headers = client ? { "X-Pi-Shell-Client": client } : {};
  const res = await fetch(`${BASE}/api/health`, { cache: "no-store", headers });
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
  throw new Error(`等待超时（${label}）：${JSON.stringify(last?.engines ?? last)}`);
}

/** 某引擎（按 client 认领后 id 就是 client）的 health 条目 */
function engineOf(health, client) {
  return (health.engines || []).find((e) => e.id === client || e.client === client) || null;
}

// ---------- 进程 / 内存（PowerShell CIM：从测试侧核对，不信桥的自述）----------

function psJson(script) {
  // 用 -InputObject @(...) 包一层：单元素也要序列化成数组，空结果给 []
  const wrapped = `$ErrorActionPreference='Stop'; $__r = & { ${script} }; ConvertTo-Json -InputObject @($__r) -Compress -Depth 4`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", wrapped], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** 以 rootPid 为根的整棵进程树：[{pid, name, commandLine, wsMb}] */
function processTree(rootPid) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0) return [];
  return psJson(`
    $all = Get-CimInstance Win32_Process
    $map = @{}
    foreach ($p in $all) {
      $ppid = [int]$p.ParentProcessId
      if (-not $map.ContainsKey($ppid)) { $map[$ppid] = @() }
      $map[$ppid] += $p
    }
    $ids = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue(${root})
    while ($queue.Count -gt 0) {
      $cur = $queue.Dequeue()
      if ($ids.Contains($cur)) { continue }
      $ids.Add($cur)
      if ($map.ContainsKey($cur)) { foreach ($c in $map[$cur]) { $queue.Enqueue([int]$c.ProcessId) } }
    }
    $rows = @()
    foreach ($id in $ids) {
      $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
      if (-not $proc) { continue }
      $cim = $all | Where-Object { [int]$_.ProcessId -eq $id } | Select-Object -First 1
      $rows += [pscustomobject]@{
        pid = $id
        name = $proc.ProcessName
        commandLine = if ($cim) { $cim.CommandLine } else { "" }
        wsMb = [math]::Round($proc.WorkingSet64 / 1MB, 1)
        startedAt = if ($cim) { $cim.CreationDate.ToUniversalTime().ToString('o') } else { "" }
      }
    }
    $rows
  `);
}

/** 进程树里匹配 cmdline 关键字的那一套（codegraph / mcp-obsidian） */
function findByCmdline(tree, pattern) {
  return tree.filter((p) => new RegExp(pattern, "i").test(String(p.commandLine || "")));
}

function treeRssMb(tree) {
  return Math.round(tree.reduce((sum, p) => sum + (Number(p.wsMb) || 0), 0) * 10) / 10;
}

/**
 * 进程身份 = pid + 创建时间。
 * Windows 会复用 pid：本脚本一轮内重启 4 次，实测出现过 pid 回收（295292 被复用），
 * 只比 pid 会把「真的重启了」误判成「没重启」。
 */
function processIdentity(pid) {
  const row = processTree(pid)[0] ?? null;
  return { pid: Number(pid) || null, startedAt: String(row?.startedAt || "") };
}

function sameProcess(a, b) {
  if (!a || !b || !a.pid || a.pid !== b.pid) return false;
  return !a.startedAt || !b.startedAt || a.startedAt === b.startedAt;
}

/** 采样两次（间隔 2.5s），取后一次（服务连接稳定后） */
async function sampleTree(pid, times = 2) {
  const samples = [];
  for (let i = 0; i < times; i += 1) {
    if (i > 0) await sleep(2500);
    const tree = processTree(pid);
    samples.push(treeRssMb(tree));
  }
  return { samples, mb: samples[samples.length - 1] };
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
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 120000 });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
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
  for (let i = 0; i < 80 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge CDP 未就绪");
  return { edge, target };
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
    return { x, y, ok, hitTag: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') : null };
  })()`, false);
  if (box.error) return box;
  if (!box.ok) return { ...box, hit: false };
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

const READY = `(() => {
  const v = (document.getElementById('version')?.textContent || '').trim();
  const input = !!document.getElementById('input');
  const client = document.querySelector('.column')?.dataset?.client || '';
  return { version: v, input, client };
})()`;

async function waitPageReady(cdp, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await evaluate(cdp, READY, false).catch(() => null);
    if (s?.input && s.version && s.version !== "—" && s.client) return s;
    await sleep(200);
  }
  return null;
}

const PANEL_STATE = `(() => {
  const panel = document.getElementById('mcp-panel');
  const rows = [...document.querySelectorAll('#mcp-list .mcp-row')].map((row) => ({
    name: row.dataset.server,
    on: !!row.querySelector('.mcp-switch')?.checked,
  }));
  const badge = document.getElementById('open-mcp-badge');
  const colMcp = document.querySelector('.column .col-mcp');
  return {
    shown: !!panel && getComputedStyle(panel).display !== 'none',
    rows,
    note: (document.querySelector('#mcp-panel .settings-note')?.textContent || '').trim(),
    status: (document.getElementById('mcp-status')?.textContent || '').trim(),
    badge: badge && !badge.hidden ? badge.textContent : '',
    colBadge: colMcp && !colMcp.hidden ? { text: colMcp.textContent, title: colMcp.title } : null,
  };
})()`;

/** 打开 ⋯ 菜单 → 点 MCP（真实鼠标路径） */
async function openMcpPanel(cdp) {
  await clickElement(cdp, "#open-menu");
  await sleep(250);
  const clicked = await clickElement(cdp, "#open-mcp");
  await sleep(700);
  const state = await evaluate(cdp, PANEL_STATE, false);
  return { clicked, state };
}

/** 勾选/取消某一项（真实点击 switch） */
async function toggleServer(cdp, name, ms = 60000) {
  // 重启期间面板会把开关 disable；等到可用再点，否则点到的是禁用控件（点了没反应 → 假失败）
  let res = null;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    res = await evaluate(cdp, `(() => {
      const input = document.querySelector('#mcp-list .mcp-row[data-server="${name}"] .mcp-switch');
      if (!input) return { error: 'no switch' };
      const r = input.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: input.disabled };
    })()`, false);
    if (res?.error) return res;
    if (!res.disabled) break;
    await sleep(300);
  }
  if (!res || res.disabled) return { ...res, disabledAfterWait: true };
  if (res.error) return res;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: res.x, y: res.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: res.x, y: res.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: res.x, y: res.y, button: "left", clickCount: 1 });
  return { hit: true };
}

/** 等某列的 mcp 名单变成期望值（重启是异步的：pid 变 + 名单变 + 回到 idle） */
async function waitEngineMcp(client, expected, prevPid, ms = 90000, expectedSession = null) {
  const want = [...expected].sort().join(",");
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    const health = await getHealth();
    const engine = engineOf(health, client);
    last = engine;
    if (engine) {
      const got = [...(engine.mcp || [])].sort().join(",");
      const pidChanged = prevPid == null || engine.pid !== prevPid;
      const sessionOk =
        !expectedSession ||
        (engine.sessionFile && path.resolve(engine.sessionFile).toLowerCase() === expectedSession.toLowerCase());
      if (got === want && pidChanged && sessionOk && (engine.state === "idle" || engine.state === "streaming")) {
        return { engine, health };
      }
    }
    await sleep(500);
  }
  throw new Error(`等待引擎 MCP 状态超时（want=${want}）：${JSON.stringify(last)}`);
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  writeMcpConfig({ default: [], rules: [] }); // 空配置 = 默认不带任何 MCP
  const fixture = writeFixtureSession();

  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  let health = await waitHealth((h) => h?.ok && h?.pi?.state === "idle", 45000, "桥就绪");
  console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid}`);

  const { edge, target } = await launchEdge(edgePath);
  const cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.ready;
  const pageErrors = [];
  cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
    if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
      const e = msg.params.entry;
      if (!/favicon/.test(String(e.url || "") + String(e.text || ""))) pageErrors.push(e.url ? `${e.text} (${e.url})` : e.text);
    }
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");

  try {
    const ready = await waitPageReady(cdp);
    check("M0 页面可交互（拿到本列 clientId）", !!ready, ready ? `client=${ready.client} pi=${ready.version}` : "30s 未就绪");
    if (!ready) throw new Error("页面未就绪");
    const client = ready.client;

    // 夹具会话挂到本列引擎（这样重启才有 sessionFile 可回）
    const opened = await fetch(`${BASE}/api/session/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Shell-Client": client },
      body: JSON.stringify({ path: fixture }),
    }).then((r) => r.json());
    await sleep(1200);
    health = await getHealth(client);
    const engine0 = engineOf(health, client);
    const session0 = engine0?.sessionFile ? path.resolve(engine0.sessionFile) : null;
    check(
      "M0b 夹具会话已接管（sessionFile = 夹具文件）",
      !!session0 && session0.toLowerCase() === path.resolve(fixture).toLowerCase(),
      `sessionFile=${session0} opened=${!!opened?.ok}`,
    );

    // ---- M1 默认不带 MCP ----
    const tree0 = processTree(health.pi.pid);
    const cmd0 = String(tree0[0]?.commandLine || "");
    const mcpChildren0 = findByCmdline(tree0, "codegraph|mcp-obsidian|caveman-shrink");
    check(
      "M1a health.engines[0].mcp === []（默认不带 MCP）",
      Array.isArray(engine0?.mcp) && engine0.mcp.length === 0,
      `mcp=${JSON.stringify(engine0?.mcp)}`,
    );
    check(
      "M1b pi 命令行含 --no-mcp（pi 1.5.0 原生开关）",
      /--no-mcp\b/.test(cmd0),
      cmd0.slice(0, 160) || "拿不到命令行",
    );
    check(
      "M1c 无 MCP 子进程（codegraph / obsidian / npx 都不在）",
      mcpChildren0.length === 0,
      mcpChildren0.map((p) => `${p.name}:${String(p.commandLine).slice(0, 60)}`).join(" | ") || "无",
    );

    // ---- M2 面板：只开 codegraph ----
    const off = await openMcpPanel(cdp);
    check(
      "M2a ⋯ → MCP 面板打开（真实点击，列出可选 server）",
      off.clicked?.hit === true && off.state.shown === true && off.state.rows.length >= 2,
      `hit=${off.clicked?.hit} shown=${off.state.shown} rows=${off.state.rows.map((r) => `${r.name}:${r.on}`).join(",")}`,
    );
    check(
      "M2b 面板说明与默认状态（全部关闭 + 重启提示）",
      off.state.rows.every((r) => r.on === false) && /约 1 秒/.test(off.state.note) && /会话不变/.test(off.state.note),
      `note=${off.state.note}`,
    );
    await shot(cdp, "mcp-panel-off.png");

    const pid0 = engine0?.pid;
    const id0 = processIdentity(pid0);
    const toggle1 = await toggleServer(cdp, "codegraph");
    let after1;
    try {
      after1 = await waitEngineMcp(client, ["codegraph"], pid0, 90000, session0);
    } catch (err) {
      after1 = null;
      check("M2c 勾选 codegraph → 引擎重启并只带 codegraph", false, err.message);
    }
    if (after1) {
      const engine1 = after1.engine;
      const tree1 = processTree(engine1.pid);
      check(
        "M2c 勾选 codegraph → 引擎重启（进程换新）且 mcp=[\"codegraph\"]",
        !sameProcess(id0, { pid: engine1.pid, startedAt: String(tree1[0]?.startedAt || "") }) &&
          JSON.stringify(engine1.mcp) === '["codegraph"]',
        `pid ${pid0}(${id0.startedAt || "?"}) → ${engine1.pid}(${tree1[0]?.startedAt || "?"}) · mcp=${JSON.stringify(engine1.mcp)} · 耗时可见于桥日志`,
      );
      check(
        "M2d 会话未变（sessionFile 与重启前一致）",
        engine1.sessionFile && path.resolve(engine1.sessionFile).toLowerCase() === session0.toLowerCase(),
        `sessionFile=${engine1.sessionFile}`,
      );
      const obsidian1 = findByCmdline(tree1, "mcp-obsidian|caveman-shrink");
      check(
        "M2e obsidian 子进程不存在（Get-CimInstance 核对进程树）",
        obsidian1.length === 0,
        obsidian1.map((p) => p.name).join(",") || "无",
      );
      // 桥侧 shim：临时 agentDir 里只有 codegraph
      const shimRoot = path.join(os.tmpdir(), "pi-shell-mcp");
      const shims = fs.existsSync(shimRoot) ? fs.readdirSync(shimRoot) : [];
      const shimJson = shims
        .map((d) => path.join(shimRoot, d, "mcp.json"))
        .filter((f) => fs.existsSync(f))
        .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
        .find((cfg) => Object.keys(cfg.mcpServers || {}).join(",") === "codegraph");
      check("M2f 临时 agentDir 里 mcp.json 只含 codegraph", !!shimJson, shimJson ? "shim mcp.json = codegraph" : `shims=${shims.join(",")}`);
      const ui1 = await evaluate(cdp, PANEL_STATE, false);
      check(
        "M2g UI 同步：开关勾上 + 列头徽标 MCP·1 + 菜单徽标",
        ui1.rows.find((r) => r.name === "codegraph")?.on === true &&
          ui1.colBadge?.text === "MCP·1" &&
          ui1.badge === "1",
        `rows=${ui1.rows.map((r) => `${r.name}:${r.on}`).join(",")} colBadge=${JSON.stringify(ui1.colBadge)} badge=${ui1.badge}`,
      );
      await shot(cdp, "mcp-panel-codegraph.png");
    }

    // ---- M3 再开 mcp-obsidian ----
    const pid1 = after1?.engine.pid ?? pid0;
    const id1 = processIdentity(pid1);
    const toggle2 = await toggleServer(cdp, "mcp-obsidian");
    let after2 = null;
    try {
      after2 = await waitEngineMcp(client, ["codegraph", "mcp-obsidian"], pid1, 120000, session0);
    } catch (err) {
      check("M3a 再开 mcp-obsidian → mcp 含两项", false, err.message);
    }
    if (after2) {
      // uvx/python 启动慢：给 25s 让 obsidian 真连上
      const t0 = Date.now();
      let obsidian = [];
      while (Date.now() - t0 < 40000) {
        obsidian = findByCmdline(processTree(after2.engine.pid), "mcp-obsidian|caveman-shrink|uvx");
        if (obsidian.length > 0) break;
        await sleep(1000);
      }
      check(
        "M3a 再开 mcp-obsidian → mcp 含两项、进程再换新",
        JSON.stringify([...after2.engine.mcp].sort()) === JSON.stringify(["codegraph", "mcp-obsidian"]) &&
          !sameProcess(id1, processIdentity(after2.engine.pid)),
        `pid ${pid1}(${id1.startedAt || "?"}) → ${after2.engine.pid} · mcp=${JSON.stringify(after2.engine.mcp)}`,
      );
      check(
        "M3b obsidian 子进程出现（npx/uvx/python 之一）",
        obsidian.length > 0,
        obsidian.map((p) => p.name).slice(0, 4).join(",") || "无",
      );
      const ui2 = await evaluate(cdp, PANEL_STATE, false);
      check(
        "M3c UI：两个开关都勾上 + 列头 MCP·2",
        ui2.rows.filter((r) => r.on).length === 2 && ui2.colBadge?.text === "MCP·2",
        `on=${ui2.rows.filter((r) => r.on).map((r) => r.name).join("+")} colBadge=${JSON.stringify(ui2.colBadge)}`,
      );
      await shot(cdp, "mcp-panel-both.png");
    }

    // ---- M5 内存：开态采样（先做开态，关态紧跟其后做对比）----
    const onPid = after2?.engine.pid ?? null;
    const onMem = onPid ? await sampleTree(onPid) : null;

    // ---- M4 全关 ----
    const pid2 = after2?.engine.pid ?? pid1;
    const id2 = processIdentity(pid2);
    let after3 = null;
    try {
      // 关 codegraph → 等落定 → 关 mcp-obsidian（面板在重启期间会禁用开关，不能连点）
      await toggleServer(cdp, "codegraph");
      const step1 = await waitEngineMcp(client, ["mcp-obsidian"], pid2, 120000, session0);
      await toggleServer(cdp, "mcp-obsidian");
      after3 = await waitEngineMcp(client, [], step1.engine.pid, 120000, session0);
    } catch (err) {
      check("M4a 全关 → mcp 回到 []", false, err.message);
    }
    if (after3) {
      await sleep(2000);
      const tree3 = processTree(after3.engine.pid);
      const cmd3 = String(tree3[0]?.commandLine || "");
      const gone = findByCmdline(tree3, "codegraph|mcp-obsidian|caveman-shrink");
      check(
        "M4a 全关 → 引擎重启（进程换新）、mcp=[]、命令行回到 --no-mcp",
        !sameProcess(id2, { pid: after3.engine.pid, startedAt: String(tree3[0]?.startedAt || "") }) &&
          (after3.engine.mcp || []).length === 0 && /--no-mcp\b/.test(cmd3),
        `pid ${pid2}(${id2.startedAt || "?"}) → ${after3.engine.pid}(${tree3[0]?.startedAt || "?"}) · mcp=${JSON.stringify(after3.engine.mcp)} · no-mcp=${/--no-mcp\b/.test(cmd3)}`,
      );
      check("M4b 两套子进程都消失", gone.length === 0, gone.map((p) => p.name).join(",") || "无");
      check(
        "M4c 会话仍在（sessionFile 未被重启换掉）",
        after3.engine.sessionFile && path.resolve(after3.engine.sessionFile).toLowerCase() === session0.toLowerCase(),
        `sessionFile=${after3.engine.sessionFile}`,
      );

      // ---- M5 关态内存 ----
      const offMem = await sampleTree(after3.engine.pid);
      if (onMem) {
        const delta = Math.round((onMem.mb - offMem.mb) * 10) / 10;
        check(
          "M5 内存：开态 vs 关态整棵树 RSS 差值 ≥ 200MB（各采样两次）",
          delta >= 200,
          `关态 ${offMem.samples.join("→")}MB · 开态 ${onMem.samples.join("→")}MB · 差 ${delta}MB`,
        );
      } else {
        check("M5 内存对比", false, "没拿到开态样本");
      }
    }

    // 面板是全屏浮层：继续点顶栏前先关掉（否则 elementFromPoint 命中的是面板遮罩）
    const closed = await clickElement(cdp, "#mcp-close");
    await sleep(300);
    const panelGone = await evaluate(cdp, `(() => { const p = document.getElementById('mcp-panel'); return getComputedStyle(p).display === 'none'; })()`, false);
    check("M4d 关面板 → 浮层真的消失（后续交互不被遮罩吃掉）", closed?.hit === true && panelGone === true, `hit=${closed?.hit} display=${panelGone ? "none" : "shown"}`);

    // ---- M6 cwd 规则自动启用 ----
    const rules = [{ cwd: `${WORKSPACE}*`, servers: ["codegraph"] }];
    const wrote = await fetch(`${BASE}/api/mcp/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default: [], rules }),
    }).then((r) => r.json());
    const persisted = JSON.parse(fs.readFileSync(MCP_CONFIG, "utf8"));
    check(
      "M6a POST /api/mcp/config 写入规则文件（default/rules 落盘）",
      wrote?.ok === true && persisted.rules?.length === 1 && persisted.rules[0].servers[0] === "codegraph",
      `rules=${JSON.stringify(persisted.rules)}`,
    );
    const badWrite = await fetch(`${BASE}/api/mcp/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: [{ cwd: "", servers: "codegraph" }] }),
    });
    check("M6b 非法配置被拒（400 + 不落盘）", badWrite.status === 400, `status=${badWrite.status}`);

    // 新建一列 → 新引擎按 cwd 规则自动带 codegraph
    const beforeIds = new Set((await getHealth()).engines.map((e) => e.id));
    const splitClick = await clickElement(cdp, '.split-btn[data-split="2"]');
    check("M6c-0 点顶栏「2」→ 新列建出来（真实点击）", splitClick?.hit === true, `hit=${splitClick?.hit} ${splitClick?.hitTag ?? ""}`);
    let newEngine = null;
    const tNew = Date.now();
    while (Date.now() - tNew < 60000) {
      const h = await getHealth();
      const fresh = h.engines.find((e) => !beforeIds.has(e.id));
      if (fresh && fresh.pid) {
        newEngine = fresh;
        if ((fresh.mcp || []).join(",") === "codegraph" && fresh.state === "idle") break;
      }
      await sleep(500);
    }
    check(
      "M6c 新建列 → 该引擎按 cwd 规则自动带 codegraph",
      !!newEngine && JSON.stringify(newEngine.mcp) === '["codegraph"]',
      newEngine ? `${newEngine.id} mcp=${JSON.stringify(newEngine.mcp)} state=${newEngine.state}` : "没等到新引擎",
    );
    if (newEngine) {
      const tree = processTree(newEngine.pid);
      const cmd = String(tree[0]?.commandLine || "");
      const obs = findByCmdline(tree, "mcp-obsidian|caveman-shrink");
      check(
        "M6d 规则引擎：命令行不带 --no-mcp，且只起 codegraph（无 obsidian）",
        !/--no-mcp\b/.test(cmd) && obs.length === 0 && findByCmdline(tree, "codegraph").length > 0,
        `no-mcp=${/--no-mcp\b/.test(cmd)} codegraph=${findByCmdline(tree, "codegraph").length} obsidian=${obs.length}`,
      );
    }
    // 规则复位（夹具不可污染后续用例）
    await fetch(`${BASE}/api/mcp/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default: [], rules: [] }),
    });

    // ---- M7 无 JS 异常 ----
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_|Failed to fetch/.test(t));
    check("M7 全程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");

    // M7b 从桥侧核对白名单：前端 4xx 会被 CDP 记成 resource error（M7 口径），
    // 这里直接数桥日志，不依赖前端过滤，专盯 /api/git/diff 的 cwd 误判。
    const logText = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
    const deniedCount = (logText.match(/git_diff_denied/g) || []).length;
    check("M7b 桥日志无 git_diff_denied（cwd 白名单未误判）", deniedCount === 0, `denied=${deniedCount}`);
  } finally {
    cdp.close();
    try { edge.kill("SIGKILL"); } catch {}
    try { bridge.kill("SIGTERM"); } catch {}
    await sleep(1500);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log(`失败：${failed.map((f) => f.name).join(" · ")}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
