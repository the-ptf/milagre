const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalMcpStore, privateJson, hash } = require("./local-mcp-store.cjs");
const { clientCatalog, readConfig, clientEntry, entryToken, canonical, prepareEdit } = require("./local-mcp-client-files.cjs");
const config = { label: "Editor", grants: { designs: { chatId: "/project#1", designIds: ["one"], capabilities: ["read"] } } };
function fixture(t, options = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-clients-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, "private");
  const store = createLocalMcpStore({ directory, ...options });
  const { createLocalMcpClients } = require("./local-mcp-clients.cjs");
  const make = () => createLocalMcpClients({ directory, store, home, env: {}, platform: "darwin", url: () => "http://127.0.0.1:43210/mcp" });
  return { home, directory, store, clients: make(), make };
}

test("every client toggle installs its native config, preserves unrelated settings and revokes on disable", async (t) => {
  const f = fixture(t);
  for (const client of f.clients.status()) {
    fs.mkdirSync(path.dirname(client.configPath), { recursive: true });
    fs.writeFileSync(
      client.configPath,
      client.id === "codex"
        ? '# keep me\nmodel = "user-model"\n[mcp_servers.other]\nurl = "https://example.invalid/mcp"\n'
        : '{\n// keep me\n"unrelated":true\n}\n',
    );
    const result = await f.clients.enable(client.id, config);
    assert.equal(result.enabled, true);
    assert.equal(result.state, "configured");
    assert.equal(JSON.stringify(result).includes("Bearer"), false);
    const text = fs.readFileSync(client.configPath, "utf8");
    assert.match(text, /keep me/);
    assert.match(text, /127\.0\.0\.1:43210/);
    assert.equal(fs.statSync(client.configPath).mode & 0o777, 0o600);
    const record = f.store.list().find((c) => c.id === result.connection.id);
    assert.equal(record.clientId, client.id);
    assert.deepEqual(record.grants, config.grants);
    // Read the credential field: a long checkout path can also contain 43 token-shaped characters.
    const token = entryToken(readConfig(clientCatalog({ home: f.home, env: {}, platform: "darwin" }).find((c) => c.id === client.id)).entry);
    assert.equal(f.store.authenticate(token).id, record.id);
    const definition = clientCatalog({ home: f.home, env: {}, platform: "darwin" }).find((c) => c.id === client.id);
    const { entry } = readConfig(definition);
    const bearer = { Authorization: `Bearer ${token}` };
    const url = "http://127.0.0.1:43210/mcp";
    const expected = {
      "claude-code": { type: "http", url, headers: bearer },
      codex: { url, http_headers: bearer },
      gemini: { httpUrl: url, headers: bearer },
      antigravity: { serverUrl: url, headers: bearer },
      opencode: { type: "remote", url, headers: bearer, oauth: false, enabled: true },
      kiro: { url, headers: bearer },
      "claude-desktop": {
        command: process.execPath,
        args: [path.join(__dirname, "local-mcp-stdio.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1", MILAGRE_MCP_URL: url, MILAGRE_MCP_TOKEN: token },
      },
    };
    assert.deepEqual(canonical(entry), expected[client.id]);
    assert.ok(!fs.readFileSync(path.join(f.directory, "clients.json"), "utf8").includes(token));
    assert.ok(!JSON.stringify(f.clients.status()).includes(token));
    await f.clients.disable(client.id);
    assert.throws(() => f.store.authenticate(token), /Unauthorized/);
    const removed = fs.readFileSync(client.configPath, "utf8");
    assert.ok(!removed.includes(token));
    assert.match(removed, /keep me/);
    assert.match(removed, client.id === "codex" ? /user-model/ : /unrelated/);
  }
});

test("startup retains configured credentials, repairs deleted entries and never resurrects revoked or expired grants", async (t) => {
  let now = Date.now();
  const f = fixture(t, { now: () => now });
  const installed = await f.clients.enable("claude-code", config);
  const first = fs.readFileSync(installed.configPath, "utf8");
  let clients = f.make();
  await clients.resume();
  assert.equal(fs.readFileSync(installed.configPath, "utf8"), first);
  fs.writeFileSync(installed.configPath, '{"other":1}');
  await clients.resume();
  const repaired = fs.readFileSync(installed.configPath, "utf8");
  assert.notEqual(repaired, first);
  assert.match(repaired, /"other":\s*1/);
  f.store.revoke(installed.connection.id);
  clients = f.make();
  await clients.resume();
  assert.equal(clients.status().find((c) => c.id === "claude-code").enabled, false);
  assert.ok(!fs.readFileSync(installed.configPath, "utf8").includes("Bearer"));
  const expires = clients.enable("codex", { ...config, expiresAt: new Date(now + 1000).toISOString() });
  now += 1001;
  clients = f.make();
  clients.resume();
  assert.equal(clients.status().find((c) => c.id === "codex").enabled, false);
  assert.ok(!fs.readFileSync(expires.configPath, "utf8").includes("Bearer"));
  assert.equal(f.store.list().length, 2, "expired grants must not be replaced automatically");
});

test("startup reconciles an interrupted client write and revokes grants with no installation intent", (t) => {
  const f = fixture(t);
  const installed = f.clients.enable("claude-code", config);
  const client = clientCatalog({ home: f.home, env: {}, platform: "darwin" })[0];
  const before = readConfig(client);
  const oldToken = entryToken(before.entry);
  const pending = f.store.create(config, { clientId: client.id });
  f.store.revoke(installed.connection.id);
  const records = privateJson(f.directory, "clients.json", {});
  const state = records.read();
  const replacement = clientEntry(client.id, "http://127.0.0.1:43210/mcp", pending.token);
  state[client.id] = {
    ...state[client.id],
    connectionId: pending.connection.id,
    entryHashes: [before.entry, replacement].map((entry) => hash(JSON.stringify(canonical(entry)))),
  };
  records.write(state); // crash after intent persisted, before the client's file was replaced
  const orphan = f.store.create(config, { clientId: "codex" }); // crash before intent persisted
  const clients = f.make();
  clients.resume();
  const current = entryToken(readConfig(client).entry);
  assert.equal(clients.status()[0].state, "configured");
  assert.equal(f.store.authenticate(current).id, pending.connection.id);
  assert.throws(() => f.store.authenticate(oldToken), /Unauthorized/);
  assert.throws(() => f.store.authenticate(pending.token), /Unauthorized/);
  assert.throws(() => f.store.authenticate(orphan.token), /Unauthorized/);
  clients.resume();
  assert.equal(entryToken(readConfig(client).entry), current, "completed recovery must not keep rotating");
});

test("config commits reject concurrent edits and ambiguous layouts without touching unrelated values", (t) => {
  const f = fixture(t);
  const installed = f.clients.enable("codex", config);
  const client = clientCatalog({ home: f.home, env: {}, platform: "darwin" }).find((c) => c.id === "codex");
  const commit = prepareEdit(client, readConfig(client), undefined);
  const changed = fs.readFileSync(installed.configPath, "utf8") + "\n# edited elsewhere\n";
  fs.writeFileSync(installed.configPath, changed);
  assert.throws(commit, /changed/);
  assert.equal(fs.readFileSync(installed.configPath, "utf8"), changed);
  const ambiguous = 'mcp_servers = { "milagre-local" = { url = "http://127.0.0.1:1/mcp" }, other = { url = "http://example.invalid" } }\n';
  fs.writeFileSync(installed.configPath, ambiguous);
  assert.throws(() => prepareEdit(client, readConfig(client), undefined), /safely edit/);
  assert.equal(fs.readFileSync(installed.configPath, "utf8"), ambiguous);
});

test("startup refreshes an owned stdio executable path after an app update without rotating access", (t) => {
  const f = fixture(t);
  f.clients.enable("claude-desktop", config);
  const client = clientCatalog({ home: f.home, env: {}, platform: "darwin" }).find((c) => c.id === "claude-desktop");
  const read = readConfig(client);
  const token = entryToken(read.entry);
  const older = { ...read.entry, command: "/previous-install/Milagre", args: ["/previous-install/local-mcp-stdio.cjs"] };
  prepareEdit(client, read, older)();
  const records = privateJson(f.directory, "clients.json", {});
  const state = records.read();
  state[client.id].entryHashes = [hash(JSON.stringify(canonical(older)))];
  records.write(state);
  f.make().resume();
  const current = readConfig(client).entry;
  assert.equal(current.command, process.execPath);
  assert.deepEqual(current.args, [path.join(__dirname, "local-mcp-stdio.cjs")]);
  assert.equal(entryToken(current), token);
});

test("conflicts, malformed configs and symbolic links never overwrite client settings or leak secrets", async (t) => {
  const f = fixture(t);
  const enabled = await f.clients.enable("gemini", config);
  const original = fs.readFileSync(enabled.configPath, "utf8");
  fs.writeFileSync(enabled.configPath, original.replace("127.0.0.1:43210", "example.invalid:43210"));
  const changed = fs.readFileSync(enabled.configPath, "utf8");
  await assert.rejects(async () => f.clients.enable("gemini", config), /changed|managed|conflict/i);
  await f.clients.disable("gemini");
  assert.equal(fs.readFileSync(enabled.configPath, "utf8"), changed);
  assert.ok(f.store.list().find((c) => c.id === enabled.connection.id).revokedAt);
  const row = f.clients.status().find((c) => c.id === "opencode");
  fs.mkdirSync(path.dirname(row.configPath), { recursive: true });
  fs.writeFileSync(row.configPath, '{"token":"never-echo-this",invalid}');
  await assert.rejects(
    async () => f.clients.enable("opencode", config),
    (error) => !error.message.includes("never-echo-this"),
  );
  fs.rmSync(row.configPath);
  const target = path.join(f.home, "elsewhere.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, row.configPath);
  await assert.rejects(async () => f.clients.enable("opencode", config), /symbolic|symlink/i);
  assert.equal(fs.readFileSync(target, "utf8"), "{}");
});

test("editing a configured client updates its grant in place without rotating its credential, and mints a new one if missing", async (t) => {
  const f = fixture(t);
  const initial = await f.clients.enable("claude-code", {
    label: "Claude Code CLI",
    grants: { projects: { projectPaths: ["/repo-a"], capabilities: ["read"] } },
  });
  const firstFile = fs.readFileSync(initial.configPath, "utf8");
  const firstToken = firstFile.match(/[A-Za-z0-9_-]{43}/)[0];

  const widened = await f.clients.enable("claude-code", {
    label: "Claude Code CLI",
    grants: {
      projects: { projectPaths: "*", capabilities: ["read"] },
      worktrees: { projectPaths: "*", capabilities: ["read", "create"] },
    },
  });
  assert.equal(widened.connection.id, initial.connection.id);
  assert.equal(widened.connection.revision, 2);
  assert.deepEqual(widened.connection.grants.projects, { projectPaths: "*", capabilities: ["read"] });
  assert.equal(fs.readFileSync(initial.configPath, "utf8"), firstFile, "configured token stays intact so running CLI sessions keep working");
  assert.equal(f.store.authenticate(firstToken).revision, 2);

  // If the owned entry was deleted from the client config file, enable repairs it with a fresh credential.
  fs.writeFileSync(initial.configPath, "{}");
  assert.equal(f.clients.status().find((c) => c.id === "claude-code").state, "missing");
  const repaired = await f.clients.enable("claude-code", {
    label: "Claude Code CLI",
    grants: { projects: { projectPaths: ["/repo-b"], capabilities: ["read"] } },
  });
  assert.notEqual(repaired.connection.id, initial.connection.id);
  assert.throws(() => f.store.authenticate(firstToken), /Unauthorized/);
  const secondToken = fs.readFileSync(repaired.configPath, "utf8").match(/[A-Za-z0-9_-]{43}/)[0];
  assert.equal(f.store.authenticate(secondToken).id, repaired.connection.id);
});
