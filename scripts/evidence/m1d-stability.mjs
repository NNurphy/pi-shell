#!/usr/bin/env node
// N-03 稳定性观测：bridge RSS + 页面 JS heap，每 30 分钟一次，共 2 小时（03 §12 / N-03）
// 用法：node scripts/evidence/m1d-stability.mjs [--hours 2] [--interval-min 30] [--port 7791]
// 产出：%TMP%\pi-shell-stability\samples.csv + summary.txt，退出码 0 = 达标
// 判据：① 每个采样点 bridge RSS < 250MB；② 末次 RSS − 首次 RSS < 50MB（无单调增长）；③ 页面 heap 末−首 < 50MB

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const PORT = arg("port", 7791);
const HOURS = arg("hours", 2);
const INTERVAL_MIN = arg("interval-min", 30);
const argStr = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : def;
};
const OUT = (() => {
  const name = argStr("out", "pi-shell-stability");
  return path.isAbsolute(name) ? name : path.join(os.tmpdir(), name);
})();
const BASE = `http://127.0.0.1:${PORT}`;
const SAMPLES = Math.round((HOURS * 60) / INTERVAL_MIN) + 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  return ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p)) || null;
}
async function freePort(start) {
  const net = await import("node:net");
  for (let port = start; port < start + 100; port++) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (ok) return port;
  }
  throw new Error("无空闲端口");
}
function psRss(pid) {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`], { encoding: "utf8" }).trim();
  return out ? Math.round(Number(out) / 1024 / 1024) : null;
}
function kill(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } catch {}
}

async function main() {
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {}
  await fsp.mkdir(OUT, { recursive: true });
  const sessionsDir = path.join(OUT, "sessions");
  await fsp.mkdir(sessionsDir, { recursive: true });

  const bridge = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_SESSIONS_DIR: sessionsDir, PI_SHELL_CWD: os.homedir(), PI_SHELL_LOG_FILE: path.join(OUT, "bridge.log") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) logs.push(l);
  });

  for (let i = 0; i < 300; i++) {
    try {
      const h = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
      if (h.pi.state === "idle") break;
    } catch {}
    await sleep(150);
  }

  // 页面（用于观测标签内存）
  const edgePath = findEdge();
  const debugPort = await freePort(PORT + 100);
  let edge = null;
  let cdp = null;
  if (edgePath) {
    edge = spawn(edgePath, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(OUT, "edge")}`, `${BASE}/`], { stdio: "ignore" });
    for (let i = 0; i < 80 && !cdp; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
        const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
        if (t) {
          const ws = new WebSocket(t.webSocketDebuggerUrl);
          await new Promise((res, rej) => {
            ws.addEventListener("open", res);
            ws.addEventListener("error", rej);
          });
          let id = 0;
          const pending = new Map();
          ws.addEventListener("message", (ev) => {
            const m = JSON.parse(ev.data);
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            p(m.result);
          });
          cdp = {
            send: (method, params = {}) =>
              new Promise((res) => {
                const mid = ++id;
                const timer = setTimeout(() => {
                  pending.delete(mid);
                  res(null);
                }, 5000);
                pending.set(mid, (v) => {
                  clearTimeout(timer);
                  res(v);
                });
                try {
                  ws.send(JSON.stringify({ id: mid, method, params }));
                } catch {
                  clearTimeout(timer);
                  res(null);
                }
              }),
          };
          await cdp.send("Page.enable");
          await cdp.send("Performance.enable");
          await sleep(1000);
        }
      } catch {}
      if (!cdp) await sleep(250);
    }
  }

  async function heapMb() {
    if (!cdp) return null;
    try {
      const r = await cdp.send("Performance.getMetrics");
      const used = r?.metrics?.find((m) => m.name === "JSHeapUsedSize")?.value;
      return used ? Math.round(used / 1024 / 1024) : null;
    } catch {
      return null;
    }
  }

  const rows = [];
  const pid = bridge.pid;
  const startedAt = Date.now();
  for (let i = 0; i < SAMPLES; i++) {
    const due = startedAt + i * INTERVAL_MIN * 60 * 1000;
    while (Date.now() < due - 2000) await sleep(Math.min(10000, due - Date.now()));
    const rss = psRss(pid);
    const heap = await heapMb();
    const row = {
      at: new Date().toISOString(),
      minute: Math.round((Date.now() - startedAt) / 60000),
      plannedMinute: i * INTERVAL_MIN,
      bridgeRssMb: rss,
      pageHeapMb: heap,
    };
    rows.push(row);
    console.log(`[${row.minute}min/plan ${row.plannedMinute}] bridge RSS=${rss}MB page heap=${heap ?? "n/a"}MB`);
    await fsp.writeFile(
      path.join(OUT, "samples.csv"),
      ["at,minute,plannedMinute,bridgeRssMb,pageHeapMb", ...rows.map((r) => `${r.at},${r.minute},${r.plannedMinute},${r.bridgeRssMb},${r.pageHeapMb ?? ""}`)].join("\n") + "\n",
    );
  }

  const first = rows[0].bridgeRssMb;
  const last = rows[rows.length - 1].bridgeRssMb;
  const maxRss = Math.max(...rows.map((r) => r.bridgeRssMb ?? 0));
  const heaps = rows.map((r) => r.pageHeapMb).filter((n) => typeof n === "number");
  const maxHeap = heaps.length ? Math.max(...heaps) : null;
  const heapDelta = heaps.length >= 2 ? heaps[heaps.length - 1] - heaps[0] : null;

  const checks = [
    ["bridge RSS 全程 < 250MB", maxRss < 250, `max=${maxRss}MB`],
    ["bridge RSS 末−首 < 50MB（无单调增长）", last - first < 50, `${first}→${last}MB (Δ${last - first})`],
    ["页面 heap 末−首 < 50MB", heapDelta === null ? true : heapDelta < 50, heapDelta === null ? "无页面采样" : `Δ${heapDelta}MB (max ${maxHeap}MB)`],
  ];
  let failed = 0;
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}  — ${detail}`);
    if (!pass) failed += 1;
  }
  await fsp.writeFile(path.join(OUT, "summary.txt"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n\n" + checks.map(([n, p, d]) => `${p ? "PASS" : "FAIL"}  ${n}  — ${d}`).join("\n") + "\n");

  try {
    edge?.kill("SIGKILL");
  } catch {}
  kill(pid);
  await sleep(2000);
  await fsp.writeFile(path.join(OUT, "bridge.log"), logs.join("\n"));
  console.log(`产出：${OUT}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
