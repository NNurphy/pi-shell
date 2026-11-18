// pi-shell bridge · T-17：工作区文件（只读）
// 安全模型（03 §11.7）：path.resolve + realpath 双重校验，任何越界（..、绝对路径、盘符、符号链接/junction 逃逸）→ 403。
// 大小限制（03 §5）：文本 ≤1 MiB、二进制 ≤8 MiB，超限 → 400 BAD_REQUEST。
// 只读：不写、不删、不改。

import fsp from "node:fs/promises";
import path from "node:path";

export const TEXT_MAX_BYTES = 1024 * 1024; // 1 MiB
export const BINARY_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB

const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".log", ".json", ".jsonl", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".css", ".scss", ".html", ".htm", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".sh", ".bash",
  ".ps1", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".sql", ".csv",
]);

const MIME = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

export class WorkspaceFiles {
  /** @param {{getRoot: () => string}} opts 根目录随工作区切换而变化，用 getter */
  constructor({ getRoot }) {
    this.getRoot = getRoot;
  }

  root() {
    return path.resolve(this.getRoot());
  }

  /** 解析并校验：返回 {rootReal, abs, real, stat}；越界/不存在抛错 */
  async resolveSafe(relPath) {
    const root = this.root();
    const raw = typeof relPath === "string" ? relPath : "";
    if (raw.includes("\0")) throw err("BAD_REQUEST", "路径含非法字符");
    if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) throw err("FORBIDDEN", "不允许绝对路径");

    const abs = raw ? path.resolve(root, raw) : root;
    const rootReal = await fsp.realpath(root).catch(() => {
      throw err("NOT_FOUND", "工作区目录不存在");
    });
    if (abs !== root && !abs.startsWith(root + path.sep)) throw err("FORBIDDEN", "路径越出工作区");

    let real;
    try {
      real = await fsp.realpath(abs);
    } catch {
      throw err("NOT_FOUND", "路径不存在");
    }
    // 符号链接 / junction 逃逸：解析后的真实路径仍须在真实根内
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw err("FORBIDDEN", "路径越出工作区（符号链接）");

    let stat;
    try {
      stat = await fsp.stat(real);
    } catch {
      throw err("NOT_FOUND", "路径不存在");
    }
    return { root, rootReal, abs, real, stat };
  }

  async list(relPath = "") {
    const { real, stat } = await this.resolveSafe(relPath || "");
    if (!stat.isDirectory()) throw err("BAD_REQUEST", "不是目录");
    const dirents = await fsp.readdir(real, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      const abs = path.join(real, d.name);
      let st = null;
      try {
        st = await fsp.stat(abs);
      } catch {
        continue;
      }
      const isDir = st.isDirectory();
      entries.push({
        name: d.name,
        path: path.relative(this.root(), abs).split(path.sep).join("/"),
        type: isDir ? "dir" : "file",
        size: isDir ? null : st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
      });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { path: path.relative(this.root(), real).split(path.sep).join("/"), entries };
  }

  async read(relPath) {
    if (typeof relPath !== "string" || !relPath) throw err("BAD_REQUEST", "path 必填");
    const { real, stat } = await this.resolveSafe(relPath);
    if (!stat.isFile()) throw err("BAD_REQUEST", "不是文件");

    const ext = path.extname(real).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    const looksText = TEXT_EXT.has(ext);

    // 文本判定：先按扩展名，再用前 8KB 是否含 NUL 兜底
    let isText = looksText;
    if (!isText && stat.size <= BINARY_MAX_BYTES) {
      const fh = await fsp.open(real, "r");
      try {
        const probe = Buffer.alloc(Math.min(8192, stat.size));
        const { bytesRead } = await fh.read(probe, 0, probe.length, 0);
        isText = !probe.subarray(0, bytesRead).includes(0);
      } finally {
        await fh.close();
      }
    }

    if (isText) {
      if (stat.size > TEXT_MAX_BYTES) throw err("BAD_REQUEST", `文本文件超过 1 MiB（${stat.size} 字节）`);
      const buf = await fsp.readFile(real);
      return { content: buf.toString("utf8"), mime: mime.startsWith("application/octet-stream") ? "text/plain; charset=utf-8" : mime, size: stat.size, encoding: "utf8" };
    }

    if (stat.size > BINARY_MAX_BYTES) throw err("BAD_REQUEST", `二进制文件超过 8 MiB（${stat.size} 字节）`);
    const buf = await fsp.readFile(real);
    return { content: buf.toString("base64"), mime, size: stat.size, encoding: "base64" };
  }
}
