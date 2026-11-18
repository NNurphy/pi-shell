#!/usr/bin/env node
// 模型配置的唯一来源 + 可用性自检。
//   node scripts/model-config.mjs            # 打印 "provider/model"（供脚本消费）
//   node scripts/model-config.mjs --flags    # 打印 "--provider X --model Y"
//   node scripts/model-check.mjs             # 真发一条最小请求验证可用（另见该脚本）
// 优先级：环境变量 PI_SHELL_PROVIDER/PI_SHELL_MODEL > scripts/model.json
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const CONFIG_FILE = path.join(ROOT, "scripts", "model.json");

/**
 * 解析优先级（越靠前越强）：
 *   1. PI_SHELL_PROVIDER / PI_SHELL_MODEL —— 显式覆盖（测试/临时）
 *   2. PI_PROVIDER / PI_MODEL —— **当前会话顶部栏选的模型**（pi 在模型切换后会更新工具子进程的环境变量，
 *      所以用户在网页里切模型后，后续新起的子进程自动继承，不需要人工同步）
 *   3. scripts/model.json —— 兜底（会话没有模型信息时用，例如计划任务/裸终端）
 */
export function readModelConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { file = {}; }

  const pick = (explicitEnv, sessionEnv, fileValue) => {
    if (process.env[explicitEnv]) return [process.env[explicitEnv], "env:explicit"];
    if (process.env[sessionEnv]) return [process.env[sessionEnv], "env:session"];
    if (fileValue) return [fileValue, "scripts/model.json"];
    return ["", "none"];
  };

  const [provider, pSrc] = pick("PI_SHELL_PROVIDER", "PI_PROVIDER", file.provider);
  const [model, mSrc] = pick("PI_SHELL_MODEL", "PI_MODEL", file.model);
  return { provider, model, source: pSrc === mSrc ? pSrc : `${pSrc}+${mSrc}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const { provider, model } = readModelConfig();
  if (process.argv.includes("--source")) {
    process.stdout.write(readModelConfig().source);
  } else if (process.argv.includes("--flags")) {
    const flags = [];
    if (provider) flags.push("--provider", provider);
    if (model) flags.push("--model", model);
    process.stdout.write(flags.join(" "));
  } else {
    process.stdout.write(provider && model ? `${provider}/${model}` : "");
  }
}