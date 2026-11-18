// pi-shell bridge · 「每个客户端最后打开的会话」sidecar 持久化
//
// 事故（v1.0.0 发布前开发期的尾巴）：引擎被空闲回收 → 重连能恢复原会话，但记忆表只在桥的进程内存里。
// 修这条尾巴要**重启桥**才生效——桥一重启记忆就没了，第一次重连只能靠前端兜底，
// 服务端不再保证「同一会话里连续对话」。
//
// 本模块把记忆落盘成桥自己维护的 sidecar（**不写 pi 的会话文件**）：
//   <agentDir>/pi-shell-last-sessions.json（PI_SHELL_LAST_SESSIONS_FILE 可覆盖）
// 结构：{ version:1, updatedAt:<iso>, sessions: { <clientId>: { path, cwd, model, thinkingLevel, at } } }
// 只存**元数据**（路径 / cwd / 模型 / 思考级别），不读会话正文（N-07）。
//
// 口径与 sessions-origins.json（origins.mjs 的 OriginStore）一致：
// - 原子写：临时文件 + rename
// - 去抖：默认 200ms（attach / 每轮状态变化都会刷新记忆，不能每条都落盘）
// - 上限：max（默认 64）按 at 淘汰最旧（LRU）
// - 启动同步加载；文件不存在 / 读失败 / 格式错 → 空表 + warn，不影响启动

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const SESSION_MEMORY_MAX = 64; // 标签页 id 每次都新：防止长期运行时无限增长
export const SESSION_MEMORY_VERSION = 1;
export const SESSION_MEMORY_DEBOUNCE_MS = 200;
export const LAST_SESSIONS_FILE_NAME = "pi-shell-last-sessions.json";

/**
 * sidecar 路径（与 origins sidecar 同口径）：
 *   1) PI_SHELL_LAST_SESSIONS_FILE 显式覆盖（测试 / 证据脚本夹具）
 *   2) PI_SHELL_SESSIONS_DIR 被覆盖时 → 落在该夹具目录旁（测试不污染真实 ~/.pi/agent）
 *   3) 否则 <agentDir>/pi-shell-last-sessions.json
 */
export function resolveLastSessionsFile({ env = process.env, agentDir, sessionsDir } = {}) {
  const override = typeof env.PI_SHELL_LAST_SESSIONS_FILE === "string" ? env.PI_SHELL_LAST_SESSIONS_FILE.trim() : "";
  if (override) return path.resolve(override);
  if (sessionsDir) return path.join(path.dirname(path.resolve(sessionsDir)), LAST_SESSIONS_FILE_NAME);
  return path.join(path.resolve(agentDir ?? "."), LAST_SESSIONS_FILE_NAME);
}

/** at 既接受 epoch ms（桥内部口径）也接受 ISO 字符串（手改 sidecar 时） */
function normalizeAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeModel(model) {
  if (!model || typeof model !== "object" || Array.isArray(model)) return null;
  const provider = typeof model.provider === "string" && model.provider ? model.provider : null;
  const id = typeof model.id === "string" && model.id ? model.id : null;
  const name = typeof model.name === "string" && model.name ? model.name : null;
  if (!provider && !id && !name) return null;
  return { provider, id, name };
}

/** 一条记忆记录（坏记录返回 null：加载时跳过，不整表报废） */
export function normalizeSessionRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.path !== "string" || !value.path.trim()) return null;
  return {
    path: path.resolve(value.path),
    cwd: typeof value.cwd === "string" && value.cwd ? path.resolve(value.cwd) : null,
    model: normalizeModel(value.model),
    thinkingLevel: typeof value.thinkingLevel === "string" && value.thinkingLevel ? value.thinkingLevel : null,
    at: normalizeAt(value.at),
  };
}

function cloneRecord(record) {
  return record ? { ...record, model: record.model ? { ...record.model } : null } : null;
}

/**
 * lastSessionByClient 的落盘版本（Map 语义子集：get / set / delete / size）。
 * 写盘失败只告警（记忆是增强，不是正确性前置）；下一次 set 会重试。
 */
export class SessionMemoryStore {
  constructor({ filePath, max = SESSION_MEMORY_MAX, log } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : "";
    this.max = max;
    this.log = log || (() => {});
    this.records = new Map(); // clientId → { path, cwd, model, thinkingLevel, at }
    this.dirty = false;
    this._timer = null;
    this._chain = Promise.resolve();
  }

  get size() {
    return this.records.size;
  }

  /** 启动期同步加载（一次）；坏文件只告警，不当机 */
  loadSync() {
    if (!this.filePath) return this;
    let text = "";
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") this.log("warn", "session_memory_load_failed", { file: this.filePath, reason: err?.code || err?.message });
      return this;
    }
    try {
      const doc = JSON.parse(text);
      const sessions =
        doc && typeof doc === "object" && !Array.isArray(doc) && doc.sessions && typeof doc.sessions === "object" && !Array.isArray(doc.sessions)
          ? doc.sessions
          : null;
      if (!sessions) throw new Error("缺少 sessions 对象");
      for (const [rawKey, value] of Object.entries(sessions)) {
        const clientId = String(rawKey ?? "").trim();
        const record = normalizeSessionRecord(value);
        if (!clientId || !record) continue;
        this.records.set(clientId, record);
      }
      this._trim();
      if (this.records.size > 0) {
        this.log("info", "session_memory_loaded", { file: this.filePath, count: this.records.size });
      }
    } catch (err) {
      this.records.clear();
      this.log("warn", "session_memory_load_failed", { file: this.filePath, reason: err?.message || String(err) });
    }
    return this;
  }

  get(clientId) {
    if (!clientId) return null;
    return cloneRecord(this.records.get(clientId));
  }

  has(clientId) {
    return Boolean(clientId) && this.records.has(clientId);
  }

  /** 写入/刷新一条记忆（只存元数据）→ 去抖落盘；返回写入的记录 */
  set(clientId, record, { delay = SESSION_MEMORY_DEBOUNCE_MS } = {}) {
    const key = typeof clientId === "string" ? clientId.trim() : "";
    const normalized = normalizeSessionRecord(record);
    if (!key || !normalized) return null;
    this.records.set(key, normalized);
    this._trim();
    this.dirty = true;
    this.scheduleFlush(delay);
    return cloneRecord(normalized);
  }

  /** 删除一条（用户显式离开会话 / 恢复时发现文件已删）→ 去抖落盘 */
  delete(clientId, { delay = SESSION_MEMORY_DEBOUNCE_MS } = {}) {
    const key = typeof clientId === "string" ? clientId.trim() : "";
    if (!key || !this.records.delete(key)) return false;
    this.dirty = true;
    this.scheduleFlush(delay);
    return true;
  }

  /** 超过上限 → 按 at 淘汰最旧（LRU） */
  _trim() {
    if (this.records.size <= this.max) return;
    const sorted = [...this.records.entries()].sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
    let excess = this.records.size - this.max;
    for (const [key] of sorted) {
      if (excess <= 0) break;
      this.records.delete(key);
      excess -= 1;
    }
    this.dirty = true;
  }

  /** 写盘对象（client 排序，便于 diff / 手改） */
  toObject(now = new Date()) {
    const sessions = {};
    for (const key of [...this.records.keys()].sort()) sessions[key] = cloneRecord(this.records.get(key));
    return {
      version: SESSION_MEMORY_VERSION,
      updatedAt: now instanceof Date ? now.toISOString() : String(now),
      sessions,
    };
  }

  _serialize() {
    return `${JSON.stringify(this.toObject(), null, 2)}\n`;
  }

  /** 合并写（默认 200ms 防抖）：记忆在 attach / 每轮状态变化上刷新，不能每条都落盘 */
  scheduleFlush(delay = SESSION_MEMORY_DEBOUNCE_MS) {
    if (!this.filePath || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, Math.max(0, delay));
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
    const body = this._serialize();
    this.dirty = false; // 先清：写失败时下一次 set/scheduleFlush 会重试
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(tmp, body, "utf8");
      await fsp.rename(tmp, this.filePath);
    } catch (err) {
      this.dirty = true;
      await fsp.rm(tmp, { force: true }).catch(() => {});
      this.log("warn", "session_memory_write_failed", { file: this.filePath, reason: err?.code || err?.message });
    }
  }

  /** 进程退出兜底（exit 回调里不能 await）：同步原子写一次，别丢掉最后 200ms 的记忆 */
  flushSync() {
    if (!this.filePath || !this.dirty) return false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const body = this._serialize();
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, body, "utf8");
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      this.dirty = true;
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      this.log("warn", "session_memory_write_failed", { file: this.filePath, reason: err?.code || err?.message });
      return false;
    }
  }
}