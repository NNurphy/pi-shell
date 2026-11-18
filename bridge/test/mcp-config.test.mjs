// MCP 按需：pi-shell-mcp.json 解析 + cwd 规则 + 临时 agentDir（shim）构建
// 只碰临时目录，不读真实 mcp.json、不起 pi 进程。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SHELL_MCP_CONFIG_FILE,
  createMcpShim,
  emptyShellMcpConfig,
  globToRegExp,
  listAvailableServers,
  matchGlob,
  loadShellMcpConfig,
  matchRule,
  resolveMcpServers,
  shellMcpConfigPath,
  validateShellMcpConfig,
  writeShellMcpConfig,
} from "../src/mcp-config.mjs";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pish-mcp-${tag}-`));
}

/** 造一个假 agentDir：mcp.json + settings.json + skills/ 目录 */
function fakeAgentDir(tag, mcpServers = {}) {
  const dir = tmpDir(tag);
  fs.writeFileSync(
    path.join(dir, "mcp.json"),
    JSON.stringify(
      {
        mcpServers:
          Object.keys(mcpServers).length > 0
            ? mcpServers
            : {
                codegraph: { command: "codegraph", args: ["serve", "--mcp"], description: "代码图谱" },
                "mcp-obsidian": { command: "npx", args: ["uvx", "mcp-obsidian"], description: "Obsidian 桥" },
                bilibili: { command: "python", args: ["s.py"], enabled: false, description: "休眠" },
              },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "settings.json"), '{"theme":"dark"}\n', "utf8");
  fs.mkdirSync(path.join(dir, "skills"));
  fs.writeFileSync(path.join(dir, "skills", "demo.md"), "# demo\n", "utf8");
  return dir;
}

test("空配置：文件不存在 → 全默认空（不带 MCP）", () => {
  const dir = tmpDir("empty");
  const file = path.join(dir, SHELL_MCP_CONFIG_FILE);
  const loaded = loadShellMcpConfig(file);
  assert.equal(loaded.exists, false);
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.config, emptyShellMcpConfig());
  // 显式给空 env：test-gate 会注入 PI_SHELL_MCP_CONFIG（测试桥一律空配置），不能让它污染断言
  assert.equal(shellMcpConfigPath(dir, {}), file);
  assert.equal(shellMcpConfigPath(dir, { PI_SHELL_MCP_CONFIG: "C:/tmp/x.json" }), path.resolve("C:/tmp/x.json"));
});

test("validate：default/rules 形状校验；servers 段原样保留；非法名拒绝", () => {
  assert.equal(validateShellMcpConfig(null).ok, false);
  assert.equal(validateShellMcpConfig({ default: "codegraph" }).ok, false);
  assert.equal(validateShellMcpConfig({ default: ["bad name"] }).ok, false);
  assert.equal(validateShellMcpConfig({ rules: {} }).ok, false);
  assert.equal(validateShellMcpConfig({ rules: [{ servers: [] }] }).ok, false);
  assert.equal(validateShellMcpConfig({ rules: [{ cwd: "C:/x", servers: ["a b"] }] }).ok, false);

  const ok = validateShellMcpConfig({
    default: ["codegraph", "codegraph"],
    rules: [{ cwd: "C:\\Docs\\my-wiki*", servers: ["mcp-obsidian"] }],
    servers: { codegraph: { command: "x" } },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.config.default, ["codegraph"]); // 去重
  assert.deepEqual(ok.config.rules, [{ cwd: "C:\\Docs\\my-wiki*", servers: ["mcp-obsidian"] }]);
  assert.deepEqual(ok.config.servers, { codegraph: { command: "x" } });
});

test("读写：原子写 + 读回一致；坏 JSON → 空配置 + error", () => {
  const dir = tmpDir("rw");
  const file = path.join(dir, SHELL_MCP_CONFIG_FILE);
  const written = writeShellMcpConfig(file, {
    default: ["codegraph"],
    rules: [{ cwd: "C:\\Code\\my-app*", servers: ["codegraph"] }],
  });
  assert.deepEqual(loadShellMcpConfig(file).config, written);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0); // 没有残留临时文件

  fs.writeFileSync(file, "{oops", "utf8");
  const broken = loadShellMcpConfig(file);
  assert.deepEqual(broken.config, emptyShellMcpConfig());
  assert.match(broken.error, /JSON/);
});

test("cwd 通配：大小写不敏感、反斜杠归一、* 匹配任意后缀", () => {
  assert.equal(matchGlob("C:\\Code\\my-app*", "C:\\Code\\my-app"), true);
  assert.equal(matchGlob("C:\\Code\\my-app*", "C:/Code/my-app-v2"), true);
  assert.equal(matchGlob("C:\\Code\\my-app*", "c:\\code\\MY-APP"), true);
  assert.equal(matchGlob("C:\\Code\\my-app*", "C:\\Code\\other"), false);
  assert.equal(matchGlob("C:\\Docs\\my-wiki*", "C:\\Docs\\my-wiki\\notes"), true);
  assert.equal(matchGlob("C:\\Docs\\my-wiki?", "C:\\Docs\\my-wiki1"), true);
  // 正则特殊字符按字面量处理（不能让 . 变成通配）
  assert.equal(globToRegExp("C:/a.b").test("C:/axb"), false);
  assert.equal(globToRegExp("C:/a.b").test("C:/a.b"), true);
});

test("规则解析：override > rule > default；命中空数组 = 明确不带", () => {
  const config = {
    default: ["codegraph"],
    rules: [
      { cwd: "C:\\Docs\\my-wiki*", servers: ["mcp-obsidian"] },
      { cwd: "C:\\Docs\\my-wiki\\notes*", servers: [] }, // 更具体但排后面 → 不生效（首条命中）
    ],
  };
  assert.deepEqual(resolveMcpServers({ cwd: "C:\\Docs\\my-wiki\\notes", config }), {
    servers: ["mcp-obsidian"],
    source: "rule",
  });
  assert.deepEqual(resolveMcpServers({ cwd: "C:\\Other", config }), { servers: ["codegraph"], source: "default" });
  assert.deepEqual(resolveMcpServers({ cwd: "C:\\Other", config, override: [] }), { servers: [], source: "override" });
  assert.equal(matchRule("C:\\Other", config.rules), null);
  assert.deepEqual(resolveMcpServers({ cwd: "C:\\X" }), { servers: [], source: "default" });
});

test("listAvailableServers：读出 mcp.json 的名称/描述/休眠标记", () => {
  const agentDir = fakeAgentDir("list");
  const { servers, error } = listAvailableServers(agentDir);
  assert.equal(error, null);
  assert.deepEqual(
    servers.map((s) => [s.name, s.enabledByDefault, s.description]),
    [
      ["codegraph", true, "代码图谱"],
      ["mcp-obsidian", true, "Obsidian 桥"],
      ["bilibili", false, "休眠"],
    ],
  );
  const missing = listAvailableServers(path.join(agentDir, "nope"));
  assert.deepEqual(missing.servers, []);
});

test("createMcpShim：只装选中的 server；其余 agentDir 内容 junction/拷贝；cleanup 不伤原目录", () => {
  const agentDir = fakeAgentDir("shim");
  const shim = createMcpShim({ agentDir, servers: ["codegraph", "mcp-obsidian"], client: "default#c1" });
  try {
    assert.deepEqual(shim.servers, ["codegraph", "mcp-obsidian"]);

    const generated = JSON.parse(fs.readFileSync(path.join(shim.dir, "mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(generated.mcpServers), ["codegraph", "mcp-obsidian"]);
    assert.equal(generated.mcpServers.codegraph.command, "codegraph");

    // settings.json 拷过来了，skills/ 链过来了
    assert.equal(fs.readFileSync(path.join(shim.dir, "settings.json"), "utf8"), '{"theme":"dark"}\n');
    assert.equal(fs.readFileSync(path.join(shim.dir, "skills", "demo.md"), "utf8"), "# demo\n");
  } finally {
    shim.cleanup();
  }
  assert.equal(fs.existsSync(shim.dir), false);
  // 原目录完好（cleanup 只删链接，不进目标）
  assert.equal(fs.existsSync(path.join(agentDir, "skills", "demo.md")), true);
  assert.equal(fs.existsSync(path.join(agentDir, "mcp.json")), true);
});

test("createMcpShim：选中文件里 enabled:false 的 server 会变成启用（按需打开休眠项）", () => {
  const agentDir = fakeAgentDir("enable");
  const shim = createMcpShim({ agentDir, servers: ["bilibili"], client: "c1" });
  try {
    const generated = JSON.parse(fs.readFileSync(path.join(shim.dir, "mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(generated.mcpServers), ["bilibili"]);
    assert.equal(generated.mcpServers.bilibili.enabled, undefined);
  } finally {
    shim.cleanup();
  }
});

test("createMcpShim：未知 server 名被丢掉（不报错，只 warn）", () => {
  const agentDir = fakeAgentDir("unknown");
  const warns = [];
  const shim = createMcpShim({
    agentDir,
    servers: ["codegraph", "nope"],
    client: "c1",
    log: (level, event, fields) => warns.push([level, event, fields]),
  });
  try {
    assert.deepEqual(shim.servers, ["codegraph"]);
    assert.equal(warns[0][1], "mcp_shim_unknown_server");
    assert.deepEqual(warns[0][2].unknown, ["nope"]);
  } finally {
    shim.cleanup();
  }
});
