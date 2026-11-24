// T-04 单测：JSONL 分帧（node --test，零依赖）
// 2026-11-25 事故：上限 8MiB→32MiB + PI_SHELL_MAX_LINE_BYTES 覆盖，用例同步更新。
import test from "node:test";
import assert from "node:assert/strict";
import { JsonlDecoder, parseRecord, parseMaxLineBytes, DEFAULT_MAX_LINE_BYTES } from "../src/framing.mjs";

function collector(opts = {}) {
  const lines = [];
  const skips = [];
  const decoder = new JsonlDecoder({
    maxLineBytes: opts.maxLineBytes,
    onLine: (line) => lines.push(line),
    onSkip: (info) => skips.push(info),
  });
  return { decoder, lines, skips };
}

test("默认单行上限为 32MiB（旧 8MiB 丢过 8.45MB get_entries 响应，2026-11-25 事故）", () => {
  assert.equal(DEFAULT_MAX_LINE_BYTES, 32 * 1024 * 1024);
});

test("事故回归：8.45MB 单行（旧 8MiB 上限必丢）在默认 32MiB 下不丢、不记 onSkip", () => {
  const { decoder, lines, skips } = collector(); // 默认上限
  const target = 8454144; // 事故现场 get_entries 响应字节数
  const line = JSON.stringify({ type: "response", data: "x".repeat(target - 60) });
  assert.ok(Buffer.byteLength(line, "utf8") > 8 * 1024 * 1024, "前置：确实超过旧 8MiB 上限");
  decoder.push(line + "\n");
  assert.equal(lines.length, 1);
  assert.equal(skips.length, 0);
});

test("等于上限不丢，超 1 字节才丢（边界语义：>，不是 >=）", () => {
  const exact = JSON.stringify({ type: "m", pad: "x".repeat(80) });
  const at = collector({ maxLineBytes: Buffer.byteLength(exact, "utf8") });
  at.decoder.push(exact + "\n");
  assert.equal(at.lines.length, 1);
  assert.equal(at.skips.length, 0);
  const over = collector({ maxLineBytes: Buffer.byteLength(exact, "utf8") - 1 });
  over.decoder.push(exact + "\n");
  assert.equal(over.lines.length, 0);
  assert.equal(over.skips.length, 1);
  assert.equal(over.skips[0].reason, "overlong");
});

// ---------- parseMaxLineBytes（PI_SHELL_MAX_LINE_BYTES 覆盖值，纯函数；env 读取在 index.mjs） ----------

test("parseMaxLineBytes：合法纯数字 → 覆盖值（含旧值 8388608，用户可设回）", () => {
  assert.deepEqual(parseMaxLineBytes("1048576"), { bytes: 1048576, ok: true, raw: "1048576" });
  assert.deepEqual(parseMaxLineBytes("8388608"), { bytes: 8388608, ok: true, raw: "8388608" });
  assert.deepEqual(parseMaxLineBytes("67108864"), { bytes: 67108864, ok: true, raw: "67108864" });
});

test("parseMaxLineBytes：未设/空串/纯空白 → 默认值且 ok（不算非法）", () => {
  for (const raw of [undefined, null, "", "   "]) {
    const r = parseMaxLineBytes(raw);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, DEFAULT_MAX_LINE_BYTES);
  }
});

test("parseMaxLineBytes：首尾空白被容忍", () => {
  assert.deepEqual(parseMaxLineBytes(" 2097152 "), { bytes: 2097152, ok: true, raw: "2097152" });
});

test("parseMaxLineBytes：非法值（非数字/小数/负数/0）→ 回退默认且 ok=false（调用方须记 warn）", () => {
  for (const raw of ["abc", "8MiB", "1.5", "-1", "0", "00 1", "0x100000"]) {
    const r = parseMaxLineBytes(raw);
    assert.equal(r.ok, false, `“${raw}” 应判非法`);
    assert.equal(r.bytes, DEFAULT_MAX_LINE_BYTES);
    assert.equal(r.raw, String(raw).trim());
  }
});

test("parseMaxLineBytes：env 覆盖值接入解码器后行为生效（小上限丢大行）", () => {
  const parsed = parseMaxLineBytes("32");
  const { decoder, lines, skips } = collector({ maxLineBytes: parsed.bytes });
  decoder.push('{"pad":"' + "x".repeat(64) + '"}\n{"ok":1}\n');
  assert.deepEqual(lines, ['{"ok":1}']);
  assert.equal(skips.length, 1);
  assert.equal(skips[0].reason, "overlong");
});

test("U+2028 / U+2029 在 JSON 字符串内不切分", () => {
  const { decoder, lines } = collector();
  const record = { type: "message_update", text: "a\u2028b\u2029c\u2028" };
  const wire = JSON.stringify(record); // 这两个字符在 JSON 字符串里合法，不会被转义
  assert.ok(wire.includes("\u2028") && wire.includes("\u2029"), "前置条件：串内确实含 U+2028/2029");
  decoder.push(wire + "\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), record);
});

test("CRLF：尾部 \\r 被剥掉", () => {
  const { decoder, lines } = collector();
  decoder.push('{"a":1}\r\n');
  assert.deepEqual(lines, ['{"a":1}']);
});

test("半行跨 chunk：拼齐后才回调一次", () => {
  const { decoder, lines } = collector();
  decoder.push('{"type":"res');
  assert.equal(lines.length, 0);
  decoder.push('ponse","id":"r1"}');
  assert.equal(lines.length, 0);
  assert.equal(decoder.pendingBytes(), Buffer.byteLength('{"type":"response","id":"r1"}'));
  decoder.push("\n");
  assert.deepEqual(lines, ['{"type":"response","id":"r1"}']);
});

test("一个 chunk 内多条记录：逐条回调", () => {
  const { decoder, lines } = collector();
  decoder.push('{"i":1}\n{"i":2}\n{"i":3}\n');
  assert.deepEqual(lines, ['{"i":1}', '{"i":2}', '{"i":3}']);
});

test("超长行（带换行）被丢弃并记 onSkip，后续行不受影响", () => {
  const { decoder, lines, skips } = collector({ maxLineBytes: 32 });
  const longLine = '{"big":"' + "x".repeat(200) + '"}';
  decoder.push(longLine + "\n" + '{"ok":true}\n');
  assert.deepEqual(lines, ['{"ok":true}']);
  assert.equal(skips.length, 1);
  assert.equal(skips[0].reason, "overlong");
  assert.ok(skips[0].bytes > 32);
});

test("超长行（跨 chunk，无换行）进入丢弃态，直到下一个换行恢复", () => {
  const { decoder, lines, skips } = collector({ maxLineBytes: 16 });
  decoder.push('{"big":"' + "y".repeat(50)); // 超过上限且无换行
  assert.equal(skips.length, 1);
  decoder.push("+".repeat(10)); // 仍在丢弃
  decoder.push('"}\n{"next":1}\n');
  assert.deepEqual(lines, ['{"next":1}']);
});

test("非法 JSON：parseRecord 返回 null，解码器继续处理后续行", () => {
  const { decoder, lines } = collector();
  decoder.push("not json\n" + '{"ok":1}\n');
  assert.equal(lines.length, 2);
  assert.equal(parseRecord(lines[0]), null);
  assert.deepEqual(parseRecord(lines[1]), { ok: 1 });
});

test("parseRecord：数组 / 标量 / 空串都返回 null（协议记录必须是对象）", () => {
  assert.equal(parseRecord("[]"), null);
  assert.equal(parseRecord("42"), null);
  assert.equal(parseRecord('"str"'), null);
  assert.equal(parseRecord(""), null);
});

test("reset 丢弃半行（子进程重启）", () => {
  const { decoder, lines } = collector();
  decoder.push('{"partial":');
  decoder.reset();
  decoder.push('{"full":1}\n');
  assert.deepEqual(lines, ['{"full":1}']);
});
