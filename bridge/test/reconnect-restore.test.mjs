// P0 重连恢复：引擎被回收后用同一 clientId 回来 → 必须恢复原会话（不是开新空会话）
//
// 事故：页面离开 → 引擎 idle-sweep → 回来重连 → claimEngine 按 INITIAL_CWD 起了空引擎，
// 页面还显示旧历史 → AI 对之前内容一无所知。修复：桥侧 lastSessionByClient（与引擎生命周期解耦）
// + claimEngine 用原会话 cwd 起引擎 + switch_session 恢复 + 广播 session_attached。
//
// 真桥 + 假 pi RPC CLI（不 spawn 真 pi、不碰真实会话目录、不占 7788），会话/日志全部夹具隔离。
// 矩阵：
//   1) 有历史（release 释放引擎）→ 重连恢复：cwd=会话 header cwd、sessionFile=原文件、日志 engine_restored
//   2) 无历史 → 现状不变（新引擎在 PI_SHELL_CWD，空会话，无恢复日志）
//   3) 原会话文件删掉后重连 → session_attach_failed NOT_FOUND + engine_restore_failed，引擎不崩
//   4) idle-sweep 回收（真实事故路径）→ 重连同样恢复
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

// 假 pi：switch_session 把运行时 cwd 换成会话 header 的 cwd（与真 pi 一致），
// new_session 沿用运行时 cwd 且不落盘（H-5），get_state 返回当前真相。
const FAKE_PI = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

let runtimeCwd = process.cwd();
let sessionFile = null;
let sessionId = "fake-boot";
let seq = 0;
let model = { provider: "fake", id: "fake-default", name: "Fake Default" };
let thinkingLevel = "off";

function headerOf(file) {
  try {
    const first = fs.readFileSync(file, "utf8").split("\\n")[0];
    const header = JSON.parse(first);
    return { cwd: typeof header.cwd === "string" ? header.cwd : null, id: header.id || null };
  } catch {
    return { cwd: null, id: null };
  }
}

function state() {
  return {
    sessionId,
    sessionFile,
    cwd: runtimeCwd,
    isStreaming: false,
    thinkingLevel,
    model,
  };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.id === "undefined") return;
  const reply = (data) => process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");
  switch (msg.type) {
    case "get_state":
      return reply(state());
    case "get_entries":
      return reply({ entries: [], leafId: null });
    case "switch_session": {
      const file = path.resolve(String(msg.sessionPath));
      const header = headerOf(file);
      if (header.cwd) runtimeCwd = header.cwd;
      sessionFile = file;
      sessionId = header.id || "fake-switched";
      return reply({ cancelled: false });
    }
    case "new_session":
      sessionFile = null;
      sessionId = "fake-session-" + ++seq;
      return reply({ cancelled: false });
    case "set_model":
      model = { provider: msg.provider, id: msg.modelId, name: msg.modelId };
      return reply(model);
    case "set_thinking_level":
      thinkingLevel = msg.level;
      return reply({});
    default:
      return reply({});
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { ms = 20000, step = 100 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last?.ok) return last;
    await sleep(step);
  }
  return last ?? { ok: false };
}

/** 夹具：假 agentDir（install 树 + 假 pi）+ 会话目录 + 项目目录 + 空 MCP 配置 + 独立日志 */
function buildFixture(tag) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pi-shell-reconnect-${tag}-`)));
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
  const project = path.join(root, "proj");
  const sessionsDir = path.join(root, "sessions");
  const sessionDir = path.join(sessionsDir, "--fixture-proj--");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionFile = path.join(sessionDir, "old-session.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "session", version: 3, id: "01a1aaaa-bbbb-cccc-dddd-eeeeeeeeeeee", timestamp: 1762300000000, cwd: project }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1762300001000, message: { role: "user", content: "旧会话" } }),
    ].join("\n") + "\n",
    "utf8",
  );

  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");
  const logFile = path.join(root, "logs", "bridge.log");

  return { root, agentDir, home, project, sessionsDir, sessionFile, mcpShellConfig, logFile };
}

async function startBridge(tag, env = {}) {
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
      PI_SHELL_LOG_FILE: fixture.logFile,
      PI_SHELL_CWD: fixture.home,
      PI_SHELL_MAX_ENGINES: "8",
      PI_SHELL_PI_BIN: "",
      ...env,
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
  };

  const readLog = () => (fs.existsSync(fixture.logFile) ? fs.readFileSync(fixture.logFile, "utf8") : "");

  const ready = await waitFor(async () => {
    try {
      const res = await api("/api/health", { client: "boot" });
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

  return { port, child, fixture, api, readLog, stop, stderr: () => stderrText };
}

const samePath = (a, b) =>
  typeof a === "string" && typeof b === "string" && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** 打开 fixture 会话并等到接管完成（engine.extra.cwd == header cwd） */
async function openFixtureSession(bridge, client) {
  const opened = await bridge.api("/api/session/open", { method: "POST", client, body: { path: bridge.fixture.sessionFile } });
  assert.equal(opened.status, 200, `open 应 200：${opened.text.slice(0, 300)}`);
  const synced = await waitFor(async () => {
    const { json } = await bridge.api("/api/health", { client });
    return { ok: samePath(json?.pi?.cwd, bridge.fixture.project), json };
  }, { ms: 30000 });
  assert.equal(synced.ok, true, `attach 后 health.pi.cwd 应追平会话 cwd，实际 ${synced.json?.pi?.cwd}`);
  return opened;
}

/** 等日志出现满足条件的行（恢复是后台异步：view 的 claim 占位会比恢复日志早） */
async function waitLogLine(bridge, predicate, { ms = 30000, label = "日志行" } = {}) {
  const hit = await waitFor(async () => {
    const lines = bridge.readLog().split("\n");
    const line = lines.find(predicate);
    return { ok: Boolean(line), line };
  }, { ms });
  assert.ok(hit.line, `超时未等到${label}`);
  return hit.line;
}

/** 连 SSE（重连路径）；返回 frames + close（读取在后台持续进行） */
async function openSse(bridge, client) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${bridge.port}/api/events?client=${encodeURIComponent(client)}`, {
    headers: { accept: "text/event-stream" },
    signal: ac.signal,
  });
  assert.equal(res.status, 200, "SSE 应 200");
  const frames = [];
  const handle = { frames, close: () => ac.abort() };
  handle.done = (async () => {
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
          let data = null;
          for (const line of block.split("\n")) {
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (data === null) continue;
          try {
            frames.push(JSON.parse(data));
          } catch {}
        }
      }
    } catch {
      /* 主动 abort / 桥关闭：正常退出 */
    }
  })();
  return handle;
}

async function waitSseFrame(handle, predicate, { ms = 30000, label = "帧" } = {}) {
  const hit = await waitFor(async () => {
    const frame = handle.frames.find(predicate);
    return { ok: Boolean(frame), frame };
  }, { ms });
  assert.ok(hit.frame, `超时未收到${label}；已收到 ${handle.frames.map((f) => f.type).join(",")}`);
  return hit.frame;
}

async function releaseEngine(bridge, client) {
  const released = await bridge.api("/api/engine/release", { method: "POST", client, body: { client } });
  assert.equal(released.status, 200, `release 应 200：${released.text.slice(0, 200)}`);
  assert.equal(released.json?.released, true, "应真的释放了一条引擎");
  const empty = await waitFor(async () => {
    const { json } = await bridge.api("/api/health", { client });
    return { ok: (json?.engineCount ?? -1) === 0, json };
  }, { ms: 15000 });
  assert.equal(empty.ok, true, `释放后引擎数应为 0，实际 ${empty.json?.engineCount}`);
}

test("1) 有历史 → 重连后恢复原会话（cwd / sessionFile / engine_restored）", { timeout: 120000 }, async () => {
  const bridge = await startBridge("history");
  try {
    const client = "reconnect-history";
    await openFixtureSession(bridge, client);
    await releaseEngine(bridge, client);

    // 重连（同一 clientId，走 SSE）：claim 必须用原会话 cwd 起引擎并 switch_session 回来
    const sse = await openSse(bridge, client);
    try {
      const attached = await waitSseFrame(sse, (f) => f.type === "session_attached" && f.restored === true, {
        label: "session_attached(restored)",
      });
      assert.equal(
        samePath(attached.sessionFile, bridge.fixture.sessionFile),
        true,
        `session_attached 应指向原会话，实际 ${attached.sessionFile}`,
      );

      const restoredLine = await waitLogLine(bridge, (l) => l.includes("|engine_restored|"), { label: "engine_restored" });
      assert.match(
        restoredLine,
        new RegExp(`client=${client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        "engine_restored 必须带 client",
      );
    } finally {
      sse.close();
    }

    const restored = await waitFor(async () => {
      const { status, json } = await bridge.api("/api/session/view", { client });
      return { ok: status === 200 && samePath(json?.sessionFile, bridge.fixture.sessionFile), status, json };
    }, { ms: 30000 });
    assert.equal(restored.ok, true, `session/view 应回到原文件，实际 ${restored.json?.sessionFile}`);
    assert.equal(samePath(restored.json?.cwd, bridge.fixture.project), true, `view.cwd 应是会话 cwd，实际 ${restored.json?.cwd}`);

    const health = await bridge.api("/api/health", { client });
    assert.equal(samePath(health.json?.pi?.cwd, bridge.fixture.project), true, `health.pi.cwd 应是会话 cwd，实际 ${health.json?.pi?.cwd}`);
    assert.equal(health.json?.pi?.state, "idle", "恢复后引擎应 idle（可发送）");

    const logText = bridge.readLog();
    assert.match(logText, /\|engine_restored\|/, "日志必须出现 engine_restored");
    assert.match(logText, /\|engine_created\|.*restore=/, "engine_created 应记录 restore=<会话文件>");
  } finally {
    await bridge.stop();
  }
});

test("2) 无历史 → 现状不变（新引擎在 PI_SHELL_CWD，空会话，无恢复）", { timeout: 120000 }, async () => {
  const bridge = await startBridge("nohistory");
  try {
    const client = "reconnect-none";
    const claimed = await bridge.api("/api/engine/claim", { method: "POST", client, body: { client } });
    assert.equal(claimed.status, 200, `claim 应 200：${claimed.text.slice(0, 300)}`);

    const idled = await waitFor(async () => {
      const { json } = await bridge.api("/api/health", { client });
      return { ok: json?.pi?.state === "idle", json };
    }, { ms: 30000 });
    assert.equal(idled.ok, true, "无历史的新引擎也应 idle");
    assert.equal(samePath(idled.json?.pi?.cwd, bridge.fixture.home), true, `无历史时应留在 PI_SHELL_CWD，实际 ${idled.json?.pi?.cwd}`);

    const view = await bridge.api("/api/session/view", { client });
    assert.equal(view.status, 200, `view 应 200：${view.text.slice(0, 200)}`);
    assert.equal(view.json?.sessionFile ?? null, null, "无历史应保持空会话（sessionFile=null）");
    assert.doesNotMatch(bridge.readLog(), /\|engine_restored\|/, "无历史不应出现 engine_restored");
  } finally {
    await bridge.stop();
  }
});

test("3) 原会话文件已删除 → NOT_FOUND 明确失败，引擎不崩、不静默", { timeout: 120000 }, async () => {
  const bridge = await startBridge("notfound");
  try {
    const client = "reconnect-gone";
    await openFixtureSession(bridge, client);
    await releaseEngine(bridge, client);
    await fsp.rm(bridge.fixture.sessionFile, { force: true });

    // 重连（同一 clientId，走 SSE）→ 后台恢复发现文件已删 → 必须广播 session_attach_failed{NOT_FOUND}
    const sse = await openSse(bridge, client);
    try {
      const failedFrame = await waitSseFrame(sse, (f) => f.type === "session_attach_failed", { label: "session_attach_failed" });
      assert.equal(failedFrame.code, "NOT_FOUND", `失败码应为 NOT_FOUND：${JSON.stringify(failedFrame)}`);
      assert.equal(samePath(failedFrame.sessionFile, bridge.fixture.sessionFile), true, "失败帧应带原会话文件");
    } finally {
      sse.close();
    }

    const failed = await waitFor(async () => {
      const logText = bridge.readLog();
      const line = logText.split("\n").find((l) => l.includes("|engine_restore_failed|"));
      return { ok: Boolean(line), line };
    }, { ms: 30000 });
    assert.ok(failed.ok, "日志必须出现 engine_restore_failed（不得静默）");
    assert.match(failed.line, /code=NOT_FOUND/, `失败码应为 NOT_FOUND：${failed.line}`);
    assert.match(failed.line, new RegExp(`client=${client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "失败日志必须带 client");

    // 引擎仍然活着（空会话可继续用），不是崩溃
    const health = await waitFor(async () => {
      const { json } = await bridge.api("/api/health", { client });
      return { ok: json?.pi?.state === "idle", json };
    }, { ms: 20000 });
    assert.equal(health.ok, true, `失败后引擎应 idle，实际 ${health.json?.pi?.state}`);
    const view = await bridge.api("/api/session/view", { client });
    assert.equal(view.status, 200, "失败后 view 仍应可用");
    assert.equal(view.json?.sessionFile ?? null, null, "失败后应保持空会话");
  } finally {
    await bridge.stop();
  }
});

test("4) idle-sweep 回收（真实事故路径）→ 重连同样恢复", { timeout: 180000 }, async () => {
  // 引擎回收靠 5s 一轮的 sweep；idleMs 调到 300ms，几秒就能复现事故
  const bridge = await startBridge("sweep", { PI_SHELL_IDLE_MS: "300" });
  try {
    const client = "reconnect-swept";
    await openFixtureSession(bridge, client);

    const swept = await waitFor(async () => {
      const { json } = await bridge.api("/api/health", { client });
      return { ok: (json?.engineCount ?? -1) === 0, json };
    }, { ms: 30000, step: 300 });
    assert.equal(swept.ok, true, `引擎应被空闲回收，实际 engineCount=${swept.json?.engineCount}`);
    assert.match(bridge.readLog(), /\|engine_swept\|/, "日志应出现 engine_swept");

    // 同一个 clientId 重连
    const claimed = await bridge.api("/api/engine/claim", { method: "POST", client, body: { client } });
    assert.equal(claimed.status, 200, `重连 claim 应 200：${claimed.text.slice(0, 300)}`);

    await waitLogLine(bridge, (l) => l.includes("|engine_restored|"), { label: "engine_restored" });
    const restored = await waitFor(async () => {
      const { status, json } = await bridge.api("/api/session/view", { client });
      return { ok: status === 200 && samePath(json?.sessionFile, bridge.fixture.sessionFile), json };
    }, { ms: 30000 });
    assert.equal(restored.ok, true, `sweep 后重连应恢复原会话，实际 ${restored.json?.sessionFile}`);
    const health = await bridge.api("/api/health", { client });
    assert.equal(samePath(health.json?.pi?.cwd, bridge.fixture.project), true, `恢复后 cwd 应是会话 cwd，实际 ${health.json?.pi?.cwd}`);
    assert.match(bridge.readLog(), /\|engine_restored\|/, "日志必须出现 engine_restored");
  } finally {
    await bridge.stop();
  }
});
test("5) 不回归 409：引擎被回收期间别的列打开了同一会话 → 重连不抢（CONFLICT）", { timeout: 120000 }, async () => {
  const bridge = await startBridge("conflict");
  try {
    const a = "reconnect-owner-a";
    const b = "reconnect-owner-b";
    await openFixtureSession(bridge, a);
    await releaseEngine(bridge, a);

    // A 的引擎没了 → B 可以（合法地）打开同一会话
    const openedB = await bridge.api("/api/session/open", { method: "POST", client: b, body: { path: bridge.fixture.sessionFile } });
    assert.equal(openedB.status, 200, `B 打开会话应 200：${openedB.text.slice(0, 300)}`);
    const attachedB = await waitFor(async () => {
      const { json } = await bridge.api("/api/health", { client: b });
      return { ok: samePath(json?.pi?.cwd, bridge.fixture.project), json };
    }, { ms: 30000 });
    assert.equal(attachedB.ok, true, "B 应已接管该会话");

    // A 重连 → 恢复必须让位（同会话双开不因恢复而放宽）
    const claimedA = await bridge.api("/api/engine/claim", { method: "POST", client: a, body: { client: a } });
    assert.equal(claimedA.status, 200, `A 重连 claim 应 200：${claimedA.text.slice(0, 300)}`);

    const conflictLine = await waitLogLine(
      bridge,
      (l) => l.includes("|engine_restore_failed|") && l.includes("code=CONFLICT"),
      { label: "engine_restore_failed code=CONFLICT" },
    );
    assert.match(conflictLine, /reason=/, "失败必须带原因");

    // B 仍持着该会话（没被抢走）
    const viewB = await bridge.api("/api/session/view", { client: b });
    assert.equal(samePath(viewB.json?.sessionFile, bridge.fixture.sessionFile), true, "B 仍应持着该会话");
  } finally {
    await bridge.stop();
  }
});
