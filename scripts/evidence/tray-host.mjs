#!/usr/bin/env node
// 证据：pi-shell 托盘程序（tray-host）
//
// 取证目标（全部给原始输出，不靠口述；夹具端口首选 7841，绝不碰 7788）：
//   A0 setup-windows.ps1：pi-shell.lnk 指托盘入口（powershell + tray-pi-shell.ps1 +
//      WindowStyle=7 最小化），重启 pi-shell.lnk 目标不变；真实桌面前后清单一致
//   S1 冷启动：起 tray（隐藏）→ /api/health 转 ok；cmd 启动器在且无主窗口（MainWindowTitle 为空）
//   S2 引擎数采样：tray.log 出现 engines=N/M 行 ≥2 条，相邻两次采样间隔 ≤5s
//   S3 单实例（已有托盘）：第二个 tray 干净退出（留日志），不产生第二个 cmd
//   S4 重启动作（命令行 -Action restart，与菜单同一条代码路径）：
//      端口短暂不可达 → 恢复 ok；旧 supervisor cmd 树死、新 cmd 起；tray 常驻进程不退
//   S5 停止动作（命令行 -Action stop）：cmd/node/pi 按枚举断言全灭，托盘进程退出，端口释放
//   S6 单实例（端口已活、无托盘）：手动 cmd 起桥后起 tray → 转监控态（留日志），不产生第二个 cmd
//   S7 监控态托盘上的 stop：全灭 + 托盘退出（对 S6 的桥收尾）
//   S8 本卡零运行时改动：git diff --stat <基线> -- bridge/src web/src 为空
//
// 铁律：夹具桥独立端口（7841 起，占则顺延）；PI_SHELL_SESSIONS_DIR / MCP 配置 /
//   桥日志全部指临时夹具；PI_SHELL_NO_BROWSER=1（夹具绝不开浏览器）；收尾只按
//   自己记录的 PID 树杀（kill-tree.ps1），禁止按命令行模式批量杀。
//
// 用法：node scripts/evidence/tray-host.mjs
// 退出码：0 = 全部通过

import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readModelConfig } from "../model-config.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-tray-evidence");
const SESSIONS = path.join(OUT_DIR, "sessions");
const MCP_CONFIG = path.join(OUT_DIR, "pi-shell-mcp.json");
const BRIDGE_LOG = path.join(OUT_DIR, "bridge.log");
const TRAY_LOG = path.join(REPO_ROOT, "logs", "tray.log");
const TRAY_SIGNAL = path.join(REPO_ROOT, "logs", "tray.signal");
const TRAY_SCRIPT = path.join(REPO_ROOT, "scripts", "tray-pi-shell.ps1");
const START_CMD = path.join(REPO_ROOT, "scripts", "start-pi-shell.cmd");
const BASELINE = "HEAD"; // 基线：与 HEAD 比对（本卡不动运行时）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 基础设施 ----------
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
async function waitFor(label, fn, timeoutMs, intervalMs = 500) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor(${label}) timeout ${timeoutMs}ms`);
}

// 端口探测：纯 Node，不依赖 netstat
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}
async function choosePort() {
  for (let i = 0; i < 10; i++) {
    const cand = 7841 + i;
    if (cand === 7788) continue;
    if (await portFree(cand)) return cand;
  }
  throw new Error("ports 7841..7850 all busy");
}

const PORT = await choosePort();
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`[fixture] port=${PORT} sessions=${SESSIONS}`);

// 夹具 env：模型唯一来源 model-config（同 test-gate 口径）；MCP 空配置；不开浏览器
const { provider, model } = readModelConfig();
fs.mkdirSync(SESSIONS, { recursive: true });
fs.writeFileSync(MCP_CONFIG, `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");
const FIXTURE_ENV = {
  ...process.env,
  PI_SHELL_PORT: String(PORT),
  PI_SHELL_SESSIONS_DIR: SESSIONS,
  PI_SHELL_MCP_CONFIG: MCP_CONFIG,
  PI_SHELL_LOG_FILE: BRIDGE_LOG,
  PI_SHELL_NO_BROWSER: "1",
  ...(provider ? { PI_SHELL_PROVIDER: provider } : {}),
  ...(model ? { PI_SHELL_MODEL: model } : {}),
};

async function health() {
  try {
    const res = await fetch(`${BASE}/api/health`, { cache: "no-store" });
    const body = await res.json();
    return body?.ok ? body : null;
  } catch { return null; }
}

// PowerShell -EncodedCommand（UTF-16LE base64）
function psEncode(cmd) { return Buffer.from(cmd, "utf16le").toString("base64"); }
function runPowerShell(cmd, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", psEncode(cmd)], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    sleep(timeoutMs).then(() => { try { p.kill(); } catch {} });
  });
}

// 全进程表（Win32_Process：pid/ppid/name/commandLine）
async function enumerateProcesses() {
  const r = await runPowerShell(
    `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  );
  try {
    const j = JSON.parse(r.out);
    return Array.isArray(j) ? j : [j];
  } catch { return []; }
}
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// 夹具 supervisor cmd：cmd.exe 且命令行含 start-pi-shell.cmd 且带本 worktree 路径。
// （tray 拉起的带 PI_SHELL_PORT=<port> 前缀；手动起夹具 cmd 的端口走 env 不在命令行；
//   生产 7788 的 cmd 用主仓路径，不含 worktree 路径，天然排除。）
const FIXTURE_ROOT = REPO_ROOT.replaceAll("\\", "/").toLowerCase();
function fixtureCmds(procs) {
  return procs.filter((p) => {
    if (p.Name !== "cmd.exe") return false;
    const cl = (p.CommandLine || "").replaceAll("\\", "/").toLowerCase();
    return cl.includes("start-pi-shell.cmd") && cl.includes(FIXTURE_ROOT);
  });
}
function mainWindowTitle(pid) {
  return runPowerShell(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowTitle`, 30000);
}
function netstatListenPids(port) {
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", timeout: 30000 });
    const pids = [];
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
      if (!parts[1].endsWith(`:${port}`)) continue;
      const pid = Number(parts[4]);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
    return [...new Set(pids)];
  } catch { return []; }
}

// 进程包装（记录 PID，收尾统一按 PID 树杀）
const spawned = [];
function spawnTray() {
  const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", TRAY_SCRIPT, "-Port", String(PORT)],
    { cwd: REPO_ROOT, env: FIXTURE_ENV, stdio: "ignore", windowsHide: true });
  spawned.push(p.pid);
  return p;
}
function spawnAction(action) {
  let exitInfo = null;
  const promise = new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", TRAY_SCRIPT, "-Port", String(PORT), "-Action", action],
      { cwd: REPO_ROOT, env: FIXTURE_ENV, stdio: "ignore", windowsHide: true });
    spawned.push(p.pid);
    p.on("exit", (code) => { exitInfo = { code, pid: p.pid }; resolve(exitInfo); });
    sleep(90000).then(() => { try { p.kill(); } catch {} });
  });
  return { promise, get done() { return exitInfo !== null; } };
}
function spawnManualCmd() {
  // PI_SHELL_PORT 已在夹具 env（start-pi-shell.cmd 只在未定义时设默认值）；
  // 不用 `set X=..&& call "带引号路径"`：node 的 Windows quoting 会把内嵌引号
  // 转义成 backslash-quote，cmd.exe 不认，call 路径解析失败、桥从未启动。
  if (/\s/.test(START_CMD)) throw new Error(`fixture path has spaces, cannot spawn cmd safely: ${START_CMD}`);
  const p = spawn(process.env.ComSpec || "cmd.exe", ["/c", `call ${START_CMD}`],
    { cwd: REPO_ROOT, env: FIXTURE_ENV, stdio: "ignore", windowsHide: true });
  spawned.push(p.pid);
  return p;
}

function trayLogLines() {
  try {
    return fs.readFileSync(TRAY_LOG, "utf8").split("\n").filter((l) => l.includes(" | "));
  } catch { return []; }
}
function trayLogHas(substr) {
  return trayLogLines().some((l) => l.includes(substr));
}

async function waitExit(p, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (p.exitCode !== null) return true;
    await sleep(300);
  }
  return p.exitCode !== null;
}

// 真实桌面 .lnk 清单（只读，前后比对）
async function realDesktopLnks() {
  const res = await runPowerShell(
    `[System.IO.Directory]::EnumerateFiles([Environment]::GetFolderPath('Desktop'), '*.lnk') | ForEach-Object { Split-Path $_ -Leaf } | Sort-Object | ConvertTo-Json -Compress`
  );
  return res.out.trim();
}

// ---------- A0：setup-windows.ps1（临时目录，真实桌面零写入） ----------
console.log("\n== A0 setup-windows.ps1：pi-shell.lnk 指托盘入口 ==");
const desktopDir = path.join(OUT_DIR, "desktop");
fs.mkdirSync(desktopDir, { recursive: true });
const desktopBefore = await realDesktopLnks();
console.log(`  真实桌面 .lnk（前）：${desktopBefore || "(无)"}`);

const psPath = path.join(REPO_ROOT, "scripts", "setup-windows.ps1");
const r0 = await runPowerShell(`& '${psPath.replaceAll("'", "''")}' -DesktopDir '${desktopDir.replaceAll("'", "''")}'`);
check("A0a setup 退出码 0", r0.code === 0, `code=${r0.code} out: ${r0.out.trim().slice(-260)}`);
console.log(r0.out.trim());

const psExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
for (const name of ["pi-shell.lnk", "重启 pi-shell.lnk"]) {
  const read = await runPowerShell(
    `$sh = New-Object -ComObject WScript.Shell; $l = $sh.CreateShortcut('${path.join(desktopDir, name).replaceAll("'", "''")}'); ` +
    `[PSCustomObject]@{ TargetPath = $l.TargetPath; Arguments = $l.Arguments; WindowStyle = $l.WindowStyle; WorkingDirectory = $l.WorkingDirectory; IconLocation = $l.IconLocation } | ConvertTo-Json -Compress`
  );
  let parsed = null;
  try { parsed = JSON.parse(read.out); } catch {}
  const norm = (p) => (p || "").replaceAll("\\", "/").toLowerCase();
  if (name === "pi-shell.lnk") {
    const ok = parsed && norm(parsed.TargetPath) === norm(psExe)
      && norm(parsed.Arguments).includes("tray-pi-shell.ps1")
      && parsed.Arguments.includes("-ExecutionPolicy Bypass")
      && parsed.WindowStyle === 7
      && norm(parsed.WorkingDirectory) === norm(REPO_ROOT)
      && norm(parsed.IconLocation) === norm(`${path.join(REPO_ROOT, "web", "icons", "pi-shell.ico")},0`);
    check("A0b pi-shell.lnk → 托盘入口（powershell + tray-pi-shell.ps1 + 最小化 + 图标）", !!ok,
      parsed ? `Target=${parsed.TargetPath} | Args=${parsed.Arguments} | WinStyle=${parsed.WindowStyle} | Icon=${parsed.IconLocation}` : `无 JSON：${read.out.trim().slice(0, 200)} ${read.err}`);
  } else {
    const ok = parsed && norm(parsed.TargetPath) === norm(path.join(REPO_ROOT, "scripts", "restart-pi-shell.cmd"))
      && !parsed.Arguments
      && norm(parsed.IconLocation) === norm(`${path.join(REPO_ROOT, "web", "icons", "pi-shell.ico")},0`);
    check("A0c 重启 pi-shell.lnk 目标不变（restart-pi-shell.cmd，无参数）", !!ok,
      parsed ? `Target=${parsed.TargetPath} | Args=${parsed.Arguments || "(空)"}` : `无 JSON：${read.out.trim().slice(0, 200)} ${read.err}`);
  }
}
const desktopAfterA0 = await realDesktopLnks();
check("A0d 真实桌面 .lnk 前后一致", desktopBefore === desktopAfterA0);

// ---------- S1：冷启动（tray 拉桥，隐藏 supervisor） ----------
console.log("\n== S1 冷启动：起 tray → health ok；cmd 无主窗口 ==");
fs.rmSync(TRAY_LOG, { force: true });
fs.rmSync(TRAY_SIGNAL, { force: true });

const tray1 = spawnTray();
try {
  const h = await waitFor("health ok (idle)", async () => {
    const b = await health();
    return b && b.pi && b.pi.state === "idle" ? b : null;
  }, 60000, 500);
  check("S1a /api/health 转 ok（pi idle）", true, `pi.pid=${h.pi.pid} state=${h.pi.state}`);
  const procs1 = await enumerateProcesses();
  const cmds1 = fixtureCmds(procs1);
  check("S1b supervisor cmd 存在（隐藏拉起）", cmds1.length === 1,
    `count=${cmds1.length} :: ${cmds1.map((c) => `pid=${c.ProcessId} cmd=${(c.CommandLine || "").slice(0, 90)}`).join(" ; ")}`);
  if (cmds1.length === 1) {
    const wt = await mainWindowTitle(cmds1[0].ProcessId);
    check("S1c cmd 启动器无主窗口（MainWindowTitle 为空）", wt.code === 0 && (wt.out.trim() === "" || wt.out.trim() === "''" || wt.out.trim() === '""'),
      `MainWindowTitle=${JSON.stringify(wt.out.trim())}`);
  }
  check("S1d 托盘进程存活", tray1.exitCode === null, `powershell pid=${tray1.pid}`);
} catch (e) {
  check("S1a /api/health 转 ok（pi idle）", false, String(e.message));
}

// ---------- S2：引擎数采样 ----------
console.log("\n== S2 引擎数采样（tray.log，间隔 ≤5s） ==");
try {
  const lines = await waitFor(">=2 sample lines", async () => {
    const ls = trayLogLines().filter((l) => l.includes("tray sample engines="));
    return ls.length >= 2 ? ls : null;
  }, 20000, 500);
  const stamps = lines.map((l) => Date.parse(l.split(" | ")[0]));
  const gaps = [];
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1]);
  const maxGap = Math.max(...gaps);
  const minGap = Math.min(...gaps);
  const fmt = lines.every((l) => /tray sample engines=\d+\/\d+ health=ok/.test(l) || /tray sample engines=-\/- health=down/.test(l));
  check("S2a 引擎数采样行 ≥2 条（0 引擎也算数）", true, lines.map((l) => l.split(" | ")[1]).slice(0, 4).join(" ⏎ "));
  check("S2b 相邻两次采样间隔 ≤5s", maxGap <= 5000, `gaps=[${gaps.join(",")}]ms max=${maxGap}ms`);
  check("S2c 采样行格式 engines=N/M", fmt, lines[0]);
} catch (e) {
  check("S2a 引擎数采样行 ≥2 条", false, String(e.message));
}

// ---------- S3：单实例（已有托盘 → Mutex 命中） ----------
console.log("\n== S3 单实例：已有托盘时第二个 tray 干净退出 ==");
try {
  const before = await enumerateProcesses();
  const cmdCountBefore = fixtureCmds(before).length;
  const tray2 = spawnTray();
  const exited = await waitExit(tray2, 10000);
  check("S3a 第二个托盘进程干净退出", exited && tray2.exitCode === 0, `exitCode=${tray2.exitCode}`);
  await sleep(1000);
  check("S3b 日志留痕 second-instance", trayLogHas("second-instance exit"), trayLogLines().filter((l) => l.includes("second-instance")).slice(-1)[0] || "(无)");
  const after = await enumerateProcesses();
  const cmdCountAfter = fixtureCmds(after).length;
  check("S3c 不产生第二个 cmd", cmdCountAfter === cmdCountBefore, `before=${cmdCountBefore} after=${cmdCountAfter}`);
  check("S3d 第一个托盘仍在跑", tray1.exitCode === null, `tray1 pid=${tray1.pid}`);
} catch (e) {
  check("S3a 第二个托盘进程干净退出", false, String(e.message));
}

// ---------- S4：重启动作（命令行 -Action restart，与菜单同一条代码路径） ----------
console.log("\n== S4 重启动作：端口短暂不可达 → 恢复 ok ==");
try {
  const procsBefore = await enumerateProcesses();
  const oldCmdPids = fixtureCmds(procsBefore).map((c) => c.ProcessId);
  const hBefore = await health();
  check("S4a 重启前 health ok", !!hBefore, hBefore ? `pi.pid=${hBefore.pi.pid}` : "health down");

  const actionP = spawnAction("restart");
  let sawDown = false, lastOk = null, downAt = null, okAt = null;
  const t0 = Date.now();
  while (!actionP.done) {
    const h = await health();
    if (!h && (Date.now() - t0) > 3000) { if (!sawDown) { sawDown = true; downAt = Date.now(); } }
    else if (h) { lastOk = h; okAt = Date.now(); }
    await sleep(250);
    if (Date.now() - t0 > 70000) break;
  }
  const action = await actionP.promise;
  check("S4b -Action restart 退出码 0", action.code === 0, `code=${action.code}`);
  check("S4c 端口短暂不可达（树杀窗口被捕捉）", sawDown, sawDown ? `down at +${downAt - t0}ms` : "未捕捉到 down（窗口被错过）");
  check("S4d 恢复 ok（新桥 health）", !!lastOk, lastOk ? `ok at +${okAt - t0}ms pi.pid=${lastOk.pi.pid}` : "从未 ok");
  check("S4e 托盘日志记录 restart", trayLogHas("tray restart ok"), trayLogLines().filter((l) => l.includes("restart")).slice(-2).join(" ⏎ ") || "(无)");
  const procsAfter = await enumerateProcesses();
  const newCmds = fixtureCmds(procsAfter);
  const oldDead = oldCmdPids.every((pid) => !alive(pid));
  check("S4f 旧 supervisor cmd 树已死", oldDead, `old=[${oldCmdPids.join(",")}] dead=${oldDead}`);
  check("S4g 新 supervisor cmd 已起（隐藏）", newCmds.length === 1, `new=[${newCmds.map((c) => c.ProcessId).join(",")}]`);
  check("S4h 常驻托盘进程未退出（restart 不杀托盘）", tray1.exitCode === null, `tray1 pid=${tray1.pid}`);
} catch (e) {
  check("S4b -Action restart 退出码 0", false, String(e.message));
}

// ---------- S5：停止动作（-Action stop：全灭 + 托盘退出） ----------
console.log("\n== S5 停止动作：cmd/node/pi 全灭，托盘进程退出 ==");
try {
  const procsBefore = await enumerateProcesses();
  const cmdPids = fixtureCmds(procsBefore).map((c) => c.ProcessId);
  // 夹具桥 = 占用夹具端口的 LISTENING owner（同机可能有生产 7788 桥，绝不按命令行误抓）
  const bridgePids = netstatListenPids(PORT);
  const hBefore = await health();
  const piPid = hBefore?.pi?.pid || null;
  console.log(`  目标：cmd=[${cmdPids}] bridge=[${bridgePids}] pi=${piPid}`);

  const action = await spawnAction("stop").promise;
  check("S5a -Action stop 退出码 0", action.code === 0, `code=${action.code}`);
  await sleep(500);
  const procsAfter = await enumerateProcesses();
  const cmdDead = fixtureCmds(procsAfter).length === 0;
  const bridgeDead = bridgePids.every((pid) => !alive(pid)) && netstatListenPids(PORT).length === 0;
  const piDead = piPid ? !alive(piPid) : true;
  check("S5b supervisor cmd 全灭（枚举）", cmdDead, `剩余=${JSON.stringify(fixtureCmds(procsAfter).map((c) => c.ProcessId))}`);
  check("S5c node 桥全灭（枚举 + 端口释放）", bridgeDead, `bridge=[${bridgePids}] listenPids=${JSON.stringify(netstatListenPids(PORT))}`);
  check("S5d pi 引擎全灭（枚举）", piDead, `pi=${piPid} alive=${piPid ? alive(piPid) : "n/a"}`);
  const healthDown = (await health()) === null;
  check("S5e 端口已停（health 不可达）", healthDown);
  const tray1Gone = await waitExit(tray1, 12000);
  check("S5f 托盘进程退出（图标随进程消失）", tray1Gone === true, `tray1 pid=${tray1.pid} exitCode=${tray1.exitCode}`);
  check("S5g 托盘日志记录 stop", trayLogHas("tray exit (stop)"), trayLogLines().filter((l) => l.includes("stop")).slice(-3).join(" ⏎ ") || "(无)");
} catch (e) {
  check("S5a -Action stop 退出码 0", false, String(e.message));
}

// ---------- S6：单实例（端口已活、无托盘 → 监控态） ----------
console.log("\n== S6 单实例：端口已活时 tray 转监控态（不拉第二个 cmd） ==");
let manualCmd = null, tray3 = null;
try {
  manualCmd = spawnManualCmd();
  const h = await waitFor("manual bridge health", () => health(), 60000, 500);
  check("S6a 手动 cmd 起桥 health ok", !!h, h ? `pi.pid=${h.pi.pid}` : "health down");
  const procsBefore = await enumerateProcesses();
  const manualCmdPid = fixtureCmds(procsBefore).map((c) => c.ProcessId);
  check("S6b 手动 supervisor cmd 唯一", manualCmdPid.length === 1, `cmd=[${manualCmdPid}]`);

  tray3 = spawnTray();
  await sleep(5000);
  check("S6c 日志留痕 monitor（转监控态）", trayLogHas("tray monitor"), trayLogLines().filter((l) => l.includes("tray monitor")).slice(-1)[0] || "(无)");
  const procsAfter = await enumerateProcesses();
  const cmdsNow = fixtureCmds(procsAfter).map((c) => c.ProcessId);
  check("S6d 不产生第二个 cmd（仍 1 个，同 PID）", cmdsNow.length === 1 && cmdsNow[0] === manualCmdPid[0], `before=[${manualCmdPid}] after=[${cmdsNow}]`);
  check("S6e 监控态托盘存活且 health ok", tray3.exitCode === null && !!(await health()), `tray3 pid=${tray3.pid}`);
} catch (e) {
  check("S6a 手动 cmd 起桥 health ok", false, String(e.message));
}

// ---------- S7：监控态托盘上的 stop（收尾） ----------
console.log("\n== S7 监控态托盘 -Action stop：全灭 + 托盘退出 ==");
try {
  const procsBefore = await enumerateProcesses();
  const cmdPid = fixtureCmds(procsBefore).map((c) => c.ProcessId)[0] || null;
  const bridgePid = netstatListenPids(PORT)[0] || null;
  const h = await health();
  const piPid = h?.pi?.pid || null;
  console.log(`  目标：cmd=${cmdPid} bridge=${bridgePid} pi=${piPid}`);

  const action = await spawnAction("stop").promise;
  check("S7a -Action stop 退出码 0", action.code === 0, `code=${action.code}`);
  await sleep(500);
  const procsAfter = await enumerateProcesses();
  const cmdDead = fixtureCmds(procsAfter).length === 0;
  const bridgeDead = netstatListenPids(PORT).length === 0 && (bridgePid ? !alive(bridgePid) : true);
  const piDead = piPid ? !alive(piPid) : true;
  check("S7b supervisor cmd / node 桥 / pi 全灭", cmdDead && bridgeDead && piDead,
    `cmdDead=${cmdDead} listen=${JSON.stringify(netstatListenPids(PORT))} bridgeAlive=${bridgePid ? alive(bridgePid) : "n/a"} piAlive=${piPid ? alive(piPid) : "n/a"}`);
  const tray3Gone = tray3 ? await waitExit(tray3, 12000) : false;
  check("S7c 托盘进程退出", tray3Gone === true, `tray3 pid=${tray3?.pid} exitCode=${tray3?.exitCode}`);
  const healthDown = (await health()) === null;
  check("S7d 端口已停", healthDown);
} catch (e) {
  check("S7a -Action stop 退出码 0", false, String(e.message));
}

// ---------- S8：本卡零运行时改动 ----------
console.log("\n== S8 运行时零改动（git diff --stat 基线 -- bridge/src web/src） ==");
{
  const diff = await new Promise((resolve) => {
    const p = spawn("git", ["diff", "--stat", BASELINE, "--", "bridge/src", "web/src"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => resolve({ code, out, err }));
  });
  check(`S8a git diff --stat ${BASELINE.slice(0, 7)} -- bridge/src web/src 为空`, diff.code === 0 && diff.out.trim() === "",
    `stdout: ${JSON.stringify(diff.out.trim())} stderr: ${diff.err.trim().slice(0, 200)}`);
}

// ---------- 收尾：只按自己记录的 PID 树杀 + 删夹具 ----------
console.log(`\n== 清理（按 PID 树杀，禁止按命令行批量杀） ==`);
for (const pid of spawned) {
  if (alive(pid)) {
    await runPowerShell(`powershell -NoProfile -File "${path.join(REPO_ROOT, "scripts", "kill-tree.ps1").replaceAll('"', '`"')}" -RootPid ${pid}`, 30000);
  }
}
const leftover = netstatListenPids(PORT);
if (leftover.length) {
  console.log(`[cleanup] 端口 ${PORT} 仍被占（PID ${leftover.join(",")}），按 PID 树杀兜底`);
  for (const pid of leftover) {
    await runPowerShell(`powershell -NoProfile -File "${path.join(REPO_ROOT, "scripts", "kill-tree.ps1").replaceAll('"', '`"')}" -RootPid ${pid}`, 30000);
  }
}
fs.rmSync(TRAY_SIGNAL, { force: true });
fs.rmSync(TRAY_LOG, { force: true });
fs.rmSync(OUT_DIR, { recursive: true, force: true });
console.log("[cleanup] 夹具目录已删，tray.log/tray.signal 已清");

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL  ${f.name}  — ${f.detail || ""}`);
  process.exit(1);
}
process.exit(0);
