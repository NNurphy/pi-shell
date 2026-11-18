#!/usr/bin/env node
// 模型可用性自检：用 scripts/model.json 配置真发一条最小请求。
// 退出码 0 = 可用；1 = 不可用（打印真实原因，如 402 余额不足 / provider 不存在）。
// 用法：node scripts/model-check.mjs [--timeout 40]
import { execFileSync } from "node:child_process";
import { readModelConfig } from "./model-config.mjs";

const args = process.argv.slice(2);
const tIdx = args.indexOf("--timeout");
const timeoutSec = tIdx >= 0 ? Number(args[tIdx + 1]) || 40 : 40;
const { provider, model, source } = readModelConfig();

if (!provider || !model) {
  console.log(`[model-check] FAIL 未配置模型（scripts/model.json 或 PI_SHELL_PROVIDER/PI_SHELL_MODEL）`);
  process.exit(1);
}

const cli = process.env.USERPROFILE
  ? `${process.env.USERPROFILE}/.pi/agent/bin/pi.ps1`
  : `${process.env.HOME}/.pi/agent/bin/pi.ps1`;

const cmd = [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cli,
  "-p", "--approve", "--no-tools", "--no-session",
  "--provider", provider, "--model", model, "只回复两个字：可用",
];

try {
  const out = execFileSync("powershell", cmd, { encoding: "utf8", timeout: timeoutSec * 1000 });
  const text = String(out).trim();
  if (!text) {
    console.log(`[model-check] FAIL 空回复（${provider}/${model}，来源 ${source}）`);
    process.exit(1);
  }
  console.log(`[model-check] PASS ${provider}/${model}（来源 ${source}）→ ${text.slice(0, 40).replace(/\n/g, " ")}`);
  process.exit(0);
} catch (err) {
  const out = `${err?.stdout || ""}${err?.stderr || ""}`.trim() || String(err?.message || err);
  console.log(`[model-check] FAIL ${provider}/${model}（来源 ${source}）`);
  console.log(`  ${out.split("\n").slice(0, 3).join("\n  ")}`);
  process.exit(1);
}