#!/usr/bin/env node
// B8 视觉重设计（P0–P1）证据截图：真实页面截图（不是 preview.html），零第三方依赖。
//
// 产出：
//   docs/evidence/ui-b8-desktop-light.png   1440×900 亮色：顶栏 + 侧栏 + 会话流（含左轨/气泡/工具行）
//   docs/evidence/ui-b8-desktop-dark.png    1440×900 暗色：同一屏
//   docs/evidence/ui-b8-agent-section.png   侧栏 AGENT 板块特写（真实 DOM 区域裁剪）
//
// 铁律：只用 %TEMP% 下的手写夹具会话（PI_SHELL_SESSIONS_DIR 指向它），绝不碰真实会话。
// 夹具里塞了一条 agent 会话（PI_SHELL_AGENT_SESSIONS_DIR），用来展示「AGENT 会话」文字徽标板块。
//
// 用法：node scripts/evidence/ui-b8-shots.mjs      （固定端口 7851，独占）
// 环境变量：EDGE_PATH 指定 msedge.exe
// 退出码：0 = 全部产出成功

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_B8_PORT || 7851);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1000;
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-b8-shots");
const SESSIONS = path.join(OUT_DIR, "sessions");
const AGENTS = path.join(OUT_DIR, "sessions-agents");
const LOG_FILE = path.join(OUT_DIR, "bridge.log");
const SHOT_DIR = path.join(REPO_ROOT, "docs", "evidence");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- 夹具（两个目录：普通会话 / agent 会话） ----------

const MAIN_ID = "b8-showcase-0001";
const AGENT_ID = "b8-agent-0001";

function jsonl(rows) {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function msg(id, parentId, at, role, content) {
  return { type: "message", id, parentId, timestamp: new Date(at).toISOString(), message: { role, content } };
}

function writeFixture() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const dir = path.join(SESSIONS, "--C--Users-user-pi-shell-b8--");
  const agentDir = path.join(AGENTS, "--C--Users-user-agent--");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const t0 = Date.now() - 3_600_000;
  let at = t0;
  const step = (ms) => (at += ms);
  const rows = [
    { type: "session", version: 3, id: MAIN_ID, timestamp: t0, cwd: REPO_ROOT },
    msg(
      "u1",
      null,
      step(0),
      "user",
      "现在信息密度高但是没有层级：长会话滚到后面就找不到当前在做什么。先把会话树的设计定下来——962 个节点那种，别给我看一整棵树。",
    ),
    msg("a1", "u1", step(8400), "assistant", [
      {
        type: "thinking",
        thinking:
          "用户抱怨的是「翻不到当前在做什么」，不是「树不全」。深度≈节点数这个事实决定了缩进不能按深度展开，所以要从 leaf 回溯主干。",
      },
      {
        type: "text",
        text:
          "## 先说结论：默认不该显示整棵树\n\n" +
          "962 个节点里，你 90% 的时间只在**主干**上。树的价值不是「看全貌」，是回答三个问题：我在哪、我怎么走过来、哪里还有岔路。\n\n" +
          "- 深度 ≈ 节点数 → 缩进必须 **3 层封顶**，第 4 层起用等宽徽标 `D1200` 承担深度\n" +
          "- 分支是「出口」不是「内容」→ 折叠成一行 `＋2 分支`，点了才加载\n" +
          "- 当前叶子必须常亮，并有 `定位当前` 兜底，否则滚丢就找不回来\n\n" +
          "所以选「主干优先 + 逐层折叠」；缩略图路线留到 v2，先看真实 962 节点的使用数据。",
      },
    ]),
    msg("u2", "a1", step(6200), "user", "缩进 3 层之后，第 1200 层怎么看出自己在哪？"),
    msg("a2", "u2", step(1200), "assistant", [
      {
        type: "toolCall",
        id: "call_1",
        name: "bash",
        arguments: { command: 'rg -n "flattenSessionTree" web/src' },
      },
    ]),
    {
      type: "message",
      id: "t1",
      parentId: "a2",
      timestamp: new Date(at + 1200).toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [
          {
            type: "text",
            text:
              "web/src/main.js:1550:function flattenSessionTree(tree) {\n" +
              "web/src/main.js:1551:  const rows = [];\nweb/src/main.js:1552:  const stack = [];",
          },
        ],
      },
    },
    msg("a3", "t1", step(2400), "assistant", [
      {
        type: "text",
        text:
          "用**等宽深度徽标**承担位置信息：\n\n" +
          "```\nD1200  ◇ 思考 4.1s\nD1201  ◆ 回复 · 缩进封顶到 3 层…\nD1202  ▸ bash npm test  1.2s ✓\n```\n\n" +
          "徽标只在 `depth > 3` 时出现，浅层靠 12px 缩进已经可读；深层改成「悬垂导轨 + 徽标」，横向永远不会跑出面板。",
      },
    ]),
  ];
  fs.writeFileSync(path.join(dir, `${MAIN_ID}.jsonl`), jsonl(rows), "utf8");

  const tAgent = Date.now() - 1_800_000;
  const agentRows = [
    { type: "session", version: 3, id: AGENT_ID, timestamp: tAgent, cwd: "C:\\Users\\user\\pi-shell-b8" },
    msg("au1", null, tAgent + 1000, "user", "复核示例项目队列（只读）"),
    msg("aa1", "au1", tAgent + 18000, "assistant", [{ type: "text", text: "已复核 27 条待回，队列无异常。" }]),
  ];
  fs.writeFileSync(path.join(agentDir, `${AGENT_ID}.jsonl`), jsonl(agentRows), "utf8");
  return path.join(dir, `${MAIN_ID}.jsonl`);
}

// ---------- bridge / Edge / CDP ----------

function startBridge() {
  return spawn(process.execPath, ["bridge/src/index.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_SESSIONS_DIR: SESSIONS,
      PI_SHELL_AGENT_SESSIONS_DIR: AGENTS,
      PI_SHELL_LOG_FILE: LOG_FILE,
    },
    stdio: "ignore", // H-15：管道不消费会把桥堵死
  });
}

async function waitHealth(ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const body = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
      if (body?.ok && body?.pi?.state === "idle") return body;
    } catch {}
    await sleep(300);
  }
  return null;
}

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
    on(fn) {
      listeners.push(fn);
    },
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
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    timeout: 120000,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function launchEdge(edgePath) {
  const edge = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${path.join(OUT_DIR, "edge-profile")}`,
    "--window-size=1440,900",
    "--force-device-scale-factor=1",
    `${BASE}/`,
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge CDP 未就绪");
  return { edge, target };
}

async function shot(cdp, file, clip) {
  const res = await cdp.send("Page.captureScreenshot", clip ? { format: "png", clip: { ...clip, scale: 1 } } : { format: "png" });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  return file;
}

const PAGE_READY = `(() => {
  const v = (document.getElementById('version')?.textContent || '').trim();
  return !!document.getElementById('input') && !!v && v !== '—';
})()`;

async function waitPageReady(cdp, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(cdp, PAGE_READY, false).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

/** 展开侧栏所有分组（默认收起是产品行为，截图需要看到行） */
async function expandAll(cdp) {
  for (let i = 0; i < 8; i++) {
    const closed = await evaluate(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('[data-role=group-row][data-open=false]')];
        rows.forEach((g) => g.querySelector('[data-role=group-toggle]')?.click());
        return rows.length;
      })()`,
      false,
    ).catch(() => 0);
    if (!closed) break;
    await sleep(250);
  }
  await sleep(300);
}

// ---------- 主流程 ----------

async function main() {
  const fixturePath = writeFixture();
  const normalized = fixturePath.replace(/\\/g, "/");

  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    throw new Error(`端口 ${PORT} 上已有实例在跑，本脚本必须独占端口`);
  } catch (err) {
    if (/已有实例在跑/.test(err.message)) throw err;
  }

  const edgePath = findEdge();
  if (!edgePath) throw new Error("找不到 msedge.exe（可用 EDGE_PATH 指定）");

  const bridge = startBridge();
  let edge = null;
  let cdp = null;

  try {
    const health = await waitHealth();
    if (!health) throw new Error(`bridge 未在 40s 内就绪（看 ${LOG_FILE}）`);
    console.log(`      bridge ready · pi ${health.pi.version} · pid ${health.pi.pid}`);

    const launched = await launchEdge(edgePath);
    edge = launched.edge;
    cdp = cdpConnect(launched.target.webSocketDebuggerUrl);
    await cdp.ready;
    const pageErrors = [];
    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params?.exceptionDetails?.text || "exception");
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const e = msg.params.entry;
        if (/favicon\.ico/.test(String(e.url || "") + " " + String(e.text || ""))) return;
        pageErrors.push(e.url ? `${e.text} (${e.url})` : e.text);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const ready = await waitPageReady(cdp);
    check("E0 页面可交互（桥就绪）", !!ready, ready ? `pi=${health.pi.version}` : "40s 未就绪");
    if (!ready) throw new Error("页面未就绪");

    // 打开夹具会话（只读；不发消息，不碰真实会话）
    const opened = await evaluate(cdp, `window.__piShell.openSessionPath(${JSON.stringify(normalized)})`, true);
    check("E1 夹具会话已渲染", (opened?.entries ?? 0) >= 6, `entries=${opened?.entries}`);
    await sleep(1200);
    await expandAll(cdp);

    const shape = await evaluate(
      cdp,
      `(() => ({
        entries: document.querySelectorAll('#log .entry').length,
        rail: getComputedStyle(document.querySelectorAll('#log .entries')[0], '::before').width,
        bubbles: document.querySelectorAll('#log .entry-user .text-block').length,
        tools: document.querySelectorAll('#log .collapse-tool').length,
        thinking: document.querySelectorAll('#log .collapse-thinking').length,
        turnDurations: document.querySelectorAll('#log [data-role=turn-duration]').length,
        rows: document.querySelectorAll('[data-role=session-row]').length,
        agentGroup: !!document.querySelector('[data-role=group-row][data-agent=true]'),
        changesHidden: document.getElementById('changes')?.hidden,
        changesCount: document.getElementById('changes-count')?.textContent,
      }))()`,
      false,
    );
    check("E2 会话流结构（左轨 + 气泡 + 工具/思考折叠）", shape.rail === "1px" && shape.bubbles >= 2 && shape.tools >= 1 && shape.thinking >= 1, JSON.stringify(shape));
    check("E3 侧栏三行行 + AGENT 板块（文字徽标）", shape.rows >= 2 && shape.agentGroup, `rows=${shape.rows} agentGroup=${shape.agentGroup}`);

    // 截图前把「接管完成」toast 关掉、把会话流滚到第一轮（截图看得到编号 01 起的左轨）
    await evaluate(cdp, `(() => {
      const t = document.getElementById('toast');
      if (t) t.hidden = true;
      document.getElementById('log').scrollTop = 0;
      return true;
    })()`, false);
    await sleep(500);

    // ---- 亮色截图 ----
    await evaluate(cdp, `window.__piShell.setPreference('theme', 'light')`, false);
    await sleep(600);
    await evaluate(cdp, `(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; return true; })()`, false);
    const lightFile = await shot(cdp, path.join(SHOT_DIR, "ui-b8-desktop-light.png"));
    check("E4 亮色桌面截图", fs.existsSync(lightFile) && fs.statSync(lightFile).size > 0, lightFile);

    // ---- 暗色截图 ----
    await evaluate(cdp, `window.__piShell.setPreference('theme', 'dark')`, false);
    await sleep(700);
    const darkFile = await shot(cdp, path.join(SHOT_DIR, "ui-b8-desktop-dark.png"));
    const darkCanvas = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`, false);
    check("E5 暗色桌面截图（canvas 已是暗色 token）", fs.existsSync(darkFile) && fs.statSync(darkFile).size > 0, `${darkFile} · canvas=${darkCanvas}`);

    // ---- token 双入口：显式 [data-theme] 与「跟随系统」两条路径都要真的变暗 ----
    const tokenPaths = await evaluate(
      cdp,
      `(async () => {
        const read = () => {
          const cs = getComputedStyle(document.documentElement);
          return { canvas: cs.getPropertyValue('--canvas').trim(), accent: cs.getPropertyValue('--accent').trim() };
        };
        const api = window.__piShell;
        api.setPreference('theme', 'system');
        await new Promise((r) => setTimeout(r, 60));
        const system = read();
        api.setPreference('theme', 'dark');
        await new Promise((r) => setTimeout(r, 60));
        const explicit = read();
        api.setPreference('theme', 'light');
        await new Promise((r) => setTimeout(r, 60));
        const light = read();
        return { system, explicit, light };
      })()`,
      true,
    );
    check(
      "E6b token 三入口（system/dark/light）取到不同 canvas + accent",
      tokenPaths.explicit.canvas !== tokenPaths.light.canvas &&
        tokenPaths.explicit.accent !== tokenPaths.light.accent &&
        [tokenPaths.system, tokenPaths.explicit, tokenPaths.light].every((t) => /^#[0-9a-f]{6}$/i.test(t.canvas)),
      `system=${tokenPaths.system.canvas}/${tokenPaths.system.accent} · dark=${tokenPaths.explicit.canvas}/${tokenPaths.explicit.accent} · light=${tokenPaths.light.canvas}/${tokenPaths.light.accent}`,
    );

    // ---- AGENT 板块特写（侧栏区域裁剪，真实 DOM） ----
    await evaluate(cdp, `window.__piShell.setPreference('theme', 'light')`, false);
    await sleep(500);
    const box = await evaluate(
      cdp,
      `(() => {
        const sb = document.querySelector('.sidebar');
        const r = sb.getBoundingClientRect();
        const agent = document.querySelector('[data-role=group-row][data-agent=true]');
        const current = document.querySelector('[data-role=session-row][data-current=true]');
        const ar = agent ? agent.getBoundingClientRect() : null;
        const cr = current ? current.getBoundingClientRect() : null;
        // 高度算到「当前会话行」的底部 + 8px，避免拍到半行
        const bottom = cr ? cr.bottom : ar ? ar.bottom + 168 : r.top + 260;
        const h = Math.min(420, Math.round(bottom - r.top + 8));
        return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: h };
      })()`,
      false,
    );
    const agentFile = await shot(cdp, path.join(SHOT_DIR, "ui-b8-agent-section.png"), box);
    check("E6 AGENT 板块特写截图", fs.existsSync(agentFile) && fs.statSync(agentFile).size > 0, `${agentFile} · clip=${JSON.stringify(box)}`);

    // 网络层失败（夹具环境里 /api/stats 之类 502）不是未捕获异常，按 tree-flat-ui 的口径排除
    const realErrors = pageErrors.filter((t) => !/favicon|net::ERR_|Failed to load resource/.test(String(t)));
    check("E7 加载期无未捕获 JS 异常", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "无");

    // 顶栏收敛证据（同时把几个关键量写成日志，便于报告引用）
    const bar = await evaluate(
      cdp,
      `(() => {
        const items = (sel) => [...document.querySelectorAll(sel)].map((el) => el.id || el.tagName);
        return {
          visible: items('header.bar > button:not([hidden]), header.bar > select, header.bar > span.state, header.bar > span.engines:not([hidden])'),
          inMenu: items('#overflow-menu > button'),
          pid: document.getElementById('pid')?.textContent,
          version: document.getElementById('version')?.textContent,
          cwd: document.getElementById('cwd')?.textContent,
          state: document.getElementById('state')?.textContent,
          engines: document.getElementById('engines')?.textContent,
          changes: document.getElementById('changes')?.hidden === false ? document.getElementById('changes-count')?.textContent : "hidden",
        };
      })()`,
      false,
    );
    console.log(`      顶栏可见：${bar.visible.join(" / ")}`);
    console.log(`      ⋯ 菜单：${bar.inMenu.join(" / ")}`);
    console.log(`      pid=${bar.pid} pi=${bar.version} cwd=${bar.cwd} state=${bar.state} engines=${bar.engines} changes=${bar.changes}`);
    check(
      "E8 顶栏收敛：可见入口 ≤ 8 且 树/文件/Diff/设置/重启 都在 ⋯ 里",
      bar.visible.length <= 8 && ["open-tree", "open-files", "open-diff", "open-settings", "restart-bridge"].every((id) => bar.inMenu.includes(id)),
      `visible=${bar.visible.length} inMenu=${bar.inMenu.length}`,
    );
  } finally {
    try {
      cdp?.close();
    } catch {}
    try {
      edge?.kill("SIGKILL");
    } catch {}
    try {
      bridge.kill("SIGTERM");
    } catch {}
    await sleep(1500);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log(`FAIL 清单：${failed.map((r) => r.name).join(" | ")}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error("FATAL", err.message);
  process.exitCode = 1;
});
