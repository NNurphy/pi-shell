// S3b（bg-continue）：POST /api/session/open 的「孤儿接管」分支（设计 §5.3）
//
// 为什么要起真桥：接管判定在 handleSessionOpen 里（index.mjs 不导出函数），只有走 HTTP 才能验到
// 「409 语义不变 / adopted:true / 引擎数不增 / 旧 pid 不残留 / 广播 bridge_state」这套行为。
// 假 pi RPC CLI（不 spawn 真 pi、不碰真实会话目录、不占 7788），端口用完即关。
//
// 矩阵：
//   1) 静默 < graceMs → 409（刚断开可能自己重连，不抢）
//   2) 目标引擎有 SSE → 409（I1：有活跃标签页占用同一会话不因接管而放宽）
//   3) 无 SSE + 静默 ≥ graceMs + 同会话 → 200 adopted:true；引擎数不增；owner 改名到本 client；
//      被接管的还是原来那条 pi（pid 不变）；本 client 旧引擎的 pid 不残留；接管后广播 bridge_state
//   4) 会话不同 → 不接管（普通打开，引擎归属不变）
//   5) 本 client 自己引擎正在 streaming → 409（不抢自己的活）
// 注：503 只来自「并行上限」这条既存路径（needsEngine → pool.capacityError），本切片没动它，
//     由 engines.test.mjs 的上限用例覆盖，这里不重复。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ENTRY = path.resolve(HERE, "..", "src", "index.mjs");
// 接管门槛调小，测试才不用真等 30s（默认值不变，见 index.mjs 的 ADOPT_GRACE_MS）
const GRACE_MS = 1500;

// 假 pi：只在收到命令时动状态；prompt 之后永远停在 streaming（= 后台还在跑的那一轮）
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
      out({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "still-running" }] } });
      return;
    case "abort":
      streaming = false;
      return reply(msg, { cancelled: true });
    default:
      return reply(msg, {});
  }
});
`;

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function freePort() {
  for (let i = 0; i < 50; i += 1) {
    const port = 7930 + i;
    if (await portFree(port)) return port;
  }
  throw new Error("找不到空闲端口（7930-7979）");
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

function buildFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-adopt-")));
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
  const dirA = path.join(root, "project-a");
  const dirB = path.join(root, "project-b");
  const sessionsDir = path.join(root, "sessions");
  for (const dir of [home, dirA, dirB, sessionsDir]) fs.mkdirSync(dir, { recursive: true });
  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");

  // 三条夹具会话（readSessionCwd 需要 header.cwd 指向真实目录）
  const rows = (id, cwd) => [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: cwd.replace(/\\/g, "/") },
    { type: "message", id: `${id}-u`, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "fixture" }] } },
  ];
  const files = {
    s1: path.join(sessionsDir, "s1.jsonl"),
    s2: path.join(sessionsDir, "s2.jsonl"),
    s3: path.join(sessionsDir, "s3.jsonl"),
  };
  fs.writeFileSync(files.s1, `${rows("s1", dirA).map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  fs.writeFileSync(files.s2, `${rows("s2", dirB).map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  fs.writeFileSync(files.s3, `${rows("s3", dirA).map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  return { root, agentDir, home, sessionsDir, mcpShellConfig, files };
}

test("S3b：/api/session/open 孤儿接管（409 语义不变 + adopted:true + 引擎数不增）", { timeout: 120000 }, async (t) => {
  const fixture = buildFixture();
  const PORT = await freePort();
  let child = null;
  let stderrText = "";

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
  const engineOf = (h, client) => (h?.engines ?? []).find((e) => e.client === client) ?? null;

  /** 连一条 SSE 并收集帧（用于「目标引擎有 SSE → 409」与「接管后广播 bridge_state」） */
  const openSse = async (client) => {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
      headers: { accept: "text/event-stream", "x-pi-shell-client": client },
      signal: ac.signal,
    });
    assert.equal(res.status, 200, "SSE 应 200");
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
            for (const line of block.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                frames.push(JSON.parse(line.slice(5).trim()));
              } catch {}
            }
          }
        }
      } catch {
        /* 主动断开：正常退出 */
      }
    })();
    return handle;
  };

  try {
    child = spawn(process.execPath, [BRIDGE_ENTRY], {
      cwd: fixture.root,
      env: {
        ...process.env,
        PI_SHELL_PORT: String(PORT),
        PI_SHELL_AGENT_DIR: fixture.agentDir,
        PI_SHELL_SESSIONS_DIR: fixture.sessionsDir,
        PI_SHELL_AGENT_SESSIONS_DIR: "",
        PI_SHELL_MCP_CONFIG: fixture.mcpShellConfig,
        PI_SHELL_ORIGINS_FILE: path.join(fixture.root, "sessions-origins.json"),
        PI_SHELL_LOG_DIR: path.join(fixture.root, "logs"),
        PI_SHELL_LOG_FILE: path.join(fixture.root, "logs", "bridge.log"),
        PI_SHELL_TURN_SNAPSHOTS: path.join(fixture.root, "turn-snapshots"),
        PI_SHELL_CWD: fixture.home,
        PI_SHELL_MAX_ENGINES: "8",
        PI_SHELL_IDLE_MS: "600000", // 本用例只验接管；别让空闲回收中途收走引擎
        PI_SHELL_ADOPT_GRACE_MS: String(GRACE_MS),
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
        const body = await health();
        return { ok: body?.ok === true };
      } catch {
        return { ok: false };
      }
    }, { ms: 30000 });
    assert.ok(ready.ok, `桥未就绪${stderrText ? `：${stderrText.slice(0, 500)}` : ""}`);

    // ── 造孤儿：tab-a 打开 s1（认领引导引擎）→ prompt 进入 streaming → 之后不再有任何请求
    const opened = await api("/api/session/open", { method: "POST", client: "tab-a", body: { path: fixture.files.s1 } });
    assert.equal(opened.status, 200, `open 应 200：${opened.text.slice(0, 200)}`);

    const attached = await waitFor(async () => {
      const h = await health();
      const e = engineOf(h, "tab-a");
      return { ok: !!e && e.sessionFile === fixture.files.s1, engine: e };
    }, { ms: 15000 });
    assert.ok(attached.ok, "tab-a 应先附着到 s1");
    const orphanPid = attached.engine.pid;
    assert.ok(orphanPid, "tab-a 引擎应有 pid");

    const prompted = await api("/api/prompt", { method: "POST", client: "tab-a", body: { message: "long task" } });
    assert.equal(prompted.status, 200, `prompt 应 200：${prompted.text.slice(0, 200)}`);
    const streaming = await waitFor(async () => {
      const h = await health();
      return { ok: engineOf(h, "tab-a")?.state === "streaming", state: engineOf(h, "tab-a")?.state };
    }, { ms: 10000 });
    assert.ok(streaming.ok, `tab-a 应进入 streaming（实际 ${streaming.state}）`);

    // ── 1) 静默还没到 graceMs → 409（刚断开可能自己重连，不抢）
    const early = await api("/api/session/open", { method: "POST", client: "tab-w", body: { path: fixture.files.s1 } });
    assert.equal(early.status, 409, `未到 grace 应 409，实际 ${early.status}：${early.text.slice(0, 200)}`);
    assert.equal(early.json?.adopted, undefined, "409 不带 adopted");
    {
      const h = await health();
      assert.equal(engineOf(h, "tab-a")?.pid, orphanPid, "未到 grace 时孤儿引擎不能被动");
    }

    // ── 2) 目标引擎有 SSE → 409（I1：有活跃标签页占用同一会话，不因接管而放宽）
    const sseA = await openSse("tab-a");
    try {
      await waitFor(async () => ({ ok: sseA.frames.some((f) => f.type === "bridge_state") }), { ms: 10000 });
      const withSse = await api("/api/session/open", { method: "POST", client: "tab-x", body: { path: fixture.files.s1 } });
      assert.equal(withSse.status, 409, `目标有 SSE 应 409，实际 ${withSse.status}：${withSse.text.slice(0, 200)}`);
      const h = await health();
      assert.equal(engineOf(h, "tab-a")?.pid, orphanPid, "有 SSE 时孤儿引擎不能被接管");
    } finally {
      sseA.close();
      await sseA.closed;
    }

    // ── 3) 无 SSE + 静默 ≥ graceMs + 同会话 → 200 adopted:true
    await sleep(GRACE_MS + 400);
    const before = await health();
    const tabWBefore = engineOf(before, "tab-w");
    assert.ok(tabWBefore, "tab-w 应有自己的空闲引擎（前一步 409 时建的）");

    const adopted = await api("/api/session/open", { method: "POST", client: "tab-w", body: { path: fixture.files.s1 } });
    assert.equal(adopted.status, 200, `可接管应 200，实际 ${adopted.status}：${adopted.text.slice(0, 300)}`);
    assert.equal(adopted.json?.adopted, true, "必须回 adopted:true");
    assert.equal(adopted.json?.mode, "live", "接管的引擎已经是活的，应回 live");
    assert.equal(adopted.json?.attach, "attached");
    assert.equal(adopted.json?.sessionFile, fixture.files.s1);
    assert.ok(Array.isArray(adopted.json?.entries) && adopted.json.entries.length > 0, "应带回该引擎的 entries");

    const after = await health();
    // 「不增」的严格形式：本 client 的旧空闲引擎被 release（先 release 再 own），所以少 1 条而不是变多
    assert.equal(after.engineCount, before.engineCount - 1, `引擎数应减 1（before=${before.engineCount} after=${after.engineCount}）`);
    assert.equal(after.engines.filter((e) => e.client === "tab-w").length, 1, "tab-w 只能有一条引擎记录");
    assert.equal(engineOf(after, "tab-a"), null, "接管后不能残留 tab-a 记录");
    assert.equal(engineOf(after, "tab-w")?.pid, orphanPid, "接管到的必须是原来那条 pi（pid 不变）");
    assert.equal(engineOf(after, "tab-w")?.sessionFile, fixture.files.s1, "sessionFile 不变");
    assert.equal(after.engines.some((e) => e.pid === tabWBefore.pid), false, "本 client 旧引擎的 pid 不能残留（先 release 再 own，F25 不静默丢进程）");

    // 接管后广播了 bridge_state：尾巴缓冲里应有 engine=tab-w 的 streaming 快照（owner 已改名）
    const sseW = await openSse("tab-w");
    try {
      const seen = await waitFor(async () => {
        const hit = sseW.frames.find((f) => f.type === "bridge_state" && f.engine === "tab-w" && f.to === "streaming");
        return { ok: !!hit, hit };
      }, { ms: 10000 });
      assert.ok(seen.ok, `接管后应广播 bridge_state（engine=tab-w/streaming）；收到：${sseW.frames.map((f) => `${f.type}:${f.engine}`).join(",")}`);
    } finally {
      sseW.close();
      await sseW.closed;
    }

    // ── 4) 会话不同 → 不接管（普通打开，引擎归属不变）
    const other = await api("/api/session/open", { method: "POST", client: "tab-x", body: { path: fixture.files.s2 } });
    assert.equal(other.status, 200, `打另一个会话应 200，实际 ${other.status}：${other.text.slice(0, 200)}`);
    assert.notEqual(other.json?.adopted, true, "不同会话不接管");
    {
      const h = await health();
      assert.equal(engineOf(h, "tab-w")?.pid, orphanPid, "跨会话不得动别人的引擎");
    }

    // ── 5) 本 client 自己引擎正在 streaming → 409（不抢自己的活）
    const busy = await api("/api/prompt", { method: "POST", client: "tab-x", body: { message: "my own turn" } });
    assert.equal(busy.status, 200, `tab-x prompt 应 200：${busy.text.slice(0, 200)}`);
    await waitFor(async () => ({ ok: engineOf(await health(), "tab-x")?.state === "streaming" }), { ms: 10000 });
    await sleep(GRACE_MS + 400); // 让 tab-w 那条引擎重新满足「静默 ≥ grace」（上一步 SSE 触碰过）
    const beforeBusy = await health();
    const blocked = await api("/api/session/open", { method: "POST", client: "tab-x", body: { path: fixture.files.s1 } });
    assert.equal(blocked.status, 409, `自己引擎忙应 409，实际 ${blocked.status}：${blocked.text.slice(0, 200)}`);
    {
      const h = await health();
      assert.equal(h.engineCount, beforeBusy.engineCount, "被拒时引擎数不变");
      assert.equal(engineOf(h, "tab-w")?.pid, orphanPid, "被拒时不得动孤儿引擎");
    }

    // 日志里要有接管与冲突两条可审计记录（不静默）
    const logText = await fsp.readFile(path.join(fixture.root, "logs", "bridge.log"), "utf8");
    assert.ok(/engine_adopted/.test(logText), "必须记 engine_adopted");
    assert.ok(/session_open_conflict/.test(logText), "必须记 session_open_conflict");
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
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
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});
