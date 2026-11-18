// 会话来源分类（origins）单测：
// ① 目录规则 ② 工具窗口边界（start-2s 内 / end+5s 外）③ 测试路径 ④ 手动覆盖优先 ⑤ 默认 user
// 附带：ToolWindowTracker 窗口累积/上限/未闭合窗口、OriginStore 原子写/去重/裁剪。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyOrigin,
  OriginStore,
  ToolWindowTracker,
  TOOL_WINDOW_BEFORE_MS,
  TOOL_WINDOW_AFTER_MS,
  TOOL_WINDOWS_MAX,
  ORIGINS_MAX_RECORDS,
} from "../src/origins.mjs";

const ROOTS = [];
function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-origins-test-"));
  ROOTS.push(root);
  return root;
}
test.after(() => {
  for (const root of ROOTS) fs.rmSync(root, { recursive: true, force: true });
});

const SESSIONS_ROOT = path.join("C:", "Users", "user", ".pi", "agent", "sessions");
const AGENT_ROOT = path.join("C:", "Users", "user", ".pi", "agent", "sessions-agents");
const USER_REL = "sessions/--C--Users-user--/01a1.jsonl";
const AGENT_REL = "sessions-agents/--C--Users-user--/01a2.jsonl";

test("规则 2：会话文件位于 agent 会话根下 → agent（agent-dir）", () => {
  const decided = classifyOrigin({
    fileRelPath: AGENT_REL,
    sessionsRoot: SESSIONS_ROOT,
    agentRoot: AGENT_ROOT,
    cwd: "C:\\Users\\user\\proj",
    createdAt: 1_000_000,
    toolWindows: [],
  });
  assert.deepEqual(decided, { origin: "agent", reason: "agent-dir" });

  // 绝对路径口径（SessionIndex 传的就是绝对 filePath）同样成立，Windows 大小写不敏感
  const viaAbsolute = classifyOrigin({
    fileRelPath: AGENT_REL,
    filePath: path.join(AGENT_ROOT.toUpperCase(), "--C--x--", "01a2.jsonl"),
    sessionsRoot: SESSIONS_ROOT,
    agentRoot: AGENT_ROOT,
    createdAt: 1_000_000,
    toolWindows: [],
  });
  assert.equal(viaAbsolute.origin, "agent");

  // 根外文件不受目录规则影响
  const notAgent = classifyOrigin({
    fileRelPath: USER_REL,
    filePath: path.join(SESSIONS_ROOT, "--C--Users-user--", "01a1.jsonl"),
    sessionsRoot: SESSIONS_ROOT,
    agentRoot: AGENT_ROOT,
    cwd: "C:\\Users\\user\\proj",
    createdAt: 1_000_000,
    toolWindows: [],
  });
  assert.deepEqual(notAgent, { origin: "user", reason: "default" });
});

test("规则 3：工具窗口边界 —— start-2s 内算 agent，start-2s 外/end+5s 外算 user", () => {
  const start = 1_700_000_000_000;
  const end = start + 10_000;
  const windows = [{ start, end }];
  const base = { fileRelPath: USER_REL, sessionsRoot: SESSIONS_ROOT, agentRoot: AGENT_ROOT, cwd: "C:\\Users\\user\\proj", toolWindows: windows };

  // 窗口正中
  assert.deepEqual(classifyOrigin({ ...base, createdAt: start + 1000 }), { origin: "agent", reason: "tool-window" });
  // 左边界：start-2s 恰好在内
  assert.deepEqual(classifyOrigin({ ...base, createdAt: start - TOOL_WINDOW_BEFORE_MS }), { origin: "agent", reason: "tool-window" });
  // 左边界外 1ms
  assert.equal(classifyOrigin({ ...base, createdAt: start - TOOL_WINDOW_BEFORE_MS - 1 }).origin, "user");
  // 右边界：end+5s 恰好在内
  assert.equal(classifyOrigin({ ...base, createdAt: end + TOOL_WINDOW_AFTER_MS }).origin, "agent");
  // 右边界外 1ms
  assert.equal(classifyOrigin({ ...base, createdAt: end + TOOL_WINDOW_AFTER_MS + 1 }).origin, "user");
  // ISO 字符串时间同样生效
  assert.equal(classifyOrigin({ ...base, createdAt: new Date(start + 500).toISOString() }).origin, "agent");
  // 多窗口：命中任意一个即可
  const multi = [{ start: 1, end: 2 }, { start, end }];
  assert.equal(classifyOrigin({ ...base, toolWindows: multi, createdAt: start + 1 }).origin, "agent");
});

test("规则 4：探针路径 / 临时 cwd → test", () => {
  const probe = classifyOrigin({
    fileRelPath: "sessions/pi-shell-e2e-probe/01a3.jsonl",
    sessionsRoot: SESSIONS_ROOT,
    agentRoot: AGENT_ROOT,
    cwd: "C:\\Users\\user\\proj",
    createdAt: 1_000_000,
    toolWindows: [],
  });
  assert.equal(probe.origin, "test");
  assert.equal(probe.reason, "test-path");

  for (const marker of ["pi-shell-probe", "pi-shell-audit"]) {
    const decided = classifyOrigin({
      fileRelPath: `sessions/${marker}/01a4.jsonl`,
      sessionsRoot: SESSIONS_ROOT,
      agentRoot: AGENT_ROOT,
      createdAt: 1_000_000,
      toolWindows: [],
    });
    assert.equal(decided.origin, "test");
  }

  // header.cwd 在系统临时目录下 → test（不依赖路径标记）
  const tempCwd = classifyOrigin({
    fileRelPath: USER_REL,
    sessionsRoot: SESSIONS_ROOT,
    agentRoot: AGENT_ROOT,
    cwd: path.join(os.tmpdir(), "some-scratch-workspace"),
    createdAt: 1_000_000,
    toolWindows: [],
  });
  assert.deepEqual(tempCwd, { origin: "test", reason: "test-cwd" });
});

test("规则 1：手动覆盖优先于目录/窗口/路径规则", () => {
  // 即便文件在 agent 根、时间在窗口内、路径带探针标记，sidecar 记录仍然优先
  const decided = classifyOrigin({
    fileRelPath: "sessions/pi-shell-probe/01a5.jsonl",
    filePath: path.join(AGENT_ROOT, "--C--x--", "01a5.jsonl"),
    sessionsRoot: SESSIONS_ROOT,
    agentRoot: AGENT_ROOT,
    cwd: path.join(os.tmpdir(), "scratch"),
    createdAt: 5_000,
    toolWindows: [{ start: 0, end: 10_000 }],
    manual: { origin: "user", reason: "manual" },
  });
  assert.deepEqual(decided, { origin: "user", reason: "manual" });

  // 手动改成 test 也生效（用户可纠正误判）
  assert.equal(
    classifyOrigin({ fileRelPath: USER_REL, sessionsRoot: SESSIONS_ROOT, agentRoot: AGENT_ROOT, createdAt: 1, manual: { origin: "test", reason: "hand-edited" } }).origin,
    "test",
  );
});

test("规则 5：都不命中 → user（default）", () => {
  assert.deepEqual(
    classifyOrigin({
      fileRelPath: USER_REL,
      sessionsRoot: SESSIONS_ROOT,
      agentRoot: AGENT_ROOT,
      cwd: "C:\\Users\\user\\proj",
      createdAt: 1_000_000,
      toolWindows: [{ start: 2_000_000, end: 2_001_000 }],
    }),
    { origin: "user", reason: "default" },
  );
  // 无任何上下文也不炸
  assert.equal(classifyOrigin({}).origin, "user");
});

test("ToolWindowTracker：start/end 成窗、未闭合窗口按「仍在执行」、只保留最近 200 个", () => {
  const tracker = new ToolWindowTracker();
  tracker.note({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" }, 1000);
  tracker.note({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash" }, 2000);
  assert.deepEqual(tracker.snapshot(3000), [{ start: 1000, end: 2000, tool: "bash" }]);

  // 未闭合（工具还在跑）：end 取快照时刻
  tracker.note({ type: "tool_execution_start", toolCallId: "c2", toolName: "subagent" }, 4000);
  assert.deepEqual(tracker.snapshot(9000), [
    { start: 1000, end: 2000, tool: "bash" },
    { start: 4000, end: 9000, tool: "subagent", open: true },
  ]);

  // 非工具事件忽略
  tracker.note({ type: "agent_start" }, 9500);
  assert.equal(tracker.snapshot(9600).length, 2);

  // 上限 200
  const many = new ToolWindowTracker();
  for (let i = 0; i < TOOL_WINDOWS_MAX + 20; i++) {
    many.note({ type: "tool_execution_start", toolCallId: `m${i}` }, i * 10);
    many.note({ type: "tool_execution_end", toolCallId: `m${i}` }, i * 10 + 5);
  }
  const snapshot = many.snapshot();
  assert.equal(snapshot.length, TOOL_WINDOWS_MAX);
  assert.equal(snapshot[snapshot.length - 1].start, (TOOL_WINDOWS_MAX + 19) * 10);

  // seed：证据脚本注入固定窗口
  const seeded = new ToolWindowTracker().seed([{ start: 1, end: 2 }, { start: "x" }]);
  assert.equal(seeded, 1);
});

test("OriginStore：原子写 + 读回 + 去重 + 裁剪最旧", async () => {
  const root = newRoot();
  const file = path.join(root, "sessions-origins.json");
  const store = new OriginStore({ filePath: file });
  store.loadSync(); // 文件不存在：空 store，不抛

  assert.equal(store.set(USER_REL, { origin: "user", reason: "default" }, new Date("2026-01-01T00:00:00.000Z")), true);
  assert.equal(store.set(USER_REL, { origin: "user", reason: "default" }, new Date("2026-01-01T00:00:00.000Z")), false, "同内容不重复落盘");
  assert.equal(store.set(AGENT_REL.replace(/\\/g, "\\\\"), { origin: "agent", reason: "agent-dir" }), true, "反斜杠键归一后仍唯一");
  assert.equal(store.size, 2);

  await store.flush();
  assert.ok(fs.existsSync(file), "sidecar 已生成");
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes(".tmp")), [], "临时文件已 rename 清理");

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), [AGENT_REL, USER_REL].sort());
  assert.equal(raw[USER_REL].origin, "user");
  assert.equal(raw[USER_REL].classifiedAt, "2026-01-01T00:00:00.000Z");

  // 读回（模拟重启）
  const reloaded = new OriginStore({ filePath: file }).loadSync();
  assert.deepEqual(reloaded.get(USER_REL), raw[USER_REL]);
  assert.equal(reloaded.get("nope.jsonl"), null);

  // 裁剪：超过 maxRecords 删 classifiedAt 最旧的
  const trimFile = path.join(root, "trim.json");
  const trimStore = new OriginStore({ filePath: trimFile, maxRecords: 3 });
  for (let i = 0; i < 6; i++) {
    trimStore.set(`sessions/x-${i}/s.jsonl`, { origin: "user", reason: "default" }, new Date(2026, 0, i + 1));
  }
  await trimStore.flush();
  const trimmed = JSON.parse(fs.readFileSync(trimFile, "utf8"));
  assert.deepEqual(Object.keys(trimmed), ["sessions/x-3/s.jsonl", "sessions/x-4/s.jsonl", "sessions/x-5/s.jsonl"]);
  assert.ok(ORIGINS_MAX_RECORDS >= 3);
});

test("OriginStore：坏文件只告警不抛，非法 origin 被忽略", () => {
  const root = newRoot();
  const file = path.join(root, "bad.json");
  fs.writeFileSync(file, "{ not json", "utf8");
  const warnings = [];
  const store = new OriginStore({ filePath: file, log: (_lvl, event) => warnings.push(event) }).loadSync();
  assert.equal(store.size, 0);
  assert.deepEqual(warnings, ["origins_load_failed"]);

  fs.writeFileSync(file, JSON.stringify({ "a.jsonl": { origin: "bogus" }, "b.jsonl": { origin: "agent", reason: "tool-window" } }), "utf8");
  const ok = new OriginStore({ filePath: file }).loadSync();
  assert.equal(ok.size, 1);
  assert.equal(ok.get("b.jsonl").origin, "agent");
});
