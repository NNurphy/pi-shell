#!/usr/bin/env node
// P0 回归（H-15）：桥的 stderr 指向管道且**读取端不消费**时，不得阻塞事件循环。
// 复现原 bug 的条件：stdio ["ignore","pipe","pipe"] + 不读 stderr + 大量请求（日志量 > 64KB）。
//
// 用法：node scripts/evidence/p0-stderr-pipe.mjs
// 断言：① 60 次大 path 请求期间 /api/health 始终 200；② stderr 管道几乎没有数据（桥不再写 stderr）；
//       ③ 请求全部完成且桥仍可用；④ 收尾按端口 PID 清理，无残留。

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-p0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const check = (name, pass, detail = "") => {
  rows.push(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
function portPid(port) {
  try {
    // 只认监听套接字：TIME_WAIT/CLOSED 的客户端连接也会带 LocalPort，取到的是 0 或过期 PID
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
      { encoding: "utf8" },
    ).trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}

async function main() {
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {}
  await fsp.mkdir(OUT, { recursive: true });
  try {
    await fetch(`${BASE}/api/health`, { cache: "no-store" });
    check(`端口 ${PORT} 空闲`, false, "已有 bridge 在跑");
    process.exit(1);
  } catch {}

  const logFile = path.join(OUT, "bridge.log");
  // 关键：stderr 接管道但**不消费**（模拟 m2c-real-task 的受害者场景）
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_CWD: os.homedir(), PI_SHELL_LOG_FILE: logFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBytes = 0;
  // 注意：**故意不监听** child.stderr 的 data；只在最后读 readableLength
  child.stderr.on("error", () => {});

  try {
    // 等 idle
    let up = false;
    for (let i = 0; i < 300; i++) {
      try {
        const h = await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json();
        if (h.pi.state === "idle") {
          up = true;
          break;
        }
      } catch {}
      await sleep(150);
    }
    check("桥启动并就绪", up, "");

    // 60 次「大 path」请求：每次都会产生日志（path 字段很长），累积量远超 64KB
    const longPath = "/" + "x".repeat(3000);
    let okCount = 0;
    let lastStatus = 0;
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${BASE}${longPath}`, { cache: "no-store" });
        lastStatus = res.status;
        if (res.status === 404) okCount += 1;
      } catch {
        lastStatus = 0;
      }
    }
    const elapsed = Date.now() - t0;
    check("60 次请求全部完成（未卡死）", okCount >= 55, `${okCount}/60 · ${elapsed}ms · last=${lastStatus}`);

    // 请求期间/之后 health 必须仍 200
    let healthOk = true;
    let healthDetail = "";
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(`${BASE}/api/health`, { cache: "no-store" });
        const body = await res.json();
        healthDetail = `${res.status}/${body.pi?.state}`;
        if (res.status !== 200) healthOk = false;
      } catch (err) {
        healthOk = false;
        healthDetail = `fetch failed: ${err.message}`;
      }
      await sleep(200);
    }
    check("大量日志后 /api/health 仍 200", healthOk, healthDetail);

    stderrBytes = child.stderr.readableLength || 0;
    check("stderr 管道未被写入（readableLength≈0，桥走文件日志）", stderrBytes < 4096, `${stderrBytes}B`);

    const logSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    check("文件日志正常增长（日志没丢）", logSize > 50 * 1024, `${(logSize / 1024).toFixed(1)}KB`);
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    check("文件日志含 start 行与 stderrMode=file-only", /bridge_start/.test(logText) && /stderrMode=file-only/.test(logText), "");
  } catch (err) {
    check("运行异常", false, err.message);
  } finally {
    const pid = portPid(PORT) ?? child.pid;
    if (pid) {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
      } catch {}
    }
    await sleep(1500);
    check("收尾：端口已释放", portPid(PORT) === null, "");
    await fsp.writeFile(path.join(OUT, "summary.txt"), rows.join("\n") + "\n");
    const failed = rows.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${rows.length - failed.length}/${rows.length} PASS`);
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
