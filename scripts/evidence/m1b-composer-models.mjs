#!/usr/bin/env node
// M1-B 证据：T-09 Composer（图片/文件注入/steer/followUp/Esc 清队列+中止/富渲染替换）
//          + T-10 模型与思考级别 + T-11 命令面板 + fix(T-08) CONFLICT
//
// 用法：node scripts/evidence/m1b-composer-models.mjs   （端口需空闲；需要 Edge）
// 产出：%TMP%\pi-shell-m1b\ 下 m1b-composer.png / m1b-palette.png / m1b-rich.png + summary.txt

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-m1b");
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

async function post(url, body) {
  const res = await fetch(`${BASE}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

// ---------------- 样本/临时目录 ----------------

function sessionFile({ id, cwd, user, answer }) {
  return [
    JSON.stringify({ type: "session", version: 3, id, timestamp: Date.now(), cwd }),
    JSON.stringify({ type: "message", id: `${id}-u`, parentId: null, timestamp: Date.now(), message: { role: "user", content: user } }),
    JSON.stringify({ type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: Date.now() + 1, message: { role: "assistant", content: [{ type: "text", text: answer }] } }),
  ].join("\n") + "\n";
}

async function buildSessions() {
  const dir = path.join(OUT, "sessions");
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "ok.jsonl"),
    sessionFile({ id: "01a1b000-0000-0000-0000-000000000001", cwd: os.homedir(), user: "可用会话", answer: "ok" }),
    "utf8",
  );
  await fsp.writeFile(
    path.join(dir, "gone.jsonl"),
    sessionFile({ id: "01a1b000-0000-0000-0000-000000000002", cwd: "C:\\Users\\user\\pi-shell-gone-dir", user: "目录已删", answer: "x" }),
    "utf8",
  );
  return dir;
}

// ---------------- Edge/CDP ----------------

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

// ---------------- main ----------------

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function main() {
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {}
  await fsp.mkdir(OUT, { recursive: true });
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    check(`端口 ${PORT} 空闲`, false, "已有 bridge 在跑");
    process.exit(1);
  } catch {}

  const sessionsDir = await buildSessions();
  const edgePath = findEdge();
  if (!edgePath) {
    check("找到 Edge", false, "未找到 msedge.exe");
    process.exit(1);
  }
  const debugPort = await freePort(PORT + 1200);

  const logs = [];
  const bridge = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_SESSIONS_DIR: sessionsDir, PI_SHELL_CWD: os.homedir() },
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

    // ---------- 端点：T-10 / T-11 ----------
    const modelsRes = await (await fetch(`${BASE}/api/models`)).json();
    const models = modelsRes.models ?? [];
    check("T-10 GET /api/models 直通且有字段", models.length > 0 && models.every((m) => m.provider && m.id), `${models.length} 个模型`);
    const levelsRes = await (await fetch(`${BASE}/api/thinking-levels`)).json();
    const levels = levelsRes.levels ?? [];
    check("T-10 GET /api/thinking-levels", Array.isArray(levels) && levels.length > 0, levels.join(","));

    // 当前模型以 get_state 为准（models[0] 不一定是当前模型）；只在同一 provider 内换，避免缺凭证导致后续对话为空
    await post("/api/session/open", { path: path.join(sessionsDir, "ok.jsonl") });
    await sleep(4000); // 两段式：等后台 switch_session 接管完成
    const live = await post("/api/session/open", { path: path.join(sessionsDir, "ok.jsonl") }); // 复用路径返回 mode=live + state
    const original = live.data?.state?.model ?? models[0];
    const target = models.find((m) => m.provider === original.provider && m.id !== original.id) ?? original;
    const setModel = await post("/api/model", { provider: target.provider, modelId: target.id });
    check("T-10 POST /api/model → ok 且 get_state 反映", setModel.status === 200 && setModel.data?.ok === true && setModel.data?.state?.model?.id === target.id, `${target.provider}/${target.id}`);
    if (target.id !== original.id) await post("/api/model", { provider: original.provider, modelId: original.id }); // 还原，避免影响后续用例
    check("T-10 切回原模型后 get_state 一致", (await post("/api/model", { provider: original.provider, modelId: original.id })).data?.state?.model?.id === original.id, `${original.provider}/${original.id}`);

    const levelToSet = levels.find((l) => l !== "off") ?? levels[0];
    const setThinking = await post("/api/thinking", { level: levelToSet });
    check("T-10 POST /api/thinking → ok 且 get_state.thinkingLevel 更新", setThinking.status === 200 && setThinking.data?.state?.thinkingLevel === levelToSet, levelToSet);
    const badThinking = await post("/api/thinking", { level: "bogus-level" });
    const badLanded = badThinking.status === 502 || badThinking.data?.state?.thinkingLevel !== "bogus-level";
    check(
      "T-10 非法思考级别不静默生效（502 或回落到合法级别）",
      badLanded,
      `status=${badThinking.status} level=${badThinking.data?.state?.thinkingLevel ?? "n/a"}`,
    );

    const cmdsRes = await (await fetch(`${BASE}/api/commands`)).json();
    const cmdNames = new Set((cmdsRes.commands ?? []).map((c) => c.name));
    check(
      "T-11 GET /api/commands 返回非空命令集（扩展/模板/技能，取决于本机 pi 配置）",
      cmdNames.size > 0,
      `${cmdNames.size} 条命令`,
    );

    // ---------- 页面 ----------
    const profile = path.join(OUT, `edge-${Date.now()}`);
    edge = spawn(
      edgePath,
      ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--window-size=1440,900", `${BASE}/`],
      { stdio: "ignore" },
    );
    let t = null;
    for (let i = 0; i < 80 && !t; i++) {
      try {
        t = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      } catch {}
      if (!t) await sleep(250);
    }
    if (!t) throw new Error("Edge CDP 未就绪");
    const cdp = cdpConnect(t.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await sleep(1500);

    // 记录所有 fetch 请求体（证据用），并原样放行
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

    const selects = await evaluate(
      cdp,
      `(() => ({ models: document.querySelectorAll('#model-select option').length, levels: document.querySelectorAll('#thinking-select option').length }))()`,
      false,
    );
    check("T-10 页面：模型与思考级别下拉已填充", selects.models > 0 && selects.levels > 0, `models=${selects.models} levels=${selects.levels}`);

    // ---- T-09：代码块请求 → settled 后富渲染（Markdown 节点）且不重复 ----
    const richPrompt = ["严格按下面格式输出，不要任何解释或额外文字：", "\`\`\`js", "console.log(1)", "\`\`\`"].join(String.fromCharCode(10));
    const rich = await evaluate(
      cdp,
      `(async () => {
        const log = document.getElementById('log');
        const waitIdle = async (limit = 120000) => {
          const t = performance.now();
          while (performance.now() - t < limit) {
            const st = document.getElementById('state').textContent || '';
            if (st.startsWith('idle')) return;
            await new Promise((r) => setTimeout(r, 150));
          }
        };
        await waitIdle(5000);
        document.getElementById('input').value = ${JSON.stringify(richPrompt)};
        document.getElementById('composer').requestSubmit();
        const t0 = performance.now();
        await new Promise((res) => {
          const timer = setInterval(() => {
            const st = document.getElementById('state').textContent || '';
            if (st.startsWith('idle') && performance.now() - t0 > 1500) { clearInterval(timer); res(); }
            if (performance.now() - t0 > 120000) { clearInterval(timer); res(); }
          }, 150);
        });
        let live = document.querySelector('[data-role=live]');
        let blocks = live ? live.querySelectorAll('[data-role=code-block]') : [];
        // 模型偶发不加围栏：严格重试一次
        if (!blocks.length) {
          document.getElementById('input').value = ${JSON.stringify(richPrompt)};
          document.getElementById('composer').requestSubmit();
          const t2 = performance.now();
          while (performance.now() - t2 < 120000) {
            const st = document.getElementById('state').textContent || '';
            live = document.querySelector('[data-role=live]');
            blocks = live ? live.querySelectorAll('[data-role=code-block]') : [];
            if (blocks.length && st.startsWith('idle')) break;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        const richNodes = live ? live.querySelectorAll('[data-live=rich]') : [];
        const assistants = live ? live.querySelectorAll('.entry-assistant') : [];
        const langs = live ? [...live.querySelectorAll('[data-role=code-lang]')].map((e) => e.textContent) : [];
        return { rich: richNodes.length, assistants: assistants.length, blocks: blocks.length, langs, chars: live ? live.textContent.length : 0 };
      })()`,
    );
    check("T-09 settled 后富渲染（代码块 + 语言标签）", rich.blocks > 0 && rich.langs.includes("js"), `blocks=${rich.blocks} langs=${rich.langs.join(",")}`);
    check("T-09 同一条消息不重复插入（assistant 条目 = 1）", rich.assistants === 1, `assistants=${rich.assistants} rich=${rich.rich}`);
    await evaluate(cdp, `(() => { document.getElementById('log').scrollTop = 0; return true; })()`, false);
    await shot(cdp, "m1b-rich.png");

    // ---- T-09：图片（images） ----
    const imgRes = await evaluate(
      cdp,
      `(async () => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_1x1)}), (c) => c.charCodeAt(0));
        const file = new File([bytes], 'dot.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('image-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 300));
        const chip = document.querySelector('[data-role=attachment][data-kind=image]');
        document.getElementById('input').value = '这张图是什么颜色？只回答一个词，不要用工具。';
        window.__fetchLog.length = 0;
        document.getElementById('composer').requestSubmit();
        const t0 = performance.now();
        await new Promise((res) => {
          const timer = setInterval(() => {
            const st = document.getElementById('state').textContent || '';
            if (st.startsWith('idle') && performance.now() - t0 > 1200) { clearInterval(timer); res(); }
            if (performance.now() - t0 > 120000) { clearInterval(timer); res(); }
          }, 150);
        });
        const req = window.__fetchLog.find((r) => r.url.includes('/api/prompt'));
        return { chip: !!chip, chipText: chip?.textContent || '', hasImages: !!req?.body?.images?.length, mime: req?.body?.images?.[0]?.mimeType || '' };
      })()`,
    );
    check("T-09 图片附件 UI（chip）+ images 参数直通", imgRes.chip && imgRes.hasImages && imgRes.mime === "image/png", imgRes.chipText);

    // ---- T-09：文件注入（≤200KB，附路径与大小）----
    const fileRes = await evaluate(
      cdp,
      `(async () => {
        const file = new File(['第一行\\nMAGIC-STRING-42\\n第三行\\n'], 'note.txt', { type: 'text/plain' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('file-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 300));
        const chip = document.querySelector('[data-role=attachment][data-kind=file]');
        document.getElementById('input').value = '只回复文件里出现的 MAGIC 字符串，不要用工具。';
        window.__fetchLog.length = 0;
        document.getElementById('composer').requestSubmit();
        const t0 = performance.now();
        await new Promise((res) => {
          const timer = setInterval(() => {
            const st = document.getElementById('state').textContent || '';
            if (st.startsWith('idle') && performance.now() - t0 > 1200) { clearInterval(timer); res(); }
            if (performance.now() - t0 > 120000) { clearInterval(timer); res(); }
          }, 150);
        });
        const req = window.__fetchLog.find((r) => r.url.includes('/api/prompt'));
        const text = document.getElementById('log').textContent || '';
        return {
          chip: chip?.textContent || '',
          injected: String(req?.body?.message || '').includes('[File: note.txt]') && String(req?.body?.message || '').includes('MAGIC-STRING-42'),
          echoed: text.includes('MAGIC-STRING-42'),
        };
      })()`,
    );
    check("T-09 文件注入（附路径与大小 + [File:] 包裹）", !!fileRes.chip && /note\.txt/.test(fileRes.chip) && /KB/.test(fileRes.chip) && fileRes.injected, fileRes.chip);
    check("F-03 回复能复述文件中的特定字符串", fileRes.echoed, "");

    const bigFile = await evaluate(
      cdp,
      `(async () => {
        const big = new File([new Uint8Array(201 * 1024)], 'big.txt', { type: 'text/plain' });
        const dt = new DataTransfer();
        dt.items.add(big);
        const input = document.getElementById('file-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 300));
        const notice = document.getElementById('notice');
        return { chips: document.querySelectorAll('[data-role=attachment][data-kind=file]').length, text: notice?.textContent || '', shown: notice?.hidden === false };
      })()`,
    );
    check("T-09 文件 >200KB 被拒绝并提示", bigFile.shown && /200KB/.test(bigFile.text), bigFile.text.slice(0, 50));

    // ---- T-09：steer/followUp + Esc = clear_queue → abort ----
    const steer = await evaluate(
      cdp,
      `(async () => {
        const waitIdle = async (limit = 120000) => {
          const t = performance.now();
          while (performance.now() - t < limit) {
            const st = document.getElementById('state').textContent || '';
            if (st.startsWith('idle')) return;
            await new Promise((r) => setTimeout(r, 150));
          }
        };
        await waitIdle();
        window.__fetchLog.length = 0;
        document.getElementById('input').value = '请从 1 数到 800，每行一个数字，不要省略、不要用工具。';
        document.getElementById('composer').requestSubmit();
        await new Promise((res) => {
          const t = setInterval(() => {
            const st = document.getElementById('state').textContent || '';
            if (st.startsWith('streaming')) { clearInterval(t); res(); }
          }, 100);
          setTimeout(() => { clearInterval(t); res(); }, 60000);
        });
        await new Promise((r) => setTimeout(r, 300));
        const sel = document.getElementById('behavior');
        const visible = sel.hidden === false;
        sel.value = 'followUp';
        document.getElementById('input').value = '停。只回复 OK。';
        document.getElementById('composer').requestSubmit();
        await new Promise((r) => setTimeout(r, 1200));
        const queuedReq = window.__fetchLog.filter((r) => r.url.includes('/api/prompt')).pop();
        return { visible, behavior: queuedReq?.body?.streamingBehavior || '', stateText: document.getElementById('state').textContent, sends: window.__fetchLog.filter((r) => r.url.includes('/api/prompt')).length, notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent };
      })()`,
    );
    check("T-09 运行中可切换 steer/followUp 并随请求发送", steer.visible && steer.behavior === "followUp", `${steer.behavior} state=${steer.stateText} sends=${steer.sends} notice=${steer.notice}`);

    const esc = await evaluate(
      cdp,
      `(async () => {
        window.__fetchLog.length = 0;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const order = [];
        const t0 = performance.now();
        await new Promise((res) => {
          const t = setInterval(() => {
            for (const r of window.__fetchLog) if (!order.includes(r.url)) order.push(r.url);
            const st = document.getElementById('state').textContent || '';
            if (st.startsWith('idle')) { clearInterval(t); res(); }
            if (performance.now() - t0 > 10000) { clearInterval(t); res(); }
          }, 120);
        });
        return { order, idleMs: Math.round(performance.now() - t0), state: document.getElementById('state').textContent };
      })()`,
    );
    check(
      "T-09 Esc = clear_queue → abort，且 ≤5s 回 idle",
      esc.order.some((u) => u.includes('/api/clear-queue')) && esc.order.some((u) => u.includes('/api/abort')) && esc.idleMs <= 5000,
      `${esc.order.map((u) => u.replace('/api/', '')).join(' → ')} / ${esc.idleMs}ms`,
    );

    // ---- T-11：命令面板 ----
    const palette = await evaluate(
      cdp,
      `(async () => {
        document.getElementById('open-palette').click();
        await new Promise((r) => setTimeout(r, 600));
        const names = [...document.querySelectorAll('.palette-item')].map((b) => b.dataset.command);
        const sources = [...document.querySelectorAll('.palette-source')].map((d) => d.textContent);
        const probe = (names[0] || '').slice(0, 4);
        document.getElementById('palette-input').value = probe;
        document.getElementById('palette-input').dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 200));
        const filtered = [...document.querySelectorAll('.palette-item')].map((b) => b.dataset.command);
        return { count: names.length, probe, allFiltered: filtered.length >= 1 && filtered.every((n) => String(n).includes(probe)), sources, filtered };
      })()`,
    );
    check("T-11 面板项与命令集一致（扩展/模板/技能）", palette.count === cmdNames.size && palette.count > 0, `共 ${palette.count} 项；分组 ${palette.sources.join("/")}`);
    check("T-11 面板过滤生效", palette.allFiltered, `${palette.probe} → ${palette.filtered.join(",")}`);
    await shot(cdp, "m1b-palette.png");

    const picked = await evaluate(
      cdp,
      `(async () => {
        const orig = window.fetch;
        window.__picked = null;
        window.fetch = async (url, opts) => {
          if (String(url).includes('/api/prompt')) {
            window.__picked = JSON.parse(opts.body);
            return new Response(JSON.stringify({ disposition: 'handled' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return orig(url, opts);
        };
        document.getElementById('open-palette').click();
        await new Promise((r) => setTimeout(r, 500));
        const items = [...document.querySelectorAll('.palette-item')];
        const item = items[0];
        const name = item?.dataset.command || '';
        item?.click();
        await new Promise((r) => setTimeout(r, 500));
        window.fetch = orig;
        return { name, message: window.__picked?.message || '', paletteHidden: document.getElementById('palette').hidden };
      })()`,
    );
    check("T-11 选中即发送命令字面量", picked.message === `/${picked.name}` && picked.paletteHidden === true, `/${picked.name} → ${picked.message}`);

    // ---- fix(T-08)：CONFLICT 409 ----
    // 两段式后：先返回内容（200/view），cwd 不存在时由 SSE session_attach_failed(CONFLICT) 通知（见 m2a 证据 ③）
    const conflict = await post("/api/session/open", { path: path.join(sessionsDir, "gone.jsonl") });
    check(
      "fix(T-08) cwd 不存在：内容仍可读（mode=view），CONFLICT 走 SSE 接管失败（由 m2a 证据 ③ 断言）",
      conflict.status === 200 && conflict.data?.mode === "view" && (conflict.data?.entries?.length ?? 0) > 0,
      `${conflict.status} mode=${conflict.data?.mode} entries=${conflict.data?.entries?.length}`,
    );

    await evaluate(cdp, `(() => { document.getElementById('input').value = ''; return true; })()`, false);
    await shot(cdp, "m1b-composer.png");
    cdp.close();
  } catch (err) {
    check("运行异常", false, err.message);
  } finally {
    try {
      edge?.kill("SIGKILL");
    } catch {}
    kill(bridge.pid);
    await sleep(2500);
    const left = psPids("bridge/src/index.mjs").concat(psPids("pi-shell-m1b"));
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
