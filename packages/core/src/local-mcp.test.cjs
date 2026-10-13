const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { z } = require("zod");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const config = { label: "Editor", grants: { designs: { chatId: "/project#1", designIds: ["one"], capabilities: ["read", "write"] } } };

test("Windows private JSON protects staged files before replacement and preserves state when ACL setup fails", (t) => {
  const vm = require("node:vm");
  const directory = fixture(t);
  const protectedFiles = new Set();
  let refuseProtection = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("./local-mcp-store.cjs"), "utf8"), {
    module,
    process: { platform: "win32" },
    structuredClone,
    require(name) {
      if (name === "./private-files.cjs")
        return {
          preparePrivateDirectory() {},
          assertPrivate(file) {
            fs.statSync(file);
            assert.ok(protectedFiles.has(file), "a reopened file must belong to the current user");
          },
          windowsAcl(file, options) {
            assert.equal(options.mode, "protect");
            assert.ok(file.endsWith(".tmp"), "protect before publishing the file");
            assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
            if (refuseProtection) throw Error("ACL setup denied");
            protectedFiles.add(file);
          },
        };
      if (name === "node:fs")
        return {
          ...fs,
          renameSync(from, to) {
            assert.ok(protectedFiles.has(from), "never publish an unprotected staging file");
            fs.renameSync(from, to);
            protectedFiles.delete(from);
            protectedFiles.add(to);
          },
        };
      return require(name);
    },
  });
  const open = () => module.exports.privateJson(directory, "endpoint.json", null);
  open().write({ port: 1234 });
  assert.equal(open().read().port, 1234);
  open().write({ port: 5678 });
  assert.equal(open().read().port, 5678);
  refuseProtection = true;
  assert.throws(() => open().write({ port: 9999 }), /ACL setup denied/);
  assert.equal(open().read().port, 5678);
  assert.deepEqual(fs.readdirSync(directory), ["endpoint.json"]);
});

test("credentials persist as hashes, rotate and revoke without leaking through listing", (t) => {
  const { createLocalMcpStore } = require("./local-mcp-store.cjs");
  const directory = fixture(t);
  let store = createLocalMcpStore({ directory });
  const created = store.create(config);
  assert.equal(store.authenticate(created.token).id, created.connection.id);
  assert.ok(!JSON.stringify(store.list()).includes(created.token));
  assert.ok(!fs.readFileSync(path.join(directory, "connections.json"), "utf8").includes(created.token));
  store = createLocalMcpStore({ directory });
  assert.equal(store.authenticate(created.token).id, created.connection.id);
  const rotated = store.rotate(created.connection.id);
  assert.throws(() => store.authenticate(created.token), /Unauthorized/);
  assert.equal(store.authenticate(rotated.token).id, created.connection.id);
  store.revoke(created.connection.id);
  assert.throws(() => store.authenticate(rotated.token), /Unauthorized/);
});

test("strict grants and expiration fail closed", (t) => {
  const { createLocalMcpStore } = require("./local-mcp-store.cjs");
  let now = 100;
  const store = createLocalMcpStore({ directory: fixture(t), now: () => now });
  assert.throws(() => store.create({ ...config, grants: { arbitrary: {} } }));
  assert.throws(() => store.create({ ...config, grants: { chats: { projectPaths: ["relative"], capabilities: ["start"] } } }));
  const made = store.create({ ...config, expiresAt: new Date(200).toISOString() });
  now = 201;
  assert.throws(() => store.authenticate(made.token), /Unauthorized/);
});

test("registry isolates groups and invalidates cached and in-flight definitions on a grant edit", async (t) => {
  const { createLocalMcpStore } = require("./local-mcp-store.cjs");
  const { createLocalMcpRegistry } = require("./local-mcp-registry.cjs");
  const store = createLocalMcpStore({ directory: fixture(t) });
  const { connection } = store.create(config);
  const registry = createLocalMcpRegistry({ connection: (id) => store.get(id) });
  let enabled = true;
  let resume;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  registry.registerToolGroup({
    id: "designs",
    enabled: () => enabled,
    tools: ({ assertActive }) => [
      { name: "read", input: {}, capability: "read", readOnly: true, run: async () => "read" },
      {
        name: "write",
        input: { value: z.string() },
        capability: "write",
        readOnly: false,
        run: async () => {
          entered();
          await new Promise((resolve) => {
            resume = resolve;
          });
          await assertActive();
          return "written";
        },
      },
    ],
  });
  registry.registerToolGroup({
    id: "projects",
    enabled: () => true,
    tools: () => [{ name: "project_list", capability: "read", input: {}, run: () => "secret" }],
  });
  const tools = registry.toolsFor(connection.id);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["read", "write"],
  );
  const pending = tools[1].run({ value: "x" });
  await ready;
  store.update(connection.id, { ...config, grants: { designs: { ...config.grants.designs, capabilities: ["read"] } } });
  resume();
  await assert.rejects(pending, /changed|revoked/);
  await assert.rejects(tools[0].run({}), /changed|revoked/);
  assert.deepEqual(
    registry.toolsFor(connection.id).map((tool) => tool.name),
    ["read"],
  );
  const cached = registry.toolsFor(connection.id)[0];
  enabled = false;
  assert.deepEqual(registry.toolsFor(connection.id), []);
  await assert.rejects(cached.run({}), /disabled/);
});

test("operation journal deduplicates concurrent retries and restart, rejects changed input", async (t) => {
  const { createLocalMcpOperations } = require("./local-mcp-operations.cjs");
  const directory = fixture(t);
  let journal = createLocalMcpOperations({ directory });
  let calls = 0;
  const execute = async () => {
    calls++;
    return { id: 42 };
  };
  const args = ["connection", "request-1", "chat_create", { worktreeId: 1 }, execute];
  assert.deepEqual(await Promise.all([journal.run(...args), journal.run(...args)]), [{ id: 42 }, { id: 42 }]);
  journal = createLocalMcpOperations({ directory });
  assert.deepEqual(await journal.run(...args), { id: 42 });
  assert.equal(calls, 1);
  await assert.rejects(journal.run("connection", "request-1", "chat_create", {}, execute), /different/);
});

test("uncertain mutations reconcile without replay after restart", async (t) => {
  const { createLocalMcpOperations } = require("./local-mcp-operations.cjs");
  const directory = fixture(t);
  let journal = createLocalMcpOperations({ directory });
  let calls = 0;
  const execute = async () => {
    calls++;
    throw Error("lost acknowledgement");
  };
  await assert.rejects(journal.run("c", "r", "worktree_create", {}, execute), /lost/);
  journal = createLocalMcpOperations({ directory });
  await assert.rejects(
    journal.run("c", "r", "worktree_create", {}, execute, async () => null),
    /uncertain/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await journal.run("c", "r", "worktree_create", {}, execute, async () => ({ worktreeId: 7 })), { worktreeId: 7 });
  assert.equal(calls, 1);
});

test("simultaneous calls cannot reuse one requestId with different input", async (t) => {
  const { createLocalMcpOperations } = require("./local-mcp-operations.cjs");
  const journal = createLocalMcpOperations({ directory: fixture(t) });
  const first = journal.run("c", "r", "chat_start", { prompt: "one" }, async () => ({ id: 1 }));
  const second = journal.run("c", "r", "chat_start", { prompt: "two" }, async () => ({ id: 2 }));
  await assert.rejects(second, /different/);
  assert.deepEqual(await first, { id: 1 });
});

test("starting a task uses the live permission mode rather than stale turn settings", async (t) => {
  const { createLocalMcpHost } = require("./local-mcp-host.cjs");
  const projectPath = fs.realpathSync(fixture(t));
  let sent;
  const host = createLocalMcpHost({
    projects: async () => [{ path: projectPath }],
    readProject: async () => ({ state: { sessions: { 1: { id: 1 } } } }),
    scopeStates: { chatMessages: async () => [] },
    permissionMode: () => "ask",
    chats: {
      turnSettings: () => ({ permissionMode: "full", model: "fixture" }),
      send: async (request) => {
        sent = request;
        return { sessionId: 1 };
      },
    },
  });
  await host.startChat({ projectPath, chatId: `${projectPath}#1`, prompt: "Inspect" }, "operation", () => {});
  assert.equal(sent.permissionMode, "ask");
});

test("revocation, expiry, OFF and resource edits invalidate awaiting reads and queued writes", async (t) => {
  const { createLocalMcpStore } = require("./local-mcp-store.cjs");
  const { createLocalMcpRegistry } = require("./local-mcp-registry.cjs");
  for (const change of ["revoke", "expire", "off", "scope"])
    await t.test(change, async (t) => {
      let now = 100,
        enabled = true,
        committed = false;
      const store = createLocalMcpStore({ directory: fixture(t), now: () => now });
      const { connection } = store.create({ ...config, expiresAt: new Date(200).toISOString() });
      const registry = createLocalMcpRegistry({ connection: (id) => store.get(id) });
      const release = Promise.withResolvers();
      registry.registerToolGroup({
        id: "designs",
        enabled: () => enabled,
        tools: ({ assertActive }) => [
          {
            name: "read",
            capability: "read",
            input: {},
            run: async () => {
              await release.promise;
              return "private result";
            },
          },
          {
            name: "write",
            capability: "write",
            input: {},
            run: async () => {
              await release.promise;
              await assertActive();
              committed = true;
              return "ok";
            },
          },
        ],
      });
      const cached = registry.toolsFor(connection.id);
      const read = cached[0].run({}),
        write = cached[1].run({});
      if (change === "revoke") store.revoke(connection.id);
      if (change === "expire") now = 201;
      if (change === "off") enabled = false;
      if (change === "scope") store.update(connection.id, { ...config, grants: { designs: { ...config.grants.designs, designIds: ["other"] } } });
      release.resolve();
      await assert.rejects(read);
      await assert.rejects(write);
      assert.equal(committed, false);
      await assert.rejects(cached[0].run({}));
      if (change === "revoke" || change === "expire") assert.throws(() => registry.toolsFor(connection.id));
      if (change === "off") assert.deepEqual(registry.toolsFor(connection.id), []);
    });
});
