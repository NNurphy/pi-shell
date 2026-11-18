#!/usr/bin/env node
// 日志轮转集成证据（N2，不需要浏览器）
//
// 两段：
//   A. 手动入口：写 12MB 到 logs/bridge.log → `node scripts/rotate-logs.mjs`
//      → 断言 bridge.log 变小、存在 .1、目录总大小 ≤ 13MB、日志里有 log_rotated。
//   B. 桥启动整理：logs/ 下 launcher/notify/mcp 各写超限内容 + bridge.log 超限
//      → 以 79xx 端口起一次桥（异步整理，不挡启动）→ health 就绪后断言
//        三个日志都生成 .1、bridge.log 由写入路径轮转、bridge.log 有 log_rotate_scan。
//
// 全程只碰 %TMP%\pi-shell-log-rotate-ui\，不写真实 logs/、不碰 7788。
// 产出：docs/evidence/log-rotate.txt（本次实测数字）
// 退出码：0 = 全部断言通过

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatBytes } from "../../bridge/src/log.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-log-rotate-ui");
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail: detail || "" });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function writeMB(file, mb, preamble = "") {
  const bytes = Math.floor(mb * MB);
  const body = Buffer.alloc(Math.max(0, bytes - Buffer.byteLength(preamble)), 0x61);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(preamble, "utf8"), body]));
  return fs.statSync(file).size;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(dir, entry.name)).size;
  }
  return total;
}

function fmt(n) {
  return formatBytes(n);
}

function exitCodeOf(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopBridge(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await exitCodeOf(child, 5000);
  if (!exited) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/F", "/T"], { stdio: "ignore" });
    await exitCodeOf(child, 3000);
  }
}

async function freePort() {
  for (let port = 7901; port <= 7960; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("找不到空闲的 79xx 端口");
}

async function waitHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return await res.json();
    } catch {}
    await sleep(150);
  }
  return null;
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

// ---------- A. 手动入口 ----------
function phaseManual() {
  const dir = path.join(OUT_DIR, "logs-manual");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "bridge.log");
  const written = writeMB(file, 12, "pre-rotation filler\n");
  check("A1 预置 12MB bridge.log", written === 12 * MB, fmt(written));

  const run = spawnSync(process.execPath, ["scripts/rotate-logs.mjs", "--dir", dir, "--max-mb", "5", "--keep", "5"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  check("A2 rotate-logs 退出码 0", run.status === 0, `exit=${run.status} ${(run.stderr || "").trim()}`);
  console.log((run.stdout || "").trimEnd());

  const baseSize = fs.statSync(file).size;
  const rotatedPath = `${file}.1`;
  const hasOne = fs.existsSync(rotatedPath);
  const oneSize = hasOne ? fs.statSync(rotatedPath).size : 0;
  const total = dirSize(dir);

  check("A3 bridge.log 变小（≠12MB）", baseSize < 1 * MB, `${fmt(baseSize)}`);
  check("A4 存在 bridge.log.1 且内容为原 12MB", hasOne && oneSize === written, hasOne ? fmt(oneSize) : "missing");
  check("A5 目录总大小 ≤ 13MB", total <= 13 * MB, fmt(total));
  const baseText = fs.readFileSync(file, "utf8");
  check("A6 新 bridge.log 有 log_rotated 行", /log_rotated/.test(baseText), baseText.trim().slice(0, 120));
  check("A7 未生成多余历史（只一次轮转）", !fs.existsSync(`${file}.2`), `files=${fs.readdirSync(dir).join(",")}`);
  return [{ dir, written, baseSize, total, stdout: (run.stdout || "").trim() }];
}

// ---------- B. 桥启动整理 ----------
async function phaseStartup() {
  const dir = path.join(OUT_DIR, "logs-startup");
  fs.mkdirSync(dir, { recursive: true });

  const launcher = path.join(dir, "launcher.log");
  const notify = path.join(dir, "notify.log");
  const mcp = path.join(dir, "mcp.log");
  const bridge = path.join(dir, "bridge.log");
  const sizes = {
    launcher: writeMB(launcher, 8, "launcher filler\n"),
    notify: writeMB(notify, 6, "notify filler\n"),
    mcp: writeMB(mcp, 6, "mcp filler\n"),
    bridge: writeMB(bridge, 12, "bridge filler\n"),
  };

  const port = await freePort();
  const child = spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(port),
      PI_SHELL_BIND: "127.0.0.1",
      PI_SHELL_LOG_DIR: dir,
      PI_SHELL_LOG_MAX_MB: "5",
      PI_SHELL_LOG_KEEP: "2",
      // 空 agentDir → pi 解析失败但不 spawn 引擎（本段只验证日志整理）
      PI_SHELL_AGENT_DIR: path.join(OUT_DIR, "agent-empty"),
      PI_SHELL_SESSIONS_DIR: path.join(OUT_DIR, "sessions"),
      PI_SHELL_CWD: path.join(OUT_DIR, "ws"),
      PI_SHELL_ORIGINS_FILE: path.join(OUT_DIR, "origins.json"),
      PI_SHELL_MCP_CONFIG: path.join(OUT_DIR, "mcp.json"),
    },
    stdio: "ignore",
  });
  try {
    const health = await waitHealth(port);
    check("B1 桥在 79xx 就绪（异步整理不挡启动）", Boolean(health), health ? `port=${port} pi=${JSON.stringify(health.pi?.state ?? health.pi)}` : `port=${port} health 超时`);

    const expected = [
      ["launcher.log", launcher],
      ["notify.log", notify],
      ["mcp.log", mcp],
      ["bridge.log", bridge],
    ];
    const ready = await waitFor(() => expected.every(([, file]) => fs.existsSync(`${file}.1`)));
    check("B2 launcher/notify/mcp/bridge 都生成了 .1", ready, expected.map(([n, f]) => `${n}:${fs.existsSync(`${f}.1`)}`).join(" "));

    for (const [name, file] of expected) {
      const base = fs.existsSync(file) ? fs.statSync(file).size : -1;
      const one = fs.existsSync(`${file}.1`) ? fs.statSync(`${file}.1`).size : -1;
      check(
        `B3 ${name} 轮转后 base 变小 / .1 保留原大小`,
        base >= 0 && base < 64 * 1024 && one === sizes[name.replace(".log", "")],
        `base=${fmt(base)} .1=${one >= 0 ? fmt(one) : "missing"}`,
      );
    }
    const bridgeText = fs.readFileSync(bridge, "utf8");
    check("B4 bridge.log 有 log_rotate_scan（启动整理记录）", /log_rotate_scan/.test(bridgeText), bridgeText.split("\n").filter((l) => /log_rotate_scan|log_rotated/.test(l)).slice(0, 3).join(" || "));
    check("B5 bridge.log 有写入路径的 log_rotated 行", /log_rotated\|from=.*bridge\.log/.test(bridgeText), "写入前检查大小 → 轮转 → 再写");
    return [{ dir, port, sizes, launcherBase: fs.statSync(launcher).size }];
  } finally {
    await stopBridge(child);
  }
}

function writeEvidence(manual, startup) {
  const m = manual[0];
  const s = startup[0];
  const lines = [
    "N2 日志按大小轮转 · 集成证据（scripts/evidence/log-rotate-ui.mjs）",
    `生成时间：${new Date().toISOString()}`,
    "",
    "A. 手动入口（scripts/rotate-logs.mjs）",
    `  目录：${m.dir}`,
    `  预置 bridge.log=${fmt(m.written)} → 轮转后 base=${fmt(m.baseSize)}，目录总大小=${fmt(m.total)}`,
    "  命令输出：",
    ...m.stdout.split("\n").map((line) => `    ${line}`),
    "",
    "B. 桥启动整理（launcher / notify / mcp / bridge，异步不挡启动）",
    `  目录：${s.dir}（port=${s.port}，PI_SHELL_LOG_MAX_MB=5，PI_SHELL_LOG_KEEP=2）`,
    `  预置：launcher=${fmt(s.sizes.launcher)} notify=${fmt(s.sizes.notify)} mcp=${fmt(s.sizes.mcp)} bridge=${fmt(s.sizes.bridge)}`,
    `  结果：launcher.log.1 / notify.log.1 / mcp.log.1 / bridge.log.1 均存在，base 只剩轮转行（${fmt(s.launcherBase)} 级别）`,
    "",
    `结论：${results.filter((r) => r.pass).length}/${results.length} 项断言通过`,
    ...results.map((r) => `  ${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`),
    "",
  ];
  const out = path.join(REPO_ROOT, "docs", "evidence", "log-rotate.txt");
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`\n[evidence] 写入 ${out}`);
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, "agent-empty"), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, "ws"), { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "mcp.json"), `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");

  const manual = phaseManual();
  const startup = await phaseStartup();
  writeEvidence(manual, startup);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
