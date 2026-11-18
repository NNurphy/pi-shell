// T-06 单测：会话索引（只读扫描 / 容错 / 缓存 / 过滤）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionIndex, HEAD_SCAN_BYTES } from "../src/sessions.mjs";

const ROOTS = [];
function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-sessions-test-"));
  ROOTS.push(root);
  return root;
}
test.after(async () => {
  for (const root of ROOTS) await fsp.rm(root, { recursive: true, force: true });
});

async function makeDir(root, name) {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function sessionLines({ id = "01a1aaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cwd = "C:\\Users\\user", user = "你好呀", answer = "收到" }) {
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: 1762300000000, cwd })];
  if (user != null) {
    lines.push(JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1762300001000, message: { role: "user", content: user } }));
  }
  if (answer != null) {
    lines.push(JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: 1762300002000, message: { role: "assistant", content: [{ type: "text", text: answer }] } }));
  }
  return lines;
}

async function writeSession(dir, name, lines) {
  const file = path.join(dir, name);
  await fsp.writeFile(file, lines.join("\n") + "\n", "utf8");
  return file;
}

test("基本字段：header id / cwd / 首条 user 前 30 字 / 末条 message 摘要", async () => {
  const root = newRoot();
  const dirName = "--C--Users-user--";
  const dir = await makeDir(root, dirName);
  const longUser = "一二三四五六七八九十".repeat(5); // 50 字
  await writeSession(dir, "a.jsonl", sessionLines({ user: longUser, answer: "第一条回答" }));

  const { groups, warnings, stats } = await new SessionIndex({ sessionsDir: root }).list({});
  assert.equal(warnings.length, 0);
  assert.equal(stats.dirs, 1);
  const s = groups[0].sessions[0];
  assert.equal(s.id, "01a1aaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(s.cwd, "C:\\Users\\user");
  assert.equal(s.title, longUser.slice(0, 30));
  assert.equal(s.lastSnippet, "第一条回答");
  assert.equal(s.status, "unknown");
  assert.ok(s.updatedAt);
  assert.equal(s.path, path.join(dir, "a.jsonl"));
});

test("status：与桥的当前 sessionId 相同才 attached", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user--");
  const id = "01a1bbbb-1111-2222-3333-444444444444";
  await writeSession(dir, "b.jsonl", sessionLines({ id }));
  const idx = new SessionIndex({ sessionsDir: root });
  assert.equal((await idx.list({ currentSessionId: id })).groups[0].sessions[0].status, "attached");
  assert.equal((await idx.list({ currentSessionId: "another-id" })).groups[0].sessions[0].status, "unknown");
});

test("无 user 消息：title 回退为 sessionId 前 8 位", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user--");
  const id = "01a1cccc-aaaa-bbbb-cccc-dddddddddddd";
  await writeSession(dir, "c.jsonl", sessionLines({ id, user: null }));
  const s = (await new SessionIndex({ sessionsDir: root }).list({})).groups[0].sessions[0];
  assert.equal(s.title, id.slice(0, 8));
});

test("空文件：不抛错，title 用文件名前 8 位，摘要为 (无消息)", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user--");
  await fsp.writeFile(path.join(dir, "empty.jsonl"), "", "utf8");
  const { groups, warnings } = await new SessionIndex({ sessionsDir: root }).list({});
  const s = groups[0].sessions[0];
  assert.equal(s.title, "empty");
  assert.equal(s.lastSnippet, "(无消息)");
  assert.ok(warnings.some((w) => /header/.test(w.reason)));
});

test("无 header：cwd 退化为目录名原文，并产生 warning", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--D--Work--pi--");
  await writeSession(dir, "d.jsonl", [
    JSON.stringify({ type: "message", id: "e1", timestamp: 1762300001000, message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "message", id: "e2", timestamp: 1762300002000, message: { role: "assistant", content: "yo" } }),
  ]);
  const { groups, warnings } = await new SessionIndex({ sessionsDir: root }).list({});
  const s = groups[0].sessions[0];
  assert.equal(s.cwd, "--D--Work--pi--");
  assert.equal(s.title, "hi");
  assert.equal(s.lastSnippet, "yo");
  assert.ok(warnings.some((w) => w.path.endsWith("d.jsonl")));
});

test("末条非 message（model_change 结尾）：摘要仍取最后一条 message", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user--");
  await writeSession(dir, "e.jsonl", [
    ...sessionLines({ user: "问题", answer: "回答正文" }),
    JSON.stringify({ type: "model_change", id: "e3", timestamp: 1762300009000, model: "x" }),
    JSON.stringify({ type: "thinking_level_change", id: "e4", timestamp: 1762300010000, level: "high" }),
  ]);
  const s = (await new SessionIndex({ sessionsDir: root }).list({})).groups[0].sessions[0];
  assert.equal(s.lastSnippet, "回答正文");
  assert.equal(new Date(s.updatedAt).getTime(), 1762300002000);
});

test("100KB 单行在中间/尾部：走 tail 窗口仍能取到末条 message", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user--");
  const big = "x".repeat(100 * 1024);
  await writeSession(dir, "f.jsonl", [
    ...sessionLines({ user: "大文件", answer: "开头回答" }),
    JSON.stringify({ type: "message", id: "e3", timestamp: 1762300005000, message: { role: "assistant", content: [{ type: "text", text: "尾部" + big }] } }),
    JSON.stringify({ type: "message", id: "e4", timestamp: 1762300006000, message: { role: "assistant", content: [{ type: "text", text: "最后一条" }] } }),
  ]);
  const s = (await new SessionIndex({ sessionsDir: root }).list({})).groups[0].sessions[0];
  assert.ok(fs.statSync(s.path).size > HEAD_SCAN_BYTES, "前置条件：文件应大于头窗口");
  assert.equal(s.lastSnippet, "最后一条");
});

test(">64KB 文件：头窗口内没有 user → title 回退 sessionId 前 8 位", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user--");
  const filler = { type: "message", id: "big", timestamp: 1762300000100, message: { role: "assistant", content: [{ type: "text", text: "y".repeat(70 * 1024) }] } };
  await writeSession(dir, "g.jsonl", [
    JSON.stringify({ type: "session", id: "01a1dddd-0000-0000-0000-000000000000", timestamp: 1762300000000, cwd: "C:\\Users\\user" }),
    JSON.stringify(filler),
  ]);
  const s = (await new SessionIndex({ sessionsDir: root }).list({})).groups[0].sessions[0];
  assert.equal(s.title, "01a1dddd");
  assert.ok(fs.statSync(s.path).size > HEAD_SCAN_BYTES);
});

test("缓存：第二次扫描命中缓存；文件变化后失效", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user--");
  const file = await writeSession(dir, "h.jsonl", sessionLines({ answer: "v1" }));
  const idx = new SessionIndex({ sessionsDir: root });
  assert.equal((await idx.list({})).stats.cacheHits, 0);
  const second = await idx.list({});
  assert.equal(second.stats.cacheHits, 1);
  assert.equal(second.groups[0].sessions[0].lastSnippet, "v1");

  await fsp.appendFile(
    file,
    JSON.stringify({ type: "message", id: "e9", timestamp: 1762300030000, message: { role: "assistant", content: "v2" } }) + "\n",
    "utf8",
  );
  const third = await idx.list({});
  assert.equal(third.stats.cacheHits, 0);
  assert.equal(third.groups[0].sessions[0].lastSnippet, "v2");
});

test("?q= 过滤：命中 title 或 lastSnippet，不命中则整组消失", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user-demo-project--");
  await writeSession(dir, "i.jsonl", sessionLines({ user: "帮我看招聘岗位", answer: "已筛出 12 条" }));
  await writeSession(dir, "j.jsonl", sessionLines({ user: "另一个话题", answer: "无关内容" }));
  const idx = new SessionIndex({ sessionsDir: root });

  const hit = await idx.list({ q: "招聘" });
  assert.equal(hit.groups.length, 1);
  assert.equal(hit.groups[0].sessions.length, 1);

  const hitSnippet = await idx.list({ q: "12 条" });
  assert.equal(hitSnippet.groups[0].sessions.length, 1);

  assert.equal((await idx.list({ q: "不存在的关键词" })).groups.length, 0);
});

test("目录不存在 / 未设置：返回 warnings，不抛错", async () => {
  const r1 = await new SessionIndex({ sessionsDir: path.join(newRoot(), "no-such-dir") }).list({});
  assert.equal(r1.groups.length, 0);
  assert.ok(r1.warnings.length >= 1);

  const r2 = await new SessionIndex({ sessionsDir: "" }).list({});
  assert.equal(r2.groups.length, 0);
  assert.match(r2.warnings[0].reason, /PI_SHELL_SESSIONS_DIR/);
});

test("分组数 == 含 jsonl 的目录数（空目录不计）", async () => {
  const root = newRoot();
  const d1 = await makeDir(root, "--C--a--");
  const d2 = await makeDir(root, "--C--b--");
  await makeDir(root, "--C--empty--");
  await writeSession(d1, "1.jsonl", sessionLines({ user: "a", answer: "a" }));
  await writeSession(d2, "2.jsonl", sessionLines({ user: "b", answer: "b" }));
  const { groups } = await new SessionIndex({ sessionsDir: root }).list({});
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.dir).sort(), ["--C--a--", "--C--b--"]);
});

test("readSessionEntries：跳过 header、保留条目、leafId 为最后一条、坏行跳过", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user--");
  const file = await writeSession(dir, "r.jsonl", [...sessionLines({ user: "问题", answer: "回答" }), "not-json-line", JSON.stringify({ type: "model_change", id: "m1", timestamp: 1762300009000, model: "x" })]);
  const { readSessionEntries } = await import("../src/sessions.mjs");
  const data = await readSessionEntries(file);
  assert.equal(data.sessionId, "01a1aaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(data.cwd, String.raw`C:\Users\user`);
  assert.equal(data.entries.length, 3); // user + assistant + model_change（坏行、header 都不算）
  assert.equal(data.leafId, "m1");
  assert.equal(data.entries[0].message.role, "user");
});

test("readSessionEntries：parseLine 坏 JSON 不影响后续，空文件返回空数组", async () => {
  const root = newRoot();
  const dir = await makeDir(root, "--C--Users-user--");
  const empty = path.join(dir, "empty.jsonl");
  await fsp.writeFile(empty, "", "utf8");
  const { readSessionEntries } = await import("../src/sessions.mjs");
  const data = await readSessionEntries(empty);
  assert.deepEqual(data.entries, []);
  assert.equal(data.leafId, null);
  assert.equal(data.sessionId, null);
});
