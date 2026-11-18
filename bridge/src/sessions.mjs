// pi-shell bridge · T-06：会话索引（只读）
// 职责（03 §7）：扫 PI_SHELL_SESSIONS_DIR/*/ ，取 header + 首条 user（≤64 条/64KB）+ 末条 message（≤120 字），
// 以 {mtimeMs,size} 为缓存键。**不写任何文件**，也不整份读入内存（小文件一次读完，大文件只读头/尾）。
//
// 容错口径（2026-11-05 定值）：
// - 无 user 消息 → title 回退为 sessionId 前 8 位
// - status 只由桥传入的当前 sessionId 判定 attached，其余 unknown
// - 文件/目录读失败 → 该项 status=unknown，并把原因放进 warnings[]，不整体 500

import fsp from "node:fs/promises";
import path from "node:path";

export const HEAD_SCAN_BYTES = 64 * 1024; // 首条 user 的扫描上限：64 条 / 64KB
export const HEAD_SCAN_LINES = 64;
export const TAIL_SCAN_BYTES = 256 * 1024; // 末条 message：从文件尾读这么多；不够再往上加
export const TAIL_SCAN_MAX_BYTES = 1024 * 1024;
export const TITLE_MAX_CHARS = 30;
export const SNIPPET_MAX_CHARS = 120;

/** 从消息对象里取纯文本 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 逐行切分（只按 \n，去尾部 \r）；dropFirst 用于尾部窗口的第一行可能是半行 */
function splitLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split("\n");
  if (dropLast) lines.pop(); // 末尾可能是不完整的行
  if (dropFirst) lines.shift(); // 头部窗口之外的前一条可能被截断
  return lines;
}

/**
 * 直接读会话文件的条目（T-17 两段式：先读文件渲染，不等 switch_session）。
 * 返回与 `get_entries` 同构：`{entries, leafId, sessionId, cwd}`（跳过 session header）。
 * 只读、按行切分（仅 \n），不依赖 pi。
 */
export async function readSessionEntries(filePath, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw Object.assign(new Error("不是文件"), { code: "BAD_REQUEST" });
  if (st.size > maxBytes) throw Object.assign(new Error(`会话文件过大（${st.size} 字节）`), { code: "BAD_REQUEST" });
  const buf = await fsp.readFile(filePath);
  const lines = buf.toString("utf8").split("\n");
  let header = null;
  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 半行/坏行：跳过（与 03 §9 的扫描口径一致）
    }
    if (!rec || typeof rec !== "object") continue;
    if (rec.type === "session") {
      header = rec;
      continue;
    }
    if (rec.type === "message" && !rec.id) continue;
    entries.push(rec);
  }
  return {
    entries,
    leafId: entries.length ? entries[entries.length - 1].id ?? null : null,
    sessionId: header?.id ?? null,
    cwd: header?.cwd ?? null,
  };
}

export class SessionIndex {
  /**
   * @param {object} opts
   * @param {string} opts.sessionsDir 扫描根（= 子进程的 --session-dir）
   * @param {string} [opts.agentSessionsDir] agent 专属会话根（PI_SHELL_AGENT_SESSIONS_DIR）：单独扫描，
   *        命中的会话 origin=agent（目录规则），用于前端「🤖 Agent 会话」独立板块
   * @param {(info:{fileRelPath:string,filePath:string,cwd:string,createdAt:number|null}) => Promise<{origin:string,reason:string}>|{origin:string,reason:string}} [opts.originFor]
   *        来源解析器（桥注入：sidecar 优先 + classifyOrigin + 持久化）
   * @param {(level:string, event:string, fields?:object)=>void} [opts.log]
   */
  constructor({ sessionsDir, agentSessionsDir, originFor, log } = {}) {
    this.sessionsDir = sessionsDir || "";
    this.agentSessionsDir = agentSessionsDir || "";
    this.originFor = typeof originFor === "function" ? originFor : null;
    this.log = log || (() => {});
    this.cache = new Map(); // path → {mtimeMs, size, summary}
  }

  /** 失效缓存（fork/clone 会新建会话文件，需要立刻能看到） */
  invalidate() {
    this.cache.clear();
  }

  /**
   * 列出会话（按目录分组）。
   * @param {{q?:string, currentSessionId?:string}} opts
   * @returns {Promise<{groups:Array, warnings:Array, stats:object}>}
   */
  async list({ q = "", currentSessionId = null } = {}) {
    const startedAt = Date.now();
    const warnings = [];
    const groups = [];
    let files = 0;
    let cacheHits = 0;
    const seen = new Set();

    if (!this.sessionsDir) {
      return {
        groups: [],
        warnings: [{ path: null, reason: "PI_SHELL_SESSIONS_DIR 未设置：无法扫描会话（03 §3）" }],
        stats: { dirs: 0, files: 0, cacheHits: 0, scanMs: Date.now() - startedAt },
      };
    }

    let dirents = [];
    try {
      dirents = await fsp.readdir(this.sessionsDir, { withFileTypes: true });
    } catch (err) {
      const reason = err?.code === "ENOENT" ? "会话目录不存在" : `会话目录不可读：${err?.code || err?.message}`;
      return {
        groups: [],
        warnings: [{ path: this.sessionsDir, reason }],
        stats: { dirs: 0, files: 0, cacheHits: 0, scanMs: Date.now() - startedAt },
      };
    }

    // 目录/扁平两轮扫描（两轮扫描实现在 _scanRoot）
    // prefix 只用于 agent 根的组键；keyPrefix 用于 sidecar 键（主根也带目录名，键才能唯一定位）
    const counters = { files: () => (files += 1), cacheHits: () => (cacheHits += 1) };
    const primary = await this._scanRoot({
      root: this.sessionsDir,
      dirents,
      currentSessionId,
      warnings,
      seen,
      counters,
      keyPrefix: path.basename(this.sessionsDir),
    });
    groups.push(...primary.groups);

    // agent 专属会话根（默认 <agentDir>/sessions-agents）：单独扫一轮，目录规则自动归类为 agent。
    // 键前缀用目录名（如 sessions-agents）与主根区分，避免 sidecar 键碰撞。
    if (this.agentSessionsDir && path.resolve(this.agentSessionsDir) !== path.resolve(this.sessionsDir)) {
      let agentDirents = null;
      try {
        agentDirents = await fsp.readdir(this.agentSessionsDir, { withFileTypes: true });
      } catch (err) {
        if (err?.code !== "ENOENT") warnings.push({ path: this.agentSessionsDir, reason: `agent 会话目录不可读：${err?.code || err?.message}` });
      }
      if (agentDirents) {
        const prefix = path.basename(this.agentSessionsDir);
        const agentScan = await this._scanRoot({
          root: this.agentSessionsDir,
          dirents: agentDirents,
          currentSessionId,
          warnings,
          seen,
          prefix,
          keyPrefix: prefix,
          counters,
        });
        // 跨根去重：agent 根与主根可能有同一个 cwd（界面会看到两个同名分组）。
        // 只做「agent 根 → 主根」的合并，根内分组数语义（A-01）不变。
        const cwdKey = (v) => (process.platform === "win32" ? String(v || "").toLowerCase() : String(v || ""));
        for (const ag of agentScan.groups) {
          const hit = groups.find((g) => cwdKey(g.cwd) === cwdKey(ag.cwd));
          if (hit) {
            hit.sessions.push(...ag.sessions);
            hit.sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
          } else {
            groups.push(ag);
          }
        }
      }
    }

    // 缓存清理：只保留本次扫描到的文件
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);

    const filtered = q
      ? groups
          .map((g) => ({ ...g, ...groupOrigin(g.sessions.filter((s) => matches(s, q))), sessions: g.sessions.filter((s) => matches(s, q)) }))
          .filter((g) => g.sessions.length > 0)
      : groups;

    const stats = { dirs: groups.length, files, cacheHits, scanMs: Date.now() - startedAt };
    this.log("info", "sessions_listed", { dirs: stats.dirs, files, cacheHits, scanMs: stats.scanMs, q: q || null });
    return { groups: filtered, warnings, stats };
  }

  /**
   * 扫一个根：`<root>/<编码 cwd>/*.jsonl` 各成一组；根下的扁平 *.jsonl 按 header.cwd 分组。
   * @returns {Promise<{groups:Array}>}
   */
  async _scanRoot({ root, dirents, currentSessionId, warnings, seen, prefix = "", keyPrefix = prefix, counters }) {
    const groups = [];
    const dirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const dirName of dirs) {
      const dirPath = path.join(root, dirName);
      let names = [];
      try {
        names = (await fsp.readdir(dirPath)).filter((n) => n.endsWith(".jsonl")).sort();
      } catch (err) {
        warnings.push({ path: dirPath, reason: `目录不可读：${err?.code || err?.message}` });
        continue; // 读不到文件名就无法列举
      }
      if (names.length === 0) continue;

      const sessions = [];
      for (const name of names) {
        const filePath = path.join(dirPath, name);
        seen.add(filePath);
        counters.files();
        const summary = await this._summarizeSafe(filePath, {
          dirName,
          currentSessionId,
          relPath: joinKey(keyPrefix, dirName, name),
        });
        if (summary.fromCache) counters.cacheHits();
        sessions.push(summary.value);
        warnings.push(...summary.warnings);
      }

      sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const cwd = sessions[0]?.cwd || dirName;
      groups.push({ cwd, dir: prefix ? `${prefix}/${dirName}` : dirName, ...groupOrigin(sessions), sessions });
    }

    // --session-dir 指定目录时，pi 直接落在根目录（无编码 cwd 子目录）→ 按 header.cwd 分组
    const flatNames = dirents.filter((d) => d.isFile() && d.name.endsWith(".jsonl")).map((d) => d.name).sort();
    if (flatNames.length) {
      const byCwd = new Map();
      for (const name of flatNames) {
        const filePath = path.join(root, name);
        seen.add(filePath);
        counters.files();
        const summary = await this._summarizeSafe(filePath, {
          dirName: "",
          currentSessionId,
          relPath: joinKey(keyPrefix, name),
        });
        if (summary.fromCache) counters.cacheHits();
        warnings.push(...summary.warnings);
        const key = summary.value.cwd || "(flat)";
        if (!byCwd.has(key)) byCwd.set(key, []);
        byCwd.get(key).push(summary.value);
      }
      for (const [cwd, sessions] of byCwd) {
        sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        // 组键必须唯一：扁平布局下同一物理根会按 header.cwd 拆成多个组，
        // 只写 `<root>:flat` 会让不同 cwd 的组撞同一个键（前端展开状态按 dir 存 → 点一个展开俩）。
        const flatKey = prefix ? `${prefix}:flat` : root;
        groups.push({ cwd, dir: cwd && cwd !== "(flat)" ? `${flatKey}:${cwd}` : flatKey, flat: true, ...groupOrigin(sessions), sessions });
      }
    }
    return { groups };
  }

  /** 读取失败不抛出，降级为 status=unknown 的条目 + warning（项目定值：不整体 500） */
  async _summarizeSafe(filePath, { dirName, currentSessionId, relPath = "" }) {
    try {
      const summary = await this._summarize(filePath, { dirName, currentSessionId });
      return {
        value: await this._withOrigin(summary.value, { filePath, relPath }),
        fromCache: summary.fromCache,
        warnings: summary.warning ? [summary.warning] : [],
      };
    } catch (err) {
      const name = path.basename(filePath);
      const fallback = {
        id: name.replace(/\.jsonl$/, ""),
        path: filePath,
        title: name.slice(0, 8),
        updatedAt: "",
        cwd: dirName || this.sessionsDir,
        lastSnippet: "(读取失败)",
        status: "unknown",
      };
      return {
        value: await this._withOrigin(fallback, { filePath, relPath }).catch(() => fallback),
        fromCache: false,
        warnings: [{ path: filePath, reason: `读取失败：${err?.code || err?.message}` }],
      };
    }
  }

  /**
   * 给会话摘要补 origin（来源分类）。
   * 分类是**每次列表都重算**的（工具窗口集合会变），但桥侧 sidecar 一旦记录就以记录为准。
   */
  async _withOrigin(value, { filePath, relPath }) {
    if (!this.originFor) return value;
    let origin = "user";
    try {
      const resolved = await this.originFor({
        fileRelPath: relPath || path.basename(filePath),
        filePath,
        cwd: value.cwd,
        createdAt: value.createdAt ?? null,
      });
      if (resolved?.origin) origin = resolved.origin;
    } catch (err) {
      this.log("warn", "origin_classify_failed", { path: filePath, reason: err?.code || err?.message });
    }
    return { ...value, origin };
  }

  async _summarize(filePath, { dirName, currentSessionId }) {
    const st = await fsp.stat(filePath); // 每个文件只 stat 一次
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return { value: withStatus(cached.summary, currentSessionId), fromCache: true };
    }

    const fh = await fsp.open(filePath, "r");
    try {
      const size = st.size;
      const headLen = Math.min(size, HEAD_SCAN_BYTES);
      const headBuf = Buffer.alloc(headLen);
      let headRead = 0;
      while (headRead < headLen) {
        const { bytesRead } = await fh.read(headBuf, headRead, headLen - headRead, headRead);
        if (bytesRead <= 0) break;
        headRead += bytesRead;
      }
      const headText = headBuf.subarray(0, headRead).toString("utf8");
      const wholeFile = size <= HEAD_SCAN_BYTES;
      const headLines = splitLines(headText, { dropLast: !wholeFile });

      const first = headLines.length ? parseLine(headLines[0]) : null;
      // header 必须是 type==="session" 的条目；否则第 0 行可能是消息（其 id 是 entry id，不是 session id）
      const header = first?.type === "session" ? first : null;
      const headerId = typeof header?.id === "string" ? header.id : null;
      // cwd 以 header 为准（H-7：真实会话 header 必带 cwd）；缺失时退化为目录名原文，
      // 不猜解码（pi 的目录名把 ':' 与 '\\' 都编码成 '-'，解码有歧义，猜错比原文更糟）
      const cwd = typeof header?.cwd === "string" && header.cwd ? header.cwd : dirName;
      const sessionId = headerId || path.basename(filePath, ".jsonl");

      // 首条 user（≤64 条 / 64KB）
      let title = "";
      const startIdx = header ? 1 : 0; // 无 header 时第 0 行也要参与首条 user 的扫描
      for (let i = startIdx; i < Math.min(headLines.length, HEAD_SCAN_LINES); i++) {
        const entry = parseLine(headLines[i]);
        if (entry?.type === "message" && entry.message?.role === "user") {
          title = oneLine(messageText(entry.message)).slice(0, TITLE_MAX_CHARS);
          if (title) break;
        }
      }
      if (!title) title = String(sessionId).slice(0, 8); // 项目定值：无 user 消息 → sessionId 前 8 位

      // 末条 message
      let last = null;
      if (wholeFile) {
        for (let i = headLines.length - 1; i >= 0; i--) {
          const entry = parseLine(headLines[i]);
          if (entry?.type === "message") {
            last = entry;
            break;
          }
        }
      } else {
        last = await findLastMessage(fh, size);
      }

      const updatedAt = last?.timestamp ? new Date(last.timestamp).toISOString() : new Date(st.mtimeMs).toISOString();
      const snippet = last ? snippetOf(last) : "(无消息)";

      const warning = headerId
        ? null
        : { path: filePath, reason: "缺少 session header：标题与 cwd 已回退（03 §7）" };

      const summary = { id: String(sessionId), path: filePath, title, updatedAt, cwd, lastSnippet: snippet };
      summary.createdAt = typeof header?.timestamp === "number" ? header.timestamp : null;
      this.cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, summary });
      return { value: withStatus(summary, currentSessionId), fromCache: false, warning };
    } finally {
      await fh.close();
    }
  }
}

function withStatus(summary, currentSessionId) {
  return { ...summary, status: currentSessionId && summary.id === currentSessionId ? "attached" : "unknown" };
}

/** sidecar 键：可选的根名前缀 + 相对会话根路径（统一 '/'） */
function joinKey(prefix, ...parts) {
  return [prefix, ...parts]
    .filter((part) => part != null && part !== "")
    .join("/")
    .replace(/\\/g, "/");
}

/** 分组 origin：组内全同则给该值，混用则 "mixed"（分组本身不变） */
function groupOrigin(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return {};
  const first = sessions[0]?.origin;
  if (!first) return {};
  return sessions.every((s) => s?.origin === first) ? { origin: first } : { origin: "mixed" };
}

function matches(s, q) {
  const needle = q.toLowerCase();
  return (
    String(s.title || "").toLowerCase().includes(needle) ||
    String(s.lastSnippet || "").toLowerCase().includes(needle)
  );
}

function snippetOf(entry) {
  const text = oneLine(messageText(entry.message));
  if (text) return text.slice(0, SNIPPET_MAX_CHARS);
  const role = entry.message?.role ?? "message";
  return `[${role}]`.slice(0, SNIPPET_MAX_CHARS); // 纯工具调用等无文本消息
}

/** 从文件尾部窗口向上找最后一条 type==="message" 的条目；窗口不够则加倍，最多 1MB */
async function findLastMessage(fh, size) {
  let window = TAIL_SCAN_BYTES;
  for (;;) {
    const len = Math.min(size, window);
    const start = size - len;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const { bytesRead } = await fh.read(buf, read, len - read, start + read);
      if (bytesRead <= 0) break;
      read += bytesRead;
    }
    const text = buf.subarray(0, read).toString("utf8");
    const lines = splitLines(text, { dropFirst: start > 0, dropLast: false });
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseLine(lines[i]);
      if (entry?.type === "message") return entry;
    }
    if (len >= size || window >= TAIL_SCAN_MAX_BYTES) return null;
    window = Math.min(window * 2, TAIL_SCAN_MAX_BYTES);
  }
}
