// pi-shell bridge · T-02（HTTP/静态/health/日志）+ T-03（pi 子进程与状态）+ T-05（SSE/prompt/abort）
// 范围：绑 127.0.0.1:7788、静态文件（仅 web/，禁目录列表、路径穿越 403/404）、CSP 响应头（03 §11）、
//       GET /api/health、GET /api/events（SSE）、POST /api/prompt、POST /api/abort、
//       POST /api/restart（第四批：exit(75) 让启动脚本重启）、
//       日志（stderr + logs/bridge.log，N2 起按大小轮转，见 log.mjs）、pi 子进程生命周期与状态归并。
// 不在本任务内：clear_queue、扩展 UI 桥、/api/sessions 系列（M1）。

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpc, resolvePiInstall } from "./rpc.mjs";
import { SessionIndex, readSessionEntries } from "./sessions.mjs";
import { deleteSessionFile } from "./session-delete.mjs";
import { OriginStore, ToolWindowTracker, classifyOrigin, ORIGINS_FILE_NAME } from "./origins.mjs";
import { SessionMemoryStore, SESSION_MEMORY_MAX, resolveLastSessionsFile } from "./session-memory.mjs";
import { WorkspaceFiles } from "./files.mjs";
import { GitReadOnly } from "./git.mjs";
import { TurnChanges } from "./turn-changes.mjs";
import {
  Engine,
  EnginePool,
  DEFAULT_CLIENT,
  DEFAULT_ADOPT_GRACE_MS,
  resolveMaxEngines,
  resolveIdleMs,
} from "./engines.mjs";
import { SseTail, DEFAULT_MAX_BYTES } from "./sse-tail.mjs";
import {
  createMcpShim,
  listAvailableServers,
  loadShellMcpConfig,
  resolveMcpServers,
  shellMcpConfigPath,
  validateShellMcpConfig,
  writeShellMcpConfig,
} from "./mcp-config.mjs";
import { annotateModels, getModelsConfig, invalidateModelsConfig } from "./models-config.mjs";
import { resolveBind, bindBannerLines, bindHosts } from "./bind.mjs";
import { appendWithRotation, resolveLogLimits, rotateIfNeededAsync, DEFAULT_ROTATE_FILES } from "./log.mjs";
import { resolveProjectDir, sameProjectDir } from "./project-dir.mjs";
import { buildSessionView, pickReadEngine, pickSessionEngine } from "./session-view.mjs";
import { createProcessSnapshotProvider, createSessionTitleReader } from "./engine-stats.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, "..");
const PROJECT_ROOT = path.resolve(BRIDGE_ROOT, "..");
const WEB_ROOT = path.resolve(PROJECT_ROOT, "web");
// N2：日志目录可用 PI_SHELL_LOG_DIR 覆盖（测试/证据脚本隔离用；默认 <project>/logs）
const LOG_DIR = path.resolve(process.env.PI_SHELL_LOG_DIR || path.join(PROJECT_ROOT, "logs"));
// B-12：删除的会话先移到仓库内 backups/deleted-sessions/（可撤销），不直接 unlink
const DELETED_BACKUP_ROOT = path.resolve(PROJECT_ROOT, "backups", "deleted-sessions");
const LOG_FILE = process.env.PI_SHELL_LOG_FILE ? path.resolve(process.env.PI_SHELL_LOG_FILE) : path.join(LOG_DIR, "bridge.log");
// N2：默认 5MB × 保留 5 份；PI_SHELL_LOG_MAX_MB / PI_SHELL_LOG_KEEP 覆盖（非法值回落默认）
const LOG_LIMITS = resolveLogLimits(process.env);
// 03 §3：PI_SHELL_AGENT_DIR（仅测试用隔离）；同时作为子进程的 PI_CODING_AGENT_DIR
const AGENT_DIR = path.resolve(process.env.PI_SHELL_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
// 03 §3：非空时同时作为 --session-dir 与扫描根；为空时子进程用 pi 默认目录，
// 扫描根则取默认位置 <agentDir>/sessions（否则 M1 列表永远是空的）
const SESSIONS_DIR = process.env.PI_SHELL_SESSIONS_DIR ? path.resolve(process.env.PI_SHELL_SESSIONS_DIR) : "";
const SCAN_DIR = SESSIONS_DIR || path.join(AGENT_DIR, "sessions");
// 会话来源分类（user/agent/test）的 agent 会话根与 sidecar（桥自己维护，不写进 pi 的会话文件）。
// 隔离口径（与 03 §3 的「PI_SHELL_SESSIONS_DIR 仅测试用隔离」一致）：
// - PI_SHELL_SESSIONS_DIR 被覆盖时，不默认去扫真实 agent 会话根（否则测试会混进真实数据）；
//   PI_SHELL_AGENT_SESSIONS_DIR 显式给值时仍扫。
// - sidecar 默认落在会话根旁边（测试隔离时不污染真实 ~/.pi/agent/sessions-origins.json）。
const AGENT_SESSIONS_DIR = process.env.PI_SHELL_AGENT_SESSIONS_DIR
  ? path.resolve(process.env.PI_SHELL_AGENT_SESSIONS_DIR)
  : SESSIONS_DIR
    ? ""
    : path.join(AGENT_DIR, "sessions-agents");
const ORIGINS_FILE = path.resolve(
  process.env.PI_SHELL_ORIGINS_FILE ||
    (SESSIONS_DIR ? path.join(path.dirname(SESSIONS_DIR), ORIGINS_FILE_NAME) : path.join(AGENT_DIR, ORIGINS_FILE_NAME)),
);

// N-01 / C-01：默认仍只绑回环。PI_SHELL_BIND 可选 tailscale / 显式 IP（手机 Tailscale 访问）；
// 0.0.0.0 / :: 默认拒绝启动，除非 PI_SHELL_ALLOW_LAN=1（见 docs/RUNBOOK.md「手机访问（Tailscale）」）。
const BIND = resolveBind({ value: process.env.PI_SHELL_BIND, allowLan: process.env.PI_SHELL_ALLOW_LAN });
const HOST = BIND.host;
// 实际监听的地址：Tailscale 模式是双栈（127.0.0.1 + 100.x），其余单地址。
// 两个 http server 共享同一个 handler，路由/SSE 行为完全一致。
const HOSTS = bindHosts(BIND);
const PORT_RAW = process.env.PI_SHELL_PORT ?? "7788";
const PORT = Number.parseInt(PORT_RAW, 10);

// 03 §3：工作区默认用户主目录（~），取 PI_SHELL_CWD 的解析值（不是 process.cwd()）
// 第三批：工作区从「桥级全局变量」变成「引擎级状态」——每个标签页可以各自切工作区。
const INITIAL_CWD = path.resolve(process.env.PI_SHELL_CWD || os.homedir());
// 并行上限（PI_SHELL_MAX_ENGINES，默认 4）；超限 → 503 PI_NOT_READY
const MAX_ENGINES = resolveMaxEngines(process.env.PI_SHELL_MAX_ENGINES);
// 空闲回收阈值（S1：PI_SHELL_IDLE_MS 可调，默认 60000 不变；证据脚本用小窗口跑得快）
const IDLE_MS = resolveIdleMs(process.env.PI_SHELL_IDLE_MS);
// 孤儿接管的静默门槛（S3：PI_SHELL_ADOPT_GRACE_MS 可调，默认 30000 不变；证据脚本用小窗口跑得快）
const ADOPT_GRACE_MS = resolveAdoptGraceMs(process.env.PI_SHELL_ADOPT_GRACE_MS);
// 引擎模型透传（bg-continue）：桥起 pi 时显式带 --provider/--model，避免沿用 settings.json 的默认模型。
// 两个都未设（空串）→ 参数列表不变（旧行为）。桥绝不读/改 settings.json，也不改用户全局默认模型。
const ENGINE_PROVIDER = (process.env.PI_SHELL_PROVIDER || "").trim();
const ENGINE_MODEL = (process.env.PI_SHELL_MODEL || "").trim();
// MCP 按需：默认不带任何 server（引擎 ≈90MB 而不是 ≈500MB）。名单来自
// `<agentDir>/pi-shell-mcp.json`（PI_SHELL_MCP_CONFIG 可覆盖）：default 名单 + 按 cwd 的规则；
// 用户在某列手动勾选后以手动为准。选中集非空时不能直接 `--no-mcp`（那是全禁），
// 改为给该引擎生成临时 agentDir（只含选中的 mcp.json），见 mcp-config.mjs 顶部说明。
const MCP_CONFIG_PATH = shellMcpConfigPath(AGENT_DIR);
let mcpShell = loadShellMcpConfig(MCP_CONFIG_PATH);

/** 读一次配置并记日志（log 定义在下面，所以实际调用放到 PI 解析之后） */
function reportMcpShell() {
  if (mcpShell.error) log("warn", "mcp_config_invalid", { path: MCP_CONFIG_PATH, reason: mcpShell.error });
  log("info", "mcp_config_loaded", {
    path: MCP_CONFIG_PATH,
    exists: mcpShell.exists,
    default: mcpShell.config.default,
    rules: mcpShell.config.rules.length,
  });
}

function reloadMcpShell() {
  mcpShell = loadShellMcpConfig(MCP_CONFIG_PATH);
  return mcpShell;
}

if (/\.[Cc][Mm][Dd]$|\.[Bb][Aa][Tt]$/.test(process.env.PI_SHELL_PI_BIN || "")) {
  process.stderr.write("PI_SHELL_PI_BIN 不支持 .cmd/.bat：请指向 cli.js 的绝对路径，或留空自动解析（见 03 §3 / 04 R-02）\n");
  process.exit(1);
}

// 03 §11.3：CSP 经响应头下发
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

// ---------- 日志（N-07：不含正文与密钥；轮转留到 T-14）----------

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\btvly-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
];

function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

// H-15：Windows 上 process.stderr 指向**管道**时写入是同步的；读取端不消费会阻塞事件循环 → 桥假死。
// 约束：仅当 stderr 是 TTY（真实终端）才镜像到 stderr；否则只写文件日志（stdout 始终留给协议数据）。
let stderrMirrored = 0;
let stderrSkipped = 0;

function log(level, event, fields) {
  const kv = fields
    ? Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${redact(typeof v === "string" ? v : JSON.stringify(v))}`)
        .join(" ")
    : "";
  const line = `${new Date().toISOString()}|${level}|${event}${kv ? "|" + kv : ""}`;
  // N2：写入前检查大小，超上限先轮转（轮转失败也继续写，不拦桥）
  appendWithRotation(LOG_FILE, line, { maxMB: LOG_LIMITS.maxMB, keep: LOG_LIMITS.keep });
  if (process.stderr.isTTY) {
    try {
      process.stderr.write(line + "\n");
      stderrMirrored += 1;
    } catch {
      stderrSkipped += 1;
    }
  } else {
    stderrSkipped += 1; // 非 TTY（管道/重定向）：不写 stderr，避免同步写阻塞
  }
}

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  process.stderr.write(`无法创建日志目录 ${LOG_DIR}: ${err?.message}\n`);
}

// N2：启动时把 logs/ 下其它日志（launcher / notify / mcp）按同一套参数整理一次。
// setImmediate + 异步 fs：不挡启动；单文件失败只记 warn。
setImmediate(() => {
  void (async () => {
    const files = DEFAULT_ROTATE_FILES.map((name) => path.join(LOG_DIR, name)).filter(
      (file) => path.resolve(file) !== path.resolve(LOG_FILE), // 正在写的文件由写入路径轮转，避免双写竞态
    );
    let rotated = 0;
    for (const file of files) {
      const result = await rotateIfNeededAsync(file, LOG_LIMITS.maxMB, LOG_LIMITS.keep);
      if (result.action === "error") {
        log("warn", "log_rotate_failed", { file: path.basename(file), reason: result.error });
        continue;
      }
      if (result.rotated) {
        rotated += 1;
        log("info", "log_rotated", {
          file: path.basename(file),
          to: path.basename(result.to),
          bytes: result.size,
          keep: result.keep,
        });
      }
    }
    if (rotated) {
      log("info", "log_rotate_scan", {
        dir: LOG_DIR,
        files: files.length,
        rotated,
        maxMB: LOG_LIMITS.maxMB,
        keep: LOG_LIMITS.keep,
      });
    }
  })().catch((err) => {
    log("warn", "log_rotate_scan_failed", { reason: err?.message || String(err) });
  });
});

// ---------- 工具执行窗口（来源分类的输入）----------
// 必须在 createRpc 之前声明：record 事件的处理器会往这里写窗口。
const toolWindows = new ToolWindowTracker({ log });
// 证据脚本用：启动期注入固定窗口（不经真实工具调用，避免创建任何真实会话）
if (process.env.PI_SHELL_ORIGIN_TEST_WINDOWS) {
  try {
    const seeded = JSON.parse(process.env.PI_SHELL_ORIGIN_TEST_WINDOWS);
    if (Array.isArray(seeded)) toolWindows.seed(seeded);
  } catch (err) {
    log("warn", "origin_test_windows_bad_json", { reason: err?.message });
  }
}

// ---------- pi 安装解析 + 子进程（T-03）----------

let PI = null;
try {
  PI = resolvePiInstall({ agentDir: AGENT_DIR });
  log("info", "pi_version_resolved", { version: PI.version, agentDir: AGENT_DIR, cli: PI.cliPath });
  reportMcpShell();
} catch (err) {
  log("error", "pi_version_unresolved", { agentDir: AGENT_DIR, reason: err?.code || err?.message });
}

/**
 * S1（bg-continue）：把 pi 的状态变化同步到引擎池的生命周期上。
 *   - streaming（agent_start / disposition / get_state）→ 记本轮起点，池里不再按空闲回收；
 *   - idle（含 agent_settled）→ 清 pin 起点 + touch：再 linger 一个 idleMs 才回收。
 * 其它状态（starting / stopping / crashed / failed）不动：回收只看 state/sse/心跳。
 */
function noteEngineState(engine, to) {
  if (to === "streaming") return engine.noteStreaming();
  if (to === "idle") return engine.noteSettled();
  return engine;
}

/** 建一个 PiRpc 并接好事件（工作区切换会重建，所以必须是函数）；engine = 这条 pi 的归属 */
function createRpc(engine, cwd) {
  if (!PI) return null;
  const instance = new PiRpc({
    cliPath: PI.cliPath,
    agentDir: PI.agentDir,
    installDir: PI.installDir,
    workspaceCwd: cwd,
    sessionsDir: SESSIONS_DIR,
    extraArgs: process.env.PI_SHELL_EXTRA_ARGS || "",
    // 引擎级 MCP：空名单 → --no-mcp（全禁）；非空 → 用该引擎的临时 agentDir（只装选中的 server）
    noMcp: (engine.mcp ?? []).length === 0,
    agentDirOverride: engine.extra?.mcpDir || undefined,
    // 模型透传：空串 → rpc.args() 不加参数（行为不变）
    provider: ENGINE_PROVIDER,
    model: ENGINE_MODEL,
    log,
  });
  instance.on("state", ({ from, to, pid }) => {
    noteEngineState(engine, to); // S1：streaming 记起点 / idle 时 touch（pin 与 linger）
    log("info", "health_state_changed", { engine: engine.id, from, to, pid: pid ?? null });
    broadcast(engine, { type: "bridge_state", pi: piHealth(engine), from, to, session: sessionInfo(engine) });
  });
  instance.on("record", (record) => {
    log("info", "pi_record", { engine: engine.id, type: record?.type }); // 只记类型，不记内容（N-07）
    instance.noteEvent(record); // 状态归并先于广播，页面/health 口径一致
    toolWindows.note(record); // 来源分类：记录工具执行窗口（start/end）
    turnChanges.note(engine, record); // PIX-4：本轮改动的文件快照（write/edit 类工具）
    if (record?.type === "extension_ui_request" && EXT_DIALOG_METHODS.has(record.method)) {
      engine.extra.pendingExtDialogs?.set(record.id, { at: Date.now(), method: record.method });
    }
    const frame = broadcast(engine, record);
    // S2b 落盘点：message_end 已进 entries（pi:dist/core/agent-session.js:768-781）→ 尾巴清空，
    // baseSeq = 该帧 seq；之后的回放只覆盖「还没落盘的那部分」，已落盘内容由 entries 渲染。
    if (record?.type === "message_end" && frame) sseTailOf(engine).reset(frame.seq);
  });
  return instance;
}

// ---------- 引擎池（第三批：每个浏览器标签页一个 pi 引擎）----------

/**
 * 给一条引擎装上 MCP 临时 agentDir（shim）：
 *   - 名单为空 → 清掉旧 shim，`--no-mcp` 由 createRpc 决定（最省）；
 *   - 名单非空 → 生成只含这些 server 的 mcp.json，子进程以 PI_CODING_AGENT_DIR 指过去。
 * 旧 shim 必须先删（Windows 上目录被占用时删不掉 → 只记 warn，不挡重启）。
 */
function applyMcpShim(engine) {
  const prev = engine.extra?.mcpDir ?? null;
  if (prev) {
    try {
      fs.rmSync(prev, { recursive: true, force: true });
    } catch (err) {
      log("warn", "mcp_shim_cleanup_failed", { engine: engine.id, dir: prev, reason: err?.code || err?.message });
    }
    engine.extra.mcpDir = null;
  }
  if (!PI || (engine.mcp ?? []).length === 0) return;
  try {
    const shim = createMcpShim({
      agentDir: PI.agentDir,
      servers: engine.mcp,
      client: engine.id,
      log,
    });
    engine.extra.mcpDir = shim.dir;
    engine.mcp = shim.servers; // 真实可用的交集（配置里写了不存在的 server 不算数）
    log("info", "mcp_shim_ready", { engine: engine.id, mcp: engine.mcp, dir: shim.dir });
  } catch (err) {
    // shim 建不出来 → 退化为「不带 MCP」（绝不误开全部 server：那才是 500MB 的来源）
    log("error", "mcp_shim_failed", { engine: engine.id, mcp: engine.mcp, reason: err?.code || err?.message });
    engine.extra.mcpDir = null;
    engine.mcp = [];
  }
}

/** 建一条引擎：extra 必须先于 rpc 存在（rpc 的事件回调会读 extra） */
function createEngine(clientId, { owner = clientId, pinned = false, start = true, mcp = null, cwd = INITIAL_CWD } = {}) {
  // mcp：显式数组（手动勾选/重启）> cwd 规则 > 配置 default（全空 = 不带 MCP）
  const desired = Array.isArray(mcp) ? mcp : resolveMcpServers({ cwd, config: mcpShell.config }).servers;
  const engine = new Engine({ id: clientId, owner, pinned, mcp: desired });
  engine.extra = {
    cwd,
    restarting: false,
    attachToken: 0,
    pendingExtDialogs: new Map(), // 该引擎的扩展对话框待回执
    sseClients: new Set(), // 绑在该引擎上的 SSE 连接
    noClientSince: 0,
    claim: null, // 已被该引擎打开（含正在接管）的会话文件
    mcpDir: null, // MCP shim 的临时 agentDir（空名单时 null）
  };
  applyMcpShim(engine);
  engine.rpc = createRpc(engine, engine.extra.cwd);
  if (start) engine.rpc?.start();
  return engine;
}

/** 删掉一条引擎的 MCP shim（临时 agentDir）：junction 只删链接，不动真实目录 */
function disposeMcpShim(engine) {
  const dir = engine?.extra?.mcpDir ?? null;
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log("info", "mcp_shim_removed", { engine: engine.id, dir });
  } catch (err) {
    log("warn", "mcp_shim_cleanup_failed", { engine: engine.id, dir, reason: err?.code || err?.message });
  }
  engine.extra.mcpDir = null;
}

const pool = new EnginePool({
  create: (clientId) => createEngine(clientId),
  max: MAX_ENGINES,
  idleMs: IDLE_MS,
  log,
  onRemove: (engine) => disposeMcpShim(engine),
});

// ---------- 重连恢复：桥侧记住「每个客户端最后打开的会话」----------
// 事故：页面离开 → 引擎被空闲回收（idle-sweep）→ 回来重连 → claimEngine 只按 INITIAL_CWD
// 起了个**空引擎 + 空会话**，页面却还显示旧历史 → AI 对之前内容一无所知，模型也退回默认。
//
// 本记录与**引擎生命周期解耦**：release / sweep **不清除**（清掉就等于把「用户的会话」
// 绑定在一条随时会被回收的 pi 进程上）。重连时用同一 clientId 重新认领 → 用原会话的 cwd
// 起引擎并 switch_session 回去（见 restoreEngineSession）。
// 只存元数据（路径 / cwd / 模型 / 思考级别），不读会话正文（N-07）。
//
// v1.0.0：记忆落盘成桥自己维护的 sidecar（不写 pi 的会话文件），**桥重启后第一次认领也能命中**。
// 隔离口径与 sessions-origins.json 一致：PI_SHELL_SESSIONS_DIR 覆盖时默认落在该夹具旁；
// PI_SHELL_LAST_SESSIONS_FILE 可显式指定（测试 / 证据脚本夹具）。
const LAST_SESSIONS_FILE = resolveLastSessionsFile({ agentDir: AGENT_DIR, sessionsDir: SESSIONS_DIR });
const lastSessionByClient = new SessionMemoryStore({ filePath: LAST_SESSIONS_FILE, max: SESSION_MEMORY_MAX, log }).loadSync();

/**
 * 记住「该客户端当前打开的会话」。只存元数据；`model/thinkingLevel` 缺省时沿用旧记录。
 * @returns {{path:string,cwd:string|null,model:object|null,thinkingLevel:string|null,at:number}|null}
 */
function rememberSession(clientId, sessionFile, state = null, cwd = null) {
  if (!clientId || typeof sessionFile !== "string" || !sessionFile) return null;
  const prev = lastSessionByClient.get(clientId) ?? null;
  const record = {
    path: path.resolve(sessionFile),
    cwd: typeof cwd === "string" && cwd ? path.resolve(cwd) : (prev?.cwd ?? null),
    model:
      state?.model && typeof state.model === "object"
        ? { provider: state.model.provider ?? null, id: state.model.id ?? null, name: state.model.name ?? null }
        : (prev?.model ?? null),
    thinkingLevel: typeof state?.thinkingLevel === "string" ? state.thinkingLevel : (prev?.thinkingLevel ?? null),
    at: Date.now(),
  };
  lastSessionByClient.set(clientId, record); // 上限（LRU）+ 去抖落盘在 store 内
  return record;
}

/** 用户显式进入「无会话文件」的状态（new_session / 切工作区）→ 不再拿旧会话去恢复 */
function forgetRememberedSession(clientId, reason = "") {
  if (!clientId) return false;
  const had = lastSessionByClient.delete(clientId);
  if (had) log("info", "session_memory_cleared", { client: clientId, reason });
  return had;
}

/** 按引擎最近一次 get_state 更新记忆（clientId = 引擎归属；引导引擎未认领时用池内 id） */
function noteSessionForEngine(engine, state = null, cwd = null) {
  const clientId = engine?.owner ?? engine?.id ?? null;
  if (!clientId) return null;
  const file = typeof state?.sessionFile === "string" && state.sessionFile ? state.sessionFile : null;
  if (!file) {
    forgetRememberedSession(clientId, "no-session-file");
    return null;
  }
  return rememberSession(clientId, file, state, cwd ?? engine.extra?.cwd ?? null);
}

/** 同步读会话 header 的 cwd（claimEngine 是同步路径：起引擎前要确定 cwd） */
function readSessionCwdSync(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    const header = JSON.parse(firstLine);
    return typeof header?.cwd === "string" ? header.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/** 恢复用的 cwd：记忆值 > 会话 header；目录已不存在 → null（不能拿不存在的 cwd 起子进程） */
function restoreCwdFor(memory) {
  if (!memory) return null;
  const raw = memory.cwd || (memory.path ? readSessionCwdSync(memory.path) : null);
  if (typeof raw !== "string" || !raw) return null;
  try {
    if (!fs.statSync(raw).isDirectory()) return null;
  } catch {
    return null;
  }
  return path.resolve(raw);
}

// N1-b：资源统计（RSS 全表快照 5s 缓存；会话标题按文件 mtime+size 缓存）
const rssProvider = createProcessSnapshotProvider({ log });
const sessionTitles = createSessionTitleReader({ log });

/** GET /api/engines/stats：一次返回所有引擎的资源行（前端「资源」面板） */
async function buildEngineStats() {
  const now = Date.now();
  const engines = pool.list();
  const rss = await rssProvider.rssByRoot(engines.map((engine) => engine.pid));
  const rows = await Promise.all(
    engines.map(async (engine) => {
      const sessionId = engine.sessionId;
      return {
        client: engine.owner ?? engine.id,
        id: engine.id,
        tab: engine.tab,
        state: engine.state,
        sessionId: sessionId ?? null,
        sessionTitle: await sessionTitles.title(engine.sessionFile, sessionId),
        mcp: [...engine.mcp],
        piPid: engine.pid,
        rssMB: rss.get(engine.pid) ?? null,
        idleSec: Math.max(0, Math.round((now - engine.lastSeenAt) / 1000)),
        pinned: !!engine.pinned,
        live: pool.isAlive(engine, now),
      };
    }),
  );
  const totalRssMB = Math.round(rows.reduce((sum, row) => sum + (row.rssMB ?? 0), 0) * 10) / 10;
  return { ok: true, at: now, engines: rows, count: rows.length, max: MAX_ENGINES, totalRssMB };
}

/** POST /api/engine/release {client}：用户主动释放一个引擎（资源面板「释放」） */
async function handleEngineRelease(req, res, headerClient) {
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
    return;
  }
  const target = typeof body.client === "string" && body.client.trim() ? body.client.trim() : headerClient;
  const engine = pool.find(target);
  if (!engine) {
    sendJson(res, 200, { ok: true, released: false, client: target, reason: "not_found" });
    return;
  }
  const sessionFile = engine.sessionFile ?? engine.claimedSessionFile ?? null;
  const pid = engine.pid;
  const released = await pool.release(engine, "user-release");
  log("info", "engine_release_user", { client: target, engine: engine.id, pid, sessionFile, released });
  sendJson(res, 200, { ok: true, released, client: target, pid, sessionFile, engineCount: pool.size });
}

// 桥退出时清掉所有 shim（进程被 kill 时 Windows 可能留目录，下次启动兜底）
process.on("exit", () => {
  for (const engine of pool.list()) disposeMcpShim(engine);
  // 会话记忆：exit 回调里不能 await，同步原子写一次，别丢最后 200ms 的刷新
  lastSessionByClient.flushSync();
});

// 引导引擎：与改造前一致——桥一启动就有 pi 在跑（既有脚本 waitHealth 等它到 idle）。
// 它没有归属、不参与空闲回收；第一个带标识的标签页认领它（见 claimEngine），不额外起进程。
// start:false —— 握手在 listen 之后启动（保留 health 的 not_started → starting → idle 序列）。
const bootstrapEngine = createEngine(DEFAULT_CLIENT, { owner: null, pinned: true, start: false });
pool.add(bootstrapEngine);

/** 全局端点的基准工作区：主引擎（default / 第一个）的 cwd，没有引擎时用初始值 */
function primaryCwd() {
  const primary = pool.get(DEFAULT_CLIENT) ?? pool.list()[0] ?? null;
  return primary?.extra?.cwd ?? INITIAL_CWD;
}

/** 主引擎（全局端点：models / commands / files / git diff 用） */
function primaryEngine() {
  return pool.get(DEFAULT_CLIENT) ?? pool.list()[0] ?? bootstrapEngine;
}

// ---------- 会话索引（T-06 / 03 §7）----------

// ---------- 来源分类（user / agent / test）----------
// 机制：新会话自动归类（不是给历史会话贴标签）。
// - sidecar（sessions-origins.json）已有记录 → 原样使用（可手改）
// - 文件在 AGENT_SESSIONS_DIR 下 → agent
// - header.timestamp 落在工具执行窗口 [start-2s, end+5s] → agent（PI AI 派生会话的机制指纹）
// - 探针路径 / 临时 cwd → test；其余 → user
const originStore = new OriginStore({ filePath: ORIGINS_FILE, log }).loadSync();

/** SessionIndex 的来源解析器：sidecar 优先 → classifyOrigin → 写回 sidecar */
function originForSession({ fileRelPath, filePath, cwd, createdAt }) {
  const manual = originStore.get(fileRelPath);
  const decided = classifyOrigin({
    fileRelPath,
    filePath,
    cwd,
    createdAt,
    sessionsRoot: SCAN_DIR,
    agentRoot: AGENT_SESSIONS_DIR,
    toolWindows: toolWindows.snapshot(),
    manual,
  });
  if (!manual && originStore.set(fileRelPath, decided)) originStore.scheduleFlush();
  return { origin: decided.origin, reason: manual ? manual.reason : decided.reason };
}

const sessionIndex = new SessionIndex({
  sessionsDir: SCAN_DIR,
  agentSessionsDir: AGENT_SESSIONS_DIR,
  originFor: originForSession,
  log,
});
const workspaceFiles = new WorkspaceFiles({ getRoot: () => primaryCwd() });
const gitReadOnly = new GitReadOnly({ getCwd: () => primaryCwd() });

// ---------- 扩展 UI 待回执登记（T-12）----------
// 规则（03 §16-7）：无 SSE 客户端持续 10s 时，对仍无回执的对话框 id 发 cancelled:true；
// 短暂刷新（<10s）不应触发。

const EXT_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const EXT_CANCEL_AFTER_MS = 10000;

const extSweep = setInterval(() => {
  const now = Date.now();
  for (const engine of pool.list()) {
    const pending = engine.extra.pendingExtDialogs;
    if (engine.sseCount() > 0) {
      engine.extra.noClientSince = now;
      continue;
    }
    if (!engine.extra.noClientSince) engine.extra.noClientSince = now;
    if (now - engine.extra.noClientSince < EXT_CANCEL_AFTER_MS) continue;
    for (const [id, info] of pending) {
      pending.delete(id);
      engine.rpc?.sendUiResponse(id, { cancelled: true });
      log("warn", "ext_ui_auto_cancelled", { engine: engine.id, id, method: info.method, waitedMs: now - info.at });
    }
  }
}, 2000);
extSweep.unref?.();

// 空闲引擎回收：无 SSE 连接 + 60s（PI_SHELL_IDLE_MS）无请求 → 关掉该引擎（关标签页后释放内存）
// S1：正在 streaming 的引擎不回收（关标签页也让这一轮跑完），只有超过 MAX_PIN_MS 才兜底强收。
const ENGINE_SWEEP_MS = 5000;
const engineSweep = setInterval(() => {
  try {
    const removed = pool.sweep();
    if (removed.length) log("info", "engine_swept", { ids: removed, remaining: pool.size });
  } catch (err) {
    log("warn", "engine_sweep_failed", { reason: err?.message });
  }
}, ENGINE_SWEEP_MS);
engineSweep.unref?.();

// ---------- SSE（03 §5 / T-05）----------
// 历史（已落盘的 entry）仍由 session/open + entries?since 补齐；这里只补**未落盘的尾巴**（S2b）：
//   - 每个引擎一份 SseTail + 自己的 seq 计数（跨引擎互不干扰 → 单引擎回放无空洞）；
//   - **只缓冲「本轮已在流式中」的内容帧**（没有客户端也要缓冲，否则断线期间的事件回来后断片）：
//     启动期/空闲期的帧、控制类帧一律不回放（历史回归：首屏把启动期的 setStatus 补给了新页面）；
//   - 数据帧带 `id: <seq>`，EventSource 断线自动重连会带 Last-Event-ID；
//   - message_end 是落盘点 → 该帧广播后清空缓冲、baseSeq = 该帧 seq（此后内容走 entries）；
//   - 会话身份变了（switch_session / new_session / 引擎重启）→ resetSseTail：
//     上一会话的未落盘帧绝不能补给新会话（S2b 风险 2）；
//   - adopt（孤儿接管）**不清尾巴**：接管前后是同一个会话文件，尾巴就是「这一轮还在后台跑」的内容，
//     清掉等于把「回到页面还能接着看」抹掉（bgUi A8）；上面三条已经把「尾巴必属于当前会话」这条不变量守住了。
//   - 连接时先发 `resume` 控制帧（{from,to,truncated}），再按 seq 回放，最后发 bridge_state 快照。
// 15s 心跳注释行（: ping）防代理/浏览器空闲超时。

const SSE_HEARTBEAT_MS = 15000;
const sseClients = new Set(); // 全部连接（日志/关闭用）；按引擎分组在 engine.extra.sseClients
// 尾巴缓冲字节上限（设计 §5.2）：PI_SHELL_TAIL_MAX_BYTES 可覆盖，默认 2MB
const TAIL_MAX_BYTES = (() => {
  const raw = Number(process.env.PI_SHELL_TAIL_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
})();

/** 该引擎的尾巴缓冲（懒建，挂在 extra 上；引擎重启/切工作区不换 engine 对象，seq 与缓冲延续） */
function sseTailOf(engine) {
  const extra = engine.extra ?? (engine.extra = {});
  if (!extra.sseTail) extra.sseTail = new SseTail({ maxBytes: TAIL_MAX_BYTES });
  return extra.sseTail;
}

/**
 * 会话身份变了（switch_session / new_session / 引擎重启）→ 清空尾巴、落点 = 当前 seq。
 * 不清就会把上一会话「还没落盘」的帧补给新会话（S2b 风险 2）：内容串台、控制帧乱弹。
 * 注意：adopt 不走这里 —— 接管前后是同一个会话，尾巴就是本轮正在跑的内容（见文件头注释）。
 */
function resetSseTail(engine, reason) {
  if (!engine) return;
  const baseSeq = Number(engine.extra?.sseSeq ?? 0);
  sseTailOf(engine).reset(baseSeq);
  log("info", "sse_tail_reset", { engine: engine.id, reason, baseSeq });
}

/**
 * 控制类帧：不进尾巴缓冲（也就不会被回放）。
 * 理由：首屏/重连时重新回放「启动期的 setStatus/setWidget/notify、旧状态快照、旧接管回执」
 * 会把当时的一次性 UI 状态强加到新页面上（firstLoad B1/B4 回归：首屏冒出 ext-status 浮层）。
 * 这些帧在建立连接时本来就会重新生成（快照/回执），回放旧值只会更错。
 */
const CONTROL_FRAME_TYPES = new Set([
  "extension_ui_request", // setStatus / setWidget / notify 等扩展 UI 指令
  "bridge_state", // 状态快照：每次连接都会现发一帧新的
  "resync", // 「请前端重载」控制帧
  "session_attached", // 接管回执（只对当时那次请求有意义）
  "session_attach_failed",
]);

/**
 * 这一帧该不该进尾巴缓冲。两条缺一不可：
 *   1) 引擎当前在 streaming —— 本轮已经开始；启动期/回合结束后产生的帧不属于「未落盘的尾巴」；
 *   2) 不是控制类帧 —— 控制帧一旦回放就会污染新页面（见 CONTROL_FRAME_TYPES）。
 */
function shouldBufferFrame(engine, frame) {
  if (!engine || engine.state !== "streaming") return false;
  return !CONTROL_FRAME_TYPES.has(frame?.type);
}

/** 该引擎的下一个 SSE seq（单调递增；连接快照与广播共用同一计数器） */
function nextSseSeq(engine) {
  const extra = engine.extra ?? (engine.extra = {});
  extra.sseSeq = Number(extra.sseSeq ?? 0) + 1;
  return extra.sseSeq;
}

function sseWrite(res, payload) {
  try {
    const seq = Number(payload?.seq);
    const id = Number.isFinite(seq) ? `id: ${seq}\n` : ""; // EventSource 用 id 行填 Last-Event-ID
    res.write(`${id}data: ${JSON.stringify(payload)}\n\n`);
  } catch (err) {
    log("warn", "sse_write_failed", { reason: err?.code || err?.message });
  }
}

/**
 * 只播给「这条引擎自己的」SSE 连接（标签页互不串流）；帧里带 engine = 客户端标识。
 * 只有「本轮流式中的内容帧」进尾巴缓冲（见 shouldBufferFrame）——断线期间产生的内容靠它补齐；
 * 控制帧/启动期帧照样广播（在线客户端看得到），但**不入缓冲、重连不回放**。返回该帧（含 seq）。
 */
function broadcast(engine, payload) {
  if (!engine) return null;
  const seq = nextSseSeq(engine);
  const frame = { seq, engine: engine.owner ?? engine.id, ...payload };
  if (shouldBufferFrame(engine, frame)) sseTailOf(engine).push({ seq, payload: frame });
  const clients = engine?.extra?.sseClients;
  if (clients) for (const res of clients) sseWrite(res, frame);
  return frame;
}

// ---------- 本轮改动快照（PIX-4）----------
// 根目录在仓库内 backups/（.gitignore 已忽略），可用 PI_SHELL_TURN_SNAPSHOTS 覆盖（测试隔离）。
const TURN_SNAPSHOT_ROOT = path.resolve(
  process.env.PI_SHELL_TURN_SNAPSHOTS || path.join(PROJECT_ROOT, "backups", "turn-snapshots"),
);
const turnChanges = new TurnChanges({
  root: TURN_SNAPSHOT_ROOT,
  getCwd: (engine) => engine?.extra?.cwd ?? primaryCwd(),
  broadcast: (engine, payload) => broadcast(engine, payload),
  log,
});
// 启动清理：每个会话只留最近 20 轮（失败不影响启动）
turnChanges.cleanupAll().catch(() => {});

const heartbeat = setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(": ping\n\n");
    } catch {
      sseClients.delete(res);
    }
  }
}, SSE_HEARTBEAT_MS);
heartbeat.unref?.();

function sessionInfo(engine) {
  const st = engine?.rpc?.lastGetState ?? null;
  return {
    sessionId: st?.sessionId ?? null,
    model: st?.model ? { provider: st.model.provider, id: st.model.id, name: st.model.name ?? null } : null,
    thinkingLevel: st?.thinkingLevel ?? null,
  };
}

/** 一条引擎的 health.pi 形状（与改造前字段完全一致，多引擎只是重复了多份） */
function piHealth(engine) {
  const snap = engine?.rpc?.snapshot?.() ?? { pid: null, state: "failed" };
  return {
    version: PI?.version ?? null,
    pid: snap.pid,
    state: snap.state,
    cwd: engine?.extra?.cwd ?? INITIAL_CWD,
    mcp: [...(engine?.mcp ?? [])],
  };
}

// ---------- 响应辅助 ----------

function baseHeaders(extra) {
  return { "Content-Security-Policy": CSP, ...extra };
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(
    status,
    baseHeaders({ "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length }),
  );
  res.end(payload);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } }); // 03 §5：不透出堆栈
}

// 03 §5：错误码 ↔ HTTP 状态（7 项，一一对应）
const HTTP_STATUS = {
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PI_ERROR: 502,
  PI_NOT_READY: 503,
  TIMEOUT: 504,
};

function sendRpcError(res, err) {
  const code = HTTP_STATUS[err?.code] ? err.code : "PI_ERROR";
  const message = err?.message || "pi 请求失败";
  log("warn", "api_error", { code, status: HTTP_STATUS[code], reason: message });
  sendError(res, HTTP_STATUS[code], code, message);
}

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 与 JSONL 单行上限同量级；文件注入上限 200KB 由前端保证

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("请求体过大"), { code: "BAD_REQUEST" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (err) => reject(Object.assign(err, { code: "BAD_REQUEST" })));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return reject(Object.assign(new Error("请求体必须是 JSON 对象"), { code: "BAD_REQUEST" }));
        }
        resolve(value);
      } catch {
        reject(Object.assign(new Error("请求体不是合法 JSON"), { code: "BAD_REQUEST" }));
      }
    });
  });
}

function sendText(res, status, text) {
  const payload = Buffer.from(text, "utf8");
  res.writeHead(
    status,
    baseHeaders({ "Content-Type": "text/plain; charset=utf-8", "Content-Length": payload.length }),
  );
  res.end(payload);
}

// ---------- /api/health（03 §5）----------
// 向后兼容：pi.* 仍是「主引擎」的快照（带 client 标识时优先该标签页自己的引擎）；
// 新增 engines/engineCount/maxEngines，供前端/验收脚本看并行现状。

function healthBody(clientId) {
  const self = clientId ? pool.find(clientId) : null;
  const primary = self ?? pool.get(DEFAULT_CLIENT) ?? pool.list()[0] ?? bootstrapEngine;
  return {
    ok: true,
    // 向后兼容：字符串形式（默认 "127.0.0.1"；Tailscale 时 "127.0.0.1,100.x.y.z"）。
    // 新字段：hosts 数组 + bindKind，便于 UI/脚本判定双栈。
    bind: HOSTS.join(","),
    hosts: HOSTS,
    bindKind: BIND.kind,
    pi: piHealth(primary),
    engines: pool.list().map((engine) => engine.health()),
    engineCount: pool.size,
    maxEngines: MAX_ENGINES,
    mcp: {
      default: [...mcpShell.config.default],
      rules: mcpShell.config.rules.length,
      configPath: MCP_CONFIG_PATH,
    },
  };
}

// ---------- 静态文件（仅 web/；禁目录列表；穿越 403）----------

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "malformed path");
    return;
  }
  if (rel.includes("\0")) {
    sendError(res, 400, "BAD_REQUEST", "malformed path");
    return;
  }

  const requested = rel.replace(/^\/+/, "");
  const resolved =
    requested === "" ? path.join(WEB_ROOT, "index.html") : path.resolve(WEB_ROOT, requested);

  // 越界（含 ..、绝对路径、盘符）一律不放行
  if (resolved !== WEB_ROOT && !resolved.startsWith(WEB_ROOT + path.sep)) {
    log("warn", "static_forbidden", { path: pathname });
    sendError(res, 403, "FORBIDDEN", "path outside web root");
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      sendError(res, 404, "NOT_FOUND", "no such file");
      return;
    }
    log("error", "static_stat_failed", { reason: err?.code || err?.message });
    sendError(res, 500, "PI_ERROR", "static read failed");
    return;
  }

  // 符号链接 / junction 逃逸：解析后的真实路径必须仍在 web/ 内
  let realPath;
  let realRoot;
  try {
    realPath = await fsp.realpath(resolved);
    realRoot = await fsp.realpath(WEB_ROOT);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      sendError(res, 404, "NOT_FOUND", "no such file");
      return;
    }
    log("error", "static_realpath_failed", { reason: err?.code || err?.message });
    sendError(res, 500, "PI_ERROR", "static read failed");
    return;
  }
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    log("warn", "static_forbidden", { path: pathname, reason: "symlink escape" });
    sendError(res, 403, "FORBIDDEN", "path outside web root");
    return;
  }

  if (stat.isDirectory()) {
    // 禁止目录列表：仅根目录回落到 index.html
    if (resolved === WEB_ROOT) {
      await sendFile(res, path.join(WEB_ROOT, "index.html"));
      return;
    }
    sendError(res, 404, "NOT_FOUND", "no such file");
    return;
  }

  await sendFile(res, resolved, stat);
}

async function sendFile(res, filePath, stat) {
  let data;
  try {
    data = await fsp.readFile(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      sendError(res, 404, "NOT_FOUND", "no such file");
      return;
    }
    log("error", "static_read_failed", { reason: err?.code || err?.message });
    sendError(res, 500, "PI_ERROR", "static read failed");
    return;
  }
  const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, baseHeaders({ "Content-Type": type, "Content-Length": data.length }));
  if (res.req?.method === "HEAD") {
    res.end();
    return;
  }
  res.end(data);
}

// ---------- /api/events（SSE）----------

/** 回放起点：?since= 优先，其次 EventSource 自动带的 Last-Event-ID；都没有 → undefined（只回放未落盘尾巴） */
function readSinceSeq(req) {
  const candidates = [];
  try {
    candidates.push(new URL(req.url || "/", `http://${HOST}:${PORT}`).searchParams.get("since"));
  } catch {
    candidates.push(null);
  }
  candidates.push(req.headers?.["last-event-id"]);
  for (const raw of candidates) {
    if (raw === null || raw === undefined || raw === "") continue;
    const seq = Number(raw);
    if (Number.isFinite(seq) && seq >= 0) return seq;
  }
  return undefined;
}

function openEventStream(req, res, engine) {
  if (!engine) {
    sendError(res, 503, "PI_NOT_READY", "pi 引擎不可用");
    return;
  }
  res.writeHead(
    200,
    baseHeaders({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    }),
  );
  res.flushHeaders?.();
  res.write("retry: 1000\n\n");
  res.write(": connected\n\n");
  engine.extra.sseClients.add(res);
  sseClients.add(res);
  engine.touch();
  engine.extra.noClientSince = 0;

  // S2b：先 resume（控制帧，无 id、不进回放窗口）再回放，二者都同步写完，不与新广播交错
  const since = readSinceSeq(req);
  const tail = sseTailOf(engine);
  const window = tail.since(since);
  sseWrite(res, {
    type: "resume",
    engine: engine.owner ?? engine.id,
    from: window.from,
    to: window.to,
    truncated: window.truncated,
  });
  for (const buffered of window.frames) sseWrite(res, buffered.payload);
  if (window.frames.length > 0) {
    log("info", "sse_replay", {
      engine: engine.id,
      since: since ?? null,
      from: window.from,
      to: window.to,
      frames: window.frames.length,
      truncated: window.truncated,
    });
  }

  // 连接时再发一帧快照：页面初始化即可拿到当前 state/session/model（不改 HTTP 契约，仅 SSE 帧）
  // 放在回放之后：seq 比回放帧新，客户端顺序应用不会回退状态。
  const snapshot = {
    seq: nextSseSeq(engine),
    engine: engine.owner ?? engine.id,
    type: "bridge_state",
    pi: piHealth(engine),
    from: null,
    to: engine.rpc?.state ?? "not_started",
    session: sessionInfo(engine),
  };
  // 快照不入缓冲：它是控制帧（每次连接现发），回放旧快照只会把过时状态补给下一页面
  sseWrite(res, snapshot);
  log("info", "sse_open", { engine: engine.id, clients: sseClients.size });

  const cleanup = () => {
    const dropped = engine.extra.sseClients.delete(res) || sseClients.delete(res);
    sseClients.delete(res);
    if (dropped) {
      engine.extra.noClientSince = Date.now();
      log("info", "sse_close", { engine: engine.id, clients: sseClients.size });
    }
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

// ---------- /api/sessions（T-06）----------

async function handleSessions(req, res, clientId) {
  let q = "";
  let include = new Set();
  try {
    const params = new URL(req.url || "/", `http://${HOST}:${PORT}`).searchParams;
    q = params.get("q") || "";
    include = new Set(
      String(params.get("include") || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    );
  } catch {
    q = "";
  }
  try {
    // attached 只认「调用方自己引擎」的当前会话（get_state.sessionId）；其余 unknown（项目定值）
    const caller = clientId ? pool.find(clientId) : null;
    const single = pool.list().length === 1 ? pool.list()[0] : null;
    const currentSessionId = (caller ?? single)?.sessionId ?? null;
    const result = await sessionIndex.list({ q, currentSessionId });
    // 默认不返回 test（测试/探针会话不污染列表）；?include=test 才返回
    if (!include.has("test")) {
      result.groups = result.groups
        .map((group) => {
          const sessions = group.sessions.filter((session) => session.origin !== "test");
          const origins = [...new Set(sessions.map((session) => session.origin))];
          return { ...group, origin: origins.length === 1 ? origins[0] : "mixed", sessions };
        })
        .filter((group) => group.sessions.length > 0);
      result.stats.dirs = result.groups.length;
    }
    await originStore.flush(); // 本轮新判定的记录立刻落盘（证据脚本会读 sidecar）
    sendJson(res, 200, result);
  } catch (err) {
    // 单个文件/目录读失败已在 list() 内降级为 warnings；到这里才是真异常
    log("error", "sessions_list_failed", { reason: err?.code || err?.message });
    sendError(res, 502, "PI_ERROR", "会话索引读取失败");
  }
}

// ---------- /api/session/fork · clone · tree（T-16）----------

/** fork/clone 之后：缓存失效 + 广播状态（列表能立刻看到新会话） */
function afterBranchChange(engine, sessionId, sessionFile) {
  sessionIndex.invalidate();
  engine.extra.claim = sessionFile ?? null;
  // fork/clone 出来的是新会话文件：记忆也跟着换（否着重连会切回分叉前的旧会话）
  noteSessionForEngine(engine, engine.rpc?.lastGetState ?? { sessionFile }, engine.extra.cwd);
  broadcast(engine, { type: "bridge_state", pi: piHealth(engine), from: null, to: engine.rpc?.state ?? "idle", session: sessionInfo(engine) });
  log("info", "session_branched", { engine: engine.id, sessionId: sessionId ?? null, file: sessionFile ?? null });
}

async function handleFork(engine, req, res) {
  const rpc = engine.rpc;
  if (!rpc) return sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
  }
  const entryId = body?.entryId;
  if (typeof entryId !== "string" || !entryId) return sendError(res, 400, "BAD_REQUEST", "entryId 必填");
  try {
    const data = await rpc.request("fork", { entryId });
    if (data?.cancelled === true) return sendJson(res, 200, { cancelled: true });
    const state = await rpc.request("get_state");
    rpc.noteGetState(state);
    afterBranchChange(engine, state?.sessionId, state?.sessionFile);
    sendJson(res, 200, { cancelled: false, text: data?.text ?? "", sessionId: state?.sessionId ?? null, sessionFile: state?.sessionFile ?? null });
  } catch (err) {
    sendRpcError(res, err);
  }
}

async function handleClone(engine, res) {
  const rpc = engine.rpc;
  if (!rpc) return sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
  try {
    const data = await rpc.request("clone");
    if (data?.cancelled === true) return sendJson(res, 200, { cancelled: true });
    const state = await rpc.request("get_state");
    rpc.noteGetState(state);
    afterBranchChange(engine, state?.sessionId, state?.sessionFile);
    sendJson(res, 200, { cancelled: false, sessionId: state?.sessionId ?? null, sessionFile: state?.sessionFile ?? null });
  } catch (err) {
    sendRpcError(res, err);
  }
}

async function handleTree(engine, res) {
  const rpc = engine.rpc;
  if (!rpc) return sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
  try {
    const data = await rpc.request("get_tree");
    sendJson(res, 200, { tree: data?.tree ?? [], leafId: data?.leafId ?? null }); // 直通
  } catch (err) {
    sendRpcError(res, err);
  }
}

// ---------- /api/turn-changes（PIX-4）：本轮改动的文件快照 ----------

/** GET /api/turn-changes?session=<id>&turn=<n>；turn 省略 = 当前/最近一轮 */
async function handleTurnChanges(req, res, clientId) {
  const sessionId = queryParam(req, "session") || null;
  const turnRaw = queryParam(req, "turn");
  const turn = /^\d+$/.test(turnRaw) ? Number.parseInt(turnRaw, 10) : null;
  // 只读端点：不新建引擎（没有引擎就没有内存态，磁盘 meta 仍可读）
  const engine = pool.find(clientId) ?? pool.get(DEFAULT_CLIENT) ?? pool.list()[0] ?? null;
  try {
    const data = await turnChanges.read({ engine, sessionId, turn });
    sendJson(res, 200, data);
  } catch (err) {
    log("warn", "turn_changes_read_failed", { reason: err?.message });
    sendError(res, 502, "PI_ERROR", err?.message || "读取本轮改动失败");
  }
}

// ---------- /api/git/diff（T-18）· /api/stats（T-19）----------

async function handleGitDiff(req, res) {
  // F-12：只允许对「桥工作区根」或「当前已附着会话文件的 cwd」取 diff，其余一律 403
  let cwd;
  try {
    cwd = await resolveDiffCwd(queryParam(req, "cwd"));
  } catch (err) {
    const code = HTTP_STATUS[err?.code] ? err.code : "BAD_REQUEST";
    log("warn", "git_diff_denied", { code, reason: err?.message });
    sendError(res, HTTP_STATUS[code], code, err?.message || "cwd 不合法");
    return;
  }
  try {
    const result = await gitReadOnly.diff(cwd);
    sendJson(res, 200, { ...result, cwd }); // 非 git 仓库 → {available:false}；cwd 为实际取 diff 的目录
  } catch (err) {
    // 5s 超时 → TIMEOUT（504），其它 → PI_ERROR（502）
    const code = err?.code === "TIMEOUT" ? "TIMEOUT" : err?.code && HTTP_STATUS[err.code] ? err.code : "PI_ERROR";
    sendError(res, HTTP_STATUS[code], code, err?.message || "git 读取失败");
  }
}

// Windows 下路径大小写不敏感（C:\Users 与 c:\users 是同一目录）
function samePath(a, b) {
  if (!a || !b) return false;
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 当前已附着会话文件的 cwd（读不到 / 无会话 → null）；多引擎时把每条都算上 */
async function attachedSessionCwds() {
  const out = [];
  for (const engine of pool.list()) {
    const file = engine.sessionFile;
    if (!file) continue;
    try {
      const cwd = await readSessionCwd(path.resolve(file));
      if (typeof cwd === "string" && cwd) out.push(path.resolve(cwd));
    } catch {}
  }
  return out;
}

/** 白名单：主引擎工作区或任一已附着会话 cwd（path.resolve + 不区分大小写）；否则抛 FORBIDDEN */
async function resolveDiffCwd(raw) {
  const requested = String(raw ?? "").trim();
  if (!requested) return primaryCwd(); // 未指定 → 桥工作区根（与 T-18 原行为一致）
  const target = path.resolve(requested); // 相对路径也在这里归一，再参与白名单比较
  // 白名单两侧都要 path.resolve：会话 header 的 cwd 由 pi 原样写入（常见正斜杠 C:/a/b），
  // primaryCwd() 直接返回 engine.extra.cwd → 与 ?cwd= 归一后的 C:\a\b 字符串不等 →
  // 引擎重启窗口（sessionFile 尚未回填）会被误判 403。
  const allowed = [primaryCwd(), ...(await attachedSessionCwds())].map((candidate) => path.resolve(candidate));
  if (allowed.some((candidate) => samePath(target, candidate))) return target;
  throw Object.assign(new Error(`不允许读取该目录的 git 差异：${target}`), { code: "FORBIDDEN" });
}

async function handleStats(engine, res) {
  const rpc = engine.rpc;
  if (!rpc) return sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
  try {
    const data = await rpc.request("get_session_stats");
    sendJson(res, 200, data ?? {}); // 原样透传（F-14：不自造复算）
  } catch (err) {
    sendRpcError(res, err);
  }
}

// ---------- /api/files · /api/file（T-17）----------

function queryParam(req, name) {
  try {
    return new URL(req.url || "/", `http://${HOST}:${PORT}`).searchParams.get(name) ?? "";
  } catch {
    return "";
  }
}

async function handleFiles(req, res) {
  try {
    const result = await workspaceFiles.list(queryParam(req, "path"));
    sendJson(res, 200, result);
  } catch (err) {
    const code = HTTP_STATUS[err?.code] ? err.code : "PI_ERROR";
    sendError(res, HTTP_STATUS[code], code, err.message);
  }
}

async function handleFile(req, res) {
  try {
    const result = await workspaceFiles.read(queryParam(req, "path"));
    sendJson(res, 200, result);
  } catch (err) {
    const code = HTTP_STATUS[err?.code] ? err.code : "PI_ERROR";
    sendError(res, HTTP_STATUS[code], code, err.message);
  }
}

// ---------- /api/workspace（T-15）----------

function waitForState(instance, pred, ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred(instance)) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("timeout waiting pi state"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function handleWorkspace(engine, req, res) {
  const rpc0 = engine.rpc;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
  }
  let nextCwd;
  try {
    nextCwd = await resolveProjectDir(body?.cwd);
  } catch (err) {
    return sendError(res, 400, err?.code || "BAD_REQUEST", err?.message || "cwd 不合法");
  }

  if (!rpc0) return sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
  if (engine.extra.restarting) return sendError(res, 503, "PI_NOT_READY", "工作区正在切换中");
  if (rpc0.state === "streaming") return sendError(res, 503, "PI_NOT_READY", "正在运行中：请先中止再切换工作区");

  engine.extra.restarting = true;
  const oldPid = rpc0.snapshot().pid;
  const fromCwd = engine.extra.cwd;
  log("info", "workspace_switch_start", { engine: engine.id, from: fromCwd, to: nextCwd, oldPid });
  try {
    await rpc0.stop("workspace-switch");
    engine.extra.cwd = nextCwd;
    engine.extra.claim = null; // 新工作区 = 新空会话，旧会话不再被本引擎占用
    forgetRememberedSession(engine.owner ?? engine.id, "workspace-switch"); // 新空会话：不再恢复旧会话
    engine.rpc = createRpc(engine, nextCwd);
    engine.rpc.start();
    await waitForState(engine.rpc, (r) => r.state === "idle" || r.state === "failed", 45000);
    if (engine.rpc.state !== "idle") throw new Error(`pi 未进入 idle（state=${engine.rpc.state}）`);
    const sessionId = engine.rpc.lastGetState?.sessionId ?? null;
    log("info", "workspace_switch_done", { engine: engine.id, cwd: nextCwd, oldPid, newPid: engine.rpc.snapshot().pid, sessionId });
    sendJson(res, 200, { cwd: nextCwd, sessionId, state: { isStreaming: false } });
  } catch (err) {
    log("error", "workspace_switch_failed", { engine: engine.id, to: nextCwd, reason: err?.code || err?.message });
    sendError(res, 502, "PI_ERROR", `切换工作区失败：${err.message}`);
  } finally {
    engine.extra.restarting = false;
  }
}

// ---------- /api/mcp/state + /api/mcp/config（MCP 按需）----------

/** UI 渲染用：有哪些 server 可选 + 默认名单 + cwd 规则 + 当前引擎实际带的名字 */
function mcpStateBody(clientId) {
  const engine = clientId ? pool.find(clientId) : null;
  const available = listAvailableServers(PI?.agentDir ?? AGENT_DIR);
  return {
    ok: true,
    available: available.servers,
    default: [...mcpShell.config.default],
    rules: mcpShell.config.rules.map((rule) => ({ cwd: rule.cwd, servers: [...rule.servers] })),
    current: engine ? [...engine.mcp] : null,
    configPath: MCP_CONFIG_PATH,
    configExists: mcpShell.exists,
    error: mcpShell.error || available.error || null,
  };
}

/** 写配置：只接受 default / rules（部分更新），schema 校验 + 原子写 + 立刻重载 */
async function handleMcpConfigWrite(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
    return;
  }
  const merged = {
    default: body.default !== undefined ? body.default : mcpShell.config.default,
    rules: body.rules !== undefined ? body.rules : mcpShell.config.rules,
    ...(mcpShell.config.servers ? { servers: mcpShell.config.servers } : {}),
  };
  const checked = validateShellMcpConfig(merged);
  if (!checked.ok) {
    sendError(res, 400, "BAD_REQUEST", checked.error);
    return;
  }
  try {
    writeShellMcpConfig(MCP_CONFIG_PATH, checked.config);
  } catch (err) {
    sendError(res, 500, "PI_ERROR", `写入失败：${err.message}`);
    return;
  }
  reloadMcpShell();
  log("info", "mcp_config_written", {
    path: MCP_CONFIG_PATH,
    default: checked.config.default,
    rules: checked.config.rules.length,
  });
  sendJson(res, 200, mcpStateBody(null));
}

// ---------- /api/engine/restart（MCP 按需启用）----------

/**
 * 重建一个引擎以应用新的 MCP 设置（pi 不支持进程内懒加载 MCP，只能换子进程）。
 *
 * 保持同一会话：先记住原 rpc 的 sessionFile（含 attach 中的 claim 占位），停旧进程 →
 * 用 engine.mcp 重建 rpc（参数 --no-mcp 由 createRpc 决定）→ 等 idle → switch_session 回原文件。
 * 切不回去（文件被删/扩展取消/switch 报错）→ 落新会话，响应里 sessionKept=false 让前端提示。
 */
async function handleEngineRestart(req, res, headerClient) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
    return;
  }
  const targetClient = typeof body.client === "string" && body.client.trim() ? body.client.trim() : headerClient;
  // 名单是 string[]（逐个勾选）；为兼容旧脚本仍接受 boolean（true = 全部可用 server）
  let desired;
  if (Array.isArray(body.mcp)) {
    if (!body.mcp.every((name) => typeof name === "string" && name.trim())) {
      sendError(res, 400, "BAD_REQUEST", "mcp 必须是 server 名数组");
      return;
    }
    desired = [...new Set(body.mcp.map((name) => name.trim()))];
  } else if (typeof body.mcp === "boolean") {
    desired = body.mcp ? listAvailableServers(PI?.agentDir ?? AGENT_DIR).servers.map((s) => s.name) : [];
  } else {
    sendError(res, 400, "BAD_REQUEST", "mcp 必填（server 名数组）");
    return;
  }
  const unknown = desired.filter((name) => !listAvailableServers(PI?.agentDir ?? AGENT_DIR).servers.some((s) => s.name === name));
  if (unknown.length) {
    sendError(res, 400, "BAD_REQUEST", `mcp.json 里没有这些 server：${unknown.join(", ")}`);
    return;
  }

  let engine;
  try {
    engine = resolveOpEngine(targetClient, { mcp: desired, tab: tabIdOf(req) });
  } catch (err) {
    if (err?.code === "CONFLICT") {
      sendError(res, err.status || 409, "CONFLICT", err.message);
      return;
    }
    log("warn", "engine_capacity_reject", { client: targetClient, count: pool.size, max: MAX_ENGINES, reason: err?.message });
    sendError(res, 503, "PI_NOT_READY", err.message);
    return;
  }
  if (!engine?.rpc) {
    sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
    return;
  }
  if (engine.extra.restarting) {
    sendError(res, 409, "CONFLICT", "引擎正在重启中");
    return;
  }
  if (engine.rpc.state === "streaming") {
    sendError(res, 409, "CONFLICT", "正在运行中：请先中止再切换 MCP");
    return;
  }

  const snapshotBody = () => ({
    ok: true,
    mcp: engine.mcp,
    engine: engine.health(),
    engines: pool.list().map((e) => e.health()),
    engineCount: pool.size,
    maxEngines: MAX_ENGINES,
  });

  // 状态已经一致：不白停一次子进程（幂等）
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  if (sameSet(engine.mcp, desired)) {
    log("info", "engine_restart_noop", { client: targetClient, engine: engine.id, mcp: desired });
    sendJson(res, 200, { ...snapshotBody(), restarted: false, sessionKept: null, sessionFile: engine.sessionFile });
    return;
  }

  const startedAt = Date.now();
  const oldPid = engine.rpc.snapshot().pid;
  const fromMcp = engine.mcp;
  const sessionFile = engine.sessionFile
    ? path.resolve(engine.sessionFile)
    : engine.extra.claim
      ? path.resolve(engine.extra.claim)
      : null;

  engine.extra.restarting = true;
  engine.extra.attachToken += 1; // 取消还在路上的接管
  engine.extra.pendingExtDialogs?.clear(); // 旧进程的对话框回执已经没有意义
  log("info", "engine_restart_start", {
    client: targetClient,
    engine: engine.id,
    from: fromMcp,
    to: desired,
    oldPid,
    sessionFile,
  });

  try {
    await engine.rpc.stop("mcp-switch");
    engine.mcp = desired;
    resetSseTail(engine, "engine-restart"); // 换进程 = 会话要重新 attach：旧尾巴不能补给新会话
    applyMcpShim(engine); // 新名单 → 新的临时 agentDir（空名单 = 清 shim + --no-mcp）
    if (sessionFile) engine.extra.claim = sessionFile; // 重建期间继续占住这个会话，避免被别的引擎抢
    engine.rpc = createRpc(engine, engine.extra.cwd);
    engine.rpc.start();
    await waitForState(engine.rpc, (r) => r.state === "idle" || r.state === "failed", 45000);
    if (engine.rpc.state !== "idle") throw new Error(`pi 未进入 idle（state=${engine.rpc.state}）`);

    // 保持同一会话：switch_session 回原文件（失败则保留 pi 新建的空会话）
    let sessionKept = false;
    let restoredFile = null;
    let sessionId = null;
    if (sessionFile && fs.existsSync(sessionFile)) {
      try {
        const switched = await engine.rpc.request("switch_session", { sessionPath: sessionFile }, { timeoutMs: 60000 });
        if (switched?.cancelled !== true) {
          const state = await engine.rpc.request("get_state");
          engine.rpc.noteGetState(state);
          const attached = state?.sessionFile ? path.resolve(state.sessionFile) : null;
          sessionKept = !!attached && attached.toLowerCase() === sessionFile.toLowerCase();
          if (sessionKept) {
            restoredFile = attached;
            sessionId = state?.sessionId ?? null;
            engine.extra.claim = attached;
          }
        }
      } catch (err) {
        log("warn", "engine_restart_session_restore_failed", {
          engine: engine.id,
          file: sessionFile,
          reason: err?.code || err?.message,
        });
      }
    }
    if (!sessionKept) engine.extra.claim = null; // 新会话：不再占用旧文件
    // 恢复会话后按会话 header 回写 cwd（T2 / F7 / B3-4）：新子进程的运行时 cwd 由 pi 从 header 决定，
    // 桥侧 extra.cwd 必须跟着走，否则 health / MCP 规则会停在引擎创建时的旧目录。
    if (sessionKept) applySessionCwd(engine, await readSessionCwd(restoredFile), restoredFile);
    // 重连恢复：MCP 重启后会话还在 → 记录保持；没恢复成功（落新空会话）→ 清掉旧会话记录
    if (sessionKept) noteSessionForEngine(engine, { sessionFile: restoredFile, model: engine.rpc.lastGetState?.model ?? null, thinkingLevel: engine.rpc.lastGetState?.thinkingLevel ?? null }, engine.extra.cwd);
    else forgetRememberedSession(engine.owner ?? engine.id, "engine-restart-new-session");

    const ms = Date.now() - startedAt;
    const newPid = engine.rpc.snapshot().pid;
    if (sessionKept) {
      const entriesData = await engine.rpc.request("get_entries").catch(() => null);
      broadcast(engine, {
        type: "session_attached",
        sessionFile: restoredFile,
        sessionId,
        leafId: entriesData?.leafId ?? null,
        ms,
      });
    } else if (sessionFile) {
      broadcast(engine, {
        type: "session_attach_failed",
        sessionFile,
        code: "RESTART_RESTORE_FAILED",
        reason: "未能恢复原会话，已落新会话",
        ms,
      });
    }

    log("info", "engine_restart_done", {
      client: targetClient,
      engine: engine.id,
      mcp: desired,
      oldPid,
      newPid,
      sessionKept,
      ms,
    });
    sendJson(res, 200, {
      ...snapshotBody(),
      restarted: true,
      previousMcp: fromMcp,
      oldPid,
      pid: newPid,
      sessionKept,
      sessionFile: sessionKept ? restoredFile : null,
      ms,
    });
  } catch (err) {
    log("error", "engine_restart_failed", {
      client: targetClient,
      engine: engine.id,
      to: desired,
      reason: err?.code || err?.message,
    });
    sendError(res, 502, "PI_ERROR", `切换 MCP 失败：${err.message}`);
  } finally {
    engine.extra.restarting = false;
  }
}

// ---------- /api/ext-ui-response（T-12）----------

async function handleExtUiResponse(engine, req, res) {
  if (!requireRpc(engine, res)) return;
  const rpc = engine.rpc;
  const pendingExtDialogs = engine.extra.pendingExtDialogs;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
  }
  const id = body?.id;
  if (typeof id !== "string" || !id) return sendError(res, 400, "BAD_REQUEST", "id 必填");
  // 03 §5：只接受当前 pending 集合内的 id（陈旧页面可能给已被自动取消的对话框补发回执）
  if (!pendingExtDialogs.has(id)) {
    log("warn", "ext_ui_response_unknown_id", { id });
    return sendError(res, 409, "CONFLICT", "对话框已失效（可能已超时/自动取消），请刷新后重试");
  }
  pendingExtDialogs.delete(id);

  const fields = {};
  if (body.cancelled === true) fields.cancelled = true;
  else if (typeof body.confirmed === "boolean") fields.confirmed = body.confirmed;
  else if (typeof body.value === "string") fields.value = body.value;
  else return sendError(res, 400, "BAD_REQUEST", "需要 value(string) / confirmed(bool) / cancelled(true)");

  if (!rpc.sendUiResponse(id, fields)) return sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
  sendJson(res, 200, { ok: true });
}

// ---------- /api/session/entries（T-13）----------

async function handleSessionEntries(engine, req, res) {
  if (!requireRpc(engine, res)) return;
  const rpc = engine.rpc;
  let since = null;
  try {
    since = new URL(req.url || "/", `http://${HOST}:${PORT}`).searchParams.get("since");
  } catch {
    since = null;
  }
  try {
    const data = await rpc.request("get_entries", since ? { since } : {});
    sendJson(res, 200, { entries: data?.entries ?? [], leafId: data?.leafId ?? null, resync: false });
  } catch (err) {
    if (!since) return sendRpcError(res, err);
    // since 失效（03 §10）：按全量重载处理，不报错；前端收到 resync 后重建列表
    log("warn", "entries_since_invalid_resync", { since });
    try {
      const full = await rpc.request("get_entries");
      broadcast(engine, { type: "resync", reason: "entries-since-invalid", leafId: full?.leafId ?? null });
      sendJson(res, 200, { entries: full?.entries ?? [], leafId: full?.leafId ?? null, resync: true });
    } catch (err2) {
      sendRpcError(res, err2);
    }
  }
}

// ---------- /api/models · /api/thinking-levels · /api/commands · /api/clear-queue（T-09/T-10/T-11）----------

function requireRpc(engine, res) {
  if (engine?.rpc) return true;
  sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
  return false;
}

// B7：模型清单默认只返回「有凭据」的模型（provider 命中 auth.json / credentials.env / 环境变量）。
// `?all=1` 保留全量（每项带 configured），便于排障与既有手工核对。
const modelsSignature = (models) =>
  (Array.isArray(models) ? models : [])
    .map((m) => `${m?.provider}/${m?.id}`)
    .sort()
    .join(",");

/** 把这次模型表 + 文件指纹记到引擎上，供 /api/models/reload 判断「引擎是否需要重启」 */
function noteModelsSnapshot(engine, models, cfg) {
  if (!engine?.extra) return null;
  const snapshot = { signature: modelsSignature(models), files: { ...cfg.files } };
  engine.extra.modelsSnapshot = snapshot;
  return snapshot;
}

/**
 * 是否需要重启 pi 引擎才能看到新模型？
 * - 模型目录文件（models.json / models-store.json）变了、但引擎返回的模型表一模一样 → 引擎表是旧的；
 * - 已配置 + 目录声明过的 provider，在引擎表里一个模型都没有 → 引擎不认这个 provider。
 * 只改凭据（auth.json / credentials.env）不算：过滤在桥侧做，引擎表本来就有这些模型。
 */
function needsEngineRestart(engine, models, cfg) {
  const prev = engine?.extra?.modelsSnapshot;
  const signature = modelsSignature(models);
  const catalogChanged = !!prev && (prev.files?.["models.json"] !== cfg.files["models.json"] ||
    prev.files?.["models-store.json"] !== cfg.files["models-store.json"]);
  if (prev && catalogChanged && prev.signature === signature) return true;

  const present = new Set((Array.isArray(models) ? models : []).map((m) => m?.provider));
  for (const provider of cfg.providers) {
    if (present.has(provider)) continue;
    if (cfg.declaredProviders.has(provider)) return true;
  }
  return false;
}

/**
 * GET /api/models：清单跟**调用方**那一列的引擎走（B1 / T5）。
 * 引擎由路由解析：带 client 且存在 → 该引擎；未知/未带 → 主引擎（既有脚本结果不变）。
 */
async function handleModels(req, res, engine) {
  if (!requireRpc(engine, res)) return;
  const rpc = engine.rpc;
  let all = false;
  try {
    all = new URL(req.url || "/", `http://${HOST}:${PORT}`).searchParams.get("all") === "1";
  } catch {
    all = false;
  }
  try {
    const data = await rpc.request("get_available_models");
    const raw = data?.models ?? [];
    const cfg = getModelsConfig({ agentDir: AGENT_DIR });
    noteModelsSnapshot(engine, raw, cfg);
    const annotated = annotateModels(raw, cfg.providers);
    const usable = annotated.filter((m) => m.configured);
    if (all) {
      sendJson(res, 200, { models: annotated, total: annotated.length, configuredCount: usable.length, all: true });
      return;
    }
    sendJson(res, 200, { models: usable, total: annotated.length, configuredCount: usable.length, all: false });
  } catch (err) {
    sendRpcError(res, err);
  }
}

/** POST /api/models/reload：清缓存 + 重读凭据，不重启 pi（引擎表不认新 provider 时才提示重启） */
async function handleModelsReload(res) {
  const engine = primaryEngine();
  if (!requireRpc(engine, res)) return;
  const rpc = engine.rpc;
  const before = engine.extra.modelsSnapshot ?? null;
  try {
    invalidateModelsConfig();
    const cfg = getModelsConfig({ agentDir: AGENT_DIR, force: true });
    const data = await rpc.request("get_available_models");
    const raw = data?.models ?? [];
    const annotated = annotateModels(raw, cfg.providers);
    const usable = annotated.filter((m) => m.configured);
    const restart = needsEngineRestart(engine, raw, cfg);
    noteModelsSnapshot(engine, raw, cfg);
    log("info", "models_reloaded", {
      providers: usable.length ? [...new Set(usable.map((m) => m.provider))] : [],
      models: usable.length,
      total: annotated.length,
      needsEngineRestart: restart,
    });
    sendJson(res, 200, {
      providers: [...cfg.configuredProviders].sort(),
      models: usable.length,
      total: annotated.length,
      needsEngineRestart: restart,
      changed: {
        credentials: !!before && (before.files?.["auth.json"] !== cfg.files["auth.json"] ||
          before.files?.["credentials.env"] !== cfg.files["credentials.env"]),
        catalog: !!before && (before.files?.["models.json"] !== cfg.files["models.json"] ||
          before.files?.["models-store.json"] !== cfg.files["models-store.json"]),
      },
    });
  } catch (err) {
    sendRpcError(res, err);
  }
}

async function handleSetModel(engine, req, res) {
  if (!requireRpc(engine, res)) return;
  const rpc = engine.rpc;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
  }
  const { provider, modelId } = body ?? {};
  if (typeof provider !== "string" || typeof modelId !== "string" || !provider || !modelId) {
    return sendError(res, 400, "BAD_REQUEST", "provider 与 modelId 必填");
  }
  try {
    const model = await rpc.request("set_model", { provider, modelId });
    const state = await rpc.request("get_state");
    rpc.noteGetState(state);
    noteSessionForEngine(engine, state, engine.extra?.cwd ?? null); // 重连恢复：模型也记住
    log("info", "model_set", { provider, modelId: model?.id ?? modelId });
    sendJson(res, 200, { ok: true, model: model ?? null, state: { model: state?.model ?? null, thinkingLevel: state?.thinkingLevel ?? null } });
  } catch (err) {
    sendRpcError(res, err);
  }
}

async function handleThinkingLevels(engine, res) {
  if (!requireRpc(engine, res)) return;
  const rpc = engine.rpc;
  try {
    const data = await rpc.request("get_available_thinking_levels");
    sendJson(res, 200, { levels: data?.levels ?? [] });
  } catch (err) {
    sendRpcError(res, err);
  }
}

async function handleSetThinking(engine, req, res) {
  if (!requireRpc(engine, res)) return;
  const rpc = engine.rpc;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
  }
  if (typeof body?.level !== "string" || !body.level) return sendError(res, 400, "BAD_REQUEST", "level 必填");
  try {
    // 03 §5：桥侧先按 get_available_thinking_levels 校验；pi 对未知 level 会静默归一为 off
    const available = await rpc.request("get_available_thinking_levels");
    const levelsNow = available?.levels ?? [];
    if (levelsNow.length && !levelsNow.includes(body.level)) {
      return sendError(res, 400, "BAD_REQUEST", `不支持的思考级别：${body.level}（可用：${levelsNow.join("/")}）`);
    }
    await rpc.request("set_thinking_level", { level: body.level });
    const state = await rpc.request("get_state");
    rpc.noteGetState(state);
    noteSessionForEngine(engine, state, engine.extra?.cwd ?? null); // 重连恢复：思考级别也记住
    // 换思考级别可能改变可用级别集合
    const levels = await rpc.request("get_available_thinking_levels").catch(() => null);
    log("info", "thinking_set", { level: body.level });
    sendJson(res, 200, { ok: true, state: { thinkingLevel: state?.thinkingLevel ?? null }, levels: levels?.levels ?? null });
  } catch (err) {
    sendRpcError(res, err);
  }
}

/** GET /api/commands：同 /api/models，命令清单跟调用方那一列的引擎走（B1 / T5） */
async function handleCommands(res, engine) {
  if (!requireRpc(engine, res)) return;
  const rpc = engine.rpc;
  try {
    const data = await rpc.request("get_commands");
    sendJson(res, 200, { commands: data?.commands ?? [] }); // 直通（A-05）
  } catch (err) {
    sendRpcError(res, err);
  }
}

/**
 * GET /api/session/view?client=<id>：该会话的完整状态（B1 / T5）。
 * - cwd 取引擎当前值（T2 已保证 attach/new/restart 后回写真实会话目录）；
 * - sessionFile/model/thinkingLevel 取最近一次 get_state（握手已有，不额外发 RPC）；
 * - 无全局缓存；引擎不存在由路由回 404，未完成握手回 503 PI_NOT_READY。
 */
function handleSessionView(engine, res) {
  if (!requireRpc(engine, res)) return;
  const state = engine.rpc.lastGetState;
  if (!state || engine.rpc.failed) return sendError(res, 503, "PI_NOT_READY", "pi 尚未完成握手");
  sendJson(res, 200, buildSessionView(engine, state));
}

async function handleClearQueue(engine, res) {
  if (!requireRpc(engine, res)) return;
  const rpc = engine.rpc;
  try {
    const data = await rpc.request("clear_queue");
    log("info", "queue_cleared", { engine: engine.id, steering: data?.steering?.length ?? 0, followUp: data?.followUp?.length ?? 0 });
    sendJson(res, 200, { steering: data?.steering ?? [], followUp: data?.followUp ?? [] });
  } catch (err) {
    sendRpcError(res, err);
  }
}

// ---------- /api/session/open（T-08）----------

/** 只允许打开扫描根内的会话文件（越界 403，含符号链接逃逸） */
async function resolveSessionPath(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw Object.assign(new Error("path 必填"), { code: "BAD_REQUEST" });
  }
  const resolved = path.resolve(inputPath);
  if (!resolved.toLowerCase().endsWith(".jsonl")) {
    throw Object.assign(new Error("path 必须是 .jsonl 会话文件"), { code: "BAD_REQUEST" });
  }
  const rootReal = await fsp.realpath(SCAN_DIR);
  let real;
  try {
    real = await fsp.realpath(resolved);
  } catch {
    throw Object.assign(new Error("会话文件不存在"), { code: "NOT_FOUND" });
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw Object.assign(new Error("会话文件不在扫描根内"), { code: "FORBIDDEN" });
  }
  return real;
}

/** 只读会话 header 的 cwd（供 CONFLICT 预检，03 §10） */
async function readSessionCwd(filePath) {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    const header = JSON.parse(firstLine);
    return typeof header?.cwd === "string" ? header.cwd : null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * 把会话 header 的 cwd 写回引擎（T2 / F7 / B3-4）：
 * `switch_session` / `engine restart` 之后 pi 的运行时 cwd 由会话 header 决定，
 * 桥侧 `engine.extra.cwd` 必须跟着走，否则 `/api/health` 的 `pi.cwd`、MCP 按 cwd 规则、
 * turn-changes 的基准目录都会停在引擎创建时的旧值（「打开旧会话后 cwd 脱钩」）。
 * @returns {string|null} 写回后的 cwd（header 没有 cwd 时不改旧值，返回 null）
 */
function applySessionCwd(engine, cwd, sessionFile) {
  if (typeof cwd !== "string" || !cwd) return null;
  const from = engine.extra.cwd;
  engine.extra.cwd = cwd;
  if (from !== cwd) {
    log("info", "session_cwd_synced", { engine: engine.id, from, to: cwd, sessionFile: sessionFile ?? null });
  }
  return cwd;
}

/** 后台接管：switch_session → get_state → SSE session_attached / session_attach_failed */
async function attachSession(engine, sessionPath, token, { cancelledByPrecheck = false, reason = "" } = {}) {
  const rpc = engine.rpc;
  const startedAt = Date.now();
  if (cancelledByPrecheck) {
    broadcast(engine, { type: "session_attach_failed", sessionFile: sessionPath, code: "CONFLICT", reason, ms: 0 });
    log("warn", "session_attach_failed", { engine: engine.id, file: sessionPath, reason, ms: 0 });
    return;
  }
  try {
    // 「离开旧会话」的这一刻就把尾巴清掉：此后产生的帧属于新会话（包括切换过程中已经开跑的那一轮，
    // 它是新会话的画面，不能丢）。放在 switch 之后清会把这份「本轮已开始」的头几帧也抹掉（bgUi A8）。
    resetSseTail(engine, "switch_session");
    const switched = await rpc.request("switch_session", { sessionPath });
    if (token !== engine.extra.attachToken) return; // 已被新的 open 覆盖
    if (switched?.cancelled === true) {
      broadcast(engine, { type: "session_attach_failed", sessionFile: sessionPath, code: "CANCELLED", reason: "扩展取消了切换", ms: Date.now() - startedAt });
      log("info", "session_attach_failed", { engine: engine.id, file: sessionPath, reason: "cancelled", ms: Date.now() - startedAt });
      return;
    }
    const state = await rpc.request("get_state");
    rpc.noteGetState(state);
    engine.extra.claim = state?.sessionFile ? path.resolve(state.sessionFile) : sessionPath;
    // cwd 真相回写（T2）：接管成功后 extra.cwd == 会话 header 的 cwd
    const sessionCwd = await readSessionCwd(engine.extra.claim);
    if (token !== engine.extra.attachToken) return; // 读 header 期间又被新的 open 覆盖
    applySessionCwd(engine, sessionCwd, engine.extra.claim);
    // 重连恢复：接管成功就把「该客户端当前会话」记下来（引擎被回收后还能切回来）
    noteSessionForEngine(engine, state, engine.extra.cwd);
    const entriesData = await rpc.request("get_entries");
    const ms = Date.now() - startedAt;
    broadcast(engine, {
      type: "session_attached",
      sessionFile: sessionPath,
      sessionId: state?.sessionId ?? null,
      leafId: entriesData?.leafId ?? null,
      ms,
    });
    log("info", "session_attached", { engine: engine.id, sessionId: state?.sessionId ?? null, ms, entries: entriesData?.entries?.length ?? 0 });
  } catch (err) {
    if (token !== engine.extra.attachToken) return;
    const code = /working directory does not exist/i.test(err?.message || "") ? "CONFLICT" : err?.code || "PI_ERROR";
    broadcast(engine, { type: "session_attach_failed", sessionFile: sessionPath, code, reason: err?.message || "接管失败", ms: Date.now() - startedAt });
    log("warn", "session_attach_failed", { engine: engine.id, file: sessionPath, code, reason: err?.message, ms: Date.now() - startedAt });
  }
}

/** 从环境读孤儿接管的静默门槛（非法值/缺省回落到 30000，与 engines.mjs 的 DEFAULT_ADOPT_GRACE_MS 一致） */
function resolveAdoptGraceMs(raw) {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_ADOPT_GRACE_MS;
  return n;
}

/**
 * S3：本客户端那条引擎能不能为了接管而丢弃。
 * 返回 null 表示可以丢（空转引擎 / 还没有引擎）；返回原因表示「有活干，不抢」→ 调用方维持 409。
 *   - streaming：自己也正在跑一轮（用户在这边有工作）；
 *   - session-busy：已经占着**别的**会话（同理）。
 */
function adoptSwapBlocker(engine, sessionPath) {
  if (!engine) return null;
  if (engine.state === "streaming") return "streaming";
  const norm = (p) => String(p ?? "").replace(/\//g, "\\").toLowerCase();
  const holding = engine.sessionFile ?? engine.claimedSessionFile ?? null;
  if (holding && norm(holding) !== norm(sessionPath)) return "session-busy";
  return null;
}

/**
 * S3（bg-continue）：把「别的客户端留下的孤儿引擎」接过来（设计 §5.3）。
 * 前提（调用方已用 adoptable + adoptSwapBlocker 判定过）：orphan 无 SSE、静默 ≥ ADOPT_GRACE_MS、同会话，
 * 且本客户端那条引擎空转。这里只负责动作：先 release 本客户端旧引擎（F25：own() 同键覆盖会静默丢进程），
 * 再 own 目标引擎；接管后 claim/sessionFile 不变（不重新 attach、不重建 MCP shim），广播 bridge_state。
 * @returns {Promise<boolean>} true = 已接管并已回 200；false = 没成（调用方按 409 处理）；接管后读不到状态时已回 503
 */
async function adoptOrphanEngine(res, engine, orphan, sessionPath) {
  const clientId = engine.id; // 池内键 = 客户端标识（own() 只改目标引擎的键，不动这个值）
  // 防御：pool.adopt 内部按 clientId 找「旧引擎」并 release，必须就是我们手里这条 —— 否则会错停别人的引擎
  if (pool.find(clientId) !== engine) {
    log("warn", "session_open_adopt_skipped", { client: clientId, reason: "engine-mismatch", found: pool.find(clientId)?.id ?? null });
    return false;
  }
  const adopted = await pool.adopt(orphan, clientId);
  if (!adopted) return false;
  // 不清尾巴：接手的是同一个会话同一轮（尾巴就是这一轮还没落盘的内容，页面回来要继续看）
  // 资源面板/其他页面立刻看到 owner 变更（不重新 attach，claim 保持原值）
  broadcast(adopted, {
    type: "bridge_state",
    pi: piHealth(adopted),
    from: null,
    to: adopted.rpc?.state ?? "idle",
    session: sessionInfo(adopted),
  });
  try {
    const state = await adopted.rpc.request("get_state");
    adopted.rpc.noteGetState(state);
    // 接管后引擎归属变了：重连恢复记录也跟着换个 client（否则新页面断开再回来会丢会话）
    noteSessionForEngine(adopted, state, adopted.extra?.cwd ?? null);
    const entriesData = await adopted.rpc.request("get_entries");
    log("info", "session_open_adopted", {
      client: clientId,
      sessionId: state?.sessionId ?? null,
      entries: entriesData?.entries?.length ?? 0,
      state: adopted.rpc?.state ?? null,
    });
    sendJson(res, 200, {
      mode: "live",
      cancelled: false,
      attach: "attached",
      adopted: true,
      sessionId: state?.sessionId ?? null,
      sessionFile: sessionPath,
      state,
      entries: entriesData?.entries ?? [],
      leafId: entriesData?.leafId ?? null,
    });
    return true;
  } catch (err) {
    // 接管成功但读不到状态（引擎刚崩）：不静默降级 —— 明确回 503，页面重试会走新建引擎的常规路径
    log("warn", "session_open_adopt_failed", { client: clientId, reason: err?.code || err?.message });
    sendError(res, 503, "PI_NOT_READY", "接管后台引擎失败，请重试");
    return false;
  }
}

async function handleSessionOpen(engine, req, res) {
  const rpc = engine.rpc;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
    return;
  }
  let sessionPath;
  try {
    sessionPath = await resolveSessionPath(body.path);
  } catch (err) {
    sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message);
    return;
  }

  // 同会话保护（第三批）：同一会话不能被两个引擎同时打开
  // S3（bg-continue）：唯一例外是「孤儿接管」——别的标签页已经关掉（无 SSE）、静默 ≥ ADOPT_GRACE_MS，
  // 而那条引擎还在后台跑着这一轮（streaming）。把它接过来，页面回来就能直接看到还在跑的那一轮。
  // I1 不放宽：有活跃 SSE 的仍走 409；本客户端自己引擎也忙（streaming / 占着别的会话）也不抢。
  const owner = pool.sessionOwner(sessionPath, { except: engine.id });
  if (owner) {
    const orphan = owner.rpc && !owner.rpc.failed ? pool.adoptable(sessionPath, { graceMs: ADOPT_GRACE_MS, except: engine.id }) : null;
    const blocked = adoptSwapBlocker(engine, sessionPath);
    if (orphan && !blocked) {
      if (await adoptOrphanEngine(res, engine, orphan, sessionPath)) return;
      if (res.headersSent || res.writableEnded) return; // 已回 503
    }
    log("warn", "session_open_conflict", {
      engine: engine.id,
      owner: owner.id,
      file: sessionPath,
      adoptable: !!orphan,
      blocked: blocked ?? (orphan ? null : "not-adoptable"),
    });
    sendError(res, 409, "CONFLICT", "该会话已在另一个标签页打开");
    return;
  }

  // 已附着同一个文件：直接 get_entries（不重复 switch，避免 3s 的 MCP 重启）
  const attachedFile = rpc?.lastGetState?.sessionFile ? path.resolve(rpc.lastGetState.sessionFile) : null;
  if (rpc && !rpc.failed && attachedFile === sessionPath && rpc.state !== "starting") {
    try {
      const state = await rpc.request("get_state");
      rpc.noteGetState(state);
      const entriesData = await rpc.request("get_entries");
      engine.extra.claim = sessionPath; // 复用：本引擎继续占用这个会话
      applySessionCwd(engine, await readSessionCwd(sessionPath), sessionPath); // cwd 真相回写（T2）
      noteSessionForEngine(engine, state, engine.extra.cwd); // 重连恢复：记住当前会话
      log("info", "session_open_reused", { engine: engine.id, sessionId: state?.sessionId ?? null, entries: entriesData?.entries?.length ?? 0 });
      sendJson(res, 200, {
        mode: "live",
        cancelled: false,
        attach: "attached",
        sessionId: state?.sessionId ?? null,
        sessionFile: sessionPath,
        state,
        entries: entriesData?.entries ?? [],
        leafId: entriesData?.leafId ?? null,
      });
      return;
    } catch {
      // 复用失败则回落到读文件 + 重新接管
    }
  }

  // 1) 读文件立即返回（目标 ≤2s；与 pi 无关，零副作用）
  let view;
  try {
    view = await readSessionEntries(sessionPath);
  } catch (err) {
    sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message);
    return;
  }

  engine.extra.claim = sessionPath; // 读文件成功：本引擎占用它（同会话保护立即生效，不等 3s 接管）

  // 2) 预检 cwd：目标 cwd 不存在则不浪费 3s 去 switch，直接判接管失败（内容仍可看）
  const token = ++engine.extra.attachToken;
  const sessionCwd = await readSessionCwd(sessionPath);
  let cwdMissing = false;
  if (sessionCwd) {
    try {
      cwdMissing = !(await fsp.stat(sessionCwd)).isDirectory();
    } catch {
      cwdMissing = true;
    }
  }

  sendJson(res, 200, {
    mode: "view",
    cancelled: false,
    attach: "pending",
    sessionId: view.sessionId,
    sessionFile: sessionPath,
    cwd: view.cwd,
    entries: view.entries,
    leafId: view.leafId,
  });
  log("info", "session_view_opened", { engine: engine.id, sessionId: view.sessionId, entries: view.entries.length, cwdMissing });

  // 3) 后台接管（不阻塞响应）
  if (!rpc) {
    broadcast(engine, { type: "session_attach_failed", sessionFile: sessionPath, code: "PI_NOT_READY", reason: "pi 未就绪", ms: 0 });
    return;
  }
  setImmediate(() => {
    attachSession(engine, sessionPath, token, { cancelledByPrecheck: cwdMissing, reason: cwdMissing ? `项目目录已移动或删除：${sessionCwd}` : "" }).catch((err) => {
      log("error", "session_attach_crashed", { engine: engine.id, reason: err?.message });
    });
  });
}

// ---------- DELETE /api/session（B-12：真删除，带可撤销备份）----------

/**
 * 删除一个会话文件：校验（根内 .jsonl / 非当前附着）→ 移到 backups/deleted-sessions/<ts>/<相对路径> → 失效列表缓存。
 * 只用 query.path（DELETE 不带请求体）；日志只记路径与备份位置，不记正文。
 */
/** 所有引擎正在用（已附着或已打开）的会话文件 */
function claimedSessionFiles() {
  const out = [];
  for (const engine of pool.list()) {
    if (engine.sessionFile) out.push(engine.sessionFile);
    if (engine.claimedSessionFile) out.push(engine.claimedSessionFile);
  }
  return out;
}

async function handleSessionDelete(req, res) {
  const raw = queryParam(req, "path");
  // 全局端点：任何引擎正在用的会话都不允许删（不只是主引擎）
  const all = claimedSessionFiles();
  let attachedFile = null;
  if (typeof raw === "string" && raw.trim()) {
    const target = path.resolve(raw.trim());
    attachedFile = all.find((file) => samePath(path.resolve(file), target)) ?? null;
  }
  try {
    const result = await deleteSessionFile({
      rawPath: raw,
      roots: [SCAN_DIR, AGENT_SESSIONS_DIR].filter(Boolean),
      backupRoot: DELETED_BACKUP_ROOT,
      attachedFile,
    });
    // 与 fork/clone 同一套失效口径：缓存不清，列表会继续显示已删会话（刷新也不消失）
    sessionIndex.invalidate();
    log("info", "session_deleted", { path: result.deleted, backup: result.backup, bytes: result.bytes });
    sendJson(res, 200, { ok: true, deleted: result.deleted, backup: result.backup });
  } catch (err) {
    const code = HTTP_STATUS[err?.code] ? err.code : "PI_ERROR";
    log("warn", "session_delete_failed", { path: typeof raw === "string" ? raw : null, code, reason: err?.message });
    sendError(res, HTTP_STATUS[code], code, err?.message || "删除失败");
  }
}

// ---------- /api/session/new（M1 · 03 §5 / A1 · T1）----------

/**
 * 把本列引擎换到 nextCwd（A1 / T1）：停旧子进程 → 按新 cwd 重算 MCP 名单 → 重建 rpc → 等 idle。
 * `createRpc` 是 engine 级，只有本列受影响；调用方必须先校验目录再调这里。
 */
async function restartEngineForCwd(engine, nextCwd) {
  const oldPid = engine.rpc?.snapshot?.().pid ?? null;
  const fromCwd = engine.extra.cwd;
  engine.extra.restarting = true;
  engine.extra.attachToken += 1; // 取消还在路上的接管
  engine.extra.pendingExtDialogs?.clear();
  log("info", "session_new_cwd_restart_start", { engine: engine.id, from: fromCwd, to: nextCwd, oldPid });
  try {
    await engine.rpc.stop("session-new-cwd");
    engine.extra.cwd = nextCwd;
    engine.extra.claim = null; // 新目录 = 新空会话，旧会话不再被本引擎占用
    forgetRememberedSession(engine.owner ?? engine.id, "session-new-cwd"); // 新空会话：不再恢复旧会话
    resetSseTail(engine, "engine-restart"); // 换进程/换目录 = 换会话：旧尾巴不能补给新会话
    // 不能沿用旧名单：项目级 .pi/mcp.json 规则按 cwd 变（F15 / 设计 §3.A 风险）
    engine.mcp = resolveMcpServers({ cwd: nextCwd, config: mcpShell.config }).servers;
    applyMcpShim(engine);
    engine.rpc = createRpc(engine, nextCwd);
    engine.rpc.start();
    await waitForState(engine.rpc, (r) => r.state === "idle" || r.state === "failed", 45000);
    if (engine.rpc.state !== "idle") throw new Error(`pi 未进入 idle（state=${engine.rpc.state}）`);
    log("info", "session_new_cwd_restart_done", {
      engine: engine.id,
      cwd: nextCwd,
      oldPid,
      newPid: engine.rpc.snapshot().pid,
      mcp: engine.mcp,
    });
  } finally {
    engine.extra.restarting = false;
  }
}

/**
 * 新建会话：可带 `{cwd}`（A1 / T1）→ 该列引擎切到新目录后 new_session → get_state → noteGetState。
 * - 不传 cwd：行为不变（运行时 cwd），响应仍带 `cwd`；
 * - 传 cwd：先校验（不存在/非目录 → 400 BAD_REQUEST，不动进程），与当前目录相同则不重启；
 *   不同则只重启本列引擎（1–3s，MCP 名单按新 cwd 重算）；
 * - streaming 中拒绝（409）：切换会话会让正在跑的回合被 abort，不能静默丢内容。
 * H-5：此端点**不落盘**——pi 只有在出现 user/assistant 消息后才创建 .jsonl。
 */
async function handleNewSession(engine, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
  }
  // 先校验目录再碰进程：目录不合法时保持原引擎与原会话
  let nextCwd = null;
  if (body?.cwd !== undefined && body?.cwd !== null) {
    try {
      nextCwd = await resolveProjectDir(body.cwd);
    } catch (err) {
      return sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "cwd 不合法");
    }
  }
  const rpc0 = engine.rpc;
  if (!rpc0) return sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
  if (rpc0.state === "streaming" || rpc0.lastGetState?.isStreaming === true) {
    return sendError(res, 409, "CONFLICT", "正在运行中：请先中止再新建会话");
  }
  if (engine.extra.restarting) return sendError(res, 503, "PI_NOT_READY", "引擎正在重启中");

  // 目录相同（忽略大小写/尾部分隔符）→ 不重启，直接 new_session
  if (nextCwd && !sameProjectDir(nextCwd, engine.extra.cwd)) {
    try {
      await restartEngineForCwd(engine, nextCwd);
    } catch (err) {
      log("error", "session_new_cwd_restart_failed", { engine: engine.id, to: nextCwd, reason: err?.code || err?.message });
      return sendError(res, 502, "PI_ERROR", `切换目录失败：${err.message}`);
    }
  }

  const rpc = engine.rpc;
  try {
    // 与 switch_session 同一口径：「离开旧会话」这一刻就清尾巴（之后产生的帧属于新会话）
    resetSseTail(engine, "new_session");
    const data = await rpc.request("new_session");
    if (data?.cancelled === true) {
      log("warn", "session_new_cancelled", { engine: engine.id, reason: "extension" });
      return sendError(res, 409, "CONFLICT", "扩展取消了新建会话");
    }
    const state = await rpc.request("get_state");
    rpc.noteGetState(state);
    engine.extra.claim = state?.sessionFile ? path.resolve(state.sessionFile) : null;
    // 新会话还没落盘（H-5）→ 清掉「旧会话」记录，避免重连时把用户丢回上一个会话
    noteSessionForEngine(engine, state, engine.extra.cwd);
    // F3/F5：pi 的 new_session 不接受 cwd，用的是**运行时 cwd**。
    // 换目录已在上面通过重启子进程完成（运行时 cwd = 新目录）；同目录/未传 cwd 时
    // 运行时 cwd 与 extra.cwd 已在 attach/restart 对齐，这里只把真相回给前端。
    const cwd = engine.extra.cwd;
    log("info", "session_created", { engine: engine.id, sessionId: state?.sessionId ?? null, cwd });
    sendJson(res, 200, { sessionId: state?.sessionId ?? null, cwd, state });
  } catch (err) {
    sendRpcError(res, err);
  }
}

// ---------- /api/prompt、/api/abort ----------

const STREAMING_BEHAVIORS = new Set(["steer", "followUp"]);

function validateImages(images) {
  if (!Array.isArray(images)) throw Object.assign(new Error("images 必须是数组"), { code: "BAD_REQUEST" });
  return images.map((img, i) => {
    const ok =
      img &&
      typeof img === "object" &&
      img.type === "image" &&
      typeof img.data === "string" &&
      img.data.length > 0 &&
      typeof img.mimeType === "string";
    if (!ok) throw Object.assign(new Error(`images[${i}] 需为 {type:"image",data,mimeType}`), { code: "BAD_REQUEST" });
    return { type: "image", data: img.data, mimeType: img.mimeType };
  });
}

async function handlePrompt(engine, req, res) {
  const rpc = engine.rpc;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
    return;
  }
  if (!rpc) {
    sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
    return;
  }

  const params = {};
  const message = typeof body.message === "string" ? body.message : null;
  const hasImages = Array.isArray(body.images) && body.images.length > 0;
  if (!message && !hasImages) {
    sendError(res, 400, "BAD_REQUEST", "message 不能为空");
    return;
  }
  if (message) params.message = message;
  if (body.images !== undefined) {
    try {
      params.images = validateImages(body.images);
    } catch (err) {
      sendError(res, 400, err.code, err.message);
      return;
    }
  }
  if (body.streamingBehavior !== undefined) {
    if (!STREAMING_BEHAVIORS.has(body.streamingBehavior)) {
      sendError(res, 400, "BAD_REQUEST", 'streamingBehavior 只能是 "steer" 或 "followUp"');
      return;
    }
    params.streamingBehavior = body.streamingBehavior;
  }

  try {
    // 504 TIMEOUT 只表示**命令回执**超时：事件流可能仍在继续，前端不得据此重发（03 §10）
    const data = await rpc.request("prompt", params);
    const disposition = data?.disposition ?? null;
    rpc.notePromptDisposition(disposition);
    log("info", "prompt_accepted", { engine: engine.id, disposition });
    sendJson(res, 200, { disposition });
  } catch (err) {
    // 已知：streaming 中不带 streamingBehavior 会被 pi 拒绝（success:false → 502），前端按错误码提示
    sendRpcError(res, err);
  }
}

async function handleAbort(engine, res) {
  const rpc = engine.rpc;
  if (!rpc) {
    sendError(res, 503, "PI_NOT_READY", "pi 未就绪");
    return;
  }
  try {
    // abort 会等 pi 侧回到 idle 才回执；超时同样只代表回执超时（03 §10）
    await rpc.request("abort");
    log("info", "abort_ok", { engine: engine.id });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendRpcError(res, err);
  }
}

// ---------- 客户端标识 → 引擎（第三批）----------

/**
 * 客户端标识：优先请求头 X-Pi-Shell-Client（前端统一注入）；EventSource 不能自定义头，
 * 所以同时接受 ?client=（与 SSE 帧里的 engine 字段同一个值）。缺省 = "default"（既有脚本/单引擎语义）
 */
function clientIdOf(req) {
  return explicitClientIdOf(req) ?? DEFAULT_CLIENT;
}

/**
 * 显式客户端标识（未带 → null）。与 clientIdOf 的区别：这里不用 "default" 兜底，
 * 供「按 client 取引擎、未带就回落主引擎」的读端点使用（B1 / T5）。
 */
function explicitClientIdOf(req) {
  const raw = req.headers?.["x-pi-shell-client"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const fromHeader = typeof value === "string" ? value.trim() : "";
  if (fromHeader) return fromHeader;
  const fromQuery = queryParam(req, "client");
  return fromQuery.trim() || null;
}

/** N1-a：标签页标识（每页随机、不持久化）。EventSource 不能自定义头 → 同时接受 ?tab=。 */
function tabIdOf(req) {
  const raw = req.headers?.["x-pi-shell-tab"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const fromHeader = typeof value === "string" ? value.trim() : "";
  if (fromHeader) return fromHeader;
  return queryParam(req, "tab").trim() || null;
}

/** 桥侧发过一个引擎（已被认领但还没 start 的情况：补齐启动） */
function ensureStarted(engine) {
  if (engine?.rpc && engine.rpc.state === "not_started") engine.rpc.start();
  return engine;
}

/**
 * 重连恢复（P0）：引擎被空闲回收后用同一 clientId 回来 → 用原会话把新引擎切回去。
 * 契约：
 *   - 成功 → 广播 `session_attached`（复用现有帧，前端直接 setAttachState("attached")）+ `engine_restored` 日志；
 *   - 文件已删/被移 → `session_attach_failed{code:NOT_FOUND}` + `engine_restore_failed` 日志，
 *     引擎保持空会话（**不得静默**）；
 *   - 与用户显式 open 共用 attachToken：用户在恢复完成前自己打开了别的会话 → 本次恢复放弃，不广播噪音。
 */
function scheduleEngineRestore(engine, clientId, memory) {
  setImmediate(() => {
    restoreEngineSession(engine, clientId, memory).catch((err) => {
      log("error", "engine_restore_crashed", { client: clientId, engine: engine.id, reason: err?.code || err?.message });
    });
  });
}

/** 恢复时尽量把模型/思考级别也带回来（会话已恢复；失败只告警，不回退会话） */
async function restoreModelAndThinking(engine, clientId, memory, state) {
  const rpc = engine.rpc;
  if (!rpc || !memory) return state;
  let latest = state;
  let changed = false;
  const want = memory.model;
  if (want?.provider && want?.id) {
    const current = latest?.model ?? null;
    if (!current || current.provider !== want.provider || current.id !== want.id) {
      try {
        await rpc.request("set_model", { provider: want.provider, modelId: want.id });
        changed = true;
        log("info", "engine_restore_model", { client: clientId, engine: engine.id, provider: want.provider, modelId: want.id });
      } catch (err) {
        log("warn", "engine_restore_model_failed", {
          client: clientId,
          engine: engine.id,
          provider: want.provider,
          modelId: want.id,
          reason: err?.code || err?.message,
        });
      }
    }
  }
  const level = memory.thinkingLevel;
  if (level && latest?.thinkingLevel && latest.thinkingLevel !== level) {
    try {
      await rpc.request("set_thinking_level", { level });
      changed = true;
      log("info", "engine_restore_thinking", { client: clientId, engine: engine.id, level });
    } catch (err) {
      log("warn", "engine_restore_thinking_failed", { client: clientId, engine: engine.id, level, reason: err?.code || err?.message });
    }
  }
  if (!changed) return latest;
  const refreshed = await rpc.request("get_state").catch(() => null);
  if (refreshed) {
    rpc.noteGetState(refreshed);
    return refreshed;
  }
  return latest;
}

async function restoreEngineSession(engine, clientId, memory) {
  const sessionFile = memory?.path ?? null;
  if (!engine || !sessionFile) return;
  const startedAt = Date.now();
  const token = ++engine.extra.attachToken; // 与用户显式 open 共用取消令牌
  const rpc = engine.rpc;
  const failed = (code, reason) => {
    broadcast(engine, {
      type: "session_attach_failed",
      sessionFile,
      code,
      reason,
      ms: Date.now() - startedAt,
    });
    log("warn", "engine_restore_failed", { client: clientId, engine: engine.id, sessionFile, code, reason });
    // 恢复不了原会话：
    // - NOT_FOUND（文件已删/被移）→ 从记忆里删掉该条（否则每次重连都撞同一个失败），
    //   后续用户在新会话里发消息时 noteSessionForEngine 会重新记上真实现状；
    // - 其余失败 → 记忆跟随引擎当前真相（pi 启动时会建一个空会话），
    //   否则用户在新会话里的内容会在回收后丢失；
    // - PI_NOT_READY（引擎没起来）不动记忆：留给下次重连再试。
    if (code === "NOT_FOUND") {
      forgetRememberedSession(clientId, "session-file-missing");
    } else if (code !== "PI_NOT_READY" && rpc && !rpc.failed) {
      noteSessionForEngine(engine, rpc.lastGetState ?? null, engine.extra.cwd);
    }
  };
  // 被新的 open 覆盖 / 引擎对象换了 rpc（重启 / 切工作区）→ 本次恢复作废
  const superseded = () => token !== engine.extra.attachToken || engine.rpc !== rpc;

  if (!rpc) {
    failed("PI_NOT_READY", "pi 未就绪");
    return;
  }
  try {
    await waitForState(rpc, (r) => r.state === "idle" || r.state === "failed", 45000);
  } catch {
    if (superseded()) return;
    failed("PI_NOT_READY", "pi 未在 45s 内就绪");
    return;
  }
  if (superseded()) {
    log("info", "engine_restore_superseded", { client: clientId, engine: engine.id, sessionFile });
    return;
  }
  if (rpc.state === "failed") {
    failed("PI_NOT_READY", "pi 启动失败");
    return;
  }
  // 文件已被删除/移动：明确失败（NOT_FOUND），引擎保持空会话，不静默
  let exists = false;
  try {
    exists = (await fsp.stat(sessionFile)).isFile();
  } catch {
    exists = false;
  }
  if (!exists) {
    failed("NOT_FOUND", "原会话文件已删除或移动");
    return;
  }
  // 不回归「同会话双开 409」：引擎被回收期间别的客户端可能已经打开了同一会话 → 不抢
  const owner = pool.sessionOwner(sessionFile, { except: engine.id });
  if (owner) {
    failed("CONFLICT", `该会话已在另一个标签页打开（${owner.id}）`);
    return;
  }
  // 用户在恢复完成前已经主动打开/切换了会话 → 尊重用户，不覆盖
  const claimed = engine.claimedSessionFile;
  if (claimed && !samePath(claimed, sessionFile)) {
    log("info", "engine_restore_skipped", { client: clientId, engine: engine.id, sessionFile, claimed });
    return;
  }
  try {
    resetSseTail(engine, "engine-restore");
    if (!engine.extra.claim) engine.extra.claim = sessionFile; // 恢复期间先占位（同会话双开拦得住）
    const switched = await rpc.request("switch_session", { sessionPath: sessionFile }, { timeoutMs: 60000 });
    if (superseded()) {
      log("info", "engine_restore_superseded", { client: clientId, engine: engine.id, sessionFile });
      return;
    }
    if (switched?.cancelled === true) {
      engine.extra.claim = null;
      failed("CANCELLED", "扩展取消了切换");
      return;
    }
    let state = await rpc.request("get_state");
    rpc.noteGetState(state);
    const attached = state?.sessionFile ? path.resolve(state.sessionFile) : sessionFile;
    if (!samePath(attached, sessionFile)) {
      engine.extra.claim = null;
      failed("RESTORE_MISMATCH", `pi 实际附着到 ${attached}`);
      return;
    }
    engine.extra.claim = attached;
    // cwd 真相：会话 header 优先（T2 的 readSessionCwd 复用）；恢复时引擎本来就是按它起的
    const cwd = applySessionCwd(engine, await readSessionCwd(attached), attached) ?? engine.extra.cwd;
    state = await restoreModelAndThinking(engine, clientId, memory, state);
    const entriesData = await rpc.request("get_entries").catch(() => null);
    const ms = Date.now() - startedAt;
    broadcast(engine, {
      type: "session_attached",
      sessionFile: attached,
      sessionId: state?.sessionId ?? null,
      leafId: entriesData?.leafId ?? null,
      ms,
      restored: true,
    });
    log("info", "engine_restored", {
      client: clientId,
      engine: engine.id,
      sessionFile: attached,
      cwd,
      sessionId: state?.sessionId ?? null,
      ms,
    });
    noteSessionForEngine(engine, state, cwd); // 记忆按最新真相刷新
  } catch (err) {
    if (superseded()) return;
    engine.extra.claim = null;
    const code = /working directory does not exist/i.test(err?.message || "") ? "CONFLICT" : err?.code || "PI_ERROR";
    failed(code, err?.message || "恢复原会话失败");
  }
}

/** 取/建一个客户端自己的引擎；超上限抛 PI_NOT_READY（不静默降级） */
function claimEngine(clientId, mcp = null, tabId = null) {
  // Q6：认领前先回收空闲引擎 —— 关标签页后 60s 内新开标签页不能被旧引擎占着名额（「开太多」）。
  // sweep 是同步移除池内记录的（rpc.stop 异步），所以下面的 find/unowned/full 看到的是清完僵尸后的池。
  pool.sweep();
  const hit = pool.find(clientId);
  if (hit) {
    hit.touchTab(tabId);
    return ensureStarted(hit.touch());
  }
  // 引导引擎（未被认领）先给第一个客户端：单标签页/既有脚本都只跑 1 个 pi 进程。
  // 【第四批修正】必须先看「有没有未认领的引擎」再判上限：PI_SHELL_MAX_ENGINES=1 时
  // 引导引擎已占满池子，先判 full 会把第一个标签页永远挡在 503 外（页面永远拿不到 pid/version）。
  const unowned = pool.list().find((engine) => !engine.owner);
  if (unowned) {
    const owned = pool.own(unowned, clientId);
    owned.touchTab(tabId);
    ensureStarted(owned);
    // v1.0.0：桥重启后引导引擎还没有归属 —— 第一次认领也要用（持久化的）记忆把原会话接回来。
    // 引导引擎按 INITIAL_CWD 起，恢复会 switch_session 并用会话 header 的 cwd 回写（restoreEngineSession）。
    const rememberedForAdopt = lastSessionByClient.get(clientId) ?? null;
    if (rememberedForAdopt?.path) {
      log("info", "session_memory_hit", {
        client: clientId,
        engine: owned.id,
        sessionFile: rememberedForAdopt.path,
        cwd: rememberedForAdopt.cwd ?? null,
        via: "bootstrap-adopt",
      });
      scheduleEngineRestore(owned, clientId, rememberedForAdopt);
    }
    return owned;
  }
  if (pool.full()) throw pool.capacityError();
  // P0 重连恢复：该客户端上次的会话（引擎被 idle-sweep 回收后仍然记得）→
  // 用原会话的 cwd 起引擎（不是 INITIAL_CWD），起来后立刻 switch_session 回去。
  const remembered = lastSessionByClient.get(clientId) ?? null;
  const restoreCwd = restoreCwdFor(remembered);
  log("info", "engine_created", {
    client: clientId,
    count: pool.liveCount() + 1,
    max: MAX_ENGINES,
    mcp,
    tab: tabId,
    cwd: restoreCwd ?? INITIAL_CWD,
    restore: remembered?.path ?? null,
  });
  const engine = pool.add(createEngine(clientId, { mcp, cwd: restoreCwd ?? INITIAL_CWD }));
  engine.touchTab(tabId);
  if (remembered?.path) scheduleEngineRestore(engine, clientId, remembered);
  return engine;
}

/** N1-a：同一 client 被新标签页认领后，旧 tab 的后续请求会被拒（409），避免两个页面互相顶掉 */
function tabConflictError(engine, tabId) {
  log("warn", "engine_tab_rejected", { client: engine.id, tab: tabId, currentTab: engine.tab });
  return Object.assign(new Error("该引擎已被另一个标签页接管，请刷新本页"), {
    code: "CONFLICT",
    status: 409,
  });
}

/**
 * 操作型端点的引擎归属：
 * - 该客户端已有引擎 → 用它；
 * - 缺省客户端（既有脚本）且池里只有一条引擎（标签页已认领）→ 共用它（单引擎兼容）；
 * - 其余 → 认领/新建（超上限 → 503）。
 */
function resolveOpEngine(clientId, { mcp = null, tab = null } = {}) {
  const hit = pool.find(clientId);
  if (hit) {
    if (hit.isTabRejected(tab)) throw tabConflictError(hit, tab);
    hit.touchTab(tab);
    return ensureStarted(hit.touch());
  }
  if (clientId === DEFAULT_CLIENT) {
    const all = pool.list();
    if (all.length === 1) {
      const shared = all[0];
      if (shared.isTabRejected(tab)) throw tabConflictError(shared, tab);
      shared.touchTab(tab);
      return ensureStarted(shared.touch());
    }
  }
  return claimEngine(clientId, mcp, tab);
}

/** 路由用：解析失败按错误码回（默认 503，tab 冲突 409） */
function opEngine(clientId, res, opts = {}) {
  try {
    return resolveOpEngine(clientId, opts);
  } catch (err) {
    if (err?.code === "CONFLICT") {
      sendError(res, err.status || 409, "CONFLICT", err.message);
      return null;
    }
    log("warn", "engine_capacity_reject", { client: clientId, count: pool.size, max: MAX_ENGINES, reason: err?.message });
    sendError(res, 503, "PI_NOT_READY", err.message);
    return null;
  }
}

// ---------- 路由 ----------

const handleRequest = async (req, res) => {
  const started = Date.now();
  let pathname = "/";
  try {
    pathname = new URL(req.url || "/", `http://${HOST}:${PORT}`).pathname;
  } catch {
    sendError(res, 400, "BAD_REQUEST", "malformed url");
    return;
  }

  const method = req.method || "GET";
  const clientId = clientIdOf(req);
  res.on("finish", () => {
    log("info", "request", {
      method,
      path: pathname,
      status: res.statusCode,
      ms: Date.now() - started,
      client: clientId === DEFAULT_CLIENT ? undefined : clientId,
    });
  });

  // 操作型端点的引擎（按需建）；超上限 → 已回 503，返回 null
  const needsEngine = () => opEngine(clientId, res, { tab: tabIdOf(req) });

  try {
    if (pathname === "/api/health") {
      if (method !== "GET" && method !== "HEAD") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      sendJson(res, 200, healthBody(clientId));
      return;
    }

    // MCP 按需：可选 server 清单 + 默认名单 + cwd 规则（UI 勾选面板的数据源）
    if (pathname === "/api/mcp/state") {
      if (method !== "GET" && method !== "HEAD") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      sendJson(res, 200, mcpStateBody(clientId));
      return;
    }

    // MCP 按需：写 pi-shell-mcp.json（default / rules）
    if (pathname === "/api/mcp/config") {
      if (method !== "POST") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      await handleMcpConfigWrite(req, res);
      return;
    }

    // N1-b：资源面板数据源（不创建引擎；一次返回所有引擎的 RSS/会话/MCP）
    if (pathname === "/api/engines/stats") {
      if (method !== "GET" && method !== "HEAD") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      sendJson(res, 200, await buildEngineStats());
      return;
    }

    // N1-b：用户主动释放引擎（资源面板「释放」/「只留当前列」）
    if (pathname === "/api/engine/release") {
      if (method !== "POST") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      await handleEngineRelease(req, res, clientId);
      return;
    }

    // 认领一个引擎（前端启动时就调）：超上限 → 503 + 明确文案，页面用 showNotice 显示
    if (pathname === "/api/engine/claim") {
      if (method !== "POST") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      // 请求体可带 {client, mcp}：client 覆盖请求头标识（脚本可直接指定列）；
      // mcp 缺省按 cwd 规则/配置 default 解析（默认空 = 不带 MCP）。
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, HTTP_STATUS[err?.code] || 400, err?.code || "BAD_REQUEST", err?.message || "请求体不合法");
        return;
      }
      const targetClient = typeof body.client === "string" && body.client.trim() ? body.client.trim() : clientId;
      const desiredMcp = Array.isArray(body.mcp) ? body.mcp : null;
      const engine = opEngine(targetClient, res, { mcp: desiredMcp, tab: tabIdOf(req) });
      if (!engine) return;
      // 已有引擎的 MCP 状态与请求不符：交给前端决定是否 POST /api/engine/restart
      // （pi 不支持进程内懒加载 MCP → 只能换子进程）。
      const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      if (desiredMcp && !sameSet(engine.mcp, desiredMcp)) {
        log("info", "engine_mcp_mismatch", {
          client: targetClient,
          engine: engine.id,
          mcp: engine.mcp,
          requested: desiredMcp,
        });
        sendJson(res, 200, {
          needsRestart: true,
          mcp: engine.mcp,
          requestedMcp: desiredMcp,
          engine: engine.health(),
          engines: pool.list().map((e) => e.health()),
          engineCount: pool.size,
          maxEngines: MAX_ENGINES,
        });
        return;
      }
      log("info", "engine_claim", {
        client: targetClient,
        engine: engine.id,
        count: pool.size,
        max: MAX_ENGINES,
        mcp: engine.mcp,
      });
      sendJson(res, 200, {
        needsRestart: false,
        mcp: engine.mcp,
        engine: engine.health(),
        engines: pool.list().map((e) => e.health()),
        engineCount: pool.size,
        maxEngines: MAX_ENGINES,
      });
      return;
    }

    // 重建一个引擎以应用新的 MCP 设置（保持同一会话：switch_session 回原 sessionFile）
    if (pathname === "/api/engine/restart") {
      if (method !== "POST") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      await handleEngineRestart(req, res, clientId);
      return;
    }

    if (pathname === "/api/events") {
      if (method !== "GET") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      // SSE 也认领引擎（超上限 → 503，前端 EventSource 报错后走 claim 提示）
      const engine = needsEngine();
      if (!engine) return;
      openEventStream(req, res, engine);
      return;
    }

    if (pathname === "/api/sessions") {
      if (method !== "GET") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      await handleSessions(req, res, clientId);
      return;
    }

    if (pathname === "/api/workspace") {
      if (method !== "POST") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleWorkspace(engine, req, res);
      return;
    }

    if (pathname === "/api/models") {
      if (method !== "GET") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = pickReadEngine({ client: explicitClientIdOf(req), find: (id) => pool.find(id), primary: primaryEngine() });
      await handleModels(req, res, engine);
      return;
    }

    if (pathname === "/api/models/reload") {
      if (method !== "POST") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      await handleModelsReload(res);
      return;
    }

    if (pathname === "/api/model") {
      if (method !== "POST") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleSetModel(engine, req, res);
      return;
    }

    if (pathname === "/api/thinking-levels") {
      if (method !== "GET") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleThinkingLevels(engine, res);
      return;
    }

    if (pathname === "/api/thinking") {
      if (method !== "POST") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleSetThinking(engine, req, res);
      return;
    }

    if (pathname === "/api/commands") {
      if (method !== "GET") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = pickReadEngine({ client: explicitClientIdOf(req), find: (id) => pool.find(id), primary: primaryEngine() });
      await handleCommands(res, engine);
      return;
    }

    if (pathname === "/api/clear-queue") {
      if (method !== "POST") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleClearQueue(engine, res);
      return;
    }

    if (pathname === "/api/ext-ui-response") {
      if (method !== "POST") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleExtUiResponse(engine, req, res);
      return;
    }

    if (pathname === "/api/session/view") {
      if (method !== "GET" && method !== "HEAD") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      // 只读端点：解析不到引擎就 404，**不创建**新引擎（否则每个拼错的 client 都多一个 pi 进程）
      const engine = pickSessionEngine({ client: explicitClientIdOf(req), find: (id) => pool.find(id), primary: primaryEngine() });
      if (!engine) {
        sendError(res, 404, "NOT_FOUND", "未知 client：没有对应的会话引擎");
        return;
      }
      handleSessionView(engine, res);
      return;
    }

    if (pathname === "/api/session/entries") {
      if (method !== "GET") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleSessionEntries(engine, req, res);
      return;
    }

    if (pathname === "/api/session/fork") {
      if (method !== "POST") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleFork(engine, req, res);
      return;
    }

    if (pathname === "/api/session/clone") {
      if (method !== "POST") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleClone(engine, res);
      return;
    }

    if (pathname === "/api/session/tree") {
      if (method !== "GET") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleTree(engine, res);
      return;
    }

    if (pathname === "/api/turn-changes") {
      if (method !== "GET") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      await handleTurnChanges(req, res, clientId);
      return;
    }

    if (pathname === "/api/git/diff") {
      if (method !== "GET") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      await handleGitDiff(req, res);
      return;
    }

    if (pathname === "/api/stats") {
      if (method !== "GET") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      const engine = needsEngine();
      if (!engine) return;
      await handleStats(engine, res);
      return;
    }

    if (pathname === "/api/files") {
      if (method !== "GET") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      await handleFiles(req, res);
      return;
    }

    if (pathname === "/api/file") {
      if (method !== "GET") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      await handleFile(req, res);
      return;
    }

    if (pathname === "/api/session/open") {
      if (method !== "POST") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      const engine = needsEngine();
      if (!engine) return;
      await handleSessionOpen(engine, req, res);
      return;
    }

    if (pathname === "/api/session") {
      if (method !== "DELETE") return sendError(res, 405, "BAD_REQUEST", "method not allowed");
      await handleSessionDelete(req, res);
      return;
    }

    if (pathname === "/api/session/new") {
      if (method !== "POST") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      const engine = needsEngine();
      if (!engine) return;
      await handleNewSession(engine, req, res);
      return;
    }

    if (pathname === "/api/prompt") {
      if (method !== "POST") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      const engine = needsEngine();
      if (!engine) return;
      await handlePrompt(engine, req, res);
      return;
    }

    if (pathname === "/api/abort") {
      if (method !== "POST") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      const engine = needsEngine();
      if (!engine) return;
      await handleAbort(engine, res);
      return;
    }

    // ---------- POST /api/restart（第四批）：界面内重启桥 ----------
    // 口径：先回 200 {ok:true}，200ms 后 process.exit(75)；
    // 75 是「非 0」，scripts/start-pi-shell.cmd 的重启循环会把它当成 crash 并在 1s 内重新拉起
    // （exit 0 会被当成「用户主动停止」而不重启，所以不能用 0）。
    // 退出前先杀掉本桥的 pi 子进程：Windows 上父进程 exit 不会带走子进程，
    // 否则守护进程重启后会多出一条孤儿 pi，还可能占着会话文件。
    if (pathname === "/api/restart") {
      if (method !== "POST") {
        sendError(res, 405, "BAD_REQUEST", "method not allowed");
        return;
      }
      const enginePids = pool
        .list()
        .map((engine) => engine.pid)
        .filter((pid) => Number.isInteger(pid));
      log("info", "restart_requested", { pid: process.pid, enginePids, client: clientId });
      sendJson(res, 200, { ok: true, pid: process.pid, enginePids, exitCode: 75 });
      setTimeout(() => {
        for (const pid of enginePids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        log("info", "restart_exit", { code: 75 });
        process.exit(75);
      }, 200);
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      sendError(res, 404, "NOT_FOUND", "unknown endpoint"); // 其余端点属 M1/M2
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendError(res, 405, "BAD_REQUEST", "method not allowed");
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (err) {
    log("error", "unhandled_request_error", { reason: err?.code || err?.message });
    if (!res.headersSent) sendError(res, 500, "PI_ERROR", "internal error");
    else res.end();
  }
};

// 每个监听地址一个 http server，共享同一 handler（Tailscale = 双栈：127.0.0.1 + 100.x）。
const servers = HOSTS.map(() => http.createServer(handleRequest));

for (const srv of servers) {
  srv.on("clientError", (err, socket) => {
    log("warn", "client_error", { reason: err?.code || err?.message });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  srv.on("error", (err) => {
    // 03 §3：端口占用直接报错，不换端口
    log("error", "listen_failed", { host: HOSTS.join(","), port: PORT_RAW, reason: err?.code || err?.message });
    process.exit(1);
  });
}

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  log("error", "bad_port", { port: PORT_RAW });
  process.exit(1);
}

// 安全护栏：通配绑定默认拒绝启动（文案见 bind.mjs）；非法值在上一步已回落回环。
if (!BIND.ok) {
  log("error", "bind_refused", { requested: BIND.requested, reason: BIND.reason });
  process.stderr.write(`[pi-shell] ${BIND.message}\n`);
  process.exit(1);
}
if (BIND.message) log("warn", "bind_adjusted", { requested: BIND.requested, bind: HOSTS.join(","), kind: BIND.kind, reason: BIND.reason });

// 非默认绑定时打印手机访问横幅（TTY 才写 stderr，H-15；非 TTY 只落 bridge.log）
function printBindBanner() {
  const lines = bindBannerLines(BIND, PORT);
  if (!lines.length) return;
  log("info", "bind_banner", { bind: HOSTS.join(","), kind: BIND.kind, url: `http://${HOST}:${PORT}` });
  if (process.stderr.isTTY) process.stderr.write(lines.map((line) => `[pi-shell] ${line}\n`).join(""));
}

HOSTS.forEach((host, index) => {
  servers[index].listen(PORT, host, () => {
    log("info", "listen_ok", { host, port: PORT });
    if (index !== 0) return; // 只跑一次启动钩子（日志/横幅/引擎握手）
    // 每次启动一行 start（pid / version / cwd / node）——旧日志保留时的分界点
    log("info", "bridge_start", {
      url: `http://${HOST}:${PORT}`,
      bind: HOSTS.join(","),
      hosts: HOSTS,
      bindKind: BIND.kind,
      port: PORT,
      pid: process.pid,
      node: process.version,
      webRoot: WEB_ROOT,
      cwd: primaryCwd(),
      piVersion: PI?.version ?? null,
      agentDir: AGENT_DIR,
      sessionsDir: SESSIONS_DIR || null,
      maxEngines: MAX_ENGINES,
      stderrMode: process.stderr.isTTY ? "tty" : "file-only",
    });
    printBindBanner();
    // 握手在监听之后启动：health 先能看到 not_started → starting → idle 的完整序列
    ensureStarted(bootstrapEngine);
  });
});

// 03 §3 生命周期：先 abort（T-05 接入）→ SIGTERM → 2s → SIGKILL；之后关监听
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown", {
    signal,
    engines: pool.list().map((engine) => ({ id: engine.id, pid: engine.pid })),
  });
  clearInterval(heartbeat);
  clearInterval(extSweep);
  clearInterval(engineSweep);
  for (const res of sseClients) {
    try {
      res.end();
    } catch {}
  }
  sseClients.clear();
  try {
    await originStore.flush(); // 退出前把来源判定落盘（sidecar）
  } catch {}
  try {
    await pool.releaseAll(`bridge-${signal}`); // 所有引擎一起关（含引导引擎）
  } catch (err) {
    log("warn", "shutdown_pi_stop_failed", { reason: err?.message });
  }
  let pending = servers.length;
  for (const srv of servers) {
    srv.close(() => {
      pending -= 1;
      if (pending <= 0) process.exit(0);
    });
  }
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGBREAK", () => shutdown("SIGBREAK")); // Windows 控制台 Ctrl+Break（G1-6 正常退出验证路径）
process.on("SIGTERM", () => shutdown("SIGTERM"));

