const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConnectorsWiring } = require("./connectors-wiring.cjs");
const { createMcpStore } = require("../mcp/store.cjs");
const { startFakeMcp } = require("../connectors/test-helpers.cjs");

const STDIO = path.join(__dirname, "..", "connectors", "test-stdio-server.cjs");

async function wiring(t, { everywhere = () => [], off = {}, moveEverywhere, linear } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "connectors-wiring-"));
  const handlers = new Map();
  const events = [];
  const mcpStore = createMcpStore(path.join(dataDir, "mcp.json"));
  mcpStore.setEverywhere(everywhere(dataDir));
  for (const [key, names] of Object.entries(off)) for (const name of names) mcpStore.setOff(...key.split(":"), name, true);
  const removed = [];
  const wired = createConnectorsWiring({
    options: { connectors: { port: 0, idleMs: 20, ...(moveEverywhere === false ? { moveEverywhere } : {}) } },
    dataDir,
    emit: (channel, payload) => events.push([channel, payload]),
    version: "0",
    commands: { handle: (name, run) => handlers.set(name, run) },
    mcpStore,
    mcp: {
      remove: async (name, target) => {
        removed.push([name, target]);
        mcpStore.setEverywhere(mcpStore.read().everywhere.filter((def) => def.name !== name));
      },
    },
    ...(linear ? { linear, linearTools: {} } : {}),
  });
  const { connectors } = wired;
  t.after(async () => {
    await wired.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, handlers, events, removed, connectors, mcpStore, wired };
}

test("an Everywhere URL server moves to Connectors with its headers when asked", async (t) => {
  const server = await startFakeMcp({ requireAuth: false, apiKey: "k-9" });
  t.after(() => server.close());
  const { handlers, removed } = await wiring(t, {
    moveEverywhere: false,
    everywhere: () => [
      { name: "docs", type: "http", url: server.url, headers: { "X-Api-Key": "k-9" } },
      { name: "old", type: "sse", url: "https://example.com/sse", headers: {} },
    ],
  });
  assert.deepEqual(await handlers.get("connectors:movable")(), [{ name: "docs", url: server.url }]);
  const moved = await handlers.get("connectors:move")(null, "docs");
  assert.equal(moved.state, "connected");
  assert.deepEqual(moved.headers, ["X-Api-Key"]);
  assert.deepEqual(removed, [["docs", "everywhere"]]);
  assert.deepEqual(await handlers.get("connectors:movable")(), []);
  await assert.rejects(handlers.get("connectors:move")(null, "old"), /can move/);
});

test("on start every Everywhere server moves, keeping the Accounts it was off for, and leaves a note", async (t) => {
  const server = await startFakeMcp({ requireAuth: false });
  t.after(() => server.close());
  const { handlers, removed, connectors } = await wiring(t, {
    everywhere: (dataDir) => [
      { name: "docs", type: "http", url: server.url, headers: {} },
      { name: "paper", type: "stdio", command: process.execPath, args: [STDIO, path.join(dataDir, "starts.txt")], env: { FAKE_USER: "u-1" } },
    ],
    off: { "codex:work": ["paper"] },
  });
  while ((await handlers.get("connectors:moved")()).length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual((await handlers.get("connectors:moved")()).sort(), ["docs", "paper"]);
  assert.deepEqual(removed.map(([name]) => name).sort(), ["docs", "paper"]);
  const paper = connectors.list().find((item) => item.id === "paper");
  assert.equal(paper.kind, "command");
  assert.deepEqual(paper.env, ["FAKE_USER"]);
  assert.deepEqual(paper.off, ["codex:work"]);
  assert.equal((await connectors.call("paper", "whoami", {})).content[0].text, "user=u-1");
  await handlers.get("connectors:dismiss-moved")();
  assert.deepEqual(await handlers.get("connectors:moved")(), []);
});

test("Milagre's Linear sign-in shows as a Connector whose Available to decides who gets its tools", async (t) => {
  let connected = true;
  const linear = {
    status: () => (connected ? { connected: true, workspaces: [{ id: "acme", organization: { name: "Acme" } }] } : { connected: false }),
    enabled: () => true,
    connect: async () => {
      connected = true;
    },
    disconnect: async () => {
      connected = false;
    },
  };
  const { handlers, wired, events } = await wiring(t, { linear });
  const [entry] = await handlers.get("connectors:list")();
  assert.equal(entry.id, "linear");
  assert.equal(entry.kind, "linear");
  assert.deepEqual(entry.workspaces, ["Acme"]);
  const names = (context) => wired.tools(context).map((tool) => tool.name);
  assert.ok(names({ provider: "codex", accountId: "a" }).includes("linear_issue"));
  await handlers.get("connectors:access")(null, "linear", "codex", "a", false);
  assert.equal(names({ provider: "codex", accountId: "a" }).includes("linear_issue"), false);
  assert.ok(names({ provider: "claude", accountId: "a" }).includes("linear_issue"));
  assert.ok(events.some(([channel, payload]) => channel === "connectors:changed" && payload.connectors[0].off.includes("codex:a")));
  await handlers.get("connectors:sign-out")(null, "linear");
  assert.deepEqual(await handlers.get("connectors:list")(), []);
});
