#!/usr/bin/env node
// M0 等价证据驱动（可重复运行，零第三方依赖）
//
// 覆盖 G0-2 ~ G0-6 与「kill 子进程 → 页面自动恢复」：
//   1) 启动 bridge（临时会话目录，不动真实会话）
//   2) SSE 层：disposition=started、首字、增量次数、事件序列、abort 时延
//   3) disposition 三态（命令 → handled；streaming 中 followUp → queued）
//   4) 页面层（headless Edge + CDP）：发消息 → 流式 → 中止 → kill 子进程 → 自动恢复 + 截图
//   5) 收尾：按 PID 终止 bridge，并检查无残留 pi 子进程
//
// 用法：
//   node scripts/evidence/m0.mjs              # 全量（需要本机 Edge）
//   node scripts/evidence/m0.mjs --no-page    # 只跑 SSE 层（不需要 Edge）
// 环境变量：
//   PI_SHELL_PORT 覆盖端口（默认 7788）
//   EDGE_PATH     指定 msedge.exe；不指定时按常见路径探测
// 产出：
//   <tmp>/pi-shell-m0-evidence/ 下的 page.png、bridge.log、summary.txt（每次运行清空重来）
//   控制台打印 PASS/FAIL 行，退出码 0=全部通过

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-m0-evidence");
const SESSIONS = path.join(OUT_DIR, "sessions");
const ARGS = new Set(process.argv.slice(2));
const WITH_PAGE = !ARGS.has("--no-page");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 进程工具（一律按 PID，不用命令行模式匹配） ----------

function psLines(script) {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function pidAlive(pid) {
  return psLines(`Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`) === String(pid);
}

function rpcChildPids(marker) {
  const out = psLines(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId`,
  );
  return out ? out.split(/\s+/).map(Number) : [];
}

function killPid(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } catch {}
}

// ---------- HTTP ----------

async function postJson(url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

async function health() {
  return (await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json()).pi;
}

async function waitHealth(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const pi = await health();
      if (pred(pi)) return { pi, ms: Date.now() - t0 };
    } catch {}
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

// ---------- SSE 客户端 ----------

function createSse() {
  const events = [];
  let started = false;
  const waiters = new Set();
  const notify = () => {
    for (const w of [...waiters]) w();
  };
  async function connect() {
    const res = await fetch(`${BASE}/api/events`, { headers: { Accept: "text/event-stream" } });
    if (res.status !== 200) throw new Error(`SSE status ${res.status}`);
    started = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          events.push({ at: Date.now(), ...JSON.parse(line.slice(6)) });
          notify();
        }
      }
    })().catch(() => {});
  }
  function waitFor(pred, ms, label) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        const hit = events.find(pred);
        if (hit) {
          waiters.delete(check);
          resolve(hit);
          return true;
        }
        if (Date.now() - t0 > ms) {
          waiters.delete(check);
          reject(new Error(`timeout: ${label}`));
          return true;
        }
        return false;
      };
      waiters.add(check);
      if (!check()) {
        const timer = setInterval(() => {
          if (check()) clearInterval(timer);
        }, 50);
        timer.unref?.();
      }
    });
  }
  return {
    connect,
    waitFor,
    events,
    reset: () => (events.length = 0),
    get connected() {
      return started;
    },
    deltas: () => events.filter((e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta"),
    seqs: () => events.map((e) => e.seq).filter((n) => typeof n === "number"),
  };
}

// ---------- 页面层（headless Edge + CDP） ----------

function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  return {
    ready,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 120000 });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result?.value;
}

async function pagePhase(edgePath) {
  const profile = path.join(OUT_DIR, "edge-profile");
  fs.rmSync(profile, { recursive: true, force: true });
  const debugPort = PORT + 1000;
  const edge = spawn(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--window-size=1280,860",
      `${BASE}/`,
    ],
    { stdio: "ignore" },
  );

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge CDP 未就绪");

  const cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await sleep(1200);

  const flow = await evaluate(
    cdp,
    `(async () => {
      const t0 = performance.now();
      const log = document.getElementById('log');
      let updates = 0, firstTextMs = null;
      const mo = new MutationObserver(() => {
        updates += 1;
        const text = [...log.querySelectorAll('.msg-assistant .msg-body')].map((b) => b.textContent).join('');
        if (text.length > 0 && firstTextMs === null) firstTextMs = Math.round(performance.now() - t0);
      });
      mo.observe(log, { subtree: true, childList: true, characterData: true });
      document.getElementById('input').value = '用两句话说明你正在运行在什么环境里。不要用工具。';
      document.getElementById('composer').requestSubmit();
      await new Promise((res) => {
        const t = setInterval(() => {
          const st = document.getElementById('state').textContent || '';
          if (st.startsWith('idle') && performance.now() - t0 > 800) { clearInterval(t); res(); }
          if (performance.now() - t0 > 90000) { clearInterval(t); res(); }
        }, 120);
      });
      mo.disconnect();
      return {
        firstTextMs,
        updates,
        state: document.getElementById('state').textContent,
        chars: [...log.querySelectorAll('.msg-assistant .msg-body')].map((b) => b.textContent).join('').length,
      };
    })()`,
  );
  check(
    "页面：首字 ≤3s 且 DOM 更新 ≥2 次",
    flow.firstTextMs != null && flow.firstTextMs <= 3000 && flow.updates >= 2,
    `首字 ${flow.firstTextMs}ms · DOM 更新 ${flow.updates} · 字符 ${flow.chars}`,
  );

  const abort = await evaluate(
    cdp,
    `(async () => {
      const t0 = performance.now();
      document.getElementById('input').value = '请写一篇 3000 字文章，主题：本地优先软件的取舍。不要用工具。';
      document.getElementById('composer').requestSubmit();
      const firstTextMs = await new Promise((res) => {
        const t = setInterval(() => {
          const text = [...document.querySelectorAll('.msg-assistant .msg-body')].map((b) => b.textContent).join('');
          if (text.length > 0) { clearInterval(t); res(Math.round(performance.now() - t0)); }
          if (performance.now() - t0 > 30000) { clearInterval(t); res(-1); }
        }, 80);
      });
      const btn = document.getElementById('abort');
      const enabled = !btn.disabled;
      btn.click();
      const tAbort = performance.now();
      const idleMs = await new Promise((res) => {
        const t = setInterval(() => {
          const st = document.getElementById('state').textContent || '';
          if (st.startsWith('idle')) { clearInterval(t); res(Math.round(performance.now() - tAbort)); }
          if (performance.now() - tAbort > 10000) { clearInterval(t); res(-1); }
        }, 80);
      });
      return { firstTextMs, enabled, idleMs };
    })()`,
  );
  check(
    "页面：中止后 ≤2s 回 idle（isStreaming=false）",
    abort.enabled && abort.idleMs >= 0 && abort.idleMs <= 2000,
    `按钮可用=${abort.enabled} · 回 idle ${abort.idleMs}ms`,
  );

  const beforePid = (await evaluate(cdp, `document.getElementById('pid').textContent`, false)).trim();
  killPid(Number(beforePid));
  let crashedSeen = false;
  let recovered = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const snap = await evaluate(
      cdp,
      `({state: document.getElementById('state').textContent, pid: document.getElementById('pid').textContent})`,
      false,
    );
    if (/crashed|starting/.test(snap.state)) crashedSeen = true;
    if (snap.state.startsWith("idle") && snap.pid.trim() && snap.pid.trim() !== beforePid) {
      recovered = { pid: snap.pid.trim(), ms: Date.now() - t0 };
      break;
    }
    await sleep(200);
  }
  check("页面：kill 子进程后自动恢复（新 pid）", crashedSeen && !!recovered, `kill ${beforePid} → ${recovered ? recovered.pid + ` / ${recovered.ms}ms` : "未恢复"}`);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(OUT_DIR, "page.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log(`      截图：${shotPath}`);

  cdp.close();
  try {
    edge.kill("SIGKILL");
  } catch {}
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });

  // 端口必须空闲：本脚本自己起桥，避免连到别人的实例上给出假证据
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 已被占用：请先停掉已有 bridge`);
  } catch (err) {
    if (!/已被占用/.test(String(err.message))) {
      /* 端口空闲即连接失败，正常 */
    } else throw err;
  }

  const logLines = [];
  const bridge = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_CWD: os.homedir(),
      PI_SHELL_EXTRA_ARGS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) logLines.push(l);
  });

  let exitCode = 0;
  try {
    const up = await waitHealth((p) => p.state === "idle", 45000, "bridge idle");
    check("G0-1 health：version=1.5.0 且 state=idle（来自 get_state）", up.pi.version === "1.5.0" && up.pi.state === "idle", `pid=${up.pi.pid} ${up.ms}ms`);
    const states = logLines.filter((l) => /health_state_changed/.test(l)).map((l) => l.replace(/.*health_state_changed\|/, ""));
    check(
      "G0-1 状态序列 not_started→starting→idle",
      states.some((s) => s.startsWith("from=not_started to=starting")) && states.some((s) => s.startsWith("from=starting to=idle")),
      states.join(" | "),
    );

    const sse = createSse();
    await sse.connect();

    // ---- started + 首字 + 增量 + 序列 ----
    sse.reset();
    const p1 = await postJson("/api/prompt", { message: "用三句话解释什么是 SSE（服务器发送事件）。不要用工具。" });
    check("disposition=started", p1.status === 200 && p1.data?.disposition === "started", JSON.stringify(p1.data));
    const first = await sse.waitFor((e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta", 30000, "first delta");
    const agentStart = sse.events.find((e) => e.type === "agent_start");
    const firstMs = agentStart ? first.at - agentStart.at : null;
    check("G0-2 首字 ≤3s", firstMs != null && firstMs <= 3000, `${firstMs}ms（agent_start→首个 text_delta）`);
    await sse.waitFor((e) => e.type === "agent_settled", 90000, "agent_settled#1");
    const deltas = sse.deltas().length;
    check("G0-2 单条回复 ≥2 次增量", deltas >= 2, `text_delta=${deltas}`);
    const types = new Set(sse.events.map((e) => e.type));
    check(
      "G0-6 事件序列 agent_start→message_update→agent_settled",
      types.has("agent_start") && types.has("message_update") && types.has("agent_settled"),
      [...types].join(","),
    );
    const seqs = sse.seqs();
    check("SSE seq 单调递增", seqs.length === 0 || seqs.every((n, i) => i === 0 || n > seqs[i - 1]), `${seqs[0]}…${seqs[seqs.length - 1]} (${seqs.length})`);

    // ---- abort ----
    sse.reset();
    await postJson("/api/prompt", { message: "请写一篇 2000 字的文章，主题是本地优先软件。不要用工具。" });
    await sse.waitFor((e) => e.type === "message_update", 30000, "first update#2");
    const tAbort = Date.now();
    const ab = await postJson("/api/abort");
    const settled = await sse.waitFor((e) => e.type === "agent_settled", 15000, "agent_settled#2");
    check("G0-3 abort 回执 200 且 ≤5s settled", ab.status === 200 && settled.at - tAbort <= 5000, `abort→settled ${settled.at - tAbort}ms aborted=${settled.aborted}`);
    const afterAbort = await waitHealth((p) => p.state === "idle", 5000, "idle after abort");
    check("G0-3 isStreaming ≤5s 转 false", afterAbort.pi.state === "idle", `${afterAbort.ms}ms`);

    // ---- handled（用本机命令集里的第一条命令，不依赖特定扩展）----
    sse.reset();
    const cmds = await (await fetch(`${BASE}/api/commands`, { cache: "no-store" })).json();
    const firstName = (cmds.commands ?? [])[0]?.name ?? "";
    if (!firstName) {
      check("disposition=handled（命令）", false, "本机命令集为空，无法测 handled 分支");
    } else {
      const p3 = await postJson("/api/prompt", { message: `/${firstName}` });
      check("disposition=handled（命令）", p3.status === 200 && p3.data?.disposition === "handled", `/${firstName} → ${JSON.stringify(p3.data)}`);
      const notified = await sse
        .waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && String(e.message || "").startsWith(`[${firstName}]`), 20000, "notify")
        .catch(() => null);
      check("handled 后立即 idle（notify 事件取决于命令实现）", (await health()).state === "idle", notified ? JSON.stringify(notified.message).slice(0, 60) : `无 notify（/${firstName} 不产生 notify，属正常）`);
    }

    // ---- queued ----
    sse.reset();
    const p4 = await postJson("/api/prompt", { message: "数到 200，每行一个数字。不要用工具。" });
    await sse.waitFor((e) => e.type === "message_update", 30000, "first update#4");
    const p5 = await postJson("/api/prompt", { message: "停。只回复 OK。", streamingBehavior: "followUp" });
    check("disposition=queued（streaming 中 followUp）", p5.status === 200 && p5.data?.disposition === "queued", JSON.stringify(p5.data));
    const p6 = await postJson("/api/prompt", { message: "无 behavior 的第二条" });
    check("streaming 中无 behavior → 502 PI_ERROR", p6.status === 502 && p6.data?.error?.code === "PI_ERROR", `status=${p6.status}`);
    await postJson("/api/abort");

    // ---- kill 子进程自动重启（SSE 层；页面层另测）----
    sse.reset();
    const before = await health();
    killPid(before.pid);
    check("G0-4 旧子进程已消失", !pidAlive(before.pid), `pid=${before.pid}`);
    const restarted = await waitHealth((p) => p.state === "idle" && p.pid && p.pid !== before.pid, 8000, "restart");
    check("G0-4 kill 后自动重启（≤8s，新 pid）", restarted.pi.pid !== before.pid, `${before.pid} → ${restarted.pi.pid} / ${restarted.ms}ms`);
    const piProcs = rpcChildPids("pi-shell-m0-evidence");
    check("G0-4 只保留 1 个 pi 子进程", piProcs.length === 1, `pids=${piProcs.join(",")}`);

    if (WITH_PAGE) {
      const edgePath = findEdge();
      if (!edgePath) {
        console.log("SKIP  页面层：未找到 msedge.exe（可用 EDGE_PATH 指定，或加 --no-page）");
      } else {
        await pagePhase(edgePath);
      }
    }
  } catch (err) {
    check(`运行异常：${err.message}`, false, "");
  } finally {
    // 收尾：按 PID 终止桥，然后确认无残留 pi 子进程
    killPid(bridge.pid);
    await sleep(2500);
    const leftoverBridge = rpcChildPids("bridge/src/index.mjs");
    const leftoverPi = rpcChildPids("pi-shell-m0-evidence");
    check("收尾：无残留 bridge / pi 进程", leftoverBridge.length === 0 && leftoverPi.length === 0, `bridge=${leftoverBridge.length} pi=${leftoverPi.length}`);
    for (const pid of [...leftoverBridge, ...leftoverPi]) killPid(pid);

    fs.writeFileSync(path.join(OUT_DIR, "bridge.log"), logLines.join("\n"));
    const failed = results.filter((r) => !r.pass);
    const summary = results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail || ""}`).join("\n");
    fs.writeFileSync(path.join(OUT_DIR, "summary.txt"), summary + "\n");
    console.log(`\n${results.length - failed.length}/${results.length} PASS；产出目录：${OUT_DIR}`);
    exitCode = failed.length === 0 ? 0 : 1;
    process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
