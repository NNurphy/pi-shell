// T-04 单测：id 配对队列 / 超时不重发 / EXTRA_ARGS 解析（不 spawn 真 pi）
import test from "node:test";
import assert from "node:assert/strict";
import { PiRpc, HANDSHAKE_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "../src/rpc.mjs";

const noopLog = () => {};

/** 把 PiRpc 挂到一个假子进程上：记录写入内容，不真起进程 */
function attachFakeChild(rpc) {
  const writes = [];
  const stdin = {
    writable: true,
    write(buf) {
      writes.push(buf);
      return true;
    },
    once() {},
    on() {},
  };
  rpc.child = { pid: 4242, stdin, stdout: { on() {}, setEncoding() {} }, stderr: { on() {}, setEncoding() {} }, on() {}, once() {}, kill() {} };
  return writes;
}

function makeRpc(overrides = {}) {
  return new PiRpc({
    cliPath: "C:/fake/cli.js",
    agentDir: "C:/fake/agent",
    installDir: "C:/fake/install",
    workspaceCwd: "C:/fake",
    log: noopLog,
    ...overrides,
  });
}

test("乱序响应：两个请求的 response 逆序到达，各归各位", async () => {
  const rpc = makeRpc();
  const writes = attachFakeChild(rpc);

  const p1 = rpc.request("get_state", {}, { id: "a1", timeoutMs: 5000 });
  const p2 = rpc.request("get_entries", {}, { id: "b2", timeoutMs: 5000 });
  assert.equal(writes.length, 2);

  // 先回后发的 b2，再回 a1
  rpc._onRecord({ type: "response", id: "b2", command: "get_entries", success: true, data: { entries: [1, 2] } });
  rpc._onRecord({ type: "response", id: "a1", command: "get_state", success: true, data: { sessionId: "s1" } });

  assert.deepEqual(await p2, { entries: [1, 2] });
  assert.deepEqual(await p1, { sessionId: "s1" });
  assert.equal(rpc._pending.size, 0);
});

test("失败响应：reject 带 PI_ERROR 与 pi 的错误文本", async () => {
  const rpc = makeRpc();
  attachFakeChild(rpc);
  const p = rpc.request("set_model", { provider: "x", modelId: "y" }, { id: "m1", timeoutMs: 5000 });
  rpc._onRecord({ type: "response", id: "m1", command: "set_model", success: false, error: "Model not found" });
  await assert.rejects(p, (err) => {
    assert.equal(err.code, "PI_ERROR");
    assert.match(err.message, /Model not found/);
    return true;
  });
});

test("超时：拒绝但**不重发**（写入次数保持 1）", async () => {
  const rpc = makeRpc();
  const writes = attachFakeChild(rpc);
  const p = rpc.request("get_state", {}, { id: "t1", timeoutMs: 30 });
  assert.equal(writes.length, 1);
  await assert.rejects(p, (err) => err.code === "TIMEOUT");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(writes.length, 1, "超时后不得重发");
  assert.equal(rpc._pending.size, 0, "超时后必须清理 pending");
});

test("迟到的 response 不会串到别的请求上（已超时的 id 被忽略）", async () => {
  const rpc = makeRpc();
  attachFakeChild(rpc);
  const p = rpc.request("get_state", {}, { id: "late", timeoutMs: 20 });
  await assert.rejects(p, (err) => err.code === "TIMEOUT");
  // 迟到响应：应被当作 unmatched 忽略，不抛错
  rpc._onRecord({ type: "response", id: "late", command: "get_state", success: true, data: { x: 1 } });
  assert.equal(rpc._pending.size, 0);
});

test("子进程关闭：在途请求全部 reject 为 PI_NOT_READY", async () => {
  const rpc = makeRpc();
  attachFakeChild(rpc);
  const p = rpc.request("get_state", {}, { id: "c1", timeoutMs: 5000 });
  rpc._rejectPending("test-close");
  await assert.rejects(p, (err) => err.code === "PI_NOT_READY");
  assert.equal(rpc._pending.size, 0);
});

test("无子进程时 request 直接 reject PI_NOT_READY（不写不挂）", async () => {
  const rpc = makeRpc();
  await assert.rejects(rpc.request("get_state"), (err) => err.code === "PI_NOT_READY");
});

test("EXTRA_ARGS：JSON 数组保留含空格路径为单个元素", () => {
  const rpc = makeRpc({ extraArgs: '["-e","C:/Users/user/my ext/select demo.ts"]' });
  assert.deepEqual(rpc.args(), ["--mode", "rpc", "-e", "C:/Users/user/my ext/select demo.ts"]);
});

test("EXTRA_ARGS：空值不加参数；非 JSON 退化为空白切分", () => {
  assert.deepEqual(makeRpc({ extraArgs: "" }).extraArgs(), []);
  assert.deepEqual(makeRpc({ extraArgs: "   " }).extraArgs(), []);
  assert.deepEqual(makeRpc({ extraArgs: "--name  hello --no-tools" }).args(), [
    "--mode",
    "rpc",
    "--name",
    "hello",
    "--no-tools",
  ]);
});

test("EXTRA_ARGS：JSON 数组里的非字符串元素 → 视为非法，退化为空白切分", () => {
  const rpc = makeRpc({ extraArgs: '["--no-tools", 42]' });
  assert.deepEqual(rpc.extraArgs(), ['["--no-tools",', "42]"]);
});

test("EXTRA_ARGS：--session-dir 仍作为两个参数前置", () => {
  const rpc = makeRpc({ sessionsDir: "C:/tmp/pi shell sessions", extraArgs: '["--no-tools"]' });
  assert.deepEqual(rpc.args(), ["--mode", "rpc", "--session-dir", "C:/tmp/pi shell sessions", "--no-tools"]);
});

test("AGENT_DIR_OVERRIDE：PI_CODING_AGENT_DIR 指向 shim（MCP 按需），未给时用 agentDir", () => {
  const base = makeRpc({});
  assert.equal(base.env().PI_CODING_AGENT_DIR, base.opts.agentDir);
  const shim = makeRpc({ agentDirOverride: "C:/tmp/shim-1" });
  assert.equal(shim.env().PI_CODING_AGENT_DIR, "C:/tmp/shim-1");
});

test("NO_MCP：true 时在 extraArgs 之前追加 --no-mcp", () => {
  assert.deepEqual(makeRpc({ noMcp: true }).args(), ["--mode", "rpc", "--no-mcp"]);
  assert.deepEqual(makeRpc({ noMcp: true, sessionsDir: "C:/tmp/s" }).args(), [
    "--mode",
    "rpc",
    "--session-dir",
    "C:/tmp/s",
    "--no-mcp",
  ]);
  // 缺省/显式 false 不加参数（既有行为）
  assert.deepEqual(makeRpc({}).args(), ["--mode", "rpc"]);
  assert.deepEqual(makeRpc({ noMcp: false }).args(), ["--mode", "rpc"]);
});

test("MODEL_PASSTHROUGH：provider/model 给了才加 --provider/--model，未给参数列表不变", () => {
  // 未给 / 空串 / 纯空白 / 非字符串 → 不加参数（旧行为不变：桥不替用户选模型）
  assert.deepEqual(makeRpc({}).args(), ["--mode", "rpc"]);
  assert.deepEqual(makeRpc({ provider: "", model: "" }).args(), ["--mode", "rpc"]);
  assert.deepEqual(makeRpc({ provider: "   ", model: "\t" }).args(), ["--mode", "rpc"]);
  assert.deepEqual(makeRpc({ provider: null, model: undefined }).args(), ["--mode", "rpc"]);
  // 只给一个也只加一个
  assert.deepEqual(makeRpc({ model: "deepseek-flash" }).args(), ["--mode", "rpc", "--model", "deepseek-flash"]);
  assert.deepEqual(makeRpc({ provider: "bailian-token-plan" }).args(), [
    "--mode",
    "rpc",
    "--provider",
    "bailian-token-plan",
  ]);
  // 两个都给：--provider 在前、--model 在后，位置在 --no-mcp 之后 / extraArgs 之前
  assert.deepEqual(
    makeRpc({
      provider: "bailian-token-plan",
      model: "deepseek-v4.1-flash-1017",
      noMcp: true,
      sessionsDir: "C:/tmp/s",
      extraArgs: "--no-tools",
    }).args(),
    [
      "--mode",
      "rpc",
      "--session-dir",
      "C:/tmp/s",
      "--no-mcp",
      "--provider",
      "bailian-token-plan",
      "--model",
      "deepseek-v4.1-flash-1017",
      "--no-tools",
    ],
  );
  // 值去空白（env 带尾随空格不能把模型名带坏）
  assert.deepEqual(makeRpc({ provider: " p ", model: " m " }).args(), ["--mode", "rpc", "--provider", "p", "--model", "m"]);
});

test("MODEL_PASSTHROUGH：modelOptions() 给出 engine_spawn 日志用的归一化字段", () => {
  assert.deepEqual(makeRpc({}).modelOptions(), { provider: null, model: null });
  assert.deepEqual(makeRpc({ provider: "  ", model: "" }).modelOptions(), { provider: null, model: null });
  assert.deepEqual(
    makeRpc({ provider: " bailian-token-plan ", model: "deepseek-v4.1-flash-1017" }).modelOptions(),
    { provider: "bailian-token-plan", model: "deepseek-v4.1-flash-1017" },
  );
});

test("默认超时常量为 30s；握手为 15s", async () => {
  const rpc = makeRpc();
  assert.equal(rpc.requestTimeoutMs, 30000);
  assert.equal(REQUEST_TIMEOUT_MS, 30000);
  assert.equal(HANDSHAKE_TIMEOUT_MS, 15000);
});

test("握手失败或超时 → 终止子进程（随后走 close 崩溃路径）", async () => {
  const rpc = makeRpc();
  const killed = [];
  rpc.child = {
    pid: 77,
    stdin: { writable: true, write: () => true, once() {}, on() {} },
    stdout: { on() {}, setEncoding() {} },
    stderr: { on() {}, setEncoding() {} },
    on() {},
    once() {},
    kill(sig) {
      killed.push(sig);
    },
  };
  rpc.request = () => Promise.reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" }));
  rpc._handshake();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(killed, ["SIGTERM"]);
});

test("背压：write 返回 false 时后续写入等 drain（不丢记录）", async () => {
  const rpc = makeRpc();
  const writes = [];
  const drainHandlers = [];
  const stdin = {
    writable: true,
    write(buf) {
      writes.push(buf);
      return writes.length !== 1; // 第一条返回 false，模拟背压
    },
    once(evt, cb) {
      if (evt === "drain") drainHandlers.push(cb);
    },
    on() {},
  };
  rpc.child = { pid: 1, stdin, stdout: { on() {}, setEncoding() {} }, stderr: { on() {}, setEncoding() {} }, on() {}, once() {}, kill() {} };

  rpc._write({ id: "w1", type: "get_state" });
  rpc._write({ id: "w2", type: "get_state" });
  assert.equal(writes.length, 1, "第一条未 drain 前不应写第二条");
  assert.equal(rpc._writeQueue.length, 1);

  // 触发 drain → 队列继续排空
  drainHandlers.shift()();
  assert.equal(writes.length, 2);
  assert.match(writes[1], /"w2"/);
  assert.equal(rpc._writeQueue.length, 0);
});
