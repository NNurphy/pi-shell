// 会话记忆 sidecar（v1.0.0）：桥重启后第一次认领也要接回原会话。
// 单测覆盖：① 写入（结构 / updatedAt / 原子写无 tmp 残留）② 加载 ③ 损坏容错
// ④ LRU 上限 ⑤ 路径口径（PI_SHELL_LAST_SESSIONS_FILE > PI_SHELL_SESSIONS_DIR 旁 > agentDir）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionMemoryStore,
  resolveLastSessionsFile,
  normalizeSessionRecord,
  SESSION_MEMORY_VERSION,
  SESSION_MEMORY_MAX,
  LAST_SESSIONS_FILE_NAME,
} from "../src/session-memory.mjs";

const ROOTS = [];
function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-session-memory-test-"));
  ROOTS.push(root);
  return root;
}
test.after(() => {
  for (const root of ROOTS) fs.rmSync(root, { recursive: true, force: true });
});

const SESSIONS_DIR = path.join("C:", "Users", "user", ".pi", "agent", "sessions");
const AGENT_DIR = path.join("C:", "Users", "user", ".pi", "agent");
const SESSION_A = path.join("C:", "Users", "user", "proj-a", "sessions", "01a1.jsonl");
const SESSION_B = path.join("C:", "Users", "user", "proj-b", "sessions", "01a2.jsonl");

function record(overrides = {}) {
  return {
    path: SESSION_A,
    cwd: path.dirname(path.dirname(SESSION_A)),
    model: { provider: "fake", id: "fake-default", name: "Fake Default" },
    thinkingLevel: "off",
    at: 1_700_000_000_000,
    ...overrides,
  };
}

test("路径口径：显式覆盖 > PI_SHELL_SESSIONS_DIR 旁 > agentDir", () => {
  const override = path.join(os.tmpdir(), "fixture-override.json");
  assert.equal(
    resolveLastSessionsFile({
      env: { PI_SHELL_LAST_SESSIONS_FILE: override, PI_SHELL_SESSIONS_DIR: SESSIONS_DIR },
      agentDir: AGENT_DIR,
      sessionsDir: SESSIONS_DIR,
    }),
    path.resolve(override),
  );
  // 测试隔离（PI_SHELL_SESSIONS_DIR）→ 与 sessions-origins.json 同口径：落在该目录旁，不污染真实 agent 目录
  assert.equal(
    resolveLastSessionsFile({ env: {}, agentDir: AGENT_DIR, sessionsDir: SESSIONS_DIR }),
    path.join(path.dirname(SESSIONS_DIR), LAST_SESSIONS_FILE_NAME),
  );
  assert.equal(
    resolveLastSessionsFile({ env: {}, agentDir: AGENT_DIR, sessionsDir: "" }),
    path.join(AGENT_DIR, LAST_SESSIONS_FILE_NAME),
  );
});

test("写入：结构 / updatedAt / 原子写（无 .tmp 残留）", async () => {
  const file = path.join(newRoot(), "pi-shell-last-sessions.json");
  const store = new SessionMemoryStore({ filePath: file });
  store.set("client-a", record(), { delay: 0 });
  store.set("client-b", record({ path: SESSION_B, at: 1_700_000_000_500 }), { delay: 0 });
  await store.flush();

  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(doc.version, SESSION_MEMORY_VERSION);
  assert.equal(Number.isFinite(Date.parse(doc.updatedAt)), true, `updatedAt 应为 ISO：${doc.updatedAt}`);
  assert.deepEqual(Object.keys(doc.sessions).sort(), ["client-a", "client-b"]);
  assert.equal(doc.sessions["client-a"].path, path.resolve(SESSION_A));
  assert.equal(doc.sessions["client-a"].cwd, path.resolve(path.dirname(path.dirname(SESSION_A))));
  assert.deepEqual(doc.sessions["client-a"].model, { provider: "fake", id: "fake-default", name: "Fake Default" });
  assert.equal(doc.sessions["client-a"].thinkingLevel, "off");
  assert.equal(doc.sessions["client-a"].at, 1_700_000_000_000);

  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "原子写不应留下临时文件");
});

test("加载：桥重启后从 sidecar 读回记忆（含 ISO at 手改容错）", () => {
  const root = newRoot();
  const file = path.join(root, "pi-shell-last-sessions.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-11-14T00:00:00.000Z",
      sessions: {
        "client-a": record(),
        "client-iso": record({ path: SESSION_B, at: "2026-11-14T01:00:00.000Z" }),
      },
    })}\n`,
    "utf8",
  );

  const loaded = new SessionMemoryStore({ filePath: file }).loadSync();
  assert.equal(loaded.size, 2);
  assert.equal(loaded.get("client-a")?.path, path.resolve(SESSION_A));
  assert.equal(loaded.get("client-iso")?.at, Date.parse("2026-11-14T01:00:00.000Z"));
  assert.equal(loaded.get("missing"), null);

  // 返回的是副本：调用方改记录不会污染 store
  const copy = loaded.get("client-a");
  copy.path = "C:\\evil.jsonl";
  assert.equal(loaded.get("client-a")?.path, path.resolve(SESSION_A));
});

test("损坏容错：坏 JSON / 缺 sessions / 坏记录 → 空表或跳过，不抛、有 warn", () => {
  const logs = [];
  const log = (level, event, fields) => logs.push({ level, event, fields });
  const root = newRoot();

  const broken = path.join(root, "broken.json");
  fs.writeFileSync(broken, "{ this is not json", "utf8");
  const store1 = new SessionMemoryStore({ filePath: broken, log }).loadSync();
  assert.equal(store1.size, 0);
  assert.equal(logs.some((entry) => entry.event === "session_memory_load_failed" && entry.level === "warn"), true);

  logs.length = 0;
  const noSessions = path.join(root, "no-sessions.json");
  fs.writeFileSync(noSessions, `${JSON.stringify({ version: 1 })}\n`, "utf8");
  assert.equal(new SessionMemoryStore({ filePath: noSessions, log }).loadSync().size, 0);
  assert.equal(logs.some((entry) => entry.event === "session_memory_load_failed"), true);

  // 坏记录跳过，好记录保留（不整表报废）
  const mixed = path.join(root, "mixed.json");
  fs.writeFileSync(
    mixed,
    `${JSON.stringify({
      version: 1,
      sessions: {
        good: record(),
        "no-path": { cwd: "C:\\tmp", at: 1 },
        "bad-shape": "just a string",
        "": record(),
      },
    })}\n`,
    "utf8",
  );
  const mixedStore = new SessionMemoryStore({ filePath: mixed, log }).loadSync();
  assert.equal(mixedStore.size, 1);
  assert.equal(mixedStore.has("good"), true);

  // 文件不存在：静默空表（不是 warn 噪音）
  const missingLogs = [];
  const missing = new SessionMemoryStore({ filePath: path.join(root, "nope.json"), log: (l, e) => missingLogs.push(e) }).loadSync();
  assert.equal(missing.size, 0);
  assert.deepEqual(missingLogs, []);
});

test("LRU 上限：超过 max 淘汰 at 最旧的，且淘汰结果落盘", async () => {
  const file = path.join(newRoot(), "pi-shell-last-sessions.json");
  const store = new SessionMemoryStore({ filePath: file, max: 3 });
  for (let i = 0; i < 5; i += 1) {
    store.set(`client-${i}`, record({ at: 1_700_000_000_000 + i * 1000 }), { delay: 0 });
  }
  assert.equal(store.size, 3);
  assert.deepEqual([...["client-0", "client-1", "client-2", "client-3", "client-4"]].filter((id) => store.has(id)), [
    "client-2",
    "client-3",
    "client-4",
  ]);
  await store.flush();
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(doc.sessions).sort(), ["client-2", "client-3", "client-4"]);

  // 生产上限就是 SESSION_MEMORY_MAX（更小的 max 只是测试便利）
  assert.equal(SESSION_MEMORY_MAX, 64);
});

test("删除：delete 后不再在内存/落盘里（恢复时文件已删 → 移除该条）", async () => {
  const file = path.join(newRoot(), "pi-shell-last-sessions.json");
  const store = new SessionMemoryStore({ filePath: file });
  store.set("client-a", record(), { delay: 0 });
  await store.flush();
  assert.equal(store.has("client-a"), true);

  assert.equal(store.delete("client-a", { delay: 0 }), true);
  assert.equal(store.delete("client-a"), false, "重复删除应返回 false");
  await store.flush();
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(doc.sessions, {});
});

test("normalizeSessionRecord：无 path / 非对象 → null（坏记录不落盘）", () => {
  assert.equal(normalizeSessionRecord(null), null);
  assert.equal(normalizeSessionRecord("C:\\a.jsonl"), null);
  assert.equal(normalizeSessionRecord({ cwd: "C:\\tmp" }), null);
  assert.equal(normalizeSessionRecord({ path: "  " }), null);
  assert.deepEqual(normalizeSessionRecord({ path: SESSION_A }), {
    path: path.resolve(SESSION_A),
    cwd: null,
    model: null,
    thinkingLevel: null,
    at: 0,
  });
});