// pi-shell · PIX-4：「本轮改动」桥侧快照（最小实现）
//
// 回答的问题：这一轮 AI 到底改了哪些文件、改了什么？
// 机制（不碰引擎核心，不接 hook）：
//   · 监听 pi 事件流里的 tool_execution_start / tool_execution_end，
//     对 write / edit 类工具（args.path 或 args.file_path）在**开始时**把文件复制到
//     backups/turn-snapshots/<sessionId>/<turn>/<hash>-before，结束时复制 -after。
//   · 文件不存在 = 新建：before 记 {exists:false}；被删 = 结束时不存在：after 记 {exists:false}。
//   · 一轮 = 一次 user 消息起（与前端「本轮」口径一致）：轮号 = 会话内第 N 条 user 消息。
//     旧会话的基数从会话文件里数（bridge 重启 / 打开旧会话都不会错位）。
//   · 单轮上限：≤50 个文件存内容、单文件 ≤2MiB、总 ≤50MiB；超限**只记路径不存内容**。
//   · 磁盘清理：每个会话保留最近 20 轮，更早在启动时和每轮结束时删除。
//   · diff 用 `git diff --no-index --unified=3`（在读取时算，不阻塞工具执行）；失败退化为空 diff。
//
// 已知限制（写进证据报告）：
//   · 桥收到事件时 pi 已经可能在写文件（事件是异步回放，不是 hook）。缓解：除 tool_execution_start
//     外，还在流式 toolcall_end（参数就绪、执行之前）预抓一次 before；同一轮同一文件只认第一次。
//   · 嵌套工具调用（parentToolCallId）不落盘进会话文件，历史会话无法重建嵌套关系。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

export const TURN_LIMITS = {
  maxFiles: 50, // 单轮最多存内容的文件数（超出的只记路径）
  maxFileBytes: 2 * 1024 * 1024, // 单文件内容上限
  maxTotalBytes: 50 * 1024 * 1024, // 单轮内容总量上限（before+after）
  maxRecords: 500, // 单轮最多记录多少个路径（只记路径也封顶，防滥用）
  keepTurns: 20, // 每个会话保留最近多少轮
  diffMaxBytes: 512 * 1024, // 单文件 diff 上限（超出截断）
  baseScanMaxBytes: 32 * 1024 * 1024, // 数旧会话 user 消息时的读取上限
};

const EMPTY_NAME = ".empty";
const META_NAME = "meta.json";
const isWin = process.platform === "win32";

/** 只认 write / edit 类工具（名字大小写不敏感；支持 apply_patch / multiedit / str_replace 变体） */
export function isWriteTool(toolName, args) {
  const name = String(toolName ?? "");
  if (!name) return false;
  const hasPath = args && typeof args === "object" && (typeof args.path === "string" || typeof args.file_path === "string");
  if (!hasPath) return false;
  return /^(write|edit|multiedit|multi_edit|apply_patch|applypatch|patch|str_replace|str_replace_editor|create|notebookedit)$/i.test(name) ||
    /(write|edit|patch)/i.test(name);
}

/** 从工具参数里取目标路径（绝对或相对执行 cwd） */
export function toolPathFromArgs(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["path", "file_path", "filePath"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function safeSegment(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "unknown";
  if (/^[A-Za-z0-9._-]{1,120}$/.test(raw)) return raw;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

function hashPath(absPath) {
  const norm = isWin ? String(absPath).toLowerCase() : String(absPath);
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 12);
}

function isUnder(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function statSafe(target) {
  try {
    const st = fs.statSync(target);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** 旧会话的 user 消息条数（轮号基数）；读失败/过大 → 0（轮号退化为「本次桥启动后的第 N 轮」） */
export function countUserMessagesSync(filePath, { beforeTs = null, maxBytes = TURN_LIMITS.baseScanMaxBytes } = {}) {
  if (!filePath) return 0;
  try {
    const st = statSafe(filePath);
    if (!st || st.size > maxBytes) return 0;
    const text = fs.readFileSync(filePath, "utf8");
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line || line.indexOf('"role":"user"') < 0) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.type !== "message" || rec.message?.role !== "user") continue;
        // beforeTs：只数「这条 user 消息之前」的条目 —— pi 可能先把当前消息落盘再发 message_start
        if (Number.isFinite(beforeTs) && typeof rec.message.timestamp === "number" && rec.message.timestamp >= beforeTs) continue;
        n += 1;
      } catch {}
    }
    return n;
  } catch {
    return 0;
  }
}

function runGitDiff(execFileImpl, beforeFile, afterFile, { cwd, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    execFileImpl(
      "git",
      ["diff", "--no-index", "--unified=3", "--", beforeFile, afterFile],
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (err, stdout) => {
        // --no-index 有差异时退出码=1：不是错误
        if (err && err.code !== 1 && !(typeof err.code === "string" && err.code === "1")) {
          resolve({ ok: false, diff: "", reason: err?.message || "git diff 失败" });
          return;
        }
        resolve({ ok: true, diff: String(stdout ?? "") });
      },
    );
  });
}

/** 从 unified diff 统计增删行（跳过 ---/+++ 文件头） */
export function countDiffLines(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export class TurnChanges {
  /**
   * @param {object} opts
   * @param {string} opts.root 快照根目录（默认 <repo>/backups/turn-snapshots）
   * @param {(engine:any)=>string} [opts.getCwd] 工具执行 cwd
   * @param {(engine:any, payload:any)=>void} [opts.broadcast] 事件回播（turn_changes 帧）
   * @param {(level:string,event:string,fields?:object)=>void} [opts.log]
   * @param {Function} [opts.execFileImpl] 仅测试用
   */
  constructor({ root, getCwd, broadcast, log, execFileImpl = execFile, limits = TURN_LIMITS } = {}) {
    this.root = path.resolve(root || path.join(process.cwd(), "backups", "turn-snapshots"));
    this.getCwd = getCwd || (() => process.cwd());
    this.broadcast = broadcast || (() => {});
    this.log = log || (() => {});
    this.execFileImpl = execFileImpl;
    this.limits = { ...TURN_LIMITS, ...limits };
    this.states = new Map(); // engineId → state
    this.pending = new Set(); // 进行中的封口任务（flush/测试用）
    this.diffCache = new Map(); // key → {mtimeKey, result}
  }

  // ---------------- 状态 ----------------

  _createState(engine, sessionId) {
    const base = countUserMessagesSync(engine?.sessionFile, { maxBytes: this.limits.baseScanMaxBytes });
    return {
      engineId: engine?.id ?? "default",
      sessionId: sessionId ?? null,
      sessionDir: path.join(this.root, sessionId ? safeSegment(sessionId) : `engine-${safeSegment(engine?.id ?? "default")}`),
      baseUsers: base,
      userCount: base,
      turn: base,
      anyTurn: false,
      files: new Map(), // absPath → entry
      toolPaths: new Map(), // toolCallId → absPath（end 时找同一条）
      storedBytes: 0,
      contentFiles: 0,
      truncated: false,
      startedAt: null,
      sealedTurn: null,
      metaTimer: null,
    };
  }

  _stateFor(engine) {
    const id = engine?.id ?? "default";
    const sid = engine?.sessionId ?? null; // 可能为 null（新会话还没 get_state）
    let st = this.states.get(id);
    if (st && sid && st.sessionId && sid !== st.sessionId) {
      // 会话换了（new_session / switch_session）：封口旧轮，重新计数
      this._enqueueSeal(st);
      this.states.delete(id);
      st = null;
    }
    if (!st) {
      st = this._createState(engine, sid);
      this.states.set(id, st);
      return st;
    }
    if (!st.sessionId && sid) {
      // 新建会话在第一次 get_state 后拿到 id：只有在还没落任何快照时才改目录名
      st.sessionId = sid;
      if (!st.startedAt) st.sessionDir = path.join(this.root, safeSegment(sid));
    }
    return st;
  }

  /** 新的一轮（user 消息到达）；record 用于把「当前这条 user 消息」排除在基数之外 */
  _beginTurn(engine, st, record) {
    if (st.startedAt) {
      const hadFiles = st.files.size;
      this._enqueueSeal(st);
      if (hadFiles) this.log("info", "turn_changes_sealed", { session: st.sessionId, turn: st.turn, files: hadFiles });
    }
    if (!st.anyTurn) {
      // 第一次：从会话文件重算基数（旧会话接着数；新会话里已落盘的当前消息不算）
      const eventTs = typeof record?.message?.timestamp === "number" ? record.message.timestamp : null;
      st.userCount = countUserMessagesSync(engine?.sessionFile, { beforeTs: eventTs, maxBytes: this.limits.baseScanMaxBytes });
      st.anyTurn = true;
    }
    st.userCount += 1;
    st.turn = st.userCount;
    st.files = new Map();
    st.toolPaths = new Map();
    st.storedBytes = 0;
    st.contentFiles = 0;
    st.truncated = false;
    st.startedAt = Date.now();
    st.sealedTurn = null;
    this.broadcastTurn(engine, st, "start");
  }

  broadcastTurn(engine, st, phase) {
    try {
      this.broadcast(engine, {
        type: "turn_changes",
        phase,
        sessionId: st.sessionId,
        turn: st.turn,
        files: st.files.size,
      });
    } catch {}
  }

  // ---------------- 快照 ----------------

  /** 抓一次文件内容（before/after）。同步复制：在事件处理当下立刻落盘，尽量抢在工具写之前 */
  _capture(st, absPath, side) {
    let entry = st.files.get(absPath);
    if (!entry) {
      if (st.files.size >= this.limits.maxRecords) {
        st.truncated = true;
        return null;
      }
      const cwd = st.cwd ? path.resolve(st.cwd) : "";
      const rel = cwd && isUnder(cwd, absPath) ? path.relative(cwd, absPath).replace(/\\/g, "/") : absPath.replace(/\\/g, "/");
      entry = {
        path: rel,
        abs: absPath,
        hash: hashPath(absPath),
        before: { stored: false, exists: false, size: null },
        after: { stored: false, exists: false, size: null },
        beforeDone: false,
        done: false,
        touches: 0,
      };
      st.files.set(absPath, entry);
    }
    // before 只认本轮第一次（同文件多次编辑：整体 diff 以轮首为基线）；after 每次都刷新（取最后一次结果）
    if (side === "before" && entry.beforeDone) return entry;
    const slot = entry[side];
    if (slot.stored && Number.isFinite(slot.size)) st.storedBytes = Math.max(0, st.storedBytes - slot.size);
    const info = statSafe(absPath);
    if (!info) {
      slot.exists = false;
      slot.stored = false;
      slot.size = null;
      delete slot.reason;
      if (side === "before") entry.beforeDone = true;
      return entry;
    }
    slot.exists = true;
    slot.size = info.size;
    if (info.size > this.limits.maxFileBytes) {
      slot.stored = false;
      slot.reason = "too-large";
      if (side === "before") entry.beforeDone = true;
      return entry;
    }
    if (!entry.contentStored && st.contentFiles >= this.limits.maxFiles) {
      // 单轮存内容的文件数上限：超出的只记路径（不存 before/after）
      slot.stored = false;
      slot.reason = "file-limit";
      st.truncated = true;
      if (side === "before") entry.beforeDone = true;
      return entry;
    }
    if (st.storedBytes + info.size > this.limits.maxTotalBytes) {
      slot.stored = false;
      slot.reason = "over-budget";
      st.truncated = true;
      if (side === "before") entry.beforeDone = true;
      return entry;
    }
    try {
      fs.mkdirSync(path.dirname(this._sideFile(st, entry, side)), { recursive: true });
      fs.copyFileSync(absPath, this._sideFile(st, entry, side));
      slot.stored = true;
      if (!entry.contentStored) {
        entry.contentStored = true;
        st.contentFiles += 1;
      }
      delete slot.reason;
      st.storedBytes += info.size;
    } catch (err) {
      slot.stored = false;
      slot.reason = "copy-failed";
      this.log("warn", "turn_snapshot_copy_failed", { path: absPath, reason: err?.message });
    }
    if (side === "before") entry.beforeDone = true;
    return entry;
  }

  _sideFile(st, entry, side) {
    return path.join(this._turnDir(st), `${entry.hash}-${side}`);
  }

  _turnDir(st) {
    return path.join(st.sessionDir, String(st.turn || 1));
  }

  // ---------------- 事件入口 ----------------

  /** 喂一条 pi 事件记录（非工具事件忽略）；返回值无意义 */
  note(engine, record) {
    try {
      const type = record?.type;
      if (type === "message_start") {
        if (record.message?.role !== "user") return;
        const st = this._stateFor(engine);
        this._beginTurn(engine, st, record);
        return;
      }
      if (type === "message_update") {
        const aev = record.assistantMessageEvent;
        if (aev?.type !== "toolcall_end") return;
        const tc = aev.toolCall;
        if (!tc || !isWriteTool(tc.name, tc.arguments)) return;
        this._onToolStart(engine, { toolCallId: tc.id, toolName: tc.name, args: tc.arguments }, "preflight");
        return;
      }
      if (type === "tool_execution_start") {
        this._onToolStart(engine, record, "start");
        return;
      }
      if (type === "tool_execution_end") {
        this._onToolEnd(engine, record);
        return;
      }
      if (type === "agent_settled" || type === "agent_end") {
        const st = this.states.get(engine?.id ?? "default");
        if (!st) return;
        if (type === "agent_end") {
          // 可能还有 retry/排队：只落盘，不封口
          void this._writeMeta(st);
          return;
        }
        this._enqueueSeal(st);
      }
    } catch (err) {
      this.log("warn", "turn_changes_note_failed", { reason: err?.message });
    }
  }

  _onToolStart(engine, record, via) {
    if (!isWriteTool(record.toolName, record.args)) return;
    const raw = toolPathFromArgs(record.args);
    if (!raw) return;
    const st = this._stateFor(engine);
    if (!st.startedAt) {
      // 没有看到 user 消息（resume / 直接工具）：当成当前轮，轮号 = 基数（至少 1）
      st.turn = Math.max(st.userCount, 1);
      st.anyTurn = true;
      st.startedAt = Date.now();
    }
    st.cwd = this.getCwd(engine) || st.cwd || "";
    const abs = path.resolve(st.cwd || process.cwd(), raw);
    if (isUnder(this.root, abs)) return; // 不给自己拍快照（防递归）
    if (record.toolCallId) st.toolPaths.set(String(record.toolCallId), abs);
    const entry = this._capture(st, abs, "before");
    if (entry) {
      entry.touches += 1;
      entry.done = false;
      this._scheduleMeta(st);
    }
    this.log("info", "turn_snapshot_before", { session: st.sessionId, turn: st.turn, path: abs, via });
  }

  _onToolEnd(engine, record) {
    const st = this.states.get(engine?.id ?? "default");
    if (!st) return;
    const id = record.toolCallId ? String(record.toolCallId) : null;
    let abs = id ? st.toolPaths.get(id) : null;
    if (!abs && isWriteTool(record.toolName, record.args)) {
      const raw = toolPathFromArgs(record.args);
      if (raw) abs = path.resolve(st.cwd || process.cwd(), raw);
    }
    if (!abs) return;
    if (!isWriteTool(record.toolName, record.args) && !st.files.has(abs)) return;
    const entry = this._capture(st, abs, "after");
    if (entry) {
      entry.done = true;
      entry.isError = record.isError === true;
      this._scheduleMeta(st);
    }
    this.broadcastTurn(engine, st, "update");
  }

  // ---------------- 落盘 / 清理 ----------------

  _scheduleMeta(st) {
    if (st.metaTimer) return;
    st.metaTimer = setTimeout(() => {
      st.metaTimer = null;
      void this._writeMeta(st);
    }, 250);
    st.metaTimer.unref?.();
  }

  _metaPayload(st) {
    return {
      sessionId: st.sessionId,
      turn: st.turn,
      cwd: st.cwd ?? null,
      startedAt: st.startedAt,
      endedAt: st.sealedTurn === st.turn ? Date.now() : null,
      truncated: Boolean(st.truncated),
      limits: {
        maxFiles: this.limits.maxFiles,
        maxFileBytes: this.limits.maxFileBytes,
        maxTotalBytes: this.limits.maxTotalBytes,
        maxRecords: this.limits.maxRecords,
      },
      files: [...st.files.values()].map((e) => ({
        path: e.path,
        hash: e.hash,
        before: { ...e.before },
        after: { ...e.after },
        done: Boolean(e.done),
        touches: e.touches,
      })),
    };
  }

  async _writeMeta(st) {
    if (!st.startedAt || st.turn <= 0) return;
    // 同步快照：调用后 st.turn / st.files 可能立刻被下一轮改写（_seal 在 _beginTurn 里异步跑）
    const dir = this._turnDir(st);
    const payload = this._metaPayload(st);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `${META_NAME}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fsp.rename(tmp, path.join(dir, META_NAME));
    } catch (err) {
      this.log("warn", "turn_meta_write_failed", { dir, reason: err?.message });
    }
  }

  _enqueueSeal(st) {
    const p = this._seal(st).finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  }

  /** 封口当前轮：写 meta + 清理旧轮 */
  async _seal(st) {
    if (!st.startedAt) return;
    if (st.metaTimer) {
      clearTimeout(st.metaTimer);
      st.metaTimer = null;
    }
    // 先同步取快照（dir/payload），再 await：否则下一轮会覆盖 st.turn / st.files
    const dir = this._turnDir(st);
    const payload = this._metaPayload(st);
    const sessionDir = st.sessionDir;
    st.sealedTurn = st.turn;
    await this._writeMetaAt(dir, payload);
    await this._cleanupSession(sessionDir);
    if (st.turn === payload.turn) st.startedAt = null;
  }

  async _writeMetaAt(dir, payload) {
    try {
      await fsp.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `${META_NAME}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fsp.rename(tmp, path.join(dir, META_NAME));
    } catch (err) {
      this.log("warn", "turn_meta_write_failed", { dir, reason: err?.message });
    }
  }

  async _cleanupSession(sessionDir) {
    try {
      const entries = await fsp.readdir(sessionDir, { withFileTypes: true });
      const turns = entries
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => Number(e.name))
        .sort((a, b) => a - b);
      const drop = turns.slice(0, Math.max(0, turns.length - this.limits.keepTurns));
      for (const turn of drop) {
        await fsp.rm(path.join(sessionDir, String(turn)), { recursive: true, force: true });
      }
      if (drop.length) this.log("info", "turn_snapshot_cleanup", { dir: sessionDir, removed: drop });
    } catch {}
  }

  /** 启动清理：所有会话只留最近 N 轮 */
  async cleanupAll() {
    try {
      const dirs = await fsp.readdir(this.root, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        await this._cleanupSession(path.join(this.root, d.name));
      }
    } catch {}
  }

  // ---------------- 读接口 ----------------

  async _readMeta(dir) {
    try {
      return JSON.parse(await fsp.readFile(path.join(dir, META_NAME), "utf8"));
    } catch {
      return null;
    }
  }

  async _turnNumbers(sessionDir) {
    try {
      const entries = await fsp.readdir(sessionDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => Number(e.name))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /** 按 sessionId 找快照目录（内存 → <id> 目录 → 扫 meta.json） */
  async _resolveSessionDir(engine, sessionId) {
    const st = this.states.get(engine?.id ?? "default");
    if (st && (!sessionId || !st.sessionId || st.sessionId === sessionId)) return st.sessionDir;
    const direct = path.join(this.root, safeSegment(sessionId));
    if (fs.existsSync(direct)) return direct;
    // 兜底：sessionId 未知/新会话时目录名是 engine-*，扫 meta.json 认领
    try {
      const dirs = await fsp.readdir(this.root, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const candidate = path.join(this.root, d.name);
        for (const turn of await this._turnNumbers(candidate)) {
          const meta = await this._readMeta(path.join(candidate, String(turn)));
          if (!meta) continue;
          if (sessionId ? meta.sessionId === sessionId : true) return candidate;
        }
      }
    } catch {}
    return null;
  }

  /**
   * 读取某一轮的改动。
   * @param {{engine:any, sessionId?:string|null, turn?:number|null}} opts
   * @returns {Promise<{sessionId:string|null, turn:number|null, latestTurn:number|null, files:Array, truncated:boolean, limits:object}>}
   */
  async read({ engine, sessionId = null, turn = null } = {}) {
    const wantedTurn = Number.isInteger(turn) && turn > 0 ? turn : null;
    const st = this.states.get(engine?.id ?? "default") ?? null;
    const sessionDir = await this._resolveSessionDir(engine, sessionId);
    const numbers = sessionDir ? await this._turnNumbers(sessionDir) : [];
    const latestTurn = numbers.length ? numbers[numbers.length - 1] : null;
    const effectiveTurn = wantedTurn ?? (st?.startedAt ? st.turn : latestTurn);

    let meta = null;
    let memory = null;
    if (sessionDir && effectiveTurn) {
      // 内存里的当前轮是最新的（meta 可能还没落盘）
      if (st && effectiveTurn === st.turn && st.files.size) memory = st;
      meta = await this._readMeta(path.join(sessionDir, String(effectiveTurn)));
    }

    const files = [];
    const source = memory ? memory.files : null;
    const list = source
      ? [...source.values()]
      : (meta?.files ?? []).map((f) => ({ ...f, abs: null }));
    for (const f of list) {
      files.push(await this._describe(sessionDir, effectiveTurn, f, source ? "memory" : "disk"));
    }
    files.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    return {
      sessionId: sessionId ?? st?.sessionId ?? meta?.sessionId ?? null,
      turn: effectiveTurn,
      latestTurn,
      availableTurns: numbers,
      files,
      truncated: Boolean(memory ? memory.truncated : meta?.truncated),
      limits: {
        maxFiles: this.limits.maxFiles,
        maxFileBytes: this.limits.maxFileBytes,
        maxTotalBytes: this.limits.maxTotalBytes,
      },
    };
  }

  async _describe(sessionDir, turn, entry, origin) {
    const before = entry.before ?? { stored: false, exists: false, size: null };
    const after = entry.after ?? { stored: false, exists: false, size: null };
    const done = entry.done !== false;
    let kind = "M";
    if (!before.exists && after.exists) kind = "A";
    else if (before.exists && !after.exists && done) kind = "D";

    const out = {
      path: entry.path,
      kind,
      before: { exists: Boolean(before.exists), size: before.size ?? null, stored: Boolean(before.stored) },
      after: { exists: Boolean(after.exists), size: after.size ?? null, stored: Boolean(after.stored) },
      additions: null,
      deletions: null,
      diff: "",
      diffTruncated: false,
      note: null,
      done,
    };
    const isAdd = !before.exists && after.stored;
    const isDel = before.stored && !after.exists && done;
    if (!(before.stored && after.stored) && !isAdd && !isDel) {
      out.note = before.reason || after.reason || "content-not-stored";
      return out;
    }
    const dir = path.join(sessionDir, String(turn));
    const emptyFile = path.join(dir, EMPTY_NAME);
    let beforeFile = path.join(dir, `${entry.hash}-before`);
    let afterFile = path.join(dir, `${entry.hash}-after`);
    if (isAdd) {
      try {
        await fsp.mkdir(dir, { recursive: true });
        if (!fs.existsSync(emptyFile)) await fsp.writeFile(emptyFile, "", "utf8");
      } catch {}
      const probe = await fsp.stat(emptyFile).catch(() => null);
      if (!probe) {
        out.note = "diff-failed";
        return out;
      }
      beforeFile = emptyFile;
    }
    if (isDel) {
      try {
        await fsp.mkdir(dir, { recursive: true });
        if (!fs.existsSync(emptyFile)) await fsp.writeFile(emptyFile, "", "utf8");
      } catch {}
      const probe = await fsp.stat(emptyFile).catch(() => null);
      if (!probe) {
        out.note = "diff-failed";
        return out;
      }
      afterFile = emptyFile;
    }
    const cacheKey = `${beforeFile}|${afterFile}`;
    const statKey = `${statSafe(beforeFile)?.mtimeMs ?? 0}:${statSafe(afterFile)?.mtimeMs ?? 0}:${origin}`;
    const cached = this.diffCache.get(cacheKey);
    if (cached && cached.key === statKey) return { ...out, ...cached.value };

    const result = await runGitDiff(this.execFileImpl, path.basename(beforeFile), path.basename(afterFile), { cwd: dir });
    if (!result.ok) {
      out.note = "diff-failed";
      this.diffCache.set(cacheKey, { key: statKey, value: { additions: 0, deletions: 0, diff: "", note: "diff-failed" } });
      return out;
    }
    let diff = result.diff;
    let truncated = false;
    if (Buffer.byteLength(diff, "utf8") > this.limits.diffMaxBytes) {
      diff = Buffer.from(diff, "utf8").subarray(0, this.limits.diffMaxBytes).toString("utf8");
      truncated = true;
    }
    const { additions, deletions } = countDiffLines(diff);
    const value = { additions, deletions, diff, diffTruncated: truncated };
    this.diffCache.set(cacheKey, { key: statKey, value });
    return { ...out, ...value };
  }

  /** 测试用：等所有 meta 落盘 */
  async flush() {
    await Promise.all([...this.pending]);
    for (const st of this.states.values()) {
      if (st.metaTimer) {
        clearTimeout(st.metaTimer);
        st.metaTimer = null;
      }
      await this._writeMeta(st);
    }
  }
}

export { EMPTY_NAME };
