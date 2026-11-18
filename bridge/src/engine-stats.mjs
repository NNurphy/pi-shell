// pi-shell bridge · N1-b：引擎资源统计（进程树 RSS + 会话标题）
//
// 为什么单独一个模块：
//   - RSS 必须取「整棵进程树」（pi + MCP 子进程），而 health 是 2s 轮询的高频端点，
//     绝不能每次 health 都跑 PowerShell（一次 ≈150–300ms）。这里做 5s 快照缓存。
//   - 一次 PowerShell 批量取全表（ProcessId/ParentProcessId/WorkingSetSize），
//     再在 JS 里按 ParentProcessId 建树，给每个引擎根 pid 求子树和：N 个引擎仍只调 1 次。
//   - 会话标题从会话文件头读（64KB），按 path+mtime+size 缓存，避免 stats 每次都扫全表。
//
// 零第三方依赖：只用 node:child_process / node:fs/promises。

import { execFile } from "node:child_process";
import fsp from "node:fs/promises";

export const DEFAULT_RSS_CACHE_MS = 5000;
export const DEFAULT_TITLE_CACHE_MS = 30000;
export const TITLE_SCAN_BYTES = 64 * 1024;

// PowerShell：一次拿全表。ConvertTo-Json -InputObject @(...) 保证单元素也输出数组，空结果输出 []。
const PS_SCRIPT =
  "$ErrorActionPreference='Stop'; " +
  "$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize; " +
  "ConvertTo-Json -InputObject @($rows) -Compress";

/** 默认执行器：powershell -NoProfile（Windows；本项目的唯一目标平台） */
function defaultRun() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 把 PowerShell 输出解析成 [{pid, ppid, workingSetBytes}]（坏行跳过，不整体失败） */
export function parseProcessRows(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((row) => ({
      pid: toInt(row?.ProcessId),
      ppid: toInt(row?.ParentProcessId),
      workingSetBytes: toInt(row?.WorkingSetSize),
    }))
    .filter((row) => row.pid > 0);
}

/** 纯函数：以某个 pid 为根求整棵树 RSS（含根），单位字节。rows 来自 parseProcessRows。 */
export function treeRssBytes(rows, rootPid) {
  const root = toInt(rootPid);
  if (root <= 0) return 0;
  const byPid = new Map();
  const children = new Map();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  if (!byPid.has(root)) return 0;
  const seen = new Set();
  const queue = [root];
  let total = 0;
  while (queue.length) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += byPid.get(pid)?.workingSetBytes ?? 0;
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return total;
}

/**
 * 进程快照提供器：cacheMs 内复用同一份全表；并发调用共享同一个 in-flight Promise。
 * @returns {{rssByRoot:(roots:number[])=>Promise<Map<number,number>>, snapshot:()=>Promise<object[]>}}
 */
export function createProcessSnapshotProvider({
  cacheMs = DEFAULT_RSS_CACHE_MS,
  now = Date.now,
  run = defaultRun,
  log = () => {},
} = {}) {
  let cache = null; // {at, rows}
  let inflight = null;
  let warned = false;

  async function snapshot() {
    if (cache && now() - cache.at < cacheMs) return cache.rows;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const rows = parseProcessRows(await run());
        cache = { at: now(), rows };
        return rows;
      } catch (err) {
        if (!warned) {
          warned = true;
          log("warn", "rss_snapshot_failed", { reason: err?.code || err?.message });
        }
        // 失败也放一个空快照进缓存：5s 内不再反复触发 PowerShell（避免每次统计都卡住事件循环）
        cache = { at: now(), rows: [] };
        return cache.rows;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** roots: 引擎根 pid 数组 → Map<pid, MB>（四舍五入到 0.1） */
  async function rssByRoot(roots) {
    const unique = [...new Set((roots ?? []).map(toInt).filter((pid) => pid > 0))];
    const out = new Map();
    if (!unique.length) return out;
    const rows = await snapshot();
    for (const pid of unique) {
      const bytes = treeRssBytes(rows, pid);
      // 根进程不存在（刚退出/正在重启）→ 不给 0 假数据，直接缺省让上层填 null
      if (!rows.some((row) => row.pid === pid)) continue;
      out.set(pid, Math.round((bytes / (1024 * 1024)) * 10) / 10);
    }
    return out;
  }

  return { snapshot, rssByRoot };
}

/** 从会话文件头文本里取第一条 user 消息的标题（与 sessions.mjs 的口径一致） */
export function titleFromSessionText(text, sessionId = null) {
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || rec.type !== "message") continue;
    if (rec.message?.role !== "user") continue;
    const content = rec.message?.content;
    let raw = "";
    if (typeof content === "string") raw = content;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") raw += block.text;
      }
    }
    const title = raw.replace(/\s+/g, " ").trim().slice(0, 30);
    if (title) return title;
  }
  return sessionId ? String(sessionId).slice(0, 8) : "";
}

/**
 * 会话标题读取器：按文件 mtime+size 缓存（stats 面板一次要 N 条标题，不能每次都读盘）。
 * 文件不存在/读失败 → 回退 sessionId 前 8 位，绝不抛。
 */
export function createSessionTitleReader({ cacheMs = DEFAULT_TITLE_CACHE_MS, now = Date.now, log = () => {} } = {}) {
  const cache = new Map(); // filePath → {mtimeMs, size, title, at}

  async function title(filePath, sessionId = null) {
    if (!filePath) return sessionId ? String(sessionId).slice(0, 8) : "";
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return sessionId ? String(sessionId).slice(0, 8) : "";
    }
    const hit = cache.get(filePath);
    if (hit && now() - hit.at < cacheMs && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.title;
    try {
      const handle = await fsp.open(filePath, "r");
      let buf;
      try {
        const length = Math.min(stat.size, TITLE_SCAN_BYTES);
        buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, 0);
      } finally {
        await handle.close();
      }
      const parsed = titleFromSessionText(buf.toString("utf8"), sessionId);
      cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, title: parsed, at: now() });
      return parsed;
    } catch (err) {
      log("warn", "session_title_read_failed", { reason: err?.code || err?.message });
      return sessionId ? String(sessionId).slice(0, 8) : "";
    }
  }

  return { title };
}
