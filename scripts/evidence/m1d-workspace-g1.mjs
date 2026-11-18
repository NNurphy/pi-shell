#!/usr/bin/env node
// M1-D 证据：T-15 工作区切换 + G1-6 进程树（①切工作区 3 次无残留；②正常退出后无残留）
//
// 用法：node scripts/evidence/m1d-workspace-g1.mjs   （端口需空闲；需要本机 python 用于发送控制台中断）
// 产出：%TMP%\pi-shell-m1d\summary.txt，退出码 0 = 全通过
//
// 第五批注：顶部「工作区」UI 按钮已移除（左侧会话列表已能直达所有项目）。
// 本脚本本来就只走 HTTP（POST /api/workspace），不点 UI，所以端点与脚本用法不变。

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-m1d");
const SESSIONS = path.join(OUT, "sessions");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function psOut(script) {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
function kill(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } catch {}
}
function piPids(marker) {
  const out = psOut(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId`);
  return out ? out.split(/\s+/).map(Number) : [];
}
function alive(pid) {
  return psOut(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id`) === String(pid);
}
async function post(url, body) {
  const res = await fetch(`${BASE}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
async function health(port = PORT) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" })).json()).pi;
}
async function waitIdle(port = PORT, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const pi = await health(port);
      if (pi.state === "idle") return pi;
    } catch {}
    await sleep(120);
  }
  throw new Error("等待 idle 超时");
}
function startBridge(env = {}) {
  const logs = [];
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_SESSIONS_DIR: SESSIONS, PI_SHELL_CWD: os.homedir(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) logs.push(l);
  });
  return { child, logs };
}

const PY_NORMAL_EXIT = `import json, os, signal, subprocess, sys, time
cfg = json.loads(sys.argv[1])
env = dict(os.environ); env.update(cfg["env"])
p = subprocess.Popen(cfg["argv"], cwd=cfg["cwd"], env=env, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
ready = False
t0 = time.time()
while time.time() - t0 < 40:
    try:
        import urllib.request
        with urllib.request.urlopen(cfg["health"], timeout=1) as r:
            if json.load(r)["pi"]["state"] == "idle":
                ready = True
                break
    except Exception:
        pass
    time.sleep(0.2)
os.kill(p.pid, signal.CTRL_BREAK_EVENT)
try:
    out, _ = p.communicate(timeout=20)
    code = p.returncode
except subprocess.TimeoutExpired:
    p.kill(); out, _ = p.communicate(); code = "timeout"
print(json.dumps({"ready": ready, "exitCode": code, "bridgePid": p.pid, "tail": (out or "")[-2000:]}))
`;

async function main() {
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {}
  await fsp.mkdir(SESSIONS, { recursive: true });
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    check(`端口 ${PORT} 空闲`, false, "已有 bridge 在跑");
    process.exit(1);
  } catch {}

  const b = startBridge();
  const chain = [];
  try {
    const first = await waitIdle();
    chain.push(first.pid);
    const beforeSessions = await (await fetch(`${BASE}/api/sessions`)).json();
    const beforeCount = beforeSessions.groups.flatMap((g) => g.sessions).length;

    // ① 切工作区 3 次，每次记录 pid 链并检查"旧 pid 消失 + 只剩 1 个 pi 子进程"
    // 通用化：目标目录由脚本自建（中文 cwd / 含空格 cwd / 普通目录），不依赖特定真实目录
    const targets = [path.join(os.homedir(), "pi-shell-测试项目"), path.join(os.homedir(), "pi-shell test project"), path.join(os.homedir(), "pi-shell-demo-project")];
    for (const t of targets) await fsp.mkdir(t, { recursive: true });
    let allGood = true;
    for (let i = 0; i < targets.length; i++) {
      const oldPid = (await health()).pid;
      const r = await post("/api/workspace", { cwd: targets[i] });
      const pi = await waitIdle();
      const children = piPids("pi-shell-m1d");
      const oldGone = !alive(oldPid);
      chain.push(pi.pid);
      const ok = r.status === 200 && String(r.data?.cwd ?? "").replace(/\\/g, "/").toLowerCase() === targets[i].toLowerCase() && oldGone && children.length === 1 && children[0] === pi.pid;
      allGood = allGood && ok;
      check(`切工作区 #${i + 1}（${targets[i].split("/").pop()}）`, ok, `pid ${oldPid} → ${pi.pid}；children=${children.join(",")}；oldGone=${oldGone}`);
      const afterSessions = await (await fetch(`${BASE}/api/sessions`)).json();
      const afterCount = afterSessions.groups.flatMap((g) => g.sessions).length;
      if (afterCount < beforeCount) allGood = false;
      if (i === 2) check("切换后旧会话仍在列表（数量不减）", afterCount >= beforeCount, `${beforeCount} → ${afterCount}`);
    }
    check("G1-6①  切工作区 3 次无残留（每次只剩 1 个 pi，旧 pid 全部消失）", allGood, `pid 链 ${chain.join(" → ")}`);

    // 切换后语义：cwd 生效 + 当前为空会话（未发消息不落盘）
    const cur = await health();
    check("切换后 health.cwd == 目标目录", cur.cwd.replace(/\\/g, "/").toLowerCase() === targets[2].toLowerCase(), cur.cwd);

    // streaming 中拒绝切换
    await post("/api/prompt", { message: "请写一篇 800 字的文章，主题：进程与线程的区别。不要用工具。" });
    let streamingSeen = null;
    for (let i = 0; i < 100 && !streamingSeen; i++) {
      const pi = await health();
      if (pi.state === "streaming") streamingSeen = pi;
      else await sleep(120);
    }
    const refused = await post("/api/workspace", { cwd: targets[0] });
    check("streaming 中切换工作区 → 503 PI_NOT_READY", !!streamingSeen && refused.status === 503 && refused.data?.error?.code === "PI_NOT_READY", `${refused.status} ${refused.data?.error?.code ?? ""}`);
    await post("/api/abort");
    await waitIdle();
  } finally {
    kill(b.child.pid);
    await sleep(2500);
  }

  // ② 正常退出（控制台中断 = Ctrl+C/Ctrl+Break 同一路径）后无残留
  const pyFile = path.join(OUT, "normal-exit.py");
  await fsp.writeFile(pyFile, PY_NORMAL_EXIT, "utf8");
  const exitLog = path.join(OUT, "normal-exit-bridge.log");
  const cfg = {
    argv: [process.execPath, path.join(REPO_ROOT, "bridge/src/index.mjs")],
    cwd: REPO_ROOT,
    env: { PI_SHELL_PORT: String(PORT), PI_SHELL_SESSIONS_DIR: SESSIONS, PI_SHELL_CWD: os.homedir(), PI_SHELL_LOG_FILE: exitLog },
    health: `${BASE}/api/health`,
  };
  const py = spawn("python", [pyFile, JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "pipe"] });
  let pyOut = "";
  py.stdout.on("data", (d) => (pyOut += String(d)));
  py.stderr.on("data", (d) => (pyOut += String(d)));
  await new Promise((r) => py.on("exit", r));
  let parsed = null;
  try {
    parsed = JSON.parse(pyOut.trim().split("\n").pop());
  } catch {}
  await sleep(2500);
  const leftover = piPids("pi-shell-m1d");
  check(
    "G1-6②  正常退出（控制台中断）→ 桥 exit 0 且无残留 pi",
    !!parsed && parsed.exitCode === 0 && leftover.length === 0,
    parsed ? `ready=${parsed.ready} exit=${parsed.exitCode} 残留=${leftover.length}` : pyOut.slice(0, 200),
  );
  const exitLogText = fs.existsSync(exitLog) ? fs.readFileSync(exitLog, "utf8") : "";
  check("G1-6②  退出时 shutdown 日志可见", /shutdown/.test(exitLogText), exitLogText.split("\n").filter((l) => /shutdown|pi_state/.test(l)).slice(-2).join(" | "));

  const failed = results.filter((r) => !r.pass);
  await fsp.writeFile(path.join(OUT, "summary.txt"), results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`).join("\n") + "\n");
  console.log(`\n${results.length - failed.length}/${results.length} PASS；产出：${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
