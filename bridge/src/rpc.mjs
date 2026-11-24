// pi-shell bridge · rpc.mjs
// T-03：直连 spawn `process.execPath + <cli.js>`、get_state 握手、状态映射、崩溃重启。
// T-04：完整 JSONL 分帧（framing.mjs）、通用 id 配对队列、30s 请求超时、握手走同一套队列。
// T-05：事件驱动的状态归并（agent_start/agent_settled/disposition），供 /api/events 与 health 使用。
// 不在本任务内：SSE / prompt / abort 端点（T-05）、扩展 UI 桥（T-12）。
// `.cmd` 退路：**不实现**（03 §3 / 04 R-02，H-13/H-14）。PI_SHELL_PI_BIN 语义 = cli.js 绝对路径。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { JsonlDecoder, parseRecord, DEFAULT_MAX_LINE_BYTES } from "./framing.mjs";

const RESTART_DELAYS_MS = [1000, 2000, 4000]; // 03 §3：1s/2s/4s
const CRASH_WINDOW_MS = 5 * 60 * 1000; // 5 分钟内
const MAX_CRASHES_IN_WINDOW = 3; // ≤3 次，超限转 failed，不做无限守护
const KILL_GRACE_MS = 2000; // SIGTERM → 2s → SIGKILL
export const HANDSHAKE_TIMEOUT_MS = 15000; // 握手 15s 无应答 → 按崩溃处理
export const REQUEST_TIMEOUT_MS = 30000; // 03 §10：请求 30s 无响应 → 超时（不重发）

/** 带错误码的 Error（03 §5 的 code 语义由上层映射到 HTTP） */
export function rpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 解析 pi 安装：version + cli 路径（按 package.json 的 bin.pi，不硬编码 dist 路径） */
export function resolvePiInstall({ agentDir } = {}) {
  const dir = agentDir || process.env.PI_SHELL_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const installDir = path.join(dir, "install");
  const version = fs.readFileSync(path.join(installDir, "current-version"), "utf8").trim();
  const pkgDir = path.join(installDir, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
  if (!binRel) throw new Error("package.json 缺少 bin.pi");
  return {
    agentDir: dir,
    installDir,
    pkgDir,
    version: pkg.version || version,
    cliPath: path.resolve(pkgDir, binRel),
  };
}

/** 从 env 判定 cli.js 路径：PI_SHELL_PI_BIN 非空时视为 cli.js 绝对路径（.cmd/.bat 直接拒绝） */
export function resolveCliPath({ agentDir, piBin } = {}) {
  const raw = (piBin ?? process.env.PI_SHELL_PI_BIN ?? "").trim();
  if (raw) {
    if (/\.[Cc][Mm][Dd]$|\.[Bb][Aa][Tt]$/.test(raw)) {
      throw new Error("PI_SHELL_PI_BIN 不支持 .cmd/.bat：请指向 cli.js 的绝对路径，或留空自动解析");
    }
    return path.resolve(raw);
  }
  return resolvePiInstall({ agentDir }).cliPath;
}

export class PiRpc extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cliPath         pi 的 cli.js 绝对路径
   * @param {string} opts.agentDir        agent 目录（同时作为 PI_CODING_AGENT_DIR 传入）
   * @param {string} opts.installDir      install 根（作为 PI_MANAGED_INSTALL_ROOT 传入）
   * @param {string} opts.workspaceCwd    子进程 cwd
   * @param {string} [opts.sessionsDir]   非空则传 --session-dir
   * @param {string} [opts.extraArgs]     PI_SHELL_EXTRA_ARGS：优先 JSON 字符串数组，否则空白切分
   * @param {boolean} [opts.noMcp]        true → 追加 --no-mcp（pi 1.5.0：不连 MCP、不加载 MCP 工具）
   * @param {string} [opts.provider]      非空 → 追加 `--provider <p>`（引擎模型透传；空 = 沿用 pi 自身默认）
   * @param {string} [opts.model]         非空 → 追加 `--model <m>`（同上；不读写 settings.json）
   * @param {string} [opts.agentDirOverride] 非空 → 子进程 PI_CODING_AGENT_DIR 指向它（MCP shim 用）
   * @param {number} [opts.maxLineBytes]  单行上限（默认 32MiB，见 framing.mjs；桥层经 PI_SHELL_MAX_LINE_BYTES 覆盖后显式传入）
   * @param {number} [opts.requestTimeoutMs] 请求超时（默认 30s）
   * @param {(level:string, event:string, fields?:object)=>void} opts.log
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.log = opts.log;
    this.state = "not_started"; // not_started|starting|idle|streaming|crashed|failed|stopping
    this.child = null;
    this.childPid = null;
    this.stopping = false;
    this.failed = false;
    this.restartTimer = null;
    this.crashTimes = [];
    this.spawnCount = 0;
    this.lastGetState = null; // 最近一次 get_state 的 data（T-05 起交给 SSE）
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

    this._decoder = null;
    this._pending = new Map(); // id → {resolve, reject, timer, type, at}
    this._reqSeq = 0;
    this._writeQueue = []; // 写队列（背压）
    this._writing = false;
  }

  snapshot() {
    return { pid: this.childPid, state: this.state };
  }

  /** PI_SHELL_EXTRA_ARGS：JSON 字符串数组优先（支持含空格路径），非 JSON 退化为空白切分 */
  extraArgs() {
    const raw = this.opts.extraArgs;
    if (!raw) return [];
    const text = String(raw).trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
        this.log("warn", "pi_extra_args_not_string_array", {});
      } catch {
        this.log("warn", "pi_extra_args_bad_json", { fallback: "whitespace-split" });
      }
    }
    return text.split(/\s+/).filter(Boolean);
  }

  /** 归一化后的模型透传参数：空串/非字符串 → null（表示「不传，用 pi 自己的默认」） */
  modelOptions() {
    const norm = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return { provider: norm(this.opts.provider), model: norm(this.opts.model) };
  }

  args() {
    const args = ["--mode", "rpc"];
    if (this.opts.sessionsDir) args.push("--session-dir", this.opts.sessionsDir);
    if (this.opts.noMcp === true) args.push("--no-mcp");
    // 引擎模型透传：只在调用方显式给了值时才加，未设（空 / 非字符串）→ 参数列表与旧版完全一致
    const { provider, model } = this.modelOptions();
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    args.push(...this.extraArgs());
    return args;
  }

  env() {
    return {
      ...process.env,
      PI_MANAGED_INSTALL_ROOT: this.opts.installDir,
      // MCP 按需：临时 agentDir（shim）里只有选中的 mcp.json，其余内容 junction/拷贝过来
      PI_CODING_AGENT_DIR: this.opts.agentDirOverride || this.opts.agentDir,
    };
  }

  start() {
    if (this.failed || this.stopping) return;
    if (this.child) return; // 防双实例：有活子进程就不再起
    const args = this.args();
    this._setState("starting", { via: "spawn" });
    this.spawnCount += 1;
    const child = spawn(process.execPath, [this.opts.cliPath, ...args], {
      cwd: this.opts.workspaceCwd,
      env: this.env(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.childPid = child.pid ?? null;

    this._decoder = new JsonlDecoder({
      maxLineBytes: this.opts.maxLineBytes || DEFAULT_MAX_LINE_BYTES,
      onLine: (line) => {
        const record = parseRecord(line);
        if (!record) {
          this.log("warn", "pi_stdout_unparsable", { bytes: line.length }); // 不记内容
          return;
        }
        this._onRecord(record);
      },
      onSkip: (info) => this.log("warn", "pi_line_skipped", info),
    });

    this.log("info", "pi_spawn", {
      pid: this.childPid,
      attempt: this.spawnCount,
      cli: this.opts.cliPath,
      args: JSON.stringify(args), // JSON 形式可审计：含空格路径应为单个元素
      cwd: this.opts.workspaceCwd,
      noMcp: this.opts.noMcp === true,
      agentDir: this.opts.agentDirOverride || this.opts.agentDir,
    });
    // 排障用：本条引擎实际要求的模型（null = 用了 pi 自己的默认，不读 settings.json）
    this.log("info", "engine_spawn", { pid: this.childPid, ...this.modelOptions() });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._decoder?.push(chunk));
    child.stdout.on("error", (err) => this.log("warn", "pi_stdout_error", { reason: err?.code || err?.message }));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log("warn", "pi_stderr", { text: text.slice(0, 600) }); // 只脱敏转发，不参与协议解析
    });
    child.stderr.on("error", (err) => this.log("warn", "pi_stderr_error", { reason: err?.code || err?.message }));
    // pi 死后写入会触发 EPIPE；不监听 stream error 会打死整个桥
    child.stdin.on("error", (err) => {
      this.log("warn", "pi_stdin_error", { pid: this.childPid, reason: err?.code || err?.message });
      this._writeQueue.length = 0;
      this._writing = false;
    });

    child.on("error", (err) => {
      this.log("error", "pi_spawn_error", { pid: this.childPid, reason: err?.code || err?.message });
      // spawn 失败也会走到 close；统一由 close 处理重启
    });

    // exit 只记日志（stdout 可能尚未排空）；重启一律等 close
    child.on("exit", (code, signal) => this.log("warn", "pi_exit", { pid: child.pid, code, signal }));
    child.on("close", (code, signal) => this._onClose(code, signal));

    this._handshake();
  }

  // ---------- 写入（背压） ----------

  _write(record) {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) {
      this.log("warn", "pi_write_skipped", { reason: "stdin not writable", pid: this.childPid });
      return false;
    }
    this._writeQueue.push(JSON.stringify(record) + "\n");
    this._pumpWrites();
    return true;
  }

  /** write() 返回 false 时等 drain 再写下一条，否则大 prompt 会被截断 */
  _pumpWrites() {
    if (this._writing) return;
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return;
    this._writing = true;
    while (this._writeQueue.length) {
      const buf = this._writeQueue.shift();
      let ok = false;
      try {
        ok = stdin.write(buf, "utf8");
      } catch (err) {
        this.log("warn", "pi_stdin_write_failed", { reason: err?.code || err?.message });
        this._writing = false;
        this._writeQueue.length = 0;
        return;
      }
      if (!ok) {
        stdin.once("drain", () => {
          this._writing = false;
          this.log("info", "pi_stdin_drain", { queued: this._writeQueue.length });
          this._pumpWrites();
        });
        return;
      }
    }
    this._writing = false;
  }

  // ---------- 请求/响应（id 配对 + 超时） ----------

  /**
   * 发送一条命令并等待同 id 的 response。
   * @param {string} type 命令名（如 "get_state"）
   * @param {object} [params] 附加字段
   * @param {{timeoutMs?:number, id?:string}} [opts]
   * @returns {Promise<any>} 成功时 resolve(data)；失败 reject(Error{code})
   */
  request(type, params = {}, opts = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(rpcError("PI_NOT_READY", "pi 未就绪"));
    const id = opts.id || `req-${++this._reqSeq}`;
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this.log("error", "pi_request_timeout", { id, type, timeoutMs }); // 只报错，不重发
        reject(rpcError("TIMEOUT", `pi 请求超时：${type}`));
      }, timeoutMs);
      timer.unref?.();
      this._pending.set(id, { resolve, reject, timer, type, at: Date.now() });
      if (!this._write({ id, type, ...params })) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(rpcError("PI_NOT_READY", "pi 未就绪"));
      }
    });
  }

  _handshake() {
    this.log("info", "pi_handshake_sent", { pid: this.childPid });
    this.request("get_state", {}, { timeoutMs: HANDSHAKE_TIMEOUT_MS })
      .then((data) => {
        this.lastGetState = data ?? {};
        const isStreaming = this.lastGetState.isStreaming === true;
        this._setState(isStreaming ? "streaming" : "idle", {
          via: "get_state",
          isStreaming,
          sessionId: this.lastGetState.sessionId,
        });
      })
      .catch((err) => {
        this.log("error", "pi_handshake_failed", { pid: this.childPid, code: err?.code, reason: err?.message });
        this._killChild(`handshake-${err?.code || "error"}`); // close 后按崩溃处理
      });
  }

  /**
   * 扩展 UI 对话框回执（T-12）：不是命令，不产生 response，直接写 stdin。
   * @param {string} id 对应 extension_ui_request 的 id
   * @param {object} fields {value} | {confirmed} | {cancelled:true}
   */
  sendUiResponse(id, fields = {}) {
    const record = { type: "extension_ui_response", id, ...fields };
    const ok = this._write(record);
    this.log(ok ? "info" : "warn", "ext_ui_response", { id, sent: ok });
    return ok;
  }

  /** 事件驱动状态归并（03 §8）：agent_start → streaming；agent_settled → idle */
  noteEvent(record) {
    if (this.failed || this.stopping) return;
    if (record?.type === "agent_start") {
      this._setState("streaming", { via: "agent_start" });
    } else if (record?.type === "agent_settled") {
      this._setState("idle", { via: "agent_settled", aborted: record.aborted === true });
    }
  }

  /** 记录一次显式的 get_state 结果（session/open 之后调用），并把状态映射为 idle/streaming */
  noteGetState(data) {
    this.lastGetState = data ?? {};
    if (this.failed || this.stopping) return;
    const isStreaming = this.lastGetState.isStreaming === true;
    this._setState(isStreaming ? "streaming" : "idle", { via: "get_state", isStreaming });
  }

  /**
   * prompt 回执三态（03 §4①）：
   * started/queued → streaming；handled → **立即 idle**（扩展命令已消费，不会再有 agent_settled）
   */
  notePromptDisposition(disposition) {
    if (this.failed || this.stopping) return;
    if (disposition === "started" || disposition === "queued") {
      this._setState("streaming", { via: `disposition:${disposition}` });
    } else if (disposition === "handled") {
      this._setState("idle", { via: "disposition:handled" });
    }
  }

  _onRecord(record) {
    if (record?.type === "response") {
      const entry = this._pending.get(record.id);
      if (!entry) {
        this.log("warn", "pi_response_unmatched", { id: record.id, command: record.command });
        return;
      }
      this._pending.delete(record.id);
      clearTimeout(entry.timer);
      if (record.success) entry.resolve(record.data ?? null);
      else entry.reject(rpcError("PI_ERROR", record.error || "pi 命令失败"));
      return;
    }
    // 事件：T-04 只透传 + 计数，SSE 广播在 T-05
    this.emit("record", record);
    if (record?.type === "extension_ui_request") {
      this.log("info", "pi_ext_ui_request", { method: record.method, id: record.id });
    }
  }

  /** 拒绝所有在途请求（子进程关闭时调用），避免调用方永久挂起 */
  _rejectPending(reason) {
    if (this._pending.size === 0) return;
    const count = this._pending.size;
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(rpcError("PI_NOT_READY", `pi 子进程已退出（${reason}）`));
      this._pending.delete(id);
    }
    this.log("warn", "pi_pending_rejected", { count, reason });
  }

  _onClose(code, signal) {
    const pid = this.childPid;
    this.child = null;
    this.childPid = null;
    this._decoder?.reset();
    this._decoder = null;
    this._writeQueue.length = 0;
    this._writing = false;
    this._rejectPending(`close code=${code} signal=${signal}`);
    this.log("warn", "pi_close", { pid, code, signal });

    if (this.stopping) {
      this._setState("stopping", { via: "close" });
      this.emit("stopped");
      return;
    }

    this.crashTimes.push(Date.now());
    const cutoff = Date.now() - CRASH_WINDOW_MS;
    this.crashTimes = this.crashTimes.filter((t) => t >= cutoff);
    this._setState("crashed", { via: "close", code, signal, crashesInWindow: this.crashTimes.length });

    if (this.crashTimes.length > MAX_CRASHES_IN_WINDOW) {
      this.failed = true;
      this._setState("failed", { via: "crash-limit", crashesInWindow: this.crashTimes.length });
      this.log("error", "pi_crash_limit_reached", { crashesInWindow: this.crashTimes.length, windowMs: CRASH_WINDOW_MS });
      return;
    }

    const delay = RESTART_DELAYS_MS[Math.min(this.crashTimes.length - 1, RESTART_DELAYS_MS.length - 1)];
    this.log("info", "pi_restart_scheduled", { delayMs: delay, crashesInWindow: this.crashTimes.length });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.failed) return;
      this.start(); // 只在 close 之后起新进程 → 避免同会话双实例
    }, delay);
  }

  _killChild(reason) {
    const child = this.child;
    if (!child || !child.pid) return;
    const pid = child.pid;
    // 一律按 PID 终止，不用命令行匹配（pkill -f 对 env-only 变量无效）
    this.log("info", "pi_kill_sigterm", { pid, reason });
    try {
      child.kill("SIGTERM");
    } catch (err) {
      this.log("warn", "pi_kill_sigterm_failed", { pid, reason: err?.message });
    }
    const timer = setTimeout(() => {
      if (this.child === child) {
        this.log("warn", "pi_kill_sigkill", { pid, reason: "grace expired" });
        try {
          child.kill("SIGKILL");
        } catch (err) {
          this.log("warn", "pi_kill_sigkill_failed", { pid, reason: err?.message });
        }
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
  }

  _setState(next, fields) {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.log("info", "pi_state", { from: prev, to: next, pid: this.childPid, ...(fields || {}) });
    this.emit("state", { from: prev, to: next, ...(fields || {}) });
  }

  /** 优雅停止：不再重启；SIGTERM → 2s → SIGKILL。返回 Promise 在子进程退出或超时后 resolve。 */
  async stop(reason = "shutdown") {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // TODO(T-05)：此处先发 abort 并等 response，再 SIGTERM
    if (!this.child) {
      this._setState("stopping", { via: reason });
      return;
    }
    await new Promise((resolve) => {
      const child = this.child;
      const done = () => {
        clearTimeout(grace);
        clearTimeout(hard);
        resolve();
      };
      const grace = setTimeout(() => {
        if (this.child === child) {
          this.log("warn", "pi_kill_sigkill", { pid: child.pid, reason: "shutdown grace expired" });
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, KILL_GRACE_MS);
      const hard = setTimeout(() => {
        this.log("warn", "pi_stop_timeout", { pid: child.pid });
        resolve();
      }, KILL_GRACE_MS + 1500);
      child.once("close", done);
      this._killChild(reason);
    });
  }
}
