#!/usr/bin/env node
// v1.0.0 证据脚本：会话记忆**持久化**（桥重启后第一次认领也能接回原会话）
//
// 事故（v1.0.0 发布前开发期的尾巴）：重连恢复用的记忆表 lastSessionByClient 只在桥的进程内存里。
// 修这条尾巴要**重启桥**才生效——桥一重启记忆就没了，第一次重连只能靠前端 openSession 兜底，
// 服务端不再保证「同一会话里连续对话」。
//
// 做法（真 pi 子进程 + 夹具会话目录，从 ~/.pi/agent/sessions 只读复制一条会话）：
//   1) 起桥 A（PI_SHELL_IDLE_MS=3000，夹具会话目录 + PI_SHELL_LAST_SESSIONS_FILE 指向夹具）；
//   2) session/open 夹具会话 → 确认 sidecar 已写入且含该 client 记录（结构 version/sessions/updatedAt）；
//   3) **杀掉桥 A**，起桥 B（同端口、同夹具、同 sidecar）；
//   4) 同一 clientId 连桥 B 并 claim（不 open）→ 断言 health.pi.cwd、/api/session/view 的 sessionFile、
//      日志 engine_restored + session_memory_hit（桥重启后第一次认领命中记忆）；
//   5) 反例：把会话文件删掉后再重启桥 → engine_restore_failed code=NOT_FOUND、
//      sidecar 里该条被移除、桥不崩（health 200 + 引擎 idle）。
//
// 纪律：端口默认 7839，门禁可用 PI_SHELL_PORT 顺延（本脚本必须独占所选端口）；
//       不碰真实会话目录（只读复制一条）；
// 收尾按自己记录的 PID 关桥，夹具目录整个删掉。
//
// 用法：node scripts/evidence/session-memory-persist-api.mjs
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
// 端口可被门禁顺延：PI_SHELL_PORT（默认 7839）
const PORT = Number(process.env.PI_SHELL_PORT || 7839);
const CLIENT = "evidence-session-memory";
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

async function waitFor(fn, ms, step = 250) {
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

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-session-memory-evi-")));
const children = [];
let exitCode = 1;

/** 起一台桥（同一个夹具、同一个 sidecar 路径）；返回 child + 日志读取器 */
function startBridge(label) {
  const logFile = path.join(tmpRoot, "logs", `${label}.log`);
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_AGENT_DIR: AGENT_DIR,
      PI_SHELL_SESSIONS_DIR: fixture.sessionsDir,
      PI_SHELL_AGENT_SESSIONS_DIR: "",
      PI_SHELL_MCP_CONFIG: fixture.mcpConfig,
      PI_SHELL_ORIGINS_FILE: path.join(tmpRoot, "sessions-origins.json"),
      PI_SHELL_LAST_SESSIONS_FILE: fixture.lastSessionsFile,
      PI_SHELL_LOG_DIR: path.join(tmpRoot, "logs"),
      PI_SHELL_LOG_FILE: logFile,
      PI_SHELL_CWD: fixture.home,
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_IDLE_MS: String(IDLE_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const handle = {
    label,
    child,
    logFile,
    stderr: "",
    readLog: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""),
  };
  child.stdout.on("data", () => {});
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (handle.stderr.length < 4000) handle.stderr += chunk;
  });
  children.push(handle);
  return handle;
}

async function waitReady(bridge) {
  const ready = await waitFor(async () => {
    try {
      const { status, json } = await api("/api/health", { client: CLIENT });
      return { ok: status === 200 && json?.pi?.state === "idle", json };
    } catch {
      return { ok: false };
    }
  }, 45000);
  check(`桥 ${bridge.label} 就绪（pi idle）`, ready.ok, `state=${ready.json?.pi?.state ?? "n/a"} pid=${ready.json?.pi?.pid ?? "n/a"}`);
  return ready.ok;
}

/** 按 PID 关自己起的桥，并等端口释放（不按命令行批量杀） */
async function stopBridge(bridge) {
  const child = bridge.child;
  if (!child || bridge.stopped) return;
  bridge.stopped = true;
  const pid = child.pid;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  const freed = await waitFor(async () => ({ ok: await portFree(PORT) }), 15000, 200);
  console.log(`INFO  收尾：已按 PID 关闭桥 ${bridge.label}（pid=${pid}）${freed.ok ? "" : "（端口仍被占用）"}`);
}

function readSidecar() {
  try {
    return JSON.parse(fs.readFileSync(fixture.lastSessionsFile, "utf8"));
  } catch {
    return null;
  }
}

const fixture = {
  sessionsDir: path.join(tmpRoot, "sessions"),
  home: path.join(tmpRoot, "home"),
  mcpConfig: path.join(tmpRoot, "pi-shell-mcp.json"),
  lastSessionsFile: path.join(tmpRoot, "pi-shell-last-sessions.json"),
  sessionFile: "",
  project: "",
};

try {
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（不换端口，先清掉占用者）`);

  const source = pickSourceSession();
  if (!source) throw new Error(`找不到可用会话：${SESSIONS_ROOT}（可读且 header.cwd 存在）`);
  check("挑到夹具来源会话", true, `${path.basename(source.file)} → cwd=${source.cwd}`);
  fixture.project = source.cwd;

  const fixtureDir = path.join(fixture.sessionsDir, path.basename(path.dirname(source.file)));
  fs.mkdirSync(fixtureDir, { recursive: true });
  fixture.sessionFile = path.join(fixtureDir, path.basename(source.file));
  await fsp.copyFile(source.file, fixture.sessionFile);
  fs.mkdirSync(fixture.home, { recursive: true });
  fs.writeFileSync(fixture.mcpConfig, `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");
  check("夹具齐备（会话 / 工作区 / MCP 空配置 / sidecar 路径）", true, tmpRoot);

  // ---------- 1) 桥 A：打开会话 → 记忆落盘 ----------
  const bridgeA = startBridge("bridge-a");
  if (!(await waitReady(bridgeA))) throw new Error("桥 A 未就绪，后续断言无意义");

  const opened = await api("/api/session/open", { method: "POST", client: CLIENT, body: { path: fixture.sessionFile } });
  check("桥 A POST /api/session/open 200", opened.status === 200, opened.text.slice(0, 200));
  const attached = await waitFor(async () => {
    const { json } = await api("/api/health", { client: CLIENT });
    return { ok: samePath(json?.pi?.cwd, fixture.project), json };
  }, 30000);
  check("桥 A 接管完成：health.pi.cwd == 会话 header cwd", attached.ok, `pi.cwd=${attached.json?.pi?.cwd}`);
  const viewA = await api("/api/session/view", { client: CLIENT });
  check("桥 A 打开后 sessionFile == 夹具会话", samePath(viewA.json?.sessionFile, fixture.sessionFile), `sessionFile=${viewA.json?.sessionFile}`);

  const sidecarWritten = await waitFor(async () => {
    const doc = readSidecar();
    return { ok: Boolean(doc?.sessions?.[CLIENT]), doc };
  }, 15000);
  check("sidecar 已写入且含该 client 记录（去抖 ≤ 数秒）", sidecarWritten.ok, fixture.lastSessionsFile);
  const docA = sidecarWritten.doc ?? {};
  check("sidecar 结构 version=1 + updatedAt 为 ISO + sessions 对象", docA.version === 1 && Number.isFinite(Date.parse(docA.updatedAt)) && Boolean(docA.sessions), `version=${docA.version} updatedAt=${docA.updatedAt}`);
  const recA = docA.sessions?.[CLIENT] ?? {};
  check(
    "sidecar 记录的是元数据（path/cwd/model/thinkingLevel/at）",
    samePath(recA.path, fixture.sessionFile) && samePath(recA.cwd, fixture.project) && typeof recA.at === "number" && "model" in recA && "thinkingLevel" in recA,
    JSON.stringify({ path: recA.path, cwd: recA.cwd, at: recA.at, model: recA.model, thinkingLevel: recA.thinkingLevel }),
  );

  // ---------- 2) 杀桥 A → 起桥 B（同端口/同夹具/同 sidecar）----------
  await stopBridge(bridgeA);
  const bridgeB = startBridge("bridge-b");
  if (!(await waitReady(bridgeB))) throw new Error("桥 B 未就绪，后续断言无意义");
  check("桥 B 启动后 sidecar 记忆仍在（进程内存不是唯一来源）", Boolean(readSidecar()?.sessions?.[CLIENT]), fixture.lastSessionsFile);

  // 4) 同一 clientId 第一次认领（不 open）：桥 B 的引导引擎被认领后必须按记忆恢复原会话
  const claimedB = await api("/api/engine/claim", { method: "POST", client: CLIENT, body: { client: CLIENT } });
  check("桥 B 重连 POST /api/engine/claim 200", claimedB.status === 200, claimedB.text.slice(0, 200));

  const hitLogged = await waitFor(async () => {
    const line = bridgeB.readLog().split("\n").find((l) => l.includes("|session_memory_hit|"));
    return { ok: Boolean(line), line };
  }, 30000);
  check("桥 B 日志出现 session_memory_hit（重启后第一次认领命中记忆）", hitLogged.ok, hitLogged.line ?? "");

  const restored = await waitFor(async () => {
    const { status, json } = await api("/api/session/view", { client: CLIENT });
    return { ok: status === 200 && samePath(json?.sessionFile, fixture.sessionFile), status, json };
  }, 45000);
  check("桥 B（无 open，只 claim）session/view 的 sessionFile == 原会话文件", restored.ok, `sessionFile=${restored.json?.sessionFile}`);

  const healthB = await waitFor(async () => {
    const { json } = await api("/api/health", { client: CLIENT });
    return { ok: samePath(json?.pi?.cwd, fixture.project), json };
  }, 30000);
  check("桥 B health.pi.cwd == 原会话 cwd（不是 PI_SHELL_CWD）", healthB.ok, `pi.cwd=${healthB.json?.pi?.cwd} 期望=${fixture.project}`);
  check("桥 B 引擎 idle（可继续对话）", healthB.json?.pi?.state === "idle", `state=${healthB.json?.pi?.state}`);

  const restoredLine = await waitFor(async () => {
    const line = bridgeB.readLog().split("\n").find((l) => l.includes("|engine_restored|"));
    return { ok: Boolean(line), line };
  }, 30000);
  check("桥 B 日志出现 engine_restored", restoredLine.ok, restoredLine.line ?? "");

  // ---------- 3) 反例：删掉会话文件后再重启桥 → NOT_FOUND + 记忆移除 + 不崩 ----------
  await stopBridge(bridgeB);
  await fsp.rm(fixture.sessionFile, { force: true });
  const bridgeC = startBridge("bridge-c");
  if (!(await waitReady(bridgeC))) throw new Error("桥 C 未就绪，后续断言无意义");

  const claimedC = await api("/api/engine/claim", { method: "POST", client: CLIENT, body: { client: CLIENT } });
  check("桥 C（会话文件已删）claim 仍 200，失败在后台明确报告", claimedC.status === 200, claimedC.text.slice(0, 200));

  const failedLine = await waitFor(async () => {
    const line = bridgeC.readLog().split("\n").find((l) => l.includes("|engine_restore_failed|"));
    return { ok: Boolean(line), line };
  }, 45000);
  check("桥 C 日志出现 engine_restore_failed（不得静默）", failedLine.ok, failedLine.line ?? "");
  check("失败码 NOT_FOUND", /code=NOT_FOUND/.test(failedLine.line ?? ""), failedLine.line ?? "");

  const removed = await waitFor(async () => {
    const doc = readSidecar();
    return { ok: Boolean(doc) && !doc.sessions?.[CLIENT], doc };
  }, 15000);
  check(
    "sidecar 里该 client 记录已被移除（避免下次重连反复撞同一失败）",
    removed.ok,
    JSON.stringify(removed.doc?.sessions ?? null),
  );

  const healthC = await waitFor(async () => {
    const { status, json } = await api("/api/health", { client: CLIENT });
    return { ok: status === 200 && json?.pi?.state === "idle", status, json };
  }, 30000);
  check("恢复失败后桥 C 不崩（health 200 + 引擎 idle）", healthC.ok, `status=${healthC.status} state=${healthC.json?.pi?.state}`);

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  check("脚本执行", false, `${err?.message || String(err)}${err?.stack ? `\n${String(err.stack).split("\n").slice(1, 4).join("\n")}` : ""}`);
  exitCode = 1;
} finally {
  for (const bridge of children) {
    try {
      await stopBridge(bridge);
    } catch (err) {
      console.log(`WARN  收尾关桥失败 ${bridge.label}: ${err?.message || String(err)}`);
    }
    if (bridge.stderr && results.some((r) => !r.ok)) console.log(`INFO  桥 ${bridge.label} stderr：${bridge.stderr.slice(0, 600)}`);
  }
  await fsp.rm(tmpRoot, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} PASS · 夹具 ${tmpRoot} 已清理`);
  process.exit(exitCode);
}