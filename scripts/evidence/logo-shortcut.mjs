#!/usr/bin/env node
// 证据：LOGO 图标资产 + Windows 快捷方式安装器
//
// 取证目标（全部给原始输出，不靠口述）：
//   A1 node scripts/make-icon.mjs 跑通（退出码 0）
//   A2 解析两个 .ico：reserved=0, type=1, count=4；四条目尺寸 = 16/32/48/256；
//      每条目数据段以 PNG magic（\x89PNG）开头
//   A3 setup-windows.ps1 -DesktopDir <临时目录> → 生成 pi-shell.lnk 与 重启 pi-shell.lnk；
//      WScript.Shell 回读 TargetPath / WorkingDirectory / IconLocation 符合口径 2
//   A4 幂等：连跑两遍，退出码均 0，目录下两个 .lnk 仍各一个
//   A5 -Remove → 两个 .lnk 消失
//   A6 真实桌面保护：证据前后真实桌面 .lnk 清单一致（全程只写临时目录）
//   A7 git diff --stat HEAD -- web/src bridge/src 输出为空（本卡不动运行时）
//
// 铁律：不占 7788、不起桥、真实桌面绝不写删（只列清单比对）。
//
// 用法：node scripts/evidence/logo-shortcut.mjs（需要 Edge，供 make-icon 栅格化）
// 退出码：0 = 全部通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(os.tmpdir(), "pi-shell-logo-evidence");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// PowerShell -EncodedCommand（UTF-16LE base64）：命令行含中文路径也不乱码
function psEncode(cmd) {
  return Buffer.from(cmd, "utf16le").toString("base64");
}
function runPowerShell(cmd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", psEncode(cmd)], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    sleep(timeoutMs).then(() => { try { p.kill(); } catch {} });
  });
}

function runNode(args, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    sleep(timeoutMs).then(() => { try { p.kill(); } catch {} });
  });
}

function runGit(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    sleep(timeoutMs).then(() => { try { p.kill(); } catch {} });
  });
}

// ---------- A1：make-icon 跑通 ----------

console.log("== A1 make-icon（favicon.svg → 两个 .ico，Edge 栅格化）==");
const mk = await runNode(["scripts/make-icon.mjs"]);
check("A1a make-icon 退出码 0", mk.code === 0, `code=${mk.code}${mk.err ? ` stderr: ${mk.err.trim().slice(0, 300)}` : ""}`);
console.log(mk.out.trim());

// ---------- A2：解析两个 .ico ----------

console.log("\n== A2 ICO 容器解析（PNG-in-ICO）==");
for (const name of ["pi-shell.ico", "pi-shell-on-dark.ico"]) {
  const icoPath = path.join(REPO_ROOT, "web", "icons", name);
  const ico = fs.readFileSync(icoPath);
  const reserved = ico.readUInt16LE(0);
  const type = ico.readUInt16LE(2);
  const count = ico.readUInt16LE(4);
  check(`A2a ${name} 头：reserved=0,type=1,count=4`, reserved === 0 && type === 1 && count === 4,
    `reserved=${reserved}, type=${type}, count=${count}`);
  const sizes = [];
  let pngOk = true;
  for (let i = 0; i < count; i++) {
    const w = ico[6 + i * 16];
    const h = ico[6 + i * 16 + 1];
    sizes.push(w === 0 ? 256 : w);
    const off = ico.readUInt32LE(6 + i * 16 + 12);
    const magic = ico.subarray(off, off + 4).toString("hex");
    if (magic !== "89504e47") pngOk = false;
    if (h !== w) pngOk = false;
  }
  check(`A2b ${name} 四条目尺寸 = 16/32/48/256`, [16, 32, 48, 256].every((s) => sizes.includes(s)) && sizes.length === 4,
    `sizes=[${sizes.join(",")}]`);
  check(`A2c ${name} 每条目数据段以 PNG magic 开头`, pngOk);
}

// ---------- A3/A4/A5：setup-windows.ps1（临时目录）----------

console.log("\n== A3 setup-windows.ps1 -DesktopDir <临时目录> ==");
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// 真实桌面 .lnk 清单（只读，前后比对）
async function realDesktopLnks() {
  const res = await runPowerShell(
    `[System.IO.Directory]::EnumerateFiles([Environment]::GetFolderPath('Desktop'), '*.lnk') | ForEach-Object { Split-Path $_ -Leaf } | Sort-Object | ConvertTo-Json -Compress`
  );
  return res.out.trim();
}
const before = await realDesktopLnks();
console.log(`  真实桌面 .lnk（前）：${before || "(无)"}`);

const lnkNames = ["pi-shell.lnk", "重启 pi-shell.lnk"];
const lnkPaths = { "pi-shell.lnk": path.join(OUT_DIR, "pi-shell.lnk"), "重启 pi-shell.lnk": path.join(OUT_DIR, "重启 pi-shell.lnk") };
const startCmd = path.join(REPO_ROOT, "scripts", "start-pi-shell.cmd");
const restartCmd = path.join(REPO_ROOT, "scripts", "restart-pi-shell.cmd");
const iconAbs = path.join(REPO_ROOT, "web", "icons", "pi-shell.ico");

const r1 = await runPowerShell(
  `& '${path.join(REPO_ROOT, "scripts", "setup-windows.ps1").replaceAll("'", "''")}' -DesktopDir '${OUT_DIR.replaceAll("'", "''")}'`
);
check("A3a setup 第一遍退出码 0", r1.code === 0, `code=${r1.code} out: ${r1.out.trim().slice(-200)}`);
for (const n of lnkNames) {
  check(`A3b 生成 ${n}`, fs.existsSync(lnkPaths[n]));
}
console.log(r1.out.trim());

// COM 回读（打开已有 .lnk 只读，不 Save）
for (const n of lnkNames) {
  const read = await runPowerShell(
    `$sh = New-Object -ComObject WScript.Shell; $l = $sh.CreateShortcut('${lnkPaths[n].replaceAll("'", "''")}'); ` +
    `[PSCustomObject]@{ TargetPath = $l.TargetPath; WorkingDirectory = $l.WorkingDirectory; IconLocation = $l.IconLocation } | ConvertTo-Json -Compress`
  );
  let parsed = null;
  try { parsed = JSON.parse(read.out); } catch {}
  const expectedTarget = n === "pi-shell.lnk" ? startCmd : restartCmd;
  const norm = (p) => (p || "").replaceAll("\\", "/").toLowerCase();
  const ok = parsed && norm(parsed.TargetPath) === norm(expectedTarget)
    && norm(parsed.WorkingDirectory) === norm(REPO_ROOT)
    && norm(parsed.IconLocation) === norm(`${iconAbs},0`);
  check(`A3c 回读 ${n}（Target/WorkingDir/Icon）`, !!ok,
    parsed ? `Target=${parsed.TargetPath} | WD=${parsed.WorkingDirectory} | Icon=${parsed.IconLocation}` : `无 JSON：${read.out.trim().slice(0, 200)} ${read.err}`);
}

console.log("\n== A4 幂等（连跑第二遍）==");
const r2 = await runPowerShell(
  `& '${path.join(REPO_ROOT, "scripts", "setup-windows.ps1").replaceAll("'", "''")}' -DesktopDir '${OUT_DIR.replaceAll("'", "''")}'`
);
check("A4a 第二遍退出码 0", r2.code === 0, `code=${r2.code}`);
const lnkFiles = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".lnk")).sort();
check("A4b 目录下 .lnk 仍各一个（共 2 个）",
  lnkFiles.length === 2 && lnkNames.every((n) => lnkFiles.includes(n)), `files=[${lnkFiles.join(",")}]`);

console.log("\n== A5 -Remove ==");
const r3 = await runPowerShell(
  `& '${path.join(REPO_ROOT, "scripts", "setup-windows.ps1").replaceAll("'", "''")}' -DesktopDir '${OUT_DIR.replaceAll("'", "''")}' -Remove`
);
check("A5a -Remove 退出码 0", r3.code === 0, `code=${r3.code} out: ${r3.out.trim().slice(-200)}`);
const after5 = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".lnk"));
check("A5b 两个 .lnk 消失", after5.length === 0, `剩余=[${after5.join(",")}]`);

// ---------- A6：真实桌面保护 ----------

console.log("\n== A6 真实桌面保护 ==");
const after = await realDesktopLnks();
check("A6 前后真实桌面 .lnk 清单一致", before === after,
  before === after ? `${(after || "(无)").slice(0, 200)}` : `前=${before.slice(0, 150)} 后=${after.slice(0, 150)}`);

// ---------- A7：不动运行时 ----------

console.log("\n== A7 运行时零改动 ==");
const diff = await runGit(["diff", "--stat", "HEAD", "--", "web/src", "bridge/src"]);
check("A7 git diff --stat HEAD -- web/src bridge/src 为空", diff.code === 0 && diff.out.trim() === "",
  `stdout: ${JSON.stringify(diff.out.trim())} stderr: ${diff.err.trim().slice(0, 200)}`);

// ---------- 收尾 ----------

fs.rmSync(OUT_DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL  ${f.name}  — ${f.detail || ""}`);
  process.exit(1);
}
process.exit(0);
