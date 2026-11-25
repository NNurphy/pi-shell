#!/usr/bin/env node
// 图标生成 v2（2026-11-25 重做，按实测反馈）：
//   v1 问题：① 256px 条目渲染坏（内容只占右侧 40%，桌面大图标只见半个 π；16/32/48 正常）
//             —— Edge headless 逐尺寸截图在部分尺寸不稳定；
//            ② 素线 favicon 直接当桌面图标太单薄。
//   v2 方案：圆角底板（品牌色，自含对比度）+ 加粗 π 骨架（几何同 web/favicon.svg）；
//            只在 1024×1024 渲染一次 → PowerShell System.Drawing 高质量双三次降采样
//            16/32/48/256 → PNG-in-ICO；对 1024 原图做像素级自检（边距对称/两条竖腿/
//            底板覆盖率），不过重试一次，再不过退出非零——坏资产不落盘。
//
// 产物：web/icons/pi-shell.ico（rust 底 #A8461C + cream π，通用）
//       web/icons/pi-shell-on-dark.ico（近黑底 #201913 + 橙 π #E3995F，深色任务栏）
// 用法：node scripts/make-icon.mjs（幂等，按内容覆盖写）；EDGE_PATH 可指定 msedge。

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO_ROOT, "web", "icons");
const RENDER_SIZE = 1024;
const SIZES = [16, 32, 48, 256];
const VARIANTS = [
  { name: "pi-shell", plate: "#A8461C", mark: "#F6E9DC", desc: "通用变体（rust 底 + cream π）" },
  { name: "pi-shell-on-dark", plate: "#201913", mark: "#E3995F", desc: "深色任务栏变体（近黑底 + 橙 π）" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  return [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => fs.existsSync(p)) || null;
}

// ---- π 骨架几何（与 web/favicon.svg 同一 paths，笔画 1.8 → 2.9，整体放大 6%）----
function markSvg(markColor) {
  return `<g transform="translate(10 10) scale(1.06) translate(-10 -10)">
    <g fill="none" stroke="${markColor}" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3.75 5.5h12.5"/>
      <path d="M7.25 5.5v10.75"/>
      <path d="M12.75 5.5v10.75"/>
      <path d="M7.25 16.25h-3.5"/>
      <path d="M12.75 16.25h3.5"/>
    </g>
  </g>`;
}

function iconSvg(v) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
  <rect x="0.9" y="0.9" width="18.2" height="18.2" rx="4.6" fill="${v.plate}"/>
  ${markSvg(v.mark)}
</svg>`;
}

// ---- PNG-in-ICO（Vista+）：6B 头 + count×16B 目录 + PNG 数据段 ----
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const parts = [header];
  for (const { size, png } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12);
    parts.push(entry); offset += png.length;
  }
  for (const { png } of pngs) parts.push(png);
  return Buffer.concat(parts);
}

// ---- PNG 解码（RGBA8）+ alpha 分析（自检用）----
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === "IDAT") idats.push(data);
    pos += 12 + len;
    if (type === "IEND") break;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`PNG 非预期格式 depth=${bitDepth} color=${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const bpp = 4, stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
  }
  return { w, h, px, bpp, stride };
}

// 自检：底板边距对称 + 覆盖率（alpha）+ 两条竖腿/顶横笔（标记色像素，与底板色距>60）
// v1 的 256 坏图（内容偏移/裁切）会在此炸掉。
function selfCheck(png, label) {
  const { w, h, px, bpp, stride } = decodePng(png);
  let minX = w, minY = h, maxX = -1, maxY = -1, cover = 0;
  const solid = (x, y) => px[y * stride + x * bpp + 3] > 32;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!solid(x, y)) continue;
    cover++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const L = minX / w, R = (w - 1 - maxX) / w, T = minY / h, B = (h - 1 - maxY) / h;
  // 底色采样：腿间空隙、脚以下、底板内（脚底≈88.5%，板底≈95.5%，取 92%）
  const sy = Math.round(h * 0.92), sx = Math.round(w * 0.5);
  const so = sy * stride + sx * bpp;
  if (px[so + 3] <= 32) throw new Error(`${label} 底色采样点落在透明区（请调采样点）`);
  const plate = [px[so], px[so + 1], px[so + 2]];
  const isMark = (x, y) => {
    const o = y * stride + x * bpp;
    if (px[o + 3] <= 32) return false;
    return Math.abs(px[o] - plate[0]) + Math.abs(px[o + 1] - plate[1]) + Math.abs(px[o + 2] - plate[2]) > 60;
  };
  const run = (y, pred) => { const runs = []; let s = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && pred(x, y);
      if (on && s < 0) s = x;
      if (!on && s >= 0) { runs.push([s, x - 1]); s = -1; }
    } return runs; };
  const legs = run(Math.round(h * 0.62), isMark);
  const bar = run(Math.round(h * 0.30), isMark);
  const problems = [];
  if (Math.abs(L - R) > 0.02 || Math.abs(T - B) > 0.02) problems.push(`边距不对称 L=${L.toFixed(3)} R=${R.toFixed(3)} T=${T.toFixed(3)} B=${B.toFixed(3)}`);
  if (cover / (w * h) < 0.55 || cover / (w * h) > 0.95) problems.push(`覆盖率异常 ${(cover / w / h * 100).toFixed(1)}%`);
  if (legs.length !== 2) problems.push(`62% 行应有两条竖腿，实得 ${legs.length} 段`);
  if (bar.length !== 1 || (bar[0][1] - bar[0][0] + 1) / w < 0.5) problems.push(`30% 行顶横笔异常 ${JSON.stringify(bar)}`);
  if (problems.length) throw new Error(`${label} 自检失败：${problems.join("；")}`);
  return { cover: (cover / w / h * 100).toFixed(1), legs: legs.map(([a, b]) => `${a}-${b}`).join(","), bar: `${bar[0][0]}-${bar[0][1]}`, margin: `${L.toFixed(3)}/${R.toFixed(3)}/${T.toFixed(3)}/${B.toFixed(3)}` };
}

async function render(edgePath, svg, outPng, profileDir) {
  const tmp = path.dirname(outPng);
  const htmlFile = path.join(tmp, "page.html");
  await fsp.writeFile(htmlFile, `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{width:100vw;height:100vh;display:block}
</style>${svg}\n`, "utf8");
  fs.rmSync(outPng, { force: true });
  const edge = spawn(edgePath, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    `--window-size=${RENDER_SIZE},${RENDER_SIZE}`,
    `--screenshot=${outPng}`,
    "--virtual-time-budget=4000",
    `--user-data-dir=${profileDir}`,
    "file:///" + htmlFile.replaceAll("\\", "/"),
  ], { stdio: "ignore" });
  const code = await new Promise((resolve) => {
    edge.on("exit", (c) => resolve(c));
    edge.on("error", (e) => fail(`Edge 启动失败：${e.message}`));
    sleep(30000).then(() => { try { edge.kill(); } catch {} resolve(-9); });
  });
  if (code !== 0) fail(`Edge 截图退出码 ${code}`);
  const png = fs.readFileSync(outPng);
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail("截图不是 PNG");
  const { width, height } = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  if (width !== RENDER_SIZE || height !== RENDER_SIZE) fail(`截图尺寸 ${width}×${height} ≠ ${RENDER_SIZE}`);
  return png;
}

// PowerShell System.Drawing 高质量降采样（1024 → 16/32/48/256）
async function downscale(srcPng, tmp, tag) {
  const ps1 = path.join(tmp, `downscale-${tag}.ps1`);
  const lines = [
    "Add-Type -AssemblyName System.Drawing",
    `$src = [System.Drawing.Bitmap]::FromFile('${srcPng.replaceAll("\\", "\\\\")}')`,
  ];
  for (const s of SIZES) {
    const out = path.join(tmp, `${tag}-${s}.png`).replaceAll("\\", "\\\\");
    lines.push(
      `$bmp = New-Object System.Drawing.Bitmap(${s}, ${s})`,
      `$g = [System.Drawing.Graphics]::FromImage($bmp)`,
      "$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
      "$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias",
      "$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality",
      `$g.DrawImage($src, 0, 0, ${s}, ${s})`,
      `$bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      "$g.Dispose(); $bmp.Dispose()",
    );
  }
  lines.push("$src.Dispose()");
  await fsp.writeFile(ps1, lines.join("\n"), "utf8");
  await new Promise((resolve, reject) => {
    const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { stdio: "ignore" });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`降采样退出码 ${c}`))));
    p.on("error", reject);
  });
  return SIZES.map((s) => ({ size: s, png: fs.readFileSync(path.join(tmp, `${tag}-${s}.png`)) }));
}

async function main() {
  const edgePath = findEdge();
  if (!edgePath) fail("找不到 msedge.exe（可用 EDGE_PATH 指定）");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-icon2-"));
  const profileDir = path.join(tmp, "edge-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  try {
    for (const v of VARIANTS) {
      const srcPng = path.join(tmp, `${v.name}-1024.png`);
      // 渲染 1024 + 自检 + 一次重试
      let check;
      let png;
      for (let attempt = 1; attempt <= 2; attempt++) {
        png = await render(edgePath, iconSvg(v), srcPng, profileDir);
        try { check = selfCheck(png, `${v.name}@${RENDER_SIZE}`); break; }
        catch (e) {
          console.error(`WARN  第 ${attempt} 次渲染自检未过：${e.message}`);
          if (attempt === 2) fail(`${v.name} 两次渲染自检均未过，中止（不写坏资产）`);
        }
      }
      const pngs = await downscale(srcPng, tmp, v.name);
      for (const { size, png: p } of pngs) {
        if (p.readUInt32BE(16) !== size || p.readUInt32BE(20) !== size) fail(`降采样尺寸不对（${size}）`);
      }
      const ico = buildIco(pngs);
      const icoPath = path.join(OUT_DIR, `${v.name}.ico`);
      await fsp.mkdir(OUT_DIR, { recursive: true });
      await fsp.writeFile(icoPath, ico);
      const kb = (ico.length / 1024).toFixed(1);
      console.log(`PASS  ${v.name}.ico — ${v.desc}：${SIZES.join("/")}，${kb} KB`);
      console.log(`      自检：cover=${check.cover}% legs=${check.legs} bar=${check.bar} 边距=${check.margin}（${RENDER_SIZE}px 原图）`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("DONE  两个 .ico 已写入 web/icons/（v2：底板+加粗 π，1024 单渲 + 降采样 + 自检）");
}

main();
