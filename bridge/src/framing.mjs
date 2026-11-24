// pi-shell bridge · T-04（分帧）
// 职责：把 stdout 字符串流切成 JSONL 记录。**只按 \n 切分**（C-05：禁 readline，
// 因为 readline 会把 U+2028 / U+2029 当成行分隔符，而它们在 JSON 字符串里是合法内容）。
// 纯函数式，无 IO，可单测。

export const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024; // 单行上限 32MiB，超限丢弃该行并记日志
// 2026-11-25 事故：旧值 8MiB，超大会话 get_entries 的 RPC 响应单行
// 8,454,144 字节（全部 entries 装一行）超限被丢 → 桥等不到应答 → 30s 超时接管失败。上限只提高，
// 「超限丢弃 + pi_line_skipped 日志」的保护底线不变；可用 PI_SHELL_MAX_LINE_BYTES 覆盖。

/**
 * 解析 PI_SHELL_MAX_LINE_BYTES 覆盖值：纯数字（正整数字节数）。
 * 纯函数、不读 env——index.mjs 启动时读 env 调这里是唯一入口，非法值由它记 warn 回退。
 * @param {string|undefined|null} raw 环境变量原始值
 * @returns {{bytes:number, ok:boolean, raw:string}} ok=false 表示非法/不可解析 → 调用方回退默认并记 warn（不静默）
 */
export function parseMaxLineBytes(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { bytes: DEFAULT_MAX_LINE_BYTES, ok: true, raw: text };
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n > 0) return { bytes: n, ok: true, raw: text };
  }
  return { bytes: DEFAULT_MAX_LINE_BYTES, ok: false, raw: text };
}

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
