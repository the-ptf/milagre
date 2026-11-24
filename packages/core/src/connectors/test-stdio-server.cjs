// A stdio MCP server for connector tests: counts its starts in a file and echoes an environment variable.
const fs = require("node:fs");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const [counter, mode] = process.argv.slice(2);
if (mode === "fail") {
  process.stderr.write("paper: no license key found\n");
  process.exit(1);
}
fs.appendFileSync(counter, "start\n");
const server = new Server({ name: "stdio-fake", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: "whoami", description: "Says the configured user", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
}));
server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: `user=${process.env.FAKE_USER ?? ""}` }] }));
void server.connect(new StdioServerTransport());
