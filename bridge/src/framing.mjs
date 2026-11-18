// pi-shell bridge · T-04（分帧）
// 职责：把 stdout 字符串流切成 JSONL 记录。**只按 \n 切分**（C-05：禁 readline，
// 因为 readline 会把 U+2028 / U+2029 当成行分隔符，而它们在 JSON 字符串里是合法内容）。
// 纯函数式，无 IO，可单测。

export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024; // 单行上限 8MB，超限丢弃该行并记日志

/**
 * JSONL 行解码器。
 * @param {object} opts
 * @param {number} [opts.maxLineBytes] 单行上限（字节）
 * @param {(line:string)=>void} opts.onLine 收到一条完整行（已去尾部 \r，空行不回调）
 * @param {(info:{reason:string, bytes?:number, dropped?:boolean})=>void} [opts.onSkip] 丢弃/跳过时回调
 */
export class JsonlDecoder {
  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES, onLine, onSkip } = {}) {
    if (typeof onLine !== "function") throw new TypeError("onLine required");
    this.maxLineBytes = maxLineBytes;
    this.onLine = onLine;
    this.onSkip = onSkip || (() => {});
    this._buf = "";
    this._discarding = false;
  }

  push(chunk) {
    let text = typeof chunk === "string" ? chunk : String(chunk);

    if (this._discarding) {
      const nl = text.indexOf("\n");
      if (nl < 0) return; // 仍在丢弃超长行
      text = text.slice(nl + 1); // 丢弃到换行（含）
      this._discarding = false;
    }

    this._buf += text;

    let nl;
    while ((nl = this._buf.indexOf("\n")) >= 0) {
      let line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1); // CRLF
      if (!line) continue;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes > this.maxLineBytes) {
        this.onSkip({ reason: "overlong", bytes: lineBytes, dropped: true });
        continue;
      }
      this.onLine(line);
    }

    // 未完成的半行也受上限约束：超限后进入丢弃态，直到下一个换行
    if (Buffer.byteLength(this._buf, "utf8") > this.maxLineBytes) {
      const bytes = Buffer.byteLength(this._buf, "utf8");
      this._buf = "";
      this._discarding = true;
      this.onSkip({ reason: "overlong", bytes, dropped: true });
    }
  }

  /** 丢弃未完成的半行（子进程重启时调用） */
  reset() {
    this._buf = "";
    this._discarding = false;
  }

  /** 当前未完成行的字节数（测试/诊断用） */
  pendingBytes() {
    return Buffer.byteLength(this._buf, "utf8");
  }
}

/** 解析一条记录；非法 JSON 返回 null（调用方记日志跳过，不记内容） */
export function parseRecord(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
