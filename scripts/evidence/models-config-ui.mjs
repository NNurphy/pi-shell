#!/usr/bin/env node
// B7 证据：模型列表只列「已配置」+ 热刷新（零依赖 CDP，默认端口 7837）
//
// 为什么存在：/api/models 直通 pi 的 get_available_models，本机 103 个模型里
// anthropic/openai 没有可用凭据；用户选中后发消息才 401。改了「只列有凭据」之后，
// 还必须证明「新配置凭据能立刻出现、不用重启桥、不用刷新整页」。
//
// 受控环境（绝不碰真实 ~/.pi/agent 与真实会话）：
//   PI_SHELL_AGENT_DIR = <tmp>/agent（自建 install 垫片 + auth.json + sessions + models.json 副本）
//   子进程环境里**故意**保留本机全部 *_API_KEY，并额外注入两个哨兵假 key：
//   B7-A「A 口径」要求环境变量完全不参与判定（只认 auth.json / credentials.env），
//   所以这些环境变量在 /api/models 里必须看不到（见断言 1c）。
//   引擎模型透传（PI_SHELL_PROVIDER / PI_SHELL_MODEL）在子进程环境里被清掉：
//   本用例的会话模型必须由夹具（fake deepseek 凭据 + settings 默认）决定。
//
// 关键事实（pi 1.5.0）：get_available_models 是「引擎启动时的可用性快照」，
// 只改 auth.json 不会让新 provider 的模型进入快照。所以这里初始 auth.json 里放一条
// `openai: {key: " "}`（只有空白，桥按「无凭据」处理，pi 认为凭据存在）——
// 这正好复刻真实机器：pi 的模型表里有 openai，但桥必须把它藏起来。
// 步骤 2 把空白换成假 key → 桥的 configured 集合变化 → 模型立刻出现（引擎未重启）。
//
// 覆盖：
//   1) 只写 auth.json 含 deepseek → 下拉只有 deepseek 的 2 个模型；/api/models 不含 anthropic/openai
//   2) 追加假 openai key → 点 ⟳ → 整页不刷新（marker 还在）就出现 openai 模型（数量增加）
//   3) 删除该 key → 点 ⟳ → openai 模型消失，数量回到 2
//   4) 刷新前后 #model-select 的当前值 == 会话真实模型（dataset.current / window.__lastModel）
//   5) 任何响应 / 页面日志 / 桥日志都不含假 key 明文
//   6) 截图 + 收尾清理
//
// 用法：
//   node scripts/evidence/models-config-ui.mjs
//   PI_SHELL_EVIDENCE_PORT=7840 node scripts/evidence/models-config-ui.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe
// 产出：docs/evidence/models-config-ui.png、<tmp>/pi-shell-models-config-ui/*.png、bridge.log
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 固定 7837（不用 PI_SHELL_PORT：某些环境会从已运行的桥继承 7788，撞端口）
const PORT = Number(process.env.PI_SHELL_EVIDENCE_PORT || 7837);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-models-config-ui");
const AGENT_DIR = path.join(OUT_DIR, "agent");
const SESSIONS = path.join(OUT_DIR, "sessions");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const SHOT_FINAL = path.join(SHOT_DIR, "models-config-ui.png");
const REAL_AGENT = path.join(os.homedir(), ".pi", "agent");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假凭据（只用于证明不会泄露；任何响应/日志出现即失败）
const FAKE_DEEPSEEK = "sk-fake-deepseek-b7-0123456789abcdef";
const FAKE_OPENAI = "sk-fake-openai-b7-fedcba9876543210";
// B7-A：只存在于环境变量里的假 key（不得被当成「已配置」）
const ENV_SENTINEL = "sk-fake-envonly-b7-00aa11bb22cc33dd";
const SECRET_RE = /sk-[A-Za-z0-9-]{6,}/;

const results = [];
const shots = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 受控 agent 目录 ----------

/** 自建 install 垫片：只读复用真实 pi 包，install 根指向 tmp（不写真实目录） */
function makeIsolatedAgentDir() {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const version = fs.readFileSync(path.join(REAL_AGENT, "install", "current-version"), "utf8").trim();
  const slot = path.join(AGENT_DIR, "install", "releases", version, "node_modules");
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(AGENT_DIR, "install", "current-version"), `${version}\n`);
  // 只 junction 包目录（只读）；install 根在 tmp，pi 的任何 install 侧写入都落 tmp
  fs.symlinkSync(path.join(REAL_AGENT, "install", "releases", version, "node_modules", "@earendil-works"),
    path.join(slot, "@earendil-works"), "junction");
  // 自定义 provider 声明（门禁会带 PI_SHELL_PROVIDER/PI_SHELL_MODEL 起桥：引擎解析不到该 provider
  // 就起不来）。只读复制真实文件，不硬编码任何模型名；本机没有就跳过（用内置 provider 也能跑）。
  const realModels = path.join(REAL_AGENT, "models.json");
  if (fs.existsSync(realModels)) fs.copyFileSync(realModels, path.join(AGENT_DIR, "models.json"));
  // 让会话初始模型落在 deepseek（否则 pi 会挑 openai——本环境的 openai 是空白凭据占位）
  fs.writeFileSync(path.join(AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' }, null, 2));
  fs.mkdirSync(SESSIONS, { recursive: true });
}

function writeAuth(providers) {
  fs.writeFileSync(path.join(AGENT_DIR, "auth.json"), JSON.stringify(providers, null, 2));
}

// 初始：deepseek 有假凭据；openai 只有空白值（pi 视为「有凭据条目」→ 模型表包含 openai，桥视为无凭据）
function writeInitialAuth() {
  writeAuth({
    deepseek: { type: "api_key", key: FAKE_DEEPSEEK },
    openai: { type: "api_key", key: " " },
  });
}

// ---------- bridge ----------

function childEnv() {
  // B7-A（A 口径）：桥不再读环境变量，所以这里**不再清** *_API_KEY，
  // 而是故意保留本机环境 + 额外注入两个哨兵，用 1c 断言证明环境变量不参与判定。
  //
  // 但引擎模型透传（PI_SHELL_PROVIDER/MODEL）必须清掉：本脚本自建 agent 目录，
  // 里面**只有 deepseek 的假凭据**（bailian/openai 等要么没凭据、要么是空白占位），
  // 会话模型只能由夹具决定。门禁整体带这对 env（bg-continue 的引擎透传）时，
  // 若透传进来，引擎就会跑一个本夹具「未配置」的模型 → 下拉里当前模型不可用，
  // 「只列已配置」这条用例的前提被破坏（与本用例要证明的事无关）。
  const env = { ...process.env };
  delete env.PI_SHELL_PROVIDER;
  delete env.PI_SHELL_MODEL;
  return {
    ...env,
    OPENAI_API_KEY: ENV_SENTINEL,
    ANTHROPIC_API_KEY: ENV_SENTINEL,
    PI_SHELL_PORT: String(PORT),
    PI_SHELL_AGENT_DIR: AGENT_DIR,
    PI_SHELL_SESSIONS_DIR: SESSIONS,
    PI_SHELL_LOG_FILE: LOG_FILE,
  };
}

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: childEnv(),
    stdio: "ignore", // H-15：不接管道（接管道不消费会把桥堵死）
  });
}

async function waitHealth(ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/api/health`, { cache: "no-store" });
      const body = await res.json();
      if (body?.ok && body?.pi?.state === "idle") return body;
    } catch {}
    await sleep(300);
  }
  return null;
}

async function getJson(pathname) {
  const res = await fetch(`${BASE}${pathname}`, { cache: "no-store" });
  return { status: res.status, text: await res.text() };
}

// ---------- Edge + CDP ----------

function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  return [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => fs.existsSync(p)) || null;
}

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  return {
    ready,
    on(fn) { listeners.push(fn); },
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

async function evaluate(cdp, expression, awaitPromise = false) {
  const res = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise, returnByValue: true, timeout: 120000,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function launchEdge(edgePath) {
  fs.rmSync(path.join(OUT_DIR, "edge-profile"), { recursive: true, force: true });
  const debugPort = PORT + 1000;
  const edge = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(OUT_DIR, "edge-profile")}`,
    "--window-size=1440,900",
    `${BASE}/`,
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge CDP 未就绪");
  return { edge, target };
}

const READY = `(() => ({
  version: (document.getElementById('version')?.textContent || '').trim(),
  state: (document.getElementById('state')?.textContent || '').trim(),
  input: !!document.getElementById('input'),
  reloadBtn: !!document.getElementById('reload-models'),
}))()`;

async function waitPageReady(cdp, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await evaluate(cdp, READY).catch(() => null);
    if (s?.input && s.reloadBtn && s.version && s.version !== "—") return s;
    await sleep(200);
  }
  return null;
}

// 真实鼠标点击：取中心 + elementFromPoint 证明没被遮住
async function clickElement(cdp, selector) {
  const box = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: "not found" };
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === el || el.contains(hit));
    return { x, y, ok };
  })()`);
  if (box.error || !box.ok) return { ...box, hit: false };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { ...box, hit: true };
}

async function shot(cdp, name) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, Buffer.from(s.data, "base64"));
  shots.push(p);
  return p;
}

// 下拉探针：分组 + 全部 option 值 + 当前选中值 / 页面自认值 / SSE 真实模型 / toast
const MODEL_PROBE = `(() => {
  const sel = document.getElementById('model-select');
  return {
    groups: sel ? [...sel.querySelectorAll('optgroup')].map((g) => ({ label: g.label, values: [...g.querySelectorAll('option')].map((o) => o.value) })) : [],
    values: sel ? [...sel.options].map((o) => o.value) : [],
    value: sel ? sel.value : null,
    current: sel ? (sel.dataset.current ?? null) : null,
    empty: sel ? (sel.dataset.empty ?? null) : null,
    last: window.__lastModel ?? null,
    toast: (document.getElementById('toast')?.textContent || '').trim(),
    notice: (document.getElementById('notice')?.textContent || '').trim(),
    marker: window.__b7Marker ?? null,
  };
})()`;

async function waitFor(cdp, fn, ms, label) {
  const t0 = Date.now();
  let last = null;
  let lastErr = null;
  while (Date.now() - t0 < ms) {
    last = await evaluate(cdp, MODEL_PROBE).catch((err) => { lastErr = err.message; return null; });
    if (last && fn(last)) return last;
    await sleep(200);
  }
  throw new Error(`等待超时（${label}）：${JSON.stringify(last)}${lastErr ? " err=" + lastErr : ""}`);
}

const isDeepseekOnly = (p) => p.groups.length === 1 && p.groups[0].label === "deepseek" && p.values.length === 2 &&
  p.values.every((v) => v.startsWith("deepseek/"));
const hasOpenai = (p) => p.groups.some((g) => g.label === "openai" && g.values.length > 0);

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  makeIsolatedAgentDir();
  writeInitialAuth();
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口（避免给出假证据）`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  let edge = null;
  let cdp = null;
  let health = null;
  try {
    health = await waitHealth();
    if (!health) throw new Error(`bridge 未在 40s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid}`);

    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;

    const pageErrors = [];
    const pageLogs = [];
    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        pageLogs.push((msg.params?.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" "));
      }
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const e = msg.params.entry;
        if (/favicon\.ico/.test(String(e.url || "") + " " + String(e.text || ""))) return;
        pageErrors.push(e.url ? `${e.text} (${e.url})` : e.text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");

    const ready = await waitPageReady(cdp);
    if (!ready) throw new Error("页面 25s 未就绪");
    console.log(`      页面就绪 · pi ${ready.version} · state=${ready.state}`);

    // ===== 1) 初始：只有 deepseek（auth.json） =====
    const initial = await waitFor(cdp, isDeepseekOnly, 15000, "初始下拉只有 deepseek");
    await shot(cdp, "models-1-deepseek-only.png");
    const apiDefault = await getJson("/api/models");
    const apiDefaultBody = JSON.parse(apiDefault.text);
    const apiAll = await getJson("/api/models?all=1");
    const apiAllBody = JSON.parse(apiAll.text);
    const apiProviders = [...new Set(apiDefaultBody.models.map((m) => m.provider))];
    check(
      "1) 只写 auth.json 的 deepseek → 下拉只有 deepseek 的 2 个模型；/api/models 不含 anthropic/openai",
      initial.groups.length === 1 && initial.groups[0].label === "deepseek" && initial.values.length === 2 &&
        apiProviders.length === 1 && apiProviders[0] === "deepseek" &&
        apiDefaultBody.models.every((m) => m.provider === "deepseek") &&
        apiDefaultBody.models.every((m) => m.configured === true) &&
        apiDefaultBody.configuredCount === 2 && apiAllBody.models.length > apiDefaultBody.models.length,
      `下拉=${JSON.stringify(initial.groups)} · /api/models providers=${JSON.stringify(apiProviders)} · ` +
        `configuredCount=${apiDefaultBody.configuredCount} · all=1=${apiAllBody.models.length}/${apiAllBody.total}（openai 在引擎表里但未配置）`,
    );

    // 1c) A 口径：环境变量里有 OPENAI_API_KEY / ANTHROPIC_API_KEY（假值）也不得算已配置
    check(
      "1c) 环境变量里的 *_API_KEY 不算已配置（A 口径：只认 auth.json / credentials.env）",
      apiProviders.length === 1 && apiProviders[0] === "deepseek" &&
        apiDefaultBody.models.every((m) => m.provider !== "openai" && m.provider !== "anthropic") &&
        !apiAllBody.models.some((m) => (m.provider === "openai" || m.provider === "anthropic") && m.configured),
      `桥进程环境注入 OPENAI_API_KEY/ANTHROPIC_API_KEY=${ENV_SENTINEL.slice(0, 12)}… · ` +
        `/api/models providers=${JSON.stringify(apiProviders)} · all=1 里 openai/anthropic 全 false`,
    );

    // ?all=1 全量：每一项都带 configured，且 openai 全是 false
    const openaiAll = apiAllBody.models.filter((m) => m.provider === "openai");
    check(
      "1b) ?all=1 返回全量且每项带 configured（openai 44 项 configured=false）",
      Array.isArray(apiAllBody.models) && apiAllBody.models.every((m) => typeof m.configured === "boolean") &&
        openaiAll.length > 0 && openaiAll.every((m) => m.configured === false),
      `total=${apiAllBody.models.length} · openai=${openaiAll.length} 项全 false`,
    );

    // 记页面加载标记 + 会话真实模型（用于证明「没有整页刷新」「模型没被打乱」）
    await evaluate(cdp, `(() => { window.__b7Marker = 1; return window.__lastModel ?? null; })()`);
    const beforeOpenaiPid = health.pi.pid;

    // ===== 2) 追加假 openai key → 点 ⟳ → 不刷新整页就出现 openai =====
    writeAuth({
      deepseek: { type: "api_key", key: FAKE_DEEPSEEK },
      openai: { type: "api_key", key: FAKE_OPENAI },
    });
    const clickReload1 = await clickElement(cdp, "#reload-models");
    const afterAdd = await waitFor(cdp, (p) => hasOpenai(p) && p.values.length > initial.values.length, 20000, "点 ⟳ 后出现 openai");
    await shot(cdp, "models-2-openai-added.png");
    const healthAfterAdd = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
    check(
      "2) 追加假 openai 键 → 点 ⟳ → 整页不刷新就出现 openai 模型（数量增加）",
      clickReload1.hit && afterAdd.marker === 1 && hasOpenai(afterAdd) &&
        afterAdd.values.length > initial.values.length &&
        afterAdd.groups.every((g) => g.label === "deepseek" || g.label === "openai") &&
        afterAdd.toast.includes("已刷新") && healthAfterAdd.pi.pid === beforeOpenaiPid,
      `⟳命中=${clickReload1.hit} · 页面标记=${afterAdd.marker}（1=未整页刷新） · 选项 ${initial.values.length}→${afterAdd.values.length} · ` +
        `分组=${JSON.stringify(afterAdd.groups.map((g) => `${g.label}:${g.values.length}`))} · toast=${JSON.stringify(afterAdd.toast)} · ` +
        `pi pid ${beforeOpenaiPid}→${healthAfterAdd.pi.pid}（未重启引擎）`,
    );

    // 步骤 2 后：选中值仍是会话真实模型
    const afterAddModel = afterAdd;
    check(
      "4a) openai 出现后，#model-select 当前值仍 == 会话真实模型",
      !!afterAddModel.last && afterAddModel.value === afterAddModel.last &&
        afterAddModel.current === afterAddModel.last && String(afterAddModel.value).startsWith("deepseek/"),
      `value=${afterAddModel.value} · dataset.current=${afterAddModel.current} · SSE __lastModel=${afterAddModel.last}`,
    );

    // ===== 3) 删除该 key → 点 ⟳ → openai 消失 =====
    writeAuth({ deepseek: { type: "api_key", key: FAKE_DEEPSEEK } });
    const clickReload2 = await clickElement(cdp, "#reload-models");
    const afterRemove = await waitFor(cdp, (p) => !hasOpenai(p) && p.values.length === 2, 20000, "点 ⟳ 后 openai 消失");
    await shot(cdp, "models-3-openai-removed.png");
    check(
      "3) 删除该 key → 点 ⟳ → openai 模型消失，数量回到 2",
      clickReload2.hit && afterRemove.marker === 1 && isDeepseekOnly(afterRemove) &&
        afterRemove.toast.includes("已刷新（2 个可用）"),
      `⟳命中=${clickReload2.hit} · 选项=${afterRemove.values.length} · 分组=${JSON.stringify(afterRemove.groups.map((g) => g.label))} · toast=${JSON.stringify(afterRemove.toast)}`,
    );

    // ===== 4) 当前值仍等于会话真实模型（刷新不能打乱选择） =====
    const finalProbe = await evaluate(cdp, MODEL_PROBE);
    const sessionModel = await evaluate(cdp, `(() => window.__lastModel ?? null)()`);
    check(
      "4b) 刷新结束后 #model-select 当前值仍 == 会话真实模型（T6 语义未破坏）",
      !!sessionModel && finalProbe.value === sessionModel && finalProbe.current === sessionModel &&
        String(finalProbe.value).startsWith("deepseek/"),
      `value=${finalProbe.value} · dataset.current=${finalProbe.current} · SSE __lastModel=${sessionModel}`,
    );

    // ===== 5) 任何响应 / 页面日志 / 桥日志都不含假 key 明文 =====
    const post = await fetch(`${BASE}/api/models/reload`, { method: "POST" });
    const postText = await post.text();
    const apiAfter = await getJson("/api/models");
    const apiAllAfter = await getJson("/api/models?all=1");
    const logText = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
    const consoleText = [...pageLogs, ...pageErrors].join("\n");
    const corpus = [initial.text, apiDefault.text, apiAll.text, postText, apiAfter.text, apiAllAfter.text, logText, consoleText].join("\n");
    const leaked = [FAKE_DEEPSEEK, FAKE_OPENAI, ENV_SENTINEL].filter((secret) => corpus.includes(secret));
    const skLike = SECRET_RE.test(corpus);
    check(
      "5) 响应 / 桥日志 / 页面日志不含假 key 明文",
      leaked.length === 0 && !skLike,
      leaked.length ? `泄露：${leaked.map((s) => s.slice(0, 12) + "…").join(", ")}` : `检查 ${corpus.length} 字符，无 sk- 明文；reload=${post.status}`,
    );

    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("0) 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0,
      realErrors.length ? realErrors.slice(0, 3).join(" | ") : "无");
  } finally {
    try { if (cdp) cdp.close(); } catch {}
    try { if (edge) edge.kill("SIGKILL"); } catch {}
    try { bridge.kill("SIGTERM"); } catch {}
    await sleep(1500);
    try { if (health?.pi?.pid) process.kill(health.pi.pid, "SIGKILL"); } catch {}
    // 收尾：先把关键截图落进仓库证据目录，再摘 junction、删临时目录
    try {
      if (shots.length) fs.copyFileSync(shots[shots.length - 1], SHOT_FINAL);
      const added = shots.find((p) => p.includes("models-2-openai-added"));
      if (added) fs.copyFileSync(added, path.join(SHOT_DIR, "models-config-ui-openai.png"));
    } catch {}
    try { fs.unlinkSync(path.join(AGENT_DIR, "install", "releases",
      fs.readFileSync(path.join(AGENT_DIR, "install", "current-version"), "utf8").trim(), "node_modules", "@earendil-works")); } catch {}
    try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n截图：\n  ${SHOT_FINAL}（终态 2 个 deepseek）\n  ${path.join(SHOT_DIR, "models-config-ui-openai.png")}（注入假 key 后 46 个）`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
