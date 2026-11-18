#!/usr/bin/env node
// S3b 证据：回来自动接管（关掉的标签页留下的那条后台引擎，回来打开同一会话就能接手）
//
// 做法：起真实桥 + 假 pi RPC CLI（不 spawn 真 pi、不碰真实会话目录、不占 7788），独立端口 7831。
// 假 pi 收到 prompt 后停在 streaming（= 后台还在跑的那一轮），所以判定全在桥的接管逻辑上，确定性最高。
//
// 覆盖（PI_SHELL_IDLE_MS=3000 / PI_SHELL_ADOPT_GRACE_MS=3000，按环境变量传进子进程）：
//   1) 无 SSE 打 prompt → 8s（> 2×idle）后引擎仍是 streaming 且**没被空闲回收**（S1 的 pin）
//   2) 新 client open 同一会话 → 200 adopted:true；引擎数仍是 1；被接管的还是原来那条 pi（pid 不变）→
//      本 client 之前那条空闲引擎被 release（旧 pid 不残留）
//   3) 同一个引擎上有 SSE 连接时，另一个 client open 同一会话 → 409（I1：不因接管而放宽）
//   4) 日志有 engine_adopted / session_open_conflict（可审计，不静默）
//
// 不覆盖（需要真实模型，与本节判据分开取证）：V-1（SIGTERM 时 pi 是否把半条 assistant 落盘）、
// V-2（长回合中桥不发请求时 pi 自己会不会被空闲机制打断）—— 用真 pi + 可用模型单独跑。
//
// 收尾：按 PID 关自己起的桥（不按命令行批量杀），夹具目录整个删掉。
// 用法：node scripts/evidence/background-continue-api.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, "..", "..");
const BRIDGE_ENTRY = path.join(BRIDGE_ROOT, "bridge", "src", "index.mjs");
// 端口可被门禁顺延：PI_SHELL_PORT（默认 7831）
const PORT = Number(process.env.PI_SHELL_PORT || 7831);
const IDLE_MS = 3000; // 与任务卡口径一致：8s > 2×idle，足以让「空闲回收」若生效就先收走引擎
const IDLE_WAIT_MS = 8000;

const FAKE_PI = `"use strict";
const path = require("node:path");
const readline = require("node:readline");

const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const reply = (msg, data) =>
  process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");

let sessionFile = null;
let sessionId = "fixture-boot";
let streaming = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.id === "undefined") return;
  switch (msg.type) {
    case "get_state":
      return reply(msg, {
        sessionId,
        sessionFile,
        cwd: process.cwd(),
        isStreaming: streaming,
        thinkingLevel: "off",
        model: { provider: "fake", id: "fake-1", name: "Fake" },
      });
    case "switch_session":
      sessionFile = msg.sessionPath;
      sessionId = path.basename(String(msg.sessionPath)).replace(/[.]jsonl$/i, "");
      return reply(msg, { cancelled: false });
    case "get_entries":
      return reply(msg, {
        entries: [{ type: "message", id: sessionId + "-u", message: { role: "user", content: [{ type: "text", text: "fixture" }] } }],
        leafId: sessionId + "-u",
      });
    case "prompt":
      reply(msg, { disposition: "started" });
      streaming = true;
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "background-turn" }] } });
      return;
    case "abort":
      streaming = false;
      return reply(msg, { cancelled: true });
    default:
      return reply(msg, {});
  }
});
`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

let tmpRoot = "";
let child = null;
let stderrText = "";

function buildFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-bg-continue-")));
  const agentDir = path.join(root, "agent");
  const pkgDir = path.join(agentDir, "install", "releases", "1.5.0", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "install", "current-version"), "1.5.0\n", "utf8");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pi-coding-agent", version: "1.5.0", bin: { pi: "cli.js" } }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(pkgDir, "cli.js"), FAKE_PI, "utf8");
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2), "utf8");

  const home = path.join(root, "home");
  const project = path.join(root, "project-a");
  const sessionsDir = path.join(root, "sessions");
  for (const dir of [home, project, sessionsDir]) fs.mkdirSync(dir, { recursive: true });
  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");

  const sessionFile = path.join(sessionsDir, "bg-continue.jsonl");
  const rows = [
    { type: "session", version: 3, id: "bg-continue", timestamp: new Date().toISOString(), cwd: project.replace(/\\/g, "/") },
    {
      type: "message",
      id: "bg-continue-u",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "后台跑一轮" }] },
    },
  ];
  fs.writeFileSync(sessionFile, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  return { root, agentDir, home, sessionFile, sessionsDir, mcpShellConfig };
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { ms = 20000, step = 50 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last?.ok) return last;
    await sleep(step);
  }
  return last ?? { ok: false };
}

async function main() {
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（不按命令行批量杀，先确认是谁）`);

  const fixture = buildFixture();
  tmpRoot = fixture.root;
  child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_AGENT_DIR: fixture.agentDir,
      PI_SHELL_SESSIONS_DIR: fixture.sessionsDir,
      PI_SHELL_AGENT_SESSIONS_DIR: "",
      PI_SHELL_MCP_CONFIG: fixture.mcpShellConfig,
      PI_SHELL_ORIGINS_FILE: path.join(tmpRoot, "sessions-origins.json"),
      PI_SHELL_LOG_DIR: path.join(tmpRoot, "logs"),
      PI_SHELL_LOG_FILE: path.join(tmpRoot, "logs", "bridge.log"),
      PI_SHELL_TURN_SNAPSHOTS: path.join(tmpRoot, "turn-snapshots"),
      PI_SHELL_CWD: fixture.home,
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_IDLE_MS: String(IDLE_MS),
      PI_SHELL_ADOPT_GRACE_MS: String(IDLE_MS),
      PI_SHELL_PI_BIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", () => {});
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderrText.length < 4000) stderrText += chunk;
  });

  const api = async (pathname, { method = "GET", client = null, body } = {}) => {
    const headers = {};
    if (client) headers["x-pi-shell-client"] = client;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
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
  };
  const health = async () => (await api("/api/health")).json;
  const ownerOf = (h, client) => (h?.engines ?? []).find((e) => e.client === client) ?? null;

  const ready = await waitFor(async () => {
    try {
      return { ok: (await health())?.ok === true };
    } catch {
      return { ok: false };
    }
  }, { ms: 30000 });
  if (!ready.ok) throw new Error(`桥未就绪（stderr: ${stderrText.slice(0, 500)}）`);
  console.log(`fixture=${tmpRoot}`);
  console.log(`bridge=http://127.0.0.1:${PORT}`);

  const tabA = "evidence-tab-a"; // 打完 prompt 就"关掉"的那一列
  const tabB = "evidence-tab-b"; // 回来打开同一会话的新页面
  const tabC = "evidence-tab-c"; // 有活跃标签页占着时的另一列

  // 1) A 打开会话 → 无 SSE 打 prompt（引擎进入 streaming）
  const opened = await api("/api/session/open", { method: "POST", client: tabA, body: { path: fixture.sessionFile } });
  if (opened.status !== 200) throw new Error(`open 应 200，实际 ${opened.status}：${opened.text.slice(0, 200)}`);
  const attached = await waitFor(async () => {
    const e = ownerOf(await health(), tabA);
    return { ok: !!e && e.sessionFile === fixture.sessionFile, engine: e };
  }, { ms: 15000 });
  if (!attached.ok) throw new Error("A 未能附着到目标会话");
  const orphanPid = attached.engine.pid;

  const prompted = await api("/api/prompt", { method: "POST", client: tabA, body: { message: "后台长任务（无 SSE）" } });
  if (prompted.status !== 200) throw new Error(`prompt 应 200，实际 ${prompted.status}：${prompted.text.slice(0, 200)}`);

  // 2) 等 8s（> 2×idle）：S1 的 pin 应让这条 streaming 引擎不被空闲回收
  await sleep(IDLE_WAIT_MS);
  const idleHealth = await health();
  const pinned = ownerOf(idleHealth, tabA);
  check(
    `无 SSE 静默 ${IDLE_WAIT_MS}ms（idle=${IDLE_MS}ms）后引擎仍在跑且未被回收`,
    pinned?.state === "streaming" && pinned?.pid === orphanPid,
    `state=${pinned?.state} pid=${pinned?.pid}（原 ${orphanPid}）engineCount=${idleHealth?.engineCount}`,
  );
  check("此时池内只有 1 条引擎（还没人回来）", idleHealth?.engineCount === 1, `engineCount=${idleHealth?.engineCount}`);

  // 3) B 回来打开同一会话 → 自动接管
  const beforeAdopt = await health();
  const tabBBefore = ownerOf(beforeAdopt, tabB);
  const adopted = await api("/api/session/open", { method: "POST", client: tabB, body: { path: fixture.sessionFile } });
  check(
    "新页面 open 同一会话 → 200 adopted:true（不是 409）",
    adopted.status === 200 && adopted.json?.adopted === true,
    `status=${adopted.status} adopted=${adopted.json?.adopted} mode=${adopted.json?.mode}`,
  );
  const afterAdopt = await health();
  check(
    "接管后引擎数仍是 1（不增；空转的旧引擎被 release）",
    afterAdopt?.engineCount === 1 && ownerOf(afterAdopt, tabA) === null,
    `before=${beforeAdopt?.engineCount} after=${afterAdopt?.engineCount} 旧引擎=${tabBBefore?.pid ?? "无"}`,
  );
  check(
    "接管到的是原来那条 pi（pid 不变、sessionFile 不变）",
    ownerOf(afterAdopt, tabB)?.pid === orphanPid && ownerOf(afterAdopt, tabB)?.sessionFile === fixture.sessionFile,
    `pid=${ownerOf(afterAdopt, tabB)?.pid} sessionFile=${ownerOf(afterAdopt, tabB)?.sessionFile}`,
  );
  // 接管前 tabB 没有引擎：这条请求会先建一条空闲引擎，再被「先 release 再 own」换掉（F25 的坑）
  const logText = await fsp.readFile(path.join(tmpRoot, "logs", "bridge.log"), "utf8");
  check(
    "接管前先 release 本 client 的空闲引擎（F25：不静默丢进程）",
    new RegExp(`engine_release\\|id=${tabB} reason=adopt-swap`).test(logText) &&
      new RegExp(`engine_adopted\\|from=${tabA} to=${tabB} pid=${orphanPid} released=${tabB}`).test(logText),
    "",
  );

  // 4) B 连上 SSE（= 有活跃标签页占着）→ C open 同一会话仍 409
  const ac = new AbortController();
  const sse = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
    headers: { accept: "text/event-stream", "x-pi-shell-client": tabB },
    signal: ac.signal,
  });
  check("有活跃标签页时的 SSE 能连上（接管后的引擎可直连）", sse.status === 200, `status=${sse.status}`);
  const sawState = await waitFor(async () => ({
    ok: Boolean((await health()).engines.some((e) => e.client === tabB && e.state === "streaming")),
  }), { ms: 10000 });
  check("接管后的引擎在 /api/health 里仍显示 streaming（资源面板口径不撒谎）", sawState.ok, `ok=${sawState.ok}`);

  const before409 = await health();
  const conflict = await api("/api/session/open", { method: "POST", client: tabC, body: { path: fixture.sessionFile } });
  const after409 = await health();
  check(
    "有 SSE 时另一列 open 同一会话 → 409（I1 不放宽）",
    conflict.status === 409 && conflict.json?.error?.code === "CONFLICT",
    `status=${conflict.status} code=${conflict.json?.error?.code}`,
  );
  check(
    "被拒时不动目标引擎（owner/pid 不变；+1 是请求方自己的空闲引擎，属今天既有的建引擎时机）",
    ownerOf(after409, tabB)?.pid === orphanPid && ownerOf(after409, tabA) === null,
    `before=${before409?.engineCount} after=${after409?.engineCount} tabB.pid=${ownerOf(after409, tabB)?.pid}`,
  );
  ac.abort(); // 主动断开（按连接关，不杀进程）
  await sleep(200);

  // 5) 日志可审计（重新读：409 那一步之后才写的行也在）
  const finalLog = await fsp.readFile(path.join(tmpRoot, "logs", "bridge.log"), "utf8");
  check("日志有 engine_adopted", /engine_adopted/.test(finalLog), "");
  check("日志有 session_open_conflict", /session_open_conflict/.test(finalLog), "");

  return results.every((r) => r.ok);
}

let exitCode = 1;
try {
  exitCode = (await main()) ? 0 : 1;
} catch (err) {
  console.error(`FAIL  ${err?.message || err}`);
  if (stderrText) console.error(`bridge stderr: ${stderrText.slice(0, 800)}`);
  exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill(); // 按 PID 关自己起的桥（不按命令行批量杀）
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null) {
      try {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {}
    }
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[background-continue-api] ${results.length - failed}/${results.length} checks passed`);
process.exit(exitCode);
