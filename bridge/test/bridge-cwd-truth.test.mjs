// T2 端到端单测：会话 cwd 真相回写（attach / new / restart）+ /api/health.pi.cwd 一致性
//
// 做法：起一个**真实桥**（bridge/src/index.mjs），但 pi 子进程换成夹具里的假 RPC CLI
// （临时 agentDir 的 install 树 + package.json bin 指过去），会话目录 / 日志 / MCP 配置全部夹具隔离。
// 不 spawn 真 pi、不碰真实会话目录（PI_SHELL_SESSIONS_DIR）、端口动态分配（不占 7788）。
//
// 覆盖：
//   1) 打开旧会话后 engine.extra.cwd 回写 → health.pi.cwd == 会话 header 的 cwd（修 F7 脱钩）
//   2) 新建会话保持运行时 cwd（F3/F5）且响应带 cwd
//   3) MCP 重启恢复会话后 cwd 仍是会话 header 的 cwd（不回到引擎创建时的旧值）
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

// 假 pi：只实现桥用到的 RPC 命令（get_state / get_entries / switch_session / new_session）。
// 关键语义与真 pi 一致：
//   - switch_session 把运行时 cwd 换成会话 header 的 cwd（pi:dist/core/agent-session-runtime.js）
//   - new_session 不接受 cwd，沿用当前运行时 cwd（同上）
//   - 新会话没有 .jsonl（H-5：出现消息才落盘）→ sessionFile = null
const FAKE_PI = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

let runtimeCwd = process.cwd();
let sessionFile = null;
let sessionId = "fake-session-0";
let seq = 0;

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
    thinkingLevel: "off",
    model: { provider: "fake", id: "fake-1", name: "Fake" },
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
      if (header.cwd) runtimeCwd = header.cwd; // 真 pi：运行时 cwd = header cwd
      sessionFile = file;
      sessionId = header.id || "fake-session-switched";
      return reply({ cancelled: false });
    }
    case "new_session":
      sessionFile = null;
      sessionId = "fake-session-" + ++seq;
      return reply({ cancelled: false }); // cwd 不变（运行时 cwd）
    default:
      return reply({});
  }
});
`;

let tmpRoot = "";
let paths = null;
let port = 0;
let child = null;
let stderrText = "";

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

/** 造夹具：假 agentDir（install 树 + mcp.json）+ 会话目录 + 项目目录 + 空 MCP 配置 */
function buildFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-cwd-truth-")));
  const agentDir = path.join(root, "agent");
  const pkgDir = path.join(agentDir, "install", "releases", "1.5.0", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "install", "current-version"), "1.5.0\n", "utf8");
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "pi-coding-agent", version: "1.5.0", bin: { pi: "cli.js" } }, null, 2), "utf8");
  fs.writeFileSync(path.join(pkgDir, "cli.js"), FAKE_PI, "utf8");
  // MCP：只有「可选名单」里有一个假 server（restart 用例要换名单才会真的重启子进程）
  fs.writeFileSync(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { fakesrv: { command: process.execPath, args: ["-e", ""] } } }, null, 2),
    "utf8",
  );

  const home = path.join(root, "home");
  const project = path.join(root, "proj");
  const altProject = path.join(root, "proj-alt");
  const notDir = path.join(root, "not-a-dir.txt");
  const sessionsDir = path.join(root, "sessions");
  const sessionDir = path.join(sessionsDir, "--fixture-proj--");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(altProject, { recursive: true });
  fs.writeFileSync(notDir, "x", "utf8");
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionFile = path.join(sessionDir, "old-session.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "01a1aaaa-bbbb-cccc-dddd-eeeeeeeeeeee", timestamp: 1762300000000, cwd: project }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1762300001000, message: { role: "user", content: "旧会话" } }),
  ];
  fs.writeFileSync(sessionFile, lines.join("\n") + "\n", "utf8");

  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  // 规则只挂在 altProject：new {cwd: altProject} 必须按新 cwd 重算名单（不能沿用旧名单）
  fs.writeFileSync(
    mcpShellConfig,
    JSON.stringify({ default: [], rules: [{ cwd: altProject, servers: ["fakesrv"] }] }, null, 2),
    "utf8",
  );

  return { root, agentDir, home, project, altProject, notDir, sessionsDir, sessionFile, mcpShellConfig };
}

async function api(pathname, { method = "GET", client = null, body } = {}) {
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

async function waitFor(fn, { ms = 20000, step = 100 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last?.ok) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last ?? { ok: false };
}

async function health(client) {
  const { status, json } = await api("/api/health", { client });
  assert.equal(status, 200, "health 应 200");
  return json;
}

/** 健康检查里的 pi.cwd 追平期望值（接管是后台异步的，轮询到稳定） */
async function waitHealthCwd(client, expected) {
  const hit = await waitFor(async () => {
    const body = await health(client);
    const cwd = body?.pi?.cwd ?? null;
    return { ok: cwd === expected, cwd, state: body?.pi?.state };
  });
  return hit;
}

test.before(async () => {
  paths = buildFixture();
  tmpRoot = paths.root;
  port = await freePort();
  child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(port),
      PI_SHELL_AGENT_DIR: paths.agentDir,
      PI_SHELL_SESSIONS_DIR: paths.sessionsDir,
      PI_SHELL_AGENT_SESSIONS_DIR: "",
      PI_SHELL_MCP_CONFIG: paths.mcpShellConfig,
      PI_SHELL_ORIGINS_FILE: path.join(tmpRoot, "sessions-origins.json"),
      PI_SHELL_LOG_DIR: path.join(tmpRoot, "logs"),
      PI_SHELL_LOG_FILE: path.join(tmpRoot, "logs", "bridge.log"),
      PI_SHELL_CWD: paths.home,
      PI_SHELL_MAX_ENGINES: "8",
      PI_SHELL_PI_BIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", () => {}); // 桥的 stdout 不承载协议数据，丢弃
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderrText.length < 4000) stderrText += chunk;
  });
  const ready = await waitFor(async () => {
    try {
      const body = await health("t0");
      return { ok: body?.pi?.state === "idle", body };
    } catch {
      return { ok: false };
    }
  }, { ms: 30000 });
  assert.equal(ready.ok, true, `桥未就绪（stderr: ${stderrText.slice(0, 500)}）`);
});

test.after(async () => {
  if (child && child.exitCode === null) {
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
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test("打开旧会话后：engine.extra.cwd 回写，health.pi.cwd == 会话 header 的 cwd", { timeout: 60000 }, async () => {
  const client = "cwd-open";
  // 新建引擎的初始 cwd = PI_SHELL_CWD（home），不是会话的项目目录
  const before = await health(client);
  assert.equal(before.pi.cwd, paths.home, "新引擎的 cwd 应等于 PI_SHELL_CWD");

  const opened = await api("/api/session/open", { method: "POST", client, body: { path: paths.sessionFile } });
  assert.equal(opened.status, 200, `open 应 200：${opened.text.slice(0, 300)}`);
  assert.equal(opened.json.cwd, paths.project, "open 响应应带会话 header 的 cwd");

  const synced = await waitHealthCwd(client, paths.project);
  assert.equal(synced.cwd, paths.project, "接管完成后 health.pi.cwd 必须等于会话 header 的 cwd（不是引擎创建时的旧值）");
});

test("新建会话：沿用运行时 cwd（F3/F5），响应带 cwd，health 不回退", { timeout: 60000 }, async () => {
  const client = "cwd-open"; // 复用上一条：该引擎已打开 proj 的会话
  const created = await api("/api/session/new", { method: "POST", client });
  assert.equal(created.status, 200, `new 应 200：${created.text.slice(0, 300)}`);
  assert.equal(created.json.cwd, paths.project, "new_session 用的是运行时 cwd（= 上次 switch 的会话目录）");
  assert.equal(created.json.state?.sessionFile ?? null, null, "新会话还没落盘（H-5）");

  const after = await health(client);
  assert.equal(after.pi.cwd, paths.project, "新建会话不得把 cwd 退回引擎创建时的旧值");

  // 全新引擎（没打开过任何会话）→ 新建会话落在初始工作区
  const fresh = await api("/api/session/new", { method: "POST", client: "cwd-fresh" });
  assert.equal(fresh.status, 200, `new 应 200：${fresh.text.slice(0, 300)}`);
  assert.equal(fresh.json.cwd, paths.home, "全新引擎新建会话 = PI_SHELL_CWD");
  assert.equal((await health("cwd-fresh")).pi.cwd, paths.home);
});

test("MCP 重启恢复会话后：cwd 仍是会话 header 的 cwd", { timeout: 90000 }, async () => {
  const client = "cwd-open"; // 上一条刚 new 过 → 重新打开 proj 的会话
  const reopened = await api("/api/session/open", { method: "POST", client, body: { path: paths.sessionFile } });
  assert.equal(reopened.status, 200, `reopen 应 200：${reopened.text.slice(0, 300)}`);
  const attached = await waitHealthCwd(client, paths.project);
  assert.equal(attached.cwd, paths.project);

  const before = await health(client);
  const restarted = await api("/api/engine/restart", { method: "POST", client, body: { client, mcp: ["fakesrv"] } });
  assert.equal(restarted.status, 200, `restart 应 200：${restarted.text.slice(0, 300)}`);
  assert.equal(restarted.json.restarted, true, "换名单必须真的换子进程");
  assert.equal(restarted.json.sessionKept, true, "重启后应切回原会话");
  assert.equal(restarted.json.sessionFile, paths.sessionFile);
  assert.notEqual(restarted.json.pid, before.pi.pid, "子进程 pid 应变化");

  const after = await health(client);
  assert.equal(after.pi.cwd, paths.project, "重启恢复会话后 cwd 必须按会话 header 回写（不是引擎重启前的旧值）");
  assert.deepEqual(after.pi.mcp, ["fakesrv"], "新名单生效");
});

// ---------- A1 / T1：POST /api/session/new {cwd} ----------

const NEW_CLIENT = "cwd-new";

/** Windows 语义下的「同目录变体」：尾部分隔符 + 大写 */
function sameDirVariant(dir) {
  return process.platform === "win32" ? `${dir.toUpperCase()}${path.sep}` : `${dir}${path.sep}`;
}

test("new 带 cwd：与该引擎初始目录相同 → 200、不重启子进程", { timeout: 60000 }, async () => {
  const created = await api("/api/session/new", { method: "POST", client: NEW_CLIENT, body: { cwd: paths.home } });
  assert.equal(created.status, 200, `new 应 200：${created.text.slice(0, 300)}`);
  assert.equal(created.json.cwd, paths.home, "响应 cwd = 新会话真实目录");
  assert.equal(created.json.sessionId === null, false, "响应应带新会话 sessionId");

  const before = await health(NEW_CLIENT);
  const again = await api("/api/session/new", {
    method: "POST",
    client: NEW_CLIENT,
    body: { cwd: sameDirVariant(paths.home) },
  });
  assert.equal(again.status, 200, `同目录变体应 200：${again.text.slice(0, 300)}`);
  assert.equal(again.json.cwd, paths.home, "同目录不重启，cwd 仍是当前会话目录");
  const after = await health(NEW_CLIENT);
  assert.equal(after.pi.pid, before.pi.pid, "同目录（忽略大小写/尾部分隔符）不得重启子进程");
});

test("new 带 cwd：目录不存在 → 400 BAD_REQUEST，且不重启子进程", { timeout: 60000 }, async () => {
  const before = await health(NEW_CLIENT);
  const bad = await api("/api/session/new", {
    method: "POST",
    client: NEW_CLIENT,
    body: { cwd: path.join(tmpRoot, "missing-dir") },
  });
  assert.equal(bad.status, 400, `应 400：${bad.text.slice(0, 300)}`);
  assert.equal(bad.json?.error?.code, "BAD_REQUEST");
  const after = await health(NEW_CLIENT);
  assert.equal(after.pi.pid, before.pi.pid, "校验失败必须先于停进程");
  assert.equal(after.pi.cwd, before.pi.cwd, "校验失败保持原会话目录");
});

test("new 带 cwd：路径是文件不是目录 → 400 BAD_REQUEST", { timeout: 60000 }, async () => {
  const before = await health(NEW_CLIENT);
  const bad = await api("/api/session/new", { method: "POST", client: NEW_CLIENT, body: { cwd: paths.notDir } });
  assert.equal(bad.status, 400, `应 400：${bad.text.slice(0, 300)}`);
  assert.equal(bad.json?.error?.code, "BAD_REQUEST");
  assert.equal((await health(NEW_CLIENT)).pi.pid, before.pi.pid, "非目录不得停进程");
});

test("new 带 cwd：换成另一个目录 → 只重启本列、按新 cwd 重算 MCP，其它列不受影响", { timeout: 90000 }, async () => {
  // 另起一列作为「其它列」的对照
  const other = await api("/api/session/new", { method: "POST", client: "cwd-other", body: { cwd: paths.home } });
  assert.equal(other.status, 200, `对照列应 200：${other.text.slice(0, 300)}`);
  const otherBefore = await health("cwd-other");

  const before = await health(NEW_CLIENT);
  assert.deepEqual(before.pi.mcp, [], "初始名单为空（default 空、home 无规则）");
  const moved = await api("/api/session/new", { method: "POST", client: NEW_CLIENT, body: { cwd: paths.altProject } });
  assert.equal(moved.status, 200, `换目录应 200：${moved.text.slice(0, 300)}`);
  assert.equal(moved.json.cwd, paths.altProject, "响应 cwd 必须是新会话真实目录");
  assert.equal(moved.json.state?.sessionFile ?? null, null, "新会话还没落盘（H-5）");

  const after = await health(NEW_CLIENT);
  assert.notEqual(after.pi.pid, before.pi.pid, "换目录必须换子进程（pi 无 set_cwd）");
  assert.equal(after.pi.cwd, paths.altProject);
  assert.deepEqual(after.pi.mcp, ["fakesrv"], "MCP 名单必须按新 cwd 重算（不能沿用旧名单）");

  const otherAfter = await health("cwd-other");
  assert.equal(otherAfter.pi.pid, otherBefore.pi.pid, "其它列的子进程不受影响");
  assert.equal(otherAfter.pi.cwd, otherBefore.pi.cwd, "其它列的目录不受影响");
});

test("new 带 cwd：新目录上的同目录变体 → 不重启", { timeout: 60000 }, async () => {
  const before = await health(NEW_CLIENT);
  assert.equal(before.pi.cwd, paths.altProject);
  const again = await api("/api/session/new", {
    method: "POST",
    client: NEW_CLIENT,
    body: { cwd: sameDirVariant(paths.altProject) },
  });
  assert.equal(again.status, 200, `应 200：${again.text.slice(0, 300)}`);
  assert.equal(again.json.cwd, paths.altProject);
  assert.equal((await health(NEW_CLIENT)).pi.pid, before.pi.pid, "同目录不得重启");
});
