// A1 / T1 端点证据：POST /api/session/new {cwd}
//
// 纯 HTTP + 临时夹具（假 pi RPC CLI，不 spawn 真 pi、不碰真实会话目录），独立端口 7832。
// 覆盖：
//   1) {cwd: <仓库根目录>} → 200 且响应 cwd 正确，health.pi.cwd 同步
//   2) {cwd: C:/nope} → 400 BAD_REQUEST（先校验再停进程：pid 不变）
//   3) {cwd: <文件>} → 400 BAD_REQUEST
//   4) 同目录变体（尾部分隔符/大小写）→ 200 且不重启（pid 不变，耗时 < 300ms）
// 用法：node scripts/evidence/new-session-dir-api.mjs
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
const PORT = Number.parseInt(process.env.PI_SHELL_EVIDENCE_PORT || "7832", 10);
const TARGET = path.resolve(process.env.PI_SHELL_EVIDENCE_CWD || BRIDGE_ROOT);

const FAKE_PI = `"use strict";
const readline = require("node:readline");
let cwd = process.cwd();
let sessionFile = null;
let sessionId = "fake-session-0";
let seq = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.id === "undefined") return;
  const reply = (data) => process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");
  switch (msg.type) {
    case "get_state":
      return reply({
        sessionId,
        sessionFile,
        cwd,
        isStreaming: false,
        thinkingLevel: "off",
        model: { provider: "fake", id: "fake-1", name: "Fake" },
      });
    case "get_entries":
      return reply({ entries: [], leafId: null });
    case "new_session":
      sessionFile = null;
      sessionId = "fake-session-" + ++seq;
      return reply({ cancelled: false });
    default:
      return reply({});
  }
});
`;

let tmpRoot = "";
let child = null;
let stderrText = "";
const results = [];

function buildFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-new-session-dir-")));
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
  const notDir = path.join(root, "not-a-dir.txt");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(notDir, "x", "utf8");
  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");
  return { root, agentDir, home, sessionsDir, notDir, mcpShellConfig };
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
  if (status !== 200) throw new Error(`health 应 200，实际 ${status}`);
  return json;
}

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  if (!fs.existsSync(TARGET) || !fs.statSync(TARGET).isDirectory()) {
    throw new Error(`目标目录不存在（证据脚本只验证真实目录）：${TARGET}`);
  }
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
      const body = await health("evidence-boot");
      return { ok: body?.pi?.state === "idle", state: body?.pi?.state };
    } catch {
      return { ok: false, state: "unreachable" };
    }
  }, { ms: 30000 });
  if (!ready.ok) throw new Error(`桥未就绪（state=${ready.state}; stderr: ${stderrText.slice(0, 500)}）`);
  console.log(`fixture=${tmpRoot}`);
  console.log(`bridge=http://127.0.0.1:${PORT}  target=${TARGET}`);

  const client = "evidence-cwd";

  // 1) 合法目录 → 200 + cwd 正确
  const created = await api("/api/session/new", { method: "POST", client, body: { cwd: TARGET } });
  check(
    "POST /api/session/new {cwd: TARGET} → 200 且 cwd 正确",
    created.status === 200 && created.json?.cwd === TARGET,
    `status=${created.status} cwd=${created.json?.cwd}`,
  );

  const h1 = await health(client);
  check("GET /api/health → pi.cwd == TARGET", h1?.pi?.cwd === TARGET, `pi.cwd=${h1?.pi?.cwd}`);

  // 2) 目录不存在 → 400 BAD_REQUEST，且不重启（pid 不变）
  const pidBeforeBad = h1?.pi?.pid;
  const missing = path.join(tmpRoot, "nope");
  const bad = await api("/api/session/new", { method: "POST", client, body: { cwd: missing } });
  check(
    "POST {cwd: 不存在} → 400 BAD_REQUEST",
    bad.status === 400 && bad.json?.error?.code === "BAD_REQUEST",
    `status=${bad.status} code=${bad.json?.error?.code}`,
  );
  const h2 = await health(client);
  check("校验失败不停进程（pid 不变）+ cwd 保持", h2?.pi?.pid === pidBeforeBad && h2?.pi?.cwd === TARGET, `pid=${h2?.pi?.pid}`);

  // 3) 路径是文件 → 400 BAD_REQUEST
  const notDir = await api("/api/session/new", { method: "POST", client, body: { cwd: fixture.notDir } });
  check(
    "POST {cwd: 文件} → 400 BAD_REQUEST",
    notDir.status === 400 && notDir.json?.error?.code === "BAD_REQUEST",
    `status=${notDir.status} code=${notDir.json?.error?.code}`,
  );

  // 4) 同目录变体（尾部分隔符 + 大小写）→ 200，不重启
  const variant = process.platform === "win32" ? `${TARGET.toUpperCase()}${path.sep}` : `${TARGET}${path.sep}`;
  const t0 = Date.now();
  const same = await api("/api/session/new", { method: "POST", client, body: { cwd: variant } });
  const ms = Date.now() - t0;
  const h3 = await health(client);
  check(
    "POST {cwd: 同目录变体} → 200 且不重启（pid 不变，<300ms）",
    same.status === 200 && same.json?.cwd === TARGET && h3?.pi?.pid === pidBeforeBad && ms < 300,
    `status=${same.status} cwd=${same.json?.cwd} pid=${h3?.pi?.pid} ms=${ms}`,
  );

  // 5) 换回来（目标目录 → 夹具 home）走重启路径，确认只影响本列/响应正确
  const moved = await api("/api/session/new", { method: "POST", client, body: { cwd: fixture.home } });
  const h4 = await health(client);
  check(
    "POST {cwd: 另一个目录} → 重启本列，响应/health 同步新目录",
    moved.status === 200 && moved.json?.cwd === fixture.home && h4?.pi?.cwd === fixture.home && h4?.pi?.pid !== pidBeforeBad,
    `status=${moved.status} cwd=${moved.json?.cwd} pid=${h4?.pi?.pid}`,
  );

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
        const { spawnSync } = await import("node:child_process");
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {}
    }
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}
process.exit(exitCode);
