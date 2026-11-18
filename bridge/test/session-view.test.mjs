// B1 / T5 单测：会话视图（GET /api/session/view）与清单端点的引擎解析。
//
// 这里只测**纯解析**（session-view.mjs）；HTTP 状态码与真实子进程由
// scripts/evidence/session-view-api.mjs（端口 7834）覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionView,
  normalizeModel,
  pickSessionEngine,
  pickReadEngine,
} from "../src/session-view.mjs";

const STATE = {
  sessionId: "01a1-session",
  sessionFile: "C:\\Users\\user\\pi-shell\\.pi\\sessions\\a.jsonl",
  model: { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat", extra: "ignored" },
  thinkingLevel: "high",
  isStreaming: false,
};

function makeEngine({ cwd = "C:\\Users\\user\\pi-shell", mcp = ["filesystem"], claim = null, state = STATE } = {}) {
  const engine = { id: "col-a", mcp: [...mcp], extra: { cwd, claim } };
  engine.rpc = { lastGetState: state };
  engine.sessionFile = state?.sessionFile ?? null;
  Object.defineProperty(engine, "claimedSessionFile", { get: () => engine.extra.claim });
  return engine;
}

test("view 字段齐全：cwd / sessionFile / model / thinkingLevel / mcp", () => {
  const view = buildSessionView(makeEngine());
  assert.deepEqual(Object.keys(view).sort(), ["cwd", "mcp", "model", "sessionFile", "thinkingLevel"]);
  assert.equal(view.cwd, "C:\\Users\\user\\pi-shell");
  assert.equal(view.sessionFile, STATE.sessionFile);
  assert.deepEqual(view.model, { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" });
  assert.equal(view.thinkingLevel, "high");
  assert.deepEqual(view.mcp, ["filesystem"]);
});

test("view：cwd 取引擎当前值（T2 回写后的会话目录），不读 get_state 的 cwd", () => {
  const engine = makeEngine({ cwd: "C:\\Users\\user\\pi-shell", state: { ...STATE, cwd: "C:\\stale" } });
  assert.equal(buildSessionView(engine).cwd, "C:\\Users\\user\\pi-shell");
});

test("view：未有 get_state 的 sessionFile 时回落到已打开的会话文件（claim）", () => {
  const engine = makeEngine({ state: { ...STATE, sessionFile: null }, claim: "C:\\tmp\\claimed.jsonl" });
  assert.equal(buildSessionView(engine).sessionFile, "C:\\tmp\\claimed.jsonl");
});

test("view：无模型 / 无 mcp 时返回 null 与空数组（不返回 undefined）", () => {
  const engine = makeEngine({ mcp: [], state: { sessionId: "s", sessionFile: null } });
  const view = buildSessionView(engine);
  assert.equal(view.model, null);
  assert.equal(view.thinkingLevel, null);
  assert.deepEqual(view.mcp, []);
});

test("normalizeModel：只透出 provider/id/name", () => {
  assert.deepEqual(normalizeModel({ provider: "p", id: "m", name: "N", secret: "x" }), {
    provider: "p",
    id: "m",
    name: "N",
  });
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel("deepseek"), null);
});

test("未知 client：view 引擎解析为 null（路由回 404 NOT_FOUND，且不创建引擎）", () => {
  const primary = makeEngine();
  const calls = [];
  const engine = pickSessionEngine({
    client: "no-such-column",
    find: (id) => {
      calls.push(id);
      return null;
    },
    primary,
  });
  assert.equal(engine, null);
  assert.deepEqual(calls, ["no-such-column"]);
});

test("view 未带 client：用主引擎（既有脚本兼容）", () => {
  const primary = makeEngine();
  const engine = pickSessionEngine({ client: null, find: () => null, primary });
  assert.equal(engine, primary);
});

test("view 带存在的 client：用该列自己的引擎", () => {
  const primary = makeEngine({ cwd: "C:\\primary" });
  const own = makeEngine({ cwd: "C:\\col-b" });
  const engine = pickSessionEngine({ client: "col-b", find: (id) => (id === "col-b" ? own : null), primary });
  assert.equal(engine, own);
});

test("models 带 client：用该列引擎（不是主引擎）", () => {
  const primary = makeEngine({ cwd: "C:\\primary" });
  const own = makeEngine({ cwd: "C:\\col-b" });
  const engine = pickReadEngine({ client: "col-b", find: (id) => (id === "col-b" ? own : null), primary });
  assert.equal(engine, own);
});

test("models 不带 client：回落主引擎（既有脚本结果不变）", () => {
  const primary = makeEngine();
  const engine = pickReadEngine({ client: null, find: () => assert.fail("不应查池"), primary });
  assert.equal(engine, primary);
});

test("models 带未知 client：回落主引擎（不 404、不创建引擎）", () => {
  const primary = makeEngine();
  const engine = pickReadEngine({ client: "gone", find: () => null, primary });
  assert.equal(engine, primary);
});

test("commands：带 client 命中该列，未知/未带回落主引擎", () => {
  const primary = makeEngine();
  const own = makeEngine({ cwd: "C:\\col-b" });
  const find = (id) => (id === "col-b" ? own : null);
  assert.equal(pickReadEngine({ client: "col-b", find, primary }), own);
  assert.equal(pickReadEngine({ client: "gone", find, primary }), primary);
  assert.equal(pickReadEngine({ client: null, find, primary }), primary);
});
