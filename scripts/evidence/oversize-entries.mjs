#!/usr/bin/env node
// 证据：JSONL 单行上限 8MiB→32MiB + PI_SHELL_MAX_LINE_BYTES 覆盖
//
// 事故复刻（2026-11-25）：某生产会话 8.69MB / 351 行（最大单行 456KB），get_entries 的 RPC
// 响应一行装下全部 entries（8,454,144 字节）> 旧 DEFAULT_MAX_LINE_BYTES(8MiB) → JsonlDecoder 丢行
// → 桥 30s 超时 → 接管失败 TIMEOUT。修法：上限 32MiB + env 覆盖，超限丢弃底线保留。
//
// 做法：纯 HTTP + 临时夹具（共享假引擎 _fake-engine.mjs，不 spawn 真 pi、不碰真实会话目录），
// 独立端口 7842（PI_SHELL_PORT 可顺延）。每个场景一个夹具根 + 一座桥，串行跑、按 PID 树收尾。
//
// 场景（对应 DoD 1-4）：
//   A 默认 32MiB：程序化生成 ~10.5MiB 会话（380+ 条、6 条 ~420KB 巨行，复刻事故形态）
//     → attach 成功（session_attached、无 pi_line_skipped reason=overlong、无 pi_request_timeout）
//     → 二次 open 走复用路径：get_entries 的 ~10.5MiB 单行 RPC 响应原样过解码器（attach=attached）
//   B PI_SHELL_MAX_LINE_BYTES=1048576（1MiB）：同会话 attach 必失败（overlong 丢弃 → 30s 超时，
//     session_attach_failed code=TIMEOUT），无 session_attached——丢弃路径行为不变
//   C PI_SHELL_MAX_LINE_BYTES=abc（非法）：桥仍启动（health idle）+ 日志 warn 回退记录（raw=abc）
//   D ~34MiB 会话 + 默认 32MiB：get_entries 响应仍被丢（保护底线在，日志有 overlong bytes>32MiB）
//
// 用法：node scripts/evidence/oversize-entries.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, "..", "..");
const BRIDGE_ENTRY = path.join(BRIDGE_ROOT, "bridge", "src", "index.mjs");
const SHARED_ENGINE = path.join(BRIDGE_ROOT, "scripts", "evidence", "_fake-engine.mjs");
// 夹具端口固定 7842（任务卡：不占 7788）。不继承环境里的 PI_SHELL_PORT：
// 本脚本可能在带着 PI_SHELL_PORT=7788（在跑的桥）的环境里被执行，继承就会撞端口。
const PORT = 7842;
const MiB = 1024 * 1024;
const CLIENT = "col-a";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const roots = []; // 所有夹具根（finally 里统一删）
const children = []; // 所有桥进程（finally 里按 PID 树清）
let stderrText = "";

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function waitFor(fn, { ms = 30000, step = 200 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last?.ok) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last ?? { ok: false };
}

async function api(pathname, { method = "GET", client = CLIENT, body } = {}) {
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
  return { status: res.status, json, text: text.length > 300 ? `<${text.length} bytes>` : text };
}

function readLog(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function waitForLog(logFile, label, { ms = 45000 } = {}) {
  return waitFor(
    () => {
      const text = readLog(logFile);
      return { ok: text.includes(label), text };
    },
    { ms, step: 200 },
  );
}

/** 日志里所有 overlong 丢行事件的 bytes 值 */
function overlongBytes(logText) {
  const out = [];
  for (const m of logText.matchAll(/pi_line_skipped.*?bytes=(\d+)/g)) out.push(Number(m[1]));
  return out;
}

function buildFixture(tag) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pi-shell-oversize-${tag}-`)));
  const agentDir = path.join(root, "agent");
  const pkgDir = path.join(agentDir, "install", "releases", "1.5.0", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "install", "current-version"), "1.5.0\n", "utf8");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pi-coding-agent", version: "1.5.0", bin: { pi: "cli.js" } }, null, 2),
    "utf8",
  );
  const shim = `"use strict";\nimport(${JSON.stringify(pathToFileURL(SHARED_ENGINE).href)}).catch((err) => { console.error(err); process.exit(1); });\n`;
  fs.writeFileSync(path.join(pkgDir, "cli.js"), shim, "utf8");
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2), "utf8");
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ fake: { key: "fixture" } }, null, 2), "utf8");

  const home = path.join(root, "home");
  const sessionsDir = path.join(root, "sessions");
  const logsDir = path.join(root, "logs");
  for (const dir of [home, sessionsDir, logsDir]) fs.mkdirSync(dir, { recursive: true });
  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");
  roots.push(root);
  return { root, agentDir, home, sessionsDir, logsDir, logFile: path.join(logsDir, "bridge.log"), mcpShellConfig };
}

/**
 * 程序化生成「事故形态」会话：header + 若干 message 行（含 400KB+ 巨行）。
 * 行形状与假引擎 readEntriesFromFile 的映射一致（{type,id,timestamp,message}），
 * 因此 get_entries 的 RPC 响应单行字节数 ≈ 文件总字节（差 header 一行 + 包装字段）。
 * @returns {{file:string, entries:number, totalBytes:number, maxLineBytes:number, leafId:string}}
 */
function generateSession(fixture, { totalTargetBytes, giantCount = 6, giantTextBytes = 420 * 1024, fillerTextBytes = 22 * 1024 }) {
  const sessionId = "2026-11-25T00-13-00-000Z-oversize-fixture";
  const ts = "2026-11-25T00:13:00.000Z";
  const file = path.join(fixture.sessionsDir, `${sessionId}.jsonl`);
  const header = { type: "session", version: 3, id: sessionId, timestamp: ts, cwd: fixture.home };
  const bytes = (row) => Buffer.byteLength(JSON.stringify(row), "utf8") + 1; // +换行
  let total = bytes(header);
  let maxLine = total;
  const rows = [];
  const addRow = (textBytes) => {
    const i = rows.length + 1;
    const row = {
      type: "message",
      id: `${sessionId}-msg-${i}`,
      timestamp: ts,
      message: { role: i % 2 === 0 ? "assistant" : "user", content: [{ type: "text", text: "x".repeat(textBytes) }] },
    };
    rows.push(row);
    const b = bytes(row);
    total += b;
    maxLine = Math.max(maxLine, b);
  };

  for (let i = 0; i < giantCount; i++) addRow(giantTextBytes); // 巨行（事故最大单行 456KB 的同量级）
  while (total + fillerTextBytes + 160 < totalTargetBytes) addRow(fillerTextBytes); // 普通行铺到接近目标
  const remain = totalTargetBytes - total;
  if (remain > 400) addRow(remain - 160); // 收尾行：贴住目标字节

  const lines = [JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { file, entries: rows.length, totalBytes: total, maxLineBytes: maxLine, leafId: rows[rows.length - 1].id };
}

/** 起一座夹具桥（env 合并 extraEnv），返回 {child, fixture, logFile}；health 就绪后 resolve */
async function startBridge(tag, extraEnv = {}) {
  const fixture = buildFixture(tag);
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: fixture.root,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_AGENT_DIR: fixture.agentDir,
      PI_SHELL_SESSIONS_DIR: fixture.sessionsDir,
      PI_SHELL_AGENT_SESSIONS_DIR: "",
      PI_SHELL_MCP_CONFIG: fixture.mcpShellConfig,
      PI_SHELL_ORIGINS_FILE: path.join(fixture.root, "sessions-origins.json"),
      PI_SHELL_LOG_DIR: fixture.logsDir,
      PI_SHELL_LOG_FILE: fixture.logFile,
      PI_SHELL_CWD: fixture.home,
      PI_SHELL_MAX_ENGINES: "2",
      PI_SHELL_IDLE_MS: "300000", // 别让引擎在 30s 超时等待期间被空闲回收（默认 60s）
      PI_SHELL_PI_BIN: "",
      FAKE_STATE: JSON.stringify({ sessionFile: null }), // 引擎空转无会话，open 后走后台接管
      FAKE_LOG: path.join(fixture.root, "fake-engine.log"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  const myStderr = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", () => {});
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (myStderr.length < 4000) myStderr.push(chunk);
    if (stderrText.length < 4000) stderrText += chunk; // 顶层 catch 汇报用
  });

  const ready = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { "x-pi-shell-client": CLIENT } });
      const json = await res.json();
      return { ok: json?.pi?.state === "idle", state: json?.pi?.state };
    } catch {
      return { ok: false, state: "unreachable" };
    }
  });
  if (!ready.ok) throw new Error(`桥(${tag})未就绪 state=${ready.state}; stderr: ${myStderr.join("").slice(0, 500)}`);
  return { child, fixture, logFile: fixture.logFile };
}

async function stopBridge(child) {
  if (!child || child.exitCode !== null) return;
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
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); // PID 树兜底
    } catch {}
  }
}

// ---------- 场景 A：默认 32MiB，10.5MiB 会话接管成功 ----------
async function scenarioA() {
  const { child, fixture, logFile } = await startBridge("a");
  const target = 10.5 * MiB;
  const session = generateSession(fixture, { totalTargetBytes: Math.floor(target) });
  check(
    "A1 夹具会话复刻事故形态（~10MiB / 350+ 条 / 含 400KB+ 巨行）",
    session.totalBytes > 8.5 * MiB && session.totalBytes < 31 * MiB && session.entries >= 350 && session.maxLineBytes >= 400 * 1024,
    `total=${(session.totalBytes / MiB).toFixed(2)}MiB entries=${session.entries} maxLine=${Math.round(session.maxLineBytes / 1024)}KB`,
  );

  const open1 = await api("/api/session/open", { method: "POST", body: { path: session.file } });
  check(
    "A2 首次 open → HTTP 200，文件直读 entries 条数正确",
    open1.status === 200 && open1.json?.entries?.length === session.entries && open1.json?.sessionId === "2026-11-25T00-13-00-000Z-oversize-fixture",
    `status=${open1.status} mode=${open1.json?.mode} attach=${open1.json?.attach} entries=${open1.json?.entries?.length}/${session.entries}`,
  );

  const attached = await waitForLog(logFile, "|info|session_attached|", { ms: 30000 });
  const logA = readLog(logFile);
  check(
    "A3 后台接管成功（switch_session + get_entries 走通，session_attached 落日志）",
    attached.ok,
    attached.ok ? logA.split("\n").find((l) => l.includes("|session_attached|"))?.slice(0, 180) : "30s 内未见 session_attached",
  );
  const overlongA = overlongBytes(logA);
  check(
    "A4 桥日志无 pi_line_skipped reason=overlong、无 pi_request_timeout",
    overlongA.length === 0 && !logA.includes("|pi_request_timeout|"),
    `overlong=${overlongA.length} timeout=${logA.includes("|pi_request_timeout|")}`,
  );

  const open2 = await api("/api/session/open", { method: "POST", body: { path: session.file } });
  check(
    "A5 二次 open 走复用路径：get_entries 的 ~10.5MiB 单行 RPC 响应原样过解码器（attach=attached）",
    open2.status === 200 && open2.json?.attach === "attached" && open2.json?.mode === "live" && open2.json?.entries?.length === session.entries && open2.json?.leafId === session.leafId,
    `status=${open2.status} mode=${open2.json?.mode} attach=${open2.json?.attach} entries=${open2.json?.entries?.length}/${session.entries}`,
  );
  await stopBridge(child);
}

// ---------- 场景 B：PI_SHELL_MAX_LINE_BYTES=1048576（1MiB）→ attach 必失败 ----------
async function scenarioB() {
  const { child, fixture, logFile } = await startBridge("b", { PI_SHELL_MAX_LINE_BYTES: "1048576" });
  const session = generateSession(fixture, { totalTargetBytes: Math.floor(10.5 * MiB) });
  const open = await api("/api/session/open", { method: "POST", body: { path: session.file } });
  check(
    "B1 1MiB 上限下 open 仍 HTTP 200（文件直读不受 RPC 行上限影响）",
    open.status === 200 && open.json?.entries?.length === session.entries,
    `status=${open.status} entries=${open.json?.entries?.length}/${session.entries}`,
  );

  // get_entries 的 ~10.5MiB 响应被丢 → 桥等 30s 超时 → session_attach_failed code=TIMEOUT
  const failed = await waitForLog(logFile, "|session_attach_failed|", { ms: 45000 });
  const logB = readLog(logFile);
  const overlongB = overlongBytes(logB);
  check(
    "B2 同会话 attach 必失败（30s 请求超时，session_attach_failed code=TIMEOUT）",
    failed.ok && logB.includes("code=TIMEOUT"),
    failed.ok ? logB.split("\n").find((l) => l.includes("|session_attach_failed|"))?.slice(0, 200) : "45s 内未见 session_attach_failed",
  );
  check(
    "B3 丢弃路径行为不变：overlong 行被丢（进入丢弃态时已缓冲字节 > 1MiB 上限）且记 pi_request_timeout",
    overlongB.some((b) => b > 1048576) && logB.includes("pi_request_timeout"),
    `overlongBytes=${overlongB.map((b) => `${(b / MiB).toFixed(2)}MiB`).join(",") || "无"} timeout=${logB.includes("pi_request_timeout")}`,
  );
  check("B4 无 session_attached（失败即失败，不静默降级）", !logB.includes("|info|session_attached|"), `session_attached=${logB.includes("|info|session_attached|")}`);
  await stopBridge(child);
}

// ---------- 场景 C：PI_SHELL_MAX_LINE_BYTES=abc（非法）→ 桥仍启动 + warn 回退 ----------
async function scenarioC() {
  const { child, logFile } = await startBridge("c", { PI_SHELL_MAX_LINE_BYTES: "abc" });
  const logC = readLog(logFile);
  check(
    "C1 非法值 → 桥仍启动（health idle）",
    true, // startBridge 已在 health idle 后才返回，到这里就是启动成功
    "health=idle（startBridge 内已等待）",
  );
  check(
    "C2 日志出现 warn 回退记录（raw=abc，不静默）",
    logC.includes("|warn|pi_max_line_bytes_invalid|") && /raw=abc/.test(logC) && /fallback=33554432/.test(logC),
    logC.split("\n").find((l) => l.includes("pi_max_line_bytes_invalid"))?.slice(0, 160) || "未见该日志",
  );
  await stopBridge(child);
}

// ---------- 场景 D：~34MiB 会话 + 默认 32MiB → 仍被丢（保护底线） ----------
async function scenarioD() {
  const { child, fixture, logFile } = await startBridge("d");
  const session = generateSession(fixture, { totalTargetBytes: Math.floor(34 * MiB) });
  check(
    "D1 夹具会话 ~33MiB（大于 32MiB 上限，DoD 4）",
    session.totalBytes > 33 * MiB && session.totalBytes < 36 * MiB,
    `total=${(session.totalBytes / MiB).toFixed(2)}MiB entries=${session.entries}`,
  );
  const open = await api("/api/session/open", { method: "POST", body: { path: session.file } });
  check("D2 open → HTTP 200（view：文件直读）", open.status === 200, `status=${open.status}`);

  const failed = await waitForLog(logFile, "|session_attach_failed|", { ms: 45000 });
  const logD = readLog(logFile);
  const overlongD = overlongBytes(logD);
  check(
    "D3 默认 32MiB 下 ~34MiB get_entries 响应仍被丢（日志有 overlong bytes>32MiB）",
    failed.ok && overlongD.some((b) => b > 32 * MiB),
    `overlongBytes=${overlongD.map((b) => `${(b / MiB).toFixed(2)}MiB`).join(",") || "无"}`,
  );
  check("D4 接管失败而非静默（session_attach_failed + 无 session_attached）", failed.ok && !logD.includes("|info|session_attached|"), `attached=${logD.includes("|info|session_attached|")}`);
  await stopBridge(child);
}

async function main() {
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（不按命令行批量杀，先确认是谁）`);
  console.log(`bridge-port=${PORT}（不占 7788）`);
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
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
  for (const child of children) await stopBridge(child); // PID 树清理收尾
  for (const root of roots) await fsp.rm(root, { recursive: true, force: true });
}
process.exit(exitCode);
