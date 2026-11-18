#!/usr/bin/env node
// 分层测试门：按改动路径只跑受影响的套件；发布前用 --full 跑全量。
// 用法：
//   node scripts/test-gate.mjs            # 对比 HEAD 的工作区改动
//   node scripts/test-gate.mjs --since HEAD~1
//   node scripts/test-gate.mjs --full     # 全量（发版用）
//   node scripts/test-gate.mjs --only composer,origin   # 只跑指定套件（迭代期用）
// 退出码：0 全过；1 有失败
import { execFileSync, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const args = process.argv.slice(2);
const full = args.includes("--full");
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? String(args[onlyIdx + 1] || "").split(",").map((x) => x.trim()).filter(Boolean) : null;

// MCP 按需：测试桥一律用「空配置」，不读真实 ~/.pi/agent/pi-shell-mcp.json。
// 否则候选名单/cwd 规则会让 E2E 引擎带起 MCP（约 480MB/引擎，且结果不可复现）。
const EMPTY_MCP_CONFIG = path.join(os.tmpdir(), "pi-shell-test-gate", "pi-shell-mcp.json");
fs.mkdirSync(path.dirname(EMPTY_MCP_CONFIG), { recursive: true });
fs.writeFileSync(EMPTY_MCP_CONFIG, `${JSON.stringify({ default: [], rules: [] }, null, 2)}\n`, "utf8");
process.env.PI_SHELL_MCP_CONFIG = EMPTY_MCP_CONFIG;

// 测试引擎的模型：唯一来源 scripts/model.json（不再依赖调用者的环境变量 / 全局 settings.json）。
// 2026-11-12 教训：引擎落回余额不足的 deepseek-flash → composer/multi 假失败。
import { readModelConfig } from "./model-config.mjs";
{
  const { provider, model } = readModelConfig();
  if (provider) process.env.PI_SHELL_PROVIDER = provider;
  if (model) process.env.PI_SHELL_MODEL = model;
}

function changedFiles() {
  try {
    const cmd = since ? ["diff", "--name-only", since] : ["status", "--porcelain"];
    const out = execFileSync("git", cmd, { cwd: ROOT, encoding: "utf8" });
    return since
      ? out.split("\n").filter(Boolean)
      : out.split("\n").filter(Boolean).map((l) => l.slice(3).trim());
  } catch { return []; }
}

// 每个套件的 port = 该脚本自己的默认端口；portEnv = 该脚本**自己读**的端口环境变量。
// 门禁在运行前探测空闲端口，冲突就顺延 +9，并通过 portEnv（同时兼容 PI_SHELL_PORT）传入。
const SUITES = {
  unit: { cmd: ["npm", "test"], cwd: "bridge" },
  firstLoad: { script: "first-load.mjs", port: 7794, portEnv: "PI_SHELL_PORT" },
  composer: { script: "composer-e2e.mjs", port: 7810, portEnv: "PI_SHELL_PORT" },
  origin: { script: "origin-ui.mjs", port: 7828, portEnv: "PI_SHELL_ORIGIN_PORT" },
  del: { script: "delete-session-ui.mjs", port: 7829, portEnv: "PI_SHELL_DEL_PORT" },
  treeFlat: { script: "tree-flat-ui.mjs", port: 7836, portEnv: "PI_SHELL_TREE_FLAT_PORT" },
  treeView: { script: "tree-view-ui.mjs", port: 7870, portEnv: "PI_SHELL_TREE_VIEW_PORT" },
  models: { script: "models-config-ui.mjs", port: 7837, portEnv: "PI_SHELL_EVIDENCE_PORT" },
  b8: { script: "ui-b8-shots.mjs", port: 7851, portEnv: "PI_SHELL_B8_PORT" },
  mobile: { script: "mobile-ui.mjs", port: 7861, portEnv: "PI_SHELL_MOBILE_PORT" },
  multi: { script: "multi-column-ui.mjs", port: 7881, portEnv: "PI_SHELL_MULTI_COL_PORT" },
  mcp: { script: "mcp-toggle-ui.mjs", port: 7898, portEnv: "PI_SHELL_MCP_PORT" },
  layout: { script: "layout-split-ui.mjs", port: 7862, portEnv: "PI_SHELL_LAYOUT_PORT" },
  sessionView: { script: "session-view-api.mjs", port: 7834, portEnv: "PI_SHELL_PORT" },
  sseTail: { script: "sse-tail-api.mjs", port: 7831, portEnv: "PI_SHELL_PORT" },
  bgContinue: { script: "background-continue-api.mjs", port: 7831, portEnv: "PI_SHELL_PORT" },
  bgUi: { script: "background-continue-ui.mjs", port: 7836, portEnv: "PI_SHELL_BG_UI_PORT" },
  sessionHeader: { script: "session-header-follow-ui.mjs", port: 7835, portEnv: "PI_SHELL_HEADER_PORT" },
  sessionMemory: { script: "session-memory-persist-api.mjs", port: 7839, portEnv: "PI_SHELL_PORT" },
  // 端口须与 scripts/evidence/thinking-order-ui.mjs 的默认 PORT（7840）一致
  thinkingOrder: { script: "thinking-order-ui.mjs", port: 7840, portEnv: "PI_SHELL_THINKING_UI_PORT" },
};

const MAP = [
  [/^bridge\//, ["unit", "sessionView"]],
  [/^bridge\/src\/(index|sse-tail)\.mjs$/, ["sseTail", "bgContinue"]],
  [/^bridge\/src\/(session-memory|index)\.mjs/, ["unit", "sseTail", "bgContinue", "sessionMemory"]],
  [/^web\/(index\.html|src\/(style|tokens)\.css)$/, ["firstLoad", "composer", "b8", "mobile", "layout"]],
  [/^web\/src\/render\.js/, ["composer"]],
  [/^web\/src\/markdown\.js/, ["composer"]],
  [/^web\/src\/list\.js/, ["origin", "del"]],
  [/^web\/src\/main\.js/, ["firstLoad", "composer", "origin", "del", "treeView", "models", "mobile", "multi", "sessionHeader"]],
  [/^web\/src\/(column|stream)\.js$/, ["bgUi", "composer", "multi", "sessionHeader"]],
  [/^web\/src\/(column|stream|render)\.js$/, ["thinkingOrder"]],
  [/^scripts\/evidence\//, ["firstLoad"]],
];

function pick(files) {
  const set = new Set();
  for (const f of files) for (const [re, suites] of MAP) if (re.test(f)) suites.forEach((s) => set.add(s));
  if (set.size === 0) set.add("unit");
  // 任何改动都先跑单测（秒级）
  set.add("unit");
  return [...set];
}

// 端口探测：纯 Node（net.createServer().listen），不依赖 netstat。
// 绑定失败 = 已被占用（含 TIME_WAIT / 出站临时端口占用的情况）。
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

const RESERVED_PORTS = new Set([7788]); // 真实 pi-shell 的生产端口，任何套件都不许占

// 从 preferred 起最多试 10 个（跳过生产端口），返回 null = 全被占。
async function choosePort(name, preferred) {
  for (let i = 0; i < 10; i++) {
    const cand = preferred + i;
    if (RESERVED_PORTS.has(cand)) continue;
    if (await portFree(cand)) {
      console.log(`[port] ${name} ${preferred} → ${cand}${i ? " (occupied)" : ""}`);
      return cand;
    }
  }
  return null;
}

// 失败套件的完整输出另存一份（stdout 可能一行都没有，报错在 stderr）——复核用。
function tailOf(r, name) {
  const out = r.stdout || "";
  const err = r.stderr || "";
  const pick = (text, n) => text.trim().split("\n").filter(Boolean).slice(-n).join(" | ");
  if (r.status !== 0) {
    const logDir = path.join(ROOT, ".dev", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `gate-fail-${name}.log`), `${out}${err}`, "utf8");
    return `${pick(out, 4) || pick(err, 4)} [全文 .dev/logs/gate-fail-${name}.log]`;
  }
  return pick(out, 4) || pick(err, 4);
}

async function runSuite(name) {
  const s = SUITES[name];
  if (!s) return { name, ok: false, detail: "unknown suite" };
  const env = { ...process.env };
  if (s.port) {
    const chosen = await choosePort(name, s.port);
    if (chosen === null) {
      return { name, ok: false, detail: `port: ${s.port}..${s.port + 9} 全被占用（试了 10 个）` };
    }
    env[s.portEnv || "PI_SHELL_PORT"] = String(chosen);
    env.PI_SHELL_PORT = String(chosen); // 兼容：旧脚本只认 PI_SHELL_PORT
  }
  const ctx = { name, ok: true, detail: "" };
  if (s.cmd) {
    const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: path.join(ROOT, s.cwd), env, encoding: "utf8", shell: true, timeout: 600000 });
    return { ...ctx, ok: r.status === 0, detail: tailOf(r, name) };
  }
  const p = path.join(ROOT, "scripts", "evidence", s.script);
  if (!fs.existsSync(p)) return { name, ok: true, detail: "skipped (missing script)" };
  const r = spawnSync(process.execPath, [p], { cwd: ROOT, env, encoding: "utf8", timeout: 900000 });
  return { ...ctx, ok: r.status === 0, detail: tailOf(r, name) };
}

const files = full ? [] : changedFiles();
const suites = only ? only : full ? Object.keys(SUITES) : pick(files);
console.log(`[test-gate] mode=${full ? "FULL" : "targeted"} files=${files.length} suites=${suites.join(",")}`);
let failed = 0;
for (const name of suites) {
  const r = await runSuite(name);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${name}  ${r.detail}`);
  if (!r.ok) failed++;
}
console.log(`\n[test-gate] ${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
