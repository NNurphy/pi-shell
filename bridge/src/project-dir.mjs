// 会话项目目录（A1 / T1）：把「用户输入的目录」变成可用的绝对路径。
// 只做校验与归一化，不碰引擎；调用方负责「先校验、后停进程」的顺序。
import fsp from "node:fs/promises";
import path from "node:path";

function badRequest(message) {
  return Object.assign(new Error(message), { code: "BAD_REQUEST" });
}

/** 去尾部分隔符，但保留盘符根（`C:\`）与 POSIX 根（`/`） */
function stripTrailingSep(value) {
  if (value.length <= 1) return value;
  const trimmed = value.replace(/[\\/]+$/, "");
  if (!trimmed) return path.sep;
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + path.sep; // `C:` 与 `C:\` 视为同一目录
  return trimmed;
}

/**
 * 归一化目录输入：非空字符串 → `path.resolve` → 去尾部分隔符。
 * @throws {Error & {code:"BAD_REQUEST"}} 输入为空/非字符串
 */
export function normalizeProjectDir(input) {
  if (typeof input !== "string" || !input.trim()) throw badRequest("cwd 必填");
  return stripTrailingSep(path.resolve(input));
}

/**
 * 校验目录：必须是**已存在**的目录。
 * @throws {Error & {code:"BAD_REQUEST"}} 不存在 / 不是目录 / 输入非法
 * @returns {Promise<string>} 归一化后的绝对路径
 */
export async function resolveProjectDir(input) {
  const resolved = normalizeProjectDir(input);
  let stat = null;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) throw badRequest(`目录不存在或不是目录：${resolved}`);
  return resolved;
}

/**
 * 两个目录是否相同：忽略大小写与尾部分隔符（Windows 语义；本仓库只支持 Windows 部署）。
 * 任一侧非法/为空 → false（调用方按「需要切换」处理，最终由 resolveProjectDir 拦）。
 */
export function sameProjectDir(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a.trim() || !b.trim()) return false;
  return normalizeProjectDir(a).toLowerCase() === normalizeProjectDir(b).toLowerCase();
}
