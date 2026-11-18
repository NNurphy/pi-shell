#!/usr/bin/env node
// PIX-3 + PIX-4 验收（零第三方依赖，CDP 真实点击 + 真实 pi 工具调用）
//
// 覆盖：
//   C1  真实一轮：让 pi 用 write 工具创建文件 → 顶栏 Changes 出现 →「本轮改动」= 该文件，状态 A，diff 含 + 行
//   C2  真实第二轮：用 edit 改同一文件 → 状态 M，行尾 +A −B，展开 diff 同时有增/删行
//   C3  「工作区」页 == `git status --porcelain`
//   C4  无工具的一轮 → 「这一轮没有文件改动」空态
//   C5  快照目录生成（backups/turn-snapshots/<session>/<turn>/meta.json + before/after 文件）
//   C6  单轮上限：60 个文件的一轮 → 60 条路径，只有 50 个存内容（其余只记路径），truncated=true
//   C7  PIX-3 工具行：运行中跳秒（200ms）→ 结束固定 durationMs；失败标记；嵌套缩进 + 子调用折叠/展开
//   C8  tabular-nums（等宽数字）
// 截图：docs/evidence/changes-turn-*.png + tool-rows-nested.png
//
// 用法：node scripts/evidence/turn-changes-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部通过
//
// 夹具：临时 git 仓库（不碰 pi-shell 自身）+ 临时 sessions 目录 + 临时快照目录。
// 真实对话使用本机默认模型（~/.pi/agent 配置），不写任何真实会话。

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7896;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-turnchanges");
const WORK = path.join(OUT, "repo");
const SESSIONS = path.join(OUT, "sessions");
const SNAPS = path.join(OUT, "snaps");
const SHOT_DIR = path.resolve(REPO_ROOT, "docs", "evidence");
const DEMO = "pix-demo.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- git（临时仓库） ----------

function git(args, cwd = WORK) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).trim()), { code: err.code }));
      else resolve(String(stdout));
    });
  });
}

async function makeRepo() {
  await fsp.mkdir(WORK, { recursive: true });
  await git(["-c", "init.defaultBranch=main", "init"]);
  await fsp.writeFile(path.join(WORK, "README.md"), "fixture\n", "utf8");
  await git(["add", "README.md"]);
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-m", "init"]);
}

// ---------- bridge ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_CWD: WORK,
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_TURN_SNAPSHOTS: SNAPS,
      PI_SHELL_LOG_FILE: path.join(OUT, "bridge.log"),
    },
    // H-15：不消费管道就别接管道（会堵死桥）
    stdio: "ignore",
  });
}

async function waitHealth(ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const body = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
      if (body?.ok && body?.pi?.version && body?.pi?.state === "idle") return body;
    } catch {}
    await sleep(300);
  }
  return null;
}

async function assertPortFree() {
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑：本脚本必须独占端口（避免假证据）`);
  } catch (err) {
    if (/已有实例/.test(err.message)) throw err;
  }
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
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 300000 });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function launchEdge(edgePath) {
  const debugPort = PORT + 1000;
  const edge = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(OUT, "edge-profile")}`,
    "--window-size=1440,1000",
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

const READY = `(() => {
  const v = (document.getElementById('version')?.textContent || '').trim();
  const st = (document.getElementById('state')?.textContent || '').trim();
  return { version: v, state: st, input: !!document.getElementById('input') };
})()`;

async function waitPageReady(cdp, ms = 30000) {
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
    return { x, y, ok, width: r.width, height: r.height };
  })()`, false);
  if (box.error || !box.ok || box.width < 1 || box.height < 1) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
}

async function waitFor(cdp, expression, ms = 15000, interval = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const value = await evaluate(cdp, expression, false).catch(() => null);
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

async function screenshot(cdp, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  return file;
}

/** 在页面里发一条消息，等回到 idle（真实 pi 回合） */
async function runPrompt(cdp, text, waitMs = 240000) {
  return evaluate(cdp, `(async () => {
    const input = document.getElementById('input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer').requestSubmit();
    const t0 = performance.now();
    await new Promise((resolve) => {
      const t = setInterval(() => {
        const st = document.getElementById('state').textContent || '';
        const notice = document.getElementById('notice');
        const bad = notice && !notice.hidden ? notice.textContent : '';
        if (/打开失败|接管失败|发送失败|ENOENT/.test(bad)) { clearInterval(t); resolve(); return; }
        if (st.startsWith('idle') && performance.now() - t0 > 2500) { clearInterval(t); resolve(); }
        if (performance.now() - t0 > ${waitMs}) { clearInterval(t); resolve(); }
      }, 350);
    });
    return {
      ms: Math.round(performance.now() - t0),
      state: document.getElementById('state').textContent,
      notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent,
    };
  })()`, true);
}

async function openChangesPanel(cdp) {
  const btn = await evaluate(cdp, `(() => {
    const b = document.getElementById('changes');
    return b ? { hidden: b.hidden, text: b.textContent.trim(), title: b.title } : null;
  })()`, false);
  if (!btn) return { ok: false, reason: "按钮不存在" };
  if (btn.hidden) return { ok: false, reason: "按钮 hidden", btn };
  const click = await clickElement(cdp, "#changes");
  const panel = await waitFor(cdp, `!!document.querySelector('[data-role="changes-panel"]')`, 8000);
  // 等这一枪取数画完（summary 不再是「读取中…」）
  const loaded = await waitFor(
    cdp,
    `(() => {
      const s = document.querySelector('[data-role="changes-summary"]');
      if (!s) return false;
      return !/读取中/.test(s.textContent || '') && (!!document.querySelector('[data-role="change-list"]') || !!document.querySelector('[data-role="change-empty"]') || !!document.querySelector('[data-role="changes-error"]'));
    })()`,
    15000,
    150,
  );
  return { ok: click.hit && !!panel && !!loaded, btn, click, panel: !!panel, loaded: !!loaded };
}

async function setChangesMode(cdp, mode) {
  const r = await clickElement(cdp, `[data-role="changes-tab"][data-mode="${mode}"]`);
  await sleep(300);
  return r.hit;
}

async function turnRows(cdp) {
  return evaluate(cdp, `(async () => {
    const rows = [...document.querySelectorAll('[data-role="change-row"]')].map((n) => ({
      kind: n.dataset.kind, path: n.dataset.path, text: n.textContent,
    }));
    const summary = document.querySelector('[data-role="changes-summary"]')?.textContent || '';
    const empty = document.querySelector('[data-role="change-empty"]')?.textContent || null;
    const activeTab = document.querySelector('[data-role="changes-tab"][data-active="1"]')?.dataset.mode || null;
    let diff = '';
    const first = document.querySelector('[data-role="change-row"]');
    if (first && first.dataset.open !== '1') { first.click(); await new Promise((r) => setTimeout(r, 250)); }
    diff = document.querySelector('[data-role="change-diff"]')?.textContent || '';
    return { rows, summary, empty, activeTab, diff };
  })()`, true);
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(SNAPS, { recursive: true });

  try {
    await git(["--version"], REPO_ROOT);
  } catch {
    throw new Error("找不到可用的 git（本脚本需要本地 git 建临时仓库）");
  }
  await assertPortFree();
  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  await makeRepo();
  const bridge = startBridge();
  let edge = null;
  let cdp = null;
  try {
    const health = await waitHealth();
    if (!health) throw new Error(`桥（${BASE}）未在 40s 内就绪（看 ${path.join(OUT, "bridge.log")}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · cwd ${health.pi.cwd}`);

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
    const ready = await waitPageReady(cdp);
    check("C0 页面可交互（pi 已握手）", !!ready, ready ? `pi=${ready.version} state=${ready.state}` : "30s 未就绪");
    if (!ready) throw new Error("页面未就绪");
    await sleep(600);

    // ---------- C1 真实一轮：write 新文件 ----------
    const r1 = await runPrompt(
      cdp,
      "请只用 write 工具把文件 pix-demo.txt 写成一行：alpha。不要用 bash，不要用其他工具，不要输出解释。",
    );
    const file1 = path.join(WORK, DEMO);
    const has1 = fs.existsSync(file1);
    check("C1a 真实工具调用落盘（write → pix-demo.txt 存在）", has1, `${r1.ms}ms · ${fs.existsSync(file1) ? fs.readFileSync(file1, "utf8").trim() : "文件不存在"}`);
    // PIX-3：真实工具行的最终耗时（durationMs 来自事件）
    const toolDur = await evaluate(cdp, `(() => {
      const durs = [...document.querySelectorAll('[data-pix-tool] [data-role="tool-duration"]')]
        .map((d) => ({ text: d.textContent, source: d.dataset.source || '' }));
      return durs;
    })()`, false);
    check(
      "C1b 工具行显示完成耗时（data-source=event，文本是时间格式）",
      toolDur.length > 0 && toolDur.every((d) => d.text === "—" || /^(\d+ms|\d+\.\d+s|\d+m \d+s)$/.test(d.text)) && toolDur.some((d) => d.source === "event"),
      JSON.stringify(toolDur),
    );

    const opened1 = await openChangesPanel(cdp);
    check("C1c 顶栏 Changes 可点开（未被遮挡）", opened1.ok === true, JSON.stringify({ reason: opened1.reason, hit: opened1.click?.hit, btn: opened1.btn }));
    const rows1 = await turnRows(cdp);
    const file1row = rows1.rows.find((r) => r.path === DEMO);
    check("C1d 「本轮改动」默认本轮：显示 pix-demo.txt，状态 A", rows1.activeTab === "turn" && !!file1row && file1row.kind === "A", JSON.stringify(rows1.rows));
    check("C1e 新建文件的 diff 含 + 行", /\n\+alpha/.test("\n" + rows1.diff), `diff=${JSON.stringify(rows1.diff.slice(0, 120))}`);
    check("C1f 摘要写明轮次与文件数", /第 1 轮 · 1 个文件/.test(rows1.summary), rows1.summary);
    const shot1 = await screenshot(cdp, "changes-turn-add.png");
    console.log(`      截图：${shot1}`);
    const apiTurn1 = await (await fetch(`${BASE}/api/turn-changes`)).json();
    const sessionId = apiTurn1.sessionId;
    const turn1 = apiTurn1.turn;

    // ---------- C2 真实第二轮：edit 同一文件 ----------
    const r2 = await runPrompt(
      cdp,
      "请只用 edit 工具把 pix-demo.txt 的第一行 alpha 改成 alpha2，并在下面加一行 beta。不要用 bash，不要用其他工具，不要输出解释。",
    );
    const content2 = fs.existsSync(file1) ? fs.readFileSync(file1, "utf8") : "";
    check("C2a 第二轮真实 edit 生效", /alpha2/.test(content2) && /beta/.test(content2), `${r2.ms}ms · ${JSON.stringify(content2)}`);
    const opened2 = await openChangesPanel(cdp);
    const rows2 = await turnRows(cdp);
    const row2 = rows2.rows.find((r) => r.path === DEMO);
    check("C2b 第二轮：同一文件状态 M", opened2.ok && !!row2 && row2.kind === "M", JSON.stringify({ btn: opened2.reason || "visible", rows: rows2.rows }));
    check("C2c 行尾显示 +A −B", /pix-demo\.txt/.test(row2?.text || "") && /\+2−1/.test(row2?.text || ""), row2?.text);
    check("C2d diff 同时含增/删行", /\n\+alpha2/.test("\n" + rows2.diff) && /\n-alpha\n/.test("\n" + rows2.diff), `diff=${JSON.stringify(rows2.diff.slice(0, 200))}`);
    const shot2 = await screenshot(cdp, "changes-turn-modify.png");
    console.log(`      截图：${shot2}`);
    check("C2e 同一文件两轮：快照按轮分开（turn=2）", /第 2 轮/.test(rows2.summary), rows2.summary);

    // ---------- C3 工作区页 == git status --porcelain ----------
    await setChangesMode(cdp, "workspace");
    await waitFor(cdp, `!!document.querySelector('[data-role="git-status-row"]')`, 8000);
    const expectedStatus = (await git(["status", "--porcelain"])).split("\n").filter(Boolean);
    const uiStatus = await evaluate(cdp, `[...document.querySelectorAll('[data-role="git-status-row"]')].map((el) => el.textContent)`, false);
    check("C3 工作区页 == git status --porcelain", JSON.stringify(uiStatus) === JSON.stringify(expectedStatus), `UI=${JSON.stringify(uiStatus)} / git=${JSON.stringify(expectedStatus)}`);
    const shot3 = await screenshot(cdp, "changes-turn-workspace.png");
    console.log(`      截图：${shot3}`);

    // ---------- C4 无工具的一轮 → 空态 ----------
    await setChangesMode(cdp, "turn");
    const r3 = await runPrompt(cdp, "只回复两个字：好的。不要调用任何工具。", 120000);
    const opened3 = await openChangesPanel(cdp);
    const rows3 = await turnRows(cdp);
    check("C4 无改动的一轮 → 空态文案「这一轮没有文件改动」", opened3.ok && rows3.empty === "这一轮没有文件改动" && rows3.rows.length === 0, JSON.stringify({ r3: r3.state, empty: rows3.empty, rows: rows3.rows.length, summary: rows3.summary }));
    const shot4 = await screenshot(cdp, "changes-turn-empty.png");
    console.log(`      截图：${shot4}`);

    // ---------- C5 快照目录结构 ----------
    const snapSessionDir = path.join(SNAPS, sessionId);
    const metaPath = path.join(snapSessionDir, String(turn1), "meta.json");
    const metaOk = fs.existsSync(metaPath);
    const meta = metaOk ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : null;
    const beforeAfter = metaOk
      ? fs.readdirSync(path.join(snapSessionDir, String(turn1))).filter((n) => /-(before|after)$/.test(n))
      : [];
    check(
      "C5 快照目录生成（<sessionId>/<turn>/meta.json + before/after 文件）",
      metaOk && meta?.turn === turn1 && meta?.sessionId === sessionId && meta?.files?.length === 1 && beforeAfter.length >= 1,
      `dir=${snapSessionDir} files=${beforeAfter.join(",")}`,
    );

    // ---------- C7 PIX-3 工具行：跳秒 / 失败 / 嵌套 ----------
    const id = Date.now().toString(36);
    const parentId = `call-${id}-parent`;
    const childId = `${parentId}/1`;
    await evaluate(cdp, `(() => {
      window.__piShell.applyFrame({ type: "tool_execution_start", toolCallId: ${JSON.stringify(parentId)}, toolName: "codemode", args: { command: "nested-demo" } });
      return true;
    })()`, false);
    const tickA = await evaluate(cdp, `(() => {
      const el = [...document.querySelectorAll('[data-pix-tool]')].find((n) => n.dataset.toolId === ${JSON.stringify(parentId)});
      return el ? el.querySelector('[data-role="tool-duration"]')?.textContent || null : null;
    })()`, false);
    await sleep(700);
    const tickB = await evaluate(cdp, `(() => {
      const el = [...document.querySelectorAll('[data-pix-tool]')].find((n) => n.dataset.toolId === ${JSON.stringify(parentId)});
      if (!el) return null;
      const d = el.querySelector('[data-role="tool-duration"]');
      return { text: d ? d.textContent : '', status: el.dataset.status, nums: d ? getComputedStyle(d).fontVariantNumeric : '' };
    })()`, false);
    const msOf = (t) => {
      const m = String(t || "").match(/([\d.]+)(ms|s)/);
      if (!m) return null;
      return Number(m[1]) * (m[2] === "s" ? 1000 : 1);
    };
    check("C7a 运行中工具行跳秒（200ms 刷新，两次读数不同且递增）", tickA && tickB && msOf(tickA) != null && msOf(tickB.text) != null && msOf(tickB.text) > msOf(tickA), `${JSON.stringify(tickA)} → ${JSON.stringify(tickB)}`);
    check("C7b 耗时位等宽数字（font-variant-numeric: tabular-nums）", String(tickB?.nums || "").includes("tabular-nums"), String(tickB?.nums));

    await evaluate(cdp, `(() => {
      window.__piShell.applyFrame({ type: "tool_execution_start", toolCallId: ${JSON.stringify(childId)}, toolName: "write", args: { path: "nested.txt" }, parentToolCallId: ${JSON.stringify(parentId)} });
      return true;
    })()`, false);
    await sleep(300);
    const nesting = await evaluate(cdp, `(() => {
      const find = (toolId) => [...document.querySelectorAll('[data-pix-tool]')].find((n) => n.dataset.toolId === toolId);
      const parent = find(${JSON.stringify(parentId)});
      const child = find(${JSON.stringify(childId)});
      if (!parent || !child) return null;
      const btn = parent.querySelector('[data-role="tool-children"]');
      return {
        childHidden: child.hidden,
        childDepth: child.dataset.depth,
        parentDepth: parent.dataset.depth,
        toggle: btn ? btn.textContent : null,
        toggleHidden: btn ? btn.hidden : null,
        childIndent: getComputedStyle(child).marginLeft,
      };
    })()`, false);
    check("C7c 嵌套：parentToolCallId → 子行默认折叠，父行 +1 个子调用", !!nesting && nesting.childHidden === true && nesting.toggle === "+1 个子调用" && nesting.toggleHidden === false && nesting.parentDepth === "0" && nesting.childDepth === "1", JSON.stringify(nesting));

    const toggled = await (async () => {
      const box = await evaluate(cdp, `(() => {
        const parent = [...document.querySelectorAll('[data-pix-tool]')].find((n) => n.dataset.toolId === ${JSON.stringify(parentId)});
        const btn = parent?.querySelector('[data-role="tool-children"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`, false);
      if (!box) return null;
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await sleep(250);
      return evaluate(cdp, `(() => {
        const child = [...document.querySelectorAll('[data-pix-tool]')].find((n) => n.dataset.toolId === ${JSON.stringify(childId)});
        const parent = [...document.querySelectorAll('[data-pix-tool]')].find((n) => n.dataset.toolId === ${JSON.stringify(parentId)});
        return child ? { hidden: child.hidden, indent: getComputedStyle(child).marginLeft, expanded: parent.querySelector('[data-role="tool-children"]')?.dataset.expanded } : null;
      })()`, false);
    })();
    check("C7d 点「+1 个子调用」→ 子行展开并缩进一级（20px）", !!toggled && toggled.hidden === false && toggled.indent === "20px" && toggled.expanded === "1", JSON.stringify(toggled));

    await evaluate(cdp, `(() => {
      window.__piShell.applyFrame({ type: "tool_execution_end", toolCallId: ${JSON.stringify(childId)}, toolName: "write", isError: true, durationMs: 1234, result: { content: [{ type: "text", text: "boom" }] } });
      return true;
    })()`, false);
    await sleep(250);
    const failed = await evaluate(cdp, `(() => {
      const child = [...document.querySelectorAll('[data-pix-tool]')].find((n) => n.dataset.toolId === ${JSON.stringify(childId)});
      if (!child) return null;
      const fail = child.querySelector('[data-role="tool-fail"]');
      return {
        dur: child.querySelector('[data-role="tool-duration"]')?.textContent || '',
        failHidden: fail ? fail.hidden : null,
        failText: fail ? fail.textContent : null,
        failColor: fail ? getComputedStyle(fail).color : '',
        status: child.dataset.status,
        failed: child.dataset.failed,
      };
    })()`, false);
    check("C7e 失败工具：耗时固定为 durationMs（1.2s）+ 耗时位旁「失败」标记（danger 色）", !!failed && String(failed.dur || "").replace(/^[\s·]+/, "").trim() === "1.2s" && failed.failHidden === false && failed.failText === "失败" && failed.status === "失败" && failed.failed === "1", JSON.stringify(failed));

    await evaluate(cdp, `(() => {
      window.__piShell.applyFrame({ type: "tool_execution_end", toolCallId: ${JSON.stringify(parentId)}, toolName: "codemode", durationMs: 2345, result: { content: [{ type: "text", text: "ok" }] } });
      return true;
    })()`, false);
    await sleep(250);
    const parentDone = await evaluate(cdp, `(() => {
      const parent = [...document.querySelectorAll('[data-pix-tool]')].find((n) => n.dataset.toolId === ${JSON.stringify(parentId)});
      return parent ? { dur: parent.querySelector('[data-role="tool-duration"]')?.textContent || '', status: parent.dataset.status, fail: parent.querySelector('[data-role="tool-fail"]')?.hidden } : null;
    })()`, false);
    check("C7f 运行结束：耗时固定为最终 durationMs（2.3s），父行不误标失败", !!parentDone && String(parentDone.dur || "").replace(/^[\s·]+/, "").trim() === "2.3s" && parentDone.status === "完成" && parentDone.fail !== false, JSON.stringify(parentDone));
    const shot5 = await screenshot(cdp, "tool-rows-nested.png");
    console.log(`      截图：${shot5}`);

    // ---------- C6 单轮上限：60 个文件 → 只记路径 ----------
    const { TurnChanges } = await import(pathToFileURL(path.join(REPO_ROOT, "bridge", "src", "turn-changes.mjs")).href);
    const fixtureCwd = path.join(OUT, "limit-work");
    fs.mkdirSync(fixtureCwd, { recursive: true });
    const tc = new TurnChanges({ root: SNAPS, getCwd: () => fixtureCwd });
    const fixtureEngine = { id: "fixture-engine", sessionId: "limit-fixture", sessionFile: null, extra: { cwd: fixtureCwd } };
    tc.note(fixtureEngine, { type: "message_start", message: { role: "user", content: "make 60 files", timestamp: Date.now() } });
    for (let i = 0; i < 60; i++) {
      const name = `f${String(i).padStart(2, "0")}.txt`;
      const callId = `limit-${i}`;
      tc.note(fixtureEngine, { type: "tool_execution_start", toolCallId: callId, toolName: "write", args: { path: name } });
      fs.writeFileSync(path.join(fixtureCwd, name), `v${i}\n`);
      tc.note(fixtureEngine, { type: "tool_execution_end", toolCallId: callId, toolName: "write", args: { path: name }, durationMs: 1 });
    }
    tc.note(fixtureEngine, { type: "agent_settled", aborted: false });
    await tc.flush();
    const limitDir = path.join(SNAPS, "limit-fixture", "1");
    const limitMeta = fs.existsSync(path.join(limitDir, "meta.json")) ? JSON.parse(fs.readFileSync(path.join(limitDir, "meta.json"), "utf8")) : null;
    const limitApi = await (await fetch(`${BASE}/api/turn-changes?session=limit-fixture&turn=1`)).json();
    const stored = (limitApi.files ?? []).filter((f) => f.after?.stored).length;
    const pathOnly = (limitApi.files ?? []).filter((f) => f.after?.stored === false);
    check(
      "C6 60 个文件的一轮：60 条路径，仅 50 个存内容（其余只记路径），truncated=true",
      (limitApi.files ?? []).length === 60 && stored === 50 && pathOnly.length === 10 && pathOnly.every((f) => f.note === "file-limit") && limitApi.truncated === true && !!limitMeta,
      `files=${limitApi.files?.length} stored=${stored} pathOnly=${pathOnly.length} reason=${pathOnly[0]?.note} truncated=${limitApi.truncated}`,
    );
    const snapFiles = fs.existsSync(limitDir) ? fs.readdirSync(limitDir).filter((n) => /-after$/.test(n)).length : 0;
    check("C6b 快照目录里内容文件数 == 50（超限不落内容）", snapFiles === 50, `dir=${limitDir} afterFiles=${snapFiles}`);

    // ---------- 收尾：无页面异常 ----------
    check("C9 页面无 JS 异常 / 控制台 error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    cdp.close();
  } finally {
    try { edge?.kill("SIGKILL"); } catch {}
    bridge.kill("SIGKILL");
    await sleep(2500);
    const failed = results.filter((r) => !r.pass);
    const summary = results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail || ""}`).join("\n") + "\n";
    fs.writeFileSync(path.join(OUT, "summary.txt"), summary, "utf8");
    console.log(`\n${results.length - failed.length}/${results.length} PASS`);
    if (failed.length) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
