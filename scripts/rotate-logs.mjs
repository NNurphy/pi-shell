#!/usr/bin/env node
// scripts/rotate-logs.mjs · N2 手动/定时清理日志（零第三方依赖）
//
// 用法（项目根执行）：
//   node scripts/rotate-logs.mjs                       # 按默认 5MB / 保留 5 份整理 logs/
//   node scripts/rotate-logs.mjs --dry-run             # 只看会发生什么，不落盘
//   node scripts/rotate-logs.mjs --max-mb 10 --keep 3
//   node scripts/rotate-logs.mjs --dir ~/pi-shell/logs
//   node scripts/rotate-logs.mjs --file bridge.log --file launcher.log
//
// 默认文件：bridge.log、launcher.log、notify.log、mcp.log（不存在的跳过）。
// 上限/保留份数的默认值同桥：PI_SHELL_LOG_MAX_MB=5、PI_SHELL_LOG_KEEP=5。
// 退出码：0 = 全部处理完（含“无需轮转”）；1 = 有文件处理失败。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_KEEP,
  DEFAULT_MAX_MB,
  formatBytes,
  resolveLogLimits,
  rotateIfNeeded,
} from "../bridge/src/log.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`用法：node scripts/rotate-logs.mjs [--max-mb 5] [--keep 5] [--dry-run] [--dir logs] [--file name]...
  --max-mb <n>   单个文件上限（MB，默认 ${DEFAULT_MAX_MB} 或 PI_SHELL_LOG_MAX_MB）
  --keep <n>     保留历史份数（默认 ${DEFAULT_KEEP} 或 PI_SHELL_LOG_KEEP）
  --dry-run      只报告，不改文件
  --dir <path>   日志目录（默认 <project>/logs 或 PI_SHELL_LOG_DIR）
  --file <name>  只处理指定文件（可重复；默认 bridge/launcher/notify/mcp）`);
}

function parseArgs(argv) {
  const env = resolveLogLimits(process.env);
  const opts = {
    maxMB: env.maxMB,
    keep: env.keep,
    dryRun: false,
    dir: process.env.PI_SHELL_LOG_DIR || path.join(ROOT, "logs"),
    files: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 缺少参数值`);
      return value;
    };
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--max-mb") opts.maxMB = next();
    else if (arg.startsWith("--max-mb=")) opts.maxMB = arg.slice("--max-mb=".length);
    else if (arg === "--keep") opts.keep = next();
    else if (arg.startsWith("--keep=")) opts.keep = arg.slice("--keep=".length);
    else if (arg === "--dir") opts.dir = next();
    else if (arg.startsWith("--dir=")) opts.dir = arg.slice("--dir=".length);
    else if (arg === "--file") opts.files.push(next());
    else if (arg.startsWith("--file=")) opts.files.push(arg.slice("--file=".length));
    else throw new Error(`未知参数：${arg}`);
  }
  if (!opts.files.length) opts.files = ["bridge.log", "launcher.log", "notify.log", "mcp.log"];
  opts.dir = path.resolve(opts.dir);
  return opts;
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      total += fs.statSync(path.join(dir, entry.name)).size;
    } catch {}
  }
  return total;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[rotate-logs] ${err.message}`);
    usage();
    return 2;
  }
  if (opts.help) {
    usage();
    return 0;
  }

  // 非法数值（非数字/≤0）回落默认值，与桥的 env 口径一致
  const invalid = (raw) => !Number.isFinite(Number(raw)) || Number(raw) <= 0;
  const limits = resolveLogLimits({ PI_SHELL_LOG_MAX_MB: opts.maxMB, PI_SHELL_LOG_KEEP: opts.keep });
  if (invalid(opts.maxMB)) console.log(`[rotate-logs] --max-mb 非法（${opts.maxMB}），回落 ${limits.maxMB}MB`);
  if (invalid(opts.keep)) console.log(`[rotate-logs] --keep 非法（${opts.keep}），回落 ${limits.keep}`);
  opts.maxMB = limits.maxMB;
  opts.keep = limits.keep;

  const before = dirSize(opts.dir);
  console.log(
    `[rotate-logs] dir=${opts.dir} max=${opts.maxMB}MB keep=${opts.keep} dryRun=${opts.dryRun}`,
  );
  if (!fs.existsSync(opts.dir)) {
    console.log(`[rotate-logs] 目录不存在，无需处理（${opts.dir}）`);
    return 0;
  }

  const summary = { rotated: 0, unchanged: 0, missing: 0, failed: 0 };
  for (const name of opts.files) {
    const file = path.resolve(opts.dir, name);
    const result = rotateIfNeeded(file, opts.maxMB, opts.keep, { dryRun: opts.dryRun });
    const label = `${name}`.padEnd(16);
    if (result.action === "error") {
      summary.failed += 1;
      console.log(`${label} ${formatBytes(result.size).padStart(8)}  FAILED  ${result.error}`);
      continue;
    }
    if (result.action === "missing") {
      summary.missing += 1;
      console.log(`${label} ${"-".padStart(8)}  skipped  (not found)`);
      continue;
    }
    if (result.action === "none") {
      summary.unchanged += 1;
      console.log(`${label} ${formatBytes(result.size).padStart(8)}  unchanged  (limit ${formatBytes(result.maxBytes)})`);
      continue;
    }
    const verb = result.action === "would-rotate" ? "would-rotate" : "rotated";
    summary.rotated += 1;
    const deleted = result.deleted.length ? result.deleted.map((f) => path.basename(f)).join(",") : "none";
    console.log(
      `${label} ${formatBytes(result.size).padStart(8)}  ${verb} -> ${path.basename(result.to)}  deleted=${deleted}`,
    );
  }

  const after = dirSize(opts.dir);
  console.log(
    `[rotate-logs] ${summary.rotated} rotated, ${summary.unchanged} unchanged, ${summary.missing} missing, ${summary.failed} failed | total ${formatBytes(before)} -> ${formatBytes(after)}${opts.dryRun ? " (dry-run: 未落盘)" : ""}`,
  );
  return summary.failed ? 1 : 0;
}

process.exit(main());
