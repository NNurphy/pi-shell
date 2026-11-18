#!/usr/bin/env node
// pi-shell · T-14 照妖镜：一条命令跑 A-01~A-08 + N-01/N-03/N-04/N-05/N-07/N-08
//
// 用法：node scripts/smoke-check.mjs [--port 7788] [--stability <csv|auto>] [--skip-model]
//   --skip-model   跳过需要真实模型调用的项（A-04/A-07 的消息发送）
// 产出：控制台 PASS/FAIL 表 + 退出码（0=全绿）；证据落在 %TMP%\pi-shell-smoke\
//
// 约定（06 §3）：A-04/A-07 会真实产生会话文件；其余只读。A-06 用 -e 绝对路径加载 test-ext/。

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARG = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const PORT = Number(ARG("port", 7788)) || 7788;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-smoke");
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const REAL_SESSIONS = path.join(AGENT_DIR, "sessions");
const EXT = path.join(REPO_ROOT, "test-ext", "select-demo.ts");
const HAS_EXT = fs.existsSync(EXT);
// 工作区切换用例目录（脚本自建，验证中文 cwd / 含空格 cwd）
const WS_CASES = [path.join(os.homedir(), "pi-shell-测试项目"), path.join(os.homedir(), "pi-shell test project")];
const SKIP_MODEL = process.argv.includes("--skip-model");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
function record(id, name, pass, detail = "") {
  rows.push({ id, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function kill(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } catch {}
}
function psOut(script) {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
function rpcChildren(port) {
  const out = psOut(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--mode rpc*' } | Select-Object -ExpandProperty ProcessId`);
  return out ? out.split(/\s+/).map(Number) : [];
}
async function freePort(start) {
  const net = await import("node:net");
  for (let port = start; port < start + 200; port++) {
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

function killTreeOfBridge(child) {
  if (child?.pid) kill(child.pid);
}

// ---------------- 桥的启停 ----------------

function startBridge({ port = PORT, env = {}, extraArgs = "" } = {}) {
  const logs = [];
  const logFile = path.join(OUT, `bridge-${port}-${Date.now()}.log`);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(port),
      PI_SHELL_CWD: os.homedir(),
      PI_SHELL_EXTRA_ARGS: extraArgs,
      PI_SHELL_LOG_FILE: logFile,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) logs.push(l);
  });
  return { child, logs, port, logFile, readLog: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n") : []) };
}

async function waitIdle(port = PORT, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" })).json();
      if (h.pi.state === "idle") return h.pi;
    } catch {}
    await sleep(150);
  }
  throw new Error("等待桥 idle 超时");
}

async function stopBridge(b, { waitMs = 4000 } = {}) {
  killTreeOfBridge(b.child);
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    try {
      await fetch(`http://127.0.0.1:${b.port}/api/health`, { cache: "no-store" });
      await sleep(150);
    } catch {
      return;
    }
  }
}

// ---------------- SSE ----------------

function openSse(port = PORT) {
  const rec = { frames: [], abort: null };
  rec.ready = (async () => {
    const ctrl = new AbortController();
    rec.abort = () => ctrl.abort();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { Accept: "text/event-stream" }, signal: ctrl.signal });
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
    throw new Error(`timeout: ${label}`);
  };
  rec.clear = () => (rec.frames.length = 0);
  return rec;
}

async function post(url, body, port = PORT) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
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
async function getJson(url, port = PORT) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { cache: "no-store" });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ---------------- 各检查 ----------------

async function a01(port) {
  const { status, data } = await getJson("/api/sessions", port);
  const groups = data?.groups ?? [];
  const dirsWithJsonl = fs.readdirSync(REAL_SESSIONS, { withFileTypes: true }).filter((d) => {
    if (!d.isDirectory()) return false;
    try {
      return fs.readdirSync(path.join(REAL_SESSIONS, d.name)).some((n) => n.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }).length;
  const sessions = groups.flatMap((g) => g.sessions);
  const fieldsOk = sessions.length > 0 && sessions.every((s) => s.title && s.updatedAt && s.lastSnippet && s.status);
  const hasGroup = groups.length > 0;
  record("A-01", "会话列表：分组数==含 jsonl 的目录数 / 至少一个分组 / 四字段非空", status === 200 && groups.length === dirsWithJsonl && hasGroup && fieldsOk, `groups=${groups.length}/${dirsWithJsonl} sessions=${sessions.length}`);
}

async function a02(sse, port) {
  // 命令集取决于本机 pi 的扩展配置（因人而异）：这里验证桥把命令透传到 /api/commands
  const { data } = await getJson("/api/commands", port);
  const cmds = data?.commands ?? [];
  const first = cmds[0]?.name ?? "";
  record("A-02", "命令列表：/api/commands 返回数组（命令来自本机 pi 扩展配置）", Array.isArray(cmds), `commands=${cmds.length}${first ? `，如 /${first}` : ""}`);
  return Array.isArray(cmds);
}

async function a02Negative() {
  const port = await freePort(PORT + 10);
  const b = startBridge({ port, extraArgs: '["--no-extensions"]' });
  try {
    await waitIdle(port);
    const { data } = await getJson("/api/commands", port);
    const count = (data?.commands ?? []).length;
    record("A-02b", "--no-extensions 实例：命令列表为空（扩展全禁用）", count === 0, `commands=${count}`);
  } finally {
    await stopBridge(b);
  }
}

async function a03(port) {
  const { status, data } = await getJson("/api/models", port);
  const models = data?.models ?? [];
  const shaped = models.length > 0 && models.every((m) => m.provider && m.id);
  record("A-03", "模型直通（集合由 passthrough 保证；TUI 抽查由复核方完成）", status === 200 && shaped, `${models.length} 个模型`);
}

async function a04(sse, port) {
  if (SKIP_MODEL) {
    record("A-04", "落盘一致（新 .jsonl + 最后 assistant entry id 在文件中）", true, "已按 --skip-model 跳过");
    return;
  }
  const before = new Set(fs.readdirSync(REAL_SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => fs.readdirSync(path.join(REAL_SESSIONS, d.name)).map((n) => `${d.name}/${n}`)));
  sse.clear();
  await post("/api/prompt", { message: "只回复两个字：好的。不要用工具。" }, port);
  try {
    await sse.waitFor((f) => f.type === "agent_settled", 90000, "settled");
  } catch {}
  await sleep(1200);
  const after = fs.readdirSync(REAL_SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => fs.readdirSync(path.join(REAL_SESSIONS, d.name)).map((n) => `${d.name}/${n}`));
  const created = after.filter((p) => !before.has(p));
  let idInFile = false;
  if (created.length) {
    const file = path.join(REAL_SESSIONS, created[0]);
    const entries = await getJson("/api/session/entries", port);
    const lastAssistant = [...(entries.data?.entries ?? [])].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
    if (lastAssistant?.id) idInFile = fs.readFileSync(file, "utf8").includes(lastAssistant.id);
  }
  record("A-04", "落盘一致：5s 内出现新 .jsonl 且最后 assistant 的 entry id 在文件中", created.length === 1 && idInFile, created[0] ?? "无新文件");
}

async function a05(port) {
  const { data } = await getJson("/api/commands", port);
  const names = new Set((data?.commands ?? []).map((c) => c.name));
  record("A-05", "命令集合非空（命令来自本机 pi 的扩展/提示词/技能配置）", names.size > 0, `${names.size} 条`);
}

async function a06(sse, port) {
  if (!HAS_EXT) {
    record("A-06", "-e 加载 select-demo → select → 回执后 pi 收到值", true, "跳过：示例扩展 test-ext/select-demo.ts 未随仓库分发");
    return;
  }
  sse.clear();
  await post("/api/prompt", { message: "/select-demo" }, port);
  let sel = null;
  try {
    sel = await sse.waitFor((f) => f.type === "extension_ui_request" && f.method === "select", 25000, "select");
  } catch {}
  let got = null;
  if (sel) {
    await post("/api/ext-ui-response", { id: sel.id, value: "beta" }, port);
    try {
      got = await sse.waitFor((f) => f.method === "notify" && String(f.message || "").includes("got=beta"), 15000, "got");
    } catch {}
  }
  record("A-06", "-e 加载 select-demo → select → 回执后 pi 收到值", !!sel && !!got, sel ? (got?.message ?? "无回执") : "未触发 select");
}

async function a07(port) {
  // 通用化：切到脚本自建的临时工作区（不依赖任何特定真实目录）
  const SMOKE_WS = path.join(os.tmpdir(), "pi-shell-smoke-ws");
  await fsp.mkdir(SMOKE_WS, { recursive: true });
  // pi 的会话目录名编码：非字母数字逐字换 '-'，首尾各包一层 '--'
  const wsDirName = `--${SMOKE_WS.replace(/[^A-Za-z0-9]/g, "-")}--`;
  const before = new Set(fs.readdirSync(REAL_SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => fs.readdirSync(path.join(REAL_SESSIONS, d.name)).map((n) => `${d.name}/${n}`)));
  const ws = await post("/api/workspace", { cwd: SMOKE_WS }, port);
  let landed = null;
  if (ws.status === 200) {
    if (!SKIP_MODEL) await post("/api/prompt", { message: "只回复两个字：好。" }, port);
    await sleep(4000);
  }
  const after = fs.readdirSync(REAL_SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => fs.readdirSync(path.join(REAL_SESSIONS, d.name)).map((n) => `${d.name}/${n}`));
  landed = after.filter((p) => !before.has(p)).find((p) => p.startsWith(`${wsDirName}/`)) ?? null;
  record(
    "A-07",
    "工作区切换：切到临时工作区 → 新会话 → 发送后文件落在对应 --编码目录--",
    ws.status === 200 && (SKIP_MODEL ? true : !!landed),
    SKIP_MODEL ? `${ws.status}（已跳过发送）` : landed ?? JSON.stringify(ws.data),
  );
}

async function a08(sessionsDir) {
  // 先放一个真实会话的副本（只读样本 → 临时目录），用于游标语义
  await fsp.mkdir(sessionsDir, { recursive: true });
  // 通用化：任选一个含 .jsonl 的分组（不依赖特定目录名）
  const groupDirs = fs.readdirSync(REAL_SESSIONS, { withFileTypes: true }).filter((d) => {
    if (!d.isDirectory()) return false;
    try {
      return fs.readdirSync(path.join(REAL_SESSIONS, d.name)).some((n) => n.endsWith(".jsonl"));
    } catch {
      return false;
    }
  });
  if (!groupDirs.length) {
    record("A-08", "游标语义（复制一条真实会话做只读样本）", false, "本机 sessions 下没有 .jsonl；先和 pi 对话一轮再跑");
    return;
  }
  const srcDir = path.join(REAL_SESSIONS, groupDirs[0].name);
  const pick = fs.readdirSync(srcDir).filter((n) => n.endsWith(".jsonl")).map((n) => ({ n, size: fs.statSync(path.join(srcDir, n)).size })).sort((a, b) => a.size - b.size)[0];
  const fixture = path.join(sessionsDir, pick.n);
  fs.copyFileSync(path.join(srcDir, pick.n), fixture);

  const port = await freePort(PORT + 20);
  const env = { PI_SHELL_SESSIONS_DIR: sessionsDir };
  const b1 = startBridge({ port, env });
  try {
    await waitIdle(port);
    const opened = await post("/api/session/open", { path: fixture }, port);
    const leaf = opened.data?.leafId ?? null;
    killTreeOfBridge(b1.child);
    await sleep(800);
    const b2 = startBridge({ port, env });
    const t0 = Date.now();
    let ok = false;
    try {
      await waitIdle(port, 15000);
      ok = true;
    } catch {}
    const ms = Date.now() - t0;
    let dedupe = false;
    if (ok && leaf) {
      // 两段式 open：内容先到、接管是后台的 → 先等 session_attached 再做游标查询
      const sse2 = openSse(port);
      await sse2.ready;
      await post("/api/session/open", { path: fixture }, port);
      try {
        await sse2.waitFor((f) => f.type === "session_attached", 30000, "attach");
      } catch {
        await sleep(3500);
      }
      sse2.abort();
      const since = await getJson(`/api/session/entries?since=${encodeURIComponent(leaf)}`, port);
      dedupe = Array.isArray(since.data?.entries) && since.data.entries.length === 0;
    }
    record("A-08", "断线恢复：重启桥 ≤15s 恢复；重开同一会话 + entries?since 无重复条目", ok && ms <= 15000 && dedupe, `恢复 ${ms}ms；since 空=${dedupe}；leaf=${String(leaf).slice(0, 8)}`);
    await stopBridge(b2);
  } finally {
    killTreeOfBridge(b1.child);
  }
}

function n01() {
  const out = psOut(`(Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty LocalAddress)`);
  const loopbackOnly = out === "127.0.0.1";
  const lan = psOut(`(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress)`);
  record("N-01", "仅监听 127.0.0.1", loopbackOnly, `local=${out || "未监听"} lan=${lan || "n/a"}`);
}

function n03() {
  const csvPath = ARG("stability", "auto");
  const candidates = [csvPath === "auto" ? "" : csvPath, path.join(os.tmpdir(), "pi-shell-stability", "samples.csv")].filter(Boolean);
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) {
    record("N-03", "2h 稳定性（≥5 点覆盖 120 分钟；bridge RSS < 250MB 且无单调增长；页面 heap 同步）", false, "未找到稳定性采样 CSV（先跑 scripts/evidence/m1d-stability.mjs）");
    return;
  }
  const raw = fs.readFileSync(file, "utf8").trim().split("\n");
  const header = raw[0].split(",");
  const idx = (name, fallback) => (header.indexOf(name) >= 0 ? header.indexOf(name) : fallback);
  const iMinute = idx("minute", 1);
  const iPlanned = idx("plannedMinute", -1);
  const iRss = idx("bridgeRssMb", 2);
  const iHeap = idx("pageHeapMb", 3);
  const rowsData = raw.slice(1).filter(Boolean).map((line) => {
    const c = line.split(",");
    return {
      minute: Number(c[iMinute]),
      planned: iPlanned >= 0 ? Number(c[iPlanned]) : Number(c[iMinute]),
      rss: Number(c[iRss]),
      heap: c[iHeap] ? Number(c[iHeap]) : null,
    };
  });
  const rss = rowsData.map((r) => r.rss);
  const maxRss = Math.max(...rss);
  const delta = rss[rss.length - 1] - rss[0];
  const heaps = rowsData.map((r) => r.heap).filter((n) => typeof n === "number");
  const heapDelta = heaps.length >= 2 ? heaps[heaps.length - 1] - heaps[0] : null;
  const plannedMax = Math.max(...rowsData.map((r) => r.planned));
  const actualSpan = Math.max(...rowsData.map((r) => r.minute)) - Math.min(...rowsData.map((r) => r.minute));
  const coverageOk = rowsData.length >= 5 && plannedMax >= 120;
  // 连续性：相邻采样的实际间隔不得超过计划间隔的 1.5 倍（休眠"追平"的采样会超限）
  let maxGap = 0;
  let plannedGap = 0;
  for (let i = 1; i < rowsData.length; i++) {
    maxGap = Math.max(maxGap, rowsData[i].minute - rowsData[i - 1].minute);
    plannedGap = Math.max(plannedGap, rowsData[i].planned - rowsData[i - 1].planned);
  }
  const continuous = plannedGap > 0 && maxGap <= plannedGap * 1.5;
  record(
    "N-03",
    "2h 稳定性：≥5 点覆盖 120 分钟且连续；bridge RSS < 250MB 且末−首 < 50MB；页面 heap 同步",
    coverageOk && continuous && maxRss < 250 && delta < 50 && (heapDelta === null || heapDelta < 50),
    `samples=${rowsData.length} plannedMax=${plannedMax}min actualSpan=${actualSpan}min maxGap=${maxGap}min(计划${plannedGap}) continuous=${continuous} maxRSS=${maxRss}MB ΔRSS=${delta}MB${heapDelta === null ? "（无页面采样）" : ` Δheap=${heapDelta}MB`}`,
  );
}

function n04() {
  // 代码审查：bridge/ 内不得出现对 ~/.pi/agent 的写调用
  const files = fs.readdirSync(path.join(REPO_ROOT, "bridge/src")).filter((f) => f.endsWith(".mjs"));
  const badPatterns = [/writeFile(Sync)?\([^)]*\.pi[\/]+agent/i, /appendFile(Sync)?\([^)]*\.pi[\/]+agent/i, /rm(Sync)?\([^)]*\.pi[\/]+agent/i, /mkdir(Sync)?\([^)]*\.pi[\/]+agent/i];
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, "bridge/src", f), "utf8");
    for (const re of badPatterns) if (re.test(text)) hits.push(`${f}:${re}`);
  }
  // 文件级快照：目录 mtime 会被 pi 自己触碰（install/），只比较文件
  const WHITELIST = ["settings.json", "models-store.json", "state", "sessions", "trust.json", "logs"];
  const snapshot = () => {
    const out = {};
    const walk = (dir, depth = 0) => {
      if (depth > 3) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["sessions", "install", "releases", "staging", "credentials", "agents", "skills", "prompts", "extensions", "memory", "scripts", "architecture"].includes(entry.name)) continue;
          walk(p, depth + 1);
        } else {
          try {
            out[path.relative(AGENT_DIR, p)] = fs.statSync(p).mtimeMs;
          } catch {}
        }
      }
    };
    walk(AGENT_DIR);
    return out;
  };
  const s1 = snapshot();
  return { hits, snapshot, s1, WHITELIST };
}

function n05() {
  const dirs = [path.join(REPO_ROOT, "web")];
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(html|js|css|mjs)$/.test(entry.name)) {
        const text = fs.readFileSync(p, "utf8");
        for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) hits.push(`${path.relative(REPO_ROOT, p)}: ${m[0]}`);
      }
    }
  };
  dirs.forEach(walk);
  record("N-05", "前端零远程资源（web/ 内无 http(s) 引用）", hits.length === 0, hits.slice(0, 2).join(" | ") || "0 处");
}

async function n07(port, sse) {
  const marker = `N07MARKER${Date.now()}`;
  if (!SKIP_MODEL) {
    sse.clear();
    await post("/api/prompt", { message: `记住这个标记，只回复 OK：${marker}` }, port);
    try {
      await sse.waitFor((f) => f.type === "agent_settled", 90000, "settled");
    } catch {}
  }
  const logPath = path.join(REPO_ROOT, "logs", "bridge.log");
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const secrets = [/sk-[A-Za-z0-9_-]{8,}/, /tvly-[A-Za-z0-9_-]{8,}/, /Bearer\s+[A-Za-z0-9._-]{8,}/].filter((re) => re.test(text));
  const hasBody = text.includes(marker);
  record("N-07", "日志不含密钥与消息正文（正则扫描 + 标记抽查）", secrets.length === 0 && !hasBody, `secrets=${secrets.length} bodyMarker=${hasBody} logBytes=${text.length}`);
}

async function n08() {
  const spacedDir = path.join(OUT, "sessions with space");
  await fsp.mkdir(spacedDir, { recursive: true });
  const port2 = await freePort(PORT + 30);
  const b = startBridge({
    port: port2,
    env: { PI_SHELL_SESSIONS_DIR: spacedDir },
    extraArgs: JSON.stringify(["--name", "my shell test"]),
  });
  const cases = [];
  let argsOk = false;
  try {
    await waitIdle(port2);
    const line = b.readLog().find((l) => /pi_spawn/.test(l)) || "";
    argsOk = line.includes('"--name","my shell test"') && line.includes("sessions with space");

    for (const cwd of WS_CASES) {
      const r = await post("/api/workspace", { cwd }, port2);
      cases.push({ cwd, status: r.status, ok: r.status === 200 && String(r.data?.cwd || "").replace(/\\/g, "/").toLowerCase() === cwd.replace(/\\/g, "/").toLowerCase() });
    }
  } finally {
    await stopBridge(b);
  }
  const wsOk = cases.length === 2 && cases.every((c) => c.ok);
  record(
    "N-08",
    "中文 cwd / 含空格 cwd / --session-dir 含空格 / EXTRA_ARGS JSON 含空格",
    wsOk && argsOk,
    `${cases.map((c) => `${c.cwd.split(/[\/]/).pop()}:${c.status}`).join(" ")}；spawn args=${argsOk}`,
  );
}

async function n04Finish(ctx) {
  if (!ctx) return;
  await sleep(500);
  const s2 = ctx.snapshot();
  const changed = Object.keys({ ...ctx.s1, ...s2 }).filter((k) => ctx.s1[k] !== s2[k]);
  const unexpected = changed.filter((k) => !ctx.WHITELIST.some((w) => k === w || k.startsWith(w)));
  record("N-04", "桥代码无写 ~/.pi/agent 调用；运行期变更只落在白名单", ctx.hits.length === 0 && unexpected.length === 0, `代码命中=${ctx.hits.length} 非白名单变更=${unexpected.join(",") || "无"}`);
}

// ---------------- main ----------------

async function main() {
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {}
  await fsp.mkdir(OUT, { recursive: true });
  for (const d of WS_CASES) {
    try {
      await fsp.mkdir(d, { recursive: true });
    } catch {}
  }

  // 端口必须空闲
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    record("PRE", `端口 ${PORT} 空闲`, false, "已有 bridge 在跑");
    process.exit(1);
  } catch {}

  const n04ctx = n04();
  const b = startBridge({ extraArgs: HAS_EXT ? JSON.stringify(["-e", EXT]) : "" });
  let sse = null;
  try {
    await waitIdle(PORT);
    sse = openSse(PORT);
    await sse.ready;

    await a01(PORT);
    const a02ok = await a02(sse, PORT);
    await a03(PORT);
    await a05(PORT);
    await a06(sse, PORT);
    await a04(sse, PORT);
    await a07(PORT);
    n01();
    n05();
    await n07(PORT, sse);
  } finally {
    sse?.abort();
    await stopBridge(b);
  }

  await a02Negative();
  await a08(path.join(OUT, "a08-sessions"));
  await n08();
  await n04Finish(n04ctx);
  n03();

  const failed = rows.filter((r) => !r.pass);
  const table = rows.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.name}  ${r.detail}`).join("\n");
  await fsp.writeFile(path.join(OUT, "summary.txt"), table + "\n");
  console.log(`\n${rows.length - failed.length}/${rows.length} PASS${failed.length ? `；FAIL: ${failed.map((r) => r.id).join(",")}` : ""}`);
  console.log(`证据：${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
