#!/usr/bin/env node
// favicon.svg → 两个 .ico 桌面图标（浅色 / 深色背景变体）
//
// 流程（零 npm 依赖）：
//   1. 读 web/favicon.svg（20×20 viewBox，stroke: currentColor，<style> 内亮/暗两色）
//   2. 把 <style> 块替换成固定色（不依赖系统配色），写临时 SVG 变体
//   3. 临时 HTML 包装，SVG 以 width:100vw;height:100vh 铺满视口（不直接截 SVG 文件——
//      固定 20×20 会贴在角落）
//   4. Edge headless 逐尺寸截图：--window-size=N,N --default-background-color=00000000（透明底）
//   5. PNG-in-ICO 手工拼装（Vista+ 原生支持）：
//      6 字节头（reserved=0, type=1, count=4）+ 16 字节/条目目录 + PNG 数据段
//
// 产物：web/icons/pi-shell.ico（#a8461c）与 web/icons/pi-shell-on-dark.ico（#e3995f），
//       各含 16/32/48/256 四尺寸。重跑幂等（按内容覆盖写）。
//
// 用法：node scripts/make-icon.mjs
// 环境变量：EDGE_PATH 指定 msedge.exe（可选）
// 退出码：0 = 两个 .ico 生成且自检通过

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SVG_PATH = path.join(REPO_ROOT, "web", "favicon.svg");
const OUT_DIR = path.join(REPO_ROOT, "web", "icons");
const SIZES = [16, 32, 48, 256];
const VARIANTS = [
  { name: "pi-shell", color: "#a8461c", desc: "浅色变体（亮背景桌面）" },
  { name: "pi-shell-on-dark", color: "#e3995f", desc: "深色背景变体" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  return [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => fs.existsSync(p)) || null;
}

// PNG-in-ICO：6 字节头 + count×16 字节目录 + PNG 数据段（宽高各 1 字节，256 写 0）
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1（icon）
  header.writeUInt16LE(pngs.length, 4); // count
  let offset = 6 + 16 * pngs.length;
  const parts = [header];
  for (const { size, png } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width（256 用 0 表示）
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0; // colorCount（不带调色板）
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bitCount
    entry.writeUInt32LE(png.length, 8); // bytesInRes
    entry.writeUInt32LE(offset, 12); // imageOffset（相对文件头）
    parts.push(entry);
    offset += png.length;
  }
  for (const { png } of pngs) parts.push(png);
  return Buffer.concat(parts);
}

function pngSize(buf) {
  // PNG 签名 8B + 4B 长度 + 4B "IHDR" → 宽高各 4B（BE）
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function shoot(edgePath, url, outPng, size, profileDir) {
  fs.rmSync(outPng, { force: true });
  const edge = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000", // 透明底
    `--window-size=${size},${size}`,
    `--screenshot=${outPng}`,
    `--user-data-dir=${profileDir}`,
    url,
  ], { stdio: "ignore" });
  const code = await new Promise((resolve) => {
    edge.on("exit", (c) => resolve(c));
    edge.on("error", (e) => fail(`Edge 启动失败：${e.message}`));
    sleep(30000).then(() => { try { edge.kill(); } catch {} resolve(-9); });
  });
  if (code !== 0) fail(`Edge 截图退出码 ${code}（size=${size}）`);
  const png = fs.readFileSync(outPng);
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail(`截图不是 PNG（size=${size}）`);
  const { width, height } = pngSize(png);
  if (width !== size || height !== size) fail(`截图尺寸 ${width}×${height} ≠ 期望 ${size}×${size}（DPR 缩放？）`);
  return png;
}

function fileUrl(p) {
  return "file:///" + p.replaceAll("\\", "/");
}

async function main() {
  const edgePath = findEdge();
  if (!edgePath) fail("找不到 msedge.exe（可用 EDGE_PATH 指定）");
  const svgText = await fsp.readFile(SVG_PATH, "utf8");
  if (!/<style>[\s\S]*?<\/style>/.test(svgText)) fail("favicon.svg 无 <style> 块，结构已变？");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-icon-"));
  const profileDir = path.join(tmp, "edge-profile");
  fs.mkdirSync(profileDir, { recursive: true });

  try {
    for (const v of VARIANTS) {
      // 1) 固定色变体：替换 <style> 块（亮/暗二选一，不依赖系统配色）
      const fixedSvg = svgText.replace(
        /<style>[\s\S]*?<\/style>/,
        `<style>svg { color: ${v.color}; }</style>`
      );
      const svgFile = path.join(tmp, `${v.name}.svg`);
      await fsp.writeFile(svgFile, fixedSvg, "utf8");
      // 2) HTML 包装：SVG 铺满视口（CSS width/height 覆盖 20×20 属性），透明底
      const htmlFile = path.join(tmp, `${v.name}.html`);
      await fsp.writeFile(htmlFile, `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{width:100vw;height:100vh;display:block}
</style>${fixedSvg}\n`, "utf8");
      // 3) 逐尺寸截图 → 4) 拼 ICO
      const pngs = [];
      for (const size of SIZES) {
        const outPng = path.join(tmp, `${v.name}-${size}.png`);
        const png = await shoot(edgePath, fileUrl(htmlFile), outPng, size, profileDir);
        pngs.push({ size, png });
      }
      const ico = buildIco(pngs);
      const icoPath = path.join(OUT_DIR, `${v.name}.ico`);
      await fsp.mkdir(OUT_DIR, { recursive: true });
      await fsp.writeFile(icoPath, ico);
      const kb = (ico.length / 1024).toFixed(1);
      console.log(`PASS  ${v.name}.ico — ${v.desc}（${v.color}）：${SIZES.join("/")} 四尺寸，${kb} KB`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("DONE  两个 .ico 已写入 web/icons/");
}

main();
