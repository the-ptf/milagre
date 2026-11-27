const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConnectorsWiring } = require("./connectors-wiring.cjs");
const { createMcpStore } = require("../mcp/store.cjs");
const { startFakeMcp } = require("../connectors/test-helpers.cjs");
const { createLinearIssues } = require("../linear/issues.cjs");

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
    ...(linear ? { linear, linearIssues: createLinearIssues({ linear }), linearTools: {} } : {}),
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

test("Linear workspace access scopes tool listing, lookups and calls from a running Chat", async (t) => {
  let connected = true;
  const workspaces = ["Acme", "Beta"].map((name) => ({ id: name.toLowerCase(), organization: { name } }));
  const queried = [];
  const linear = {
    status: () => ({ connected, workspaces: connected ? workspaces : [] }),
    workspaces: () => (connected ? workspaces : []),
    enabled: () => true,
    query: async (workspace) => {
      queried.push(workspace);
      return {};
    },
    download: async (workspace) => {
      queried.push(workspace);
      throw Object.assign(new Error("File missing"), { code: "not-found" });
    },
    connect: async () => {
      connected = true;
    },
    disconnect: async () => {
      connected = false;
    },
  };
  const { handlers, wired, events, dataDir } = await wiring(t, { linear });
  fs.mkdirSync(path.join(dataDir, "connectors"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, "connectors", "builtin.json"), JSON.stringify({ linear: { off: ["codex:a"] } }), { mode: 0o600 });
  const [entry] = await handlers.get("connectors:list")();
  assert.equal(entry.id, "linear");
  assert.equal(entry.kind, "linear");
  assert.deepEqual(entry.workspaces, ["Acme", "Beta"]);
  assert.deepEqual(
    entry.workspaceAccess.map(({ off }) => off),
    [["codex:a"], ["codex:a"]],
  );
  const codex = { provider: "codex", accountId: "a" };
  const claude = { provider: "claude", accountId: "a" };
  const access = handlers.get("connectors:access");
  const linearTools = (context) => wired.tools(context).filter((tool) => tool.name.startsWith("linear_"));
  assert.deepEqual(
    wired.tools(codex).map((tool) => tool.name),
    ["email_connect"],
  );
  await access(null, "linear", "codex", "a", true, "beta");
  await access(null, "linear", "claude", "a", false, "beta");
  assert.throws(() => access(null, "linear", "codex", "a", true, "missing"), /no longer connected/);
  const codexTools = wired.tools(codex);
  const run = (name, args) => codexTools.find((tool) => tool.name === `linear_${name}`).run(args);
  await assert.rejects(run("issue", { issue: "ENG-12" }), /any connected Linear workspace \(beta\)/);
  assert.deepEqual(queried.splice(0), ["beta"]);
  assert.equal(await run("search", { query: "work" }), "No issues match in beta.");
  assert.deepEqual(queried.splice(0), ["beta"]);
  await assert.rejects(run("file", { url: "https://uploads.linear.app/file.png" }), /\(beta\)/);
  assert.deepEqual(queried.splice(0), ["beta"]);
  const denied = [
    ["issue", { issue: "https://linear.app/acme/issue/ENG-12", workspace: "beta" }],
    ["search", { query: "work", workspace: "acme" }],
    ["file", { url: "https://uploads.linear.app/file.png", workspace: "acme" }],
    ["create_issue", { team: "ENG", title: "Work", workspace: "acme" }],
    ["update_issue", { issue: "ENG-12", title: "Work", workspace: "acme" }],
    ["comment", { issue: "https://linear.app/acme/issue/ENG-12", body: "Work" }],
  ];
  for (const [name, args] of denied) await assert.rejects(run(name, args), /doesn't have access to the "acme"/);
  assert.deepEqual(queried, []);
  await wired
    .tools(claude)
    .find((tool) => tool.name === "linear_search")
    .run({ query: "work" });
  assert.deepEqual(queried.splice(0), ["acme"]);
  await access(null, "linear", "codex", "a", false, "beta");
  assert.deepEqual(linearTools(codex), []);
  await assert.rejects(run("search", { query: "work" }), /doesn't have access to any/);
  assert.deepEqual(queried, []);
  assert.ok(events.some(([channel, payload]) => channel === "connectors:changed" && payload.connectors[0].off.includes("codex:a")));
  await access(null, "linear", "codex", "a", true);
  assert.deepEqual(
    (await handlers.get("connectors:list")())[0].workspaceAccess.map(({ off }) => off),
    [[], ["claude:a"]],
  );
  await handlers.get("connectors:sign-out")(null, "linear");
  assert.deepEqual(await handlers.get("connectors:list")(), []);
});
