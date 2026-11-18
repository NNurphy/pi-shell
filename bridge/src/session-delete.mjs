// pi-shell bridge · 会话删除（带可撤销备份）
// 职责：把一个 .jsonl 会话文件**移动**到 <备份根>/<YYYYMMDD-HHmmss>/<相对会话根路径>，
// 而不是直接 unlink —— 删错了能从磁盘捞回来。
//
// 铁律（本模块的全部价值就在这里）：
// - 只删「会话根内」的 .jsonl（多个根：主会话根 + agent 会话根）；越界 403，非 .jsonl 400
// - 当前已附着的会话一律 409（pi 只有一个当前会话，删它等于删自己正在用的文件）
// - 先备份成功、并确认原路径已不存在，才算删除成功；移动失败 **绝不** 删原文件
// - 本模块不读文件正文（只 stat），不写日志（由调用方记 session_deleted）

import fsp from "node:fs/promises";
import path from "node:path";

const WIN = process.platform === "win32";

/** 路径比较口径：Windows 大小写不敏感 */
function norm(p) {
  return WIN ? String(p).toLowerCase() : String(p);
}

/** child 是否落在 root 内（root 本身不算「内」） */
export function isInside(child, root) {
  const c = norm(child);
  const r = norm(root);
  if (!c || !r) return false;
  return c === r ? false : c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function fail(status, code, message) {
  return Object.assign(new Error(message), { code, status });
}

/** 备份目录名：本地时间 <YYYYMMDD-HHmmss> */
export function backupStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function exists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除（= 移到备份目录）一个会话文件。
 * @param {object} opts
 * @param {string} opts.rawPath        请求里的 path（绝对路径；相对路径按进程 cwd 解析）
 * @param {string[]} opts.roots        允许删除的会话根（主根 + agent 根，空值自动忽略）
 * @param {string} opts.backupRoot     备份根（<repo>/backups/deleted-sessions）
 * @param {string|null} [opts.attachedFile] 桥当前已附着的会话文件（get_state.sessionFile）
 * @param {Date} [opts.now]            备份时间戳（测试注入）
 * @returns {Promise<{deleted:string, backup:string, bytes:number}>}
 */
export async function deleteSessionFile({ rawPath, roots = [], backupRoot, attachedFile = null, now = new Date() }) {
  if (typeof rawPath !== "string" || !rawPath.trim()) throw fail(400, "BAD_REQUEST", "path 必填");
  if (!backupRoot) throw fail(500, "PI_ERROR", "备份根未配置");

  const resolved = path.resolve(rawPath.trim());
  const rootList = [...new Set(roots.filter((r) => typeof r === "string" && r).map((r) => path.resolve(r)))];

  // 1) 白名单（先判越界，再判扩展名：C:\Windows\win.ini 这类必须得到 403 而不是 400）
  const owner = rootList.find((root) => isInside(resolved, root));
  if (!owner) throw fail(403, "FORBIDDEN", "只能删除会话目录内的文件");

  // 2) 只接受 .jsonl
  if (!resolved.toLowerCase().endsWith(".jsonl")) throw fail(400, "BAD_REQUEST", "path 必须是 .jsonl 会话文件");

  // 3) 必须存在且是普通文件
  let st;
  try {
    st = await fsp.stat(resolved);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw fail(404, "NOT_FOUND", "会话文件不存在");
    throw fail(400, "BAD_REQUEST", `会话文件不可读：${err?.code || err?.message}`);
  }
  if (!st.isFile()) throw fail(400, "BAD_REQUEST", "path 必须指向文件");

  // 4) 符号链接逃逸：真实路径仍须在（真实）根内
  let real;
  try {
    real = await fsp.realpath(resolved);
  } catch {
    throw fail(404, "NOT_FOUND", "会话文件不存在");
  }
  let ownerReal = owner;
  try {
    ownerReal = await fsp.realpath(owner);
  } catch {
    // 根本身不可解析（罕见）：保留字面根，按上面已通过的白名单继续
  }
  if (!isInside(real, ownerReal)) throw fail(403, "FORBIDDEN", "会话文件不在会话根内（符号链接逃逸）");

  // 5) 保护：当前已附着的会话
  if (typeof attachedFile === "string" && attachedFile.trim()) {
    const attached = path.resolve(attachedFile.trim());
    if (norm(attached) === norm(resolved) || norm(attached) === norm(real)) {
      throw fail(409, "CONFLICT", "会话正在使用：请先中止或切走");
    }
  }

  // 6) 备份：<backupRoot>/<stamp>/<相对会话根路径>（保留目录结构；同秒同名则加序号，不覆盖旧备份）
  const relPath = path.relative(ownerReal, real) || path.basename(real);
  if (relPath.startsWith("..") || path.isAbsolute(relPath)) throw fail(403, "FORBIDDEN", "会话文件不在会话根内");
  const stamp = backupStamp(now);
  let backupDir = path.join(backupRoot, stamp);
  let backupPath = path.join(backupDir, relPath);
  for (let i = 1; i <= 50 && (await exists(backupPath)); i += 1) {
    backupDir = path.join(backupRoot, `${stamp}-${i}`);
    backupPath = path.join(backupDir, relPath);
  }

  const bytes = st.size;
  try {
    await fsp.mkdir(path.dirname(backupPath), { recursive: true });
  } catch (err) {
    throw fail(502, "PI_ERROR", `备份目录创建失败（未删除原文件）：${err?.code || err?.message}`);
  }

  try {
    await fsp.rename(real, backupPath);
  } catch (renameErr) {
    const fallback = ["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EBUSY"].includes(renameErr?.code);
    if (!fallback) {
      throw fail(502, "PI_ERROR", `备份失败（未删除原文件）：${renameErr?.code || renameErr?.message}`);
    }
    // 跨卷 / 被占用：copy → 校验字节数 → 才删原文件；任何一步失败都保留原文件
    try {
      await fsp.copyFile(real, backupPath);
      const copied = await fsp.stat(backupPath);
      if (copied.size !== bytes) throw new Error(`备份字节数不一致（${copied.size} ≠ ${bytes}）`);
      await fsp.unlink(real);
    } catch (copyErr) {
      try {
        await fsp.rm(backupPath, { force: true });
      } catch {}
      throw fail(502, "PI_ERROR", `备份失败（未删除原文件）：${copyErr?.message}`);
    }
  }

  // 7) 确认原路径已不存在 + 备份完整（任一不成立都明确失败，不装作删成功）
  if (await exists(resolved)) throw fail(502, "PI_ERROR", "删除后原文件仍存在");
  let backupStat;
  try {
    backupStat = await fsp.stat(backupPath);
  } catch {
    throw fail(502, "PI_ERROR", "备份文件不存在");
  }
  if (backupStat.size !== bytes) throw fail(502, "PI_ERROR", `备份字节数不一致（${backupStat.size} ≠ ${bytes}）`);

  return { deleted: resolved, backup: backupPath, bytes };
}
