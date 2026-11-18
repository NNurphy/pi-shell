// T-04 单测：JSONL 分帧（node --test，零依赖）
import test from "node:test";
import assert from "node:assert/strict";
import { JsonlDecoder, parseRecord, DEFAULT_MAX_LINE_BYTES } from "../src/framing.mjs";

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

test("默认单行上限为 8MB", () => {
  assert.equal(DEFAULT_MAX_LINE_BYTES, 8 * 1024 * 1024);
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
