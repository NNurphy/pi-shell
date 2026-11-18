// T-18 单测：git 只读封装（非仓库判定 / 截断 / 超时映射 / GIT_OPTIONAL_LOCKS）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitReadOnly, GIT_TIMEOUT_MS, PATCH_MAX_BYTES } from "../src/git.mjs";

const TMP = [];

async function tmpDir(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pi-shell-git-${name}-`));
  TMP.push(dir);
  return dir;
}
test.after(async () => {
  for (const dir of TMP) await fsp.rm(dir, { recursive: true, force: true });
});

test.afterEach(async () => {
  for (const dir of TMP.splice(0)) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("超时常量 = 5s；patch 上限 2 MiB", () => {
  assert.equal(GIT_TIMEOUT_MS, 5000);
  assert.equal(PATCH_MAX_BYTES, 2 * 1024 * 1024);
});

test("非 git 仓库 → {available:false}（不抛错）", async () => {
  const dir = await tmpDir("nogit");
  const git = new GitReadOnly({ getCwd: () => dir });
  const r = await git.diff();
  assert.equal(r.available, false);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.status, []);
});

test("patch 超过 2 MiB → 截断并标 truncated", async () => {
  const dir = await tmpDir("trunc");
  const fake = (cmd, args, opts, cb) => {
    if (args[0] === "diff" && args[1] === "--stat") return cb(null, " big.txt | 1000 +++++\n", "");
    if (args[0] === "diff") return cb(null, "x".repeat(PATCH_MAX_BYTES + 1000), "");
    if (args[0] === "status") return cb(null, " M big.txt\n", "");
    return cb(null, "", "");
  };
  const git = new GitReadOnly({ getCwd: () => dir, execFileImpl: fake });
  const r = await git.diff();
  assert.equal(r.available, true);
  assert.equal(r.truncated, true);
  assert.equal(Buffer.byteLength(r.patch, "utf8"), PATCH_MAX_BYTES);
});

test("git 被 kill（超时）→ 抛 TIMEOUT（上层 504）", async () => {
  const dir = await tmpDir("timeout");
  const fake = (cmd, args, opts, cb) => {
    const err = Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
    cb(err, "", "");
  };
  const git = new GitReadOnly({ getCwd: () => dir, execFileImpl: fake, timeoutMs: 5 });
  await assert.rejects(git.diff(), (err) => err.code === "TIMEOUT");
});

test("status 解析 porcelain 行（code + path）", async () => {
  const dir = await tmpDir("status");
  const fake = (cmd, args, opts, cb) => {
    if (args[0] === "status") return cb(null, " M a.txt\n?? b.txt\n", "");
    return cb(null, "", "");
  };
  const git = new GitReadOnly({ getCwd: () => dir, execFileImpl: fake });
  const rows = await git.statusPorcelain();
  assert.deepEqual(rows, [
    { code: " M", path: "a.txt" },
    { code: "??", path: "b.txt" },
  ]);
});

test("GIT_OPTIONAL_LOCKS=0 传给出 git（不留 index.lock 的关键）", async () => {
  const dir = await tmpDir("env");
  let seenEnv = null;
  const fake = (cmd, args, opts, cb) => {
    seenEnv = opts.env;
    cb(null, "", "");
  };
  const git = new GitReadOnly({ getCwd: () => dir, execFileImpl: fake });
  await git.statusPorcelain();
  assert.equal(seenEnv.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(fs.existsSync(path.join(dir, ".git", "index.lock")), false);
});

test("diff(cwd)：所有 git 命令都在指定目录执行；不传则用 getCwd()", async () => {
  const fallback = await tmpDir("cwd-fallback");
  const target = await tmpDir("cwd-target");
  const seen = [];
  const fake = (cmd, args, opts, cb) => {
    seen.push({ args: args.join(" "), cwd: opts.cwd });
    if (args.join(" ") === "status --porcelain") return cb(null, " M a.txt\n", "");
    return cb(null, "", "");
  };
  const git = new GitReadOnly({ getCwd: () => fallback, execFileImpl: fake });

  await git.diff();
  assert.ok(seen.length >= 3, `三条命令都要跑：${seen.map((s) => s.args).join(" / ")}`);
  assert.deepEqual(new Set(seen.map((s) => s.cwd)), new Set([fallback]));

  seen.length = 0;
  const r = await git.diff(target);
  assert.equal(r.available, true);
  assert.deepEqual(new Set(seen.map((s) => s.cwd)), new Set([target])); // 显式 cwd 覆盖 getCwd()
  assert.deepEqual(seen.map((s) => s.args).sort(), ["diff", "diff --stat", "status --porcelain"]);
  assert.deepEqual(r.status, [{ code: " M", path: "a.txt" }]);
});
