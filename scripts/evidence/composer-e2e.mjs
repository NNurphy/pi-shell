#!/usr/bin/env node
// Composer 键盘发送 E2E（P0 回归，零第三方依赖）
//
// 为什么存在：f056652（T-09 Composer 重做）把 M0 的 Enter 处理器换成了全局 keydown
// （只处理 Esc / Ctrl+K / Ctrl+U），没有等价物 → Enter / Ctrl+Enter 都不发送，
// 只能点「发送」按钮。本脚本只用真实键盘事件（CDP Input.dispatchKeyEvent / Input.insertText）
// 走用户路径，并同时守住两个渲染回归：用户消息重复、每轮多一个空 system 块。
//
// 覆盖（第五批改回终端习惯：Enter 换行 / Ctrl+Enter 发送）：
//   T1 Enter 不发送且出现换行（输入框保留文本 + \n / 0 用户气泡 / 无 assistant 输出）
//   T1b Enter 后输入框含 \n 且未发送（连按两次仍只换行）
//   T2 Ctrl+Enter 发送（输入框清空 / 1 条用户气泡 / assistant 首字 ≤3s）
//   T3 Shift+Enter 换行（值为 a\nb，且没有发出消息）
//   T4 输入法保护（isComposing: true 的 Enter 不发送）
//   T5 一轮结束后的 DOM（.entry-user 1 / .msg-user 0 / 空 system 0 / assistant 文本 > 0）
//   T6 模型显示一致（SSE 先到 / /api/models 后到，下拉仍显示真实 session.model）
//   T6b 思考级别不被重置（SSE 先到 / /api/thinking-levels 后到，下拉仍显示真实 session.thinkingLevel）
//   T7 滚动不被抢（真实滚轮上滚后：新输出不再拽到底 / #jump-bottom 出现 / 点击回落 / 发消息强制到底 / 无新消息时隐藏）
//
// 用法：
//   node scripts/evidence/composer-e2e.mjs
//   PI_SHELL_PORT=7811 node scripts/evidence/composer-e2e.mjs
// 环境变量：
//   EDGE_PATH  指定 msedge.exe
// 产出：
//   <tmp>/pi-shell-composer-e2e/*.png（截图）、bridge.log、sessions/
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7810);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-composer-e2e");
const SESSIONS = path.join(OUT_DIR, "sessions");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const shots = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- bridge ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_LOG_FILE: LOG_FILE,
    },
    // H-15：subprocess stdio 必须 ignore/inherit，接管道不消费会把桥堵死
    stdio: "ignore",
  });
}

async function waitHealth(ms = 30000) {
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

async function rawEvaluate(cdp, expression, awaitPromise = false) {
  const res = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise, returnByValue: true, timeout: 120000,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function evaluate(cdp, expression, awaitPromise = false, timeoutMs = 45000) {
  return Promise.race([
    rawEvaluate(cdp, expression, awaitPromise),
    sleep(timeoutMs).then(() => { throw new Error(`evaluate 超时 ${timeoutMs}ms`); }),
  ]);
}

// ---------- CDP Input.* 兜底（不许整轮挂死） ----------
// 已取证：headless Edge 下 `Input.dispatchMouseEvent{type:mouseWheel}` 可能**永远没有回执**
// （同连接内 evaluate / insertText / screenshot 都是毫秒级），一挂就是整轮卡死，
// 让人误判断言失败。这里统一 2s 超时：超时即跳过该动作 + 记一笔 `wheel:timeout` 之类，
// 后续状态仍由真实探测（scrollInfo / DOM）判定 —— **断言不因此放宽**。
const CDP_INPUT_TIMEOUT_MS = 2000;
const cdpSkips = []; // {label, reason}：被兜底掉的 CDP 动作（写进 T7 详情，便于排障）

function softLabel(method, params) {
  if (method === "Input.dispatchMouseEvent") {
    if (params?.type === "mouseWheel") return "wheel";
    if (params?.type === "mouseMoved") return "mouse-move";
    return "mouse-click";
  }
  if (method === "Input.dispatchKeyEvent") return `key-${params?.type ?? "?"}`;
  return method;
}

/** 发一条 CDP 命令并限时等回执；超时/报错 → 记一笔并返回 {ok:false}，调用方决定是否跳过 */
async function sendSoft(cdp, method, params = {}, timeoutMs = CDP_INPUT_TIMEOUT_MS) {
  const call = cdp.send(method, params).then(
    (result) => ({ ok: true, result }),
    (err) => ({ ok: false, reason: String(err?.message || err) }),
  );
  const outcome = await Promise.race([
    call,
    sleep(timeoutMs).then(() => ({ ok: false, timeout: true })),
  ]);
  if (!outcome.ok) {
    const reason = outcome.timeout ? "timeout" : outcome.reason;
    cdpSkips.push({ label: softLabel(method, params), reason });
    console.log(`      CDP 兜底跳过：${softLabel(method, params)}:${reason}（${timeoutMs}ms 无回执）`);
  }
  return outcome;
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

const READY = `(() => {
  const v = (document.getElementById('version')?.textContent || '').trim();
  return { version: v, input: !!document.getElementById('input'), state: (document.getElementById('state')?.textContent || '').trim() };
})()`;

async function waitPageReady(cdp, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await evaluate(cdp, READY).catch(() => null);
    if (s?.input && s.version && s.version !== "—") return s;
    await sleep(200);
  }
  return null;
}

// 真实鼠标点击：先取元素中心，再用 elementFromPoint 证明没被别的东西挡住
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
  await sendSoft(cdp, "Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  const down = await sendSoft(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  const up = await sendSoft(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  // 无回执不等于没效果（浏览器可能已分发），仍按命中计价；真正判定由后续 DOM/状态探测负责
  return { ...box, hit: true, acked: down.ok && up.ok };
}

// 真实回车：type=keyDown + text="\r" 才会走浏览器默认行为（textarea 换行），
// rawKeyDown 不产生字符插入，无法证明「Shift+Enter 换行」。
async function pressEnter(cdp, modifiers = 0) {
  const base = {
    key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    modifiers, text: "\r", unmodifiedText: "\r",
  };
  await sendSoft(cdp, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await sendSoft(cdp, "Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers,
  });
}

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

// 模型下拉探针（T6）：value = 界面显示的模型；current = 页面自认的模型；
// last = 从 SSE bridge_state 收到的 session.model（main.js 在 applySessionState 里写入）
const MODEL_PROBE = `(() => {
  const sel = document.getElementById('model-select');
  const opts = sel ? [...sel.options].map((o) => o.value) : [];
  return {
    value: sel ? sel.value : null,
    current: sel ? (sel.dataset.current ?? null) : null,
    last: window.__lastModel ?? null,
    first: opts[0] ?? null,
    count: opts.length,
  };
})()`;

// 把 /api/models 人为延迟 800ms（注入到每次新文档、先于 main.js 执行），
// 制造“SSE bridge_state 先到、模型选项后到”的竞态顺序
const DELAY_MODELS = `(() => {
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const pending = orig.call(this, input, init);
    if (!/\\/api\\/models(?:$|[?/#])/.test(url)) return pending;
    window.__modelsDelayed = (window.__modelsDelayed || 0) + 1;
    return new Promise((resolve, reject) => setTimeout(() => pending.then(resolve, reject), 800));
  };
})()`;

// 思考级别探针（T6b）：value = 界面显示的级别；last = 从 SSE bridge_state 收到的 session.thinkingLevel
const THINKING_PROBE = `(() => {
  const sel = document.getElementById('thinking-select');
  const opts = sel ? [...sel.options].map((o) => o.value) : [];
  return {
    value: sel ? sel.value : null,
    selectedIndex: sel ? sel.selectedIndex : null,
    last: window.__lastThinkingLevel ?? null,
    first: opts[0] ?? null,
    count: opts.length,
  };
})()`;

// 把 /api/thinking-levels 人为延迟 800ms（注入到每次新文档、先于 main.js 执行），
// 与 DELAY_MODELS 同构：制造「SSE bridge_state 先到、options 后到」的竞态顺序
const DELAY_THINKING = `(() => {
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const pending = orig.call(this, input, init);
    if (!/\\/api\\/thinking-levels(?:$|[?/#])/.test(url)) return pending;
    window.__thinkingLevelsDelayed = (window.__thinkingLevelsDelayed || 0) + 1;
    return new Promise((resolve, reject) => setTimeout(() => pending.then(resolve, reject), 800));
  };
})()`;

// 可见用户节点 = 实时气泡 + 富渲染条目（一条消息只能出现一个）
const USER_NODES = `document.querySelectorAll('#log .msg-user, #log .entry-user').length`;
const ASSISTANT_TEXT = `[...document.querySelectorAll('#log .msg-assistant .msg-body, #log .entry-assistant .text-block')].map(b => b.textContent).join('')`;
const INPUT_VALUE = `document.getElementById('input').value`;
const STATE_TEXT = `document.getElementById('state').textContent`;

async function setEmptyInput(cdp) {
  await evaluate(cdp, `(() => { const el = document.getElementById('input'); el.focus(); el.value = ''; })()`);
}

async function shot(cdp, name) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, Buffer.from(s.data, "base64"));
  shots.push(p);
  return p;
}

/** 等本轮结束：assistant 有文本且状态回到 idle */
async function waitRoundEnd(cdp, maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await evaluate(cdp, `({ state: ${STATE_TEXT}, len: (${ASSISTANT_TEXT}).length })`).catch(() => null);
    if (s && s.len > 0 && String(s.state).startsWith("idle")) return Date.now() - t0;
    await sleep(250);
  }
  return -1;
}

// ---------- 主流程 ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });

  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口（避免给出假证据）`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  const health = await waitHealth();
  if (!health) throw new Error("bridge 未在 30s 内就绪（看 " + LOG_FILE + "）");
  console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid}`);

  const { edge, target } = await launchEdge(edgePath);
  const cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.ready;

  const pageErrors = [];
  cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
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

  try {
    const ready = await waitPageReady(cdp);
    if (!ready) throw new Error("页面 20s 未就绪");
    console.log(`      页面就绪 · pi ${ready.version} · state=${ready.state}`);
    await sleep(800);

    // ================= T1 Enter 换行（不发送） =================
    // 第五批回退「终端习惯」：Enter 只换行，发送靠 Ctrl(⌘)+Enter。
    const focus = await clickElement(cdp, "#input");
    const typed = "只回答两个字：收到";
    await cdp.send("Input.insertText", { text: typed });
    const typedLen = await evaluate(cdp, INPUT_VALUE);
    await pressEnter(cdp, 0);
    await sleep(400);
    const afterEnter = await evaluate(cdp, `({ value: ${INPUT_VALUE}, users: ${USER_NODES}, state: ${STATE_TEXT}, assistant: (${ASSISTANT_TEXT}).length })`);
    await shot(cdp, "t1-enter-newline.png");
    check(
      "T1 Enter 不发送且出现换行（输入框保留文本 + \\n / 0 条用户气泡 / 无 assistant 输出）",
      focus.hit && String(typedLen).length === typed.length && afterEnter.value === `${typed}\n` && afterEnter.users === 0 && afterEnter.assistant === 0 && !String(afterEnter.state).startsWith("streaming"),
      `点中输入框=${focus.hit} · 键入 ${String(typedLen).length} 字符 · 回车后输入框=${JSON.stringify(afterEnter.value)} · 用户气泡 ${afterEnter.users} · assistant ${afterEnter.assistant} 字 · state=${afterEnter.state}`,
    );

    // ================= T1b Enter 后输入框含 \\n 且未发送 =================
    // 反证 T1 不是「内容被清空/被吞掉」：再键入一个字符 + 再按 Enter，输入框应有两个换行，仍不发送。
    await cdp.send("Input.insertText", { text: "b" });
    await pressEnter(cdp, 0);
    await sleep(300);
    const twoEnter = await evaluate(cdp, `({ value: ${INPUT_VALUE}, users: ${USER_NODES}, state: ${STATE_TEXT} })`);
    const newlineCount = (twoEnter.value.match(/\n/g) || []).length;
    check(
      "T1b Enter 后输入框含 \\n 且未发送（两次 Enter = 两个换行 / 用户气泡 0 / 非 streaming）",
      twoEnter.value.includes("\n") && newlineCount === 2 && twoEnter.users === 0 && !String(twoEnter.state).startsWith("streaming"),
      `输入框=${JSON.stringify(twoEnter.value)}（换行 ${newlineCount} 个）· 用户气泡 ${twoEnter.users} · state=${twoEnter.state}`,
    );

    // ================= T2 Ctrl+Enter 发送 =================
    await setEmptyInput(cdp);
    await cdp.send("Input.insertText", { text: "只回答两个字：收到" });
    const t2 = Date.now();
    await pressEnter(cdp, MOD.ctrl);
    let firstTextMs = -1;
    for (let i = 0; i < 30; i++) {
      const len = await evaluate(cdp, `(${ASSISTANT_TEXT}).length`).catch(() => 0);
      if (len > 0) { firstTextMs = Date.now() - t2; break; }
      await sleep(100);
    }
    const ctrlFirst = await evaluate(cdp, `({ value: ${INPUT_VALUE}, users: ${USER_NODES} })`);
    const roundMs = await waitRoundEnd(cdp);
    await shot(cdp, "t2-ctrl-enter.png");
    check(
      "T2 Ctrl+Enter 发送（输入框清空 / 1 条用户气泡 / assistant 首字 ≤3s）",
      ctrlFirst.value === "" && ctrlFirst.users === 1 && firstTextMs >= 0 && firstTextMs <= 3000,
      `回车后输入框「${ctrlFirst.value}」· 用户气泡 ${ctrlFirst.users}（期望 1）· 首字 ${firstTextMs}ms · 整轮 ${roundMs}ms`,
    );

    // ================= T5 一轮结束后的 DOM =================
    const dom = await evaluate(cdp, `(() => {
      const entryUsers = document.querySelectorAll('#log .entry-user').length;
      const msgUsers = document.querySelectorAll('#log .msg-user').length;
      const emptySystem = [...document.querySelectorAll('#log .entry-system')].filter((el) => {
        const block = el.querySelector('.text-block');
        const text = block ? block.textContent.trim() : '';
        return text.length === 0;
      }).length;
      const systemTotal = document.querySelectorAll('#log .entry-system').length;
      const assistant = (${ASSISTANT_TEXT}).trim();
      return { entryUsers, msgUsers, emptySystem, systemTotal, assistantLen: assistant.length, assistant: assistant.slice(0, 40) };
    })()`);
    await shot(cdp, "t5-dom.png");
    check(
      "T5 一轮结束后的 DOM（.entry-user=1 / .msg-user=0 / 空 system=0 / assistant 文本>0）",
      dom.entryUsers === 1 && dom.msgUsers === 0 && dom.emptySystem === 0 && dom.assistantLen > 0,
      `entry-user=${dom.entryUsers} · msg-user=${dom.msgUsers} · 空 system=${dom.emptySystem}/${dom.systemTotal} · assistant ${dom.assistantLen} 字「${dom.assistant}」`,
    );

    // ================= T3 Shift+Enter 换行 =================
    await setEmptyInput(cdp);
    await cdp.send("Input.insertText", { text: "a" });
    await pressEnter(cdp, MOD.shift);
    await cdp.send("Input.insertText", { text: "b" });
    await sleep(400);
    const shift = await evaluate(cdp, `({ value: ${INPUT_VALUE}, users: ${USER_NODES} })`);
    await shot(cdp, "t3-shift-enter.png");
    check(
      "T3 Shift+Enter 换行（值为 a\\nb，且没有发出消息）",
      shift.value === "a\nb" && shift.users === 1,
      `输入框值=${JSON.stringify(shift.value)} · 用户气泡仍为 ${shift.users}`,
    );

    // ================= T4 输入法保护 =================
    // CDP Input.dispatchKeyEvent 没有 isComposing 参数（协议里只有 autoRepeat / key / code…），
    // 而输入法组词态的判定恰恰是 KeyboardEvent.isComposing → 只能用合成 KeyboardEvent 验证。
    await setEmptyInput(cdp);
    await cdp.send("Input.insertText", { text: "输入法组词中" });
    const composing = await evaluate(cdp, `(() => {
      const el = document.getElementById('input');
      const ev = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true, isComposing: true,
      });
      el.dispatchEvent(ev);
      return { value: el.value, isComposing: ev.isComposing, users: ${USER_NODES} };
    })()`);
    await sleep(500);
    const composingAfter = await evaluate(cdp, `({ value: ${INPUT_VALUE}, users: ${USER_NODES} })`);
    await shot(cdp, "t4-composing.png");
    check(
      "T4 输入法保护（isComposing: true 的 Enter 不发送）",
      composing.isComposing === true && composingAfter.value === "输入法组词中" && composingAfter.users === 1,
      `ev.isComposing=${composing.isComposing} · 输入框仍为「${composingAfter.value}」· 用户气泡仍为 ${composingAfter.users}`,
    );

    // ================= T6 模型显示一致 =================
    // 为什么存在：loadModels() 曾经用 `dataset.current = els.model.value` 把「下拉第一项」
    // （provider 字母序第一个，如 anthropic · Claude Fable 5）当成当前模型；若 SSE 的
    // bridge_state 比 /api/models 先到，applySessionState 找不到 option 不回选，随后填完
    // 选项就永久停错模型。这里两段验证：先看当前顺序的结果一致性，再用 fetch wrapper
    // 人为延迟 /api/models 800ms 复现竞态顺序。
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: DELAY_MODELS });
    await cdp.send("Page.reload", { ignoreCache: false });
    const reloaded = await waitPageReady(cdp);
    // 采证：是否真的先收到 SSE model、后拿到模型选项（options 为空的窗口）
    let raceSeen = false;
    const t6Start = Date.now();
    let probe = null;
    while (Date.now() - t6Start < 5000) {
      probe = await evaluate(cdp, MODEL_PROBE).catch(() => null);
      if (probe?.last && probe.count === 0) raceSeen = true;
      if (probe?.last && probe.count > 0) break;
      await sleep(20);
    }
    if (probe?.last && probe.count > 0 && Date.now() - t6Start < 1500) await sleep(1500 - (Date.now() - t6Start));
    const t6 = await evaluate(cdp, MODEL_PROBE);
    const delayed = await evaluate(cdp, "window.__modelsDelayed || 0").catch(() => 0);
    await shot(cdp, "t6-model.png");
    check(
      "T6 模型显示一致（SSE 先到 / models 后延迟 800ms：下拉 value = SSE session.model，且不是首项）",
      !!reloaded && delayed > 0 && t6.last != null && t6.value === t6.last && t6.current === t6.last && (t6.count <= 1 || t6.value !== t6.first),
      `value=${t6.value} · dataset.current=${t6.current} · SSE session.model=${t6.last} · 首项=${t6.first}（共 ${t6.count} 项）· 延迟注入生效=${delayed} 次 · 观察到 SSE 先到窗口=${raceSeen}`,
    );

    // ================= T6b 刷新后思考级别不被重置成首项（off） =================
    // 为什么存在：loadThinkingLevels() 重建 options 时若当前值不在列表里，浏览器会自动选首项（off）；
    // applySessionState 在 options 就绪前拿不到对应 option 就把会话真实值丢了 → 刷新后显示 off。
    // 这里把 /api/thinking-levels 延迟 800ms，逼出「SSE 先到、options 后到」的同一竞态。
    // 先把会话真实级别设为一个非首项（优先 high），不依赖模型默认值。
    const levelsRes = await (await fetch(`${BASE}/api/thinking-levels`, { cache: "no-store" })).json().catch(() => null);
    const levelList = Array.isArray(levelsRes?.levels) ? levelsRes.levels : [];
    const nonFirst = levelList.filter((l) => l !== levelList[0]);
    const targetLevel = nonFirst.includes("high") ? "high" : nonFirst[0] ?? null;
    let levelSet = null;
    if (targetLevel) {
      const r = await fetch(`${BASE}/api/thinking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: targetLevel }),
      }).catch(() => null);
      const body = await r?.json().catch(() => null);
      levelSet = body?.state?.thinkingLevel ?? null;
    }
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: DELAY_THINKING });
    await cdp.send("Page.reload", { ignoreCache: false });
    const reloaded2 = await waitPageReady(cdp);
    // 采证：是否真的先收到 SSE thinkingLevel、后拿到 options（count === 0 的窗口）
    let levelRaceSeen = false;
    let tprobe = null;
    const t6bStart = Date.now();
    while (Date.now() - t6bStart < 6000) {
      tprobe = await evaluate(cdp, THINKING_PROBE).catch(() => null);
      if (tprobe?.last && tprobe.count === 0) levelRaceSeen = true;
      if (tprobe?.last && tprobe.count > 0) break;
      await sleep(20);
    }
    if (tprobe?.last && tprobe.count > 0 && Date.now() - t6bStart < 1500) await sleep(1500 - (Date.now() - t6bStart));
    const t6b = await evaluate(cdp, THINKING_PROBE);
    const levelDelayed = await evaluate(cdp, "window.__thinkingLevelsDelayed || 0").catch(() => 0);
    await shot(cdp, "t6b-thinking.png");
    check(
      "T6b 刷新后思考级别不被重置成首项（SSE 先到 / thinking-levels 后延迟 800ms：value = SSE session.thinkingLevel ≠ 首项）",
      !!reloaded2 && !!targetLevel && levelDelayed > 0 && t6b.last != null && t6b.value === t6b.last && t6b.value === targetLevel && (t6b.count <= 1 || t6b.value !== t6b.first),
      `value=${t6b.value} · SSE session.thinkingLevel=${t6b.last} · 期望=${targetLevel}（POST 回执=${levelSet}）· 首项=${t6b.first}（共 ${t6b.count} 项，selectedIndex=${t6b.selectedIndex}）· 延迟注入生效=${levelDelayed} 次 · 观察到 SSE 先到窗口=${levelRaceSeen}`,
    );

    // ================= T7 自动滚动不抢用户位置（B-11） =================
    // 为什么存在：所有新输出都无条件 `els.log.scrollTop = els.log.scrollHeight`，
    // 用户向上翻历史时会被 streaming delta 拽回底部（终端不会这样）。
    // 这里只走真实事件：真实 Ctrl+Enter 发送 → 真实滚轮上滚 → 观察 2s 内输出继续时的 scrollTop。
    const SCROLL_INFO = "window.__piShell.scrollInfo()";
    await setEmptyInput(cdp);
    await cdp.send("Input.insertText", { text: "请写一篇 2000 字的中文散文，主题是秋天的雨。直接输出正文，不要提纲、不要标题。" });
    await pressEnter(cdp, MOD.ctrl);

    // 等「有首字 + >300 字 + 可滚动范围 >600px + 仍在 streaming」，否则滚动验证没有意义
    let ready7 = null;
    const t7Wait = Date.now();
    while (Date.now() - t7Wait < 90000) {
      ready7 = await evaluate(cdp, `(() => { const el = document.getElementById('log'); return { len: (${ASSISTANT_TEXT}).length, state: ${STATE_TEXT}, range: el.scrollHeight - el.clientHeight }; })()`).catch(() => null);
      if (ready7 && ready7.len > 300 && ready7.range > 600 && String(ready7.state).startsWith("streaming")) break;
      await sleep(200);
    }

    // 真实滚轮上滚；headless 里若合成滚轮不生效，退回 scrollTop 赋值（同样触发真实 scroll 事件）
    const logCenter = await evaluate(cdp, `(() => {
      const el = document.getElementById('log');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await sendSoft(cdp, "Input.dispatchMouseEvent", { type: "mouseMoved", x: logCenter.x, y: logCenter.y });
    for (let i = 0; i < 5; i++) {
      const wheel = await sendSoft(cdp, "Input.dispatchMouseEvent", { type: "mouseWheel", x: logCenter.x, y: logCenter.y, deltaX: 0, deltaY: -200 });
      // 无回执就不再试：headless 下这个动作就是没回执，继续发只会白等
      if (!wheel.ok) break;
      await sleep(60);
    }
    await sleep(300);
    let unpinned = await evaluate(cdp, `({ info: ${SCROLL_INFO}, len: (${ASSISTANT_TEXT}).length })`);
    const wheelScrolled = unpinned.info.pinned === false;
    if (!wheelScrolled) {
      await evaluate(cdp, `(() => { const el = document.getElementById("log"); el.scrollTop = 200; return el.scrollTop; })()`);
      await sleep(300);
      unpinned = await evaluate(cdp, `({ info: ${SCROLL_INFO}, len: (${ASSISTANT_TEXT}).length })`);
    }
    await shot(cdp, "t7-scrolled-up.png");

    // 后续 2s：输出继续，但 scrollTop 不许被拽到底部，角标必须可见
    await sleep(2000);
    const pinnedBack = await evaluate(cdp, `({ info: ${SCROLL_INFO}, len: (${ASSISTANT_TEXT}).length, state: ${STATE_TEXT} })`);
    const drift = Math.abs(pinnedBack.info.scrollTop - unpinned.info.scrollTop);
    const grew = pinnedBack.len - unpinned.len;

    // 点「回到底部」→ 回到末尾且角标隐藏
    const jumpClick = await clickElement(cdp, "#jump-bottom");
    await sleep(350);
    const afterJump = await evaluate(cdp, SCROLL_INFO);
    const jumpGap = Math.abs(afterJump.scrollTop + afterJump.clientHeight - afterJump.scrollHeight);
    await shot(cdp, "t7-jumped-bottom.png");

    // 用户自己发消息（例外①）：即使之前向上滚，也要强制到底
    // 用真实滚轮上滚；若这一轮已经结束、内容不再可滚动，则该子断言不适用（软跳过，记为 n/a）
    await evaluate(cdp, `(() => { const el = document.getElementById("log"); el.scrollTop = 200; return el.scrollTop; })()`);
    await sendSoft(cdp, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 700, y: 400, deltaX: 0, deltaY: -600 });
    await sleep(300);
    const beforeSend = await evaluate(cdp, SCROLL_INFO);
    const sendTestable = (beforeSend.scrollHeight - beforeSend.clientHeight) > 200;
    await clickElement(cdp, "#input");
    await cdp.send("Input.insertText", { text: "收到" });
    await pressEnter(cdp, MOD.ctrl);
    await sleep(600);
    const afterSend = await evaluate(cdp, `({ info: ${SCROLL_INFO}, users: ${USER_NODES} })`);
    const sendGap = Math.abs(afterSend.info.scrollTop + afterSend.info.clientHeight - afterSend.info.scrollHeight);

    // 回归：非流式、无新消息时角标保持隐藏
    const t7Round = await waitRoundEnd(cdp, 180000);
    await sleep(800);
    const quiet = await evaluate(cdp, `({ info: ${SCROLL_INFO}, state: ${STATE_TEXT} })`);
    await shot(cdp, "t7-quiet.png");
    const skips = cdpSkips.filter((s) => s.label === "wheel").length;
    const wheelNote = skips ? ` · 滚轮无回执被兜底 ${skips} 次（wheel:timeout，改用 scrollTop 验证）` : "";

    check(
      "T7 自动滚动不抢位置（上滚后新输出不拽到底 / #jump-bottom 可见可点 / 发消息强制到底 / 静默时隐藏）",
      !!ready7 && ready7.len > 300 && unpinned.info.pinned === false && drift < 20 && grew > 0 &&
        unpinned.info.jumpVisible === true && pinnedBack.info.jumpVisible === true && jumpClick.hit &&
        jumpGap <= 5 && afterJump.jumpVisible === false && (sendTestable ? beforeSend.pinned === false : true) && sendGap <= 5 &&
        afterSend.info.jumpVisible === false && quiet.info.jumpVisible === false,
      `首字快照 ${ready7 ? ready7.len : "-"} 字/${ready7 ? ready7.range : "-"}px · 上滚方式=${wheelScrolled ? "真实滚轮" : "scrollTop 赋值"}${wheelNote} → scrollTop=${unpinned.info.scrollTop} pinned=${unpinned.info.pinned} 角标=${unpinned.info.jumpVisible} · 2s 内输出 +${grew} 字，scrollTop 漂移 ${drift}px → pinned=${pinnedBack.info.pinned} 角标=${pinnedBack.info.jumpVisible} · 点角标(命中=${jumpClick.hit}) 距底 ${jumpGap}px 角标=${afterJump.jumpVisible} · 发送前 pinned=${beforeSend.pinned}${sendTestable ? "" : "（不可滚动，子断言 n/a）"} → 发送后距底 ${sendGap}px 角标=${afterSend.info.jumpVisible} 用户气泡=${afterSend.users} · 收尾 ${t7Round}ms state=${quiet.state} 角标=${quiet.info.jumpVisible}`,
    );

    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_/.test(t));
    check("T0 全流程无未捕获 JS 异常 / 控制台 error", realErrors.length === 0,
      realErrors.length ? realErrors.slice(0, 3).join(" | ") : "无");
  } finally {
    cdp.close();
    try { edge.kill("SIGKILL"); } catch {}
    try { bridge.kill("SIGTERM"); } catch {}
    await sleep(1500);
    try { process.kill(health.pi.pid, "SIGKILL"); } catch {}
  }

  const failed = results.filter((r) => !r.pass);
  if (cdpSkips.length) {
    const counts = cdpSkips.reduce((m, s) => ((m[`${s.label}:${s.reason}`] = (m[`${s.label}:${s.reason}`] || 0) + 1), m), {});
    console.log(`\nCDP 兜底跳过：${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(" ")}`);
  }
  console.log("\n截图：");
  for (const p of shots) console.log(`  ${p}`);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
