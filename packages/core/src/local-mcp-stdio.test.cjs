const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { createLocalMcpServer } = require("./local-mcp-server.cjs");

test("Claude Desktop stdio connects only to the existing loopback host and never logs its credential", async (t) => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  const token = "s".repeat(43);
  const server = createLocalMcpServer({
    authenticate: (value) => (value === token ? { id: "desktop" } : null),
    toolsFor: () => [{ name: "design_list", description: "List designs", input: {}, readOnly: true, run: () => "[]" }],
  });
  t.after(() => server.close());
  const client = new Client({ name: "desktop-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "local-mcp-stdio.cjs")],
    env: { MILAGRE_MCP_URL: await server.listen(), MILAGRE_MCP_TOKEN: token },
    stderr: "pipe",
  });
  let log = "";
  transport.stderr?.on("data", (c) => (log += c));
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["design_list"],
  );
  assert.equal((await client.callTool({ name: "design_list", arguments: {} })).content[0].text, "[]");
  assert.ok(!log.includes(token));
});

test("the stdio adapter refuses a network URL without making a connection", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "local-mcp-stdio.cjs")], {
    env: { MILAGRE_MCP_URL: "https://example.invalid/mcp", MILAGRE_MCP_TOKEN: "s".repeat(43) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(output, /loopback/);
  assert.ok(!output.includes("s".repeat(43)));
});
