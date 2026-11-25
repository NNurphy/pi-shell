// 接管/重连的初始 entries 走文件直读（与会话体积解耦）
//
// 为什么要这组用例：`get_entries` 的 RPC 响应是「一行装下全部 entries」，被 JSONL 单行上限约束
// （framing.mjs；PI_SHELL_MAX_LINE_BYTES 可调小）。大会话（单个历史会话 8.7MiB、87% 是 base64 图片）
// 超限就整行丢弃 → 30s 超时 → 接管失败，而「只读浏览」因为直读文件始终能看。
//
// 证明手法（比「跑一遍能过」强）：假 pi 的 `get_entries` **一律回 success:false**，并把收到的命令
// 逐行记进 FAKE_CMD_LOG。接管/重连一旦回头依赖全量 RPC，就会立刻红（而不是悄悄慢 30s）。
// 同时夹具会话里放一条 2MiB 的 message 行 + PI_SHELL_MAX_LINE_BYTES=1048576：即使真要过解码器也过不去。
//
// 矩阵：
//   1) open（view + 后台接管）→ entries 来自文件（条数/leafId 正确），日志 entriesVia=file，命令日志无 get_entries
//   2) 二次 open = 复用路径（S4 权威重载走它）→ attach=attached，entries 仍来自文件
//   3) 断线重连（release → claim，恢复路径）→ engine_restored，仍无 get_entries
//   4) 全程：无 pi_request_timeout / 无 pi_line_skipped overlong / 无 session_attach_failed
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
const BIG_TEXT_BYTES = 2 * 1024 * 1024; // 单条 message 的正文：远超 1MiB 单行上限

// 假 pi：get_entries 故意失败 + 每条命令记日志（证明接管路径不再拉全量 entries）
const FAKE_PI = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const CMD_LOG = process.env.FAKE_CMD_LOG || "";
const note = (type) => {
  if (!CMD_LOG) return;
  try { fs.appendFileSync(CMD_LOG, type + "\\n"); } catch {}
};

let sessionFile = null;
let sessionId = "fake-boot";
const streaming = false;

const headerOf = (file) => {
  try {
    const header = JSON.parse(fs.readFileSync(file, "utf8").split("\\n")[0]);
    return { cwd: typeof header.cwd === "string" ? header.cwd : null, id: header.id || null };
  } catch {
    return { cwd: null, id: null };
  }
};

const reply = (msg, data) => process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");
const fail = (msg, error) => process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: false, error }) + "\\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.id === "undefined") return;
  note(msg.type);
  switch (msg.type) {
    case "get_state":
      return reply(msg, {
        sessionId,
        sessionFile,
        cwd: process.cwd(),
        isStreaming: streaming,
        thinkingLevel: "off",
        model: { provider: "fake", id: "fake-default", name: "Fake Default" },
      });
    case "switch_session": {
      const file = path.resolve(String(msg.sessionPath));
      const header = headerOf(file);
      sessionFile = file;
      sessionId = header.id || path.basename(file).replace(/[.]jsonl$/i, "");
      return reply(msg, { cancelled: false });
    }
    // 接管/重连不该再调它 —— 一律失败（谁依赖它就立刻红，不留 30s 超时的含糊）
    case "get_entries":
      return fail(msg, "get_entries must not be called on attach/reconnect path");
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
    const port = 7940 + i;
    if (await portFree(port)) return port;
  }
  throw new Error("找不到空闲端口（7940-7989）");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function buildFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-fileread-")));
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
  for (const dir of [home, project, sessionsDir]) fs.mkdirSync(dir, { recursive: true });

  const sessionId = "01a1aaaa-1111-2222-3333-444444444444";
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
  const rows = [
    { type: "session", version: 3, id: sessionId, timestamp: "2026-11-25T00:00:00.000Z", cwd: project.replace(/\\/g, "/") },
    { type: "message", id: "e1", timestamp: "2026-11-25T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "第一条" }] } },
    // 2MiB 单行（同事故形态：图片 base64 塞进正文）——直读能读，走 RPC 单行必然超 1MiB 上限
    { type: "message", id: "e2", timestamp: "2026-11-25T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(BIG_TEXT_BYTES) }] } },
    { type: "message", id: "e3", timestamp: "2026-11-25T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "第三条" }] } },
  ];
  fs.writeFileSync(sessionFile, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");
  return { root, agentDir, home, project, sessionsDir, sessionFile, sessionId, leafId: "e3", mcpShellConfig };
}

test("接管/重连的初始 entries 走文件直读（get_entries 全量 RPC 调用即失败）", { timeout: 150000 }, async () => {
  const fixture = buildFixture();
  const PORT = await freePort();
  const logFile = path.join(fixture.root, "logs", "bridge.log");
  const cmdLog = path.join(fixture.root, "fake-cmds.log");
  let child = null;
  let stderrText = "";

  const api = async (pathname, { method = "GET", client = "col-a", body } = {}) => {
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

  const readLog = () => {
    try {
      return fs.readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };
  const readCmds = () => {
    try {
      return fs.readFileSync(cmdLog, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const waitLogLine = (label, test = (line) => line.includes(label), { ms = 30000 } = {}) =>
    waitFor(() => {
      const line = readLog().split("\n").find(test);
      return { ok: !!line, line };
    }, { ms });

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
        PI_SHELL_LOG_FILE: logFile,
        PI_SHELL_CWD: fixture.home,
        PI_SHELL_MAX_ENGINES: "4",
        PI_SHELL_IDLE_MS: "600000",
        PI_SHELL_PI_BIN: "",
        // 极端约束：1MiB 单行上限（任何走解码器的全量 entries 响应都过不去）
        PI_SHELL_MAX_LINE_BYTES: String(1024 * 1024),
        FAKE_CMD_LOG: cmdLog,
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
        const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { "x-pi-shell-client": "col-a" } });
        const json = await res.json();
        return { ok: json?.pi?.state === "idle", state: json?.pi?.state };
      } catch {
        return { ok: false, state: "unreachable" };
      }
    }, { ms: 30000 });
    assert.ok(ready.ok, `桥未就绪 state=${ready.state}${stderrText ? `：${stderrText.slice(0, 500)}` : ""}`);

    // ── 1) 首次 open：view 立即返回（文件直读，2MiB 行不影响）+ 后台接管完成
    const openedAt = Date.now();
    const open1 = await api("/api/session/open", { method: "POST", body: { path: fixture.sessionFile } });
    const openMs = Date.now() - openedAt;
    assert.equal(open1.status, 200, `open 应 200：${open1.text.slice(0, 300)}`);
    assert.equal(open1.json?.mode, "view", "首次 open 应走 view（读文件先返回）");
    assert.equal(open1.json?.entries?.length, 3, "entries 应来自文件（3 条）");
    assert.equal(open1.json?.leafId, "e3", "leafId 应为文件最后一条");
    assert.equal(open1.json?.sessionId, fixture.sessionId, "sessionId 应来自会话 header");

    const attached = await waitLogLine("|info|session_attached|", undefined, { ms: 30000 });
    assert.ok(attached.ok, "后台接管应成功（session_attached）");
    assert.match(attached.line, /entriesVia=file/, "接管日志应标明 entries 来自文件直读");
    assert.match(attached.line, /entries=3/, `接管日志条数应为 3（实际：${attached.line}）`);

    // ── 2) 二次 open = 复用路径（S4 权威重载走它）：entries 仍来自文件
    const open2 = await api("/api/session/open", { method: "POST", body: { path: fixture.sessionFile } });
    assert.equal(open2.status, 200, `复用 open 应 200：${open2.text.slice(0, 300)}`);
    assert.equal(open2.json?.mode, "live", "复用应回 live");
    assert.equal(open2.json?.attach, "attached");
    assert.equal(open2.json?.entries?.length, 3, "复用路径 entries 应来自文件（3 条）");
    assert.equal(open2.json?.leafId, "e3");
    const reused = await waitLogLine("|info|session_open_reused|");
    assert.ok(reused.ok, "应记 session_open_reused");
    assert.match(reused.line, /entriesVia=file/, "复用路径日志应标明 entries 来自文件直读");

    // ── 3) 断线重连（恢复路径）：release → claim → engine_restored
    const released = await api("/api/engine/release", { method: "POST", body: { client: "col-a" } });
    assert.equal(released.status, 200, `release 应 200：${released.text.slice(0, 300)}`);
    assert.equal(released.json?.released, true, "应真的释放了一条引擎");
    const reclaimed = await api("/api/engine/claim", { method: "POST", body: { client: "col-a" } });
    assert.equal(reclaimed.status, 200, `claim 应 200：${reclaimed.text.slice(0, 300)}`);
    const restored = await waitLogLine("|info|engine_restored|", undefined, { ms: 40000 });
    assert.ok(restored.ok, `重连应恢复原会话（engine_restored）；实际日志尾部：${readLog().split("\n").slice(-8).join(" | ").slice(0, 600)}`);
    const view = await waitFor(async () => {
      const res = await api("/api/session/view");
      const file = res.json?.sessionFile ? path.resolve(res.json.sessionFile) : null;
      return { ok: file === fixture.sessionFile, file, cwd: res.json?.cwd };
    }, { ms: 15000 });
    assert.ok(view.ok, `恢复后 session/view 应指向原会话（实际 ${view.file}）`);

    // ── 4) 核心断言：全程没有 get_entries（谁回头依赖全量 RPC，这条就红）+ 无超时/丢行/接管失败
    const cmds = readCmds();
    assert.equal(cmds.includes("get_entries"), false, `接管/重连路径不得调用 get_entries（实际命令：${cmds.join(",")}）`);
    assert.ok(cmds.includes("switch_session"), "接管应确实走过 switch_session（不是空转就报成功）");
    const logText = readLog();
    assert.equal(/pi_line_skipped/.test(logText), false, "日志不应出现 pi_line_skipped（含 overlong 丢弃）");
    assert.equal(/pi_request_timeout/.test(logText), false, "日志不应出现 pi_request_timeout");
    assert.equal(/\|session_attach_failed\|/.test(logText), false, "不应出现 session_attach_failed");
    console.log(`[report] open(view)=${openMs}ms attach=${/(?:^|\s)ms=(\d+)/.exec(attached.line)?.[1] ?? "?"}ms entries=3 bigLine=${(BIG_TEXT_BYTES / 1024 / 1024).toFixed(0)}MiB cap=1MiB`);
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