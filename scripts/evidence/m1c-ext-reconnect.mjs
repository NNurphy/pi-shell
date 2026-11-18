#!/usr/bin/env node
// M1-C 证据：T-12 扩展 UI 桥（四对话框 + 三通知 + cancelled + 10s 无客户端自动取消）
//             T-13 重连（游标补齐 / resync / 断线横幅 + 手动重试）
//
// 用法：node scripts/evidence/m1c-ext-reconnect.mjs   （端口需空闲；需要 Edge）
// 产出：%TMP%\pi-shell-m1c\ 下 m1c-dialog.png / m1c-notify.png / m1c-reconnect.png + summary.txt

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-m1c");
const EXT = path.join(REPO_ROOT, "test-ext", "select-demo.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function psPids(marker) {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId`], { encoding: "utf8" }).trim();
    return out ? out.split(/\s+/).map(Number) : [];
  } catch {
    return [];
  }
}
async function post(url, body) {
  const res = await fetch(`${BASE}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

/** 极简 SSE 客户端：收集帧 + 等某帧 */
function openSse() {
  const rec = { frames: [], closed: false, abort: null };
  rec.ready = (async () => {
    const ctrl = new AbortController();
    rec.abort = () => ctrl.abort();
    const res = await fetch(`${BASE}/api/events`, { headers: { Accept: "text/event-stream" }, signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = raw.split("\n").find((l) => l.startsWith("data: "));
            if (line) rec.frames.push({ at: Date.now(), ...JSON.parse(line.slice(6)) });
          }
        }
      } catch {}
    })();
  })();
  rec.waitFor = async (pred, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = rec.frames.find(pred);
      if (hit) return hit;
      await sleep(80);
    }
    throw new Error(`timeout waiting ${label}`);
  };
  rec.clear = () => (rec.frames.length = 0);
  return rec;
}

function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  return ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p)) || null;
}
async function freePort(start) {
  const net = await import("node:net");
  for (let port = start; port < start + 80; port++) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (ok) return port;
  }
  throw new Error("没有空闲端口");
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
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 180000 });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + " " + (res.exceptionDetails.exception?.description || ""));
  return res.result?.value;
}
async function shot(cdp, file) {
  const data = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data.data, "base64"));
}

function sessionFile({ id, cwd, user, answer }) {
  return [
    JSON.stringify({ type: "session", version: 3, id, timestamp: Date.now(), cwd }),
    JSON.stringify({ type: "message", id: `${id}-u`, parentId: null, timestamp: Date.now(), message: { role: "user", content: user } }),
    JSON.stringify({ type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: Date.now() + 1, message: { role: "assistant", content: [{ type: "text", text: answer }] } }),
  ].join("\n") + "\n";
}

async function main() {
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {}
  await fsp.mkdir(OUT, { recursive: true });
  const sessionsDir = path.join(OUT, "sessions");
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.writeFile(path.join(sessionsDir, "ok.jsonl"), sessionFile({ id: "01a1c000-0000-0000-0000-000000000001", cwd: os.homedir(), user: "可用会话", answer: "ok" }), "utf8");
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    check(`端口 ${PORT} 空闲`, false, "已有 bridge 在跑");
    process.exit(1);
  } catch {}

  const logs = [];
  const logFile = path.join(OUT, "bridge.log");
  const bridge = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: sessionsDir,
      PI_SHELL_CWD: os.homedir(),
      PI_SHELL_EXTRA_ARGS: JSON.stringify(["-e", EXT]),
      PI_SHELL_LOG_FILE: logFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) logs.push(l);
  });

  let edge = null;
  try {
    for (let i = 0; i < 300; i++) {
      try {
        const h = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
        if (h.pi.state === "idle") break;
      } catch {}
      await sleep(150);
    }

    // ---------- A-06：真实扩展 select 往返 ----------
    const sse = openSse();
    await sse.ready;

    sse.clear();
    const p1 = await Promise.race([post("/api/prompt", { message: "/select-demo" }), new Promise((r) => setTimeout(() => r({ status: 0, data: null, pending: true }), 800))]); // 扩展命令会等对话框，不阻塞
    const sel = await sse.waitFor((f) => f.type === "extension_ui_request" && f.method === "select", 20000, "select request").catch(() => null);
    // 判定只依赖 bridge 侧事件（02 A-02 口径）：扩展命令的 disposition 可能为 null，不作为判据
    check("A-06 /select-demo 触发 select（bridge 侧 SSE 收到）", !!sel, `${JSON.stringify(p1.data)} · options=${(sel.options || []).join(",")}`);
    if (sel) {
      const r = await post("/api/ext-ui-response", { id: sel.id, value: "beta" });
      const got = await sse.waitFor((f) => f.type === "extension_ui_request" && f.method === "notify" && String(f.message || "").includes("got=beta"), 15000, "notify got").catch(() => null);
      check("A-06 回执后 pi 收到所选值（notify got=beta）", r.status === 200 && !!got, got?.message || "未收到");
    }

    // cancelled 路径
    sse.clear();
    post("/api/prompt", { message: "/select-demo" }).catch(() => {});
    const sel2 = await sse.waitFor((f) => f.type === "extension_ui_request" && f.method === "select", 20000, "select#2").catch(() => null);
    if (sel2) {
      await post("/api/ext-ui-response", { id: sel2.id, cancelled: true });
      const cancelled = await sse.waitFor((f) => f.method === "notify" && /cancelled/.test(String(f.message || "")), 15000, "notify cancelled").catch(() => null);
      check("T-12 cancelled:true 路径（扩展收到取消）", !!cancelled, cancelled?.message || "未收到");
    } else check("T-12 cancelled:true 路径", false, "未收到第二次 select");

    // confirm / input / editor
    for (const [arg, method, fields, expect] of [
      ["confirm", "confirm", { confirmed: true }, "confirmed=true"],
      ["input", "input", { value: "hello-input" }, "input=hello-input"],
      ["editor", "editor", { value: "edited-text" }, "edited="],
    ]) {
      sse.clear();
      post("/api/prompt", { message: `/select-demo ${arg}` }).catch(() => {});
      const first = await sse.waitFor((f) => f.type === "extension_ui_request" && f.method === "select", 20000, `select for ${arg}`).catch(() => null);
      if (!first) {
        check(`T-12 ${method} 对话框往返`, false, "首个 select 未出现");
        continue;
      }
      await post("/api/ext-ui-response", { id: first.id, value: "alpha" });
      const dialog = await sse.waitFor((f) => f.type === "extension_ui_request" && f.method === method, 15000, method).catch(() => null);
      if (!dialog) {
        check(`T-12 ${method} 对话框往返`, false, "未收到对话框请求");
        continue;
      }
      await post("/api/ext-ui-response", { id: dialog.id, ...fields });
      const note = await sse.waitFor((f) => f.method === "notify" && String(f.message || "").includes(expect), 15000, "notify").catch(() => null);
      check(`T-12 ${method} 对话框往返`, !!note, note?.message || "未收到回显");
    }

    // setWidget / setStatus
    sse.clear();
    post("/api/prompt", { message: "/select-demo widget" }).catch(() => {});
    const wSel = await sse.waitFor((f) => f.type === "extension_ui_request" && f.method === "select", 20000, "select before widget").catch(() => null);
    if (wSel) await post("/api/ext-ui-response", { id: wSel.id, value: "alpha" });
    const w = await sse.waitFor((f) => f.method === "setWidget", 20000, "setWidget").catch(() => null);
    const st = await sse.waitFor((f) => f.method === "setStatus", 15000, "setStatus").catch(() => null);
    check("T-12 setWidget / setStatus 通知（bridge 侧收到）", !!w && !!st, `${w ? `widgetLines=${(w.widgetLines || []).length}` : "无 widget"} / ${st ? st.statusText : "无 status"}`);

    // ---------- T-12：10s 无 SSE 客户端 → 自动 cancelled ----------
    sse.clear();
    post("/api/prompt", { message: "/select-demo" }).catch(() => {});
    const pendingSel = await sse.waitFor((f) => f.type === "extension_ui_request" && f.method === "select", 20000, "select for auto-cancel").catch(() => null);
    if (pendingSel) {
      sse.abort();
      await sleep(13000);
      // notify 在无客户端时不会广播，故以桥日志 + 扩展被解除阻塞为准
      const autoLog = (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n") : []).filter((l) => /ext_ui_auto_cancelled/.test(l)).pop() || "";
      const sse2 = openSse();
      await sse2.ready;
      const afterIdle = await sse2.waitFor((f) => f.type === "extension_ui_request" && f.method === "notify", 8000, "post-cancel notify").catch(() => null);
      const h = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
      check("T-12 无客户端 10s → 对未回执 id 发 cancelled（桥日志佐证）", /ext_ui_auto_cancelled/.test(autoLog) && h.pi.state === "idle", autoLog.split("|").slice(1).join("|").slice(0, 70));
      sse2.abort();
    } else check("T-12 10s 自动取消", false, "未触发 select");

    // ---------- T-13：entries 游标 ----------
    const full = await (await fetch(`${BASE}/api/session/entries`)).json();
    check("T-13 GET /api/session/entries 全量", Array.isArray(full.entries) && full.entries.length > 0 && typeof full.leafId === "string", `${full.entries.length} 条，leafId=${String(full.leafId).slice(0, 8)}`);
    const sinceRes = await (await fetch(`${BASE}/api/session/entries?since=${encodeURIComponent(full.leafId)}`)).json();
    check("T-13 since=最后一条 → 无新条目", sinceRes.entries.length === 0 && sinceRes.leafId === full.leafId, `${sinceRes.entries.length} 条`);
    const badSince = await (await fetch(`${BASE}/api/session/entries?since=deadbeef-not-exist`)).json();
    check("T-13 since 失效 → 全量 + resync 标记", badSince.resync === true && badSince.entries.length === full.entries.length, `resync=${badSince.resync} entries=${badSince.entries.length}`);

    // ---------- 页面：对话框 / 通知 / 断线重试 ----------
    const edgePath = findEdge();
    if (!edgePath) {
      check("找到 Edge", false, "未找到 msedge.exe");
    } else {
      const debugPort = await freePort(PORT + 1300);
      const profile = path.join(OUT, `edge-${Date.now()}`);
      edge = spawn(edgePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--window-size=1440,900", `${BASE}/`], { stdio: "ignore" });
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
      await sleep(1500);

      await evaluate(
        cdp,
        `(() => {
          if (window.__fetchLog) return true;
          window.__fetchLog = [];
          const orig = window.fetch.bind(window);
          window.fetch = async (url, opts) => {
            try { window.__fetchLog.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null }); } catch { window.__fetchLog.push({ url: String(url) }); }
            return orig(url, opts);
          };
          return true;
        })()`,
        false,
      );

      // 四种对话框 DOM + 回执
      const dialog = await evaluate(
        cdp,
        `(async () => {
          const out = {};
          for (const [method, frame, clickText] of [
            ['select', { type: 'extension_ui_request', id: 'ui-select', method: 'select', title: '选一项', options: ['A', 'B'] }, 'B'],
            ['confirm', { type: 'extension_ui_request', id: 'ui-confirm', method: 'confirm', title: '确认?', message: '继续吗' }, '确定'],
            ['input', { type: 'extension_ui_request', id: 'ui-input', method: 'input', title: '输入', placeholder: 'x' }, '提交'],
            ['editor', { type: 'extension_ui_request', id: 'ui-editor', method: 'editor', title: '编辑', prefill: 'l1' }, '提交'],
          ]) {
            window.__piShell.ext(frame);
            await new Promise((r) => setTimeout(r, 150));
            const modal = document.getElementById('modal');
            const visible = modal.hidden === false;
            const buttons = [...modal.querySelectorAll('button')];
            const btn = buttons.find((b) => b.textContent === clickText);
            if (!out[method]) out[method] = { visible };
            if (method === 'editor' || method === 'input') {
              const ta = modal.querySelector('textarea');
              if (ta) ta.value = method === 'editor' ? 'edited-text' : 'hello-input';
            }
            btn?.click();
            await new Promise((r) => setTimeout(r, 120));
            out[method].closed = document.getElementById('modal').hidden === true;
          }
          const bodies = window.__fetchLog.filter((r) => r.url.includes('/api/ext-ui-response')).map((r) => r.body);
          return { out, bodies };
        })()`,
      );
      const values = dialog.bodies.map((b) => (b?.cancelled ? "cancelled" : b?.confirmed !== undefined ? `confirmed=${b.confirmed}` : `value=${b.value}`)).join(" | ");
      check("T-12 四种对话框（select/confirm/input/editor）UI 可见且回执", ["select", "confirm", "input", "editor"].every((m) => dialog.out[m]?.visible && dialog.out[m]?.closed), values);

      // cancelled 按钮
      const canc = await evaluate(
        cdp,
        `(async () => {
          window.__fetchLog.length = 0;
          window.__piShell.ext({ type: 'extension_ui_request', id: 'ui-cancel', method: 'confirm', title: '取消?', message: 'x' });
          await new Promise((r) => setTimeout(r, 150));
          const btn = [...document.querySelectorAll('#modal button')].find((b) => b.textContent === '取消');
          btn?.click();
          await new Promise((r) => setTimeout(r, 150));
          const body = window.__fetchLog.find((r) => r.url.includes('/api/ext-ui-response'))?.body;
          return { cancelled: body?.cancelled === true, body };
        })()`,
      );
      check("T-12 UI cancelled:true 回执", canc.cancelled, JSON.stringify(canc.body));

      // 三种通知
      const notes = await evaluate(
        cdp,
        `(async () => {
          window.__piShell.ext({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hello-toast', notifyType: 'info' });
          window.__piShell.ext({ type: 'extension_ui_request', id: 'n2', method: 'setStatus', statusKey: 'k', statusText: 'status-text' });
          window.__piShell.ext({ type: 'extension_ui_request', id: 'n3', method: 'setWidget', widgetKey: 'w', lines: ['widget-line-1', 'widget-line-2'] });
          await new Promise((r) => setTimeout(r, 200));
          return {
            toast: document.getElementById('toast').hidden === false && document.getElementById('toast').textContent,
            status: document.getElementById('ext-status').hidden === false ? document.getElementById('ext-status').textContent : '',
            widget: document.getElementById('widget').hidden === false ? document.getElementById('widget').textContent : '',
          };
        })()`,
      );
      check("T-12 notify → toast", /hello-toast/.test(notes.toast), notes.toast);
      check("T-12 setStatus → 状态条", /status-text/.test(notes.status), notes.status);
      check("T-12 setWidget → 编辑区上方块", /widget-line-1/.test(notes.widget) && /widget-line-2/.test(notes.widget), notes.widget.replace(/\n/g, " / "));
      await shot(cdp, "m1c-notify.png");

      // select 对话框截图（重新打开一个）
      await evaluate(cdp, `window.__piShell.ext({ type: 'extension_ui_request', id: 'ui-shot', method: 'select', title: 'A-06 请选择一项', options: ['alpha', 'beta', 'gamma'] })`, false);
      await sleep(200);
      await shot(cdp, "m1c-dialog.png");
      await evaluate(cdp, `(() => { document.getElementById('modal').hidden = true; return true; })()`, false);

      // 断线：强制断开 → 横幅 + 重试
      const disc = await evaluate(
        cdp,
        `(async () => {
          window.__piShell.forceDisconnect();
          await new Promise((r) => setTimeout(r, 400));
          const banner = document.getElementById('reconnect');
          const visible = banner.hidden === false;
          const text = document.getElementById('reconnect-text').textContent;
          document.getElementById('reconnect-btn').click();
          await new Promise((r) => setTimeout(r, 1600));
          return { visible, text, afterHidden: document.getElementById('reconnect').hidden === true, state: document.getElementById('state').textContent };
        })()`,
      );
      check("T-13 断线 → 横幅 + 重试按钮；点击后恢复", disc.visible && /重连/.test(disc.text) && disc.afterHidden, `${disc.text.slice(0, 24)} → ${disc.state}`);
      await shot(cdp, "m1c-reconnect.png");
      cdp.close();
    }
  } catch (err) {
    check("运行异常", false, err.message);
  } finally {
    try {
      edge?.kill("SIGKILL");
    } catch {}
    kill(bridge.pid);
    await sleep(2500);
    const left = psPids("bridge/src/index.mjs").concat(psPids("pi-shell-m1c"));
    check("收尾：无残留 bridge / pi 进程", left.length === 0, `残留=${left.length}`);
    for (const pid of left) kill(pid);
    await fsp.writeFile(path.join(OUT, "bridge.log"), logs.join("\n"));
    const failed = results.filter((r) => !r.pass);
    await fsp.writeFile(path.join(OUT, "summary.txt"), results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`).join("\n") + "\n");
    console.log(`\n${results.length - failed.length}/${results.length} PASS；产出目录：${OUT}`);
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
