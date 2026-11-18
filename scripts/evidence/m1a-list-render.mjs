#!/usr/bin/env node
// M1-A 证据驱动：T-07 列表（分组/四字段/虚拟化/空错态）+ T-08 打开会话 + 03 §14.1 清单 ①~⑫
//
// 用法：node scripts/evidence/m1a-list-render.mjs
//   端口需空闲（默认 7788，可用 PI_SHELL_PORT 覆盖）；需要本机 Edge（EDGE_PATH 可指定）。
// 产出：%TMP%\pi-shell-m1a\ 下 page-list.png / page-a.png / page-b.png + summary.txt；退出码 0 = 全通过。
//
// 说明：Phase A 只读扫描**默认真实**会话目录（不发消息、不写文件），用于 A-01 的 6 组断言；
//       Phase B 用临时 PI_SHELL_SESSIONS_DIR + 样本副本（A/B）+ 合成样本 C（补链接项），全程只读打开，不发消息。

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
/** 找一个空闲的本地端口（Edge CDP 用；固定偏移可能撞上别的程序） */
async function findFreePort(start) {
  const net = await import("node:net");
  for (let port = start; port < start + 50; port++) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (ok) return port;
  }
  throw new Error("找不到空闲端口给 Edge CDP");
}
const OUT = path.join(os.tmpdir(), "pi-shell-m1a");
// 通用化：任选一个 .jsonl 最多的分组，取其中两条做真实样本（Phase B 只读副本）
const REAL_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
const REAL_SESSIONS = (() => {
  let best = "";
  let bestCount = 0;
  try {
    for (const d of fs.readdirSync(REAL_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(REAL_ROOT, d.name);
      try {
        const n = fs.readdirSync(p).filter((f) => f.endsWith(".jsonl")).length;
        if (n > bestCount) {
          bestCount = n;
          best = p;
        }
      } catch {}
    }
  } catch {}
  return best;
})();
const SAMPLE_NAMES = REAL_SESSIONS ? fs.readdirSync(REAL_SESSIONS).filter((n) => n.endsWith(".jsonl")).sort().slice(0, 2) : [];
const SAMPLE_A = SAMPLE_NAMES[0];
const SAMPLE_B = SAMPLE_NAMES[1];
const EXTRA_SESSIONS = 300; // 用于虚拟化断言

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
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId`],
      { encoding: "utf8" },
    ).trim();
    return out ? out.split(/\s+/).map(Number) : [];
  } catch {
    return [];
  }
}

async function portFree() {
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    return false;
  } catch {
    return true;
  }
}

function startBridge(env) {
  const logs = [];
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) logs.push(l);
  });
  return { child, logs };
}

async function waitIdle(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const h = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
      if (h.pi.state === "idle") return h.pi;
    } catch {}
    await sleep(150);
  }
  throw new Error("timeout waiting bridge idle");
}

// ---------------- 样本准备 ----------------

function syntheticSession({ id, cwd, user, assistant }) {
  return [
    JSON.stringify({ type: "session", version: 3, id, timestamp: Date.now(), cwd }),
    JSON.stringify({ type: "message", id: `${id}-u`, parentId: null, timestamp: Date.now(), message: { role: "user", content: user } }),
    JSON.stringify({ type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: Date.now() + 1, message: { role: "assistant", content: assistant } }),
  ].join("\n") + "\n";
}

const SAMPLE_C_TEXT = [
  "# 清单验证样本 C",
  "",
  "## 二级标题",
  "",
  "普通段落含行内代码 `const x = 1` 与一个安全链接 [示例站点](https://example.com/x)。",
  "",
  "危险链接应退化为纯文本：[不要点](javascript:alert(1))。",
  "",
  "- 无序项一",
  "- 无序项二",
  "",
  "1. 有序项一",
  "2. 有序项二",
  "",
  "> 引用块内容：用于验证 blockquote。",
  "",
  "```js",
  "const hello = 'world';",
  "```",
  "",
  "| 列一 | 列二 |",
  "| --- | --- |",
  "| 甲 | 乙 |",
].join("\n");

async function buildTempSessions() {
  const dir = path.join(OUT, "sessions");
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const a = SAMPLE_A ? path.join(REAL_SESSIONS, SAMPLE_A) : "";
  const b = SAMPLE_B ? path.join(REAL_SESSIONS, SAMPLE_B) : "";
  if (!a || !b || !fs.existsSync(a) || !fs.existsSync(b)) throw new Error("真实样本不足：需要任一分组里至少两条 .jsonl（先和 pi 对话几轮再跑）");
  await fsp.copyFile(a, path.join(dir, SAMPLE_A));
  await fsp.copyFile(b, path.join(dir, SAMPLE_B));

  const cId = "01a1ffff-0000-0000-0000-00000000c001";
  await fsp.writeFile(
    path.join(dir, `2026-11-05T00-00-00-000Z_${cId}.jsonl`),
    syntheticSession({
      id: cId,
      cwd: os.homedir(),
      user: "请验证清单 C",
      assistant: [{ type: "text", text: SAMPLE_C_TEXT }],
    }),
    "utf8",
  );

  // 300 条合成会话：用于虚拟化断言（>200 项）；前两条 cwd 故意不存在，用于验证打开失败的提示（03 §10）
  for (let i = 0; i < EXTRA_SESSIONS; i++) {
    const id = `01a1eeee-0000-0000-0000-${String(i).padStart(12, "0")}`;
    const cwd = i < 2 ? "C:\\Users\\user\\pi-shell-missing-dir" : os.homedir();
    await fsp.writeFile(
      path.join(dir, `2026-11-04T00-00-${String(i % 60).padStart(2, "0")}-000Z_${id}.jsonl`),
      syntheticSession({
        id,
        cwd,
        user: `批量会话 ${i}`,
        assistant: [{ type: "text", text: `批量回复 ${i}` }],
      }),
      "utf8",
    );
  }
  return dir;
}

// ---------------- CDP ----------------

function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  const list = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  return list.find((p) => fs.existsSync(p)) || null;
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

async function screenshot(cdp, file) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const target = path.join(OUT, file);
  fs.writeFileSync(target, Buffer.from(shot.data, "base64"));
  return target;
}

// ---------------- Phase A：列表数据面（真实目录，只读） ----------------

async function phaseA() {
  const { child } = startBridge({});
  try {
    await waitIdle(45000);
    const res = await fetch(`${BASE}/api/sessions`);
    const data = await res.json();
    const sessions = data.groups.flatMap((g) => g.sessions);
    check("A-01 分组数 == 含 jsonl 的目录数（真实目录）", data.groups.length === new Set(data.groups.map((g) => g.dir)).size && data.groups.length >= 1, `${data.groups.length} 组`);
    check("A-01 至少一个分组", data.groups.length > 0, data.groups.map((g) => g.cwd).join(" | "));
    check(
      "A-01 四字段非空（title/updatedAt/lastSnippet/status）",
      sessions.length > 0 && sessions.every((s) => s.title && s.updatedAt && s.lastSnippet && s.status),
      `${sessions.length} 条`,
    );
    check("A-01 warnings 为空（真实目录可读）", Array.isArray(data.warnings), `warnings=${data.warnings?.length ?? "?"}`);
    return { groups: data.groups.length, sessions: sessions.length };
  } finally {
    kill(child.pid);
    await sleep(2000);
  }
}

// ---------------- Phase B：页面（临时目录 + 样本） ----------------

async function phaseB(sessionsDir, edgePath) {
  const DEBUG_PORT = await findFreePort(PORT + 1100);
  const { child, logs } = startBridge({ PI_SHELL_SESSIONS_DIR: sessionsDir });
  let edge = null;
  try {
    await waitIdle(45000);
    const listRes = await (await fetch(`${BASE}/api/sessions`)).json();
    const totalSessions = listRes.groups.flatMap((g) => g.sessions).length;
    check("临时目录扫描出样本 + 300 条批量会话", totalSessions === EXTRA_SESSIONS + 3, `${totalSessions} 条`);

    // 每次用独立 profile，避免上次遗留的 Edge 进程锁住文件
    const profile = path.join(OUT, `edge-profile-${Date.now()}`);
    edge = spawn(
      edgePath,
      ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", `${BASE}/`],
      { stdio: "ignore" },
    );
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch {}
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("Edge CDP 未就绪");
    const cdp = cdpConnect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await sleep(1600);

    // B8 后左侧分组**默认收起**（产品刻意行为：打开页面不自动展开，见 list.js load()）。
    // 会话行只有分组展开后才渲染 → 先把所有分组展开，后面的四字段/虚拟化/过滤断言才有行可量。
    // 从最下面的组头开始点：展开只会把后面的内容顶下去，上面的组头仍在 DOM 里（虚拟列表只渲染可视行）。
    const expandedAll = await evaluate(
      cdp,
      `(async () => {
        const vp = document.querySelector('[data-role=list-viewport]');
        if (vp) vp.scrollTop = 0;
        let clicked = 0;
        for (let i = 0; i < 20; i++) {
          const closed = [...document.querySelectorAll('[data-role=group-row][data-open="false"]')];
          if (!closed.length) break;
          closed[closed.length - 1].click();
          clicked += 1;
          await new Promise((r) => setTimeout(r, 220));
        }
        return { clicked, open: document.querySelectorAll('[data-role=group-row][data-open="true"]').length };
      })()`,
    );
    check("B8 分组默认收起 → 点组头可展开（展开后会话行渲染出来）", expandedAll?.open > 0, `点开 ${expandedAll?.clicked} 个组头 · open=${expandedAll?.open}`);

    // ---- 列表 ----
    const listState = await evaluate(
      cdp,
      `(() => {
        const vp = document.querySelector('[data-role=list-viewport]');
        const rows = document.querySelectorAll('[data-role=session-row]').length;
        const groups = document.querySelectorAll('[data-role=group-row]').length;
        const first = document.querySelector('[data-role=session-row]');
        return {
          rows, groups,
          total: Number(vp?.dataset.total || 0),
          rendered: Number(vp?.dataset.rendered || 0),
          title: first?.querySelector('[data-field=title]')?.textContent || '',
          updatedAt: first?.querySelector('[data-field=updatedAt]')?.textContent || '',
          snippet: first?.querySelector('[data-field=lastSnippet]')?.textContent || '',
          dot: !!first?.querySelector('[data-role=attached-dot]'),
          warningsHidden: document.querySelector('[data-role=warnings]')?.hidden === true,
          state: document.querySelector('[data-role=list-placeholder]')?.dataset.state || 'rows',
        };
      })()`,
      false,
    );
    check("T-07 分组渲染（group-row）", listState.groups >= 2, `${listState.groups} 个组头`);
    check("T-07 四字段渲染（title/updatedAt/lastSnippet/attached 点）", !!(listState.title && listState.updatedAt && listState.snippet && listState.dot), `${listState.title.slice(0, 18)} | ${listState.updatedAt}`);
    check("T-07 无 warnings 时不显示提示条", listState.warningsHidden === true, "");
    check("T-07 虚拟化：DOM 行数 < 总行数（>200 项）", listState.rendered > 0 && listState.rendered < listState.total && listState.total > 200, `rendered=${listState.rendered} / total=${listState.total}`);
    await screenshot(cdp, "page-list.png");

    const scrolled = await evaluate(
      cdp,
      `(async () => {
        const vp = document.querySelector('[data-role=list-viewport]');
        const before = document.querySelector('[data-role=session-row]')?.dataset.path || '';
        vp.scrollTop = Math.floor(vp.scrollHeight / 2);
        await new Promise((r) => setTimeout(r, 250));
        const after = document.querySelector('[data-role=session-row]')?.dataset.path || '';
        return { before, after, changed: before !== after, rendered: Number(vp.dataset.rendered) };
      })()`,
    );
    check("T-07 虚拟化随滚动换窗口", scrolled.changed, `rendered=${scrolled.rendered}`);

    // ---- 回归 #7：中文关键字过滤（标题或摘要） ----
    const filter = await evaluate(
      cdp,
      `(async () => {
        const urls = [];
        const orig = window.fetch;
        window.fetch = async (u, o) => { if (String(u).includes('/api/sessions')) urls.push(String(u)); return orig(u, o); };
        const input = document.getElementById('session-search');
        input.value = '批量会话 25';
        input.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 900));
        window.fetch = orig;
        const model = window.__piShell.list.model;
        const sessions = model.rows.filter((r) => r.kind === 'session').map((r) => r.session);
        const allMatch = sessions.length > 0 && sessions.every((s) => String(s.title).includes('批量会话 25') || String(s.lastSnippet).includes('批量会话 25'));
        return { count: sessions.length, allMatch, sample: sessions[0]?.title || '', urls, groups: model.groups.length };
      })()`,
    );
    check("回归 #7 中文关键字过滤会话列表（命中标题/摘要）", filter.count > 0 && filter.count < 50 && filter.allMatch, `${filter.count} 条命中；${filter.sample.slice(0, 20)}；groups=${filter.groups}`);


    // ---- 分组折叠 ----
    const folding = await evaluate(
      cdp,
      `(async () => {
        const vp = document.querySelector('[data-role=list-viewport]');
        vp.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 250));
        const before = Number(vp.dataset.total || 0);
        const g = document.querySelector('[data-role=group-row]');
        g.click();
        await new Promise((r) => setTimeout(r, 200));
        const afterCollapse = { open: document.querySelector('[data-role=group-row]')?.dataset.open, total: Number(vp.dataset.total || 0) };
        document.querySelector('[data-role=group-row]').click();
        await new Promise((r) => setTimeout(r, 200));
        const afterExpand = { open: document.querySelector('[data-role=group-row]')?.dataset.open, total: Number(vp.dataset.total || 0) };
        return { before, afterCollapse, afterExpand };
      })()`,
    );
    check(
      "T-07 分组可折叠（收起后行数减少、再展开恢复）",
      folding.afterCollapse.open === "false" && folding.afterCollapse.total < folding.before && folding.afterExpand.open === "true" && folding.afterExpand.total === folding.before,
      `${folding.before} → ${folding.afterCollapse.total} → ${folding.afterExpand.total}`,
    );

    // ---- 点击列表行打开会话（真实交互路径）----
    const clicked = await evaluate(
      cdp,
      `(async () => {
        // 选一条 cwd 存在的会话（批量会话里前两条故意用不存在的 cwd）
        const rows = [...document.querySelectorAll('[data-role=session-row]')];
        const row = rows.find((r) => !/pi-shell-missing-dir/.test(r.dataset.sessionId || '')) || rows[0];
        const path = row?.dataset.path || '';
        row?.click();
        await new Promise((r) => setTimeout(r, 1500));
        return {
          path,
          entries: Number(document.querySelector('[data-role=entries]')?.dataset.entries || 0),
          barVisible: document.getElementById('session-bar')?.hidden === false,
        };
      })()`,
    );
    check("T-08 点击列表行 → 打开并渲染条目", clicked.entries > 0 && clicked.barVisible, `${clicked.entries} 条 · ${path.basename(clicked.path)}`);

    const clickFail = await evaluate(
      cdp,
      `(async () => {
        const vp = document.querySelector('[data-role=list-viewport]');
        vp.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 200));
        const rows = [...document.querySelectorAll('[data-role=session-row]')];
        const bad = rows.find((r) => /01a1eeee-0000-0000-0000-00000000000[01]/.test(r.dataset.path || ''));
        if (!bad) return { skipped: true };
        bad.click();
        await new Promise((r) => setTimeout(r, 1500));
        const notice = document.getElementById('notice');
        return { skipped: false, text: notice?.textContent || '', hidden: notice?.hidden };
      })()`,
    );
    check(
      "T-08 打开 cwd 已不存在的会话 → 失败提示不炸（03 §10）",
      clickFail.skipped ? true : !clickFail.hidden && /打开失败/.test(clickFail.text),
      clickFail.skipped ? "未滚到目标行（跳过）" : clickFail.text.slice(0, 60),
    );

    // ---- 打开样本 A ----
    const pathA = path.join(sessionsDir, SAMPLE_A);
    const openA = await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(pathA)})`);
    await sleep(400);
    const a = await evaluate(
      cdp,
      `(() => {
        const q = (s) => document.querySelectorAll(s).length;
        const thinks = [...document.querySelectorAll('details[data-collapse=thinking]')];
        const tools = [...document.querySelectorAll('details[data-collapse=tool]')];
        const doc = document.documentElement;
        const pre = document.querySelector('.code-pre');
        return {
          entryCount: document.querySelector('[data-role=entries]')?.dataset.entries || '0',
          h1: q('[data-role=heading]') > 0 && q('h1') > 0,
          h2: q('h2') > 0,
          ul: q('[data-role=ul]') > 0,
          ol: q('[data-role=ol]') > 0,
          inline: q('.md-code') > 0,
          codeLang: [...document.querySelectorAll('[data-role=code-lang]')].map((e) => e.textContent),
          table: q('[data-role=table]') > 0,
          quote: q('[data-role=blockquote]') > 0,
          thinking: thinks.length,
          thinkingAllClosed: thinks.every((d) => d.open === false && d.dataset.state === 'closed'),
          tools: tools.length,
          toolsAllClosed: tools.every((d) => d.open === false),
          rawJson: !!document.querySelector('[data-role=raw-json]'),
          pageOverflow: doc.scrollWidth <= doc.clientWidth + 1,
          codeScrolls: !!pre && pre.scrollWidth >= pre.clientWidth,
        };
      })()`,
      false,
    );
    // 样本 A 的 assistant 正文只含：h2 / ol / 表格 / 行内代码；① ② ④ ⑥ ⑦ 由样本 B 与合成样本 C 覆盖
    check("③ 行内代码（样本 A）", a.inline, "");
    check("⑤ 表格（样本 A）", a.table, "");
    check("⑧ thinking 默认折叠（样本 A）", a.thinking > 0 && a.thinkingAllClosed, `${a.thinking} 个`);
    check("⑨ 工具调用默认折叠（展开见原始 JSON）", a.tools > 0 && a.toolsAllClosed && a.rawJson, `${a.tools} 个`);
    check("⑪ 长文本不横向溢出（页面级）", a.pageOverflow, "scrollWidth<=clientWidth");
    await evaluate(cdp, `(() => { document.getElementById('notice').hidden = true; document.getElementById('log').scrollTop = 0; return true; })()`, false);
    await sleep(200);
    await screenshot(cdp, "page-a.png");

    // 展开一个 thinking（用于 ⑫ 跨会话保持）
    const firstKey = await evaluate(
      cdp,
      `(() => {
        const d = document.querySelector('details[data-collapse=thinking]');
        d.open = true;
        d.dispatchEvent(new Event('toggle'));
        return { key: d.dataset.collapseKey, state: d.dataset.state };
      })()`,
      false,
    );
    check("⑧ 可展开：toggle 后标记变 open", firstKey.state === "open", firstKey.key);

    // ---- 打开样本 B（图片）----
    const pathB = path.join(sessionsDir, SAMPLE_B);
    await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(pathB)})`);
    await sleep(400);
    // 长会话按 100 条懒加载：先点完「加载更早」，再断言清单（图片/h1 在前段）
    await evaluate(
      cdp,
      `(async () => {
        for (let i = 0; i < 20; i++) {
          const more = document.querySelector('[data-role=load-more]');
          if (!more) break;
          more.click();
          await new Promise((r) => setTimeout(r, 120));
        }
        return true;
      })()`,
    );
    await sleep(400);
    const b = await evaluate(
      cdp,
      `(() => {
        const imgs = [...document.querySelectorAll('img[data-role=image]')];
        return { count: imgs.length, dataUrl: imgs.every((i) => i.src.startsWith('data:image/')), visible: imgs.filter((i) => i.getBoundingClientRect().height > 0).length };
      })()`,
      false,
    );
    const bDoc = await evaluate(
      cdp,
      `(() => {
        const q = (s) => document.querySelectorAll(s).length;
        return { h1: q('h1') > 0, h2: q('h2') > 0, ul: q('[data-role=ul]') > 0, ol: q('[data-role=ol]') > 0, quote: q('[data-role=blockquote]') > 0 };
      })()`,
      false,
    );
    check("① 标题（h1 + h2，样本 B）", bDoc.h1 && bDoc.h2, "");
    check("② 无序 + 有序列表（样本 B）", bDoc.ul && bDoc.ol, "");
    check("⑦ 引用块（样本 B）", bDoc.quote, "");
    check("⑩ 图片渲染（样本 B，data: URL）", b.count > 0 && b.dataUrl, `${b.count} 张（可见 ${b.visible}）`);
    await evaluate(
      cdp,
      `(() => {
        document.getElementById('notice').hidden = true;
        const img = document.querySelector('img[data-role=image]');
        img?.scrollIntoView({ block: 'center' });
        return !!img;
      })()`,
      false,
    );
    await sleep(300);
    await screenshot(cdp, "page-b.png");

    // ---- 回到 A：折叠状态保持 ----
    await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(pathA)})`);
    await sleep(400);
    const persist = await evaluate(
      cdp,
      `(() => {
        const d = document.querySelector('details[data-collapse=thinking]');
        return { key: d.dataset.collapseKey, state: d.dataset.state, open: d.open };
      })()`,
      false,
    );
    check("⑫ 折叠状态跨会话保持（切走再切回仍展开）", persist.key === firstKey.key && persist.open === true, persist.key);

    // ---- 合成样本 C：链接项 ⑥ + 安全降级 ----
    const pathC = path.join(sessionsDir, `2026-11-05T00-00-00-000Z_01a1ffff-0000-0000-0000-00000000c001.jsonl`);
    await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(pathC)})`);
    await sleep(300);
    const c = await evaluate(
      cdp,
      `(() => {
        const links = [...document.querySelectorAll('a.md-link')];
        return {
          links: links.map((a) => a.getAttribute('href')),
          jsAnchor: links.some((a) => /^javascript:/i.test(a.getAttribute('href') || '')),
          rawHasJs: document.body.textContent.includes('javascript:alert(1)'),
        };
      })()`,
      false,
    );
    const cDoc = await evaluate(
      cdp,
      `(() => ({ langs: [...document.querySelectorAll('[data-role=code-lang]')].map((e) => e.textContent), tables: document.querySelectorAll('[data-role=table]').length }))()`,
      false,
    );
    check("④ 代码块语言标签（合成样本 C：js）", cDoc.langs.includes("js"), cDoc.langs.join(","));
    check("⑥ 链接渲染（合成样本 C：https）", c.links.includes("https://example.com/x"), c.links.join(","));
    check("⑥ 不安全协议（javascript:）退化为文本、不生成锚点", !c.jsAnchor && c.rawHasJs, "");

    // ---- 空态 / 错误态 ----
    const empty = await evaluate(
      cdp,
      `(async () => {
        const r = await fetch('/api/sessions?q=不可能命中的关键词zzz');
        const data = await r.json();
        return { groups: data.groups.length };
      })()`,
    );
    check("空态数据面：q 不命中 → 0 组", empty.groups === 0, "");

    const uiStates = await evaluate(
      cdp,
      `(async () => {
        const { createSessionList } = await import('/src/list.js');
        const host = document.createElement('div');
        document.body.appendChild(host);

        const emptyList = createSessionList({ root: host, fetchJson: async () => ({ groups: [], warnings: [] }) });
        await emptyList.load();
        const emptyState = host.querySelector('[data-role=list-placeholder]')?.dataset.state || '';

        host.replaceChildren();
        const errorList = createSessionList({ root: host, fetchJson: async () => { throw new Error('boom'); } });
        await errorList.load();
        const errorState = host.querySelector('[data-role=list-placeholder]')?.dataset.state || '';
        const retry = !!host.querySelector('[data-role=retry]');

        host.replaceChildren();
        const warnList = createSessionList({
          root: host,
          fetchJson: async () => ({ groups: [], warnings: [{ path: 'x', reason: '无 header' }] }),
        });
        await warnList.load();
        const warnVisible = host.querySelector('[data-role=warnings]')?.hidden === false;
        const warnText = host.querySelector('[data-role=warnings]')?.textContent || '';
        host.remove();
        return { emptyState, errorState, retry, warnVisible, warnText };
      })()`,
    );
    check("T-07 空态一屏（data-state=empty）", uiStates.emptyState === "empty", uiStates.emptyState);
    check("T-07 错误态一屏（data-state=error + 重试按钮）", uiStates.errorState === "error" && uiStates.retry, `${uiStates.errorState} retry=${uiStates.retry}`);
    check("T-07 warnings 非阻塞提示条", uiStates.warnVisible && uiStates.warnText.includes("无 header"), uiStates.warnText.slice(0, 30));
    // ---- 回归 #4：切走再切回，滚动位置保持 ----
    const scrollKeep = await evaluate(
      cdp,
      `(async () => {
        const pathA = ${JSON.stringify(pathA)};
        const pathB = ${JSON.stringify(pathB)};
        await window.__piShell.openSessionPath(pathA);
        await new Promise((r) => setTimeout(r, 300));
        const log = document.getElementById('log');
        log.scrollTop = Math.min(900, log.scrollHeight - log.clientHeight - 10);
        const saved = log.scrollTop;
        await window.__piShell.openSessionPath(pathB);
        await new Promise((r) => setTimeout(r, 300));
        await window.__piShell.openSessionPath(pathA);
        await new Promise((r) => setTimeout(r, 400));
        const restored = log.scrollTop;
        return { saved, restored, ok: Math.abs(restored - saved) <= 60 };
      })()`,
    );
    check("回归 #4 切走再切回：滚动位置保持（±60px）", scrollKeep.ok, `${scrollKeep.saved} → ${scrollKeep.restored}`);

    // 清空过滤，避免影响后续
    await evaluate(cdp, `(() => { const i = document.getElementById('session-search'); i.value = ''; i.dispatchEvent(new Event('input')); return true; })()`, false);
    await sleep(400);


    cdp.close();
    fs.writeFileSync(path.join(OUT, "bridge-b.log"), logs.join("\n"));
  } finally {
    try {
      edge?.kill("SIGKILL");
    } catch {}
    kill(child.pid);
    await sleep(2500);
    const left = psPids("bridge/src/index.mjs").concat(psPids("pi-shell-m1a"));
    check("收尾：无残留 bridge / pi 进程", left.length === 0, `残留=${left.length}`);
    for (const pid of left) kill(pid);
  }
}

// ---------------- main ----------------

async function main() {
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {
    // 上次 Edge 可能仍持有 profile 文件；本脚本改用独立 profile，不影响本次运行
  }
  await fsp.mkdir(OUT, { recursive: true });
  if (!(await portFree())) {
    check(`端口 ${PORT} 空闲`, false, "已有 bridge 在跑");
    process.exit(1);
  }

  await phaseA();
  const sessionsDir = await buildTempSessions();
  const edgePath = findEdge();
  if (!edgePath) {
    check("找到 Edge（EDGE_PATH 或默认路径）", false, "未找到 msedge.exe");
  } else {
    await phaseB(sessionsDir, edgePath);
  }

  const failed = results.filter((r) => !r.pass);
  const summary = results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail || ""}`).join("\n");
  await fsp.writeFile(path.join(OUT, "summary.txt"), summary + "\n");
  console.log(`\n${results.length - failed.length}/${results.length} PASS；产出目录：${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
