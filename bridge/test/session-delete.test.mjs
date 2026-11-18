// B-12 单测：会话删除（白名单 / 保护 / 备份移动 / 失败不删原文件）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteSessionFile, backupStamp, isInside } from "../src/session-delete.mjs";

const ROOTS = [];
function newRoot(tag = "delete") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-shell-${tag}-`));
  ROOTS.push(root);
  return root;
}
test.after(async () => {
  for (const root of ROOTS) await fsp.rm(root, { recursive: true, force: true });
});

/** 建一个 fixture 会话：<sessions>/<dir>/<name>.jsonl */
async function fixture({ sessions, dir = "--C--Users-user-proj--", name = "s1.jsonl", body = "x".repeat(64) }) {
  const target = path.join(sessions, dir, name);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: name.replace(/\.jsonl$/, ""), timestamp: 1762300000000, cwd: "C:\\Users\\user\\proj" }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1762300001000, message: { role: "user", content: body } }),
  ];
  await fsp.writeFile(target, lines.join("\n") + "\n", "utf8");
  return target;
}

test("正常删除：文件消失 + 备份保留目录结构与字节数", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  const backupRoot = path.join(base, "backups", "deleted-sessions");
  const file = await fixture({ sessions });
  const before = await fsp.stat(file);

  const res = await deleteSessionFile({
    rawPath: file,
    roots: [sessions],
    backupRoot,
    attachedFile: null,
    now: new Date(2026, 10, 7, 13, 5, 9),
  });

  assert.equal(res.deleted, file);
  assert.equal(res.bytes, before.size);
  assert.equal(res.backup, path.join(backupRoot, "20261107-130509", "--C--Users-user-proj--", "s1.jsonl"));
  await assert.rejects(fsp.stat(file), /ENOENT/);
  const backupStat = await fsp.stat(res.backup);
  assert.equal(backupStat.size, before.size);
  assert.equal(await fsp.readFile(res.backup, "utf8"), await fsp.readFile(path.join(backupRoot, "20261107-130509", "--C--Users-user-proj--", "s1.jsonl"), "utf8"));
});

test("备份时间戳格式 <YYYYMMDD-HHmmss>", () => {
  assert.equal(backupStamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405");
  assert.equal(backupStamp(new Date(2026, 11, 31, 23, 59, 59)), "20261231-235959");
});

test("越界：会话根外的 path → 403 FORBIDDEN（且原文件不动）", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  const backupRoot = path.join(base, "backups");
  await fsp.mkdir(sessions, { recursive: true });
  const outside = path.join(base, "outside.jsonl");
  await fsp.writeFile(outside, "{}\n", "utf8");

  await assert.rejects(
    deleteSessionFile({ rawPath: outside, roots: [sessions], backupRoot }),
    (err) => err.code === "FORBIDDEN" && err.status === 403,
  );
  assert.equal((await fsp.stat(outside)).isFile(), true);
  // 备份目录不应被创建（越界在写盘之前就被拦下）
  await assert.rejects(fsp.stat(backupRoot), /ENOENT/);
});

test("越界路径即使是非 .jsonl 也给 403（不是 400）", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  await fsp.mkdir(sessions, { recursive: true });
  await assert.rejects(
    deleteSessionFile({ rawPath: path.join(base, "win.ini"), roots: [sessions], backupRoot: path.join(base, "b") }),
    (err) => err.code === "FORBIDDEN" && err.status === 403,
  );
});

test("根内非 .jsonl → 400 BAD_REQUEST（文件保留）", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  const backupRoot = path.join(base, "backups");
  const file = path.join(sessions, "notes.txt");
  await fsp.mkdir(sessions, { recursive: true });
  await fsp.writeFile(file, "keep me", "utf8");

  await assert.rejects(
    deleteSessionFile({ rawPath: file, roots: [sessions], backupRoot }),
    (err) => err.code === "BAD_REQUEST" && err.status === 400,
  );
  assert.equal(await fsp.readFile(file, "utf8"), "keep me");
});

test("path 缺失 → 400 BAD_REQUEST", async () => {
  await assert.rejects(deleteSessionFile({ rawPath: "  ", roots: ["C:\\x"], backupRoot: "C:\\y" }), (err) => err.code === "BAD_REQUEST");
});

test("不存在 → 404 NOT_FOUND", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  await fsp.mkdir(sessions, { recursive: true });
  await assert.rejects(
    deleteSessionFile({ rawPath: path.join(sessions, "gone.jsonl"), roots: [sessions], backupRoot: path.join(base, "b") }),
    (err) => err.code === "NOT_FOUND" && err.status === 404,
  );
});

test("当前已附着的会话 → 409 CONFLICT，文件与备份目录都不动", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  const backupRoot = path.join(base, "backups");
  const file = await fixture({ sessions });

  await assert.rejects(
    deleteSessionFile({ rawPath: file, roots: [sessions], backupRoot, attachedFile: file }),
    (err) => err.code === "CONFLICT" && err.status === 409 && /请先中止或切走/.test(err.message),
  );
  assert.equal((await fsp.stat(file)).isFile(), true);
  await assert.rejects(fsp.stat(backupRoot), /ENOENT/);
});

test("已附着判断忽略大小写（Windows 路径口径）", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  const backupRoot = path.join(base, "backups");
  const file = await fixture({ sessions });
  const upper = process.platform === "win32" ? file.toUpperCase() : file;
  await assert.rejects(
    deleteSessionFile({ rawPath: file, roots: [sessions], backupRoot, attachedFile: upper }),
    (err) => err.code === "CONFLICT",
  );
});

test("agent 会话根同样可删（多根白名单）", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  const agentSessions = path.join(base, "sessions-agents");
  const backupRoot = path.join(base, "backups");
  await fsp.mkdir(sessions, { recursive: true });
  const file = await fixture({ sessions: agentSessions, dir: "--C--Users-user-agent--", name: "a1.jsonl" });

  const res = await deleteSessionFile({ rawPath: file, roots: [sessions, agentSessions], backupRoot, now: new Date(2026, 10, 7, 1, 2, 3) });
  assert.equal(res.backup, path.join(backupRoot, "20261107-010203", "--C--Users-user-agent--", "a1.jsonl"));
  await assert.rejects(fsp.stat(file), /ENOENT/);
});

test("同秒同名备份已存在：加序号，不覆盖旧备份", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  const backupRoot = path.join(base, "backups");
  const now = new Date(2026, 10, 7, 9, 8, 7);
  const first = await fixture({ sessions, body: "first" });
  const res1 = await deleteSessionFile({ rawPath: first, roots: [sessions], backupRoot, now });
  const second = await fixture({ sessions, body: "second" });
  const res2 = await deleteSessionFile({ rawPath: second, roots: [sessions], backupRoot, now });

  assert.notEqual(res1.backup, res2.backup);
  assert.match(res2.backup, /20261107-090807-1[\\/]/);
  assert.match(await fsp.readFile(res1.backup, "utf8"), /first/);
  assert.match(await fsp.readFile(res2.backup, "utf8"), /second/);
});

test("备份目录无法创建 → PI_ERROR 502，原文件不删", async () => {
  const base = newRoot();
  const sessions = path.join(base, "sessions");
  const file = await fixture({ sessions });
  const blocking = path.join(base, "not-a-dir");
  await fsp.writeFile(blocking, "i am a file", "utf8"); // 让 backupRoot 下的 mkdir 必然失败

  await assert.rejects(
    deleteSessionFile({ rawPath: file, roots: [sessions], backupRoot: path.join(blocking, "deleted-sessions") }),
    (err) => err.code === "PI_ERROR" && err.status === 502 && /未删除原文件/.test(err.message),
  );
  assert.equal((await fsp.stat(file)).isFile(), true);
});

test("isInside：根内为真、根本身与旁系前缀为假", () => {
  const root = path.join("C:\\", "Users", "user", ".pi", "agent", "sessions");
  assert.equal(isInside(path.join(root, "--C--x--", "a.jsonl"), root), true);
  assert.equal(isInside(root, root), false);
  assert.equal(isInside(path.join(root + "-agents", "a.jsonl"), root), false);
  assert.equal(isInside("C:\\Windows\\win.ini", root), false);
});
