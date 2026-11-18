// pi-shell bridge · 会话视图（B1 / T5）
//
// 为什么：顶栏需要的 cwd / model / thinkingLevel / mcp 分散在 4 个端点里，且清单端点永远取主引擎
// → 前端拿不到「这个会话的真实配置」，切列后顶栏会停在上一列的值（design F12/F13/B3-1~B3-3）。
//
// 本模块只做**纯解析**（引擎选择 + 响应字段组装），HTTP 状态码由 index.mjs 负责：
// - view：显式 client 必须命中池内引擎（未知 → 调用方回 404 NOT_FOUND，不创建引擎）；
//         未带 client → 主引擎（向后兼容既有脚本）。
// - 清单（models/commands）：显式 client 命中就用它；未知/未带 → 回落主引擎。
// - 字段真相：cwd 取 engine.extra.cwd（T2 已在 attach/new/restart 后回写会话 header 的 cwd），
//   sessionFile/model/thinkingLevel 取最近一次 get_state，mcp 取引擎当前名单。
// - 无全局缓存：每次按 client 现算（多列并发不会串）。

/** get_state.model → 与 /api/health 的 session 字段同形状（null 表示未知） */
export function normalizeModel(model) {
  if (!model || typeof model !== "object") return null;
  return {
    provider: typeof model.provider === "string" ? model.provider : null,
    id: typeof model.id === "string" ? model.id : null,
    name: typeof model.name === "string" ? model.name : null,
  };
}

/**
 * 组装 GET /api/session/view 的响应体。
 * @param {object} engine 引擎记录（只读 extra/mcp，不改状态）
 * @param {object|null} [state] 最近一次 get_state（默认取 engine.rpc.lastGetState）
 */
export function buildSessionView(engine, state = engine?.rpc?.lastGetState ?? null) {
  const claimed = engine?.claimedSessionFile ?? null;
  const fromState = typeof state?.sessionFile === "string" && state.sessionFile ? state.sessionFile : null;
  return {
    cwd: engine?.extra?.cwd ?? null,
    sessionFile: fromState ?? claimed,
    model: normalizeModel(state?.model),
    thinkingLevel: typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null,
    mcp: Array.isArray(engine?.mcp) ? [...engine.mcp] : [],
  };
}

/**
 * view 端点的引擎解析：显式 client 未命中 → null（调用方回 404 NOT_FOUND，且不创建引擎）。
 */
export function pickSessionEngine({ client = null, find, primary } = {}) {
  if (!client) return primary ?? null;
  return find?.(client) ?? null;
}

/**
 * 清单端点（models/commands）的引擎解析：显式 client 命中 → 该引擎；否则回落主引擎。
 */
export function pickReadEngine({ client = null, find, primary } = {}) {
  if (!client) return primary ?? null;
  return find?.(client) ?? primary ?? null;
}
