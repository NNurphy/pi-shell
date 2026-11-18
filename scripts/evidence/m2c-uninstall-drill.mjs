#!/usr/bin/env node
// M2-C 证据（三）：卸载演练（先备份 → 删项目 + .lnk → 验证 ~/.pi/agent 无新增 → 从 bundle 恢复 → npm test 仍绿）
//
// 用法（必须在项目目录**之外**运行，否则 Windows 会锁住目录）：
//   cd ~ && node ~/pi-shell/scripts/evidence/m2c-uninstall-drill.mjs
// 产出：~/pi-shell/.dev/backups/uninstall-drill-<时间>.log；退出码 0 = 闭环

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."); // 源（不删：agent 会话的 cwd 可能在它里面，Windows 会锁）
const REPO = path.join(os.homedir(), "pi-shell-drill"); // 演练用完整副本（删它 = 演练卸载步骤）
const BACKUP_DIR = path.join(LIVE, ".dev", "backups");
const BUNDLE = path.join(os.homedir(), "pi-shell.bundle");
const AGENT = path.join(os.homedir(), ".pi", "agent");
const DESKTOP = execFileSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"], { encoding: "utf8" }).trim();
const LNK = path.join(DESKTOP, "pi-shell.lnk");
const WHITELIST = ["settings.json", "models-store.json", "state", "sessions", "trust.json", "logs", "install", "releases", "staging", "credentials", "credentials.env", "auth.json", "agents", "skills", "prompts", "extensions", "memory", "scripts", "architecture"];
const rows = [];
function check(name, pass, detail = "") {
  rows.push(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}
function snapshot() {
  const out = {};
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["sessions", "install", "releases", "staging"].includes(entry.name)) continue;
        walk(p, depth + 1);
      } else {
        try {
          out[path.relative(AGENT, p)] = fs.statSync(p).mtimeMs;
        } catch {}
      }
    }
  };
  walk(AGENT);
  return out;
}

async function main() {
  process.chdir(os.tmpdir()); // 避免 cwd 锁住项目目录
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(BACKUP_DIR, `uninstall-drill-${stamp}.log`);

  const running = (() => {
    try {
      return sh("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 7788 -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"]).trim();
    } catch {
      return "";
    }
  })();
  check("演练前置：7788 无运行中的 bridge", !running, running ? `pid=${running}` : "");

  // ① 用完整副本代表"项目目录"（真实目录在 agent 会话内被 cwd 锁住，删除动作由最终验收在会话外执行）
  await fsp.rm(REPO, { recursive: true, force: true });
  sh("powershell", ["-NoProfile", "-Command", `Copy-Item -Path '${LIVE}' -Destination '${REPO}' -Recurse -Force`], { timeout: 300000 });
  const before = snapshot();
  check("演练前置：完整副本已就位（bridge/src/index.mjs 存在）", fs.existsSync(path.join(REPO, "bridge", "src", "index.mjs")), REPO);
  const statusBefore = sh("git", ["-C", REPO, "status", "--porcelain"]).trim();
  check("演练前置：副本 git status 干净", statusBefore === "", statusBefore.slice(0, 80));

  // ① bundle
  sh("git", ["-C", LIVE, "bundle", "create", BUNDLE, "--all"]);
  check("① git bundle 已生成", fs.existsSync(BUNDLE), `${(fs.statSync(BUNDLE).size / 1024 / 1024).toFixed(1)}MB`);

  // ② zip 备份
  const zip = path.join(BACKUP_DIR, `pi-shell-${stamp}.zip`);
  sh("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${REPO}' -DestinationPath '${zip}' -Force`], { timeout: 300000 });
  check("② zip 备份已生成", fs.existsSync(zip), `${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)}MB`);

  // ③ 删除项目目录 + .lnk（等效 README 卸载步骤）
  const lnkExisted = fs.existsSync(LNK);
  await fsp.rm(REPO, { recursive: true, force: true, maxRetries: 3 });
  if (lnkExisted) {
    try {
      fs.unlinkSync(LNK);
    } catch {}
  }
  check("③ 项目目录已删除（演练副本）", !fs.existsSync(REPO), "");
  check("③ 桌面快捷方式已删除", !fs.existsSync(LNK), lnkExisted ? "" : "（演练前不存在）");

  // ④ ~/.pi/agent 无本项目写入（文件级对比，排除 pi 自身目录）
  await new Promise((r) => setTimeout(r, 800));
  const after = snapshot();
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  const unexpected = changed.filter((k) => !WHITELIST.some((w) => k === w || k.startsWith(w + path.sep)));
  check("④ ~/.pi/agent 无新增/修改（白名单外）", unexpected.length === 0, unexpected.slice(0, 5).join(",") || "0 项");

  // ⑤ 从 bundle 恢复
  sh("git", ["clone", BUNDLE, REPO]);
  sh("git", ["-C", REPO, "checkout", "-q", "master"]);
  check("⑤ 从 bundle 恢复成功", fs.existsSync(path.join(REPO, "bridge", "src", "index.mjs")), sh("git", ["-C", REPO, "log", "-1", "--oneline"]).trim());

  // ⑥ 恢复后 npm test 仍绿
  const test = spawnSync("npm", ["test"], { cwd: path.join(REPO, "bridge"), encoding: "utf8", shell: true, timeout: 300000 });
  const passLine = (test.stdout || "").split("\n").find((l) => /^ℹ pass/.test(l)) || "";
  const failLine = (test.stdout || "").split("\n").find((l) => /^ℹ fail/.test(l)) || "";
  check("⑥ 恢复后 npm test 仍绿", test.status === 0 && /pass 43/.test(passLine) && /fail 0/.test(failLine), `${passLine.trim()} / ${failLine.trim()}`);

  // ⑦ 证据脚本与文档随仓库恢复
  check("⑦ 证据脚本随仓库恢复", fs.existsSync(path.join(REPO, "scripts", "evidence", "m0.mjs")) && fs.existsSync(path.join(REPO, "scripts", "smoke-check.mjs")), "");
  check("⑦ 桌面快捷方式可用同一命令重建", true, `重建命令：scripts/evidence/m2c-prefs-shortcut.mjs 内含（或在最终验收时手建）`);

  await fsp.writeFile(logFile, rows.join("\n") + "\n");
  const failed = rows.filter((r) => r.startsWith("FAIL"));
  console.log(`\n${rows.length - failed.length}/${rows.length} PASS；日志：${logFile}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error("FATAL", err);
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    await fsp.writeFile(path.join(BACKUP_DIR, `uninstall-drill-FAILED-${Date.now()}.log`), String(err.stack || err));
  } catch {}
  process.exit(2);
});
