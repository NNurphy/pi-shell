// pi-shell bridge · 多引擎池（第三批：每个浏览器标签页一个 pi 引擎）
//
// 为什么：单个 pi 子进程同一时刻只能跑一个回合；标签页 A 跑长任务时，标签页 B 想跑另一个会话
// 就必然互相中止（switch_session / abort 都会打断当前回合）。所以按「客户端标识」分引擎：
//   - 浏览器标签页在 sessionStorage 里放一个 id，所有请求带 X-Pi-Shell-Client；
//   - 缺省（既有脚本/单引擎语义）一律当 "default" 客户端，行为与改造前一致；
//   - 上限 max（默认 4，PI_SHELL_MAX_ENGINES 可配），超限 → 503 PI_NOT_READY；
//   - 无 SSE 连接且 60s 无请求 → 回收该引擎（关标签页后释放内存）。
//   - S1（bg-continue）：正在 streaming 的引擎不参与空闲回收（关掉标签页也让这一轮跑完）；
//     只有流式超过 MAX_PIN_MS 的兜底才强收（engine_pin_expired）。
//
// 本模块只做「池 + 生命周期」。协议/请求队列仍复用 rpc.mjs 的 PiRpc，不改它的行为。
// 桥侧附加状态（cwd、扩展对话框、SSE 连接集合…）挂在 engine.extra 上，由 index.mjs 填充。

export const DEFAULT_CLIENT = "default";
export const DEFAULT_MAX_ENGINES = 4;
export const DEFAULT_IDLE_MS = 60000; // 60s 无 SSE / 无请求 → 回收
// S1（bg-continue）：流式中的引擎不回收；超过这个上限才强制回收（防「永远卡在 streaming」）。
// 正常路径靠 pi 自己的 agent_settled，这条只是兜底（记 engine_pin_expired 警告，不静默）。
export const MAX_PIN_MS = 2 * 60 * 60 * 1000; // 2h（设计 §5.1 的 MAX_TURN_MS，保守值）
// S3（bg-continue）：孤儿接管的静默门槛。别的引擎占着同一会话 + 没有 SSE 连接，
// 且已经静默这么久 → 才允许新页面把它接管过来；刚断开（可能只是抖动/自己重连）不抢。
export const DEFAULT_ADOPT_GRACE_MS = 30000; // 30s（设计 §5.3）

/** 一条引擎记录：一个 pi 子进程 + 它自己的桥侧状态 */
export class Engine {
  constructor({ id, rpc = null, owner = null, pinned = false, mcp = [], now = Date.now() } = {}) {
    this.id = id; // 池内唯一键（取自客户端标识）
    this.rpc = rpc; // PiRpc 实例（沿用 rpc.mjs 的协议逻辑）
    this.owner = owner; // 拥有该引擎的客户端标识；null = 尚未被任何标签页认领（引导引擎）
    // 该引擎实际启用的 MCP server 名单（空数组 = 不带 MCP，子进程带 --no-mcp）。
    // 默认关闭：引擎 ≈90MB 而不是 ≈500MB；需要时按列勾选（见 POST /api/engine/restart）。
    // 切换必须换新子进程（pi 不支持进程内懒加载 MCP）。
    this.mcp = Array.isArray(mcp) ? [...new Set(mcp)] : [];
    // 引导引擎不参与空闲回收：改造前「桥一启动就常驻一个 pi」，既有脚本随时可能来问它
    this.pinned = pinned;
    this.createdAt = now;
    this.lastSeenAt = now; // 最近一次 SSE 活跃 / 请求
    // S1：本轮 streaming 的开始时间（pin 的起点）。null = 当前不在流式中。
    this.streamStartedAt = null;
    // N1-a：同一 clientId 可能被复制标签页共用。标签页标识（每页随机、不持久化）用来
    // 识别「同一 client 来自不同标签」：记录 tabs，最新认领的 tab 拿到控制权，旧 tab 可被拒绝。
    this.tabs = new Map(); // tabId → {firstSeen, lastSeen}
    this.tab = null; // 当前控制该引擎的标签页
    this.rejectedTabs = new Set(); // 被新标签页顶掉的旧 tab
    this.extra = {}; // 桥侧附加状态：{cwd, restarting, attachToken, pendingExtDialogs, sseClients, claim}
  }

  get state() {
    return this.rpc?.state ?? "not_started";
  }

  get pid() {
    return this.rpc?.snapshot?.()?.pid ?? null;
  }

  /** 当前附着的会话文件（冲突检测的唯一权威来源） */
  get sessionFile() {
    return this.rpc?.lastGetState?.sessionFile ?? null;
  }

  get sessionId() {
    return this.rpc?.lastGetState?.sessionId ?? null;
  }

  /** 桥侧「已打开」的会话文件：attach 尚未完成时先占位，避免同会话被两个引擎同时打开 */
  get claimedSessionFile() {
    return this.extra?.claim ?? null;
  }

  sseCount() {
    return this.extra?.sseClients?.size ?? 0;
  }

  touch(now = Date.now()) {
    this.lastSeenAt = now;
    return this;
  }

  /** S1：进入 streaming → 记本轮起点（只记第一次，重入不重置计时） */
  noteStreaming(now = Date.now()) {
    if (this.streamStartedAt == null) this.streamStartedAt = now;
    this.lastSeenAt = now;
    return this;
  }

  /** S1：回合结束（idle / agent_settled）→ 清 pin 起点并 touch：再 linger 一个 idleMs 才回收 */
  noteSettled(now = Date.now()) {
    this.streamStartedAt = null;
    this.lastSeenAt = now;
    return this;
  }

  /**
   * 记录一次「来自哪个标签页」的认领/操作。
   * 同一 client 上出现新 tab，且旧 tab 在 takeoverMs 内还活跃 → 旧 tab 记入 rejectedTabs
   * （允许桥拒绝旧 tab 的后续请求，避免两个页面互相顶掉）。旧 tab 已静默超过窗口则直接接管。
   * @returns {{tab:string|null, previous:string|null, tookOver:boolean}}
   */
  touchTab(tabId, now = Date.now(), takeoverMs = 10000) {
    if (!tabId) return { tab: this.tab, previous: null, tookOver: false };
    const previous = this.tab;
    const previousRec = previous ? this.tabs.get(previous) : null;
    const tookOver = !!previous && previous !== tabId && !!previousRec && now - previousRec.lastSeen <= takeoverMs;
    const rec = this.tabs.get(tabId);
    if (rec) rec.lastSeen = now;
    else this.tabs.set(tabId, { firstSeen: now, lastSeen: now });
    this.tab = tabId;
    this.rejectedTabs.delete(tabId); // 重新拿回控制权的 tab 解除拒绝
    if (tookOver) this.rejectedTabs.add(previous);
    return { tab: tabId, previous, tookOver };
  }

  /** 该标签页是否已被本引擎拒绝（只有「不是当前 tab」的旧 tab 会被拒） */
  isTabRejected(tabId) {
    return !!tabId && tabId !== this.tab && this.rejectedTabs.has(tabId);
  }

  health() {
    return {
      id: this.id,
      client: this.owner,
      tab: this.tab,
      state: this.state,
      sessionFile: this.sessionFile,
      pid: this.pid,
      mcp: [...this.mcp],
    };
  }
}

/** 引擎池：getOrCreate / claim / release / sweep */
export class EnginePool {
  /**
   * @param {object} opts
   * @param {(clientId:string)=>Engine} opts.create 建引擎（含 spawn）的工厂，由 index.mjs 提供
   * @param {number} [opts.max] 并行上限
   * @param {number} [opts.idleMs] 空闲回收阈值
   * @param {number} [opts.maxPinMs] 流式 pin 的兜底上限（超过即允许回收）
   * @param {Function} [opts.log]
   * @param {()=>number} [opts.now]
   * @param {(engine:Engine, reason:string)=>void} [opts.onRemove] 引擎移除后的清理钩子
   *        （MCP shim 的临时 agentDir 就靠它回收，见 index.mjs）
   */
  constructor({
    create,
    max = DEFAULT_MAX_ENGINES,
    idleMs = DEFAULT_IDLE_MS,
    maxPinMs = MAX_PIN_MS,
    log = () => {},
    now = Date.now,
    onRemove = null,
  } = {}) {
    this.create = create;
    this.onRemove = onRemove;
    this.max = max;
    this.idleMs = idleMs;
    this.maxPinMs = maxPinMs;
    this.log = log;
    this.now = now;
    this._engines = new Map(); // id → Engine（插入顺序 = 创建顺序）
  }

  get size() {
    return this._engines.size;
  }

  list() {
    return [...this._engines.values()];
  }

  ids() {
    return [...this._engines.keys()];
  }

  get(id) {
    return (id && this._engines.get(id)) || null;
  }

  /** 按「拥有者」找（认领时引擎 id 可能还没改名，两者都要查） */
  byOwner(clientId) {
    for (const engine of this._engines.values()) if (engine.owner === clientId) return engine;
    return null;
  }

  /** 直接命中：先按 id，再按 owner */
  find(clientId) {
    if (!clientId) return null;
    return this.get(clientId) ?? this.byOwner(clientId);
  }

  add(engine) {
    this._engines.set(engine.id, engine);
    return engine;
  }

  /** 是否「活着」的引擎：max 判定与 health 计数的唯一口径。
   *  - pinned 引导引擎：活着（单引擎兼容，既有脚本随时会来问它）
   *  - streaming：活着（S1：流式中不回收，即使没有 SSE；超过 maxPinMs 兜底才算死）
   *  - 有 SSE 连接：活着（标签页还连着）
   *  - stopping：不算（正在关）
   *  - idleMs 内有过心跳/请求：活着
   *  池内记录里可能有「超过 idleMs 还没被 sweep 到」的僵尸（sweep 每 5s 一轮，
   *  再叠上关标签页与新开标签页的竞争）→ 直接数 Map.size 会把僵尸当活引擎。 */
  isAlive(engine, now = this.now()) {
    if (!engine) return false;
    if (engine.pinned) return true;
    if (engine.state === "stopping") return false;
    if (engine.state === "streaming") return !this.pinExpired(engine, now);
    if (engine.sseCount() > 0) return true;
    return now - engine.lastSeenAt <= this.idleMs;
  }

  /** pin 起点：优先本轮 streaming 的起点；没记过（老记录/外部直接改 state）则退回最后活跃时间 */
  pinSince(engine) {
    return engine?.streamStartedAt ?? engine?.lastSeenAt ?? 0;
  }

  /** S1 兜底：流式已经超过 maxPinMs → 允许回收（否则「永远卡在 streaming」会把槽位占死） */
  pinExpired(engine, now = this.now()) {
    if (!engine) return false;
    return now - this.pinSince(engine) > this.maxPinMs;
  }

  /** 活引擎数（不计僵尸） */
  liveCount(now = this.now()) {
    return this.list().filter((engine) => this.isAlive(engine, now)).length;
  }

  /** 是否已达上限：先回收空闲引擎，再只数「活引擎」。
   *  旧实现数池内全部记录 → 关标签页后 60s 内再开新标签页会被误判「开太多」（503）。 */
  full(now = this.now()) {
    this.sweep(now);
    return this.liveCount(now) >= this.max;
  }

  /** 超上限错误（03 §5：PI_NOT_READY → 503） */
  capacityError() {
    return Object.assign(new Error(`已达并行上限（${this.max}）：关闭一个标签页再试`), {
      code: "PI_NOT_READY",
      status: 503,
    });
  }

  /** 取已有引擎，没有且未超限则新建；超限抛 capacityError */
  getOrCreate(clientId) {
    this.sweep(); // 先清僵尸（>idleMs 无心跳、无 SSE），再判上限
    const hit = this.find(clientId);
    if (hit) return hit.touch(this.now());
    if (this.full()) throw this.capacityError();
    const engine = this.create(clientId);
    return this.add(engine);
  }

  /**
   * 认领：把引擎的归属改成 clientId（id 同步改名 → SSE 帧/health 里显示的就是标签页标识）。
   * 改名只影响池内键与展示，不动 pi 子进程。
   */
  own(engine, clientId) {
    if (!engine) return null;
    if (engine.id !== clientId) {
      const previous = engine.id;
      this._engines.delete(previous);
      engine.id = clientId;
      this._engines.set(clientId, engine);
      this.log("info", "engine_claimed", { from: previous, to: clientId });
    }
    engine.owner = clientId;
    engine.pinned = false; // 被标签页认领后按普通引擎回收（关标签页 → 60s 后释放）
    engine.touch(this.now());
    return engine;
  }

  /** 关闭并移除一个引擎（幂等） */
  async release(target, reason = "release") {
    const engine = typeof target === "string" ? this.get(target) : target;
    if (!engine) return false;
    if (this._engines.get(engine.id) !== engine) return false; // 已被移除（幂等）
    this._engines.delete(engine.id);
    this.log("info", "engine_release", { id: engine.id, reason, pid: engine.pid ?? null });
    try {
      await engine.rpc?.stop(`engine-${reason}`);
    } catch (err) {
      this.log("warn", "engine_stop_failed", { id: engine.id, reason: err?.message });
    }
    try {
      this.onRemove?.(engine, reason);
    } catch (err) {
      this.log("warn", "engine_onremove_failed", { id: engine.id, reason: err?.message });
    }
    return true;
  }

  async releaseAll(reason = "shutdown") {
    for (const engine of this.list()) await this.release(engine, reason);
  }

  /**
   * 回收空闲引擎：无 SSE 连接 + 超过 idleMs 没有请求。
   * 正在 stopping 的不重复处理（release 本身是异步的）。
   * S1：streaming 的引擎不回收（即使无 SSE），只有超过 maxPinMs 的兜底才回收 + 记警告。
   * @returns {string[]} 被回收的 id
   */
  sweep(now = this.now()) {
    const removed = [];
    const collect = (engine, reason) => {
      removed.push(engine.id);
      this.release(engine, reason).catch((err) =>
        this.log("warn", "engine_sweep_failed", { id: engine.id, reason: err?.message }),
      );
    };
    for (const engine of this.list()) {
      if (engine.state === "stopping") continue;
      if (engine.pinned) continue; // 引导引擎常驻（单引擎兼容）
      if (engine.state === "streaming") {
        if (!this.pinExpired(engine, now)) continue; // 流式中不回收
        // 兜底：不静默降级 —— 明确记下「pin 到期被强收」，用户可在资源面板/日志里看到
        this.log("warn", "engine_pin_expired", {
          id: engine.id,
          streamingMs: now - this.pinSince(engine),
          maxPinMs: this.maxPinMs,
        });
        collect(engine, "pin-expired");
        continue;
      }
      if (engine.sseCount() > 0) continue; // 有标签页连着 → 活着
      if (now - engine.lastSeenAt <= this.idleMs) continue;
      collect(engine, "idle-sweep");
    }
    return removed;
  }

  /** 同会话保护：找出「除了 except Client 之外」正在使用该会话文件的引擎（大小写不敏感） */
  sessionOwner(sessionFile, { except = null } = {}) {
    if (!sessionFile) return null;
    const norm = (p) => (typeof p === "string" ? p.replace(/\//g, "\\").toLowerCase() : "");
    const target = norm(sessionFile);
    for (const engine of this.list()) {
      if (except && (engine.id === except || engine.owner === except)) continue;
      if (norm(engine.sessionFile) === target || norm(engine.claimedSessionFile) === target) return engine;
    }
    return null;
  }

  /**
   * S3（bg-continue）：孤儿接管判定 —— 找出「可以接管过来」的那个引擎（设计 §5.3）。
   * 可接管的四条缺一不可：
   *   1. 它占着同一个会话（sessionFile 或 attach 占位 claim；口径与 sessionOwner 一致）；
   *   2. 不是本客户端自己的引擎（except 排除自己）；
   *   3. 没有任何 SSE 连接（标签页已关 / 被 suspend）；有活跃标签页的仍走 409（I1 不放宽）；
   *   4. 静默 ≥ graceMs（默认 30000）—— 刚断开的窗口留给它自己重连，不抢。
   * 另外排除 stopping（正在关的引擎接管没有意义）。
   * @returns {Engine|null}
   */
  adoptable(sessionFile, { now = this.now(), graceMs = DEFAULT_ADOPT_GRACE_MS, except = null } = {}) {
    if (!sessionFile) return null;
    const engine = this.sessionOwner(sessionFile, { except });
    if (!engine) return null;
    if (engine.state === "stopping") return null;
    if (engine.sseCount() > 0) return null;
    if (now - engine.lastSeenAt < graceMs) return null;
    return engine;
  }

  /**
   * S3：接管动作 —— 把 engine 的归属换成 clientId。
   * 【必须】先 release 本 clientId 的旧引擎再 own：own() 是 `_engines.delete(旧键) + set(clientId, engine)`，
   * 同一个 clientId 已有记录时会被**静默覆盖**（F25）→ 旧 pi 子进程 + MCP shim 再也没人 stop（泄漏）。
   * 是否允许接管（adoptable）与本客户端引擎是否忙碌（409）属于策略，由调用方判定；这里只保证不丢进程。
   * @returns {Engine|null} 接管后的引擎
   */
  async adopt(engine, clientId, { reason = "adopt-swap" } = {}) {
    if (!engine || !clientId) return null;
    const previous = this.find(clientId);
    const from = engine.id;
    let released = null;
    if (previous && previous !== engine) {
      released = previous.id;
      await this.release(previous, reason); // 先释放，避免 own() 覆盖记录
    }
    const adopted = this.own(engine, clientId);
    this.log("info", "engine_adopted", {
      from,
      to: clientId,
      pid: adopted?.pid ?? null,
      released,
      sessionFile: adopted?.sessionFile ?? adopted?.claimedSessionFile ?? null,
    });
    return adopted;
  }
}

/** 从环境读并行上限（非法值回落到默认 4） */
export function resolveMaxEngines(raw) {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_MAX_ENGINES;
  return n;
}

/** 从环境读空闲回收阈值（PI_SHELL_IDLE_MS；非法值/缺省回落到 60000） */
export function resolveIdleMs(raw) {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_IDLE_MS;
  return n;
}
