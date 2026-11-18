// S2c：尾巴缓冲的作用域（哪些帧可以回放、哪个时刻必须清空）
//
// 为什么要这一层：尾巴回放把**引擎启动期**的 extension_ui_request(setStatus)
// 也补给了首个 SSE 连接 → 发版门禁 firstLoad B1/B4 回归（首屏常驻一个 ext-status 浮层）。
// 这是「回放范围」的实现边界，不是测试口径。本文件钉住三条口径：
//   1) 只有引擎处于 streaming（本轮已开始）时的帧才入缓冲：启动期帧一律不入、不回放；
//   2) 控制类帧（extension_ui_request / bridge_state / resync / 接管回执…）不入缓冲、不回放，
//      但**在线客户端照常实时收到**（不能为了防回放把实时 UI 指令也掐掉）；
//   3) 会话身份变了（switch_session / new_session / 引擎重启 / adopt）→ reset：
//      上一会话「还没落盘」的尾巴绝不能补给新会话（S2b 风险 2）。
//
// 与 sse-replay.test.mjs 同款夹具：真实桥 + 假 pi RPC CLI（不 spawn 真 pi、不占 7788、不碰真实会话）。
// 假 pi 的事件由命令触发（确定性），启动期就吐一帧 setStatus（首屏回归的原始触发点）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ENTRY = path.resolve(HERE, "..", "src", "index.mjs");
const GRACE_MS = 1500; // 接管静默门槛调小（默认 30s 不变）

const FAKE_PI = `"use strict";
const path = require("node:path");
const readline = require("node:readline");

const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const reply = (msg, data) =>
  process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");
const delta = (text) =>
  out({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });
const uiRequest = (id, method, extra) => out({ type: "extension_ui_request", id, method, ...(extra || {}) });

// 启动期（还没有任何一轮）：这一帧是 firstLoad B1/B4 回归的原始触发点，绝不能进回放缓冲
uiRequest("boot-status", "setStatus", { status: { text: "ready" } });

let sessionId = "scope-boot";
let sessionFile = null;
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
      streaming = false;
      return reply(msg, { cancelled: false });
    case "new_session":
      sessionId = "scope-new";
      sessionFile = null;
      streaming = false;
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
      delta("a1");
      uiRequest("mid-widget", "setWidget", { widget: "progress" }); // 流式中的控制帧：实时发、不回放
      delta("a2");
      return;
    case "get_commands":
      reply(msg, { commands: [] });
      // 断线期间产生的内容帧 + 夹在中间的控制帧
      delta("w1");
      uiRequest("mid-notify", "notify", { message: "still working" });
      delta("w2");
      return;
    case "abort":
      streaming = false;
      reply(msg, { cancelled: true });
      out({ type: "agent_settled" });
      return;
    default:
      return reply(msg, {});
  }
});
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 夹具：假 agentDir（install 树 + 假 pi）+ 会话目录（可带夹具 .jsonl）+ 空 MCP 配置 */
function buildFixture(tag, { sessions = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pi-shell-scope-${tag}-`)));
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
  const projectDir = path.join(root, "project");
  const sessionsDir = path.join(root, "sessions");
  for (const dir of [home, projectDir, sessionsDir]) fs.mkdirSync(dir, { recursive: true });
  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");

  // 夹具会话：header.cwd 必须指向真实存在的目录（readSessionCwd / 接管前置检查）
  const files = {};
  for (const id of sessions) {
    const file = path.join(sessionsDir, `${id}.jsonl`);
    const rows = [
      { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: projectDir.replace(/\\/g, "/") },
      { type: "message", id: `${id}-u`, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "fixture" }] } },
    ];
    fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    files[id] = file;
  }
  return { root, agentDir, home, projectDir, sessionsDir, mcpShellConfig, files };
}

function sleep(ms) {
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

async function api(port, pathname, { method = "GET", client = null, body } = {}) {
  const headers = {};
  if (client) headers["x-pi-shell-client"] = client;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
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
}

/** 起一个真实桥（假 pi、动态端口、夹具目录），返回句柄 */
async function startBridge(tag, extraEnv = {}, fixtureOpts = {}) {
  const fixture = buildFixture(tag, fixtureOpts);
  const port = await freePort();
  const logFile = path.join(fixture.root, "logs", "bridge.log");
  let stderrText = "";
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: fixture.root,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(port),
      PI_SHELL_AGENT_DIR: fixture.agentDir,
      PI_SHELL_SESSIONS_DIR: fixture.sessionsDir,
      PI_SHELL_AGENT_SESSIONS_DIR: "",
      PI_SHELL_MCP_CONFIG: fixture.mcpShellConfig,
      PI_SHELL_ORIGINS_FILE: path.join(fixture.root, "sessions-origins.json"),
      PI_SHELL_LOG_DIR: path.join(fixture.root, "logs"),
      PI_SHELL_LOG_FILE: logFile,
      PI_SHELL_TURN_SNAPSHOTS: path.join(fixture.root, "turn-snapshots"),
      PI_SHELL_CWD: fixture.home,
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_IDLE_MS: "600000", // 用例里会主动断线，别让空闲回收把引擎收走
      PI_SHELL_ADOPT_GRACE_MS: String(GRACE_MS),
      PI_SHELL_PI_BIN: "",
      ...extraEnv,
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

  const ready = await waitFor(async () => {
    try {
      const res = await api(port, "/api/health", { client: "boot" });
      return { ok: res.json?.pi?.state === "idle" };
    } catch {
      return { ok: false };
    }
  }, { ms: 30000 });
  assert.equal(ready.ok, true, `桥未就绪（stderr: ${stderrText.slice(0, 500)}）`);

  const logText = () => {
    try {
      return fs.readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill(); // 按 PID 关自己起的桥（不按命令行批量杀）
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await fsp.rm(fixture.root, { recursive: true, force: true });
  };
  return { port, child, fixture, logFile, logText, stop };
}

/** 把一块 `id:` / `data:` 文本解析成一帧；注释行（`: ping`）与 retry 返回 null */
function parseFrame(block) {
  let id = null;
  let data = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  if (data === null) return null;
  return { id: Number.isFinite(id) ? id : null, payload: JSON.parse(data) };
}

/** 连 SSE；返回 { frames, close() }（读取在后台持续进行，close() 断线） */
async function openSse({ port, client, since }) {
  const ac = new AbortController();
  const headers = { accept: "text/event-stream" };
  if (client) headers["x-pi-shell-client"] = client;
  const qs = since === undefined ? "" : `?since=${encodeURIComponent(String(since))}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/events${qs}`, { headers, signal: ac.signal });
  assert.equal(res.status, 200, "SSE 应 200");
  const frames = [];
  const handle = { frames, res, close: () => ac.abort() };
  handle.closed = (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame = parseFrame(block);
          if (frame) frames.push(frame);
        }
      }
    } catch {
      /* 主动 abort / 桥关闭：正常退出 */
    }
  })();
  return handle;
}

function waitFrame(handle, predicate, { ms = 10000, label = "帧" } = {}) {
  return waitFor(async () => {
    const hit = handle.frames.find(predicate);
    return { ok: Boolean(hit), frame: hit };
  }, { ms }).then((r) => {
    assert.ok(r.frame, `超时未收到${label}；已收到 ${handle.frames.map((f) => f.payload?.type).join(",")}`);
    return r.frame;
  });
}

const textOf = (frame) => frame?.payload?.message?.content?.[0]?.text ?? null;
const byText = (text) => (f) => f.payload?.type === "message_update" && textOf(f) === text;
const isUi = (f) => f.payload?.type === "extension_ui_request";
/** 回放窗口内的帧（resume 控制帧本身不算） */
const inWindow = (handle, resume) =>
  handle.frames.filter((f) => f.id !== null && f.id >= resume.payload.from && f.id <= resume.payload.to);

// ---------- 1) 启动期帧 / 控制类帧 ----------

test("S2c：启动期 setStatus 不入缓冲（首连不回放），流式控制帧实时但也不回放", { timeout: 120000 }, async () => {
  const bridge = await startBridge("control");
  try {
    const client = "sse-scope-control";

    // ---- 连接 1：启动期（引擎 idle、还没跑过任何一轮）----
    const c1 = await openSse({ port: bridge.port, client });
    const snapshot = await waitFrame(c1, (f) => f.payload?.type === "bridge_state", { label: "连接快照" });
    assert.equal(c1.frames[0]?.payload?.type, "resume", "resume 帧必须在所有数据帧之前");
    assert.ok(
      !c1.frames.some(isUi),
      `启动期的 extension_ui_request 不得补给新连接：${c1.frames.map((f) => f.payload?.type).join(",")}`,
    );

    // ---- 流式：内容是内容、控制帧照旧实时送达 ----
    const prompted = await api(bridge.port, "/api/prompt", { method: "POST", client, body: { message: "hi" } });
    assert.equal(prompted.status, 200, `prompt 应 200：${prompted.text.slice(0, 200)}`);
    const a2 = await waitFrame(c1, byText("a2"), { label: "a2" });
    const widget = await waitFrame(c1, (f) => isUi(f) && f.payload?.method === "setWidget", { label: "流式控制帧" });
    assert.ok(widget.id > snapshot.id, "控制帧实时送达（不能为了防回放把实时 UI 指令掐掉）");
    c1.close();

    // ---- 断线期间：内容帧 + 夹一帧 notify ----
    const cmds = await api(bridge.port, "/api/commands", { client });
    assert.equal(cmds.status, 200);

    // ---- 连接 2：只回放内容帧 ----
    const c2 = await openSse({ port: bridge.port, client, since: a2.id });
    const resume = await waitFrame(c2, (f) => f.payload?.type === "resume", { label: "resume" });
    assert.equal(resume.payload.from, a2.id + 1, "回放起点 = since + 1");
    await waitFrame(c2, byText("w2"), { label: "回放 w2" });

    const replayed = inWindow(c2, resume);
    assert.deepEqual(
      replayed.filter((f) => f.payload?.type === "message_update").map(textOf),
      ["w1", "w2"],
      "断线期间的内容帧必须补齐（不重不漏）",
    );
    assert.ok(!replayed.some(isUi), `控制帧不得回放：${replayed.map((f) => f.payload?.type).join(",")}`);
    assert.ok(
      !replayed.some((f) => f.payload?.type === "bridge_state"),
      "旧的状态快照不得回放（连接时会现发一帧新的）",
    );
    assert.equal(resume.payload.truncated, false);
    c2.close();
  } finally {
    await bridge.stop();
  }
});

// ---------- 2) 会话身份变了 → reset ----------

test("S2c：new_session 后 reset（上一会话的未落盘尾巴不补给新会话）", { timeout: 120000 }, async () => {
  const bridge = await startBridge("new-session");
  try {
    const client = "sse-scope-new";

    const c1 = await openSse({ port: bridge.port, client });
    await waitFrame(c1, (f) => f.payload?.type === "bridge_state", { label: "连接快照" });
    const prompted = await api(bridge.port, "/api/prompt", { method: "POST", client, body: { message: "hi" } });
    assert.equal(prompted.status, 200);
    const a2 = await waitFrame(c1, byText("a2"), { label: "a2" });

    // 回合结束但不落盘（只有 agent_settled，没有 message_end）→ 尾巴里还留着 a1/a2
    const aborted = await api(bridge.port, "/api/abort", { method: "POST", client, body: {} });
    assert.equal(aborted.status, 200, `abort 应 200：${aborted.text.slice(0, 200)}`);
    const idle = await waitFor(async () => {
      const h = await api(bridge.port, "/api/health");
      return { ok: h.json?.pi?.state === "idle", state: h.json?.pi?.state };
    }, { ms: 10000 });
    assert.equal(idle.ok, true, `应回到 idle（实际 ${idle.state}）`);
    c1.close();

    const created = await api(bridge.port, "/api/session/new", { method: "POST", client, body: {} });
    assert.equal(created.status, 200, `new_session 应 200：${created.text.slice(0, 200)}`);
    assert.ok(
      /sse_tail_reset.*reason=new_session/.test(bridge.logText()),
      "new_session 必须重置尾巴（日志应有 sse_tail_reset reason=new_session）",
    );

    // since=0：若没 reset，a1/a2 会被当成「未落盘的尾巴」补给新会话
    const c2 = await openSse({ port: bridge.port, client, since: 0 });
    const resume = await waitFrame(c2, (f) => f.payload?.type === "resume", { label: "resume" });
    assert.ok(resume.payload.from > a2.id, `reset 后回放起点应在旧尾巴之后（from=${resume.payload.from} a2=${a2.id}）`);
    await sleep(200);
    assert.deepEqual(
      c2.frames.filter((f) => f.payload?.type === "message_update"),
      [],
      "上一会话的 message_update 不得补给新会话",
    );
    c2.close();
  } finally {
    await bridge.stop();
  }
});

test("S2c：switch_session 后 reset（打开另一条会话不把上一会话的尾巴补给新会话）", { timeout: 120000 }, async () => {
  const bridge = await startBridge("switch-session", {}, { sessions: ["s1", "s2"] });
  const { port, fixture } = bridge;
  const health = async () => (await api(port, "/api/health")).json;
  const engineOf = (h, client) => (h?.engines ?? []).find((e) => e.client === client) ?? null;

  try {
    const client = "sse-scope-switch";
    const opened = await api(port, "/api/session/open", { method: "POST", client, body: { path: fixture.files.s1 } });
    assert.equal(opened.status, 200, `open 应 200：${opened.text.slice(0, 200)}`);
    const attached = await waitFor(async () => {
      const e = engineOf(await health(), client);
      return { ok: !!e && e.sessionFile === fixture.files.s1, engine: e };
    }, { ms: 15000 });
    assert.ok(attached.ok, "应先附着到 s1");

    const c1 = await openSse({ port, client });
    await waitFrame(c1, (f) => f.payload?.type === "bridge_state", { label: "连接快照" });
    const prompted = await api(port, "/api/prompt", { method: "POST", client, body: { message: "s1 的一轮" } });
    assert.equal(prompted.status, 200, `prompt 应 200：${prompted.text.slice(0, 200)}`);
    const a2 = await waitFrame(c1, byText("a2"), { label: "a2（已进尾巴缓冲）" });

    // 回合结束但不落盘（只有 agent_settled）→ 尾巴里仍留着 a1/a2，等下一次会话切换清理
    const aborted = await api(port, "/api/abort", { method: "POST", client, body: {} });
    assert.equal(aborted.status, 200, `abort 应 200：${aborted.text.slice(0, 200)}`);
    await waitFor(async () => {
      const h = await health();
      return { ok: h?.pi?.state === "idle", state: h?.pi?.state };
    }, { ms: 10000 });

    // ---- 切到 s2（同一个引擎 → switch_session）----
    const switched = await api(port, "/api/session/open", { method: "POST", client, body: { path: fixture.files.s2 } });
    assert.equal(switched.status, 200, `open s2 应 200：${switched.text.slice(0, 200)}`);
    await waitFrame(c1, (f) => f.payload?.type === "session_attached" && f.payload?.sessionFile === fixture.files.s2, {
      label: "session_attached(s2)",
    });
    assert.ok(
      /sse_tail_reset.*reason=switch_session/.test(bridge.logText()),
      "switch_session 后必须重置尾巴（日志应有 sse_tail_reset reason=switch_session）",
    );

    // since=0：若没 reset，s1 的 a1/a2 会被当成「未落盘的尾巴」补进 s2 这一页
    const c2 = await openSse({ port, client, since: 0 });
    const resume = await waitFrame(c2, (f) => f.payload?.type === "resume", { label: "resume" });
    assert.ok(resume.payload.from > a2.id, `reset 后回放起点应在旧尾巴之后（from=${resume.payload.from} a2=${a2.id}）`);
    await sleep(200);
    assert.deepEqual(
      c2.frames.filter((f) => f.payload?.type === "message_update"),
      [],
      "上一会话的 message_update 不得补给新会话",
    );
    c1.close();
    c2.close();
  } finally {
    await bridge.stop();
  }
});
