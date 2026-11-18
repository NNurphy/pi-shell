// S2a 单测：SSE 尾巴缓冲（node --test，零依赖）
import test from "node:test";
import assert from "node:assert/strict";
import { SseTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_FRAME_BYTES } from "../src/sse-tail.mjs";

function frame(seq, payload = { type: "message_update", text: `t${seq}` }) {
  return { seq, payload };
}

test("默认上限：总量 2MB / 单帧 512KB", () => {
  assert.equal(DEFAULT_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_FRAME_BYTES, 512 * 1024);
  const tail = new SseTail();
  assert.equal(tail.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(tail.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
});

test("push 后 since 按 seq 严格递增回放", () => {
  const tail = new SseTail();
  tail.reset(10);
  for (const seq of [11, 12, 13]) assert.deepEqual(tail.push(frame(seq)), { accepted: true });

  const out = tail.since(10);
  assert.equal(out.from, 11);
  assert.equal(out.to, 13);
  assert.deepEqual(out.frames.map((f) => f.seq), [11, 12, 13]);
  assert.deepEqual(out.frames[1].payload, frame(12).payload);
  assert.equal(out.truncated, false);

  // 客户端只缺最后两条
  assert.deepEqual(tail.since(11).frames.map((f) => f.seq), [12, 13]);
});

test("reset 清空缓冲并推进落盘点", () => {
  const tail = new SseTail();
  tail.reset(0);
  tail.push(frame(1));
  tail.push(frame(2));
  assert.equal(tail.size, 2);
  assert.ok(tail.bytes > 0);

  tail.reset(2);
  assert.equal(tail.size, 0);
  assert.equal(tail.bytes, 0);
  assert.equal(tail.baseSeq, 2);
  assert.equal(tail.truncated, false);

  const out = tail.since(1);
  assert.equal(out.from, 3); // 早于落盘点的 since 只回放落点之后
  assert.equal(out.to, 2);
  assert.deepEqual(out.frames, []);
});

test("无 since 时从 baseSeq+1 回放（只补未落盘的尾巴）", () => {
  const tail = new SseTail();
  tail.reset(41);
  tail.push(frame(42));
  tail.push(frame(43));

  for (const missing of [undefined, null]) {
    const out = tail.since(missing);
    assert.equal(out.from, 42);
    assert.equal(out.to, 43);
    assert.deepEqual(out.frames.map((f) => f.seq), [42, 43]);
  }
});

test("客户端已是最新：回放窗口为空", () => {
  const tail = new SseTail();
  tail.reset(7);
  tail.push(frame(8));
  const out = tail.since(8);
  assert.equal(out.from, 9);
  assert.equal(out.to, 8);
  assert.deepEqual(out.frames, []);
});

test("跨落点不重复：落点前的帧不再回放", () => {
  const tail = new SseTail();
  tail.reset(0);
  for (const seq of [1, 2, 3]) tail.push(frame(seq));

  tail.reset(3); // message_end 落盘：1..3 已在 entries 里
  for (const seq of [4, 5]) tail.push(frame(seq));

  // 客户端很旧（since=1）也只能拿到落点之后的部分
  const out = tail.since(1);
  assert.equal(out.from, 4);
  assert.deepEqual(out.frames.map((f) => f.seq), [4, 5]);

  // 反复回放不产生重复/重排
  const again = tail.since(1);
  assert.deepEqual(again.frames.map((f) => f.seq), [4, 5]);
});

test("超总字节上限：丢最旧帧、置 truncated、仍能回放已保留部分", () => {
  const tail = new SseTail({ maxBytes: 200, maxFrameBytes: 1024 });
  tail.reset(0);
  for (let seq = 1; seq <= 5; seq++) {
    assert.deepEqual(tail.push(frame(seq, { type: "message_update", text: "x".repeat(60) })), {
      accepted: true,
    });
  }
  assert.ok(tail.bytes <= 200, `bytes=${tail.bytes}`);
  assert.equal(tail.truncated, true);

  const out = tail.since(0);
  assert.equal(out.truncated, true);
  assert.equal(out.to, 5);
  const seqs = out.frames.map((f) => f.seq);
  assert.ok(seqs.length > 0 && seqs.length < 5, `seqs=${seqs}`);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b)); // 仍严格递增
  assert.equal(seqs.at(-1), 5); // 保留最新
});

test("单帧超 512KB：跳过该帧并置 truncated，seq 仍推进", () => {
  const tail = new SseTail();
  tail.reset(0);
  tail.push(frame(1));
  const big = tail.push(frame(2, { type: "message_update", text: "x".repeat(512 * 1024) }));
  assert.deepEqual(big, { accepted: false, reason: "too_large" });
  assert.equal(tail.size, 1);
  assert.equal(tail.truncated, true);

  // 后续正常帧仍可入缓冲，回放窗口的 to 覆盖被跳过的 seq
  assert.deepEqual(tail.push(frame(3)), { accepted: true });
  const out = tail.since(0);
  assert.equal(out.from, 1);
  assert.equal(out.to, 3);
  assert.deepEqual(out.frames.map((f) => f.seq), [1, 3]);
  assert.equal(out.truncated, true);
});

test("乱序 / 重复 seq 被拒绝，不重复入缓冲", () => {
  const tail = new SseTail();
  tail.reset(0);
  tail.push(frame(1));
  assert.deepEqual(tail.push(frame(1)), { accepted: false, reason: "out_of_order" });
  assert.deepEqual(tail.push(frame(0)), { accepted: false, reason: "out_of_order" });
  assert.deepEqual(tail.push({ payload: {} }), { accepted: false, reason: "invalid_seq" });
  assert.equal(tail.size, 1);
  assert.equal(tail.truncated, false);
});
