#!/usr/bin/env node
// 会话来源分类（user / agent / test）UI 证据（零依赖、CDP）
//
// 为什么存在：「新会话自动归类」是机制，不是一次性的标签操作。本脚本证明的是页面/接口层面的
// 可见行为，而不是函数返回值：
//   1) /api/sessions 默认不返回 test；?include=test 才返回
//   2) 页面有「🤖 Agent 会话（N）」独立板块，且里面只有 agent 会话
//   3) agent 行有 AGENT 徽标 + data-origin="agent"；user 行没有
//   4) 用户会话仍在原有 cwd 分组里（分组没被重排）
//   5) sessions-origins.json 生成且含 4 条记录（工具窗口那条的 reason = tool-window）
//   6) 刷新后分类不变（持久化 + sidecar 优先）
//
// 数据来源：**手写夹具**（%TEMP%/pi-shell-origin-fixture/sessions[-agents]），
// 绝不创建、移动或删除任何真实会话文件；桥的 agent 目录也指向夹具（不启动 pi）。
// 工具窗口不靠真实工具调用：桥支持 PI_SHELL_ORIGIN_TEST_WINDOWS 在启动期注入固定窗口，
// 匹配逻辑与生产完全同一条代码路径。
//
// 用法：node scripts/evidence/origin-ui.mjs   （固定端口 7828；PI_SHELL_ORIGIN_PORT 可改）
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 固定 7828：不读环境里的 PI_SHELL_PORT（那是正在运行的真实桥的端口，不能抢）
const PORT = Number(process.env.PI_SHELL_ORIGIN_PORT || 7828);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-origin-fixture");
const SESSIONS = path.join(OUT_DIR, "sessions");
const AGENTS = path.join(OUT_DIR, "sessions-agents");
const AGENT_DIR = path.join(OUT_DIR, "agent");
const ORIGINS = path.join(OUT_DIR, "sessions-origins.json");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具（4 个最小 jsonl：session header + 1 user + 1 assistant）----------

const NOW = Date.now();
const FIXTURE = [
  {
    dir: path.join(SESSIONS, "--C--Users-user-user--"),
    file: "user-session-0001.jsonl",
    id: "user-session-0001",
    cwd: "C:\\Users\\user\\user-proj",
    headerAt: NOW - 3_600_000,
    userAt: NOW - 3_600_000 + 1000,
    answerAt: NOW - 3_600_000 + 2000,
    user: "用户自己发起的会话",
    answer: "好的",
  },
  {
    dir: path.join(SESSIONS, "--C--Users-user-window--"),
    file: "agent-window-session-0001.jsonl",
    id: "agent-window-session-0001",
    cwd: "C:\\Users\\user\\window-proj",
    // header.timestamp 落在注入的工具窗口内 → 工具窗口规则（reason=tool-window）
    headerAt: NOW,
    userAt: NOW + 500,
    answerAt: NOW + 900,
    user: "AI 在工具窗口里跑出来的会话",
    answer: "来自 pi -p",
  },
  {
    dir: path.join(SESSIONS, "--C--Users-user-e2e--"),
    file: "test-session-0001.jsonl",
    id: "test-session-0001",
    cwd: path.join(OUT_DIR, "tmp-proj"),
    headerAt: NOW - 1_000_000,
    userAt: NOW - 1_000_000 + 1000,
    answerAt: NOW - 1_000_000 + 2000,
    user: "探针会话",
    answer: "不该出现在列表里",
  },
  {
    dir: path.join(AGENTS, "--C--Users-user-agent--"),
    file: "agent-dir-session-0001.jsonl",
    id: "agent-dir-session-0001",
    cwd: "C:\\Users\\user\\agent-proj",
    headerAt: NOW - 1_800_000,
    userAt: NOW - 1_800_000 + 1000,
    answerAt: NOW - 1_800_000 + 2000,
    user: "开发 Agent 的会话",
    answer: "来自 sessions-agents",
  },
];

function writeFixture() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(AGENTS, { recursive: true });
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  for (const item of FIXTURE) {
    fs.mkdirSync(item.dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: item.id, timestamp: item.headerAt, cwd: item.cwd }),
      JSON.stringify({
        type: "message",
        id: `${item.id}-e1`,
        parentId: null,
        timestamp: item.userAt,
        message: { role: "user", content: item.user },
      }),
      JSON.stringify({
        type: "message",
        id: `${item.id}-e2`,
        parentId: `${item.id}-e1`,
        timestamp: item.answerAt,
        message: { role: "assistant", content: [{ type: "text", text: item.answer }] },
      }),
    ];
    fs.writeFileSync(path.join(item.dir, item.file), lines.join("\n") + "\n", "utf8");
  }
}

// ---------- bridge ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_AGENT_SESSIONS_DIR: AGENTS,
      PI_SHELL_ORIGINS_FILE: ORIGINS,
      PI_SHELL_AGENT_DIR: AGENT_DIR, // 隔离：不启动/不触碰真实 pi agent 目录
      PI_SHELL_ORIGIN_TEST_WINDOWS: JSON.stringify([{ start: NOW - 500, end: NOW + 500, tool: "bash" }]),
      PI_SHELL_LOG_FILE: LOG_FILE,
    },
    stdio: "ignore", // H-15：管道不消费会把桥堵死
  });
}

async function waitHealth(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/api/health`, { cache: "no-store" });
      const body = await res.json();
      if (body?.ok) return body;
    } catch {}
    await sleep(200);
  }
  return null;
}

async function getSessions(query = "") {
  const res = await fetch(`${BASE}/api/sessions${query}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const flatten = (data) => (data.groups ?? []).flatMap((g) => g.sessions ?? []);

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

/** 页面里的分类快照（只读 DOM，不触发业务动作） */
const SNAPSHOT = `(() => {
  const rows = [...document.querySelectorAll('[data-role=session-row]')];
  const groups = [...document.querySelectorAll('[data-role=group-row]')];
  const agentGroup = groups.find((g) => g.dataset.agent === 'true') || null;
  const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
  return {
    groups: groups.map((g) => ({ dir: g.dataset.dir, text: g.textContent, top: top(g), open: g.dataset.open })),
    agentGroup: agentGroup ? { dir: agentGroup.dataset.dir, text: agentGroup.textContent, top: top(agentGroup), open: agentGroup.dataset.open } : null,
    rows: rows.map((r) => ({
      id: r.dataset.sessionId,
      origin: r.dataset.origin || null,
      top: top(r),
      badge: r.querySelector('[data-role=origin-badge]')?.textContent || null,
      title: r.querySelector('[data-field=title]')?.textContent || '',
      leftShadow: getComputedStyle(r).boxShadow,
    })),
  };
})()`;

/** 列表默认收起（用户要求）：测试前把所有分组/Agent 板块展开，否则看不到行 */
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

async function waitRows(cdp, expected, ms = 20000) {
  const t0 = Date.now();
  let snap = null;
  while (Date.now() - t0 < ms) {
    snap = await evaluate(cdp, SNAPSHOT, false).catch(() => null);
    if ((snap?.rows?.length ?? 0) >= expected) return snap;
    await sleep(250);
  }
  return snap;
}

// ---------- 主流程 ----------

async function main() {
  writeFixture();

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
  try {
    const health = await waitHealth();
    if (!health) throw new Error(`bridge 未在 20s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · 夹具 ${OUT_DIR}`);

    // ---- 断言 1：接口层默认不含 test；?include=test 才返回 ----
    const plain = await getSessions();
    const plainSessions = flatten(plain);
    const plainIds = plainSessions.map((s) => s.id).sort();
    check(
      "1a /api/sessions 默认不返回 test 会话",
      plainSessions.length === 3 && plainSessions.every((s) => s.origin !== "test"),
      `返回 ${plainSessions.length} 条：${plainIds.join(", ")}`,
    );
    const withTest = await getSessions("?include=test");
    const withTestSessions = flatten(withTest);
    const testSession = withTestSessions.find((s) => s.id === "test-session-0001");
    check(
      "1b ?include=test 才返回 test 会话",
      withTestSessions.length === 4 && testSession?.origin === "test",
      `返回 ${withTestSessions.length} 条（test=${testSession?.origin ?? "缺失"}）`,
    );

    // ---- 断言 5（接口侧先落盘）：sidecar 4 条记录 + reason 正确 ----
    const sidecarKey = (dirName, file) => `sessions/${dirName}/${file}`;
    const agentKey = (dirName, file) => `sessions-agents/${dirName}/${file}`;
    const raw = fs.existsSync(ORIGINS) ? JSON.parse(fs.readFileSync(ORIGINS, "utf8")) : null;
    const windowRecord = raw?.[sidecarKey("--C--Users-user-window--", "agent-window-session-0001.jsonl")];
    const userRecord = raw?.[sidecarKey("--C--Users-user-user--", "user-session-0001.jsonl")];
    const testRecord = raw?.[sidecarKey("--C--Users-user-e2e--", "test-session-0001.jsonl")];
    const agentRecord = raw?.[agentKey("--C--Users-user-agent--", "agent-dir-session-0001.jsonl")];
    check(
      "5 sessions-origins.json 生成且含 4 条记录（工具窗口 reason=tool-window）",
      !!raw &&
        Object.keys(raw).length === 4 &&
        windowRecord?.origin === "agent" &&
        windowRecord?.reason === "tool-window" &&
        userRecord?.origin === "user" &&
        agentRecord?.origin === "agent" &&
        agentRecord?.reason === "agent-dir" &&
        testRecord?.origin === "test",
      raw
        ? `4 条：user=${userRecord?.reason} · window=${windowRecord?.reason} · agent=${agentRecord?.reason} · test=${testRecord?.reason}`
        : "sidecar 未生成",
    );

    // ---- 页面 ----
    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;
    const pageErrors = [];
    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    await expandAll(cdp);
    const snap = await waitRows(cdp, 3);
    const rowIds = (snap?.rows ?? []).map((r) => r.id).sort();
    check("0 页面列表渲染出 3 条非 test 会话", (snap?.rows?.length ?? 0) === 3, rowIds.join(", "));

    // ---- 断言 2：独立板块存在，且里面只有 agent 会话 ----
    const agentIds = new Set(["agent-dir-session-0001", "agent-window-session-0001"]);
    const agentRows = (snap?.rows ?? []).filter((r) => r.origin === "agent");
    const firstUserGroupTop = (snap?.groups ?? []).find((g) => g.dir !== "__agent__")?.top ?? Infinity;
    check(
      "2 顶部有独立板块「AGENT 会话 2」，只含 agent 会话且位于所有 cwd 分组之前",
      !!snap?.agentGroup &&
        snap.agentGroup.text.includes("AGENT 会话") &&
        /\s?2$/.test(snap.agentGroup.text.trim()) &&
        agentRows.length === 2 &&
        agentRows.every((r) => agentIds.has(r.id)) &&
        agentRows.every((r) => r.top < firstUserGroupTop),
      `板块文本=${snap?.agentGroup?.text ?? "缺失"} · agent 行=${agentRows.map((r) => r.id).join(",") || "无"}`,
    );

    // ---- 断言 3：agent 行有 AGENT 徽标 + data-origin；user 行没有 ----
    const userRow = (snap?.rows ?? []).find((r) => r.id === "user-session-0001");
    check(
      "3a agent 行有 AGENT 徽标 + data-origin=agent + 左侧强调边",
      agentRows.length === 2 &&
        agentRows.every((r) => r.badge === "AGENT" && r.origin === "agent" && /inset/.test(r.leftShadow)),
      agentRows.map((r) => `${r.id}[${r.badge ?? "无徽标"}]`).join(" · "),
    );
    check(
      "3b user 行没有 AGENT 徽标 / data-origin",
      !!userRow && !userRow.badge && !userRow.origin,
      userRow ? `badge=${userRow.badge ?? "无"} origin=${userRow.origin ?? "无"}` : "user 行缺失",
    );

    // ---- 断言 4：用户会话仍在按 cwd 分组里 ----
    const agentCwds = new Set(agentRows.map((r) => r.id));
    const userGroups = (snap?.groups ?? []).filter((g) => g.dir !== "__agent__");
    const userGroup = userGroups.find((g) => g.dir === "--C--Users-user-user--");
    const nextGroupTop = userGroups
      .filter((g) => g.top > (userGroup?.top ?? Infinity))
      .reduce((min, g) => Math.min(min, g.top), Infinity);
    check(
      "4 用户会话仍在按 cwd 分组里（且不混入 agent 行）",
      !!userGroup &&
        (userGroup.text.includes("--C--Users-user-user--") || userGroup.text.includes("C:\\Users\\user\\user-proj")) &&
        !!userRow &&
        userRow.top > userGroup.top &&
        userRow.top < nextGroupTop &&
        !agentCwds.has(userRow.id) &&
        userGroups.every((g) => g.dir !== "__agent__"),
      `分组=${userGroup?.dir ?? "缺失"} · 用户行 top=${userRow?.top ?? "?"} · 下一组 top=${nextGroupTop === Infinity ? "无" : nextGroupTop}`,
    );

    // test 会话不出现在页面
    const testOnPage = (snap?.rows ?? []).some((r) => r.id === "test-session-0001");
    check("4b 页面不出现 test 会话", !testOnPage, testOnPage ? "test 行被渲染了" : "未出现");

    // ---- 断言 6：刷新后分类不变（持久化 + sidecar 优先）----
    const before = JSON.stringify(raw);
    await cdp.send("Page.reload", { ignoreCache: true });
    await expandAll(cdp);
    await sleep(500);
    await expandAll(cdp);
    const snap2 = await waitRows(cdp, 3);
    const agentRows2 = (snap2?.rows ?? []).filter((r) => r.origin === "agent");
    const raw2 = fs.existsSync(ORIGINS) ? JSON.parse(fs.readFileSync(ORIGINS, "utf8")) : null;
    check(
      "6 刷新后分类不变（页面 + sidecar 记录一致）",
      (snap2?.rows?.length ?? 0) === 3 &&
        agentRows2.length === 2 &&
        JSON.stringify(raw2) === before,
      `刷新后 ${snap2?.rows?.length ?? 0} 条（agent ${agentRows2.length} 条）· sidecar 未变=${JSON.stringify(raw2) === before}`,
    );

    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("7 加载期无未捕获 JS 异常", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");
  } finally {
    try { cdp?.close(); } catch {}
    try { edge?.kill("SIGKILL"); } catch {}
    try { bridge.kill("SIGTERM"); } catch {}
    await sleep(1200);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
