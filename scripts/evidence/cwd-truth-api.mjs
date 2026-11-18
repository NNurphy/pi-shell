#!/usr/bin/env node
// T2 证据脚本：会话 cwd 真相回写（端点级，真 pi）
//
// 做法：真实 pi 子进程 + **夹具会话目录**（PI_SHELL_SESSIONS_DIR）。
// 从 `~/.pi/agent/sessions/` 任一含 .jsonl 的分组里**只读**挑一条会话，复制进夹具，
// 然后打开它，断言 /api/health 的 pi.cwd == 该会话 header 的 cwd（不再是引擎创建时的旧值）。
//
// 纪律：端口固定 7832（被占直接 FAIL，不换端口）；不碰真实会话目录（只读一条文件）；
// 收尾按 PID 关自己起的桥，夹具目录整个删掉。
//
// 用法：node scripts/evidence/cwd-truth-api.mjs
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
// 通用化：任选一个含 .jsonl 的分组（不依赖特定目录名）
const SESSIONS_ROOT = path.join(AGENT_DIR, "sessions");
const SOURCE_DIR = (() => {
  try {
    return (
      fs
        .readdirSync(SESSIONS_ROOT, { withFileTypes: true })
        .filter((d) => {
          if (!d.isDirectory()) return false;
          try {
            return fs.readdirSync(path.join(SESSIONS_ROOT, d.name)).some((n) => n.endsWith(".jsonl"));
          } catch {
            return false;
          }
        })
        .map((d) => path.join(SESSIONS_ROOT, d.name))[0] ?? ""
    );
  } catch {
    return "";
  }
})();
const PORT = 7832;
const CLIENT = "evidence-cwd";

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

async function waitFor(fn, ms, step = 100) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last?.ok) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last ?? { ok: false };
}

const samePath = (a, b) => typeof a === "string" && typeof b === "string" && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-cwd-truth-evi-")));
let child = null;
let exitCode = 1;

try {
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（不换端口，先清掉占用者）`);
  if (!fs.existsSync(SOURCE_DIR)) throw new Error(`找不到会话目录：${SOURCE_DIR}`);

  // 1) 只读挑一条真实会话（最新 mtime），复制进夹具
  const source = fs
    .readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(SOURCE_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!source) throw new Error(`没有可用的会话文件：${SOURCE_DIR}`);
  const header = JSON.parse(fs.readFileSync(source, "utf8").split("\n")[0]);
  const expectedCwd = header.cwd;
  check("会话 header 带 cwd", typeof expectedCwd === "string" && expectedCwd.length > 0, `${path.basename(source)} → ${expectedCwd}`);

  const sessionsDir = path.join(tmpRoot, "sessions");
  const fixtureDir = path.join(sessionsDir, path.basename(SOURCE_DIR));
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixtureSession = path.join(fixtureDir, path.basename(source));
  await fsp.copyFile(source, fixtureSession);

  const home = path.join(tmpRoot, "home");
  fs.mkdirSync(home, { recursive: true });
  const mcpConfig = path.join(tmpRoot, "pi-shell-mcp.json");
  fs.writeFileSync(mcpConfig, `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");
  check("初始工作区（PI_SHELL_CWD）≠ 会话 cwd", !samePath(home, expectedCwd), `${home} vs ${expectedCwd}`);

  // 2) 起桥（真 pi，夹具会话目录 + 空 MCP 配置）
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
      PI_SHELL_LOG_FILE: path.join(tmpRoot, "logs", "bridge.log"),
      PI_SHELL_CWD: home,
      PI_SHELL_MAX_ENGINES: "2",
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

  const before = (await api("/api/health", { client: CLIENT })).json;
  check("打开会话前 health.pi.cwd == 初始工作区", samePath(before.pi.cwd, home), `pi.cwd=${before.pi.cwd}`);

  // 3) 打开会话：响应 cwd 是 header cwd，接管完成后 health.pi.cwd 必须追平
  const opened = await api("/api/session/open", { method: "POST", client: CLIENT, body: { path: fixtureSession } });
  check("POST /api/session/open 200", opened.status === 200, opened.text.slice(0, 200));
  check("/api/session/open 响应 cwd == 会话 header cwd", samePath(opened.json?.cwd, expectedCwd), `cwd=${opened.json?.cwd}`);

  const synced = await waitFor(async () => {
    const { json } = await api("/api/health", { client: CLIENT });
    return { ok: samePath(json?.pi?.cwd, expectedCwd), json };
  }, 30000);
  const after = synced.json ?? (await api("/api/health", { client: CLIENT })).json;
  check("attach 后 health.pi.cwd == 会话 header cwd（不再陈旧）", samePath(after?.pi?.cwd, expectedCwd), `pi.cwd=${after?.pi?.cwd}`);
  check("health.pi.cwd 与 /api/session/open 的 cwd 一致", samePath(after?.pi?.cwd, opened.json?.cwd), `${after?.pi?.cwd} == ${opened.json?.cwd}`);

  // 4) 新建会话：沿用运行时 cwd，响应带 cwd
  const created = await api("/api/session/new", { method: "POST", client: CLIENT });
  check("POST /api/session/new 200", created.status === 200, created.text.slice(0, 200));
  check("new_session 响应带 cwd == 运行时 cwd（会话目录）", samePath(created.json?.cwd, expectedCwd), `cwd=${created.json?.cwd}`);
  const afterNew = (await api("/api/health", { client: CLIENT })).json;
  check("new_session 后 health.pi.cwd 不回退", samePath(afterNew?.pi?.cwd, expectedCwd), `pi.cwd=${afterNew?.pi?.cwd}`);

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
