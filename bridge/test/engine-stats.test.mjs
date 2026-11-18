// N1-b 单测：进程树 RSS 求和 / 会话标题提取（纯函数，不依赖 PowerShell）
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseProcessRows,
  treeRssBytes,
  titleFromSessionText,
  createProcessSnapshotProvider,
  createSessionTitleReader,
} from "../src/engine-stats.mjs";

const MB = 1024 * 1024;

test("parseProcessRows：正常数组 / 单对象 / 坏输入", () => {
  const rows = parseProcessRows(
    JSON.stringify([
      { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: 100 },
      { ProcessId: "11", ParentProcessId: "10", WorkingSetSize: "200" },
      { ProcessId: 0, ParentProcessId: 1, WorkingSetSize: 300 }, // 非法 pid 丢弃
    ]),
  );
  assert.deepEqual(rows, [
    { pid: 10, ppid: 1, workingSetBytes: 100 },
    { pid: 11, ppid: 10, workingSetBytes: 200 },
  ]);
  assert.equal(parseProcessRows("not json").length, 0);
  assert.equal(parseProcessRows("").length, 0);
  const single = parseProcessRows(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, WorkingSetSize: 9 }));
  assert.deepEqual(single, [{ pid: 7, ppid: 1, workingSetBytes: 9 }]);
});

test("treeRssBytes：整棵树求和（pi + MCP 孙进程），不含兄弟进程", () => {
  const rows = [
    { pid: 100, ppid: 1, workingSetBytes: 100 * MB }, // pi
    { pid: 101, ppid: 100, workingSetBytes: 50 * MB }, // MCP node
    { pid: 102, ppid: 101, workingSetBytes: 10 * MB }, // MCP 的孙进程
    { pid: 200, ppid: 1, workingSetBytes: 999 * MB }, // 另一个引擎，不能算进来
  ];
  assert.equal(treeRssBytes(rows, 100), 160 * MB);
  assert.equal(treeRssBytes(rows, 101), 60 * MB);
  assert.equal(treeRssBytes(rows, 999), 0);
  assert.equal(treeRssBytes(rows, 0), 0);
});

test("treeRssBytes：环路防护（父 pid 成环不死循环）", () => {
  const rows = [
    { pid: 1, ppid: 2, workingSetBytes: 1 },
    { pid: 2, ppid: 1, workingSetBytes: 2 },
  ];
  assert.equal(treeRssBytes(rows, 1), 3);
});

test("titleFromSessionText：取第一条 user 文本、压空白、截 30 字；无 user 回退 sessionId", () => {
  const text = [
    JSON.stringify({ type: "session", id: "s1" }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "先说话" }] } }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "  你好\n  世界  " }] } }),
  ].join("\n");
  assert.equal(titleFromSessionText(text, "abcdefghij"), "你好 世界");
  assert.equal(titleFromSessionText("", "abcdefghij"), "abcdefgh");
  const long = JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(80) } });
  assert.equal(titleFromSessionText(long).length, 30);
});

test("createProcessSnapshotProvider：整表一次取，cacheMs 内复用；根进程不存在则不给 0", async () => {
  let calls = 0;
  let clock = 1000;
  const provider = createProcessSnapshotProvider({
    cacheMs: 5000,
    now: () => clock,
    run: async () => {
      calls += 1;
      return JSON.stringify([
        { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 200 * MB },
        { ProcessId: 101, ParentProcessId: 100, WorkingSetSize: 100 * MB },
      ]);
    },
  });
  const first = await provider.rssByRoot([100, 999]);
  assert.equal(calls, 1);
  assert.deepEqual([...first.entries()], [[100, 300]]); // 树和 300MB；999 不存在 → 缺省
  clock += 1000;
  await provider.rssByRoot([100]);
  assert.equal(calls, 1); // 5s 缓存命中，不重复跑 PowerShell
  clock += 5000;
  await provider.rssByRoot([100]);
  assert.equal(calls, 2); // 过期后重取
});

test("createProcessSnapshotProvider：取快照失败 → 空结果不抛，且只告警一次", async () => {
  let calls = 0;
  const warns = [];
  const provider = createProcessSnapshotProvider({
    cacheMs: 60000,
    now: () => 0,
    run: async () => {
      calls += 1;
      throw Object.assign(new Error("powershell 不可用"), { code: "ENOENT" });
    },
    log: (_level, event) => warns.push(event),
  });
  assert.equal((await provider.rssByRoot([5])).size, 0);
  assert.equal((await provider.rssByRoot([5])).size, 0);
  assert.equal(calls, 1); // 失败也进缓存，5s 内不再反复触发
  assert.deepEqual(warns, ["rss_snapshot_failed"]);
});

test("createSessionTitleReader：读文件头取首条 user；缓存按 mtime+size；读不到回退 sessionId", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-shell-title-"));
  const file = path.join(dir, "s.jsonl");
  const text = (title) =>
    `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: title }] } })}\n`;
  await fsp.writeFile(file, text("第一句标题"), "utf8");
  const fixed = new Date("2026-01-01T00:00:00Z");
  await fsp.utimes(file, fixed, fixed); // 固定 mtime：后面同长度改写再还原 mtime 才能确定性命中缓存
  const reader = createSessionTitleReader({ cacheMs: 60000 });
  try {
    assert.equal(await reader.title(file, "abcdefghij"), "第一句标题");
    // 同长度改写 + 还原 mtime → 缓存命中，仍返回旧标题（不重读整文件）
    await fsp.writeFile(file, text("第二句标题"), "utf8");
    await fsp.utimes(file, fixed, fixed);
    assert.equal(await reader.title(file, "abcdefghij"), "第一句标题");
    // 文件变化（换回新内容且 mtime 真的变了）→ 失效重读
    await fsp.writeFile(file, text("第三句标题"), "utf8");
    assert.equal(await reader.title(file, "abcdefghij"), "第三句标题");
    assert.equal(await reader.title(path.join(dir, "nope.jsonl"), "abcdefghij"), "abcdefgh");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
