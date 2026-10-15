const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const d = require("./definitions.cjs");

const url = { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer abc" } };
const cmd = { name: "pencil", type: "stdio", command: "pencil", args: ["mcp", "--stdio"], env: { TOKEN: "t" } };

test("converts to each provider's shape", () => {
  assert.deepEqual(d.toClaudeConfig(url), { type: "http", url: url.url, headers: url.headers });
  assert.deepEqual(d.toClaudeConfig(cmd), { type: "stdio", command: "pencil", args: ["mcp", "--stdio"], env: { TOKEN: "t" } });
  assert.deepEqual(d.toCodexConfig(url), { url: url.url, http_headers: url.headers });
  assert.deepEqual(d.toCodexConfig({ ...cmd, env: {} }), { command: "pencil", args: ["mcp", "--stdio"] });
  assert.deepEqual(d.toAcpServer(url), { type: "http", name: "linear", url: url.url, headers: [{ name: "Authorization", value: "Bearer abc" }] });
  assert.deepEqual(d.toAcpServer(cmd), { name: "pencil", command: "pencil", args: ["mcp", "--stdio"], env: [{ name: "TOKEN", value: "t" }] });
});

test("reads back from provider configs", () => {
  assert.deepEqual(d.fromClaudeConfig("linear", { type: "http", url: url.url, headers: url.headers }), url);
  assert.deepEqual(d.fromClaudeConfig("pencil", { command: "pencil", args: ["mcp", "--stdio"], env: { TOKEN: "t" } }), cmd);
  assert.deepEqual(d.fromCodexConfig("linear", { url: url.url, http_headers: url.headers }), url);
  assert.equal(d.fromClaudeConfig("x", { type: "claudeai-proxy" }), null);
});

test("masking hides values and unmasking keeps untouched ones", () => {
  const masked = d.maskDefinition(url);
  assert.deepEqual(masked.headers, { Authorization: "••••••" });
  assert.deepEqual(d.unmaskDefinition(masked, url).headers, { Authorization: "Bearer abc" });
  assert.deepEqual(d.unmaskDefinition({ ...masked, headers: { Authorization: "Bearer new" } }, url).headers, { Authorization: "Bearer new" });
  assert.deepEqual(d.unmaskDefinition({ ...masked, headers: { "X-New": "••••••" } }, url).headers, {}, "a masked value with no stored value is dropped");
  assert.deepEqual(d.maskDefinition(cmd).env, { TOKEN: "••••••" });
});

test("reads server names from Claude and Codex configs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mcp-names-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: { pencil: {}, linear: {} } }));
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    '[mcp_servers.pencil]\ncommand = "p"\n\n[mcp_servers."my-x"]\nurl = "u"\n[mcp_servers.pencil.env]\nA = "1"\n',
  );
  assert.deepEqual([...d.claudeConfigNames(path.join(dir, ".claude.json"))].sort(), ["linear", "pencil"]);
  assert.deepEqual([...d.codexConfigNames(path.join(dir, "config.toml"))].sort(), ["my-x", "pencil"]);
  assert.equal(d.claudeConfigNames(path.join(dir, "missing.json")).size, 0);
});

test("detail is the URL or the command line", () => {
  assert.equal(d.detailOf(url), url.url);
  assert.equal(d.detailOf(cmd), "pencil mcp --stdio");
});
