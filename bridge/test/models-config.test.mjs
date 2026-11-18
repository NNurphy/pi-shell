// 「已配置模型」判定单测（B7）
// ① 只读 auth.json 顶层 provider 键 ② 环境变量 ③ 不泄露 key 值
// ④ mtime 变化使缓存失效 ⑤ ?all=1 的全量语义（annotateModels 全量返回 + configured 标记）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readConfiguredProviders,
  readDeclaredProviders,
  getModelsConfig,
  invalidateModelsConfig,
  annotateModels,
  CACHE_FILES,
} from "../src/models-config.mjs";

const ROOTS = [];
function newAgentDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-models-test-"));
  ROOTS.push(root);
  const agent = path.join(root, "agent");
  fs.mkdirSync(agent, { recursive: true });
  return agent;
}
test.after(() => {
  for (const root of ROOTS) fs.rmSync(root, { recursive: true, force: true });
});

const SECRET_AUTH = "sk-ant-topsecret-0123456789abcdef";
const SECRET_ENV = "sk-openai-envsecret-fedcba9876543210";
const SECRET_FILE = "sk-deepseek-file-secret-abcdef0123456789";

function writeAuth(agent, obj) {
  fs.writeFileSync(path.join(agent, "auth.json"), JSON.stringify(obj, null, 2));
}

function sorted(set) {
  return [...set].sort();
}

// ---------- ① auth.json 只取顶层键 ----------

test("① 只读 auth.json 顶层 provider 键（嵌套字段不算 provider）", () => {
  const agent = newAgentDir();
  writeAuth(agent, {
    deepseek: { type: "api_key", key: SECRET_AUTH, meta: { anthropic: "not-a-provider" } },
    anthropic: { type: "api_key", key: "" }, // 空凭据不算
    "not-an-object": "plain-secret-value", // 非空字符串算（旧版迁移格式）
    empty: { type: "api_key", key: "" },
  });

  const providers = readConfiguredProviders({ agentDir: agent, env: {} });
  assert.deepEqual(sorted(providers), ["deepseek", "not-an-object"]);
  assert.equal(providers.has("meta"), false);
  assert.equal(providers.has("anthropic"), false, "空 key 不应算已配置");
});

// ---------- ② A 口径：只认配置文件，环境变量不参与 ----------

test("② credentials.env 的 X_API_KEY= 生效；注入的 env 不生效（A 口径）", () => {
  const agent = newAgentDir();
  fs.writeFileSync(path.join(agent, "credentials.env"), [
    "# comment",
    `DEEPSEEK_API_KEY=${SECRET_FILE}`,
    "ANTHROPIC_API_KEY=\"\"", // 空值忽略
    "TAVILY_API_KEY=tvly-123",
    "",
  ].join("\n"));

  const providers = readConfiguredProviders({
    agentDir: agent,
    // 注入的「环境变量」：历史上会让 openai / moonshot 变成已配置，A 口径后必须完全不参与
    env: {
      OPENAI_API_KEY: SECRET_ENV,
      MOONSHOT_API_KEY: "ms-secret-value",
      EMPTY_API_KEY: "",
      PATH: "/usr/bin",
    },
  });

  assert.equal(providers.has("deepseek"), true, "credentials.env 的 DEEPSEEK_API_KEY 仍然生效");
  assert.equal(providers.has("tavily"), true, "credentials.env 里表外的 X_API_KEY 走通用规则");
  assert.equal(providers.has("openai"), false, "env 不是配置文件，不得让 openai 变成已配置");
  assert.equal(providers.has("moonshotai-cn"), false, "env 不得让 moonshotai-cn 变成已配置");
  assert.equal(providers.has("anthropic"), false, "空值不算配置");
  assert.equal(providers.has("empty"), false, "空 env 值不算配置");
  assert.equal(providers.has("path"), false, "非 *_API_KEY 变量不参与");
});

test("②b 真实 process.env 里的 *_API_KEY 不得让 provider 变成已配置", () => {
  const agent = newAgentDir();
  writeAuth(agent, { deepseek: { type: "api_key", key: SECRET_AUTH } });

  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.OPENAI_API_KEY = SECRET_ENV;
  process.env.ANTHROPIC_API_KEY = "sk-ant-envsecret-0123456789";
  try {
    invalidateModelsConfig();
    const providers = readConfiguredProviders({ agentDir: agent }); // 不传 env：走默认
    assert.deepEqual(sorted([...providers].filter((p) => ["openai", "anthropic"].includes(p))), []);
    assert.deepEqual(sorted(providers), ["deepseek"]);
    // getModelsConfig 同理（stamp 只跟配置文件走）
    const cfg = getModelsConfig({ agentDir: agent, force: true });
    assert.deepEqual(sorted(cfg.providers), ["deepseek"]);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------- ③ 不泄露值 ----------

test("③ 返回结构不含 key 明文（auth.json / credentials.env / 注入的 env 三路）", () => {
  const agent = newAgentDir();
  writeAuth(agent, { deepseek: { type: "api_key", key: SECRET_AUTH } });
  fs.writeFileSync(path.join(agent, "credentials.env"), `KIMI_API_KEY=${SECRET_FILE}\n`);
  const env = { OPENAI_API_KEY: SECRET_ENV }; // 注入但不应被读

  invalidateModelsConfig();
  const providers = readConfiguredProviders({ agentDir: agent, env });
  assert.equal(providers.has("openai"), false, "注入的 env 不得让 openai 变成已配置");
  const cfg = getModelsConfig({ agentDir: agent, env, force: true });
  const annotated = annotateModels(
    [{ provider: "deepseek", id: "deepseek-flash", baseUrl: "https://api.deepseek.com" }],
    cfg.providers,
  );

  // 所有可序列化的返回值都不得含 key 明文 / sk- 前缀 / 长 base64
  const payloads = [
    JSON.stringify(sorted(providers)),
    JSON.stringify(sorted(cfg.providers)),
    JSON.stringify([...cfg.declaredProviders]),
    JSON.stringify(cfg.files),
    JSON.stringify(cfg.stamp),
    JSON.stringify(annotated),
  ];
  for (const text of payloads) {
    for (const secret of [SECRET_AUTH, SECRET_ENV, SECRET_FILE]) {
      assert.equal(text.includes(secret), false, `返回值泄露了 key：${text.slice(0, 120)}`);
    }
    assert.equal(/sk-[A-Za-z0-9-]{6,}/.test(text), false, "返回值含 sk- 形式的明文");
    assert.equal(/[A-Za-z0-9+/]{40,}={0,2}/.test(text), false, "返回值含长 base64 段");
  }
});

// ---------- ④ mtime 缓存失效 ----------

test("④ auth.json mtime 变化 → 缓存失效并重读", () => {
  const agent = newAgentDir();
  writeAuth(agent, { deepseek: { type: "api_key", key: SECRET_AUTH } });
  invalidateModelsConfig();

  const first = getModelsConfig({ agentDir: agent, env: {} });
  assert.deepEqual(sorted(first.providers), ["deepseek"]);

  writeAuth(agent, {
    deepseek: { type: "api_key", key: SECRET_AUTH },
    openai: { type: "api_key", key: SECRET_ENV },
  });
  // 显式把 mtime 推到未来，避免同毫秒写入导致指纹不变（Windows 时间粒度）
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(agent, "auth.json"), future, future);

  const second = getModelsConfig({ agentDir: agent, env: {} }); // 不带 force：靠指纹
  assert.deepEqual(sorted(second.providers), ["deepseek", "openai"]);
  assert.notEqual(second.stamp, first.stamp);
});

test("④b models.json / models-store.json 的 mtime 也参与失效", () => {
  const agent = newAgentDir();
  invalidateModelsConfig();
  const first = getModelsConfig({ agentDir: agent, env: {} });
  assert.deepEqual([...first.declaredProviders], []);

  fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { localrelay: { models: [] } } }));
  const second = getModelsConfig({ agentDir: agent, env: {} });
  assert.deepEqual([...second.declaredProviders], ["localrelay"]);
  assert.notEqual(second.stamp, first.stamp);
});

test("④c 缓存命中返回同一快照；force=true 绕过缓存（重启按钮/排障用）", () => {
  const agent = newAgentDir();
  writeAuth(agent, { ark: { type: "api_key", key: SECRET_AUTH } });
  invalidateModelsConfig();

  const first = getModelsConfig({ agentDir: agent, env: {} });
  assert.deepEqual(sorted(first.providers), ["ark", "ark-agent"]);

  const cached = getModelsConfig({ agentDir: agent, env: {} });
  assert.equal(cached, first, "文件没变时应返回同一个缓存快照");

  const forced = getModelsConfig({ agentDir: agent, env: {}, force: true });
  assert.notEqual(forced, first, "force=true 必须重读");
  assert.deepEqual(sorted(forced.providers), sorted(first.providers));
});

// ---------- ⑤ ?all=1 语义 ----------

test("⑤ 全量返回：每项都带 configured，默认过滤 == 只留 true", () => {
  const agent = newAgentDir();
  writeAuth(agent, { deepseek: { type: "api_key", key: SECRET_AUTH } });
  invalidateModelsConfig();
  const cfg = getModelsConfig({ agentDir: agent, env: {} });

  const raw = [
    { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5" },
    { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
    { provider: "deepseek", id: "deepseek-pro", name: "DeepSeek V4 Pro" },
    { provider: "openai", id: "gpt-x", name: "GPT X" },
  ];
  const all = annotateModels(raw, cfg.providers); // 等价于 ?all=1
  assert.equal(all.length, raw.length);
  assert.deepEqual(all.map((m) => m.configured), [false, true, true, false]);

  const usable = all.filter((m) => m.configured); // 等价于默认 /api/models
  assert.equal(usable.length, 2);
  assert.ok(usable.every((m) => m.provider === "deepseek"));
  // 原始数组不被修改
  assert.equal("configured" in raw[0], false);
});

test("⑤b 本地/中转 baseUrl 仍按 provider 键判定（不因 localhost 误判为可用）", () => {
  const agent = newAgentDir();
  writeAuth(agent, { duou: { type: "api_key", key: SECRET_AUTH } });
  invalidateModelsConfig();
  const cfg = getModelsConfig({ agentDir: agent, env: {} });
  const all = annotateModels([
    { provider: "duou", id: "relay-a", baseUrl: "http://127.0.0.1:8317/v1" },
    { provider: "openai", id: "relay-b", baseUrl: "http://localhost:11434/v1" },
  ], cfg.providers);
  assert.deepEqual(all.map((m) => m.configured), [true, false]);
});

test("缓存文件清单契约（auth.json / credentials.env / models.json / models-store.json）", () => {
  assert.deepEqual(CACHE_FILES, ["auth.json", "credentials.env", "models.json", "models-store.json"]);
  assert.equal(typeof readDeclaredProviders, "function");
});
