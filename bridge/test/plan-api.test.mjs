// 计划协议（/api/plan 沙箱 + /plan 改写 + 内置 plan 命令）单测
//
// 口径：
//   1) GET /api/plan：正常读取（相对/绝对）、title 提取、不存在 → exists:false、
//      越界（..、junction 逃逸）→ 403 PLAN_PATH_FORBIDDEN、非法扩展名 → 403、>2MiB → 413 PLAN_TOO_LARGE；
//   2) /plan 改写："/plan"、"/plan 做个 X" 改写；"/plan做X"（无空格）与普通消息**不改写**；
//      改写结果不再被识别（幂等）；
//   3) /api/commands：追加 builtin plan；pi 侧已有同名时不重复追加。
//
// 手法：真桥 + 假 pi（与 attach-fileread 同款夹具）。断言的是**发给 pi 的文本**（假 pi 落盘记录），
// 而不是桥内部函数返回值——改写若没真正走到 RPC，这里就红。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ENTRY = path.resolve(HERE, "..", "src", "index.mjs");
const PLAN_MAX_BYTES = 2 * 1024 * 1024;

// 假 pi：get_state / get_commands（从夹具文件读，便于运行中切换）/ prompt（落盘记录收到的文本）
const FAKE_PI = `"use strict";
const fs = require("node:fs");
const readline = require("node:readline");

const PROMPT_LOG = process.env.FAKE_PROMPT_LOG || "";
const COMMANDS_FILE = process.env.FAKE_COMMANDS_FILE || "";

const reply = (msg, data) => process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");

const readCommands = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8"));
    return Array.isArray(parsed.commands) ? parsed.commands : [];
  } catch {
    return [];
  }
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.id === "undefined") return;
  switch (msg.type) {
    case "get_state":
      return reply(msg, {
        sessionId: "fake-boot",
        sessionFile: null,
        cwd: process.cwd(),
        isStreaming: false,
        thinkingLevel: "off",
        model: { provider: "fake", id: "fake-default", name: "Fake Default" },
      });
    case "get_commands":
      return reply(msg, { commands: readCommands() });
    case "prompt": {
      if (PROMPT_LOG) {
        try {
          fs.appendFileSync(PROMPT_LOG, JSON.stringify({ message: msg.message, streamingBehavior: msg.streamingBehavior ?? null }) + "\\n");
        } catch {}
      }
      return reply(msg, { disposition: "started" });
    }
    default:
      return reply(msg, {});
  }
});
`;

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function freePort() {
  for (let i = 0; i < 50; i += 1) {
    const port = 7980 + i; // 避开 7788 与其它测试的 7940 段
    if (await portFree(port)) return port;
  }
  throw new Error("找不到空闲端口（7980-8029）");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { ms = 30000, step = 100 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last?.ok) return last;
    await sleep(step);
  }
  return last ?? { ok: false };
}

let child = null;
let fixture = null;
let PORT = 0;
let outsideJunction = null;

function buildFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-plan-")));
  const agentDir = path.join(root, "agent");
  const pkgDir = path.join(agentDir, "install", "releases", "1.5.0", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "install", "current-version"), "1.5.0\n", "utf8");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pi-coding-agent", version: "1.5.0", bin: { pi: "cli.js" } }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(pkgDir, "cli.js"), FAKE_PI, "utf8");
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2), "utf8");

  const home = path.join(root, "home");
  const project = path.join(root, "proj");
  const outside = path.join(root, "outside");
  const sessionsDir = path.join(root, "sessions");
  const plansInProject = path.join(project, ".pi", "plans");
  const plansInAgent = path.join(agentDir, "plans");
  const plansLegacy = path.join(home, ".claude", "plans");
  for (const dir of [home, project, outside, sessionsDir, plansInProject, plansInAgent, plansLegacy]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 计划文件：cwd 子树 / <agentDir>/plans / ~/.claude/plans 三处白名单各一份
  const projectPlan = path.join(plansInProject, "x.md");
  fs.writeFileSync(projectPlan, "# 计划 X\n\n## 目标\n把 X 做出来\n", "utf8");
  const agentPlan = path.join(plansInAgent, "y.md");
  fs.writeFileSync(agentPlan, "没有标题的计划正文\n", "utf8");
  const legacyPlan = path.join(plansLegacy, "legacy.md");
  fs.writeFileSync(legacyPlan, "# 旧计划\n正文\n", "utf8");

  // 反例：白名单外 .md（父目录在 root 下、但不在 cwd/白名单里）
  const outsidePlan = path.join(outside, "secret.md");
  fs.writeFileSync(outsidePlan, "# 不该被读到\n", "utf8");

  // 反例：非法扩展名 + 超大文件
  fs.writeFileSync(path.join(project, ".pi", "plans", "evil.json"), "{}\n", "utf8");
  const bigPlan = path.join(project, ".pi", "plans", "big.md");
  fs.writeFileSync(bigPlan, `# 大计划\n${"y".repeat(PLAN_MAX_BYTES)}\n`, "utf8"); // > 2MiB

  const mcpShellConfig = path.join(root, "pi-shell-mcp.json");
  fs.writeFileSync(mcpShellConfig, JSON.stringify({ default: [], rules: [] }, null, 2), "utf8");
  const commandsFile = path.join(root, "fake-commands.json");
  fs.writeFileSync(commandsFile, JSON.stringify({ commands: [{ name: "help", description: "帮助", source: "extension" }] }), "utf8");

  return {
    root,
    agentDir,
    home,
    project,
    plansInProject,
    plansInAgent,
    plansLegacy,
    projectPlan,
    agentPlan,
    legacyPlan,
    outsidePlan,
    commandsFile,
    logFile: path.join(root, "logs", "bridge.log"),
    promptLog: path.join(root, "fake-prompts.log"),
    mcpShellConfig,
    sessionsDir,
  };
}

const api = async (pathname, { method = "GET", body } = {}) => {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
};

const readLog = () => {
  try {
    return fs.readFileSync(fixture.logFile, "utf8");
  } catch {
    return "";
  }
};

const readPrompts = () => {
  try {
    return fs
      .readFileSync(fixture.promptLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

test.before(async () => {
  fixture = buildFixture();
  PORT = await freePort();
  child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: fixture.project,
    env: {
      ...process.env,
      PI_SHELL_PORT: String(PORT),
      PI_SHELL_AGENT_DIR: fixture.agentDir,
      PI_SHELL_SESSIONS_DIR: fixture.sessionsDir,
      PI_SHELL_AGENT_SESSIONS_DIR: "",
      PI_SHELL_MCP_CONFIG: fixture.mcpShellConfig,
      PI_SHELL_ORIGINS_FILE: path.join(fixture.root, "sessions-origins.json"),
      PI_SHELL_LOG_DIR: path.join(fixture.root, "logs"),
      PI_SHELL_LOG_FILE: fixture.logFile,
      PI_SHELL_CWD: fixture.project, // engine.cwd = 夹具工作区
      PI_SHELL_MAX_ENGINES: "4",
      PI_SHELL_IDLE_MS: "600000",
      PI_SHELL_PI_BIN: "",
      HOME: fixture.home,
      USERPROFILE: fixture.home, // os.homedir() → 夹具 home（~/.claude/plans 白名单用它）
      FAKE_PROMPT_LOG: fixture.promptLog,
      FAKE_COMMANDS_FILE: fixture.commandsFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", () => {});
  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderrText.length < 4000) stderrText += chunk;
  });

  const ready = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      const json = await res.json();
      return { ok: json?.pi?.state === "idle", state: json?.pi?.state };
    } catch {
      return { ok: false, state: "unreachable" };
    }
  }, { ms: 30000 });
  assert.ok(ready.ok, `桥未就绪 state=${ready.state}${stderrText ? `：${stderrText.slice(0, 500)}` : ""}`);

  // Windows 上用目录 junction 模拟「符号链接逃逸」（不需要管理员权限）
  try {
    outsideJunction = path.join(fixture.project, "link-out");
    fs.symlinkSync(path.dirname(fixture.outsidePlan), outsideJunction, "junction");
  } catch {
    outsideJunction = null;
  }
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (fixture?.root) await fsp.rm(fixture.root, { recursive: true, force: true }).catch(() => {});
});

test("GET /api/plan：正常读取（相对/绝对/三处白名单）+ title + 不存在", { timeout: 60000 }, async () => {
  // 1) 相对路径（按 engine.cwd 解析）
  const rel = await api(`/api/plan?path=${encodeURIComponent(".pi/plans/x.md")}`);
  assert.equal(rel.status, 200, `相对路径应 200：${rel.text.slice(0, 300)}`);
  assert.equal(rel.json?.exists, true);
  assert.equal(rel.json?.title, "计划 X", "title 取首个 '# ' 标题");
  assert.match(rel.json?.content ?? "", /把 X 做出来/);
  assert.equal(rel.json?.relPath, ".pi/plans/x.md", "relPath 相对 cwd（正斜杠）");
  assert.equal(path.resolve(rel.json?.path ?? ""), path.resolve(fixture.projectPlan), "path 应为归一后的绝对路径");
  assert.equal(rel.json?.bytes, fs.statSync(fixture.projectPlan).size);
  assert.equal(typeof rel.json?.mtimeMs, "number");

  // 2) 绝对路径 + <agentDir>/plans 白名单 + 无标题时回退文件名
  const abs = await api(`/api/plan?path=${encodeURIComponent(fixture.agentPlan)}`);
  assert.equal(abs.status, 200, `绝对路径（agent plans）应 200：${abs.text.slice(0, 300)}`);
  assert.equal(abs.json?.exists, true);
  assert.equal(abs.json?.title, "y", "无 '# ' 标题 → 文件名去扩展名");
  assert.equal(abs.json?.relPath, null, "不在 cwd 子树 → relPath=null");

  // 3) ~/.claude/plans 白名单（兼容旧习惯路径）
  const legacy = await api(`/api/plan?path=${encodeURIComponent(fixture.legacyPlan)}`);
  assert.equal(legacy.status, 200, `~/.claude/plans 应 200：${legacy.text.slice(0, 300)}`);
  assert.equal(legacy.json?.title, "旧计划");

  // 4) 不存在 → 200 + exists:false（不是错误弹窗）
  const missing = await api(`/api/plan?path=${encodeURIComponent(".pi/plans/none.md")}`);
  assert.equal(missing.status, 200, `不存在应 200：${missing.text.slice(0, 300)}`);
  assert.equal(missing.json?.exists, false);
  assert.equal(missing.json?.relPath, ".pi/plans/none.md");
  assert.equal(missing.json?.content, undefined);
});

test("GET /api/plan：越界 / 非法扩展名 → 403，>2MiB → 413", { timeout: 60000 }, async () => {
  // 5) 越界：路径穿越（含扩展名白名单外）
  const traversal = await api(`/api/plan?path=${encodeURIComponent("../../etc/passwd")}`);
  assert.equal(traversal.status, 403, `穿越路径应 403：${traversal.text.slice(0, 300)}`);
  assert.equal(traversal.json?.error?.code, "PLAN_PATH_FORBIDDEN");

  // 6) 越界：不在白名单内的 .md（扩展名合法，靠白名单挡）
  const escaped = await api(`/api/plan?path=${encodeURIComponent("../outside/secret.md")}`);
  assert.equal(escaped.status, 403, `白名单外 .md 应 403：${escaped.text.slice(0, 300)}`);
  assert.equal(escaped.json?.error?.code, "PLAN_PATH_FORBIDDEN");

  // 7) 越界：junction 指向 cwd 外（realpath 归一后判白名单）
  if (outsideJunction) {
    const viaLink = await api(`/api/plan?path=${encodeURIComponent("link-out/secret.md")}`);
    assert.equal(viaLink.status, 403, `junction 逃逸应 403：${viaLink.text.slice(0, 300)}`);
    assert.equal(viaLink.json?.error?.code, "PLAN_PATH_FORBIDDEN");
  } else {
    console.log("[report] 跳过 junction 逃逸断言（当前环境无法创建 junction）");
  }

  // 8) 非法扩展名
  const badExt = await api(`/api/plan?path=${encodeURIComponent(".pi/plans/evil.json")}`);
  assert.equal(badExt.status, 403, `.json 应 403：${badExt.text.slice(0, 300)}`);
  assert.equal(badExt.json?.error?.code, "PLAN_PATH_FORBIDDEN");

  // 9) 超过 2 MiB
  const big = await api(`/api/plan?path=${encodeURIComponent(".pi/plans/big.md")}`);
  assert.equal(big.status, 413, `>2MiB 应 413：${big.text.slice(0, 300)}`);
  assert.equal(big.json?.error?.code, "PLAN_TOO_LARGE");
});

test("POST /api/prompt：/plan 改写（触发条件 / 内容 / 幂等）", { timeout: 60000 }, async () => {
  const lastPrompt = () => readPrompts().at(-1)?.message ?? null;

  // 1) "/plan 做个 X" → 指令块 + cwd + PLAN_READY 标记 + 用户请求
  const withArg = await api("/api/prompt", { method: "POST", body: { message: "/plan 做个 X" } });
  assert.equal(withArg.status, 200, `prompt 应 200：${withArg.text.slice(0, 300)}`);
  const text1 = lastPrompt();
  assert.ok(text1?.startsWith("[pi-shell 计划阶段]"), `改写文本应以指令块开头：${String(text1).slice(0, 120)}`);
  assert.match(text1, /PLAN_READY: \.pi\/plans\/<slug>\.md/, "应含 PLAN_READY 标记协议");
  assert.ok(text1.includes(path.join(path.resolve(fixture.project), ".pi", "plans")), "应含真实 cwd 下的计划目录");
  assert.ok(text1.trimEnd().endsWith("用户请求：做个 X"), `末尾应为用户请求：做个 X（实际尾部：${String(text1).split("\n").at(-1)}）`);
  assert.equal(/^\/plan\b/m.test(text1), false, "改写后不应以 /plan 开头（防二次改写）");

  // 2) 纯 "/plan" → 占位文案
  const bare = await api("/api/prompt", { method: "POST", body: { message: "/plan" } });
  assert.equal(bare.status, 200);
  const text2 = lastPrompt();
  assert.ok(text2?.startsWith("[pi-shell 计划阶段]"), "纯 /plan 也应改写");
  assert.ok(text2.trimEnd().endsWith("用户请求：（用户未指定，先问我想要什么）"), `纯 /plan 应填占位：${String(text2).split("\n").at(-1)}`);

  // 3) "/plan做X"（无空格）→ 不改写，逐字节一致
  const noSpace = await api("/api/prompt", { method: "POST", body: { message: "/plan做X" } });
  assert.equal(noSpace.status, 200);
  assert.equal(lastPrompt(), "/plan做X", "无空格不应识别为 /plan");

  // 4) 普通消息 → 不改写
  const plain = await api("/api/prompt", { method: "POST", body: { message: "普通消息" } });
  assert.equal(plain.status, 200);
  assert.equal(lastPrompt(), "普通消息", "普通消息必须逐字节等价");

  // 5) 幂等：把改写结果原样再发一次 → 不再识别（文本一字不改）
  const again = await api("/api/prompt", { method: "POST", body: { message: text1 } });
  assert.equal(again.status, 200);
  assert.equal(lastPrompt(), text1, "改写结果不得被二次改写");

  // 6) 日志：只有两次改写（/plan 与 /plan 做个 X）
  const logText = readLog();
  const rewrites = logText.split("\n").filter((line) => line.includes("|info|prompt_rewritten|"));
  assert.equal(rewrites.length, 2, `prompt_rewritten 应只出现 2 次（实际 ${rewrites.length}）`);
  assert.ok(rewrites.every((line) => line.includes("kind=plan")), `日志应带 kind=plan：${rewrites.join(" | ")}`);
});

test("GET /api/commands：追加内置 plan（pi 侧有同名则不重复）", { timeout: 60000 }, async () => {
  // 1) pi 侧无 plan → 追加在末尾，source=builtin
  const first = await api("/api/commands");
  assert.equal(first.status, 200, `commands 应 200：${first.text.slice(0, 300)}`);
  const commands = first.json?.commands ?? [];
  assert.equal(commands.length, 2, `应返回 pi 的 1 条 + 内置 plan（实际 ${commands.length}）`);
  assert.equal(commands[0]?.name, "help", "pi 返回项顺序不变");
  assert.deepEqual(commands[1], { name: "plan", description: "只做计划，不改文件（pi-shell 内置）", source: "builtin" });

  // 2) pi 侧已有同名 plan → 不重复追加
  fs.writeFileSync(
    fixture.commandsFile,
    JSON.stringify({ commands: [{ name: "plan", description: "pi 自带", source: "prompt" }, { name: "help", description: "帮助", source: "extension" }] }),
    "utf8",
  );
  const second = await api("/api/commands");
  assert.equal(second.status, 200);
  const names = (second.json?.commands ?? []).map((cmd) => cmd.name);
  assert.deepEqual(names, ["plan", "help"], `已有同名 plan 时不得追加（实际：${names.join(",")}）`);
  assert.equal((second.json?.commands ?? []).filter((cmd) => cmd.name === "plan").length, 1, "plan 只能出现一次");
  assert.equal(second.json?.commands?.[0]?.source, "prompt", "pi 侧 plan 原样保留");
});