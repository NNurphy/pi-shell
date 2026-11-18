#!/usr/bin/env node
// M2-C 证据（一）：T-21 偏好（主题/密度/字号/快捷键提示 + 刷新保持 + localStorage 失效降级）+ T-22 桌面快捷方式
//
// 用法：node scripts/evidence/m2c-prefs-shortcut.mjs   （端口需空闲；需要 Edge；会在桌面创建/删除 pi-shell.lnk）
// 产出：%TMP%\pi-shell-m2c\summary.txt + m2c-settings.png

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_SHELL_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), "pi-shell-m2c");
const DESKTOP = (() => {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"], { encoding: "utf8" }).trim();
  } catch {
    return path.join(os.homedir(), "Desktop");
  }
})();
const LNK = path.join(DESKTOP, "pi-shell.lnk");
const CMD = path.join(REPO_ROOT, "scripts", "start-pi-shell.cmd");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function kill(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } catch {}
}
function portPid(port) {
  try {
    // 只认「监听行」：同端口会挂一堆 TIME_WAIT 连接（OwningProcess=0）。
    // 本机 Get-NetTCPConnection 把监听行的 State 报成空（-State Listen 会得到 0 行），
    // 但监听行的 RemotePort 恒为 0 —— 用它区分。
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 -and $_.OwningProcess -gt 0 } | Select-Object -First 1).OwningProcess`],
      { encoding: "utf8" },
    ).trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}
/**
 * 结束「启动器 cmd → node 桥 → pi」整棵树（按端口定位）。
 * 为什么不能只杀 node：start-pi-shell.cmd 带崩溃自愈循环，node 被 /F 杀掉后
 * 退出码非 0 → 1s 后自动重启，端口一直被占（同 scripts/restart-pi-shell.ps1 的口径）。
 */
function killPortTree(port) {
  const pid = portPid(port);
  if (!pid) return null;
  let target = pid;
  try {
    const parent = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `$p=(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId; if($p){ $pp=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if($pp -and $pp.Name -eq 'cmd.exe'){ $p } }`],
      { encoding: "utf8" },
    ).trim();
    if (parent) target = Number(parent);
  } catch {}
  try {
    execFileSync("taskkill", ["/PID", String(target), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  return target;
}
async function getJson(url) {
  const res = await fetch(`${BASE}${url}`, { cache: "no-store" });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  return ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p)) || null;
}
async function freePort(start) {
  const net = await import("node:net");
  for (let port = start; port < start + 120; port++) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (ok) return port;
  }
  throw new Error("无空闲端口");
}
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    p(m.result);
  });
  const ready = new Promise((res) => ws.addEventListener("open", res));
  return {
    ready,
    send: (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); }),
    close: () => ws.close(),
  };
}
async function evaluate(cdp, expr, awaitPromise = true) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true, timeout: 120000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
}
async function shot(cdp, file) {
  const data = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data.data, "base64"));
}
async function waitPage(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const h = await getJson("/api/health");
      if (h.status === 200 && h.data?.pi?.state === "idle") return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function main() {
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {}
  await fsp.mkdir(OUT, { recursive: true });

  // ---------- T-22：快捷方式存在 + 可拉起 ----------
  check("T-22 启动脚本存在（scripts/start-pi-shell.cmd）", fs.existsSync(CMD), CMD);
  check("T-22 桌面快捷方式存在（pi-shell.lnk）", fs.existsSync(LNK), `${LNK}（${fs.existsSync(LNK) ? fs.statSync(LNK).size + "B" : "缺失"}）`);

  // 用 Start-Process 拉起 .lnk（等于双击），等页面 200
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `Start-Process -FilePath '${LNK}'`], { timeout: 15000 });
  } catch (err) {
    check("T-22 Start-Process 拉起快捷方式", false, err.message);
  }
  const up = await waitPage(30000);
  const health = await getJson("/api/health");
  const startedPid = portPid(PORT);
  check("T-22 双击快捷方式后 /api/health 200 且 state=idle", up && health.status === 200 && health.data?.pi?.version === "1.5.0", `pid=${startedPid}`);
  if (startedPid) {
    // 产品行为（Q4/Q6 起）：start-pi-shell.cmd 带崩溃自愈循环（守护 cmd → node 桥 → pi）。
    // 只杀 node 会被循环 1s 后拉起来（端口仍占）→ 必须像 scripts/restart-pi-shell.ps1 一样结束整棵树。
    killPortTree(PORT);
    await sleep(2500);
  }
  check("T-22 关闭后端口释放（无残留 bridge）", portPid(PORT) === null, "");

  // 回滚步骤可执行：删 .lnk 后再恢复
  try {
    fs.unlinkSync(LNK);
    const gone = !fs.existsSync(LNK);
    execFileSync("powershell", ["-NoProfile", "-Command", `$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('${LNK}'); $s.TargetPath='${CMD}'; $s.WorkingDirectory='${REPO_ROOT}'; $s.Description='pi-shell — 本地网页外壳'; $s.Save()`], { timeout: 15000 });
    check("T-22 回滚可删（删掉后可重建）", gone && fs.existsSync(LNK), "删除 → 重建成功");
  } catch (err) {
    check("T-22 回滚可删（删掉后可重建）", false, err.message);
  }

  // ---------- 起桥做 T-21 页面测试 ----------
  const logs = [];
  const bridge = spawn(process.execPath, [path.join(REPO_ROOT, "bridge/src/index.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_SHELL_PORT: String(PORT), PI_SHELL_CWD: os.homedir() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) logs.push(l);
  });
  let edge = null;
  try {
    if (!(await waitPage(60000))) throw new Error("bridge 未就绪");
    const edgePath = findEdge();
    if (!edgePath) {
      check("找到 Edge", false, "未找到 msedge.exe");
    } else {
      const debugPort = await freePort(PORT + 1600);
      const profile = path.join(OUT, `edge-${Date.now()}`);
      edge = spawn(edgePath, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--window-size=1440,900", `${BASE}/`], { stdio: "ignore" });
      let target = null;
      for (let i = 0; i < 80 && !target; i++) {
        try {
          target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((x) => x.type === "page" && x.webSocketDebuggerUrl);
        } catch {}
        if (!target) await sleep(250);
      }
      if (!target) throw new Error("Edge CDP 未就绪");
      const cdp = cdpConnect(target.webSocketDebuggerUrl);
      await cdp.ready;
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");
      await sleep(1600);

      const applied = await evaluate(
        cdp,
        `(async () => {
          document.getElementById('open-settings').click();
          document.getElementById('pref-theme').value = 'dark';
          document.getElementById('pref-theme').dispatchEvent(new Event('change'));
          document.getElementById('pref-density').value = 'compact';
          document.getElementById('pref-density').dispatchEvent(new Event('change'));
          document.getElementById('pref-font').value = 'large';
          document.getElementById('pref-font').dispatchEvent(new Event('change'));
          document.getElementById('pref-hints').checked = false;
          document.getElementById('pref-hints').dispatchEvent(new Event('change'));
          await new Promise((r) => setTimeout(r, 200));
          const root = document.documentElement;
          return { theme: root.dataset.theme, density: root.dataset.density, font: root.dataset.font, hints: document.body.dataset.hints, stored: localStorage.getItem('pi-shell.prefs') };
        })()`,
      );
      check(
        "T-21 三种偏好 + 快捷键提示各切一次（DOM 生效 + 落 localStorage）",
        applied.theme === "dark" && applied.density === "compact" && applied.font === "large" && applied.hints === "off" && String(applied.stored).includes("dark"),
        `${applied.theme}/${applied.density}/${applied.font}/hints=${applied.hints}`,
      );
      await shot(cdp, "m2c-settings.png");

      // 刷新后保持（同一 profile 重新加载页面）
      await cdp.send("Page.reload", { ignoreCache: false });
      await sleep(2000);
      const afterReload = await evaluate(cdp, `(() => ({ theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.density, font: document.documentElement.dataset.font }))()`, false);
      check("T-21 刷新后偏好保持", afterReload.theme === "dark" && afterReload.density === "compact" && afterReload.font === "large", `${afterReload.theme}/${afterReload.density}/${afterReload.font}`);

      // localStorage 抛异常：不崩，降级默认 + 提示
      const degrade = await evaluate(
        cdp,
        `(async () => {
          const proto = Object.getPrototypeOf(window.localStorage);
          const origSet = proto.setItem;
          proto.setItem = function () { throw new Error('QuotaExceededError (simulated)'); };
          let threw = false;
          try { window.__piShell.setPreference('theme', 'light'); } catch { threw = true; }
          proto.setItem = origSet;
          await new Promise((r) => setTimeout(r, 200));
          const toastEl = document.getElementById('toast');
          return {
            threw,
            theme: document.documentElement.dataset.theme,
            toast: toastEl.hidden === false ? toastEl.textContent : '',
            rows: window.__piShell.list.model.rows.length,
          };
        })()`,
      );
      check("T-21 localStorage 被禁用：不崩 + 降级提示 + 页面仍可用", !degrade.threw && /localStorage/.test(degrade.toast) && degrade.rows > 0, `theme=${degrade.theme} rows=${degrade.rows}`);
      cdp.close();
    }
  } catch (err) {
    check("运行异常", false, err.message);
  } finally {
    try {
      edge?.kill("SIGKILL");
    } catch {}
    kill(bridge.pid);
    await sleep(2500);
    check("收尾：无残留 bridge / pi 进程", portPid(PORT) === null, "");
    await fsp.writeFile(path.join(OUT, "bridge.log"), logs.join("\n"));
    const failed = results.filter((r) => !r.pass);
    await fsp.writeFile(path.join(OUT, "summary.txt"), results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`).join("\n") + "\n");
    console.log(`\n${results.length - failed.length}/${results.length} PASS；产出：${OUT}`);
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
