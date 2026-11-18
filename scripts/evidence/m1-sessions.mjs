#!/usr/bin/env node
// M1 · T-06 证据驱动：合成 1000 条会话的冷/热扫描、A-01 数据面、坏数据容错、?q=、V-08 闭环
//
// 用法：node scripts/evidence/m1-sessions.mjs
//   端口需空闲（默认 7788，可用 PI_SHELL_PORT 覆盖）；不需要浏览器。
// 产出：%TMP%\pi-shell-m1-sessions\summary.txt（另打印到控制台），退出码 0 = 全通过。

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionIndex } from "../../bridge/src/sessions.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-m1-sessions");
const DIRS = [
  "--C--Users-user-demo-project--",
  "--C--Users-user--",
  "--C--Users-user-pi-shell--",
  "--C--Users-user-project-two--",
  "--C--Users-user-project-three--",
  "--C--Users-user-dot-skills--",
];
const N = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// 一条符合 session-format 的最小会话（header + user + assistant）
function sessionText(i, dir) {
  const id = `01a1${String(i).padStart(4, "0")}-1111-2222-3333-${String(i).padStart(12, "0")}`;
  const ts = 1762300000000 + i * 1000;
  const user = `第 ${i} 条会话的问题：${i % 7 === 0 ? "项目任务梳理" : "日常任务"}`;
  const answer = `第 ${i} 条的回复摘要 ${"内容".repeat(i % 5)}`.trim();
  return [
    JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: dir }),
    JSON.stringify({ type: "message", id: `${id}-u`, parentId: null, timestamp: ts + 1, message: { role: "user", content: user } }),
    JSON.stringify({ type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: ts + 2, message: { role: "assistant", content: [{ type: "text", text: answer }] } }),
  ].join("\n") + "\n";
}

async function buildSessions(root) {
  for (const dir of DIRS) await fsp.mkdir(path.join(root, dir), { recursive: true });
  for (let i = 0; i < N; i++) {
    const dir = DIRS[i % DIRS.length];
    const file = path.join(root, dir, `2026-11-05T00-00-${String(i).padStart(2, "0")}-000Z_${i}.jsonl`);
    await fsp.writeFile(file, sessionText(i, dir), "utf8");
  }
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

function kill(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } catch {}
}

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

async function main() {
  await fsp.rm(OUT, { recursive: true, force: true });
  const sessionsDir = path.join(OUT, "sessions");
  await fsp.mkdir(sessionsDir, { recursive: true });
  await buildSessions(sessionsDir);
  check("前置：合成 1000 条会话（6 个目录）", fs.readdirSync(sessionsDir).length === DIRS.length, `${N} files`);

  // ---- 核心层：冷/热 ----
  const idx = new SessionIndex({ sessionsDir });
  const cold = await timed(() => idx.list({}));
  const hot = await timed(() => idx.list({}));
  const all = cold.value.groups.flatMap((g) => g.sessions);
  check("冷扫描 <3s", cold.ms < 3000, `${cold.ms.toFixed(0)}ms`);
  check("热扫描 <3s（缓存命中）", hot.ms < 3000, `${hot.ms.toFixed(0)}ms；cacheHits=${hot.value.stats.cacheHits}`);
  check("A-01 分组数 == 含 jsonl 的目录数", cold.value.groups.length === DIRS.length, `${cold.value.groups.length}/${DIRS.length}`);
  check("A-01 含 demo-project 分组", cold.value.groups.some((g) => String(g.cwd).includes("demo-project")), cold.value.groups.map((g) => g.cwd).join(" | "));
  check("A-01 1000 条四字段非空", all.length === N && all.every((s) => s.title && s.updatedAt && s.lastSnippet && s.status), `sessions=${all.length}`);
  check("A-01 status 仅 attached|unknown", all.every((s) => s.status === "unknown" || s.status === "attached"), "");
  check("无 warnings（合成数据全部可解析）", cold.value.warnings.length === 0, JSON.stringify(cold.value.warnings.slice(0, 2)));

  // ---- ?q= ----
  const hit = await idx.list({ q: "项目任务" });
  const hitCount = hit.groups.flatMap((g) => g.sessions).length;
  const miss = await idx.list({ q: "不可能出现的关键字zzz" });
  check("?q= 命中（title 子串）", hitCount > 0, `${hitCount} 条`);
  check("?q= 不命中", miss.groups.length === 0, `groups=${miss.groups.length}`);

  // ---- 坏数据容错 ----
  const badDir = path.join(sessionsDir, "--C--Users-user-bad--");
  await fsp.mkdir(badDir, { recursive: true });
  await fsp.writeFile(path.join(badDir, "empty.jsonl"), "", "utf8");
  await fsp.writeFile(path.join(badDir, "no-header.jsonl"), JSON.stringify({ type: "message", id: "e1", timestamp: 1762300001000, message: { role: "user", content: "无 header" } }) + "\n", "utf8");
  await fsp.writeFile(
    path.join(badDir, "tail-nonmessage.jsonl"),
    [
      JSON.stringify({ type: "session", id: "bad2", timestamp: 1762300000000, cwd: "C:\\Users\\user\\bad" }),
      JSON.stringify({ type: "message", id: "e1", timestamp: 1762300001000, message: { role: "user", content: "问题" } }),
      JSON.stringify({ type: "message", id: "e2", timestamp: 1762300002000, message: { role: "assistant", content: "正文" } }),
      JSON.stringify({ type: "model_change", id: "e3", timestamp: 1762300003000, model: "x" }),
    ].join("\n") + "\n",
    "utf8",
  );
  await fsp.writeFile(
    path.join(badDir, "huge-line.jsonl"),
    [
      JSON.stringify({ type: "session", id: "bad3", timestamp: 1762300000000, cwd: "C:\\Users\\user\\bad" }),
      JSON.stringify({ type: "message", id: "e1", timestamp: 1762300001000, message: { role: "user", content: "大行" } }),
      JSON.stringify({ type: "message", id: "e2", timestamp: 1762300002000, message: { role: "assistant", content: [{ type: "text", text: "z".repeat(100 * 1024) }] } }),
      JSON.stringify({ type: "message", id: "e3", timestamp: 1762300003000, message: { role: "assistant", content: "末尾" } }),
    ].join("\n") + "\n",
    "utf8",
  );
  const bad = await new SessionIndex({ sessionsDir }).list({});
  const badGroup = bad.groups.find((g) => g.dir === "--C--Users-user-bad--");
  const byName = Object.fromEntries(badGroup.sessions.map((s) => [path.basename(s.path), s]));
  check("坏数据：空文件不炸且给出 (无消息)", byName["empty.jsonl"]?.lastSnippet === "(无消息)" && !!byName["empty.jsonl"]?.title, JSON.stringify(byName["empty.jsonl"]?.title));
  check("坏数据：无 header → cwd 退化 + warning", byName["no-header.jsonl"]?.cwd === "--C--Users-user-bad--" && bad.warnings.some((w) => w.path.endsWith("no-header.jsonl")), byName["no-header.jsonl"]?.cwd);
  check("坏数据：末条非 message → 摘要取最后一条 message", byName["tail-nonmessage.jsonl"]?.lastSnippet === "正文", byName["tail-nonmessage.jsonl"]?.lastSnippet);
  check("坏数据：100KB 单行 → 仍取到末条 message", byName["huge-line.jsonl"]?.lastSnippet === "末尾", byName["huge-line.jsonl"]?.lastSnippet);

  // ---- 端口必须空闲 ----
  let portFree = true;
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    portFree = false;
  } catch {}
  if (!portFree) {
    check(`端口 ${PORT} 空闲（本脚本需自己起桥）`, false, "已有 bridge 在跑");
  } else {
    // ---- 端到端：HTTP 冷/热 + V-08 ----
    const logLines = [];
    const bridge = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
      cwd: REPO_ROOT,
      env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_SESSIONS_DIR: sessionsDir, PI_SHELL_CWD: os.homedir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bridge.stderr.setEncoding("utf8");
    bridge.stderr.on("data", (d) => {
      for (const l of String(d).split("\n")) if (l.trim()) logLines.push(l);
    });
    try {
      for (let i = 0; i < 200; i++) {
        try {
          const h = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
          if (h.pi.state === "idle") break;
        } catch {}
        await sleep(150);
      }

      const httpCold = await timed(async () => (await fetch(`${BASE}/api/sessions`)).json());
      const httpHot = await timed(async () => (await fetch(`${BASE}/api/sessions`)).json());
      check("HTTP GET /api/sessions 冷 <3s", httpCold.ms < 3000, `${httpCold.ms.toFixed(0)}ms`);
      check("HTTP GET /api/sessions 热 <3s", httpHot.ms < 3000, `${httpHot.ms.toFixed(0)}ms；cacheHits=${httpHot.value.stats?.cacheHits}`);
      check("HTTP 四字段非空", httpCold.value.groups.flatMap((g) => g.sessions).every((s) => s.title && s.updatedAt && s.lastSnippet && s.status), "");

      // V-08：临时会话目录 = 子进程落盘目录；先发消息产生文件，再查列表能看到
      const marker = `v08-${Date.now()}`;
      const promptRes = await fetch(`${BASE}/api/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `只回复这个标记，不要用工具：${marker}` }),
      });
      check("V-08 prompt 被接受", promptRes.status === 200, `status=${promptRes.status}`);

      let landed = null;
      for (let i = 0; i < 120 && !landed; i++) {
        const hits = [];
        // 两种布局都要找：<root>/<编码cwd>/*.jsonl 与 <root>/*.jsonl（--session-dir 扁平落盘）
        const candidates = [];
        for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.push(path.join(sessionsDir, entry.name));
          if (entry.isDirectory()) {
            for (const name of fs.readdirSync(path.join(sessionsDir, entry.name))) {
              if (name.endsWith(".jsonl")) candidates.push(path.join(sessionsDir, entry.name, name));
            }
          }
        }
        for (const p of candidates) {
          if (fs.statSync(p).size > 0 && fs.readFileSync(p, "utf8").includes(marker)) hits.push(p);
        }
        if (hits.length) landed = hits[0];
        else await sleep(250);
      }
      check("V-08 消息落盘在 PI_SHELL_SESSIONS_DIR 内", !!landed, landed ? path.relative(sessionsDir, landed) : "5s 内未找到");

      if (landed) {
        const dirName = path.basename(path.dirname(landed));
        const viaQ = await (await fetch(`${BASE}/api/sessions?q=${encodeURIComponent(marker)}`)).json();
        const found = viaQ.groups.flatMap((g) => g.sessions).find((s) => s.path === landed);
        check("V-08 /api/sessions 能看到刚落盘的会话（按 q 命中）", !!found, found ? `cwd=${found.cwd} title=${found.title}` : "未命中");
        const headerCwd = JSON.parse(fs.readFileSync(landed, "utf8").split("\n")[0]).cwd;
        check("V-08 分组 cwd 与 header.cwd 一致", !!found && found.cwd === headerCwd, `${found?.cwd || ""} vs ${headerCwd}`);
        check("V-08 当前会话 status=attached", found?.status === "attached", found?.status || "");
      }
    } finally {
      kill(bridge.pid);
      await sleep(2500);
      const left = psPids("bridge/src/index.mjs").concat(psPids("pi-shell-m1-sessions"));
      check("收尾：无残留 bridge / pi 进程", left.length === 0, `残留=${left.length}`);
      for (const pid of left) kill(pid);
      await fsp.writeFile(path.join(OUT, "bridge.log"), logLines.join("\n"));
    }
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
