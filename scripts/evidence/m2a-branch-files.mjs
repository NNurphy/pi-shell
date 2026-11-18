#!/usr/bin/env node
// M2-A 返工证据：T-16 分支（fork/clone/tree）+ T-17 文件/预览/懒加载 + session/open 两段式
//  ① 500 条会话「内容可见」耗时（目标 ≤2s）
//  ② 后台接管耗时（只记录，不设 PASS/FAIL）
//  ③ 接管失败路径（cwd 不存在）：内容仍可看 + 横幅 + 重试
//  ④ 同一文件已附着 → 直接 get_entries（不重复 switch）
//
// 用法：node scripts/evidence/m2a-branch-files.mjs   （端口需空闲；需要 Edge）

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-m2a");
const SESSIONS = path.join(OUT, "sessions");
const WORK = path.join(OUT, "work");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function info(name, detail) {
  console.log(`INFO  ${name}  ${detail}`);
}
function kill(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } catch {}
}
function psCount(marker) {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Measure-Object | Select-Object -ExpandProperty Count`], { encoding: "utf8" }).trim();
    return Number(out) || 0;
  } catch {
    return 0;
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
async function getJson(url) {
  const res = await fetch(`${BASE}${url}`, { cache: "no-store" });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
function openSse() {
  const rec = { frames: [], abort: null };
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
      await sleep(60);
    }
    throw new Error(`timeout: ${label}`);
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
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true, timeout: 120000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
}
async function shot(cdp, file) {
  const data = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data.data, "base64"));
}

function sessionLines({ id, cwd, messages }) {
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: Date.now(), cwd })];
  messages.forEach((m, i) => {
    lines.push(JSON.stringify({ type: "message", id: `${id}-${i}`, parentId: i ? `${id}-${i - 1}` : null, timestamp: Date.now() + i, message: m }));
  });
  return lines.join("\n") + "\n";
}

async function waitForFile(dir, count, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const files = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    if (files.length >= count) return files;
    await sleep(200);
  }
  return fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
}

async function main() {
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {}
  await fsp.mkdir(SESSIONS, { recursive: true });
  await fsp.mkdir(path.join(WORK, "sub"), { recursive: true });

  await fsp.writeFile(path.join(WORK, "readme.md"), "# 标题\n\n- 一\n- 二\n\n```js\nconsole.log(1)\n```\n", "utf8");
  await fsp.writeFile(path.join(WORK, "code.js"), "// hello\nconst x = 1;\n", "utf8");
  await fsp.writeFile(path.join(WORK, "sub", "note.txt"), "子目录文件\n", "utf8");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await fsp.writeFile(path.join(WORK, "dot.png"), png);
  await fsp.writeFile(path.join(WORK, "big-text.txt"), "x".repeat(1024 * 1024 + 100), "utf8");
  await fsp.writeFile(path.join(WORK, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 10));

  // 通用化：任选一个含 .jsonl 的分组做只读样本（不依赖特定目录名）
  const SESSIONS_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
  const groupEntry = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).find((d) => {
    if (!d.isDirectory()) return false;
    try {
      return fs.readdirSync(path.join(SESSIONS_ROOT, d.name)).some((n) => n.endsWith(".jsonl"));
    } catch {
      return false;
    }
  });
  if (!groupEntry) throw new Error("本机 sessions 下没有 .jsonl，无法取样");
  const realDir = path.join(SESSIONS_ROOT, groupEntry.name);
  const pick = fs.readdirSync(realDir).filter((n) => n.endsWith(".jsonl")).map((n) => ({ n, size: fs.statSync(path.join(realDir, n)).size })).sort((a, b) => a.size - b.size)[0];
  const srcFile = path.join(SESSIONS, pick.n);
  fs.copyFileSync(path.join(realDir, pick.n), srcFile);

  // 500 条合成会话（内容可见耗时 + 懒加载）
  const bigId = "01a1b500-0000-0000-0000-000000000500";
  const bigMessages = [];
  for (let i = 0; i < 500; i++) {
    bigMessages.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `${i % 2 === 0 ? "问" : "答"} 第 ${i} 条 ${"内容".repeat(20)}` }] });
  }
  const bigFile = path.join(SESSIONS, `2026-11-06T00-00-00-000Z_${bigId}.jsonl`);
  await fsp.writeFile(bigFile, sessionLines({ id: bigId, cwd: os.homedir(), messages: bigMessages }), "utf8");

  // 接管失败样本：cwd 指向不存在的目录
  const badFile = path.join(SESSIONS, "2026-11-06T00-00-00-000Z_01a1b900-0000-0000-0000-000000000900.jsonl");
  await fsp.writeFile(badFile, sessionLines({ id: "01a1b900-0000-0000-0000-000000000900", cwd: "C:\\Users\\user\\pi-shell-m2a-gone", messages: [{ role: "user", content: "看得到但接管不了" }, { role: "assistant", content: [{ type: "text", text: "内容可见" }] }] }), "utf8");

  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    check(`端口 ${PORT} 空闲`, false, "已有 bridge 在跑");
    process.exit(1);
  } catch {}

  const logs = [];
  const logFile = path.join(OUT, "bridge.log");
  const bridge = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_SESSIONS_DIR: SESSIONS, PI_SHELL_CWD: WORK, PI_SHELL_LOG_FILE: logFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // H-15：桥在非 TTY 下只写文件日志；这里读文件（不再依赖 stderr 管道）
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n") : []);
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) logs.push(l);
  });

  let edge = null;
  let sse = null;
  try {
    for (let i = 0; i < 300; i++) {
      try {
        if ((await getJson("/api/health")).data?.pi?.state === "idle") break;
      } catch {}
      await sleep(150);
    }
    sse = openSse();
    await sse.ready;

    // ---------- ① + ②：view 先到，attach 后台 ----------
    const tOpen = Date.now();
    const openBig = await post("/api/session/open", { path: bigFile });
    const viewMs = Date.now() - tOpen;
    check(
      "① 500 条会话「内容可见」≤2s（读文件，不等 switch）",
      openBig.status === 200 && openBig.data?.mode === "view" && (openBig.data?.entries?.length ?? 0) >= 500 && viewMs <= 2000,
      `${viewMs}ms · mode=${openBig.data?.mode} · entries=${openBig.data?.entries?.length} · attach=${openBig.data?.attach}`,
    );
    let attached = null;
    try {
      attached = await sse.waitFor((f) => f.type === "session_attached" && String(f.sessionFile).includes("000500"), 30000, "session_attached(big)");
    } catch {}
    info("② 接管完成耗时（只记录，不设门槛）", attached ? `${attached.ms}ms（SSE session_attached）` : "未在 30s 内完成（也记录）");
    check("② 接管成功事件到达（内容先行、接管后行）", !!attached, attached ? `ms=${attached.ms}` : "无 session_attached");

    // ---------- ④ 同一文件已附着 → 复用 get_entries ----------
    sse.clear();
    const beforeReuse = readLog().length;
    const tReuse = Date.now();
    const reuse = await post("/api/session/open", { path: bigFile });
    const reuseMs = Date.now() - tReuse;
    check(
      "④ 同一文件已附着：直接 get_entries（mode=live / attach=attached，不再 switch）",
      reuse.status === 200 && reuse.data?.mode === "live" && reuse.data?.attach === "attached" && reuseMs < 1500,
      `mode=${reuse.data?.mode} attach=${reuse.data?.attach} ${reuseMs}ms`,
    );
    check("④ 复用路径不产生新的 switch（日志无 session_attached 重复）", !readLog().slice(beforeReuse).some((l) => /session_attached/.test(l)), "");

    // ---------- ③ 接管失败：cwd 不存在 → 内容仍可看 ----------
    sse.clear();
    const badOpen = await post("/api/session/open", { path: badFile });
    const failedEvt = await sse.waitFor((f) => f.type === "session_attach_failed" && String(f.sessionFile).includes("000900"), 15000, "attach failed").catch(() => null);
    check(
      "③ 接管失败仍返回内容（mode=view + entries>0）",
      badOpen.status === 200 && badOpen.data?.mode === "view" && (badOpen.data?.entries?.length ?? 0) > 0,
      `entries=${badOpen.data?.entries?.length}`,
    );
    check("③ SSE session_attach_failed（CONFLICT）+ 原因可读", !!failedEvt && failedEvt.code === "CONFLICT" && /目录/.test(String(failedEvt.reason || "")), failedEvt ? `${failedEvt.code} ${failedEvt.reason}` : "无事件");

    // ---------- T-16：tree / fork / clone（先打开源会话并等接管完成） ----------
    const openSrc = await post("/api/session/open", { path: srcFile });
    check("T-16 打开源会话（view）", openSrc.status === 200 && !!openSrc.data?.sessionId, String(openSrc.data?.sessionId).slice(0, 8));
    try {
      await sse.waitFor((f) => f.type === "session_attached" && String(f.sessionFile).includes(pick.n.replace(/\.jsonl$/, "").slice(-12)), 30000, "attached(src)");
    } catch {
      await sleep(3500); // 兜底：接管约 3s
    }
    const tree1 = await getJson("/api/session/tree");
    const nodes = tree1.data?.tree ?? [];
    const flat = [];
    const walk = (ns) => ns.forEach((n) => { flat.push(n); walk(n.children ?? []); });
    walk(nodes);
    const userNode = flat.find((n) => n.entry?.type === "message" && n.entry?.message?.role === "user");
    check("T-16 GET /api/session/tree 直通（含 entry/children/leafId）", tree1.status === 200 && flat.length > 0 && "leafId" in (tree1.data ?? {}), `nodes=${flat.length}`);
    check("T-16 树里有可 fork 的 user 消息", !!userNode, userNode?.entry?.id ?? "无");

    const beforeFiles = fs.readdirSync(SESSIONS).filter((n) => n.endsWith(".jsonl")).length;
    const fork = await post("/api/session/fork", { entryId: userNode?.entry?.id });
    check("T-16 fork 成功且 sessionFile 变化", fork.status === 200 && fork.data?.cancelled === false && fork.data?.sessionFile && path.resolve(fork.data.sessionFile) !== path.resolve(srcFile), `${String(fork.data?.sessionFile || "").split("\\").pop()}`);
    await post("/api/prompt", { message: "只回复两个字：好。" });
    const afterForkFiles = await waitForFile(SESSIONS, beforeFiles + 1);
    const forkFile = fork.data?.sessionFile ? path.resolve(fork.data.sessionFile) : null;
    check("T-16 fork 后出现新 .jsonl（发送消息后落盘，H-5）", !!forkFile && afterForkFiles.some((n) => path.resolve(path.join(SESSIONS, n)) === forkFile), `文件数 ${beforeFiles} → ${afterForkFiles.length}`);
    const listAfterFork = await getJson("/api/sessions");
    check("T-16 fork 后列表立刻可见（SessionIndex 缓存已失效）", (listAfterFork.data?.groups ?? []).flatMap((g) => g.sessions).length >= beforeFiles + 1, "");

    const beforeClone = fs.readdirSync(SESSIONS).filter((n) => n.endsWith(".jsonl")).length;
    const clone = await post("/api/session/clone");
    check("T-16 clone 成功且 sessionFile 变化", clone.status === 200 && clone.data?.cancelled === false && clone.data?.sessionFile && path.resolve(clone.data.sessionFile) !== forkFile, String(clone.data?.sessionFile || "").split("\\").pop());
    const cloneFile = clone.data?.sessionFile ? path.resolve(clone.data.sessionFile) : null;
    await post("/api/prompt", { message: "只回复两个字：嗯。" });
    const afterCloneFiles = await waitForFile(SESSIONS, beforeClone + 1);
    check("T-16 clone 后出现新 .jsonl", !!cloneFile && afterCloneFiles.some((n) => path.resolve(path.join(SESSIONS, n)) === cloneFile), `文件数 ${beforeClone} → ${afterCloneFiles.length}`);
    const tree2 = await getJson("/api/session/tree");
    const flat2 = [];
    const walk2 = (ns) => ns.forEach((n) => { flat2.push(n); walk2(n.children ?? []); });
    walk2(tree2.data?.tree ?? []);
    const cloneUsers = flat2.filter((n) => n.entry?.type === "message" && n.entry?.message?.role === "user");
    check("T-16 clone 后当前会话树有自己的分支（含 user 节点）", tree2.status === 200 && cloneUsers.length >= 1, `user=${cloneUsers.length}`);
    check("T-16 fork 返回被 fork 的 user 文本", String(fork.data?.text || "").trim().length > 0, String(fork.data?.text || "").slice(0, 20));

    // ---------- T-17：文件 / 越界 / 大小 ----------
    const rootList = await getJson("/api/files");
    check("T-17 GET /api/files 列工作区根（目录在前）", rootList.status === 200 && (rootList.data?.entries ?? []).length > 0 && rootList.data.entries[0].type === "dir", `entries=${rootList.data?.entries?.length}`);
    check("T-17 子目录可进入", (await getJson("/api/files?path=sub")).status === 200, "");
    const md = await getJson("/api/file?path=readme.md");
    check("T-17 预览 Markdown", md.status === 200 && String(md.data?.mime).startsWith("text/markdown") && String(md.data?.content).includes("# 标题"), md.data?.mime);
    const pngRes = await getJson("/api/file?path=dot.png");
    check("T-17 预览图片（base64 + image/png）", pngRes.status === 200 && pngRes.data?.mime === "image/png" && pngRes.data?.encoding === "base64", `${pngRes.data?.size}B`);
    const jsRes = await getJson("/api/file?path=code.js");
    check("T-17 预览代码", jsRes.status === 200 && String(jsRes.data?.mime).includes("javascript"), jsRes.data?.mime);

    const junction = path.join(WORK, "escape");
    try {
      execFileSync("cmd", ["/c", "mklink", "/J", junction, os.homedir()], { stdio: "ignore" });
    } catch {}
    const cases = [
      ["..%2f", "/api/file?path=..%2f..%2fWindows%2fwin.ini"],
      ["绝对路径", "/api/file?path=C%3A%2FWindows%2Fwin.ini"],
      ["junction", "/api/file?path=escape%2F.pi"],
      ["盘符相对", "/api/file?path=C%3A%5CWindows%5Cwin.ini"],
    ];
    const codes = [];
    for (const [name, url] of cases) codes.push(`${name}:${(await getJson(url)).status}`);
    check("T-17 越界四例全部 403", codes.every((c) => c.endsWith("403")), codes.join(" "));
    try {
      execFileSync("cmd", ["/c", "rmdir", junction], { stdio: "ignore" });
    } catch {}
    const bigText = await getJson("/api/file?path=big-text.txt");
    const bigBin = await getJson("/api/file?path=big.bin");
    check("T-17 超限 400（文本 >1MiB / 二进制 >8MiB）", bigText.status === 400 && bigBin.status === 400, `${bigText.status}/${bigBin.status}`);

    // ---------- 页面：内容可见 + 懒加载 + 接管横幅 ----------
    const edgePath = findEdge();
    if (!edgePath) {
      check("找到 Edge", false, "未找到 msedge.exe");
    } else {
      const debugPort = await freePort(PORT + 1400);
      edge = spawn(edgePath, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(OUT, "edge")}`, "--window-size=1440,900", `${BASE}/`], { stdio: "ignore" });
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

      // 先附着到源会话，确保随后打开 big 走「读文件」路径（而不是复用）
      await post("/api/session/open", { path: srcFile });
      await sleep(3500);

      const lazy = await evaluate(
        cdp,
        `(async () => {
          const t0 = performance.now();
          await window.__piShell.openSessionPath(${JSON.stringify(path.resolve(bigFile).replace(/\\/g, "/"))});
          const visibleMs = Math.round(performance.now() - t0);
          const body = document.querySelector('[data-role=entries]');
          const rendered = Number(body?.dataset.entries || 0);
          const total = Number(body?.dataset.total || 0);
          const more = document.querySelector('[data-role=load-more]');
          more?.click();
          await new Promise((r) => setTimeout(r, 300));
          const after = Number(document.querySelector('[data-role=entries]')?.dataset.entries || 0);
          return { visibleMs, rendered, total, more: !!more, after };
        })()`,
      );
      check("① 页面：500 条内容可见 ≤2s", lazy.visibleMs <= 2000, `${lazy.visibleMs}ms`);
      check("T-17 懒加载先渲染末 100 条（total≥500）", lazy.rendered === 100 && lazy.total >= 500 && lazy.more, `${lazy.rendered}/${lazy.total}`);
      check("T-17 「加载更早」追加 100 条", lazy.after === 200, `${lazy.rendered} → ${lazy.after}`);
      await shot(cdp, "m2a-lazy.png");

      // 接管完成后的按钮状态（页面侧）
      const attachUi = await evaluate(
        cdp,
        `(async () => {
          const t0 = performance.now();
          while (performance.now() - t0 < 15000 && window.__piShell.attachState !== 'attached') await new Promise((r) => setTimeout(r, 100));
          return { state: window.__piShell.attachState, sendDisabled: document.getElementById('send').disabled, ms: Math.round(performance.now() - t0) };
        })()`,
      );
      info("② 页面：接管完成耗时（只记录）", `${attachUi.ms}ms · state=${attachUi.state}`);
      check("② 接管完成后 Composer 可用", attachUi.state === "attached" && attachUi.sendDisabled === false, `state=${attachUi.state}`);

      // ③ 失败路径（页面）：内容可见 + 横幅 + 重试按钮
      const failUi = await evaluate(
        cdp,
        `(async () => {
          await window.__piShell.openSessionPath(${JSON.stringify(path.resolve(badFile).replace(/\\/g, "/"))});
          const t0 = performance.now();
          while (performance.now() - t0 < 15000 && window.__piShell.attachState !== 'failed') await new Promise((r) => setTimeout(r, 100));
          const banner = document.getElementById('attach-banner');
          return {
            state: window.__piShell.attachState,
            entries: Number(document.querySelector('[data-role=entries]')?.dataset.entries || 0),
            bannerHidden: banner.hidden,
            text: document.getElementById('attach-text').textContent,
            retryVisible: document.getElementById('attach-retry').hidden === false,
            sendDisabled: document.getElementById('send').disabled,
          };
        })()`,
      );
      check(
        "③ 页面：内容仍可看 + 接管失败横幅 + 重试按钮 + Composer 禁用",
        failUi.entries > 0 && failUi.state === "failed" && failUi.bannerHidden === false && failUi.retryVisible && failUi.sendDisabled === true,
        `entries=${failUi.entries} state=${failUi.state} “${String(failUi.text).slice(0, 28)}”`,
      );
      await shot(cdp, "m2a-attach-failed.png");

      // UI 树 / 文件面板（回归 #10/#11）
      await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(srcFile.replace(/\\/g, "/"))})`);
      await sleep(3500);
      await evaluate(cdp, `document.getElementById('open-tree').click()`);
      await sleep(700);
      const treeUi = await evaluate(cdp, `(() => ({ nodes: document.querySelectorAll('.tree-node').length, forks: document.querySelectorAll('[data-fork-entry]').length, leaf: document.querySelectorAll('.tree-node.is-leaf').length }))()`, false);
      check("T-16 UI 树：节点 + user 可 fork + leaf 高亮", treeUi.nodes > 0 && treeUi.forks > 0 && treeUi.leaf === 1, `nodes=${treeUi.nodes} fork=${treeUi.forks} leaf=${treeUi.leaf}`);
      await shot(cdp, "m2a-tree.png");

      await evaluate(cdp, `document.getElementById('open-files').click()`);
      await sleep(600);
      await evaluate(cdp, `(() => { const b = [...document.querySelectorAll('[data-role=file-item]')].find((x) => x.dataset.path === 'readme.md'); b?.click(); return !!b; })()`, false);
      await sleep(600);
      const previewUi = await evaluate(cdp, `(() => ({ files: document.querySelectorAll('[data-role=file-item],[data-role=file-dir]').length, heading: document.querySelector('[data-role=preview] h1')?.textContent || '' }))()`, false);
      check("T-17 UI 文件面板 + Markdown 预览", previewUi.files > 0 && previewUi.heading.includes("标题"), `files=${previewUi.files} h1=${previewUi.heading}`);
      await shot(cdp, "m2a-preview.png");
      cdp.close();
    }
  } catch (err) {
    check("运行异常", false, err.message);
  } finally {
    sse?.abort();
    try {
      edge?.kill("SIGKILL");
    } catch {}
    kill(bridge.pid);
    await sleep(2500);
    check("收尾：无残留 bridge / pi 进程", psCount("pi-shell-m2a") === 0, `残留=${psCount("pi-shell-m2a")}`);
    await fsp.writeFile(path.join(OUT, "bridge.log"), logs.join("\n"));
    const failed = results.filter((r) => !r.pass);
    await fsp.writeFile(path.join(OUT, "summary.txt"), results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`).join("\n") + "\n");
    console.log(`\n${results.length - failed.length}/${results.length} PASS；产出：${OUT}`);
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
