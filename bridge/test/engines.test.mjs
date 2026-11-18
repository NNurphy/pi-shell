// 第三批单测：引擎池（每标签页一个 pi 引擎 / 上限 / 同会话保护 / 空闲回收）
import test from "node:test";
import assert from "node:assert/strict";
import { Engine, EnginePool, DEFAULT_CLIENT, DEFAULT_IDLE_MS, MAX_PIN_MS, DEFAULT_ADOPT_GRACE_MS, resolveMaxEngines, resolveIdleMs } from "../src/engines.mjs";

/** 假 PiRpc：只实现池/桥用到的部分 */
function fakeRpc({ state = "idle", pid = 1000, sessionFile = null, sessionId = null } = {}) {
  const rpc = {
    state,
    stopped: 0,
    lastGetState: { sessionFile, sessionId },
    snapshot: () => ({ pid, state: rpc.state }),
    stop: async () => {
      rpc.stopped += 1;
      rpc.state = "stopping";
    },
  };
  return rpc;
}

function makePool({ max = 2, idleMs = 60000, maxPinMs = MAX_PIN_MS, now = () => 1000 } = {}) {
  const created = [];
  const records = []; // 日志断言用（级别/事件/字段）
  const pool = new EnginePool({
    max,
    idleMs,
    maxPinMs,
    now,
    log: (level, event, fields) => records.push({ level, event, fields }),
    create: (clientId) => {
      const engine = new Engine({ id: clientId, owner: clientId, rpc: fakeRpc({ pid: 1000 + created.length }) });
      engine.extra = { sseClients: new Set(), pendingExtDialogs: new Map(), cwd: "/x", claim: null };
      created.push(engine);
      return engine;
    },
  });
  return { pool, created, records };
}

test("resolveMaxEngines：默认 4，非法值回落，1 合法", () => {
  assert.equal(resolveMaxEngines(undefined), 4);
  assert.equal(resolveMaxEngines(""), 4);
  assert.equal(resolveMaxEngines("1"), 1);
  assert.equal(resolveMaxEngines("8"), 8);
  assert.equal(resolveMaxEngines("0"), 4);
  assert.equal(resolveMaxEngines("abc"), 4);
  assert.equal(resolveMaxEngines("-3"), 4);
});

test("Engine.mcp：默认空名单（= 不带 MCP），数组入参去重，health 给拷贝", () => {
  assert.deepEqual(new Engine({ id: "a" }).mcp, []);
  const engine = new Engine({ id: "a", mcp: ["codegraph", "codegraph", "mcp-obsidian"] });
  assert.deepEqual(engine.mcp, ["codegraph", "mcp-obsidian"]);
  const health = engine.health();
  health.mcp.push("x"); // 外部改动不能影响引擎状态
  assert.deepEqual(engine.mcp, ["codegraph", "mcp-obsidian"]);
});

test("Engine：health/state/sessionFile 读的是自己的 rpc", () => {
  const engine = new Engine({ id: "a", owner: "a", rpc: fakeRpc({ pid: 42, sessionFile: "C:/s/x.jsonl", sessionId: "sid" }) });
  assert.equal(engine.state, "idle");
  assert.equal(engine.pid, 42);
  assert.equal(engine.sessionId, "sid");
  assert.deepEqual(engine.mcp, []); // 默认不带任何 MCP
  assert.deepEqual(engine.health(), {
    id: "a",
    client: "a",
    tab: null,
    state: "idle",
    sessionFile: "C:/s/x.jsonl",
    pid: 42,
    mcp: [],
  });
  engine.mcp = ["codegraph"];
  assert.deepEqual(engine.health().mcp, ["codegraph"]);
});

test("getOrCreate：命中原有引擎；新建后 size 增长", () => {
  const { pool, created } = makePool();
  const a = pool.getOrCreate("a");
  assert.equal(a.id, "a");
  assert.equal(pool.size, 1);
  assert.equal(pool.getOrCreate("a"), a); // 幂等
  pool.getOrCreate("b");
  assert.equal(pool.size, 2);
  assert.equal(created.length, 2);
});

test("getOrCreate：超过上限抛 PI_NOT_READY，文案含上限数", () => {
  const { pool } = makePool({ max: 2 });
  pool.getOrCreate("a");
  pool.getOrCreate("b");
  assert.throws(
    () => pool.getOrCreate("c"),
    (err) => err.code === "PI_NOT_READY" && err.status === 503 && /已达并行上限（2）/.test(err.message),
  );
  assert.equal(pool.size, 2); // 失败不占位
});

test("own：认领后引擎 id 改名、可按 owner 找到；改名不影响 rpc", () => {
  const { pool } = makePool();
  const boot = new Engine({ id: DEFAULT_CLIENT, owner: null, rpc: fakeRpc({ pid: 7 }) });
  boot.extra = { sseClients: new Set(), pendingExtDialogs: new Map(), cwd: "/x", claim: null };
  pool.add(boot);
  const same = pool.own(boot, "tab-1");
  assert.equal(same, boot);
  assert.equal(boot.id, "tab-1");
  assert.equal(boot.owner, "tab-1");
  assert.equal(pool.get("tab-1"), boot);
  assert.equal(pool.get(DEFAULT_CLIENT), null);
  assert.equal(pool.find("tab-1"), boot);
  assert.equal(pool.byOwner("tab-1"), boot);
  assert.equal(boot.pid, 7);
});

test("own：认领后取消 pinned（引导引擎转为可回收）", () => {
  const { pool } = makePool();
  const boot = new Engine({ id: DEFAULT_CLIENT, owner: null, pinned: true, rpc: fakeRpc() });
  boot.extra = { sseClients: new Set(), pendingExtDialogs: new Map(), cwd: "/x", claim: null };
  pool.add(boot);
  pool.own(boot, "tab-1");
  assert.equal(boot.pinned, false);
});

test("release：移除并停止 rpc，幂等", async () => {
  const { pool } = makePool();
  const a = pool.getOrCreate("a");
  assert.equal(await pool.release(a, "test"), true);
  assert.equal(pool.size, 0);
  assert.equal(a.rpc.stopped, 1);
  assert.equal(await pool.release(a, "test"), false);
});

test("sweep：有 SSE 连接 / 未到阈值 / pinned 都不回收；到点才回收", async () => {
  let clock = 0;
  const { pool } = makePool({ idleMs: 60000, max: 3, now: () => clock });
  const pinned = new Engine({ id: "boot", owner: null, pinned: true, rpc: fakeRpc() });
  pinned.extra = { sseClients: new Set(), pendingExtDialogs: new Map(), cwd: "/x", claim: null };
  pool.add(pinned);
  const a = pool.getOrCreate("a");
  const b = pool.getOrCreate("b");
  a.touch(0);
  b.touch(0);
  b.extra.sseClients.add({}); // b 有标签页连着

  clock = 30000;
  assert.deepEqual(pool.sweep(clock), []); // 未到 60s
  clock = 61000;
  assert.deepEqual(pool.sweep(clock), ["a"]); // a 到点，b 有 SSE，boot 是 pinned
  assert.equal(pool.get("b"), b);
  assert.equal(pool.get("boot"), pinned);
  await new Promise((r) => setTimeout(r, 0)); // 让 release 的 stop 跑完
  assert.equal(a.rpc.stopped, 1);

  b.extra.sseClients.clear(); // 关标签页 → SSE 断开
  clock = 130000;
  assert.deepEqual(pool.sweep(clock), ["b"]);
});

test("sweep：正在 stopping 的引擎不重复回收", () => {
  const { pool } = makePool({ idleMs: 1000, now: () => 5000 });
  const a = pool.getOrCreate("a");
  a.rpc.state = "stopping";
  assert.deepEqual(pool.sweep(5000), []);
});

test("sessionOwner：大小写不敏感 + 排除自己 + 认领中的占位也算", () => {
  const { pool } = makePool();
  const a = pool.getOrCreate("a");
  const b = pool.getOrCreate("b");
  a.rpc.lastGetState.sessionFile = "C:\\Users\\User\\sessions\\One.JSONL";
  assert.equal(pool.sessionOwner("c:/users/user/sessions/one.jsonl"), a);
  assert.equal(pool.sessionOwner("C:\\Users\\user\\sessions\\one.jsonl", { except: "a" }), null);
  assert.equal(pool.sessionOwner("C:\\USERS\\USER\\SESSIONS\\ONE.JSONL", { except: b.id }), a);

  b.extra.claim = "C:\\tmp\\claim.jsonl"; // attach 还没完成的占位
  assert.equal(pool.sessionOwner("C:/tmp/CLAIM.jsonl"), b);
  assert.equal(pool.sessionOwner(null), null);
  assert.equal(pool.sessionOwner("C:/nope.jsonl"), null);
});

test("capacityError / full：上限判断跟着 max 走", () => {
  const { pool } = makePool({ max: 1 });
  assert.equal(pool.full(), false);
  pool.getOrCreate("a");
  assert.equal(pool.full(), true);
  assert.throws(() => pool.getOrCreate("b"), /已达并行上限（1）/);
});

test("N1-a touchTab：同一 client 的新 tab 接管，旧 tab 在活跃窗口内被拒", () => {
  const engine = new Engine({ id: "a", owner: "a", rpc: fakeRpc() });
  engine.touchTab("tab-A", 1000);
  assert.equal(engine.tab, "tab-A");
  assert.equal(engine.isTabRejected("tab-A"), false);
  // 旧 tab 2s 前还活跃 → 新 tab 接管并把旧 tab 记为 rejected
  engine.touchTab("tab-B", 3000);
  assert.equal(engine.tab, "tab-B");
  assert.equal(engine.isTabRejected("tab-A"), true);
  assert.equal(engine.isTabRejected("tab-B"), false);
  // 旧 tab 重新认领 → 拿回控制权，自身不再被拒
  engine.touchTab("tab-A", 4000);
  assert.equal(engine.tab, "tab-A");
  assert.equal(engine.isTabRejected("tab-A"), false);
  assert.equal(engine.isTabRejected("tab-B"), true);
});

test("N1-a touchTab：旧 tab 已静默超过窗口 → 直接接管，不拒绝", () => {
  const engine = new Engine({ id: "a", owner: "a", rpc: fakeRpc() });
  engine.touchTab("tab-A", 1000);
  engine.touchTab("tab-B", 20000); // 19s > 10s
  assert.equal(engine.tab, "tab-B");
  assert.equal(engine.isTabRejected("tab-A"), false);
});

test("N1-a health 带 tab 字段；无 tab 时为 null", () => {
  const engine = new Engine({ id: "a", owner: "a", rpc: fakeRpc() });
  assert.equal(engine.health().tab, null);
  engine.touchTab("tab-X", 1000);
  assert.equal(engine.health().tab, "tab-X");
});

// ---------- S1（bg-continue）：流式中不回收 ----------

test("S1：resolveIdleMs 默认 60000，非法值回落", () => {
  assert.equal(DEFAULT_IDLE_MS, 60000);
  assert.equal(resolveIdleMs(undefined), 60000);
  assert.equal(resolveIdleMs(""), 60000);
  assert.equal(resolveIdleMs("3000"), 3000);
  assert.equal(resolveIdleMs("0"), 60000);
  assert.equal(resolveIdleMs("-1"), 60000);
  assert.equal(resolveIdleMs("abc"), 60000);
});

test("S1：streaming + 无 SSE + 超过 idleMs → sweep 不回收，isAlive 仍为 true", () => {
  let clock = 0;
  const { pool } = makePool({ idleMs: 60000, now: () => clock });
  const a = pool.getOrCreate("a");
  a.rpc.state = "streaming";
  a.noteStreaming(1000); // = index.mjs 的 noteEngineState(engine, "streaming")

  clock = 200000; // 比 idleMs 大得多（也远超窗口），但在 MAX_PIN_MS 内
  assert.equal(pool.sseCount?.() ?? 0, 0);
  assert.equal(a.sseCount(), 0);
  assert.equal(pool.isAlive(a, clock), true);
  assert.deepEqual(pool.sweep(clock), []);
  assert.equal(pool.get("a"), a);
  assert.equal(a.rpc.stopped, 0);
  assert.equal(pool.liveCount(clock), 1);
});

test("S1：streaming 超过 MAX_PIN_MS → 允许回收，并记 engine_pin_expired（warn）", () => {
  let clock = 0;
  const { pool, records } = makePool({ idleMs: 60000, maxPinMs: 10000, now: () => clock });
  const a = pool.getOrCreate("a");
  a.rpc.state = "streaming";
  a.noteStreaming(0);

  clock = 10000; // 正好到上限：不算过期（严格大于才收）
  assert.equal(pool.isAlive(a, clock), true);
  assert.deepEqual(pool.sweep(clock), []);

  clock = 10001; // 超上限 → 兜底回收
  assert.equal(pool.isAlive(a, clock), false);
  assert.deepEqual(pool.sweep(clock), ["a"]);
  const pinLog = records.find((r) => r.event === "engine_pin_expired");
  assert.ok(pinLog, "必须记 engine_pin_expired");
  assert.equal(pinLog.level, "warn");
  assert.equal(pinLog.fields.id, "a");
  assert.equal(pinLog.fields.streamingMs, 10001);
  assert.equal(pinLog.fields.maxPinMs, 10000);
});

test("S1：pin 起点缺失（外部直接改 state）时退回 lastSeenAt，仍会兜底回收", () => {
  let clock = 0;
  const { pool } = makePool({ maxPinMs: 10000, now: () => clock });
  const a = pool.getOrCreate("a");
  a.rpc.state = "streaming"; // 没走 noteStreaming → streamStartedAt 保持 null
  a.touch(0); // 最后活跃时间 = 0（pin 起点回退到它）
  clock = 10000;
  assert.equal(pool.pinExpired(a, clock), false); // 从 lastSeenAt=0 起算
  clock = 10001;
  assert.equal(pool.pinExpired(a, clock), true);
  assert.deepEqual(pool.sweep(clock), ["a"]);
});

test("S1：streaming 超过 MAX_PIN_MS 时 pinned 引擎仍不回收（引导引擎常驻优先）", () => {
  let clock = 0;
  const { pool } = makePool({ maxPinMs: 1000, now: () => clock });
  const boot = new Engine({ id: "boot", owner: null, pinned: true, rpc: fakeRpc({ state: "streaming" }) });
  boot.extra = { sseClients: new Set(), pendingExtDialogs: new Map(), cwd: "/x", claim: null };
  pool.add(boot);
  clock = 999999;
  assert.equal(pool.isAlive(boot, clock), true);
  assert.deepEqual(pool.sweep(clock), []);
});

test("S1：agent_settled 后 linger 一个 idleMs，随后正常回收", () => {
  let clock = 0;
  const { pool, records } = makePool({ idleMs: 60000, now: () => clock });
  const a = pool.getOrCreate("a");
  a.rpc.state = "streaming";
  a.noteStreaming(0);

  clock = 5000;
  a.rpc.state = "idle";
  a.noteSettled(5000); // = index.mjs 的 noteEngineState(engine, "idle")（含 agent_settled）
  assert.equal(a.streamStartedAt, null);
  assert.equal(pool.isAlive(a, clock), true);

  clock = 60000; // settle 后 55s：还在 linger 窗口内
  assert.equal(pool.isAlive(a, clock), true);
  assert.deepEqual(pool.sweep(clock), []);
  assert.equal(pool.get("a"), a);

  clock = 65001; // settle 后 60.001s：正常回收（不是 pin 到期）
  assert.equal(pool.isAlive(a, clock), false);
  assert.deepEqual(pool.sweep(clock), ["a"]);
  assert.equal(records.some((r) => r.event === "engine_pin_expired"), false);
});

test("S1：流式中的引擎计入 liveCount（D2：孤儿流式仍占并行槽位）", () => {
  let clock = 0;
  const { pool } = makePool({ max: 1, idleMs: 60000, now: () => clock });
  const a = pool.getOrCreate("a");
  a.rpc.state = "streaming";
  a.noteStreaming(0);
  clock = 600000;
  assert.equal(pool.liveCount(clock), 1);
  assert.equal(pool.full(clock), true);
  assert.throws(() => pool.getOrCreate("b"), /已达并行上限（1）/);
});

// ---------- S3（bg-continue）：孤儿接管判定 + 接管动作 ----------

/** 造一个「占着某个会话、无 SSE」的孤儿引擎（模拟关掉标签页后的流式引擎） */
function makeOrphan(pool, id, { sessionFile = "C:\\s\\one.jsonl", state = "streaming", now = 0 } = {}) {
  const engine = pool.getOrCreate(id);
  engine.rpc.state = state;
  engine.rpc.lastGetState.sessionFile = sessionFile;
  if (state === "streaming") engine.noteStreaming(now);
  else engine.touch(now);
  return engine;
}

test("S3：无 SSE + 同会话 + 静默 ≥ graceMs → 可接管（默认 30000）", () => {
  assert.equal(DEFAULT_ADOPT_GRACE_MS, 30000);
  let clock = 0;
  const { pool } = makePool({ now: () => clock });
  const orphan = makeOrphan(pool, "tab-old", { now: 0 });

  clock = 30000;
  assert.equal(orphan.sseCount(), 0);
  // 路径大小写/斜杠不敏感（与 sessionOwner 同口径）；except 排除自己
  assert.equal(pool.adoptable("c:/s/ONE.jsonl", { now: clock, except: "tab-new" }), orphan);
  assert.equal(pool.adoptable("c:/s/ONE.jsonl", { now: clock }), orphan);
  assert.equal(pool.adoptable(null, { now: clock }), null);
});

test("S3：有 SSE 连接的引擎不可接管（活跃标签页仍走 409，I1）", () => {
  const clock = 100000;
  const { pool } = makePool({ now: () => clock });
  const orphan = makeOrphan(pool, "tab-old", { now: 0 });
  orphan.extra.sseClients.add({});
  assert.equal(pool.adoptable(orphan.sessionFile, { now: clock }), null);
  orphan.extra.sseClients.clear();
  assert.equal(pool.adoptable(orphan.sessionFile, { now: clock }), orphan);
});

test("S3：静默未到 graceMs 不可接管（刚断开可能自己重连）；graceMs 边界取「≥」", () => {
  let clock = 0;
  const { pool } = makePool({ now: () => clock });
  const orphan = makeOrphan(pool, "tab-old", { now: 0 });

  clock = 29999; // 差 1ms → 不抢
  assert.equal(pool.adoptable(orphan.sessionFile, { now: clock }), null);
  clock = 30000; // 正好到门槛 → 可接管
  assert.equal(pool.adoptable(orphan.sessionFile, { now: clock }), orphan);
  // graceMs 可显式覆盖
  clock = 5000;
  assert.equal(pool.adoptable(orphan.sessionFile, { now: clock, graceMs: 4000 }), orphan);
  assert.equal(pool.adoptable(orphan.sessionFile, { now: clock, graceMs: 6000 }), null);
});

test("S3：不同会话不可接管；claim 占位也算同一会话；stopping 不可接管", () => {
  const clock = 100000;
  const { pool } = makePool({ now: () => clock });
  const a = makeOrphan(pool, "tab-a", { now: 0, sessionFile: "C:\\s\\one.jsonl" });
  const b = pool.getOrCreate("tab-b"); // attach 还没完成的占位
  b.extra.claim = "C:\\s\\two.jsonl";
  b.touch(0);

  assert.equal(pool.adoptable("C:\\s\\one.jsonl", { now: clock }), a);
  assert.equal(pool.adoptable("C:\\s\\two.jsonl", { now: clock }), b);
  assert.equal(pool.adoptable("C:\\s\\three.jsonl", { now: clock }), null);

  a.rpc.state = "stopping"; // 正在关的引擎接管没有意义
  assert.equal(pool.adoptable("C:\\s\\one.jsonl", { now: clock }), null);
});

test("S3：adopt 先 release 本 client 旧引擎再 own（引擎数不增、旧 pid 不在池内、claim 不变）", async () => {
  let clock = 0;
  const { pool, records } = makePool({ now: () => clock });
  const orphan = makeOrphan(pool, "tab-old", { now: 0 }); // pid 1000
  orphan.extra.claim = "C:\\s\\one.jsonl";
  const mine = pool.getOrCreate("tab-new"); // 本客户端那条空闲空引擎（pid 1001）
  clock = 30000;
  const target = pool.adoptable(orphan.claimedSessionFile, { now: clock, except: "tab-new" });
  assert.equal(target, orphan);

  const before = pool.size;
  const adopted = await pool.adopt(target, "tab-new");
  assert.equal(adopted, orphan);
  assert.equal(pool.size, before - 1); // 不增：本客户端旧引擎被 release，目标引擎改键不占新槽
  assert.deepEqual(pool.ids(), ["tab-new"]);
  assert.equal(pool.get("tab-new"), orphan);
  assert.equal(orphan.owner, "tab-new");
  assert.equal(orphan.pid, 1000); // 接管成功的是原流式引擎
  assert.equal(mine.rpc.stopped, 1); // 旧引擎被 release（不是静默丢）
  assert.equal(pool.list().includes(mine), false);
  assert.equal(pool.list().some((e) => e.pid === 1001), false); // 旧 pid 不在池内
  assert.equal(orphan.extra.claim, "C:\\s\\one.jsonl"); // claim 不变（I7 之外的另一条不变量）
  assert.equal(orphan.rpc.stopped, 0); // 被接管的引擎不能被停
  const adoptedLog = records.find((r) => r.event === "engine_adopted");
  assert.ok(adoptedLog, "必须记 engine_adopted");
  assert.equal(adoptedLog.level, "info");
  assert.equal(adoptedLog.fields.from, "tab-old");
  assert.equal(adoptedLog.fields.to, "tab-new");
  assert.equal(adoptedLog.fields.released, "tab-new");
  assert.equal(adoptedLog.fields.pid, 1000);
});

test("S3：本 client 无旧引擎时 adopt 直接 own（不误停目标引擎）", async () => {
  let clock = 0;
  const { pool, records } = makePool({ now: () => clock });
  const orphan = makeOrphan(pool, "tab-old", { now: 0 });
  clock = 30000;
  const adopted = await pool.adopt(pool.adoptable(orphan.sessionFile, { now: clock, except: "tab-new" }), "tab-new");
  assert.equal(adopted, orphan);
  assert.equal(pool.size, 1);
  assert.equal(orphan.rpc.stopped, 0);
  assert.equal(records.find((r) => r.event === "engine_adopted").fields.released, null);
  assert.equal(await pool.adopt(null, "tab-new"), null);
  assert.equal(await pool.adopt(orphan, null), null);
});

// 注：本切片只做模块 + 单测；index.mjs 的 /api/session/open 接管分支（adopted 字段 / 409 分支）见 S3b。
