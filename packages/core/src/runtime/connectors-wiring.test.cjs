const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConnectorsWiring } = require("./connectors-wiring.cjs");
const { createMcpStore } = require("../mcp/store.cjs");
const { startFakeMcp } = require("../connectors/test-helpers.cjs");

test("an Everywhere URL server moves to Connectors with its headers", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "connectors-wiring-"));
  const server = await startFakeMcp({ requireAuth: false, apiKey: "k-9" });
  const handlers = new Map();
  const mcpStore = createMcpStore(path.join(dataDir, "mcp.json"));
  mcpStore.setEverywhere([
    { name: "docs", type: "http", url: server.url, headers: { "X-Api-Key": "k-9" } },
    { name: "local", type: "stdio", command: "run", args: [], env: {} },
  ]);
  const removed = [];
  const connectors = createConnectorsWiring({
    options: { connectors: { port: 0 } },
    dataDir,
    emit: () => {},
    version: "0",
    commands: { handle: (name, run) => handlers.set(name, run) },
    mcpStore,
    mcp: {
      remove: async (name, target) => {
        removed.push([name, target]);
        mcpStore.setEverywhere(mcpStore.read().everywhere.filter((def) => def.name !== name));
      },
    },
  });
  t.after(async () => {
    await connectors.dispose();
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  assert.deepEqual(await handlers.get("connectors:movable")(), [{ name: "docs", url: server.url }]);
  const moved = await handlers.get("connectors:move")(null, "docs");
  assert.equal(moved.state, "connected");
  assert.deepEqual(moved.headers, ["X-Api-Key"]);
  assert.deepEqual(removed, [["docs", "everywhere"]]);
  assert.deepEqual(await handlers.get("connectors:movable")(), []);
  await assert.rejects(handlers.get("connectors:move")(null, "local"), /isn't an Everywhere server/);
});
