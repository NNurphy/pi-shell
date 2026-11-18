// pi-shell bridge · 会话来源分类（user / agent / test）
//
// 目标（机制级，不是给历史会话贴一次性标签）：**新会话自动归类**，用户不手动标。
// 判定顺序（命中即止，见 classifyOrigin）：
//   1) 手动覆盖：sessions-origins.json 里已有的记录原样使用（可手改）
//   2) 目录规则：会话文件位于 PI_SHELL_AGENT_SESSIONS_DIR（默认 ~/.pi/agent/sessions-agents）下 → agent
//   3) 工具窗口规则：header.timestamp 落在任意引擎工具执行窗口 [start-2s, end+5s] 内 → agent
//      这是「PI AI / 派出的开发 Agent 发起的会话」的机制指纹：AI 只能在工具调用期间
//      （bash 跑 `pi -p`、subagent 工具…）派生新会话。窗口由桥从 pi 事件流
//      tool_execution_start / tool_execution_end 记录（ToolWindowTracker）。
//   4) 测试规则：路径含 pi-shell-probe / pi-shell-e2e / pi-shell-audit，
//      或 header.cwd 在系统临时目录下 → test
//   5) 其余 → user
//
// 纯函数 classifyOrigin 便于单测；OriginStore 负责 sidecar 持久化（原子写 + 裁剪）。

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const ORIGINS = ["user", "agent", "test"];

export const TOOL_WINDOW_BEFORE_MS = 2000; // 窗口左扩：start - 2s
export const TOOL_WINDOW_AFTER_MS = 5000; // 窗口右扩：end + 5s
export const TOOL_WINDOWS_MAX = 200; // 只保留最近 200 个窗口
export const ORIGINS_MAX_RECORDS = 5000; // sidecar 超过 5000 条删最旧
export const ORIGINS_FILE_NAME = "sessions-origins.json";
export const TEST_PATH_MARKERS = ["pi-shell-probe", "pi-shell-e2e", "pi-shell-audit"];

/** reason 取值（写进 sidecar，便于人工核对；证据脚本断言 tool-window） */
export const REASONS = {
  manual: "manual",
  agentDir: "agent-dir",
  toolWindow: "tool-window",
  testPath: "test-path",
  testCwd: "test-cwd",
  user: "default",
};

const isWin = process.platform === "win32";

function norm(p) {
  const resolved = path.resolve(String(p));
  return isWin ? resolved.toLowerCase() : resolved;
}

/** child 是否位于 parent 之内（含相等；Windows 大小写不敏感） */
function isUnder(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function toMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOrigin(origin) {
  return ORIGINS.includes(origin) ? origin : null;
}

/** sidecar 键归一：统一 '/' 分隔、去掉前导 './'（Windows 上手改也不会产生重复键） */
export function normalizeKey(relPath) {
  return String(relPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/** 会话文件绝对路径：优先用桥给的绝对路径，否则相对会话根解析（纯函数口径） */
function resolveAbs({ filePath, fileRelPath, sessionsRoot }) {
  if (filePath) return path.resolve(String(filePath));
  if (!fileRelPath) return null;
  const rel = String(fileRelPath);
  if (path.isAbsolute(rel)) return path.resolve(rel);
  if (sessionsRoot) return path.resolve(String(sessionsRoot), rel);
  return path.resolve(rel);
}

function isTempCwd(cwd) {
  if (!cwd) return false;
  const roots = [os.tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR, "/tmp", "/private/tmp"].filter(Boolean);
  return roots.some((root) => isUnder(root, cwd));
}

function isTestPath(absPath) {
  if (!absPath) return false;
  const lower = String(absPath).replace(/\\/g, "/").toLowerCase();
  return TEST_PATH_MARKERS.some((marker) => lower.includes(marker));
}

/** timestamp 是否落在任一工具窗口内（窗口 = [start-2s, end+5s]） */
export function inToolWindow(createdAt, toolWindows) {
  const at = toMs(createdAt);
  if (at == null || !Array.isArray(toolWindows)) return false;
  for (const window of toolWindows) {
    const start = toMs(window?.start);
    if (start == null) continue;
    const end = toMs(window?.end) ?? start;
    if (at >= start - TOOL_WINDOW_BEFORE_MS && at <= end + TOOL_WINDOW_AFTER_MS) return true;
  }
  return false;
}

/**
 * 纯函数：判定一个会话的来源。
 * @param {object} input
 * @param {string} [input.fileRelPath] sidecar 键（相对会话根，可带根名前缀）
 * @param {string} [input.filePath]    会话文件绝对路径（有则优先用于目录/路径规则）
 * @param {string} [input.sessionsRoot] 扫描根（PI_SHELL_SESSIONS_DIR）
 * @param {string} [input.agentRoot]   agent 会话根（PI_SHELL_AGENT_SESSIONS_DIR）
 * @param {string} [input.cwd]         header.cwd（测试规则：系统临时目录）
 * @param {number|string} [input.createdAt] header.timestamp（工具窗口规则的判定依据）
 * @param {Array<{start:number,end:number}>} [input.toolWindows]
 * @param {{origin?:string,reason?:string}} [input.manual] sidecar 已有记录（手动覆盖优先）
 * @returns {{origin:"user"|"agent"|"test", reason:string}}
 */
export function classifyOrigin({ fileRelPath, filePath, sessionsRoot, agentRoot, cwd, createdAt, toolWindows, manual } = {}) {
  // 1) 手动覆盖优先（sidecar 记录的 origin 原样使用）
  const manualOrigin = normalizeOrigin(manual?.origin);
  if (manualOrigin) return { origin: manualOrigin, reason: manual?.reason || REASONS.manual };

  const absPath = resolveAbs({ filePath, fileRelPath, sessionsRoot });

  // 2) 目录规则：agent 专属会话目录
  //    a) 绝对路径落在 agent 根下（生产路径：SessionIndex 总是传 filePath）
  //    b) sidecar 键带根名前缀（如 "sessions-agents/..."）时，没有绝对路径也能判定
  const keyPrefix = agentRoot ? `${path.basename(agentRoot)}/` : "";
  const byDir = (agentRoot && absPath && isUnder(agentRoot, absPath)) ||
    (keyPrefix.length > 1 && normalizeKey(fileRelPath).startsWith(keyPrefix));
  if (byDir) return { origin: "agent", reason: REASONS.agentDir };

  // 3) 工具窗口规则：会话创建时刻落在引擎工具执行窗口内 → 由 PI AI / 派出的 Agent 发起
  if (inToolWindow(createdAt, toolWindows)) return { origin: "agent", reason: REASONS.toolWindow };

  // 4) 测试规则：探针路径 / 系统临时目录下的 cwd
  if (isTestPath(absPath)) return { origin: "test", reason: REASONS.testPath };
  if (isTempCwd(cwd)) return { origin: "test", reason: REASONS.testCwd };

  // 5) 默认：用户自己发起
  return { origin: "user", reason: REASONS.user };
}

/**
 * 工具执行窗口记录器：从 pi 事件流累积 [start, end] 窗口，最多保留最近 max 个。
 * 未闭合的窗口（工具还在跑，或进程崩了没收到 end）在 snapshot() 时按「至今仍在执行」处理，
 * 这样长工具调用期间新开的会话也能被识别为 agent。
 */
export class ToolWindowTracker {
  constructor({ max = TOOL_WINDOWS_MAX, log } = {}) {
    this.max = max;
    this.log = log || (() => {});
    this.windows = [];
    this.open = new Map(); // toolCallId → {start, tool}
    this.seq = 0;
  }

  /** 喂一条 pi 事件记录；非工具事件忽略 */
  note(record, now = Date.now()) {
    const type = record?.type;
    if (type === "tool_execution_start") {
      const key = record.toolCallId ? String(record.toolCallId) : `anon:${++this.seq}`;
      this.open.set(key, { start: now, tool: record.toolName ?? null });
    } else if (type === "tool_execution_end") {
      const key = record.toolCallId ? String(record.toolCallId) : null;
      const started = key ? this.open.get(key) : null;
      if (key) this.open.delete(key);
      this._push({ start: started?.start ?? now, end: now, tool: record.toolName ?? started?.tool ?? null });
    }
    return this.windows.length;
  }

  _push(window) {
    this.windows.push(window);
    if (this.windows.length > this.max) this.windows.splice(0, this.windows.length - this.max);
  }

  /** 测试/启动注入（证据脚本用：给定固定窗口，不依赖真实工具调用） */
  seed(windows) {
    for (const item of windows ?? []) {
      const start = toMs(item?.start);
      const end = toMs(item?.end);
      if (start == null || end == null) continue;
      this._push({ start, end, tool: item?.tool ?? null });
    }
    return this.windows.length;
  }

  /** 快照（含未闭合窗口，end 取当前时刻） */
  snapshot(now = Date.now()) {
    const closed = this.windows.map((window) => ({ ...window }));
    for (const started of this.open.values()) closed.push({ start: started.start, end: now, tool: started.tool, open: true });
    return closed;
  }

  clear() {
    this.windows.length = 0;
    this.open.clear();
  }
}

/**
 * sessions-origins.json 读写（桥自己维护的 sidecar，**不写进 pi 的会话文件**）。
 * 文件结构：{ "<相对会话根路径>": { origin, reason, classifiedAt } }
 * - 原子写：临时文件 + rename
 * - 去重：键归一后 Map，天然唯一
 * - 裁剪：超过 maxRecords 按 classifiedAt 删最旧
 */
export class OriginStore {
  constructor({ filePath, maxRecords = ORIGINS_MAX_RECORDS, log } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : "";
    this.maxRecords = maxRecords;
    this.log = log || (() => {});
    this.records = new Map();
    this.dirty = false;
    this._timer = null;
    this._chain = Promise.resolve();
  }

  /** 同步读（启动期一次；坏文件只告警，不当机） */
  loadSync() {
    if (!this.filePath) return this;
    try {
      const text = fs.readFileSync(this.filePath, "utf8");
      const doc = JSON.parse(text);
      const entries = doc && typeof doc === "object" && !Array.isArray(doc) ? Object.entries(doc) : [];
      for (const [key, value] of entries) {
        if (!value || typeof value !== "object") continue;
        const origin = normalizeOrigin(value.origin);
        if (!origin) continue;
        this.records.set(normalizeKey(key), {
          origin,
          reason: typeof value.reason === "string" && value.reason ? value.reason : REASONS.manual,
          classifiedAt:
            typeof value.classifiedAt === "string" && value.classifiedAt ? value.classifiedAt : new Date(0).toISOString(),
        });
      }
      this._trim();
    } catch (err) {
      if (err?.code !== "ENOENT") this.log("warn", "origins_load_failed", { reason: err?.code || err?.message });
    }
    return this;
  }

  get size() {
    return this.records.size;
  }

  get(relPath) {
    const record = this.records.get(normalizeKey(relPath));
    return record ? { ...record } : null;
  }

  has(relPath) {
    return this.records.has(normalizeKey(relPath));
  }

  /** 写入一条判定；内容未变化时返回 false（避免无意义落盘） */
  set(relPath, { origin, reason }, at = new Date()) {
    const key = normalizeKey(relPath);
    const normalized = normalizeOrigin(origin);
    if (!key || !normalized) return false;
    const record = {
      origin: normalized,
      reason: reason || REASONS.manual,
      classifiedAt: at instanceof Date ? at.toISOString() : String(at),
    };
    const prev = this.records.get(key);
    if (prev && prev.origin === record.origin && prev.reason === record.reason) return false;
    this.records.set(key, record);
    this.dirty = true;
    this._trim();
    return true;
  }

  /** 键排序后的普通对象（写盘用；顺序稳定便于 diff/手改） */
  toObject() {
    const out = {};
    for (const key of [...this.records.keys()].sort()) out[key] = { ...this.records.get(key) };
    return out;
  }

  /** 超过上限 → 删 classifiedAt 最旧的记录 */
  _trim() {
    if (this.records.size <= this.maxRecords) return;
    const sorted = [...this.records.entries()].sort((a, b) =>
      String(a[1].classifiedAt).localeCompare(String(b[1].classifiedAt)),
    );
    let excess = this.records.size - this.maxRecords;
    for (const [key] of sorted) {
      if (excess <= 0) break;
      this.records.delete(key);
      excess -= 1;
    }
    this.dirty = true;
  }

  /** 合并写（默认 200ms 防抖）：分类发生在 list() 热路径上，不能每条都落盘 */
  scheduleFlush(delay = 200) {
    if (!this.filePath || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, delay);
    this._timer.unref?.();
  }

  /** 串行化落盘：临时文件 + rename（Windows 上 rename 覆盖已存在文件是原子替换） */
  flush() {
    if (!this.filePath || !this.dirty) return this._chain;
    this._chain = this._chain.then(
      () => this._writeAtomic(),
      () => this._writeAtomic(),
    );
    return this._chain;
  }

  async _writeAtomic() {
    if (!this.dirty) return;
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const body = JSON.stringify(this.toObject(), null, 2) + "\n";
    this.dirty = false; // 先清：写失败时下次 scheduleFlush 会重试
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(tmp, body, "utf8");
      await fsp.rename(tmp, this.filePath);
    } catch (err) {
      this.dirty = true; // 下次 scheduleFlush 重试
      await fsp.rm(tmp, { force: true }).catch(() => {});
      this.log("warn", "origins_write_failed", { reason: err?.code || err?.message });
    }
  }
}
