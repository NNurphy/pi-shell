#!/usr/bin/env node
// M2-C 证据（二）：真实任务演示（网页完成两条只读任务）
//   ① 会话列表统计（只读：不发消息、不写文件）
//   ② 运行状态查看（只读：不改任何设置）
// 说明：演示「网页里完成真实任务」只跑只读分支，不产生对外动作。
//
// 用法：node scripts/evidence/m2c-real-task.mjs   （端口需空闲；需要 Edge；会真实调用模型）
// 产出：%TMP%\pi-shell-m2c\real-task\summary.txt + task1.png / task2.png + 对话文本

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-m2c", "real-task");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? process.argv[i + 1] : "";
})();
const CHECK_ONLY = process.argv.includes("--check");
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function kill(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } catch {}
}
function portPid(port) {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: "utf8" }).trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}
async function getJson(url) {
  const res = await fetch(`${BASE}${url}`, { cache: "no-store" });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  return ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p)) || null;
}
async function freePort(start) {
  const net = await import("node:net");
  for (let port = start; port < start + 120; port++) {
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
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    p(m.result);
  });
  const ready = new Promise((res) => ws.addEventListener("open", res));
  return {
    ready,
    send: (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); }),
    close: () => ws.close(),
  };
}
async function evaluate(cdp, expr, awaitPromise = true) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true, timeout: 240000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
}
async function shot(cdp, file) {
  const data = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data.data, "base64"));
}

async function main() {
  if (!ONLY && !CHECK_ONLY) {
    try {
      await fsp.rm(OUT, { recursive: true, force: true });
    } catch {}
  }
  await fsp.mkdir(OUT, { recursive: true });

  if (CHECK_ONLY) {
    for (const [name, file] of [["① 会话统计（只读）", "task1.result.json"], ["② 运行状态（只读）", "task2.result.json"]]) {
      const p = path.join(OUT, file);
      let r = null;
      try {
        r = JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {}
      check(`真实任务${name}`, !!r && r.ok === true, r ? `${r.ms}ms · ${r.chars} 字符 · state=${r.state}` : "缺少结果文件");
    }
    const failed0 = results.filter((r) => !r.pass);
    await fsp.writeFile(path.join(OUT, "summary.txt"), results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`).join(String.fromCharCode(10)) + String.fromCharCode(10));
    console.log(`
${results.length - failed0.length}/${results.length} PASS`);
    process.exit(failed0.length ? 1 : 0);
  }

  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    check(`端口 ${PORT} 空闲`, false, "已有 bridge 在跑");
    process.exit(1);
  } catch {}

  const bridge = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_CWD: os.homedir(), PI_SHELL_LOG_FILE: path.join(OUT, "bridge.log") },
    stdio: ["ignore", "ignore", "ignore"], // 双保险：不消费就不接管道（H-15）
  });
  let edge = null;
  try {
    for (let i = 0; i < 400; i++) {
      try {
        if ((await getJson("/api/health")).data?.pi?.state === "idle") break;
      } catch {}
      await sleep(150);
    }
    const edgePath = findEdge();
    if (!edgePath) throw new Error("未找到 msedge.exe");
    const debugPort = await freePort(PORT + 1700);
    const profile = path.join(OUT, `edge-${Date.now()}`);
    edge = spawn(edgePath, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--window-size=1440,900", `${BASE}/`], { stdio: "ignore" });
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      try {
        target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      } catch {}
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("Edge CDP 未就绪");
    const cdp = cdpConnect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await sleep(1800);

    const runTask = (prompt, waitMs) => `(async () => {
      const log = document.getElementById('log');
      document.getElementById('input').value = ${JSON.stringify(prompt)};
      document.getElementById('composer').requestSubmit();
      const t0 = performance.now();
      await new Promise((res) => {
        const timer = setInterval(() => {
          const st = document.getElementById('state').textContent || '';
          const notice = document.getElementById('notice');
          if (st.startsWith('idle') && performance.now() - t0 > 2000) { clearInterval(timer); res(); }
          if (performance.now() - t0 > ${waitMs}) { clearInterval(timer); res(); }
        }, 400);
      });
      const text = log.innerText;
      return { ms: Math.round(performance.now() - t0), chars: text.length, text: text.slice(-4000), state: document.getElementById('state').textContent, notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent };
    })()`;

    // ① 会话列表统计（只读）
    if (!ONLY || ONLY === "task1") {
    const task1 = await evaluate(cdp, runTask("查看当前会话列表，只读统计各项目分组的会话数量；不要改动任何文件。", 420000));
    const task1Ok = task1.chars > 200 && /会话|分组|项目|数量/i.test(task1.text) && !/打开失败|中止失败/.test(task1.notice || "");
    check("真实任务①：网页里完成会话统计（只读，无对外动作）", task1Ok, `${task1.ms}ms · ${task1.chars} 字符 · state=${task1.state}`);
    await fsp.writeFile(path.join(OUT, "task1.txt"), task1.text, "utf8");
    await fsp.writeFile(path.join(OUT, "task1.result.json"), JSON.stringify({ ok: task1Ok, ms: task1.ms, chars: task1.chars, state: task1.state }), "utf8");
    await shot(cdp, "task1.png");
    }

    // ② 运行状态查看（只读）
    if (!ONLY || ONLY === "task2") {
    const task2 = await evaluate(cdp, runTask("查看当前使用的模型与思考级别并汇报；只读，不要改任何设置。", 420000));
    const task2Ok = task2.chars > 150 && /模型|级别|思考|thinking/i.test(task2.text) && !/打开失败|中止失败/.test(task2.notice || "");
    check("真实任务②：网页里完成运行状态查看（只读）", task2Ok, `${task2.ms}ms · ${task2.chars} 字符 · state=${task2.state}`);
    await fsp.writeFile(path.join(OUT, "task2.txt"), task2.text, "utf8");
    await fsp.writeFile(path.join(OUT, "task2.result.json"), JSON.stringify({ ok: task2Ok, ms: task2.ms, chars: task2.chars, state: task2.state }), "utf8");
    await shot(cdp, "task2.png");
    }

    const stats = await getJson("/api/stats");
    check("真实任务后 /api/stats 反映用量", Number(stats.data?.tokens?.total ?? 0) > 0, `tokens=${stats.data?.tokens?.total} cost=${stats.data?.cost}`);
    cdp.close();
  } catch (err) {
    check("运行异常", false, err.message);
  } finally {
    try {
      edge?.kill("SIGKILL");
    } catch {}
    kill(bridge.pid);
    await sleep(2500);
    check("收尾：无残留 bridge / pi 进程", portPid(PORT) === null, "");
    const failed = results.filter((r) => !r.pass);
    await fsp.writeFile(path.join(OUT, "summary.txt"), results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`).join(String.fromCharCode(10)) + String.fromCharCode(10));
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
