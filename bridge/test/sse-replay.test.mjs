// S2b 接线层单测：SSE 尾巴回放（真实桥 + 假 pi RPC CLI，不 spawn 真 pi、不占 7788、不碰真实会话）
//
// 覆盖（对应任务卡 DoD 1/2/3/4）：
//   1) 每个数据帧带 `id: <seq>`；`?since=` 与 `Last-Event-ID` 都能命中（后者在截断用例里验）
//   2) resume 帧在数据帧之前（含 {from,to,truncated}）；回放 seq 严格递增、无重复
//   3) message_end 是落盘点：缓冲归零、baseSeq = 该帧 seq，再连不重放已落盘内容
//   4) 超字节上限：resume.truncated=true，仍回放已保留的最新部分（不整段丢弃）
//
// 假 pi 的事件由**命令**触发而不是定时器（确定性）：
//   prompt       → 回复 + agent_start + message_start + u1 + u2（第一波）
//   get_commands → 回复 + u3..u8（第二波：断线期间产生，落进尾巴缓冲）
//   get_state    → 回复 + message_end + agent_settled（落盘点 + 回合结束）
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

const FAKE_PI = `"use strict";
const readline = require("node:readline");

const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const reply = (msg, data) =>
  process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");

let sessionId = "fake-sse-tail-0";
const delta = (text) =>
  out({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.id === "undefined") return;
  switch (msg.type) {
    case "get_state":
      reply(msg, {
        sessionId,
        sessionFile: null,
        cwd: process.cwd(),
        isStreaming: false,
        thinkingLevel: "off",
        model: { provider: "fake", id: "fake-1", name: "Fake" },
      });
      // 落盘点：message_end（真 pi：appendMessage 在 message_end 时发生）
      out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "end" }] } });
      out({ type: "agent_settled" });
      return;
    case "get_entries":
      return reply(msg, { entries: [], leafId: null });
    case "prompt":
      reply(msg, { disposition: "started" });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      delta("u1");
      delta("u2");
      return;
    case "get_commands":
      reply(msg, { commands: [] });
      // 第二波：客户端此时已断开 → 只能靠尾巴缓冲回放
      for (const text of ["u3", "u4", "u5", "u6", "u7", "u8"]) delta(text);
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

/** 夹具：假 agentDir（install 树 + 假 pi）+ 空会话目录 + 空 MCP 配置（不读真实 ~/.pi/agent） */
function buildFixture(tag) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pi-shell-sse-${tag}-`)));
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
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");
  return { root, agentDir, home, sessionsDir, mcpShellConfig };
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

/** 起一个真实桥（假 pi、动态端口、夹具目录），返回句柄 */
async function startBridge(tag, extraEnv = {}) {
  const fixture = buildFixture(tag);
  const port = await freePort();
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
      PI_SHELL_LOG_FILE: path.join(fixture.root, "logs", "bridge.log"),
      PI_SHELL_CWD: fixture.home,
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_IDLE_MS: "600000", // 用例里会主动断线，别让空闲回收把引擎收走
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
  return { port, child, fixture, stop, stderr: () => stderrText };
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

/** 连 SSE；返回 { frames, close(), }（读取在后台持续进行，close() 断线） */
async function openSse({ port, client, since, lastEventId }) {
  const ac = new AbortController();
  const headers = { accept: "text/event-stream" };
  if (client) headers["x-pi-shell-client"] = client;
  if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
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

test("S2b：断线重连用 ?since= 回放尾巴（id 行 / resume 帧 / 严格递增 / 落盘点清空）", { timeout: 120000 }, async () => {
  const bridge = await startBridge("since");
  try {
    const client = "sse-since";

    // ---- 连接 1：拿到快照 + 第一波 ----
    const c1 = await openSse({ port: bridge.port, client });
    const snapshot = await waitFrame(c1, (f) => f.payload?.type === "bridge_state", { label: "连接快照" });
    assert.equal(c1.frames[0]?.payload?.type, "resume", "resume 帧必须在所有数据帧之前");
    assert.ok(c1.frames.every((f) => f.payload?.type === "resume" || Number.isFinite(f.id)), "每个数据帧都必须有 id: <seq>");
    assert.deepEqual(
      Object.keys(c1.frames[0].payload).filter((k) => ["from", "to", "truncated"].includes(k)).sort(),
      ["from", "to", "truncated"],
      "resume 帧必须含 {from,to,truncated}",
    );
    assert.ok(Number.isFinite(snapshot.id), "连接快照也要带 id");

    const prompted = await api(bridge.port, "/api/prompt", { method: "POST", client, body: { message: "hi" } });
    assert.equal(prompted.status, 200, `prompt 应 200：${prompted.text.slice(0, 200)}`);
    const u2 = await waitFrame(c1, byText("u2"), { label: "u2" });
    const lastSeen = u2.id;
    assert.ok(Number.isFinite(lastSeen) && lastSeen > snapshot.id, "u2 的 seq 应大于快照 seq");
    c1.close(); // 模拟断线

    // ---- 断线期间产生 u3..u8：没有客户端也必须进缓冲 ----
    const cmds = await api(bridge.port, "/api/commands", { client });
    assert.equal(cmds.status, 200);

    // ---- 连接 2：?since= 回放 ----
    const c2 = await openSse({ port: bridge.port, client, since: lastSeen });
    const resume = await waitFrame(c2, (f) => f.payload?.type === "resume", { label: "resume" });
    assert.equal(resume.payload.from, lastSeen + 1, "回放起点 = since+1");
    assert.equal(resume.payload.truncated, false, "默认上限下不应截断");
    await waitFrame(c2, byText("u8"), { label: "回放 u8" });

    const replayed = c2.frames.filter((f) => f.payload?.type === "message_update" && f.id <= resume.payload.to);
    const seqs = replayed.map((f) => f.id);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => seqs[0] + i), "回放 seq 严格递增、无空洞");
    assert.equal(new Set(seqs).size, seqs.length, "回放不得重复");
    assert.deepEqual(replayed.map(textOf), ["u3", "u4", "u5", "u6", "u7", "u8"], "断线期间的 6 帧都要补齐");
    assert.equal(resume.payload.to, replayed[replayed.length - 1].id, "resume.to = 回放窗口末端");

    // ---- 落盘点：message_end（POST /api/model → 假 pi 的 get_state 触发）→ 缓冲归零 ----
    const modeled = await api(bridge.port, "/api/model", {
      method: "POST",
      client,
      body: { provider: "fake", modelId: "fake-1" },
    });
    assert.equal(modeled.status, 200, `set_model 应 200：${modeled.text.slice(0, 200)}`);
    const ended = await waitFrame(c2, (f) => f.payload?.type === "message_end", { label: "message_end" });
    const endSeq = ended.id;

    // ---- 连接 3：?since=0 早于落盘点 → 只回放 baseSeq 之后（不重放已落盘内容） ----
    const c3 = await openSse({ port: bridge.port, client, since: 0 });
    const resume3 = await waitFrame(c3, (f) => f.payload?.type === "resume", { label: "resume(3)" });
    assert.equal(resume3.payload.from, endSeq + 1, "落盘点之后才回放：from = baseSeq+1");
    c3.close();

    const replayed3 = c3.frames.filter((f) => f.payload?.type === "message_update");
    assert.deepEqual(replayed3, [], "已落盘的 message_update 不得再回放（不重复）");
    assert.ok(
      !c3.frames.some((f) => f.payload?.type === "message" || f.payload?.type === "message_start"),
      "落盘点之前的内容一律不回放",
    );
  } finally {
    await bridge.stop();
  }
});

test("S2b：Last-Event-ID 命中 + 超上限时 truncated=true 且仍回放已保留部分", { timeout: 120000 }, async () => {
  // 尾巴缓冲上限压到 400B：第二波的 6 帧必然溢出，验证「截断但仍回放最新部分」
  const bridge = await startBridge("trunc", { PI_SHELL_TAIL_MAX_BYTES: "400" });
  try {
    const client = "sse-trunc";

    const c1 = await openSse({ port: bridge.port, client });
    await waitFrame(c1, (f) => f.payload?.type === "bridge_state", { label: "连接快照" });
    const prompted = await api(bridge.port, "/api/prompt", { method: "POST", client, body: { message: "hi" } });
    assert.equal(prompted.status, 200);
    const u2 = await waitFrame(c1, byText("u2"), { label: "u2" });
    c1.close();

    const cmds = await api(bridge.port, "/api/commands", { client });
    assert.equal(cmds.status, 200);

    // 不带 ?since=，只靠 EventSource 会带的 Last-Event-ID
    const c2 = await openSse({ port: bridge.port, client, lastEventId: u2.id });
    const resume = await waitFrame(c2, (f) => f.payload?.type === "resume", { label: "resume" });
    assert.equal(resume.payload.from, u2.id + 1, "Last-Event-ID 必须被当作 since");
    assert.equal(resume.payload.truncated, true, "超字节上限必须置 truncated");
    assert.ok(resume.payload.to > resume.payload.from, `回放窗口应有内容：${JSON.stringify(resume.payload)}`);
    await waitFrame(c2, byText("u8"), { label: "回放 u8" });

    const replayed = c2.frames.filter(
      (f) => f.payload?.type === "message_update" && f.id >= resume.payload.from && f.id <= resume.payload.to,
    );
    assert.ok(replayed.length > 0, "截断后仍要回放已保留部分（不整段丢弃）");
    assert.ok(replayed.length < 6, `6 帧应被截断，实际回放 ${replayed.length} 帧`);
    assert.equal(textOf(replayed[replayed.length - 1]), "u8", "保留的是最新部分（末端必须是 u8）");
    const ids = replayed.map((f) => f.id);
    assert.deepEqual(ids, ids.slice().sort((a, b) => a - b), "截断后仍是递增顺序");
    c2.close();
  } finally {
    await bridge.stop();
  }
});
