// T1 单测：项目目录校验 / 归一化 / 同目录判定（/api/session/new {cwd} 的前置条件）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeProjectDir, resolveProjectDir, sameProjectDir } from "../src/project-dir.mjs";

let root = "";
let dir = "";
let file = "";

test.before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-project-dir-")));
  dir = path.join(root, "项目 目录");
  file = path.join(root, "not-a-dir.txt");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "x", "utf8");
});

test.after(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

test("resolveProjectDir：合法目录 → 归一化绝对路径（含中文/空格）", async () => {
  const resolved = await resolveProjectDir(dir);
  assert.equal(resolved, path.resolve(dir));
});

test("resolveProjectDir：不存在 → BAD_REQUEST", async () => {
  await assert.rejects(resolveProjectDir(path.join(root, "nope")), (err) => err.code === "BAD_REQUEST");
});

test("resolveProjectDir：是文件不是目录 → BAD_REQUEST", async () => {
  await assert.rejects(resolveProjectDir(file), (err) => err.code === "BAD_REQUEST");
});

test("resolveProjectDir：空/非字符串 → BAD_REQUEST", async () => {
  for (const value of ["", "   ", null, 42, {}]) {
    await assert.rejects(resolveProjectDir(value), (err) => err.code === "BAD_REQUEST", `input=${String(value)}`);
  }
});

test("normalizeProjectDir：尾部反斜杠/斜杠被去掉，盘符根保留", () => {
  assert.equal(normalizeProjectDir(`${dir}${path.sep}`), path.resolve(dir));
  assert.equal(normalizeProjectDir(`${dir}${path.sep}${path.sep}`), path.resolve(dir));
  assert.equal(normalizeProjectDir(`${dir}/`), path.resolve(dir));
  if (process.platform === "win32") {
    assert.match(normalizeProjectDir("C:\\"), /^[A-Za-z]:\\$/);
  }
});

test("sameProjectDir：忽略大小写与尾部分隔符；不同目录/非法输入 → false", () => {
  assert.equal(sameProjectDir(dir, dir), true);
  assert.equal(sameProjectDir(dir, `${dir}${path.sep}`), true);
  assert.equal(sameProjectDir(dir, dir.toUpperCase()), true, "Windows 语义：大小写不敏感");
  assert.equal(sameProjectDir(dir, root), false);
  assert.equal(sameProjectDir(dir, ""), false);
  assert.equal(sameProjectDir(null, dir), false);
});
