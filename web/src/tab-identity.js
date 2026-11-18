// pi-shell · N1-a：标签页身份（复制标签页不再抢同一个引擎）
//
// 问题：clientId 存在 sessionStorage，浏览器「复制标签页」会连 sessionStorage 一起复制
// → 两个页面认领同一个引擎，互相顶掉，还容易撞上「引擎上限」。
//
// 策略（两道，优先级从高到低）：
//   1. BroadcastChannel：启动时广播 {type:'hello', clientId}；若 300ms 内收到同 clientId 的
//      {type:'here'}（来自另一个 tabId）→ 认为被复制，重新生成 clientId。
//      频道常驻：之后任何新页面 hello 同 id，本页都会回 here，让对方换号。
//   2. localStorage 心跳锁 pi-shell.clients = {clientId:{tabId, ts}}：
//      每 5s 写自己的 ts 并清理 >30s 的项；启动时若自己的 clientId 已被别的 tabId 占用
//      （ts 仍新鲜）→ 同样换新。心跳期间若发现别人用更新的 ts 写了同一个 id → 通知换号。
//
// tabId 每页随机、不持久化（复制标签页也拿不到同一个）——它是桥侧区分「同一 client 来自哪个标签」
// 的依据（X-Pi-Shell-Tab）。

export const CLIENT_KEY = "pi-shell.client";
export const CLIENTS_KEY = "pi-shell.clients";
export const CHANNEL_NAME = "pi-shell.tab-identity";
export const HELLO_WAIT_MS = 300;
export const STALE_MS = 30000;
export const HEARTBEAT_MS = 5000;

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // 隐私模式禁 storage：静默降级为「本页独立 id」（BroadcastChannel 仍可用）
  }
}

function readTable(storage, log) {
  const raw = safeGet(storage, CLIENTS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    log?.("warn", "clients_table_parse_failed", { reason: err?.message });
    return {};
  }
}

function writeTable(storage, table) {
  try {
    storage.setItem(CLIENTS_KEY, JSON.stringify(table));
  } catch {
    // 忽略（配额/隐私模式）
  }
}

/** 本次文档加载是不是「刷新/前进后退」：刷新必须保留 sessionStorage 里的 clientId（不是复制标签页） */
function isReloadNavigation() {
  try {
    const type = globalThis.performance?.getEntriesByType?.("navigation")?.[0]?.type;
    return type === "reload" || type === "back_forward";
  } catch {
    return false;
  }
}

/** 清掉 >staleMs 无心跳的项；返回清理数量 */
function pruneTable(table, now, staleMs) {
  let removed = 0;
  for (const [id, entry] of Object.entries(table)) {
    if (!entry || typeof entry !== "object" || !Number.isFinite(entry.ts) || now - entry.ts > staleMs) {
      delete table[id];
      removed += 1;
    }
  }
  return removed;
}

/**
 * 解析本页身份。**必须在页面认领引擎之前 await 完成**。
 * @param {object} [opts]
 * @param {Storage} [opts.storage] 默认 sessionStorage
 * @param {Storage} [opts.local] 默认 localStorage
 * @param {()=>number} [opts.now]
 * @param {number} [opts.helloWaitMs] 等待 here 的时间（默认 300ms）
 * @param {number} [opts.staleMs] 心跳过期阈值（默认 30s）
 * @param {number} [opts.heartbeatMs] 心跳周期（默认 5s）
 * @param {()=>string} [opts.makeId]
 * @param {Function} [opts.log]
 */
export async function createTabIdentity({
  storage = globalThis.sessionStorage,
  local = globalThis.localStorage,
  now = Date.now,
  helloWaitMs = HELLO_WAIT_MS,
  staleMs = STALE_MS,
  heartbeatMs = HEARTBEAT_MS,
  makeId = randomId,
  log = () => {},
} = {}) {
  const tabId = makeId();
  let clientId = safeGet(storage, CLIENT_KEY) || makeId();
  let lastWriteAt = 0;
  let stopped = false;
  let sawHere = false;
  const conflictListeners = new Set();
  const handledConflicts = new Set();
  let bc = null;

  const notifyConflict = (nextId, reason) => {
    log("info", "tab_identity_changed", { from: clientId, to: nextId, reason, tabId });
    for (const fn of conflictListeners) {
      try {
        fn(nextId, { from: clientId, reason });
      } catch (err) {
        log("warn", "tab_identity_listener_failed", { reason: err?.message });
      }
    }
  };

  const adopt = (nextId) => {
    if (!nextId || nextId === clientId) return clientId;
    clientId = nextId;
    safeSet(storage, CLIENT_KEY, clientId);
    beat();
    return clientId;
  };

  /** 写心跳 + 清理过期项 + 发现自己被顶掉时换号（每次 id 只处理一次，避免来回打架） */
  const beat = () => {
    if (!local) return;
    const t = now();
    const table = readTable(local, log);
    pruneTable(table, t, staleMs);
    const owner = table[clientId];
    if (owner && owner.tabId !== tabId && Number(owner.ts) > lastWriteAt && !handledConflicts.has(clientId)) {
      handledConflicts.add(clientId);
      const next = makeId();
      // 先让位再通知：避免继续用已被别人占用的 id 发请求
      adopt(next);
      notifyConflict(next, "heartbeat");
      return;
    }
    table[clientId] = { tabId, ts: t };
    lastWriteAt = t;
    writeTable(local, table);
  };

  // ---- 1) localStorage 占用预检（BroadcastChannel 没答话前的快速路径） ----
  // 刷新/前进后退不算「复制标签页」：sessionStorage 里的 id 必须保留，否则每次 F5 都换引擎、
  // 还会因为旧页心跳未过期而错误重建（实测会让首屏多出一个 starting 引擎）。
  if (local && !isReloadNavigation()) {
    const t = now();
    const table = readTable(local, log);
    pruneTable(table, t, staleMs);
    const owner = table[clientId];
    if (owner && owner.tabId !== tabId) {
      // 同一 id 还被另一个 tab 持有（ts 新鲜）→ 复制标签页：换新号
      const prev = clientId;
      clientId = makeId();
      log("info", "tab_identity_occupied", { from: prev, to: clientId, ownerTab: owner.tabId, tabId });
    }
    writeTable(local, table);
    safeSet(storage, CLIENTS_KEY, clientId);
    safeSet(storage, CLIENT_KEY, clientId);
  } else if (storage) {
    // 刷新：沿用 sessionStorage 里的 id（若没有才写入）；并立刻接管心跳项，
    // 避免上一页没来得及 pagehide 的旧 tabId 被心跳循环当成「别人占着」
    if (!safeGet(storage, CLIENT_KEY)) safeSet(storage, CLIENT_KEY, clientId);
    if (local) {
      const t = now();
      const table = readTable(local, log);
      pruneTable(table, t, staleMs);
      table[clientId] = { tabId, ts: t };
      writeTable(local, table);
      lastWriteAt = t;
    }
  }

  // ---- 2) BroadcastChannel hello/here ----
  if (typeof BroadcastChannel === "function") {
    try {
      bc = new BroadcastChannel(CHANNEL_NAME);
      bc.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object" || !msg.clientId) return;
        if (msg.tabId === tabId) return;
        if (msg.type === "hello" && msg.clientId === clientId) {
          // 有人在问「这个 id 有人吗」→ 回答 here（对方据此换号）
          try {
            bc.postMessage({ type: "here", clientId, tabId });
          } catch {}
          return;
        }
        if (msg.type === "here" && msg.clientId === clientId) {
          sawHere = true;
          if (!handledConflicts.has(clientId)) {
            handledConflicts.add(clientId);
            const next = makeId();
            adopt(next);
            notifyConflict(next, "broadcast");
          }
        }
      };
      bc.postMessage({ type: "hello", clientId, tabId });
    } catch (err) {
      log("warn", "tab_identity_channel_failed", { reason: err?.message });
      bc = null;
    }
  }

  // 给「here」留出往返窗口（300ms）；期间有人回答 = 这个 id 已被别的页面占用。
  // 换号后还要再广播一次 hello：原先可能还有第三个页面复制了同一个旧 id。
  if (bc) {
    await new Promise((resolve) => setTimeout(resolve, helloWaitMs));
    if (sawHere && !stopped) {
      // 已在 onmessage 里换过号；再 hello 一次让同样复制的其它页面也换号
      try {
        bc.postMessage({ type: "hello", clientId, tabId });
      } catch {}
    }
  }

  beat();
  const heartbeatTimer = setInterval(beat, heartbeatMs);
  heartbeatTimer.unref?.();

  // 正常离开页面（刷新/关标签页）时立刻撤掉自己的心跳项：否则下次刷新会看到「同一个 id
  // 被旧 tab 占着」而误判为复制标签页（刷新场景已在上面用 navigation type 兜底，这里是第二道）。
  const onPageHide = () => {
    if (!local) return;
    const table = readTable(local, log);
    if (table[clientId]?.tabId === tabId) delete table[clientId];
    writeTable(local, table);
    try {
      bc?.postMessage({ type: "bye", clientId, tabId });
    } catch {}
  };
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", onPageHide);
  }

  return {
    get clientId() {
      return clientId;
    },
    tabId,
    /** 换号（外部检测到冲突时也可主动调用） */
    adopt,
    onConflict(fn) {
      conflictListeners.add(fn);
      return () => conflictListeners.delete(fn);
    },
    heartbeat: beat,
    stop() {
      stopped = true;
      clearInterval(heartbeatTimer);
      try {
        globalThis.removeEventListener?.("pagehide", onPageHide);
      } catch {}
      onPageHide();
      try {
        bc?.close();
      } catch {}
    },
  };
}
