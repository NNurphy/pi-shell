// 绑定地址解析（PI_SHELL_BIND）—— 手机 Tailscale 访问支持。
//
// 默认行为不变：127.0.0.1，只绑回环。
// 显式选择外露的三种写法：
//   PI_SHELL_BIND=tailscale        → 自动取 Tailscale IPv4（tailscale ip -4，失败再扫网卡），
//                                    并**双栈监听** 127.0.0.1 + 100.x（桌面地址不失效）
//   PI_SHELL_BIND=100.x.y.z        → 任意显式 IP（v4/v6）
//   PI_SHELL_BIND=0.0.0.0          → 仅当同时 PI_SHELL_ALLOW_LAN=1 才放行，否则拒绝启动
// 任何非法值 → 回落 127.0.0.1（不静默外露，也不静默崩溃）。

import os from "node:os";
import { execFileSync } from "node:child_process";

export const DEFAULT_BIND = "127.0.0.1";
export const TAILSCALE_KEYWORD = "tailscale";
/** 通配绑定：等于「监听所有网卡」，默认拒绝 */
export const WILDCARD_HOSTS = ["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0", "[::]", "*"];
/** Tailscale 用 CGNAT 段 100.64.0.0/10（100.64.0.0 – 100.127.255.255） */
const TAILSCALE_PREFIX = { first: 100, secondMin: 64, secondMax: 127 };

function text(value) {
  return String(value ?? "").trim();
}

export function isWildcardHost(value) {
  return WILDCARD_HOSTS.includes(text(value).toLowerCase());
}

export function isLoopbackHost(value) {
  const host = text(value).toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** 严格点分四段 IPv4（0–255），拒绝 "100.1"、"999.1.1.1"、"1.2.3.4.5" */
export function isIpv4(value) {
  const host = text(value);
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 宽松 IPv6：只做形态检查（十六进制 + 冒号，至少 3 段），够用来挡打字错误 */
export function isIpv6(value) {
  const host = text(value).replace(/^\[|\]$/g, "");
  if (!host.includes(":")) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(host)) return false;
  if (host.includes(":::")) return false;
  return host.split(":").length >= 3;
}

export function isIpHost(value) {
  return isIpv4(value) || isIpv6(value);
}

export function isTailscaleIpv4(value) {
  if (!isIpv4(value)) return false;
  const [a, b] = text(value).split(".").map(Number);
  return a === TAILSCALE_PREFIX.first && b >= TAILSCALE_PREFIX.secondMin && b <= TAILSCALE_PREFIX.secondMax;
}

/** `tailscale ip -4` 的输出 → 第一个合法 IPv4（容忍 `100.x.y.z%iface` 与空行） */
export function parseTailscaleIpv4(stdout) {
  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trim().split("%")[0].trim();
    if (isIpv4(line)) return line;
  }
  return null;
}

/**
 * 探测本机 Tailscale IPv4：
 * 1) `tailscale ip -4`（最权威，含 MagicDNS 视角下的本机地址）
 * 2) 扫网卡，取 100.64.0.0/10 的地址（Tailscale 未在 PATH 时的兜底）
 * @returns {{ip:string|null, source:"tailscale-cli"|"interface"|"none", reason:string|null}}
 */
export function detectTailscaleIpv4(options = {}) {
  const tryExec = options.execFileSync ?? execFileSync;
  try {
    const stdout = tryExec("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    const ip = parseTailscaleIpv4(stdout);
    if (ip) return { ip, source: "tailscale-cli", reason: null };
    return scanInterfaces("tailscale ip -4 输出里没有 IPv4 地址");
  } catch (err) {
    return scanInterfaces(`tailscale 命令不可用（${err?.code || err?.message || "unknown"}）`);
  }
}

function scanInterfaces(note) {
  const nets = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(nets || {})) {
    for (const address of addresses || []) {
      const family = address?.family;
      const isV4 = family === "IPv4" || family === 4;
      if (!isV4) continue;
      const candidate = text(address.address);
      if (isTailscaleIpv4(candidate) || /tailscale/i.test(name)) {
        return { ip: candidate, source: "interface", reason: null };
      }
    }
  }
  return { ip: null, source: "none", reason: `${note}，网卡里也没有 100.64.0.0/10 地址` };
}

export function resolveAllowLan(value) {
  return /^(1|true|yes|on)$/i.test(text(value));
}

/**
 * 解析 PI_SHELL_BIND。
 * @param {object} input
 * @param {string} [input.value]        PI_SHELL_BIND 原始值
 * @param {string|boolean} [input.allowLan] PI_SHELL_ALLOW_LAN 原始值
 * @param {Function} [input.detect]     注入探测函数（单测用）
 * @returns {{ok:boolean, host:string, kind:"loopback"|"tailscale"|"explicit"|"lan"|"refused",
 *            requested:string, reason:string|null, message:string|null, tailscaleIp:string|null, allowLan:boolean}}
 */
export function resolveBind(input = {}) {
  const requested = text(input.value);
  const allowLan = resolveAllowLan(input.allowLan);
  const base = { requested, tailscaleIp: null, allowLan, reason: null, message: null };

  const loopback = (reason, message) => ({
    ...base,
    ok: true,
    host: DEFAULT_BIND,
    kind: "loopback",
    reason,
    message,
  });

  // 1) 未设置 → 默认回环（与 v1.0 行为完全一致）
  if (!requested) return { ...base, ok: true, host: DEFAULT_BIND, kind: "loopback" };

  // 2) tailscale 关键字 → 探测本机 100.x 地址
  if (requested.toLowerCase() === TAILSCALE_KEYWORD) {
    const detect = input.detect ?? (() => detectTailscaleIpv4());
    let found;
    try {
      found = detect() || {};
    } catch (err) {
      found = { ip: null, reason: err?.message || "探测失败" };
    }
    const ip = text(found.ip);
    if (!ip) {
      return loopback(
        "tailscale_not_found",
        `PI_SHELL_BIND=tailscale 但没拿到 Tailscale IPv4（${found.reason || "未知原因"}）→ 已回落 ${DEFAULT_BIND}。` +
          ` 检查：tailscale status 是否已登录（详见 docs/RUNBOOK.md「手机访问（Tailscale）」）。`,
      );
    }
    const legacy = isIpv4(ip) && !isTailscaleIpv4(ip);
    // 双栈：Tailscale 模式下同时监听回环与 100.x（桌面快捷方式仍走 127.0.0.1）。
    // 只监听 100.x 会让 http://127.0.0.1:PORT 失效——这是 Q2 修的回归。
    return {
      ...base,
      ok: true,
      host: ip,
      hosts: [DEFAULT_BIND, ip],
      kind: "tailscale",
      tailscaleIp: ip,
      reason: legacy ? "tailscale_ip_outside_cgnat" : null,
      message: legacy ? `Tailscale 返回的 ${ip} 不在 100.64.0.0/10 段内，请确认这是预期的地址。` : null,
    };
  }

  // 3) 通配绑定 → 默认拒绝（安全护栏）
  if (isWildcardHost(requested)) {
    if (!allowLan) {
      return {
        ...base,
        ok: false,
        host: DEFAULT_BIND,
        kind: "refused",
        reason: "wildcard_bind_refused",
        message:
          `拒绝启动：PI_SHELL_BIND=${requested} 会让桥监听所有网卡（含局域网/公网）。` +
          ` 默认不允许。手机远程访问请用 PI_SHELL_BIND=tailscale（自动取 100.x 地址，不经过公网）；` +
          ` 确实要暴露到局域网，请显式设置 PI_SHELL_ALLOW_LAN=1（自担风险，见 docs/RUNBOOK.md）。`,
      };
    }
    return {
      ...base,
      ok: true,
      host: requested,
      kind: "lan",
      reason: "wildcard_allowed_by_env",
      message: `PI_SHELL_ALLOW_LAN=1：绑定 ${requested}（所有网卡），任何能连到本机端口的人都能操作 pi。`,
    };
  }

  // 4) 回环别名（localhost / ::1）→ 仍算回环
  if (isLoopbackHost(requested)) {
    return { ...base, ok: true, host: requested, kind: "loopback" };
  }

  // 5) 显式 IP → 直接用
  if (isIpHost(requested)) {
    return { ...base, ok: true, host: requested, kind: "explicit" };
  }

  // 6) 非法值 → 回落回环（不外露、不崩溃）
  return loopback(
    "invalid_bind",
    `PI_SHELL_BIND=${requested} 既不是合法 IP 也不是 tailscale → 已回落 ${DEFAULT_BIND}。`,
  );
}

/** URL 形式（IPv6 加方括号） */
export function bindUrl(host, port) {
  const shown = String(host).includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

/** 实际监听的地址列表：Tailscale 是双栈（127.0.0.1 + 100.x），其余单地址 */
export function bindHosts(bind) {
  if (!bind) return [DEFAULT_BIND];
  const hosts = Array.isArray(bind.hosts) ? bind.hosts.filter(Boolean) : [];
  return hosts.length ? [...new Set(hosts)] : [bind.host];
}

/**
 * 启动横幅：默认回环不打印（不打扰）。
 * Tailscale = 双栈，必须同时给出 desktop / mobile 两个地址，否则用户会以为桌面入口失效。
 */
export function bindBannerLines(bind, port) {
  if (!bind || bind.kind === "loopback") return [];
  const hosts = bindHosts(bind);
  if (bind.kind === "tailscale") {
    const mobile = hosts.find((host) => !isLoopbackHost(host)) || bind.host;
    return [
      `desktop ${bindUrl(DEFAULT_BIND, port)}`,
      `mobile  ${bindUrl(mobile, port)}   （同一 tailnet，已登录 Tailscale）`,
      "同一会话勿在手机与 PC 双开（会互相抢占引擎）；关闭窗口 / Ctrl+C 即恢复不对外监听。",
      "详见 docs/RUNBOOK.md「手机访问（Tailscale）」。",
    ];
  }
  const url = bindUrl(bind.host, port);
  return [
    `bind = ${bind.host} (${bind.kind}) → ${url}`,
    `手机访问（同一 tailnet，已登录 Tailscale）: ${url}`,
    "注意：绑非回环且非 tailscale 时 127.0.0.1 不再可用；同一会话勿在手机与 PC 双开（会互相抢占引擎）。",
    "关闭窗口 / Ctrl+C 即恢复不对外监听；详见 docs/RUNBOOK.md「手机访问（Tailscale）」。",
  ];
}
