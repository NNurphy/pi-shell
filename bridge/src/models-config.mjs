// pi-shell bridge · 「已配置模型」判定（B7）
//
// 为什么需要：pi 的 get_available_models 返回的是「模型目录」，不是「用户能用的模型」。
// 本机目录里有 anthropic(17)/openai(44)，但 ~/.pi/agent/auth.json 没有对应凭据，
// 用户选中后发消息才 401。这里把「有没有凭据」这件事算出来，给 /api/models 过滤用。
//
// 硬约束：任何返回值 / 日志都不得包含 key 的明文。本模块只回 provider 名字与文件 mtime，
// 读到的 key 值只在内存里判断「非空」，不写入任何返回结构。
//
// 判定口径（B7-A 起为「A 口径 · 只认 pi 的配置文件」）：
//   只认 ~/.pi/agent/auth.json（顶层 provider 键，值非空）
//        + ~/.pi/agent/credentials.env（`X_API_KEY=` 值非空）。
//   **不读进程环境变量**：本机 shell 里遗留的 OPENAI_API_KEY / QWEN_API_KEY 等不算「已配置」，
//   否则用户机器上一条与 pi 无关的 key 就会让 44 个 openai 模型重新出现（选中后 401）。
//   env 参数只为单测注入保留（用来证明「环境变量不参与判定」），默认不读 process.env。
//
// 缓存：auth.json / credentials.env / models.json / models-store.json 的 mtime+size 变化即失效，
// 所以「以后新配置模型」不需要重启桥（只有 pi 自己的模型表不认新 provider 时才需要重启引擎）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** auth.json 之外还要看的凭据文件（`X_API_KEY=` 形式） */
const CREDENTIALS_FILE = "credentials.env";

/** 参与缓存失效的文件（相对 agent 目录） */
export const CACHE_FILES = ["auth.json", CREDENTIALS_FILE, "models.json", "models-store.json"];

/**
 * `X_API_KEY` 变量名 → provider 名（显式表；表外的 `Y_API_KEY` 走通用规则）。
 * 只用于 credentials.env **文件**里的变量名（环境变量已不参与判定，见文件头「A 口径」）。
 * 只列本机实际在用 / 常见的大厂变量，避免把无关的 key 当成模型 provider。
 */
const CREDENTIAL_PROVIDERS = {
  ANTHROPIC_API_KEY: ["anthropic"],
  OPENAI_API_KEY: ["openai"],
  DEEPSEEK_API_KEY: ["deepseek"],
  MOONSHOT_API_KEY: ["moonshotai-cn"],
  KIMI_API_KEY: ["kimi-coding"],
  ARK_API_KEY: ["ark"],
  VOLC_ARK_API_KEY: ["ark"],
  ZAI_API_KEY: ["zai-coding-cn"],
  ZHIPU_API_KEY: ["zai-coding-cn"],
  GLM_API_KEY: ["zai-coding-cn"],
  GOOGLE_API_KEY: ["google"],
  GEMINI_API_KEY: ["google"],
  OPENROUTER_API_KEY: ["openrouter"],
  GROQ_API_KEY: ["groq"],
  MISTRAL_API_KEY: ["mistral"],
  XAI_API_KEY: ["xai"],
};

/**
 * provider 别名：auth.json 里的键名与模型目录里的 provider 不一定同名
 * （例如 kimi-coding 的模型 provider 常常是 moonshotai-cn）。双向展开，判定时只查集合。
 */
const PROVIDER_ALIASES = {
  "moonshotai-cn": ["moonshotai", "moonshot"],
  "kimi-coding": ["kimi", "moonshotai", "moonshot"],
  "zai-coding-cn": ["zai", "zai-coding", "zhipu", "glm"],
  "ark-agent": ["ark"],
  ark: ["ark-agent"],
};

/** 通用规则：FOO_API_KEY → provider "foo"（仅用于 credentials.env 里的未知变量） */
const GENERIC_API_KEY = /^([A-Z][A-Z0-9_]*)_API_KEY$/;

/** 解析 agent 目录（与 index.mjs 的口径一致；单测注入临时目录） */
export function resolveAgentDir(agentDir) {
  return path.resolve(agentDir || process.env.PI_SHELL_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

/** 凭据「是否算存在」：只看有没有值，绝不返回/记录值本身 */
function hasCredentialValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (value && typeof value === "object") {
    return ["key", "apiKey", "accessToken", "refreshToken", "token"].some(
      (f) => typeof value[f] === "string" && value[f].trim().length > 0,
    );
  }
  return false;
}

function addWithAliases(set, provider) {
  const name = String(provider || "").trim();
  if (!name) return;
  set.add(name);
  for (const alias of PROVIDER_ALIASES[name] ?? []) set.add(alias);
  // 反向：别名本身作为键时，展开到规范名（例如 auth 里写 moonshot）
  for (const [canonical, aliases] of Object.entries(PROVIDER_ALIASES)) {
    if (canonical === name || aliases.includes(name)) {
      set.add(canonical);
      for (const a of aliases) set.add(a);
    }
  }
}

/** 读 auth.json：只用顶层 provider 键（嵌套对象里的字段不是 provider） */
function readAuthProviders(file, set) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // 坏 JSON 不算配置（pi 自己会报错），不要让 /api/models 500
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  for (const [provider, cred] of Object.entries(parsed)) {
    if (hasCredentialValue(cred)) addWithAliases(set, provider);
  }
}

/** 解析 credentials.env：`X_API_KEY=` 形式（值为空则忽略；值本身不落任何变量以外的地方） */
function parseCredentialsEnv(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!name || !value) continue;
    out.push(name);
  }
  return out;
}

/** credentials.env 里的变量名 → provider 名集合（只看非空值；值不进入任何返回结构） */
function addCredentialProvider(set, name) {
  const known = CREDENTIAL_PROVIDERS[name];
  if (known) {
    for (const p of known) addWithAliases(set, p);
    return;
  }
  const m = name.match(GENERIC_API_KEY);
  if (m) addWithAliases(set, m[1].toLowerCase());
}

/**
 * 读取「已配置 provider」原始键（不做别名展开）。
 * 只认两个配置文件：auth.json 顶层 provider 键 + credentials.env 的 *_API_KEY。
 * 进程环境变量（process.env）**不读**；env 参数仅为单测注入保留，且不参与判定。
 * @param {{agentDir?:string, env?:NodeJS.ProcessEnv}} [opts] env 已忽略（保留签名，见文件头 A 口径）
 * @returns {Set<string>} provider 名（不含任何 key 值）
 */
export function readConfiguredProviderNames({ agentDir } = {}) {
  const dir = resolveAgentDir(agentDir);
  const set = new Set();

  readAuthProviders(path.join(dir, "auth.json"), set);

  try {
    const creds = fs.readFileSync(path.join(dir, CREDENTIALS_FILE), "utf8");
    for (const name of parseCredentialsEnv(creds)) addCredentialProvider(set, name);
  } catch {
    // 没有 credentials.env 是正常情况
  }

  set.delete("");
  return set;
}

/**
 * 读取「已配置 provider」集合（含别名展开，供 annotateModels 判定）。
 * @param {{agentDir?:string, env?:NodeJS.ProcessEnv}} [opts] env 已忽略（保留签名，见文件头 A 口径）
 * @returns {Set<string>} provider 名（含别名），不含任何 key 值
 */
export function readConfiguredProviders({ agentDir } = {}) {
  const expanded = new Set();
  for (const name of readConfiguredProviderNames({ agentDir })) addWithAliases(expanded, name);
  return expanded;
}

/** 模型目录「声明过的 provider」：models.json 的 providers 键 + models-store.json 顶层键 */
export function readDeclaredProviders({ agentDir } = {}) {
  const dir = resolveAgentDir(agentDir);
  const set = new Set();

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      return null;
    }
  };

  const modelsJson = readJson("models.json");
  if (modelsJson?.providers && typeof modelsJson.providers === "object") {
    for (const provider of Object.keys(modelsJson.providers)) set.add(provider);
  }

  const store = readJson("models-store.json");
  if (store && typeof store === "object" && !Array.isArray(store)) {
    for (const provider of Object.keys(store)) set.add(provider);
  }

  return set;
}

/** 文件指纹（只暴露 mtime/size，不读内容） */
function fileFingerprint(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

let cache = null; // {stamp, value}

/** 指纹只由配置文件决定（环境变量不参与，故不再进 stamp） */
function computeStamp(dir) {
  return CACHE_FILES.map((f) => `${f}=${fileFingerprint(path.join(dir, f))}`).join("|");
}

/**
 * 带 mtime 缓存的配置快照。
 * @param {{agentDir?:string, env?:NodeJS.ProcessEnv, force?:boolean}} [opts] env 已忽略（保留签名）
 * @returns {{providers:Set<string>, configuredProviders:Set<string>, declaredProviders:Set<string>, files:Object, stamp:string}}
 */
export function getModelsConfig({ agentDir, force = false } = {}) {
  const dir = resolveAgentDir(agentDir);
  const stamp = computeStamp(dir);
  if (!force && cache && cache.stamp === stamp) return cache.value;

  const configuredProviders = readConfiguredProviderNames({ agentDir: dir });
  const providers = new Set();
  for (const name of configuredProviders) addWithAliases(providers, name);

  const value = {
    agentDir: dir,
    providers, // 含别名（判定用）
    configuredProviders, // 原始键（GET /api/models/reload 的 providers 展示用）
    declaredProviders: readDeclaredProviders({ agentDir: dir }),
    files: Object.fromEntries(CACHE_FILES.map((f) => [f, fileFingerprint(path.join(dir, f))])),
    stamp,
  };
  cache = { stamp, value };
  return value;
}

/** 显式清缓存（POST /api/models/reload 用） */
export function invalidateModelsConfig() {
  cache = null;
}

/** provider 是否已配置（含别名） */
export function isProviderConfigured(provider, configured) {
  if (!provider) return false;
  const set = configured instanceof Set ? configured : new Set(configured ?? []);
  return set.has(provider);
}

/**
 * 给模型打 `configured` 标记。
 * 判定口径：provider 命中已配置集合即为 true。
 * （baseUrl 指向本地/中转站的模型也走同一条规则——凭据是挂在 provider 键上的，
 *  不能靠 baseUrl 猜；这里只保证不因为 baseUrl 是 localhost 就误判为可用。）
 * @param {Array<object>} models pi 的 get_available_models 结果
 * @param {Set<string>|string[]} configured
 * @returns {Array<object>} 新数组，每项含 configured:boolean
 */
export function annotateModels(models, configured) {
  const set = configured instanceof Set ? configured : new Set(configured ?? []);
  return (Array.isArray(models) ? models : []).map((model) => ({
    ...model,
    configured: set.has(model?.provider),
  }));
}
