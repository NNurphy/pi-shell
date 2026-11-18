// 绑定地址解析（PI_SHELL_BIND）单测：默认不变 / tailscale / 显式 IP / 通配拒绝 / 非法回落
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BIND,
  resolveBind,
  resolveAllowLan,
  parseTailscaleIpv4,
  detectTailscaleIpv4,
  isIpv4,
  isIpv6,
  isLoopbackHost,
  isTailscaleIpv4,
  isWildcardHost,
  bindUrl,
  bindBannerLines,
  bindHosts,
} from "../src/bind.mjs";

const TS_IP = "100.100.100.2";
const withTailscale = (ip = TS_IP) => ({ detect: () => ({ ip, source: "tailscale-cli", reason: null }) });

test("默认：未设置 PI_SHELL_BIND → 127.0.0.1（与 v1.0 行为一致）", () => {
  for (const value of [undefined, null, "", "   "]) {
    const bind = resolveBind({ value });
    assert.equal(bind.ok, true);
    assert.equal(bind.host, DEFAULT_BIND);
    assert.equal(bind.kind, "loopback");
    assert.equal(bind.requested, "");
  }
});

test("显式 127.0.0.1 / localhost / ::1 → 仍是回环，不探测 Tailscale", () => {
  let probed = 0;
  for (const value of ["127.0.0.1", " localhost ", "::1"]) {
    const bind = resolveBind({ value, detect: () => (probed++, { ip: TS_IP }) });
    assert.equal(bind.ok, true);
    assert.equal(bind.kind, "loopback");
    assert.equal(bind.message, null);
  }
  assert.equal(probed, 0, "回环值不应触发 Tailscale 探测（避免启动变慢）");
});

test("tailscale：探测到 100.x → 绑该地址，kind=tailscale", () => {
  const bind = resolveBind({ value: "tailscale", ...withTailscale() });
  assert.equal(bind.ok, true);
  assert.equal(bind.host, TS_IP);
  assert.equal(bind.kind, "tailscale");
  assert.equal(bind.tailscaleIp, TS_IP);
  assert.equal(bind.reason, null);
});

test("tailscale：大小写/空白不敏感", () => {
  const bind = resolveBind({ value: "  TailScale ", ...withTailscale() });
  assert.equal(bind.host, TS_IP);
  assert.equal(bind.kind, "tailscale");
});

test("tailscale：探测不到 → 回落 127.0.0.1 + 明确文案（不崩溃、不外露）", () => {
  const bind = resolveBind({
    value: "tailscale",
    detect: () => ({ ip: null, source: "none", reason: "tailscale 命令不可用（ENOENT）" }),
  });
  assert.equal(bind.ok, true);
  assert.equal(bind.host, DEFAULT_BIND);
  assert.equal(bind.kind, "loopback");
  assert.equal(bind.reason, "tailscale_not_found");
  assert.match(bind.message, /ENOENT/);
  assert.match(bind.message, /127\.0\.0\.1/);
});

test("tailscale：探测函数抛错 → 同样回落，不把异常冒到启动流程", () => {
  const bind = resolveBind({
    value: "tailscale",
    detect: () => {
      throw new Error("boom");
    },
  });
  assert.equal(bind.ok, true);
  assert.equal(bind.host, DEFAULT_BIND);
  assert.match(bind.message, /boom/);
});

test("tailscale：返回非 CGNAT 地址 → 仍然采用，但带 warn reason", () => {
  const bind = resolveBind({ value: "tailscale", ...withTailscale("192.168.1.5") });
  assert.equal(bind.ok, true);
  assert.equal(bind.host, "192.168.1.5");
  assert.equal(bind.kind, "tailscale");
  assert.equal(bind.reason, "tailscale_ip_outside_cgnat");
  assert.match(bind.message, /100\.64\.0\.0\/10/);
});

test("显式 IP（v4 / v6）→ kind=explicit，原样绑定", () => {
  for (const value of ["100.101.168.65", "192.168.1.20", "fd7a:115c:a1e0::1"]) {
    const bind = resolveBind({ value });
    assert.equal(bind.ok, true);
    assert.equal(bind.host, value);
    assert.equal(bind.kind, "explicit");
  }
});

test("护栏：0.0.0.0 没有 PI_SHELL_ALLOW_LAN=1 → 拒绝启动", () => {
  for (const value of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", "*"]) {
    const bind = resolveBind({ value });
    assert.equal(bind.ok, false, `${value} 必须被拒绝`);
    assert.equal(bind.kind, "refused");
    assert.equal(bind.reason, "wildcard_bind_refused");
    assert.match(bind.message, /拒绝启动/);
    assert.match(bind.message, /PI_SHELL_ALLOW_LAN=1/);
    assert.match(bind.message, /PI_SHELL_BIND=tailscale/);
  }
});

test("护栏：0.0.0.0 + PI_SHELL_ALLOW_LAN=1 → 放行，kind=lan（横幅会告警）", () => {
  for (const allowLan of ["1", "true", "TRUE", "yes", true]) {
    const bind = resolveBind({ value: "0.0.0.0", allowLan });
    assert.equal(bind.ok, true);
    assert.equal(bind.host, "0.0.0.0");
    assert.equal(bind.kind, "lan");
    assert.equal(bind.reason, "wildcard_allowed_by_env");
    assert.match(bind.message, /所有网卡/);
  }
  // "0" / 未设 / 空 都不算放行
  for (const allowLan of ["0", "", undefined, "maybe"]) {
    assert.equal(resolveBind({ value: "0.0.0.0", allowLan }).ok, false);
  }
});

test("非法值 → 回落 127.0.0.1（记 warn，不静默外露）", () => {
  for (const value of ["abc", "100.1", "999.1.1.1", "1.2.3.4.5", "10.0.0.1/24", "127.0.0.256"]) {
    const bind = resolveBind({ value });
    assert.equal(bind.ok, true, `${value} 不应导致启动失败`);
    assert.equal(bind.host, DEFAULT_BIND);
    assert.equal(bind.kind, "loopback");
    assert.equal(bind.reason, "invalid_bind");
    assert.match(bind.message, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("isIpv4 / isIpv6 / isLoopbackHost / isWildcardHost / isTailscaleIpv4 边界", () => {
  assert.equal(isIpv4("100.64.0.1"), true);
  assert.equal(isIpv4("0.0.0.0"), true);
  assert.equal(isIpv4("256.0.0.1"), false);
  assert.equal(isIpv4("1.2.3"), false);
  assert.equal(isIpv4(""), false);

  assert.equal(isIpv6("fd7a:115c:a1e0::1"), true);
  assert.equal(isIpv6("[::1]"), true);
  assert.equal(isIpv6("::"), true); // 通配判断在之前，这里只做形态
  assert.equal(isIpv6("100.100.100.2"), false);
  assert.equal(isIpv6("zz::1"), false);

  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("127.0.0.2"), false);

  assert.equal(isWildcardHost("0.0.0.0"), true);
  assert.equal(isWildcardHost("::"), true);
  assert.equal(isWildcardHost("*"), true);
  assert.equal(isWildcardHost("100.100.100.2"), false);

  assert.equal(isTailscaleIpv4("100.64.0.1"), true);
  assert.equal(isTailscaleIpv4("100.127.255.254"), true);
  assert.equal(isTailscaleIpv4("100.128.0.1"), false);
  assert.equal(isTailscaleIpv4("99.64.0.1"), false);
});

test("resolveAllowLan：1/true/yes/on 放行，其余不放行", () => {
  for (const value of ["1", "true", "YES", "on", true]) assert.equal(resolveAllowLan(value), true);
  for (const value of [undefined, "", "0", "false", "no", false, "2"]) assert.equal(resolveAllowLan(value), false);
});

test("parseTailscaleIpv4：取第一行合法 IPv4，容忍 %iface / 前后空白", () => {
  assert.equal(parseTailscaleIpv4("100.100.100.2\n"), "100.100.100.2");
  assert.equal(parseTailscaleIpv4("\r\n  100.100.100.2%Tailscale  \r\nfd7a::1\r\n"), "100.100.100.2");
  assert.equal(parseTailscaleIpv4("fd7a:115c:a1e0::1\n"), null);
  assert.equal(parseTailscaleIpv4(""), null);
  assert.equal(parseTailscaleIpv4(null), null);
});

test("detectTailscaleIpv4：优先 tailscale ip -4 的输出", () => {
  const calls = [];
  const result = detectTailscaleIpv4({
    execFileSync: (cmd, args) => {
      calls.push([cmd, ...args]);
      return "100.100.100.2\n";
    },
  });
  assert.deepEqual(calls, [["tailscale", "ip", "-4"]]);
  assert.deepEqual(result, { ip: "100.100.100.2", source: "tailscale-cli", reason: null });
});

test("detectTailscaleIpv4：命令失败 → 扫网卡兜底（找不到就返回 none + reason）", () => {
  const result = detectTailscaleIpv4({
    execFileSync: () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  });
  // 本机有没有 Tailscale 都不影响断言形态：要么扫到网卡地址，要么明确 none
  assert.ok(["interface", "none"].includes(result.source));
  if (result.source === "none") {
    assert.equal(result.ip, null);
    assert.match(result.reason, /ENOENT/);
  } else {
    assert.equal(isTailscaleIpv4(result.ip), true);
  }
});

test("bindUrl：IPv6 自动加方括号", () => {
  assert.equal(bindUrl("127.0.0.1", 7788), "http://127.0.0.1:7788");
  assert.equal(bindUrl("100.100.100.2", 7788), "http://100.100.100.2:7788");
  assert.equal(bindUrl("fd7a:115c:a1e0::1", 7788), "http://[fd7a:115c:a1e0::1]:7788");
});

test("bindBannerLines：默认回环不打印横幅；tailscale/lan 打印手机地址", () => {
  const loop = resolveBind({ value: "127.0.0.1" });
  assert.deepEqual(bindBannerLines(loop, 7788), []);
  assert.deepEqual(bindBannerLines(resolveBind({}), 7788), []);

  const ts = resolveBind({ value: "tailscale", ...withTailscale() });
  const lines = bindBannerLines(ts, 7788);
  assert.ok(lines.length >= 3);
  assert.match(lines.join("\n"), /http:\/\/100\.100\.100\.2:7788/);
  assert.match(lines.join("\n"), /同一会话勿在手机与 PC 双开/);

  const lan = resolveBind({ value: "0.0.0.0", allowLan: "1" });
  assert.match(bindBannerLines(lan, 7788).join("\n"), /http:\/\/0\.0\.0\.0:7788/);
});

// ---------- Q2：Tailscale 双栈（127.0.0.1 + 100.x 同时监听） ----------

test("tailscale：hosts = [127.0.0.1, 100.x]（双栈，桌面地址不失效）", () => {
  const bind = resolveBind({ value: "tailscale", ...withTailscale() });
  assert.deepEqual(bind.hosts, [DEFAULT_BIND, TS_IP]);
  assert.deepEqual(bindHosts(bind), [DEFAULT_BIND, TS_IP]);
});

test("bindHosts：默认/显式单地址仍是单监听", () => {
  assert.deepEqual(bindHosts(resolveBind({})), [DEFAULT_BIND]);
  assert.deepEqual(bindHosts(resolveBind({ value: "127.0.0.1" })), ["127.0.0.1"]);
  assert.deepEqual(bindHosts(resolveBind({ value: "0.0.0.0", allowLan: "1" })), ["0.0.0.0"]);
  assert.deepEqual(bindHosts(null), [DEFAULT_BIND]);
  // 探测不到 Tailscale 时回落回环：不残留 hosts（避免监听一个不存在的地址）
  const fallback = resolveBind({ value: "tailscale", detect: () => ({ ip: null, reason: "ENOENT" }) });
  assert.equal(fallback.host, DEFAULT_BIND);
  assert.deepEqual(bindHosts(fallback), [DEFAULT_BIND]);
});

test("tailscale 横幅：desktop 与 mobile 两行都给（手机能照抄，桌面快捷方式不失效）", () => {
  const lines = bindBannerLines(resolveBind({ value: "tailscale", ...withTailscale() }), 7788);
  assert.match(lines[0], /^desktop http:\/\/127\.0\.0\.1:7788$/);
  assert.match(lines[1], /^mobile\s+http:\/\/100\.100\.100\.2:7788/);
});
