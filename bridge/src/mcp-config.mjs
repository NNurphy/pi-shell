// pi-shell bridge · MCP 按需配置（默认关闭 + 按列勾选 + cwd 规则自动启用）
//
// 背景（pi 1.5.0 实测，见 docs/MCP.md）：pi **没有** `--mcp-config <path>` 参数，也**没有**
// `PI_MCP_CONFIG` 之类的环境变量；MCP server 名单只从两处读：
//   1. `<agentDir>/mcp.json`（全局，agentDir = `PI_CODING_AGENT_DIR`，可被环境变量重定向）
//   2. `<cwd>/.pi/mcp.json`（项目级，需项目受信任）
// `--no-mcp` 是唯一的内建开关，只能「全开 / 全关」。
//
// 所以「只加载选中的 server」用第 1 条路：为一条引擎生成一个**临时 agentDir**（shim）——
// 真实 agentDir 里的目录用 junction 链过去、文件拷过去，只把 `mcp.json` 换成「只含选中 server」
// 的生成文件；子进程以 `PI_CODING_AGENT_DIR=<shim>` 启动。这样 settings / auth / skills /
// extensions（绝对路径或 junction）全部照旧，只是 server 名单不同。
// 选中集为空时不用 shim，直接 `--no-mcp`（最省，≈90MB/引擎）。
//
// 本模块只做「配置 + shim 构建」，不碰 HTTP/引擎池。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHELL_MCP_CONFIG_FILE = "pi-shell-mcp.json";

/** 空配置：文件不存在时的全默认（= 什么 MCP 都不开） */
export function emptyShellMcpConfig() {
  return { default: [], rules: [] };
}

/** 配置文件路径：PI_SHELL_MCP_CONFIG 覆盖 > `<agentDir>/pi-shell-mcp.json` */
export function shellMcpConfigPath(agentDir, env = process.env) {
  const raw = String(env.PI_SHELL_MCP_CONFIG || "").trim();
  if (raw) return path.resolve(raw);
  return path.join(agentDir, SHELL_MCP_CONFIG_FILE);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServerName(value) {
  // pi 的 server 名只允许字母/数字/_/-
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * 校验 pi-shell-mcp.json 的形状（`default` 与 `rules` 是唯一可写字段）。
 * @returns {{ok:true, config:object}|{ok:false, error:string}}
 */
export function validateShellMcpConfig(input) {
  if (!isRecord(input)) return { ok: false, error: "配置必须是对象（{default, rules}）" };
  const out = emptyShellMcpConfig();

  if (input.default !== undefined) {
    if (!Array.isArray(input.default)) return { ok: false, error: "default 必须是 server 名数组" };
    for (const name of input.default) {
      if (!isServerName(name)) return { ok: false, error: `default 含非法 server 名：${JSON.stringify(name)}` };
    }
    out.default = [...new Set(input.default)];
  }

  if (input.rules !== undefined) {
    if (!Array.isArray(input.rules)) return { ok: false, error: "rules 必须是数组" };
    const rules = [];
    for (let i = 0; i < input.rules.length; i += 1) {
      const rule = input.rules[i];
      if (!isRecord(rule)) return { ok: false, error: `rules[${i}] 必须是对象（{cwd, servers}）` };
      if (typeof rule.cwd !== "string" || !rule.cwd.trim()) return { ok: false, error: `rules[${i}].cwd 必须是非空字符串` };
      if (!Array.isArray(rule.servers)) return { ok: false, error: `rules[${i}].servers 必须是 server 名数组` };
      for (const name of rule.servers) {
        if (!isServerName(name)) return { ok: false, error: `rules[${i}].servers 含非法 server 名：${JSON.stringify(name)}` };
      }
      rules.push({ cwd: rule.cwd, servers: [...new Set(rule.servers)] });
    }
    out.rules = rules;
  }

  // servers 段是「可选继承位」：文件里出现就原样保留（写回时不丢），但不参与选择逻辑
  if (input.servers !== undefined) {
    if (!isRecord(input.servers)) return { ok: false, error: "servers 必须是对象" };
    out.servers = input.servers;
  }
  return { ok: true, config: out };
}

/**
 * 读配置：文件不存在 / JSON 坏 / 形状不对 → 全默认空（并回一个 reason 供日志）。
 * @returns {{config:{default:string[], rules:object[], servers?:object}, path:string, exists:boolean, error:string|null}}
 */
export function loadShellMcpConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return { config: emptyShellMcpConfig(), path: filePath, exists: false, error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return { config: emptyShellMcpConfig(), path: filePath, exists: true, error: `JSON 解析失败：${err.message}` };
  }
  try {
    const checked = validateShellMcpConfig(parsed);
    if (!checked.ok) return { config: emptyShellMcpConfig(), path: filePath, exists: true, error: checked.error };
    return { config: checked.config, path: filePath, exists: true, error: null };
  } catch (err) {
    return { config: emptyShellMcpConfig(), path: filePath, exists: true, error: err.message };
  }
}

/** 原子写：同目录临时文件 + rename（Windows 上 rename 覆盖同卷目标可行） */
export function writeShellMcpConfig(filePath, config) {
  const checked = validateShellMcpConfig(config);
  if (!checked.ok) throw new Error(checked.error);
  const body = `${JSON.stringify(checked.config, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, filePath);
  return checked.config;
}

/** 通配（只认 * 与 ?）：`C:\Code\my-app*` → 正则；大小写不敏感（Windows 路径） */
export function globToRegExp(pattern) {
  const norm = String(pattern ?? "").replace(/\\/g, "/");
  let re = "";
  for (const ch of norm) {
    if (ch === "*") re += "[\\s\\S]*";
    else if (ch === "?") re += "[\\s\\S]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** 路径通配匹配（两边都归一正斜杠，大小写不敏感）：给 matchRule 用 */
export function matchGlob(pattern, value) {
  return globToRegExp(pattern).test(String(value ?? "").replace(/\\/g, "/"));
}

/** 按 cwd 依次匹配规则：第一条命中即用它的 servers（空数组 = 明确不带 MCP） */
export function matchRule(cwd, rules = []) {
  const target = String(cwd ?? "");
  if (!target) return null;
  for (const rule of rules) {
    if (!rule || typeof rule.cwd !== "string") continue;
    if (matchGlob(rule.cwd, target)) return rule;
  }
  return null;
}

/**
 * 一条引擎该带哪些 server（首次创建时算一次；用户手动覆盖优先于规则）。
 * @returns {{servers:string[], source:"override"|"rule"|"default"}}
 */
export function resolveMcpServers({ cwd, config, override = null } = {}) {
  const cfg = config ?? emptyShellMcpConfig();
  if (Array.isArray(override)) return { servers: [...new Set(override)], source: "override" };
  const rule = matchRule(cwd, cfg.rules);
  if (rule) return { servers: [...new Set(rule.servers)], source: "rule" };
  return { servers: [...new Set(cfg.default ?? [])], source: "default" };
}

/** 默认 agentDir 里的 server 清单（mcp.json 的 mcpServers）：供 UI 勾选 */
export function listAvailableServers(agentDir) {
  const file = path.join(agentDir, "mcp.json");
  if (!fs.existsSync(file)) return { servers: [], error: null, path: file };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { servers: [], error: `mcp.json 解析失败：${err.message}`, path: file };
  }
  const map = isRecord(parsed?.mcpServers) ? parsed.mcpServers : {};
  const servers = Object.entries(map)
    .filter(([name]) => isServerName(name))
    .map(([name, entry]) => ({
      name,
      description: typeof entry?.description === "string" ? entry.description : "",
      // enabled:false 是「文件里默认休眠」；仍可在本列手动打开（按需启用就是靠这个）
      enabledByDefault: entry?.enabled !== false,
      transport: entry?.url ? "http" : "stdio",
    }));
  return { servers, error: null, path: file };
}

function safeClientTag(client) {
  return String(client || "engine").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
}

/**
 * 生成一条引擎的临时 agentDir（shim）：真实 agentDir 的目录 junction 过去、文件拷过去，
 * 只把 mcp.json 换成「只含选中 server」的生成文件。
 *
 * @returns {{dir:string, servers:string[], cleanup:()=>void}}
 */
export function createMcpShim({ agentDir, servers, client = "engine", tmpRoot = null, log = () => {} }) {
  const wanted = [...new Set(servers ?? [])];
  const { servers: available } = listAvailableServers(agentDir);
  const byName = new Map(available.map((s) => [s.name, s]));
  const kept = wanted.filter((name) => byName.has(name));
  const unknown = wanted.filter((name) => !byName.has(name));
  if (unknown.length) log("warn", "mcp_shim_unknown_server", { client, unknown });

  const root = tmpRoot || path.join(os.tmpdir(), "pi-shell-mcp");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, `${safeClientTag(client)}-`));

  // 1) 真实 agentDir 的其余内容：目录 junction、文件拷贝（mcp.json 除外，由本模块生成）
  for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
    if (entry.name === "mcp.json") continue;
    const target = path.join(agentDir, entry.name);
    const link = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) fs.symlinkSync(target, link, "junction");
      else if (entry.isFile()) fs.copyFileSync(target, link);
      else log("warn", "mcp_shim_skip_entry", { client, name: entry.name });
    } catch (err) {
      log("warn", "mcp_shim_link_failed", { client, name: entry.name, reason: err?.code || err?.message });
    }
  }

  // 2) 生成的 mcp.json：只保留选中的条目（原样继承 command/args/env/description…）
  const realMcp = JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf8"));
  const all = isRecord(realMcp?.mcpServers) ? realMcp.mcpServers : {};
  const mcpServers = {};
  for (const name of kept) {
    const entry = isRecord(all[name]) ? { ...all[name] } : null;
    if (!entry) continue;
    delete entry.enabled; // 选中即启用（文件里的 enabled:false 只是默认休眠）
    mcpServers[name] = entry;
  }
  const generated = { ...(realMcp.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: realMcp.autoEnableCodemode }), mcpServers };
  fs.writeFileSync(path.join(dir, "mcp.json"), `${JSON.stringify(generated, null, 2)}\n`, "utf8");

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true }); // rmSync 对 junction 只删链接，不进目标
    } catch (err) {
      log("warn", "mcp_shim_cleanup_failed", { client, dir, reason: err?.code || err?.message });
    }
  };
  return { dir, servers: kept, cleanup };
}
