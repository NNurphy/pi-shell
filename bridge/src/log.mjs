// bridge/src/log.mjs · N2 日志按大小轮转
//
// 口径（docs/RUNBOOK.md §2.7）：
// - 上限按字节比较（maxMB × 1024 × 1024）；文件**大于**上限才轮转（等于不动）。
// - 保留 keep 份历史：base → base.1 → … → base.<keep>；最旧 base.<keep> 先删，
//   多余的 base.<keep+n> 一并清掉（用户把 keep 调小时不留孤儿）。
// - 轮转后往**新文件**写一行 `log_rotated`（from / to / bytes），便于事后追溯。
// - 同进程：写日志 = 同步 stat → 同步 rename → 同步 append，天然串行；
//   异步入口按文件排队（同一文件不会并发轮转）。
// - 跨进程：不做全局锁。多桥实例写**不同**文件互不影响；同一文件被两个进程同时
//   轮转属未支持场景（Windows rename 冲突会被捕获成 action=error，不影响继续写）。
//
// 零第三方依赖。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const MB = 1024 * 1024;

export const DEFAULT_MAX_MB = 5;
export const DEFAULT_KEEP = 5;
/** 启动时顺带整理的日志（相对日志目录）；bridge.log 由写日志路径自己轮转 */
export const DEFAULT_ROTATE_FILES = ["launcher.log", "notify.log", "mcp.log"];
export const ROTATE_EVENT = "log_rotated";

function positiveNumber(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const text = String(raw).trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function positiveInt(raw, fallback) {
  const value = positiveNumber(raw, NaN);
  if (!Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return int >= 1 ? int : fallback;
}

/** 读上限/保留份数；任何非法值（空/非数字/≤0）回落默认值。 */
export function resolveLogLimits(env = process.env) {
  return {
    maxMB: positiveNumber(env.PI_SHELL_LOG_MAX_MB, DEFAULT_MAX_MB),
    keep: positiveInt(env.PI_SHELL_LOG_KEEP, DEFAULT_KEEP),
  };
}

/** maxMB → 字节上限（非有限/非正数 → 默认 5MB）。 */
export function maxBytesFor(maxMB) {
  const n = Number(maxMB);
  return Math.floor((Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MB) * MB);
}

/** 轮转计划：删除目标 + 重命名链（base → .1，.1 → .2 …，从新到旧）。 */
export function rotationPlan(file, keep = DEFAULT_KEEP) {
  const k = positiveInt(keep, DEFAULT_KEEP);
  const moves = [];
  for (let i = k - 1; i >= 1; i--) moves.push({ from: `${file}.${i}`, to: `${file}.${i + 1}` });
  moves.push({ from: file, to: `${file}.1` });
  return { keep: k, deleteTarget: `${file}.${k}`, moves };
}

/** 轮转行：`<iso>|info|log_rotated|from=.. to=.. bytes=..`（也写进 launcher/notify 等纯文本日志）。 */
export function formatRotationLine(from, to, bytes, date = new Date()) {
  return `${date.toISOString()}|info|${ROTATE_EVENT}|from=${from} to=${to} bytes=${bytes}`;
}

export function formatBytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0) return "-";
  if (value >= MB) return `${(value / MB).toFixed(2)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${value}B`;
}

function errorMessage(err) {
  return err?.code ? `${err.code}: ${err.message}` : String(err?.message ?? err);
}

function statSyncOrNull(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : null;
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
}

/** 找出超出 keep 的历史文件（keep 调小后的孤儿），升序。 */
function extraRotatedFiles(file, keep, readdir = fs.readdirSync) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`);
  let names;
  try {
    names = readdir(dir);
  } catch {
    return [];
  }
  const extras = [];
  for (const name of names) {
    const hit = re.exec(name);
    if (hit && Number(hit[1]) > keep) extras.push({ file: path.join(dir, name), index: Number(hit[1]) });
  }
  return extras.sort((a, b) => a.index - b.index).map((item) => item.file);
}

function newResult(file, maxMB, keep, dryRun) {
  return {
    file,
    size: 0,
    maxMB,
    maxBytes: maxBytesFor(maxMB),
    keep,
    rotated: false,
    dryRun,
    action: "none",
    to: null,
    moves: [],
    deleted: [],
    error: null,
  };
}

/**
 * 按大小轮转（同步）。日志写入路径用这个。
 * @param {string} file
 * @param {number} [maxMB]
 * @param {number} [keep]
 * @param {{dryRun?: boolean, announce?: boolean, now?: () => Date}} [options]
 */
export function rotateIfNeeded(file, maxMB = DEFAULT_MAX_MB, keep = DEFAULT_KEEP, options = {}) {
  const { dryRun = false, announce = true, now = () => new Date() } = options;
  const k = positiveInt(keep, DEFAULT_KEEP);
  const result = newResult(file, maxMB, k, dryRun);

  let size;
  try {
    size = statSyncOrNull(file);
  } catch (err) {
    result.action = "error";
    result.error = errorMessage(err);
    return result;
  }
  if (size === null) {
    result.action = "missing";
    return result;
  }
  result.size = size;
  if (size <= result.maxBytes) return result;

  const plan = rotationPlan(file, k);
  result.to = plan.moves[plan.moves.length - 1].to;
  const extras = extraRotatedFiles(file, k);

  if (dryRun) {
    result.action = "would-rotate";
    result.moves = plan.moves.filter(({ from }) => statSyncOrNull(from) !== null);
    if (statSyncOrNull(plan.deleteTarget) !== null) result.deleted.push(plan.deleteTarget);
    result.deleted.push(...extras.filter((extra) => statSyncOrNull(extra) !== null));
    return result;
  }

  try {
    if (statSyncOrNull(plan.deleteTarget) !== null) {
      fs.unlinkSync(plan.deleteTarget);
      result.deleted.push(plan.deleteTarget);
    }
    for (const extra of extras) {
      if (statSyncOrNull(extra) === null) continue;
      fs.unlinkSync(extra);
      result.deleted.push(extra);
    }
    for (const { from, to } of plan.moves) {
      if (statSyncOrNull(from) === null) continue;
      fs.renameSync(from, to);
      result.moves.push({ from, to });
    }
    result.rotated = result.moves.length > 0;
    result.action = result.rotated ? "rotated" : "none";
    if (result.rotated && announce) {
      try {
        fs.appendFileSync(file, `${formatRotationLine(file, result.to, size, now())}\n`, "utf8");
      } catch {
        // 新文件写不进轮转行不算失败：renames 已经完成
      }
    }
  } catch (err) {
    result.action = "error";
    result.error = errorMessage(err);
  }
  return result;
}

const asyncQueues = new Map();

/**
 * 异步轮转：与同步版同语义，但走 fsp（不阻塞启动）。
 * 同一文件的调用在本进程内排队串行。
 */
export function rotateIfNeededAsync(file, maxMB = DEFAULT_MAX_MB, keep = DEFAULT_KEEP, options = {}) {
  const key = path.resolve(file);
  const prev = asyncQueues.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => rotateAsync(file, maxMB, keep, options),
    () => rotateAsync(file, maxMB, keep, options),
  );
  const guard = run.catch(() => {});
  asyncQueues.set(key, guard);
  guard.then(() => {
    if (asyncQueues.get(key) === guard) asyncQueues.delete(key);
  });
  return run;
}

async function rotateAsync(file, maxMB, keep, options) {
  const { dryRun = false, announce = true, now = () => new Date() } = options;
  const k = positiveInt(keep, DEFAULT_KEEP);
  const result = newResult(file, maxMB, k, dryRun);

  let size;
  try {
    const st = await fsp.stat(file);
    size = st.isFile() ? st.size : null;
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      result.action = "missing";
      return result;
    }
    result.action = "error";
    result.error = errorMessage(err);
    return result;
  }
  if (size === null) {
    result.action = "missing";
    return result;
  }
  result.size = size;
  if (size <= result.maxBytes) return result;

  const plan = rotationPlan(file, k);
  result.to = plan.moves[plan.moves.length - 1].to;
  const extras = extraRotatedFiles(file, k);

  try {
    if (await exists(plan.deleteTarget)) {
      await fsp.unlink(plan.deleteTarget);
      result.deleted.push(plan.deleteTarget);
    }
    for (const extra of extras) {
      if (!(await exists(extra))) continue;
      await fsp.unlink(extra);
      result.deleted.push(extra);
    }
    for (const { from, to } of plan.moves) {
      if (!(await exists(from))) continue;
      await fsp.rename(from, to);
      result.moves.push({ from, to });
    }
    result.rotated = result.moves.length > 0;
    result.action = result.rotated ? "rotated" : "none";
    if (result.rotated && announce) {
      try {
        await fsp.appendFile(file, `${formatRotationLine(file, result.to, size, now())}\n`, "utf8");
      } catch {
        // 同上：轮转行写不进不算失败
      }
    }
  } catch (err) {
    result.action = "error";
    result.error = errorMessage(err);
  }
  return result;
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写一行日志（写入前检查大小 → 必要时轮转 → append）。永不抛：
 * 日志写不了不应拦住桥。
 * @returns {{ok: boolean, rotated: object|null, error: string|null}}
 */
export function appendWithRotation(file, line, options = {}) {
  const { maxMB = DEFAULT_MAX_MB, keep = DEFAULT_KEEP, now } = options;
  let rotated = null;
  try {
    const size = statSyncOrNull(file);
    if (size !== null && size > maxBytesFor(maxMB)) {
      rotated = rotateIfNeeded(file, maxMB, keep, { now });
    }
    fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`, "utf8");
    return { ok: true, rotated, error: null };
  } catch (err) {
    return { ok: false, rotated, error: errorMessage(err) };
  }
}
