#!/usr/bin/env node
// 产品能力审计（Owner 用）：不看脚本断言，看「用户在界面上能不能真的用到」
//
// 与 first-load.mjs 的分工：
//   first-load.mjs  → 首屏可见性回归门（发布必须过）
//   本脚本          → 逐项确认 F-01~F-17 在【界面上】是否可达、行为是否符合文档描述
// 关键区别：bridge 有端点但前端没有入口的，记「界面上不可达」；只测 API 不算交付。
//
// 用法：node scripts/evidence/product-audit.mjs
// 产出：<tmp>/pi-shell-audit/（截图 + 日志）；控制台 PASS/FAIL/SKIP 行
// 退出码：0（体检脚本，不是门禁）

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7795);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-audit");
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];

function audit(id, name, verdict, detail) {
  rows.push({ id, name, verdict, detail });
  console.log(`${verdict === "OK" ? "PASS" : verdict === "NO" ? "FAIL" : "SKIP"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function step(msg) { console.log(`      · ${msg}`); }

// ---------- CDP ----------

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

async function rawEval(cdp, expression, awaitPromise) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 60000 });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function evaluate(cdp, expression, awaitPromise = true, timeoutMs = 45000) {
  return Promise.race([
    rawEval(cdp, expression, awaitPromise),
    sleep(timeoutMs).then(() => { throw new Error(`evaluate 超时 ${timeoutMs}ms`); }),
  ]);
}

async function clickSelector(cdp, selector) {
  const box = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: "not found" };
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, ok: !!hit && (hit === el || el.contains(hit)) };
  })()`, false, 10000);
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
  return p;
}

// 等待页面进入 idle（流式结束）
async function waitIdle(cdp, maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const st = await evaluate(cdp, `document.getElementById('state').textContent`, false, 5000).catch(() => "");
    if (String(st).startsWith("idle")) return Date.now() - t0;
    await sleep(250);
  }
  return -1;
}

// ---------- main ----------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const LOG_FILE = path.join(OUT_DIR, "bridge.log");

  try { await fetch(`${BASE}/api/health`, { cache: "no-store" }); throw new Error(`端口 ${PORT} 被占用`); } catch (e) {
    if (/被占用/.test(e.message)) throw e;
  }
  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe");

  const bridge = spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_LOG_FILE: LOG_FILE },
    stdio: "ignore",
  });
  let health = null;
  for (let i = 0; i < 100 && !health; i++) {
    try {
      const b = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
      if (b?.pi?.state === "idle") health = b;
    } catch {}
    if (!health) await sleep(300);
  }
  if (!health) throw new Error("bridge 未就绪");
  step(`bridge ready · pi ${health.pi.version}`);

  const debugPort = PORT + 1000;
  const edge = spawn(edgePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(OUT_DIR, "profile")}`,
    "--window-size=1440,900", `${BASE}/`,
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
  const cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await sleep(1500);

  try {
    // ================= 1. 列表 =================
    const listInfo = await evaluate(cdp, `(async () => {
      for (let i = 0; i < 60; i++) {
        if (document.querySelectorAll('[data-role=session-row]').length > 0) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const rows = [...document.querySelectorAll('[data-role=session-row]')];
      const groups = [...document.querySelectorAll('[data-role=group-row]')].map(g => ({ dir: g.dataset.dir, open: g.dataset.open, text: g.textContent.trim().slice(0, 18) }));
      return { groups, sessions: rows.length,
        total: document.querySelector('[data-role=list-viewport]')?.dataset.total,
        sample: rows.slice(0, 3).map(r => ({
          title: r.querySelector('[data-field=title]')?.textContent?.trim().slice(0, 20),
          snippet: r.querySelector('[data-field=lastSnippet]')?.textContent?.trim().slice(0, 24),
          time: r.querySelector('[data-field=updatedAt]')?.textContent?.trim(),
          attached: r.dataset.attached,
        })) };
    })()`, true);
    audit("F-01", "会话列表（分组/标题/摘要/时间/attached）", listInfo.sessions > 0 ? "OK" : "NO",
      `行 ${listInfo.sessions}（总 ${listInfo.total}）· 组 ${listInfo.groups.length} 个：${listInfo.groups.map(g => `${g.dir}${g.open === "true" ? "" : "(折叠)"}`).join(", ")} · 例「${listInfo.sample?.[0]?.title}」`);

    // ================= 2. 过滤 =================
    const sampleTitle = String(listInfo?.sample?.[0]?.title || "会话");
    const query = sampleTitle.slice(0, 2);
    const search = await evaluate(cdp, `(async () => {
      const box = document.getElementById('session-search');
      const n0 = document.querySelectorAll('[data-role=session-row]').length;
      const q = ${JSON.stringify(query)};
      box.focus(); box.value = q; box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      const rows = [...document.querySelectorAll('[data-role=session-row]')];
      const allMatch = rows.length > 0 && rows.every(r => r.textContent.toLowerCase().includes(q.toLowerCase()));
      box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      return { n0, rows: rows.length, allMatch, after: document.querySelectorAll('[data-role=session-row]').length };
    })()`, true);
    audit("F-13", "过滤：标题/摘要子串（本地即时）", search.rows > 0 && search.allMatch ? "OK" : "NO",
      `'${query}' → ${search.rows} 行（全命中=${search.allMatch}）；清空后 ${search.after}/${search.n0}`);

    // ================= 3. 发送：真实键盘路径（Ctrl+Enter，第五批起 Enter=换行）+ 流式 =================
    step("发送测试：点击输入框 → 键入 → Ctrl+Enter");
    const focusBox = await clickSelector(cdp, "#input");
    await cdp.send("Input.insertText", { text: "用一句话回答：你现在运行在哪个工作目录？不要用工具。" });
    const typed = await evaluate(cdp, `document.getElementById('input').value`, false, 5000);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2, text: "\r", unmodifiedText: "\r" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 });
    await sleep(900);
    const afterEnter = await evaluate(cdp, `({ value: document.getElementById('input').value, sending: document.getElementById('state').textContent, bubbles: document.querySelectorAll('#log .msg-user').length })`, false);
    const enterWorks = afterEnter.value.trim() === "" && (afterEnter.bubbles > 0 || !String(afterEnter.sending).startsWith('idle'));
    audit("F-03b", "Ctrl+Enter 发送（界面提示「Enter 换行 · Ctrl+Enter 发送」）", enterWorks ? "OK" : "NO",
      `点中输入框=${focusBox.hit} · 键入 ${String(typed).length} 字符 · 按 Ctrl+Enter 后：输入框剩余「${String(afterEnter.value).split("\n").join("\\n").slice(0, 20)}」· 用户气泡 ${afterEnter.bubbles} 个 → ${enterWorks ? "已发送" : "**没发送（需要点按钮）**"}`);

    let t0 = Date.now();
    if (!enterWorks) {
      step("改用点「发送」按钮继续功能验证");
      await clickSelector(cdp, "#send");
      t0 = Date.now();
    }
    const firstText = await (async () => {
      for (let i = 0; i < 250; i++) {
        const n = await evaluate(cdp, `[...document.querySelectorAll('#log .msg-assistant .msg-body, #log .entry-assistant .text-block')].map(b => b.textContent).join('').length`, false, 5000).catch(() => 0);
        if (n > 0) return Date.now() - t0;
        await sleep(150);
      }
      return -1;
    })();
    const idleMs = await waitIdle(cdp, 90000);
    const answer = await evaluate(cdp, `(() => {
      const rich = [...document.querySelectorAll('#log .entry-assistant .text-block')];
      const live = [...document.querySelectorAll('#log .msg-assistant .msg-body')];
      // 一轮结束后应只剩富渲染节点；若 live 仍在，说明「就地替换」失效（旧缺陷）
      const nodes = rich.length ? rich : live;
      const t = nodes.map(b => b.textContent).join('');
      return { chars: t.length, text: t.slice(0, 120), liveNodes: live.length, richNodes: rich.length,
               dupNodes: live.length > 0 && rich.length > 0 };
    })()`, false);
    audit("F-00b / F-03", "发送纯文本 → 流式回复", firstText > 0 && firstText <= 3000 ? "OK" : "NO",
      `首字 ${firstText}ms（判据 ≤3000）· 整轮 ${idleMs}ms · ${answer.chars} 字符 · live/rich 节点 ${answer.liveNodes}/${answer.richNodes}（双节点并存=${answer.dupNodes}）· 「${answer.text}」`);

    const stats1 = await evaluate(cdp, `(() => { const el = document.getElementById('stats'); return { d: getComputedStyle(el).display, t: el.textContent.trim() }; })()`, false);
    await sleep(1000);
    const stats2 = await evaluate(cdp, `(() => { const el = document.getElementById('stats'); return { d: getComputedStyle(el).display, t: el.textContent.trim(), title: el.title }; })()`, false);
    audit("F-14", "Token / 成本 / 上下文展示", stats2.d !== "none" && /tok/.test(stats2.t) ? "OK" : "NO",
      `${stats2.t}${stats2.title ? ` · ${stats2.title.slice(0, 60)}` : ""}`);

    // ================= 4. 中止 =================
    step("中止测试：长任务 + 点中止");
    await clickSelector(cdp, "#input");
    await cdp.send("Input.insertText", { text: "请写一篇 2000 字的文章，主题：本地优先软件的取舍。不要用工具。" });
    await clickSelector(cdp, "#send");
    let sawText = false;
    for (let i = 0; i < 120; i++) {
      const n = await evaluate(cdp, `[...document.querySelectorAll('#log .msg-assistant .msg-body, #log .entry-assistant .text-block, #log .entry-assistant .text-block p')].map(b => b.textContent).join('').length`, false, 5000).catch(() => 0);
      if (n > 20) { sawText = true; break; }
      await sleep(150);
    }
    const abortBtn = await clickSelector(cdp, "#abort");
    const lens = [];
    for (let i = 0; i < 4; i++) {
      await sleep(600);
      lens.push(await evaluate(cdp, `[...document.querySelectorAll('#log .msg-assistant .msg-body, #log .entry-assistant .text-block, #log .entry-assistant .text-block p')].map(b => b.textContent).join('').length`, false, 5000).catch(() => -1));
    }
    const st = await evaluate(cdp, `({ state: document.getElementById('state').textContent, disabled: document.getElementById('abort').disabled })`, false);
    const stopped = lens[1] === lens[3] && lens[1] === lens[2];
    audit("F-00c / F-04", "中止：≤2s 停写 + 回 idle", sawText && abortBtn.hit && stopped ? "OK" : "NO",
      `点中=${abortBtn.hit} · 长度 ${lens.join("→")} · 状态=${st.state} · 按钮禁用=${st.disabled}`);

    // ================= 5. 打开真实会话（两段式 + 渲染清单） =================
    step("打开真实会话（工具密集）");
    const openInfo = await evaluate(cdp, `(async () => {
      // 展开所有分组，保证目标行被虚拟化渲染
      document.querySelectorAll('[data-role=group-row][data-open=false]').forEach(g => g.querySelector('[data-role=group-toggle]')?.click());
      await new Promise(r => setTimeout(r, 800));
      let rows = [...document.querySelectorAll('[data-role=session-row]')];
      // 选一条有摘要且非当前会话的行
      const cand = rows.find(r => (r.querySelector('[data-field=lastSnippet]')?.textContent || '').length > 10);
      if (!cand) return { error: 'no-candidate-row', rows: rows.length, groups: document.querySelectorAll('[data-role=group-row]').length };
      cand.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 200));
      const t0 = performance.now();
      cand.click();
      const path = cand.dataset.path;
      const samples = [];
      let msEntries = null, msEnabled = null, sawViewing = false, blocks = 0;
      for (let i = 0; i < 100; i++) {
        const body = document.querySelector('[data-role=entries]');
        blocks = body ? body.children.length : 0;
        const banner = document.getElementById('attach-banner');
        const disabled = document.getElementById('send').disabled;
        if (banner && !banner.hidden) sawViewing = true;
        const tNow = Math.round(performance.now() - t0);
        if (msEntries === null && blocks > 0) msEntries = tNow;
        if (msEntries !== null && !disabled && msEnabled === null) msEnabled = tNow;
        if (samples.length < 12) samples.push([tNow, blocks, banner && !banner.hidden ? 'viewing' : 'hidden', disabled]);
        if (msEntries !== null && msEnabled !== null) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { ms: msEntries, msEnabled, blocks, sawViewing, timeline: samples,
               meta: document.getElementById('session-meta')?.textContent?.trim(), path };
    })()`, true, 60000);
    audit("F-09 / F-17", "点开会话：内容先渲染（目标 ≤2s）", openInfo.ms != null && openInfo.ms <= 2000 ? "OK" : openInfo.ms != null ? "NO" : "NO",
      openInfo.error ? `${openInfo.error} · path=${openInfo.path}` : `${openInfo.blocks} 块 / ${openInfo.ms}ms · ${openInfo.meta || ""}`);

    const tl = openInfo.timeline || [];
    audit("F-09b", "两段式：先可读 → 接管完成（可发送）", openInfo.msEnabled != null ? "OK" : "NO",
      `内容 ${openInfo.ms}ms 可见 · 可发送于 ${openInfo.msEnabled ?? '未达成'}ms · 见到过「接管中」态=${openInfo.sawViewing} · 时间线 ${tl.slice(0, 6).map(x => `${x[0]}ms/${x[1]}块/${x[2]}`).join(" ")}`);

    const render = await evaluate(cdp, `(() => {
      const log = document.getElementById('log');
      const c = (s) => log.querySelectorAll(s).length;
      const firstTool = log.querySelector('details[data-collapse=tool]');
      const firstThinking = log.querySelector('details[data-collapse=thinking]');
      return { h: c('h1,h2,h3,h4'), li: c('ul li,ol li'), code: c('code:not(pre code)'), pre: c('pre'),
        table: c('table'), link: c('a[href]'), quote: c('blockquote'), img: c('img'),
        thinking: c('details[data-collapse=thinking]'), tool: c('details[data-collapse=tool]'),
        thinkingOpen: firstThinking ? firstThinking.open : null, toolOpen: firstTool ? firstTool.open : null,
        toolLabel: firstTool?.querySelector('summary')?.textContent?.trim().slice(0, 46) || null,
        meta: document.getElementById('session-meta')?.textContent?.trim() };
    })()`, false);
    const hit = ["h", "li", "code", "pre", "table", "link", "quote", "img", "thinking", "tool"].filter((k) => render[k] > 0);
    const asstText = await evaluate(cdp, `(() => {
      const rich = [...document.querySelectorAll('#log .entry-assistant')];
      const texts = rich.map(n => n.textContent.trim()).filter(Boolean);
      const dup = texts.length > 1 && new Set(texts).size < texts.length;
      return { n: rich.length, chars: texts.join('').length, dup, sample: texts[0]?.slice(0, 60) };
    })()`, false);
    audit("F-02d", "打开的会话：assistant 内容真的显示出来", asstText.chars > 0 ? "OK" : "NO",
      `${asstText.n} 条 assistant · 合计 ${asstText.chars} 字符 · 发现重复文本=${asstText.dup} · 「${asstText.sample || ""}」`);
    audit("F-02", "渲染清单（Markdown/表格/链接/图片/thinking/工具折叠）", hit.length >= 5 ? "OK" : "NO",
      `命中 ${hit.join(",") || "无"}（h${render.h} li${render.li} code${render.code} pre${render.pre} table${render.table} link${render.link} quote${render.quote} img${render.img}）· thinking ${render.thinking} 个（默认收起=${render.thinkingOpen === false}）· 工具 ${render.tool} 个（默认收起=${render.toolOpen === false}，例「${render.toolLabel}」）`);

    // 工具折叠：真实点击 + 跨会话保持
    const foldBox = await evaluate(cdp, `(() => {
      const t = document.querySelector('#log details[data-collapse=tool]');
      if (!t) return { error: 'no-tool-block' };
      t.scrollIntoView({ block: 'center' });
      const r = t.querySelector('summary').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), key: t.dataset.collapseKey };
    })()`, false);
    if (!foldBox.error) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: foldBox.x, y: foldBox.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: foldBox.x, y: foldBox.y, button: "left", clickCount: 1 });
      await sleep(500);
      const f = await evaluate(cdp, `(() => {
        const hit = document.elementFromPoint(${foldBox.x}, ${foldBox.y});
        const d = hit?.closest('details');
        return { hit: hit ? hit.tagName + '.' + (hit.className || '') : null, open: d ? d.open : null,
                 bodyLen: d ? (d.querySelector('.collapse-body')?.textContent?.length || 0) : 0,
                 many: document.querySelectorAll('#log details[data-collapse=tool]').length };
      })()`, false);
      audit("F-02b", "工具调用折叠可展开（真实点击）", f.open === true ? "OK" : "NO", `命中 ${f.hit} · 该块 open=${f.open} · 正文 ${f.bodyLen} 字符 · 共 ${f.many} 个工具块`);
    } else {
      audit("F-02b", "工具调用折叠可展开（真实点击）", "—", foldBox.error);
    }

    // ================= 6. 命令面板 =================
    await clickSelector(cdp, "#open-palette");
    await sleep(1000);
    const palette = await evaluate(cdp, `(() => {
      const items = [...document.querySelectorAll('.palette-item')];
      return { shown: getComputedStyle(document.getElementById('palette')).display !== 'none',
        n: items.length, src: [...new Set([...document.querySelectorAll('.palette-source')].map(e => e.textContent.trim()))],
        sample: items.slice(0, 6).map(i => i.querySelector('.palette-name')?.textContent?.trim()) };
    })()`, false);
    audit("F-06", "命令面板（扩展命令/模板/技能）", palette.shown && palette.n > 0 ? "OK" : "NO",
      `${palette.n} 条 · ${palette.src.join("/")} · 例 ${palette.sample.join(" ")}`);
    await evaluate(cdp, `document.getElementById('palette-input').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`, false);
    await shot(cdp, "audit-palette.png");
    await evaluate(cdp, `document.getElementById('palette').hidden = true`, false);

    // ================= 7. 会话树 / fork =================
    await clickSelector(cdp, "#open-tree");
    await sleep(1500);
    const tree = await evaluate(cdp, `(() => ({
      shown: getComputedStyle(document.getElementById('panel')).display !== 'none',
      title: document.getElementById('panel-title').textContent,
      nodes: document.querySelectorAll('.tree-node').length,
      forks: document.querySelectorAll('.tree-fork').length,
      err: document.querySelector('.panel-error')?.textContent?.trim() || null,
      action: document.getElementById('panel-action').textContent.trim(),
    }))()`, false);
    audit("F-10", "会话树（节点 + fork 入口，不实际 fork）", tree.shown && tree.nodes > 0 ? "OK" : "NO",
      `${tree.title} · ${tree.nodes} 节点 / ${tree.forks} 个 fork 按钮 / 面板动作「${tree.action}」${tree.err ? ` · ${tree.err}` : ""}`);
    await clickSelector(cdp, "#panel-close");

    // ================= 8. 文件树 + 预览 + 越界 =================
    await clickSelector(cdp, "#open-files");
    await sleep(2000);
    const files = await evaluate(cdp, `(async () => {
      const rows = [...document.querySelectorAll('[data-role=file-list] .file-row')];
      const md = rows.find(r => /\.md\b/i.test(r.textContent));
      if (!md) return { rows: rows.length, names: rows.slice(0, 5).map(r => r.textContent.trim().slice(0, 16)) };
      md.click();
      for (let i = 0; i < 80; i++) {
        const box = document.querySelector('.preview');
        if (box) return { rows: rows.length, names: rows.slice(0, 4).map(r => r.textContent.trim().slice(0, 14)),
          preview: { len: box.textContent.length, text: box.textContent.trim().slice(0, 70), md: !!box.querySelector('.text-block'), code: !!box.querySelector('.preview-code') } };
        await new Promise(r => setTimeout(r, 100));
      }
      return { rows: rows.length, preview: { error: 'timeout' } };
    })()`, true, 40000);
    audit("F-11", "文件树 + 只读预览（md/代码/图片）", files.rows > 0 && files.preview?.len > 0 ? "OK" : "NO",
      `${files.rows} 项 · ${files.names.join(", ")}${files.preview ? ` · 预览 ${files.preview.len} 字符（md=${files.preview.md}）「${files.preview.text}」` : " · 无 .md 可试"}`);
    const escape = await (await fetch(`${BASE}/api/file?path=${encodeURIComponent("../../../Windows/win.ini")}`)).json().catch((e) => ({ error: e.message }));
    audit("F-11b", "越界读取拒绝（403）", /FORBIDDEN|403|越界/.test(JSON.stringify(escape)) ? "OK" : "NO", JSON.stringify(escape).slice(0, 100));
    await clickSelector(cdp, "#panel-close");

    // ================= 9. Git diff：界面入口 =================
    const uiDiff = await evaluate(cdp, `(() => {
      const html = document.documentElement.innerHTML;
      return { ref: /git\\/diff/.test(html), nodes: [...document.querySelectorAll('[id*=diff],[class*=diff]')].length };
    })()`, false);
    const gitProbe = await (await fetch(`${BASE}/api/git/diff`)).json().catch((e) => ({ error: e.message }));
    audit("F-12", "Git diff（只读）", uiDiff.ref || uiDiff.nodes ? "OK" : "NO",
      `API 可用=${gitProbe?.available ?? gitProbe?.error} · 界面入口=${uiDiff.ref || uiDiff.nodes > 0} → ${uiDiff.ref || uiDiff.nodes > 0 ? "可达" : "**界面上没有入口，用户用不到**"}`);

    // ================= 10. 偏好：即时生效 + 刷新保持 =================
    await clickSelector(cdp, "#open-settings");
    await sleep(400);
    const pref1 = await evaluate(cdp, `(async () => {
      const before = getComputedStyle(document.getElementById('log')).fontSize;
      const sel = document.getElementById('pref-font');
      sel.value = 'large'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      return { before, after: getComputedStyle(document.getElementById('log')).fontSize };
    })()`, true);
    await clickSelector(cdp, "#settings-close");
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(3000);
    const pref2 = await evaluate(cdp, `getComputedStyle(document.getElementById('log')).fontSize`, false).catch(() => "?");
    audit("F-17b", "偏好即时生效 + 刷新保持", pref1.before !== pref1.after && pref2 === pref1.after ? "OK" : "NO",
      `${pref1.before} → ${pref1.after} · 刷新后 ${pref2}`);
    await evaluate(cdp, `(() => { const s = document.getElementById('settings'); if (s) s.hidden = false;
      const sel = document.getElementById('pref-font'); sel.value = 'normal'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      s.hidden = true; })()`, false);

    // ================= 11. 折叠状态跨会话保持 =================
    const keep = await evaluate(cdp, `(async () => {
      // 重新打开刚才那条会话
      document.querySelectorAll('[data-role=group-row][data-open=false]').forEach(g => g.querySelector('[data-role=group-toggle]')?.click());
      await new Promise(r => setTimeout(r, 800));
      const rows = [...document.querySelectorAll('[data-role=session-row]')];
      const withSnippet = rows.find(r => (r.querySelector('[data-field=lastSnippet]')?.textContent || '').length > 10);
      const other = rows.find(r => r !== withSnippet);
      if (!withSnippet || !other) return { error: '行不足' };
      withSnippet.click();
      for (let i = 0; i < 80; i++) {
        if (document.querySelector('#log details[data-collapse=tool]')) break;
        await new Promise(r => setTimeout(r, 150));
      }
      const tool = document.querySelector('#log details[data-collapse=tool]');
      if (!tool) return { error: '该会话无工具块' };
      if (!tool.open) tool.querySelector('summary').click();
      await new Promise(r => setTimeout(r, 300));
      const key = tool.dataset.collapseKey;
      other.click();
      await new Promise(r => setTimeout(r, 2500));
      const back = [...document.querySelectorAll('[data-role=session-row]')].find(r => r.dataset.path === withSnippet.dataset.path);
      back?.click();
      for (let i = 0; i < 100; i++) {
        const el = [...document.querySelectorAll('#log details[data-collapse=tool]')].find(d => d.dataset.collapseKey === key);
        if (el) return { open: el.open };
        await new Promise(r => setTimeout(r, 150));
      }
      return { error: '切回未找到同一块' };
    })()`, true, 90000);
    audit("F-02c", "折叠状态跨会话保持（同页内）", keep.open === true ? "OK" : keep.open === false ? "NO" : "—", keep.error || `切走再切回 open=${keep.open}`);

    // ================= 12. 端点 vs 前端入口 =================
    const bridgeSrc = fs.readFileSync(path.join(REPO_ROOT, "bridge/src/index.mjs"), "utf8");
    const webSrc = ["main.js", "list.js", "render.js", "stream.js", "markdown.js"]
      .map((f) => fs.readFileSync(path.join(REPO_ROOT, "web/src", f), "utf8")).join("\n");
    const endpoints = [...new Set([...bridgeSrc.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]))];
    const orphans = endpoints.filter((p) => !webSrc.includes(p));
    audit("P-01", "bridge 端点 vs 前端入口（孤儿=用户用不到）", orphans.length === 0 ? "OK" : "NO",
      `共 ${endpoints.length} 个端点 · 无前端入口：${orphans.join(", ") || "无"}`);

    const entries = await evaluate(cdp, `(() => [...document.querySelectorAll('header.bar button, header.bar select, #composer button, #composer select')].map(b => (b.id || b.tagName) + ':' + (b.textContent || b.value || '').trim().slice(0, 10)))()`, false);
    audit("P-02", "界面可点入口清单", "—", entries.join(" | "));

    await shot(cdp, "audit-final.png");
  } finally {
    cdp.close();
    try { edge.kill("SIGKILL"); } catch {}
    try { bridge.kill("SIGTERM"); } catch {}
    await sleep(1200);
    try { process.kill(health.pi.pid, "SIGKILL"); } catch {}
  }

  const ok = rows.filter((r) => r.verdict === "OK").length;
  const no = rows.filter((r) => r.verdict === "NO").length;
  console.log(`\n合计：PASS ${ok} · FAIL ${no} · 仅记录 ${rows.length - ok - no}`);
  console.log(`证据目录：${OUT_DIR}`);
}

main().catch((e) => { console.error("FATAL", e.message); process.exitCode = 1; });
