#!/usr/bin/env node
// S2b 证据：SSE 尾巴回放（断线重连补齐未落盘的输出，不重复、不乱序）
//
// 做法：起真实桥 + 假 pi RPC CLI（不 spawn 真 pi、不碰真实会话目录），独立端口 7831。
// 假 pi 的事件由命令触发，保证确定性：
//   prompt       → 回复 + agent_start + message_start + u1/u2
//   get_commands → 回复 + u3..u8（客户端此时已断开 → 只能靠尾巴缓冲）
//   get_state    → 回复 + message_end + agent_settled（落盘点）
//
// 覆盖：
//   1) 每个数据帧带 `id: <seq>`；首个数据帧是 resume（含 from/to/truncated）
//   2) 连上 → 断开 → 带 ?since= 重连：回放的 seq 与「断线期间产生」的 seq 集合完全相等（不重不漏）
//   3) 回放 seq 严格递增；resume 窗口 [from,to] 与实际回放帧一致
//   4) message_end 后缓冲归零：?since=0 再连，from = baseSeq+1，已落盘内容不重放
//
// 收尾：按 PID 关自己起的桥（不按命令行批量杀），夹具目录整个删掉。
// 用法：node scripts/evidence/sse-tail-api.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, "..", "..");
const BRIDGE_ENTRY = path.join(BRIDGE_ROOT, "bridge", "src", "index.mjs");
// 端口可被门禁顺延：PI_SHELL_PORT（默认 7831）
const PORT = Number(process.env.PI_SHELL_PORT || 7831);

const FAKE_PI = `"use strict";
const readline = require("node:readline");

const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const reply = (msg, data) =>
  process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");
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
        sessionId: "fake-sse-tail-0",
        sessionFile: null,
        cwd: process.cwd(),
        isStreaming: false,
        thinkingLevel: "off",
        model: { provider: "fake", id: "fake-1", name: "Fake" },
      });
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
      for (const text of ["u3", "u4", "u5", "u6", "u7", "u8"]) delta(text);
      return;
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-sse-tail-")));
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

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function api(pathname, { method = "GET", client = null, body } = {}) {
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

/** 解析一块 `id:`/`data:` 文本；注释行（: connected / : ping）与 retry 返回 null */
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

async function openSse({ client, since }) {
  const ac = new AbortController();
  const headers = { accept: "text/event-stream" };
  if (client) headers["x-pi-shell-client"] = client;
  const qs = since === undefined ? "" : `?since=${encodeURIComponent(String(since))}`;
  const res = await fetch(`http://127.0.0.1:${PORT}/api/events${qs}`, { headers, signal: ac.signal });
  if (res.status !== 200) throw new Error(`SSE 应 200，实际 ${res.status}`);
  const frames = [];
  const handle = { frames, close: () => ac.abort() };
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
      /* 主动断开：正常退出 */
    }
  })();
  return handle;
}

function waitFrame(handle, predicate, label) {
  return waitFor(async () => {
    const hit = handle.frames.find(predicate);
    return { ok: Boolean(hit), frame: hit };
  }, { ms: 15000 }).then((r) => {
    if (!r.frame) throw new Error(`超时未收到${label}（已收到：${handle.frames.map((f) => f.payload?.type).join(",")}）`);
    return r.frame;
  });
}

const textOf = (frame) => frame?.payload?.message?.content?.[0]?.text ?? null;
const byText = (text) => (f) => f.payload?.type === "message_update" && textOf(f) === text;
const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

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
      PI_SHELL_CWD: fixture.home,
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_IDLE_MS: "600000", // 用例里会主动断线，别让空闲回收收走引擎
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

  const ready = await waitFor(async () => {
    try {
      const body = (await api("/api/health", { client: "evidence-boot" })).json;
      return { ok: body?.pi?.state === "idle", state: body?.pi?.state };
    } catch {
      return { ok: false, state: "unreachable" };
    }
  }, { ms: 30000 });
  if (!ready.ok) throw new Error(`桥未就绪（state=${ready.state}; stderr: ${stderrText.slice(0, 500)}）`);
  console.log(`fixture=${tmpRoot}`);
  console.log(`bridge=http://127.0.0.1:${PORT}`);

  const client = "evidence-sse-tail";

  // 1) 连上：resume 在最前，数据帧都带 id
  const c1 = await openSse({ client });
  const snapshot = await waitFrame(c1, (f) => f.payload?.type === "bridge_state", "连接快照");
  const first = c1.frames[0];
  check("首个数据帧是 resume（在所有数据帧之前）", first?.payload?.type === "resume", `type=${first?.payload?.type}`);
  check(
    "resume 帧含 {from,to,truncated}",
    first && ["from", "to", "truncated"].every((k) => k in first.payload),
    JSON.stringify(first?.payload),
  );
  check(
    "数据帧都带 id: <seq>（resume 控制帧除外）",
    c1.frames.filter((f) => f.payload?.type !== "resume").every((f) => Number.isFinite(f.id)),
    `snapshot id=${snapshot.id} 帧数=${c1.frames.length}`,
  );

  // 2) 第一波：prompt → u1/u2
  const prompt = await api("/api/prompt", { method: "POST", client, body: { message: "hi" } });
  if (prompt.status !== 200) throw new Error(`prompt 应 200，实际 ${prompt.status}：${prompt.text.slice(0, 200)}`);
  const u2 = await waitFrame(c1, byText("u2"), "u2");
  const lastSeen = u2.id;
  check("流式帧 seq 单调递增（快照 < u1 < u2）", lastSeen > snapshot.id, `snapshot=${snapshot.id} lastSeen=${lastSeen}`);

  // 3) 断开（模拟切走/锁屏），断线期间产生 u3..u8
  c1.close();
  const cmds = await api("/api/commands", { client });
  if (cmds.status !== 200) throw new Error(`/api/commands 应 200，实际 ${cmds.status}`);
  await sleep(200); // 给广播一点落缓冲的时间（同一事件循环内，非时序判据）

  // 4) 带 ?since= 重连：回放窗口与断线期间的帧集合一致（不重不漏）
  const c2 = await openSse({ client, since: lastSeen });
  const resume = await waitFrame(c2, (f) => f.payload?.type === "resume", "resume(2)");
  await waitFrame(c2, byText("u8"), "回放 u8");
  const replayed = c2.frames.filter(
    (f) => f.id !== null && f.id >= resume.payload.from && f.id <= resume.payload.to && f.payload?.type !== "resume",
  );
  const replayedSeqs = replayed.map((f) => f.id);
  const seenBefore = c1.frames.filter((f) => f.id !== null).map((f) => f.id);
  const union = [...new Set([...seenBefore, ...replayedSeqs])];

  check(
    "回放起点 = since + 1",
    resume.payload.from === lastSeen + 1,
    `since=${lastSeen} from=${resume.payload.from}`,
  );
  check(
    "回放 seq 连续（集合比较：既无空洞也无重复）",
    JSON.stringify(replayedSeqs) === JSON.stringify(range(resume.payload.from, resume.payload.to)),
    `from=${resume.payload.from} to=${resume.payload.to} frames=${replayedSeqs.join(",")}`,
  );
  check(
    "断线输出的 6 帧全部补齐（u3…u8）",
    JSON.stringify(replayed.filter((f) => f.payload?.type === "message_update").map(textOf)) ===
      JSON.stringify(["u3", "u4", "u5", "u6", "u7", "u8"]),
    replayed.filter((f) => f.payload?.type === "message_update").map(textOf).join(","),
  );
  check(
    "两次连接合起来无重复（seq 唯一）",
    overlapping(seenBefore, replayedSeqs) === 0 && new Set(replayedSeqs).size === replayedSeqs.length,
    `before=${seenBefore.length} replayed=${replayedSeqs.length} 重叠=${overlapping(seenBefore, replayedSeqs)}`,
  );

  // 5) 落盘点：message_end 之后缓冲归零，?since=0 也只回放 baseSeq 之后
  const modeled = await api("/api/model", { method: "POST", client, body: { provider: "fake", modelId: "fake-1" } });
  if (modeled.status !== 200) throw new Error(`set_model 应 200，实际 ${modeled.status}：${modeled.text.slice(0, 200)}`);
  const ended = await waitFrame(c2, (f) => f.payload?.type === "message_end", "message_end");

  const c3 = await openSse({ client, since: 0 });
  const resume3 = await waitFrame(c3, (f) => f.payload?.type === "resume", "resume(3)");
  check(
    "message_end 是落盘点：?since=0 的 from = 该帧 seq + 1",
    resume3.payload.from === ended.id + 1,
    `message_end seq=${ended.id} from=${resume3.payload.from}`,
  );
  await sleep(200);
  check(
    "已落盘内容不重放（无 message_update / message_start）",
    !c3.frames.some((f) => ["message_update", "message_start", "message"].includes(f.payload?.type)),
    c3.frames.map((f) => f.payload?.type).join(","),
  );
  c3.close();
  c2.close();

  return results.every((r) => r.ok);
}

function overlapping(a, b) {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x)).length;
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
        const { spawnSync } = await import("node:child_process");
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {}
    }
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}
process.exit(exitCode);
