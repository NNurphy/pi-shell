#!/usr/bin/env node
// P0 证据脚本：重连后恢复原会话（端点级，真 pi）
//
// 事故（2026-11-14）：页面离开 → 引擎被 idle-sweep 回收 → 回来重连 → 桥按 INITIAL_CWD 起了
// 空引擎 + 空会话，页面却还显示旧历史 → AI 对之前内容一无所知。
//
// 做法：真 pi 子进程 + **夹具会话目录**（从 ~/.pi/agent/sessions 只读复制一条会话）。
//   1) open 夹具会话，记下 sessionFile 与 header cwd；
//   2) 等 > idleMs（PI_SHELL_IDLE_MS=3000）让引擎被 sweep（/api/health engineCount=0 + 日志 engine_swept）；
//   3) 用同一个 clientId 重新连（POST /api/engine/claim）；
//   4) 断言 health.pi.cwd == 原会话 cwd、/api/session/view 的 sessionFile == 原文件、日志 engine_restored；
//   5) 反例：释放引擎后删掉原会话文件再重连 → 日志 engine_restore_failed code=NOT_FOUND，引擎不崩、不静默。
//
// 纪律：端口固定 7837（被占直接 FAIL，不换端口）；不碰真实会话目录（只读复制一条）；
// 收尾按 PID 关自己起的桥，夹具目录整个删掉。
//
// 用法：node scripts/evidence/reconnect-restore-api.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRIDGE_ENTRY = path.join(ROOT, "bridge", "src", "index.mjs");
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SESSIONS_ROOT = path.join(AGENT_DIR, "sessions");
const PORT = 7837;
const CLIENT = "evidence-reconnect";
const IDLE_MS = 3000;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
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

async function waitFor(fn, ms, step = 200) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last?.ok) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last ?? { ok: false };
}

const samePath = (a, b) =>
  typeof a === "string" && typeof b === "string" && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** 会话根下找一条「header cwd 仍然存在」的真实会话（只读，按 mtime 从新到旧） */
function pickSourceSession() {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(SESSIONS_ROOT, 0);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    try {
      const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
      if (typeof header?.cwd !== "string" || !header.cwd) continue;
      if (!fs.statSync(header.cwd).isDirectory()) continue;
      return { file, cwd: header.cwd };
    } catch {
      // 坏文件/被移动的会话：跳过
    }
  }
  return null;
}

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-reconnect-evi-")));
let child = null;
let exitCode = 1;

try {
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（不换端口，先清掉占用者）`);

  const source = pickSourceSession();
  if (!source) throw new Error(`找不到可用会话：${SESSIONS_ROOT}（可读且 header.cwd 存在）`);
  check("挑到夹具来源会话", true, `${path.basename(source.file)} → cwd=${source.cwd}`);
  const expectedCwd = source.cwd;

  const sessionsDir = path.join(tmpRoot, "sessions");
  const fixtureDir = path.join(sessionsDir, path.basename(path.dirname(source.file)));
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixtureSession = path.join(fixtureDir, path.basename(source.file));
  await fsp.copyFile(source.file, fixtureSession);

  const home = path.join(tmpRoot, "home");
  fs.mkdirSync(home, { recursive: true });
  const mcpConfig = path.join(tmpRoot, "pi-shell-mcp.json");
  fs.writeFileSync(mcpConfig, `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");
  const logFile = path.join(tmpRoot, "logs", "bridge.log");
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");
  check("初始工作区（PI_SHELL_CWD）≠ 会话 cwd", !samePath(home, expectedCwd), `${home} vs ${expectedCwd}`);

  // 起桥（真 pi，夹具会话目录 + 空 MCP 配置；idleMs=3000 让回收几秒内发生）
  child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_AGENT_DIR: AGENT_DIR,
      PI_SHELL_SESSIONS_DIR: sessionsDir,
      PI_SHELL_AGENT_SESSIONS_DIR: "",
      PI_SHELL_MCP_CONFIG: mcpConfig,
      PI_SHELL_ORIGINS_FILE: path.join(tmpRoot, "sessions-origins.json"),
      PI_SHELL_LOG_DIR: path.join(tmpRoot, "logs"),
      PI_SHELL_LOG_FILE: logFile,
      PI_SHELL_CWD: home,
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_IDLE_MS: String(IDLE_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});

  const ready = await waitFor(async () => {
    try {
      const { status, json } = await api("/api/health", { client: CLIENT });
      return { ok: status === 200 && json?.pi?.state === "idle", json };
    } catch {
      return { ok: false };
    }
  }, 45000);
  check("桥就绪（pi idle）", ready.ok, `pi.state=${ready.json?.pi?.state ?? "n/a"} pid=${ready.json?.pi?.pid ?? "n/a"}`);
  if (!ready.ok) throw new Error("桥未就绪，后续断言无意义");

  // 1) 打开夹具会话：接管完成后记下真相
  const opened = await api("/api/session/open", { method: "POST", client: CLIENT, body: { path: fixtureSession } });
  check("POST /api/session/open 200", opened.status === 200, opened.text.slice(0, 200));
  const attached = await waitFor(async () => {
    const { json } = await api("/api/health", { client: CLIENT });
    return { ok: samePath(json?.pi?.cwd, expectedCwd), json };
  }, 30000);
  check("接管完成：health.pi.cwd == 会话 header cwd", attached.ok, `pi.cwd=${attached.json?.pi?.cwd}`);
  const viewBefore = await api("/api/session/view", { client: CLIENT });
  check("打开后 /api/session/view sessionFile == 夹具会话", samePath(viewBefore.json?.sessionFile, fixtureSession), `sessionFile=${viewBefore.json?.sessionFile}`);

  // 2) 等引擎被 idle-sweep 回收（> idleMs 无请求；sweep 每 5s 一轮）
  const swept = await waitFor(async () => {
    const { json } = await api("/api/health", { client: CLIENT });
    return { ok: (json?.engineCount ?? -1) === 0, json };
  }, 40000, 500);
  check("引擎被 idle-sweep 回收（engineCount=0）", swept.ok, `engineCount=${swept.json?.engineCount}`);
  check("日志出现 engine_swept", /\|engine_swept\|/.test(readLog()), "");

  // 3) 同一个 clientId 重连（这是事故发生的那一步）
  const reclaimed = await api("/api/engine/claim", { method: "POST", client: CLIENT, body: { client: CLIENT } });
  check("重连 POST /api/engine/claim 200", reclaimed.status === 200, reclaimed.text.slice(0, 200));

  const restored = await waitFor(async () => {
    const { status, json } = await api("/api/session/view", { client: CLIENT });
    return { ok: status === 200 && samePath(json?.sessionFile, fixtureSession), status, json };
  }, 45000);
  check("重连后 /api/session/view sessionFile == 原会话文件", restored.ok, `sessionFile=${restored.json?.sessionFile}`);

  const healthAfter = await waitFor(async () => {
    const { json } = await api("/api/health", { client: CLIENT });
    return { ok: samePath(json?.pi?.cwd, expectedCwd), json };
  }, 30000);
  check("重连后 health.pi.cwd == 原会话 cwd（不是 PI_SHELL_CWD）", healthAfter.ok, `pi.cwd=${healthAfter.json?.pi?.cwd} 期望=${expectedCwd}`);
  check("重连后引擎 idle（可继续发送）", healthAfter.json?.pi?.state === "idle", `state=${healthAfter.json?.pi?.state}`);

  const restoreLogged = await waitFor(async () => {
    const line = readLog()
      .split("\n")
      .find((l) => l.includes("|engine_restored|"));
    return { ok: Boolean(line), line };
  }, 30000);
  check("日志出现 engine_restored（client / sessionFile / cwd）", restoreLogged.ok, restoreLogged.line ?? "");
  check(
    "engine_created 用的是会话 cwd（不是 INITIAL_CWD）",
    new RegExp(`\\|engine_created\\|.*cwd=${expectedCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(readLog()),
    "",
  );

  // 4) 反例：释放引擎 + 删掉原会话文件再重连 → NOT_FOUND，明确失败且引擎不崩
  const released = await api("/api/engine/release", { method: "POST", client: CLIENT, body: { client: CLIENT } });
  check("释放引擎", released.status === 200 && released.json?.released === true, released.text.slice(0, 200));
  await waitFor(async () => {
    const { json } = await api("/api/health", { client: CLIENT });
    return { ok: (json?.engineCount ?? -1) === 0, json };
  }, 15000);
  await fsp.rm(fixtureSession, { force: true });

  const reclaimed2 = await api("/api/engine/claim", { method: "POST", client: CLIENT, body: { client: CLIENT } });
  check("文件删除后重连 claim 200（失败在后台明确报告）", reclaimed2.status === 200, reclaimed2.text.slice(0, 200));

  const failedLine = await waitFor(async () => {
    const line = readLog()
      .split("\n")
      .find((l) => l.includes("|engine_restore_failed|"));
    return { ok: Boolean(line), line };
  }, 45000);
  check("日志出现 engine_restore_failed（不得静默）", failedLine.ok, failedLine.line ?? "");
  check("失败码 NOT_FOUND", /code=NOT_FOUND/.test(failedLine.line ?? ""), failedLine.line ?? "");

  const healthFailed = await waitFor(async () => {
    const { json } = await api("/api/health", { client: CLIENT });
    return { ok: json?.pi?.state === "idle", json };
  }, 30000);
  check("恢复失败后引擎仍 idle（不崩）", healthFailed.ok, `state=${healthFailed.json?.pi?.state}`);
  const viewFailed = await api("/api/session/view", { client: CLIENT });
  check(
    "恢复失败后不再指向已删会话（落到空会话）",
    !samePath(viewFailed.json?.sessionFile, fixtureSession),
    `sessionFile=${viewFailed.json?.sessionFile ?? null}`,
  );

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  check("脚本执行", false, err?.message || String(err));
  exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    const pid = child.pid;
    child.kill();
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
    if (child.exitCode === null) child.kill("SIGKILL");
    console.log(`INFO  收尾：已按 PID 关闭桥（pid=${pid}）`);
  }
  await fsp.rm(tmpRoot, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} PASS · 夹具 ${tmpRoot} 已清理`);
  process.exit(exitCode);
}