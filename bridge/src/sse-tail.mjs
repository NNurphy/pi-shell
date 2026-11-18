// pi-shell bridge · S2a（SSE 尾巴缓冲）
// 职责：按 seq 保存「尚未落盘」的 SSE 帧，供断线重连回放（不重复、不乱序）。
// 边界用落盘点切：message_end 落盘后由调用方 reset(baseSeq)，此前的帧一律丢弃，
// 回放只覆盖 baseSeq 之后的部分（已完成内容由 session/open + entries 渲染）。
// 纯模块，无 IO、无定时器，可单测。

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 缓冲字节上限，默认 2MB
export const DEFAULT_MAX_FRAME_BYTES = 512 * 1024; // 单帧上限，超过则跳过并置 truncated

export class SseTail {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxBytes] 缓冲总字节上限（超出时丢最旧的帧并置 truncated）
   * @param {number} [opts.maxFrameBytes] 单帧字节上限（超出则跳过该帧并置 truncated）
   */
  constructor({ maxBytes = DEFAULT_MAX_BYTES, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.maxFrameBytes = maxFrameBytes;
    this._baseSeq = 0;
    this._lastSeq = 0;
    this._frames = [];
    this._bytes = 0;
    this._truncated = false;
  }

  /** 落盘点：清空缓冲并记录基线（该 seq 及之前的帧已在 entries 里） */
  reset(baseSeq) {
    const seq = Number(baseSeq);
    this._baseSeq = Number.isFinite(seq) ? seq : 0;
    this._lastSeq = this._baseSeq;
    this._frames = [];
    this._bytes = 0;
    this._truncated = false;
  }

  /**
   * 追加一帧（尚未落盘）。
   * @param {{seq:number, payload:any}} frame
   * @returns {{accepted:boolean, reason?:string}}
   */
  push(frame) {
    const seq = Number(frame?.seq);
    if (!Number.isFinite(seq)) return { accepted: false, reason: "invalid_seq" };
    if (seq <= this._lastSeq) return { accepted: false, reason: "out_of_order" };

    // seq 已被观测到，无论是否入缓冲都推进 lastSeq（回放窗口的 to 以它为准）
    this._lastSeq = seq;

    const payload = frame.payload;
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? null), "utf8");
    if (bytes > this.maxFrameBytes) {
      this._truncated = true;
      return { accepted: false, reason: "too_large" };
    }

    this._frames.push({ seq, payload });
    this._bytes += bytes;

    // 超总上限：从最旧的帧开始丢，保留最新部分（truncated 提示前端"部分输出未能补齐"）
    while (this._bytes > this.maxBytes && this._frames.length > 0) {
      const dropped = this._frames.shift();
      this._bytes -= Buffer.byteLength(JSON.stringify(dropped.payload ?? null), "utf8");
      this._truncated = true;
    }

    return { accepted: true };
  }

  /**
   * 取回放窗口：max(seq, baseSeq)+1 .. lastSeq。
   * 无 since（undefined/null）时从 baseSeq+1 开始，即只回放未落盘的尾巴。
   * @param {number} [seq] 客户端已收到的最后 seq（lastSeq）
   * @returns {{from:number, to:number, frames:Array<{seq:number,payload:any}>, truncated:boolean}}
   */
  since(seq) {
    const seen = Number(seq);
    const start = Math.max(Number.isFinite(seen) ? seen : this._baseSeq, this._baseSeq) + 1;
    const frames = this._frames
      .filter((f) => f.seq >= start)
      .map((f) => ({ seq: f.seq, payload: f.payload }));
    return { from: start, to: this._lastSeq, frames, truncated: this._truncated };
  }

  get baseSeq() {
    return this._baseSeq;
  }

  get truncated() {
    return this._truncated;
  }

  get size() {
    return this._frames.length;
  }

  get bytes() {
    return this._bytes;
  }
}
