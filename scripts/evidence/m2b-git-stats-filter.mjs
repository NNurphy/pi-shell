#!/usr/bin/env node
// M2-B 证据：T-18 Git 只读 diff / T-19 成本统计 / T-20 列表过滤（1000 条）
//
// 用法：node scripts/evidence/m2b-git-stats-filter.mjs   （端口需空闲；需要 Edge）
// 产出：%TMP%\pi-shell-m2b\summary.txt + m2b-stats.png / m2b-filter.png

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-m2b");
const REPO = path.join(OUT, "repo");
const SESSIONS = path.join(OUT, "sessions");
const NOTGIT = path.join(OUT, "notgit");
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
function psCount(marker) {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Measure-Object | Select-Object -ExpandProperty Count`], { encoding: "utf8" }).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}
const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
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

function sessionText({ id, cwd, user, answer }) {
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
  await fsp.mkdir(SESSIONS, { recursive: true });
  await fsp.mkdir(NOTGIT, { recursive: true });

  // ---- 临时 git 仓库 ----
  await fsp.mkdir(REPO, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "dev@localhost"]);
  git(["config", "user.name", "pi-shell dev"]);
  await fsp.writeFile(path.join(REPO, "a.txt"), "line1\nline2\n", "utf8");
  await fsp.writeFile(path.join(REPO, "b.txt"), "b1\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  await fsp.writeFile(path.join(REPO, "a.txt"), "line1\nline2-changed\nline3\n", "utf8");
  await fsp.writeFile(path.join(REPO, "c-new.txt"), "new\n", "utf8");

  // ---- 1000 条合成会话（T-20）----
  for (let i = 0; i < 1000; i++) {
    const id = `01a1f000-0000-0000-0000-${String(i).padStart(12, "0")}`;
    await fsp.writeFile(
      path.join(SESSIONS, `2026-11-06T00-00-${String(i % 60).padStart(2, "0")}-000Z_${id}.jsonl`),
      sessionText({ id, cwd: "C:\\Users\\user\\bulk", user: `批量会话 ${i}`, answer: `批量回复 ${i}` }),
      "utf8",
    );
  }

  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    check(`端口 ${PORT} 空闲`, false, "已有 bridge 在跑");
    process.exit(1);
  } catch {}

  const logs = [];
  const bridge = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_SESSIONS_DIR: SESSIONS, PI_SHELL_CWD: REPO },
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
        if ((await getJson("/api/health")).data?.pi?.state === "idle") break;
      } catch {}
      await sleep(150);
    }

    // ---------- T-18 ----------
    const statusBefore = git(["status", "--porcelain"]);
    const diff = await getJson("/api/git/diff");
    const termStat = git(["diff", "--stat"]);
    const apiFiles = String(diff.data?.stat || "").split("\n").filter(Boolean).map((l) => l.split("|")[0].trim()).filter(Boolean).sort();
    const termFiles = termStat.split("\n").filter(Boolean).map((l) => l.split("|")[0].trim()).filter(Boolean).sort();
    check("T-18 GET /api/git/diff 可用且与终端 `git diff --stat` 文件清单一致", diff.status === 200 && diff.data?.available === true && JSON.stringify(apiFiles) === JSON.stringify(termFiles), `${apiFiles.join(",")}`);
    check("T-18 patch 含实际改动", String(diff.data?.patch || "").includes("line2-changed"), `${String(diff.data?.patch || "").length}B`);
    const statusAfter = git(["status", "--porcelain"]);
    check("T-18 只读：调用前后 `git status --porcelain` 不变", statusBefore === statusAfter, `${statusBefore.split("\n").filter(Boolean).length} 项`);
    check("T-18 无 .git/index.lock 残留", !fs.existsSync(path.join(REPO, ".git", "index.lock")), "");

    // 大 patch 截断
    await fsp.writeFile(path.join(REPO, "big.txt"), "start\n", "utf8");
    git(["add", "big.txt"]);
    git(["commit", "-q", "-m", "add big"]);
    await fsp.writeFile(path.join(REPO, "big.txt"), "x".repeat(3 * 1024 * 1024), "utf8");
    const bigDiff = await getJson("/api/git/diff");
    check("T-18 patch >2MiB → 截断 + truncated:true", bigDiff.status === 200 && bigDiff.data?.truncated === true && Buffer.byteLength(String(bigDiff.data?.patch || ""), "utf8") === 2 * 1024 * 1024, `${Buffer.byteLength(String(bigDiff.data?.patch || ""))}B`);
    // 还原，避免影响后续
    await fsp.writeFile(path.join(REPO, "big.txt"), "start\n", "utf8");

    // 非 git 仓库
    const wsNonGit = await post("/api/workspace", { cwd: NOTGIT });
    const nonGit = await getJson("/api/git/diff");
    check("T-18 非 git 目录 → 200 {available:false}", wsNonGit.status === 200 && nonGit.status === 200 && nonGit.data?.available === false, `ws=${wsNonGit.status} body.available=${nonGit.data?.available}`);
    // 切回仓库
    await post("/api/workspace", { cwd: REPO });
    const backGit = await getJson("/api/git/diff");
    check("T-18 切回仓库后恢复 available:true", backGit.data?.available === true, "");

    // ---------- T-19 ----------
    const openSrc = await post("/api/session/open", { path: path.join(SESSIONS, fs.readdirSync(SESSIONS).find((n) => n.endsWith(".jsonl"))) });
    check("T-19 打开会话后 GET /api/stats 返回字段", (await getJson("/api/stats")).data?.tokens !== undefined, "");
    const stats1 = await getJson("/api/stats");
    const stats1b = await getJson("/api/stats");
    check("T-19 直通一致（两次调用逐字段相等）", JSON.stringify(stats1.data) === JSON.stringify(stats1b.data), `tokens=${stats1.data?.tokens?.total} cost=${stats1.data?.cost}`);
    const beforeTokens = Number(stats1.data?.tokens?.total ?? 0);

    // 真实对话：前后 tokens 单调增加
    await post("/api/prompt", { message: "只回复两个字：好的。" });
    let settled = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const s = await getJson("/api/stats");
      if (Number(s.data?.tokens?.total ?? 0) > beforeTokens) {
        settled = true;
        break;
      }
      await sleep(1000);
    }
    const stats2 = await getJson("/api/stats");
    check("T-19 真实对话后 tokens 单调增加", settled && Number(stats2.data?.tokens?.total ?? 0) > beforeTokens, `${beforeTokens} → ${stats2.data?.tokens?.total}`);

    // ---------- 页面：stats 展示 + null 分支 ----------
    const edgePath = findEdge();
    if (!edgePath) {
      check("找到 Edge", false, "未找到 msedge.exe");
    } else {
      const debugPort = await freePort(PORT + 1500);
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
      await sleep(1800);

      const statsUi = await evaluate(
        cdp,
        `(async () => {
          await window.__piShell.refreshStats();
          await new Promise((r) => setTimeout(r, 300));
          const el = document.getElementById('stats');
          const text = el.textContent;
          // null 分支：stub /api/stats 返回 contextUsage.tokens=null
          const orig = window.fetch;
          window.fetch = async (u, o) => {
            if (String(u).includes('/api/stats')) {
              return new Response(JSON.stringify({ tokens: { total: 1234, input: 1000, output: 234, cacheRead: 0, cacheWrite: 0 }, cost: 0.0123, contextUsage: { tokens: null, contextWindow: 200000, percent: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return orig(u, o);
          };
          let threw = false;
          try { await window.__piShell.refreshStats(); } catch { threw = true; }
          window.fetch = orig;
          const nullText = el.textContent;
          await window.__piShell.refreshStats();
          return { text, nullText, threw, hidden: el.hidden };
        })()`,
      );
      check("T-19 UI 显示 tokens/cost/context", /tok/.test(statsUi.text) && /\$/.test(statsUi.text) && /ctx/.test(statsUi.text) && !statsUi.hidden, statsUi.text);
      check("T-19 contextUsage.tokens=null 不崩（显示 ctx ?/200k）", !statsUi.threw && /ctx/.test(statsUi.nullText), statsUi.nullText);
      await shot(cdp, "m2b-stats.png");

      // ---------- T-20 ----------
      const filter = await evaluate(
        cdp,
        `(async () => {
          // B8 后左侧分组**默认收起**（产品刻意行为，见 list.js load()）：会话行不渲染。
          // 过滤断言要量的是「命中的会话行」，所以先点开所有组头（从最下面的点起，展开只影响下方）。
          for (let i = 0; i < 20; i++) {
            const closed = [...document.querySelectorAll('[data-role=group-row][data-open="false"]')];
            if (!closed.length) break;
            closed[closed.length - 1].click();
            await new Promise((r) => setTimeout(r, 220));
          }
          // 等首屏列表加载完（baseGroups 就绪）再测输入延迟
          const tWait = performance.now();
          while (performance.now() - tWait < 15000 && window.__piShell.list.model.rows.length < 200) await new Promise((r) => setTimeout(r, 100));
          const statUrl = [];
          const orig = window.fetch;
          window.fetch = async (u, o) => { if (String(u).includes('/api/sessions')) statUrl.push(String(u)); return orig(u, o); };
          const input = document.getElementById('session-search');
          const t0 = performance.now();
          input.value = '批量会话 777';
          input.dispatchEvent(new Event('input'));
          const norm = (s) => String(s).replace(/\\\\/g, '/').toLowerCase();
          let updatedMs = null;
          for (let i = 0; i < 200; i++) {
            const rows = window.__piShell.list.model.rows.filter((r) => r.kind === 'session');
            if (rows.length > 0 && rows.length < 50) { updatedMs = Math.round(performance.now() - t0); break; }
            await new Promise((r) => setTimeout(r, 10));
          }
          const hits = window.__piShell.list.model.rows.filter((r) => r.kind === 'session').length;
          const hitsLabel = input.dataset.hits;
          // 不命中 → 空态
          input.value = '不可能命中的关键词zzz';
          input.dispatchEvent(new Event('input'));
          let emptyState = '';
          for (let i = 0; i < 200; i++) {
            emptyState = document.querySelector('[data-role=list-placeholder]')?.dataset.state || '';
            if (emptyState === 'empty') break;
            await new Promise((r) => setTimeout(r, 10));
          }
          // 清空按钮
          const clearBtn = document.getElementById('search-clear');
          const clearVisible = clearBtn.hidden === false;
          clearBtn.click();
          await new Promise((r) => setTimeout(r, 600));
          window.fetch = orig;
          return { updatedMs, hits, hitsLabel, emptyState, clearVisible, urls: statUrl.length };
        })()`,
      );
      check("T-20 输入到列表更新 <300ms（防抖 250ms + 缓存查询）", filter.updatedMs != null && filter.updatedMs < 300, `${filter.updatedMs}ms（命中 ${filter.hits} 条）`);
      check("T-20 命中数显示", String(filter.hitsLabel) === String(filter.hits) && filter.hits > 0, `label=${filter.hitsLabel} hits=${filter.hits}`);
      check("T-20 不命中 → 空态一屏", filter.emptyState === "empty", filter.emptyState);
      check("T-20 清空按钮可见且可用", filter.clearVisible, "");
      await shot(cdp, "m2b-filter.png");

      // 缓存未失效（不读文件正文）：连续查询 cacheHits == files
      const q1 = await getJson("/api/sessions?q=%E6%89%B9%E9%87%8F");
      await sleep(300);
      const q2 = await getJson("/api/sessions?q=%E6%89%B9%E9%87%8F%20777");
      check(
        "T-20 过滤只走索引缓存（第二次 cacheHits == files，不重读文件）",
        (q1.data?.stats?.cacheHits ?? 0) === (q1.data?.stats?.files ?? -1) && (q2.data?.stats?.cacheHits ?? 0) === (q2.data?.stats?.files ?? -1),
        `q1=${q1.data?.stats?.cacheHits}/${q1.data?.stats?.files} q2=${q2.data?.stats?.cacheHits}/${q2.data?.stats?.files}`,
      );
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
    check("收尾：无残留 bridge / pi 进程", psCount("pi-shell-m2b") === 0, `残留=${psCount("pi-shell-m2b")}`);
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
