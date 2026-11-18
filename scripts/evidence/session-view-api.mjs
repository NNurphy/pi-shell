#!/usr/bin/env node
// B1 / T5 端点证据：GET /api/session/view?client= · /api/models?client= · /api/commands?client=
//
// 做法：纯 HTTP + 临时夹具（假 pi RPC CLI，不 spawn 真 pi、不碰真实会话目录），独立端口 7834。
// 假 pi 的 `get_available_models` / `get_commands` / `get_state` 都按**自己的 cwd** 生成，
// 所以「/api/models?client=X 的模型 id」就是「X 引擎直接 get_available_models 的结果」——
// 端点若仍取主引擎，下面 col-b 的断言必然失败。
//
// 覆盖：
//   1) 建两列（col-a/col-b，各自 cwd 不同）→ GET /api/session/view?client= 各自 cwd 正确、字段齐全
//   2) /api/models?client=col-b 与 col-b 引擎的 get_available_models（model-<dir>）一致
//   3) /api/commands?client=col-b 同样是 col-b 引擎的清单
//   4) 不带 client → 仍返回主引擎结果（与 /api/health 的 pi.cwd 同一列）
//   5) 未知 client：/api/session/view → 404 NOT_FOUND；/api/models 回落主引擎（不 404）
//
// 收尾：按 PID 关自己起的桥（不按命令行批量杀），夹具目录整个删掉。
// 用法：node scripts/evidence/session-view-api.mjs
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
// 端口可被门禁顺延：PI_SHELL_PORT（默认 7834）
const PORT = Number(process.env.PI_SHELL_PORT || 7834);

// 假 pi：所有可观察值都从 process.cwd() 派生（= 该引擎的真实 cwd），便于断言「用的是哪一列」。
const FAKE_PI = `"use strict";
const path = require("node:path");
const readline = require("node:readline");

const cwd = process.cwd();
const name = path.basename(cwd) || "root";
const model = { provider: "fake", id: "model-" + name, name: "Fake " + name };
let seq = 0;
let sessionId = "fake-" + name + "-0";
let sessionFile = path.join(cwd, ".fake-session-0.jsonl");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.id === "undefined") return;
  const reply = (data) =>
    process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");
  switch (msg.type) {
    case "get_state":
      return reply({ sessionId, sessionFile, cwd, isStreaming: false, thinkingLevel: "high", model });
    case "get_entries":
      return reply({ entries: [], leafId: null });
    case "new_session":
      seq += 1;
      sessionId = "fake-" + name + "-" + seq;
      sessionFile = path.join(cwd, ".fake-session-" + seq + ".jsonl");
      return reply({ cancelled: false });
    case "get_available_models":
      return reply({ models: [model] });
    case "get_commands":
      return reply({ commands: [{ name: "cmd-" + name, description: "cwd=" + cwd }] });
    default:
      return reply({});
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-session-view-")));
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
  // provider "fake" 算「已配置」→ /api/models 的 configured 过滤不会把假模型滤掉
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ fake: { key: "fixture" } }, null, 2), "utf8");

  const home = path.join(root, "home");
  const dirA = path.join(root, "project-a");
  const dirB = path.join(root, "project-b");
  const sessionsDir = path.join(root, "sessions");
  for (const dir of [home, dirA, dirB, sessionsDir]) fs.mkdirSync(dir, { recursive: true });
  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");
  return { root, agentDir, home, dirA, dirB, sessionsDir, mcpShellConfig };
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

async function waitFor(fn, { ms = 30000, step = 100 } = {}) {
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

const modelIdFor = (dir) => `model-${path.basename(dir)}`;
const expectedCwd = (dir) => fs.realpathSync(dir);

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
  });
  if (!ready.ok) throw new Error(`桥未就绪（state=${ready.state}; stderr: ${stderrText.slice(0, 500)}）`);
  console.log(`fixture=${tmpRoot}`);
  console.log(`bridge=http://127.0.0.1:${PORT}`);

  const colA = "col-a";
  const colB = "col-b";

  // 1) 建两列，各自切到不同项目目录（A1/T1 的 /api/session/new {cwd}）
  const a = await api("/api/session/new", { method: "POST", client: colA, body: { cwd: fixture.dirA } });
  const b = await api("/api/session/new", { method: "POST", client: colB, body: { cwd: fixture.dirB } });
  check(
    "建两列：POST /api/session/new {cwd} 各自成功",
    a.status === 200 && b.status === 200 && a.json?.cwd === expectedCwd(fixture.dirA) && b.json?.cwd === expectedCwd(fixture.dirB),
    `a=${a.status}/${a.json?.cwd} b=${b.status}/${b.json?.cwd}`,
  );

  // 2) view：两列各自的 cwd 正确，字段齐全
  const viewA = await api(`/api/session/view?client=${colA}`);
  const viewB = await api(`/api/session/view?client=${colB}`);
  const fieldsOk = (view) =>
    view.status === 200 &&
    ["cwd", "sessionFile", "model", "thinkingLevel", "mcp"].every((key) => key in (view.json ?? {}));
  check(
    "GET /api/session/view?client=col-a → 200 + 字段齐全 + cwd=project-a",
    fieldsOk(viewA) && viewA.json.cwd === expectedCwd(fixture.dirA),
    `status=${viewA.status} cwd=${viewA.json?.cwd} keys=${Object.keys(viewA.json ?? {}).join(",")}`,
  );
  check(
    "GET /api/session/view?client=col-b → 200 + cwd=project-b",
    fieldsOk(viewB) && viewB.json.cwd === expectedCwd(fixture.dirB),
    `status=${viewB.status} cwd=${viewB.json?.cwd}`,
  );
  check(
    "view：model/thinkingLevel/sessionFile 来自该列 get_state",
    viewB.json?.model?.id === modelIdFor(fixture.dirB) &&
      viewB.json?.thinkingLevel === "high" &&
      typeof viewB.json?.sessionFile === "string" &&
      path.dirname(viewB.json.sessionFile) === expectedCwd(fixture.dirB) &&
      Array.isArray(viewB.json?.mcp),
    `model=${JSON.stringify(viewB.json?.model)} thinking=${viewB.json?.thinkingLevel} file=${viewB.json?.sessionFile}`,
  );

  // 3) models 带 client：等于 col-b 引擎直接 get_available_models 的结果（假 pi 按自身 cwd 生成）
  const modelsB = await api(`/api/models?client=${colB}`);
  const idsB = (modelsB.json?.models ?? []).map((m) => m.id);
  check(
    `/api/models?client=col-b → 与 col-b 引擎 get_available_models 一致（${modelIdFor(fixture.dirB)}）`,
    modelsB.status === 200 && idsB.length === 1 && idsB[0] === modelIdFor(fixture.dirB),
    `status=${modelsB.status} ids=${idsB.join(",")}`,
  );

  // 4) commands 带 client：同样是 col-b 引擎的清单
  const cmdsB = await api(`/api/commands?client=${colB}`);
  check(
    "/api/commands?client=col-b → col-b 引擎的命令清单",
    cmdsB.status === 200 && cmdsB.json?.commands?.[0]?.name === `cmd-${path.basename(fixture.dirB)}`,
    `status=${cmdsB.status} cmd=${cmdsB.json?.commands?.[0]?.name}`,
  );

  // 5) 不带 client：仍返回主引擎结果（与 /api/health 的 pi.cwd 同一列）
  const primaryHealth = await health(null);
  const primaryDir = primaryHealth?.pi?.cwd;
  check(
    "不带 client：/api/health 能给出主引擎 cwd（后续断言基线）",
    typeof primaryDir === "string" && fs.existsSync(primaryDir),
    `pi.cwd=${primaryDir}`,
  );
  const viewPrimary = await api("/api/session/view");
  const modelsPrimary = await api("/api/models");
  const cmdsPrimary = await api("/api/commands");
  check(
    "不带 client：/api/session/view 仍用主引擎（cwd == health.pi.cwd）",
    viewPrimary.status === 200 && viewPrimary.json?.cwd === primaryDir,
    `status=${viewPrimary.status} cwd=${viewPrimary.json?.cwd} primary=${primaryDir}`,
  );
  check(
    "不带 client：/api/models 仍用主引擎（model-<主引擎目录>）",
    modelsPrimary.status === 200 &&
      (modelsPrimary.json?.models ?? []).every((m) => m.id === modelIdFor(primaryDir)),
    `ids=${(modelsPrimary.json?.models ?? []).map((m) => m.id).join(",")} primary=${primaryDir}`,
  );
  check(
    "不带 client：/api/commands 仍用主引擎",
    cmdsPrimary.status === 200 && cmdsPrimary.json?.commands?.[0]?.name === `cmd-${path.basename(primaryDir)}`,
    `cmd=${cmdsPrimary.json?.commands?.[0]?.name} primary=${primaryDir}`,
  );

  // 6) 错误口径：view 未知 client → 404 NOT_FOUND；models 未知 client → 回落主引擎（不 404）
  const viewUnknown = await api("/api/session/view?client=no-such-column");
  check(
    "GET /api/session/view?client=未知 → 404 NOT_FOUND",
    viewUnknown.status === 404 && viewUnknown.json?.error?.code === "NOT_FOUND",
    `status=${viewUnknown.status} code=${viewUnknown.json?.error?.code}`,
  );
  const modelsUnknown = await api("/api/models?client=no-such-column");
  check(
    "/api/models?client=未知 → 回落主引擎（200，不 404）",
    modelsUnknown.status === 200 &&
      (modelsUnknown.json?.models ?? []).every((m) => m.id === modelIdFor(primaryDir)),
    `status=${modelsUnknown.status} ids=${(modelsUnknown.json?.models ?? []).map((m) => m.id).join(",")}`,
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
