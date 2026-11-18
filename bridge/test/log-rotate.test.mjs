// 日志按大小轮转（N2）单测：只碰临时目录，不写真实 logs/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_KEEP,
  DEFAULT_MAX_MB,
  appendWithRotation,
  formatBytes,
  formatRotationLine,
  maxBytesFor,
  resolveLogLimits,
  rotateIfNeeded,
  rotateIfNeededAsync,
  rotationPlan,
} from "../src/log.mjs";

const MB = 1024 * 1024;

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pish-log-${tag}-`));
}

function writeMB(file, mb, preamble = "") {
  const bytes = Math.max(1, Math.floor(mb * MB));
  const body = Buffer.alloc(Math.max(0, bytes - Buffer.byteLength(preamble)), 0x61);
  fs.writeFileSync(file, preamble + body.toString("latin1"), "latin1");
  return fs.statSync(file).size;
}

function rotatedFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => /\.log\.\d+$/.test(name) || /\.txt\.\d+$/.test(name))
    .sort();
}

test("默认值：PI_SHELL_LOG_MAX_MB=5 / PI_SHELL_LOG_KEEP=5", () => {
  assert.deepEqual(resolveLogLimits({}), { maxMB: DEFAULT_MAX_MB, keep: DEFAULT_KEEP });
  assert.equal(DEFAULT_MAX_MB, 5);
  assert.equal(DEFAULT_KEEP, 5);
  assert.equal(maxBytesFor(5), 5 * MB);
  const plan = rotationPlan("C:/x/bridge.log", 5);
  assert.equal(plan.deleteTarget, "C:/x/bridge.log.5");
  assert.deepEqual(plan.moves[0], { from: "C:/x/bridge.log.4", to: "C:/x/bridge.log.5" });
  assert.deepEqual(plan.moves[plan.moves.length - 1], { from: "C:/x/bridge.log", to: "C:/x/bridge.log.1" });
});

test("非法参数回落默认值（空/非数字/≤0/非整数保留份数）", () => {
  for (const raw of [undefined, null, "", "  ", "abc", "5MB", "0", "-3", "-0.5", "NaN", "Infinity"]) {
    assert.equal(resolveLogLimits({ PI_SHELL_LOG_MAX_MB: raw }).maxMB, DEFAULT_MAX_MB, `maxMB raw=${raw}`);
  }
  for (const raw of [undefined, null, "", "abc", "0", "-2", "0.4"]) {
    assert.equal(resolveLogLimits({ PI_SHELL_LOG_KEEP: raw }).keep, DEFAULT_KEEP, `keep raw=${raw}`);
  }
  assert.equal(resolveLogLimits({ PI_SHELL_LOG_MAX_MB: "2.5", PI_SHELL_LOG_KEEP: "3" }).maxMB, 2.5);
  assert.equal(resolveLogLimits({ PI_SHELL_LOG_MAX_MB: "2.5", PI_SHELL_LOG_KEEP: "3" }).keep, 3);
  assert.equal(resolveLogLimits({ PI_SHELL_LOG_KEEP: "2.9" }).keep, 2); // 向下取整，≥1 才算合法
});

test("① 未超限不动：文件大小与内容都不变，不产生 .1", () => {
  const dir = tmpDir("small");
  const file = path.join(dir, "bridge.log");
  const size = writeMB(file, 0.5, "hello\n");
  const before = fs.readFileSync(file);
  const result = rotateIfNeeded(file, 5, 5);
  assert.equal(result.action, "none");
  assert.equal(result.rotated, false);
  assert.equal(result.size, size);
  assert.equal(fs.statSync(file).size, size);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(rotatedFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("② 超限生成 .1 并保留 N 份（含轮转行）", () => {
  const dir = tmpDir("rotate");
  const file = path.join(dir, "bridge.log");
  const size = writeMB(file, 2, "gen1\n");
  assert.equal(size, 2 * MB);

  const result = rotateIfNeeded(file, 1, 2);
  assert.equal(result.action, "rotated");
  assert.equal(result.rotated, true);
  assert.equal(result.to, `${file}.1`);
  assert.equal(result.moves.length, 1);
  assert.equal(fs.statSync(`${file}.1`).size, size);

  const rotatedText = fs.readFileSync(file, "utf8");
  assert.match(rotatedText, /log_rotated/);
  assert.match(rotatedText, /from=.*bridge\.log/);
  assert.match(rotatedText, /to=.*bridge\.log\.1/);
  assert.match(rotatedText, new RegExp(`bytes=${size}`));
  assert.ok(fs.statSync(file).size < 1024, "轮转后只剩一行 log_rotated");

  // 再轮转两次 → .1 / .2，keep=2 时不得出现 .3
  writeMB(file, 2, "gen2\n");
  assert.equal(rotateIfNeeded(file, 1, 2).action, "rotated");
  writeMB(file, 2, "gen3\n");
  const third = rotateIfNeeded(file, 1, 2);
  assert.equal(third.action, "rotated");
  assert.deepEqual(rotatedFiles(dir), ["bridge.log.1", "bridge.log.2"]);
  assert.match(fs.readFileSync(`${file}.1`, "latin1"), /^gen3\n/);
  assert.match(fs.readFileSync(`${file}.2`, "latin1"), /^gen2\n/);
  assert.ok(!fs.existsSync(`${file}.3`), "最旧一份被删");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("③ 最旧被删：keep 调小后已有的 .N 孤儿也被清理", () => {
  const dir = tmpDir("prune");
  const file = path.join(dir, "bridge.log");
  writeMB(file, 2, "current\n");
  fs.writeFileSync(`${file}.1`, "one\n");
  fs.writeFileSync(`${file}.2`, "two\n");
  fs.writeFileSync(`${file}.3`, "three\n");
  fs.writeFileSync(`${file}.4`, "four\n");

  const result = rotateIfNeeded(file, 1, 2);
  assert.equal(result.action, "rotated");
  assert.deepEqual(result.deleted.map((f) => path.basename(f)).sort(), ["bridge.log.2", "bridge.log.3", "bridge.log.4"]);
  assert.deepEqual(rotatedFiles(dir), ["bridge.log.1", "bridge.log.2"]);
  assert.match(fs.readFileSync(`${file}.1`, "latin1"), /^current\n/);
  assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "one\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("④ dry-run 不写：只报告 would-rotate，文件与历史原样", () => {
  const dir = tmpDir("dry");
  const file = path.join(dir, "bridge.log");
  const size = writeMB(file, 3, "keepme\n");
  fs.writeFileSync(`${file}.1`, "old\n");

  const result = rotateIfNeeded(file, 1, 5, { dryRun: true });
  assert.equal(result.action, "would-rotate");
  assert.equal(result.rotated, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(
    result.moves.map((m) => path.basename(m.from)),
    ["bridge.log.1", "bridge.log"],
  );
  assert.equal(fs.statSync(file).size, size);
  assert.equal(fs.readFileSync(file, "utf8").startsWith("keepme\n"), true);
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "old\n");
  assert.ok(!fs.existsSync(`${file}.2`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("appendWithRotation：写前检查大小，超限先轮转再落这一行", () => {
  const dir = tmpDir("append");
  const file = path.join(dir, "bridge.log");
  const size = writeMB(file, 1.5, "old\n");
  const result = appendWithRotation(file, "2026-01-01T00:00:00.000Z|info|after", { maxMB: 1, keep: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.rotated?.action, "rotated");
  assert.equal(fs.statSync(`${file}.1`).size, size);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /log_rotated/);
  assert.match(text, /\|info\|after\n$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("缺失文件：action=missing，不报错", () => {
  const dir = tmpDir("missing");
  const result = rotateIfNeeded(path.join(dir, "nope.log"), 1, 2);
  assert.equal(result.action, "missing");
  assert.equal(result.rotated, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("异步入口同文件串行：并发调用不会产生多余历史", async () => {
  const dir = tmpDir("async");
  const file = path.join(dir, "bridge.log");
  writeMB(file, 2, "async\n");
  const [a, b] = await Promise.all([
    rotateIfNeededAsync(file, 1, 5),
    rotateIfNeededAsync(file, 1, 5),
  ]);
  const actions = [a.action, b.action].sort();
  assert.deepEqual(actions, ["none", "rotated"]);
  assert.deepEqual(rotatedFiles(dir), ["bridge.log.1"]);
  assert.match(fs.readFileSync(file, "utf8"), /log_rotated/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("辅助函数：formatBytes / formatRotationLine", () => {
  assert.equal(formatBytes(0), "0B");
  assert.equal(formatBytes(2048), "2.0KB");
  assert.equal(formatBytes(5 * MB), "5.00MB");
  const line = formatRotationLine("C:/x/a.log", "C:/x/a.log.1", 42, new Date("2026-01-02T03:04:05.000Z"));
  assert.equal(line, "2026-01-02T03:04:05.000Z|info|log_rotated|from=C:/x/a.log to=C:/x/a.log.1 bytes=42");
});
