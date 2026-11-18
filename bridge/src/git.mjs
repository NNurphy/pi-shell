// pi-shell bridge · T-18：Git 只读（status / diff --stat / diff）
// 安全与只读约束：
// - 只调用 `git status --porcelain`、`git diff --stat`、`git diff`，**不做 add/commit/stash/checkout**
// - `GIT_OPTIONAL_LOCKS=0`：禁止 git 为刷新 index 而写 index.lock（跑完不留锁）
// - 命令 5s 超时 → TIMEOUT（上层映射 504）；patch >2 MiB 截断并标 truncated
// - 非 git 仓库 → {available:false}
import { execFile } from "node:child_process";

export const GIT_TIMEOUT_MS = 5000;
export const PATCH_MAX_BYTES = 2 * 1024 * 1024;

function runGit(execFileImpl, args, { cwd, timeoutMs = GIT_TIMEOUT_MS, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFileImpl("git", args, { cwd, timeout: timeoutMs, maxBuffer, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
          return reject(Object.assign(new Error("git 命令超时"), { code: "TIMEOUT" }));
        }
        return reject(Object.assign(new Error(String(stderr || err.message || "git 失败").trim().split("\n")[0]), { code: "PI_ERROR", stderr: String(stderr || "") }));
      }
      resolve(String(stdout ?? ""));
    });
    child.on("error", (err) => reject(Object.assign(err, { code: "PI_ERROR" })));
  });
}

export class GitReadOnly {
  /** @param {{getCwd:()=>string, execFileImpl?:Function, timeoutMs?:number}} opts execFileImpl 仅测试用 */
  constructor({ getCwd, execFileImpl = execFile, timeoutMs = GIT_TIMEOUT_MS }) {
    this.getCwd = getCwd;
    this.execFileImpl = execFileImpl;
    this.timeoutMs = timeoutMs;
  }

  /** @param {string} [cwd] 不传则用构造时的 getCwd()（F-12：可按会话 cwd 取 diff） */
  async statusPorcelain(cwd = this.getCwd()) {
    const out = await runGit(this.execFileImpl, ["status", "--porcelain"], { cwd, timeoutMs: this.timeoutMs });
    return out.split("\n").filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
  }

  async diff(cwd = this.getCwd()) {
    let stat = "";
    let patch = "";
    try {
      stat = await runGit(this.execFileImpl, ["diff", "--stat"], { cwd, timeoutMs: this.timeoutMs });
      patch = await runGit(this.execFileImpl, ["diff"], { cwd, timeoutMs: this.timeoutMs, maxBuffer: PATCH_MAX_BYTES * 3 });
    } catch (err) {
      // 非 git 仓库：git 会返回 "fatal: not a git repository"
      if (/not a git repository/i.test(err?.message || "") || /not a git repository/i.test(err?.stderr || "")) {
        return { available: false, stat: "", patch: "", truncated: false, status: [] };
      }
      throw err;
    }

    let truncated = false;
    const bytes = Buffer.byteLength(patch, "utf8");
    if (bytes > PATCH_MAX_BYTES) {
      truncated = true;
      patch = Buffer.from(patch, "utf8").subarray(0, PATCH_MAX_BYTES).toString("utf8");
    }
    let status = [];
    try {
      status = await this.statusPorcelain(cwd);
    } catch {
      status = [];
    }
    return { available: true, stat, patch, truncated, status };
  }
}
