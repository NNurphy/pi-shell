// PIX-4 单测：本轮改动快照（写盘 / 轮号 / 上限 / diff / 清理）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TurnChanges, TURN_LIMITS, countDiffLines, isWriteTool, toolPathFromArgs } from "../src/turn-changes.mjs";

const TMP = [];
async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-shell-turn-"));
  TMP.push(dir);
  return dir;
}
test.after(async () => {
  for (const dir of TMP.splice(0)) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function fakeEngine({ id = "e1", sessionId = "sess-1", cwd, sessionFile = null } = {}) {
  return { id, sessionId, sessionFile, extra: { cwd } };
}

const userStart = { type: "message_start", message: { role: "user", content: "hi" } };

test("isWriteTool：只认 write/edit 类 + 有 path/file_path", () => {
  assert.equal(isWriteTool("write", { path: "a.txt" }), true);
  assert.equal(isWriteTool("edit", { file_path: "a.txt" }), true);
  assert.equal(isWriteTool("apply_patch", { path: "a" }), true);
  assert.equal(isWriteTool("bash", { command: "x" }), false);
  assert.equal(isWriteTool("write", { content: "x" }), false);
  assert.equal(toolPathFromArgs({ file_path: " C:\\x\\a.txt " }), "C:\\x\\a.txt");
});

test("countDiffLines 跳过 +++/--- 文件头", () => {
  const diff = ["--- a/x", "+++ b/x", "@@ -1 +1,2 @@", "-old", "+new", "+more"].join("\n");
  assert.deepEqual(countDiffLines(diff), { additions: 2, deletions: 1 });
});

test("新建文件 → kind A；再次编辑 → kind M，diff 含增删行", async () => {
  const root = await tmp();
  const work = await tmp();
  const engine = fakeEngine({ cwd: work });
  const tc = new TurnChanges({ root, getCwd: (e) => e.extra.cwd, execFileImpl: (await import("node:child_process")).execFile });

  tc.note(engine, userStart);
  const file = path.join(work, "a.txt");
  tc.note(engine, { type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "a.txt" } });
  fs.writeFileSync(file, "one\n");
  tc.note(engine, { type: "tool_execution_end", toolCallId: "c1", toolName: "write", args: { path: "a.txt" } });
  await tc.flush();

  let got = await tc.read({ engine, sessionId: "sess-1", turn: 1 });
  assert.equal(got.turn, 1);
  assert.equal(got.files.length, 1);
  assert.equal(got.files[0].path, "a.txt");
  assert.equal(got.files[0].kind, "A");
  assert.equal(got.files[0].before.exists, false);
  assert.ok(got.files[0].diff.includes("+one"));

  // 第二轮：改同一文件
  tc.note(engine, userStart);
  tc.note(engine, { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: { path: "a.txt" } });
  fs.writeFileSync(file, "one\ntwo\n");
  tc.note(engine, { type: "tool_execution_end", toolCallId: "c2", toolName: "edit", args: { path: "a.txt" } });
  await tc.flush();

  got = await tc.read({ engine, sessionId: "sess-1", turn: 2 });
  assert.equal(got.files[0].kind, "M");
  assert.ok(got.files[0].additions >= 1);
  assert.ok(got.files[0].diff.includes("+two"));
  // 第 1 轮的 meta 已封口（磁盘可读）
  const turn1 = JSON.parse(await fsp.readFile(path.join(root, "sess-1", "1", "meta.json"), "utf8"));
  assert.equal(turn1.turn, 1);
});

test("文件被删除 → kind D", async () => {
  const root = await tmp();
  const work = await tmp();
  const file = path.join(work, "gone.txt");
  fs.writeFileSync(file, "bye\n");
  const engine = fakeEngine({ cwd: work });
  const tc = new TurnChanges({ root, getCwd: (e) => e.extra.cwd });
  tc.note(engine, userStart);
  tc.note(engine, { type: "tool_execution_start", toolCallId: "d1", toolName: "edit", args: { path: "gone.txt" } });
  fs.rmSync(file);
  tc.note(engine, { type: "tool_execution_end", toolCallId: "d1", toolName: "edit", args: { path: "gone.txt" } });
  await tc.flush();
  const got = await tc.read({ engine, sessionId: "sess-1", turn: 1 });
  assert.equal(got.files[0].kind, "D");
  assert.equal(got.files[0].after.exists, false);
});

test("超过 maxRecords → 只记路径 / 标记 truncated（内容不存）", async () => {
  const root = await tmp();
  const work = await tmp();
  const engine = fakeEngine({ cwd: work });
  const tc = new TurnChanges({ root, getCwd: (e) => e.extra.cwd, limits: { maxRecords: 60, maxFiles: 50 } });
  tc.note(engine, userStart);
  for (let i = 0; i < 60; i++) {
    const name = `f${String(i).padStart(2, "0")}.txt`;
    const id = `c${i}`;
    tc.note(engine, { type: "tool_execution_start", toolCallId: id, toolName: "write", args: { path: name } });
    fs.writeFileSync(path.join(work, name), `v${i}\n`);
    tc.note(engine, { type: "tool_execution_end", toolCallId: id, toolName: "write", args: { path: name } });
  }
  await tc.flush();
  const got = await tc.read({ engine, sessionId: "sess-1", turn: 1 });
  assert.equal(got.files.length, 60);
  assert.equal(got.files.filter((f) => f.before.stored).length, 0); // 新建：before 不存在
  assert.equal(got.files.filter((f) => f.after.stored).length, 50); // 后 10 个超上限：只记路径
  assert.equal(got.truncated, true);
});

test("单文件 > 2MiB → 不存内容（note=too-large）", async () => {
  const root = await tmp();
  const work = await tmp();
  const engine = fakeEngine({ cwd: work });
  const tc = new TurnChanges({ root, getCwd: (e) => e.extra.cwd });
  tc.note(engine, userStart);
  const big = path.join(work, "big.bin");
  fs.writeFileSync(big, Buffer.alloc(TURN_LIMITS.maxFileBytes + 8, 65));
  tc.note(engine, { type: "tool_execution_start", toolCallId: "b1", toolName: "edit", args: { path: "big.bin" } });
  fs.writeFileSync(big, Buffer.alloc(TURN_LIMITS.maxFileBytes + 16, 66));
  tc.note(engine, { type: "tool_execution_end", toolCallId: "b1", toolName: "edit", args: { path: "big.bin" } });
  await tc.flush();
  const got = await tc.read({ engine, sessionId: "sess-1", turn: 1 });
  assert.equal(got.files[0].before.stored, false);
  assert.equal(got.files[0].note, "too-large");
});

test("旧会话轮号基数：从会话文件数 user 消息", async () => {
  const root = await tmp();
  const work = await tmp();
  const sessions = await tmp();
  const sessionFile = path.join(sessions, "s.jsonl");
  const lines = [
    { type: "session", id: "sess-2" },
    { type: "message", id: "u1", message: { role: "user", content: "a" } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    { type: "message", id: "u2", message: { role: "user", content: "c" } },
  ];
  fs.writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const engine = fakeEngine({ sessionId: "sess-2", cwd: work, sessionFile });
  const tc = new TurnChanges({ root, getCwd: (e) => e.extra.cwd });
  tc.note(engine, userStart);
  tc.note(engine, { type: "tool_execution_start", toolCallId: "x", toolName: "write", args: { path: "n.txt" } });
  fs.writeFileSync(path.join(work, "n.txt"), "n\n");
  tc.note(engine, { type: "tool_execution_end", toolCallId: "x", toolName: "write", args: { path: "n.txt" } });
  await tc.flush();
  const got = await tc.read({ engine, sessionId: "sess-2" });
  assert.equal(got.turn, 3); // 基 2 + 本轮 1
  assert.equal(got.files.length, 1);
});

test("清理：只保留最近 keepTurns 轮", async () => {
  const root = await tmp();
  const work = await tmp();
  const engine = fakeEngine({ cwd: work });
  const tc = new TurnChanges({ root, getCwd: (e) => e.extra.cwd, limits: { keepTurns: 3 } });
  for (let i = 1; i <= 5; i++) {
    tc.note(engine, userStart);
    tc.note(engine, { type: "tool_execution_start", toolCallId: `c${i}`, toolName: "write", args: { path: `t${i}.txt` } });
    fs.writeFileSync(path.join(work, `t${i}.txt`), `${i}\n`);
    tc.note(engine, { type: "tool_execution_end", toolCallId: `c${i}`, toolName: "write", args: { path: `t${i}.txt` } });
    await tc._seal(tc.states.get("e1"));
  }
  const dirs = (await fsp.readdir(path.join(root, "sess-1"))).filter((n) => /^\d+$/.test(n)).sort();
  assert.deepEqual(dirs, ["3", "4", "5"]);
});

test("bridge 重启后仍能按 sessionId + turn 读到（磁盘 meta）", async () => {
  const root = await tmp();
  const work = await tmp();
  const engine = fakeEngine({ cwd: work });
  const tc = new TurnChanges({ root, getCwd: (e) => e.extra.cwd });
  tc.note(engine, userStart);
  tc.note(engine, { type: "tool_execution_start", toolCallId: "z", toolName: "write", args: { path: "z.txt" } });
  fs.writeFileSync(path.join(work, "z.txt"), "z\n");
  tc.note(engine, { type: "tool_execution_end", toolCallId: "z", toolName: "write", args: { path: "z.txt" } });
  tc.note(engine, { type: "agent_settled", aborted: false });
  await tc.flush();

  const tc2 = new TurnChanges({ root, getCwd: (e) => e.extra.cwd });
  const got = await tc2.read({ engine: fakeEngine({ cwd: work }), sessionId: "sess-1" });
  assert.equal(got.turn, 1);
  assert.equal(got.files.length, 1);
  assert.equal(got.files[0].kind, "A");
});
