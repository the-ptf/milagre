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

test("starting a Chat with no live agent takes the calling Chat's mode, and Ask for an outside client", async (t) => {
  const { createLocalMcpHost } = require("./local-mcp-host.cjs");
  const projectPath = fs.realpathSync(fixture(t));
  const live = { [`${projectPath}#2`]: "full" };
  let sent;
  const host = createLocalMcpHost({
    projects: async () => [{ path: projectPath }],
    readProject: async () => ({ state: { sessions: { 1: { id: 1 } } } }),
    scopeStates: { chatMessages: async () => [] },
    permissionMode: (chatId, fallback = "ask") => live[chatId] ?? fallback,
    chats: {
      turnSettings: () => ({ model: "fixture" }),
      send: async (request) => {
        sent = request;
        request.canStart();
        return { sessionId: 1 };
      },
    },
  });
  await host.startChat({ projectPath, chatId: `${projectPath}#1`, prompt: "Inspect" }, "a", () => {}, `${projectPath}#2`);
  assert.equal(sent.permissionMode, "full");
  await host.startChat({ projectPath, chatId: `${projectPath}#1`, prompt: "Inspect" }, "b", () => {});
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

// A host over one Project with one Worktree and Chats 1 (the target) and 2 (the caller), and every port recorded.
function steeringHost(t, overrides = {}) {
  const { createLocalMcpHost } = require("./local-mcp-host.cjs");
  const projectPath = fs.realpathSync(fixture(t));
  const otherPath = fs.realpathSync(fixture(t));
  const calls = [];
  const modes = { [`${projectPath}#2`]: "ask", ...overrides.modes?.(projectPath) };
  let links = overrides.links?.(projectPath, otherPath) ?? [];
  const state = (root) => ({
    worktrees: { 1: { id: 1, path: root, name: "main" } },
    sessions: { 1: { id: 1, worktree_id: 1, title: "Target", ...overrides.session }, 2: { id: 2, worktree_id: 1 } },
  });
  const host = createLocalMcpHost({
    projects: async () => [
      { id: projectPath, path: projectPath },
      { id: otherPath, path: otherPath },
    ],
    readProject: async (root) => ({ state: state(root) }),
    scopeStates: { chatMessages: async () => [] },
    permissionMode: (chatId, fallback = "ask") => (chatId in modes ? modes[chatId] : fallback),
    chats: {
      runs: overrides.run ? { [`${projectPath}#1`]: { approvals: [], questions: [], ...overrides.run } } : {},
      turnSettings: () => ({ provider: "claude", model: "old", effort: "low", ...overrides.turn }),
      send: async (request) => {
        calls.push(["send", request]);
        return { sessionId: 1 };
      },
    },
    stopChat: async (chatId) => calls.push(["stop", chatId]),
    setPermissionMode: async (chatId, mode) => calls.push(["mode", chatId, mode]),
    respondPermission: async (...args) => (calls.push(["respond", ...args]), true),
    answerQuestion: async (...args) => (calls.push(["answer", ...args]), true),
    patchChat: async (...args) => calls.push(["patch", ...args]),
    searchChats: async () => [{ message: { id: 7, session_id: 1 }, snippet: "found it" }],
    links: {
      list: async () => links,
      add: async (a, b) => (links = [...links, { id: `l${links.length}`, a, b }]),
      remove: async (id) => (links = links.filter((link) => link.id !== id)),
    },
    activeWorktrees: async (root) => [root],
    models: async () => ({
      claude: [{ id: "old", efforts: ["low", "high"], defaultEffort: "low" }],
      codex: [{ id: "new", efforts: ["medium", "high"], defaultEffort: "medium" }],
    }),
    approve: async (chatId, request) => {
      calls.push(["approve", chatId, request.title]);
      return overrides.decision ?? "allow";
    },
  });
  return { host, projectPath, otherPath, calls, chatId: `${projectPath}#1`, caller: `${projectPath}#2`, links: () => links };
}

test("chat_start switches provider, model and effort when given, and keeps the Chat's otherwise", async (t) => {
  const { host, projectPath, chatId, calls } = steeringHost(t);
  await host.startChat({ projectPath, chatId, prompt: "Go", provider: "codex", model: "new", effort: "high" }, "a", () => {});
  assert.deepEqual((({ provider, model, effort }) => ({ provider, model, effort }))(calls.at(-1)[1]), { provider: "codex", model: "new", effort: "high" });
  await host.startChat({ projectPath, chatId, prompt: "Go" }, "b", () => {});
  assert.deepEqual((({ provider, model, effort }) => ({ provider, model, effort }))(calls.at(-1)[1]), { provider: "claude", model: "old", effort: "low" });
});

test("a permission mode above the caller's needs the user's approval, and an outside client can't raise it", async (t) => {
  const { host, projectPath, chatId, caller, calls } = steeringHost(t);
  await host.startChat({ projectPath, chatId, prompt: "Go", permissionMode: "ask" }, "a", () => {}, caller);
  assert.equal(calls.filter(([kind]) => kind === "approve").length, 0);
  await host.startChat({ projectPath, chatId, prompt: "Go", permissionMode: "full" }, "b", () => {}, caller);
  assert.deepEqual(calls.find(([kind]) => kind === "approve").slice(0, 2), ["approve", caller]);
  assert.equal(calls.findLast(([kind]) => kind === "send")[1].permissionMode, "full");
  await assert.rejects(
    host.startChat({ projectPath, chatId, prompt: "Go", permissionMode: "auto" }, "c", () => {}),
    /outside client/,
  );

  const denied = steeringHost(t, { decision: "deny" });
  await assert.rejects(
    denied.host.startChat({ projectPath: denied.projectPath, chatId: denied.chatId, prompt: "Go", permissionMode: "full" }, "a", () => {}, denied.caller),
    /declined/,
  );
  assert.equal(denied.calls.filter(([kind]) => kind === "send").length, 0);
});

test("chat_set_mode needs a running agent and gates a raise", async (t) => {
  const idle = steeringHost(t);
  await assert.rejects(idle.host.setMode({ projectPath: idle.projectPath, chatId: idle.chatId, permissionMode: "ask" }, idle.caller), /no running agent/);
  const { host, projectPath, chatId, caller, calls } = steeringHost(t, { run: {} });
  await host.setMode({ projectPath, chatId, permissionMode: "auto" }, caller);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["approve", "mode"],
  );
});

test("chat_stop stops the Chat's turn", async (t) => {
  const { host, projectPath, chatId, calls } = steeringHost(t, { run: {} });
  assert.deepEqual(await host.stopChat({ projectPath, chatId }), { chatId, stopped: true });
  assert.deepEqual(calls, [["stop", chatId]]);
});

test("chat_respond answers another Chat's approval or question, with the user's approval below Full permission", async (t) => {
  const run = {
    approvals: [{ requestId: "p1", kind: "command", tool: "Bash", title: "Run npm test", command: "npm test" }],
    questions: [
      {
        requestId: "q1",
        questions: [{ id: "a", header: "Pick", question: "Which?", options: [{ label: "One" }], multiSelect: false, allowOther: false, secret: false }],
      },
    ],
  };
  const { host, projectPath, chatId, caller, calls } = steeringHost(t, { run });
  const read = await host.readChat({ projectPath, chatId, limit: 5 });
  assert.equal(read.approvals[0].command, "npm test");
  assert.equal(read.questions[0].requestId, "q1");
  await assert.rejects(host.respond({ projectPath, chatId, requestId: "p1", decision: "allow" }, chatId), /its own/);
  await assert.rejects(host.respond({ projectPath, chatId, requestId: "nope", decision: "allow" }, caller), /Nothing with that requestId/);
  await host.respond({ projectPath, chatId, requestId: "p1", decision: "deny" }, caller);
  assert.equal(calls.filter(([kind]) => kind === "approve").length, 0, "denying takes nothing from the user");
  await host.respond({ projectPath, chatId, requestId: "p1", decision: "allow" }, caller);
  await host.respond({ projectPath, chatId, requestId: "q1", answers: { a: ["One"] } }, caller);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["respond", "approve", "respond", "approve", "answer"],
  );
  assert.deepEqual(calls.at(-1), ["answer", chatId, "q1", { a: ["One"] }, "One"]);
  await assert.rejects(host.respond({ projectPath, chatId, requestId: "p1", decision: "allow" }), /outside client/);

  const full = steeringHost(t, { run, modes: (root) => ({ [`${root}#2`]: "full" }) });
  await full.host.respond({ projectPath: full.projectPath, chatId: full.chatId, requestId: "p1", decision: "allow" }, full.caller);
  assert.deepEqual(
    full.calls.map(([kind]) => kind),
    ["respond"],
  );
});

test("chat_update renames and archives, and won't archive a running Chat", async (t) => {
  const { host, projectPath, chatId, calls } = steeringHost(t);
  await host.updateChat({ projectPath, chatId, title: "  Renamed ", archived: true });
  assert.deepEqual(calls, [["patch", projectPath, 1, { title: "Renamed", archived: true }]]);
  const running = steeringHost(t, { run: {} });
  await assert.rejects(running.host.updateChat({ projectPath: running.projectPath, chatId: running.chatId, archived: true }), /Stop the Chat/);
});

test("chat_search returns Chat refs and snippets", async (t) => {
  const { host, projectPath, chatId } = steeringHost(t);
  assert.deepEqual(await host.searchChats({ projectPath, query: "found", limit: 5 }), [{ chatId, title: "Target", messageId: 7, snippet: "found it" }]);
});

test("chat_start attaches files and images only from inside the Chat's Worktree", async (t) => {
  const { host, projectPath, chatId, calls } = steeringHost(t);
  fs.writeFileSync(path.join(projectPath, "notes.md"), "hi");
  fs.writeFileSync(path.join(projectPath, "shot.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  await host.startChat(
    { projectPath, chatId, prompt: "Look", files: [path.join(projectPath, "notes.md")], images: [path.join(projectPath, "shot.png")] },
    "a",
    () => {},
  );
  const sent = calls.at(-1)[1];
  assert.deepEqual(sent.files, [path.join(projectPath, "notes.md")]);
  assert.match(sent.prompt, /Attached files:\n.*notes\.md$/);
  assert.match(sent.images[0].dataUrl, /^data:image\/png;base64,/);
  const outside = path.join(fs.realpathSync(fixture(t)), "secret.txt");
  fs.writeFileSync(outside, "no");
  await assert.rejects(
    host.startChat({ projectPath, chatId, prompt: "Look", files: [outside] }, "b", () => {}),
    /outside the Chat's Worktree/,
  );
  await assert.rejects(
    host.startChat({ projectPath, chatId, prompt: "Look", files: ["relative.md"] }, "c", () => {}),
    /absolute path/,
  );
});

test("worktree_link links two Worktrees, asking the user first from an agent in Ask mode", async (t) => {
  const { host, projectPath, otherPath, caller, calls, links } = steeringHost(t);
  const args = { projectPath, worktreeId: 1, targetProjectPath: otherPath, targetWorktreeId: 1 };
  await assert.rejects(
    host.linkWorktrees(args, undefined, () => false),
    /outside this connection's scope/,
  );
  const made = await host.linkWorktrees(args, caller, () => false);
  assert.equal(made.created, true);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["approve"],
  );
  assert.deepEqual(links()[0].b, { project_id: otherPath, worktree_path: otherPath });
  assert.deepEqual(await host.linkWorktrees(args, caller, () => false), { linkId: made.linkId, created: false });
  // An outside client with both Projects in its scope links without a card.
  const outside = steeringHost(t);
  await outside.host.linkWorktrees({ ...args, projectPath: outside.projectPath, targetProjectPath: outside.otherPath }, undefined, () => true);
  assert.equal(outside.calls.length, 0);
  assert.equal(outside.links().length, 1);
});

test("worktree_unlink removes only Worktree-to-Worktree Links that reach this Worktree", async (t) => {
  const { host, projectPath, otherPath, links } = steeringHost(t, {
    links: (root, other) => [
      { id: "w", a: { project_id: root, worktree_path: root }, b: { project_id: other, worktree_path: other } },
      { id: "p", a: { project_id: root, worktree_path: root }, b: { project_id: other } },
    ],
  });
  assert.deepEqual(await host.unlinkWorktrees({ projectPath, worktreeId: 1, targetWorktreePath: otherPath }), { removed: ["w"] });
  assert.deepEqual(
    links().map((link) => link.id),
    ["p"],
  );
  await assert.rejects(host.unlinkWorktrees({ projectPath, worktreeId: 1, targetWorktreePath: otherPath }), /Project Links are removed on the canvas/);
});

test("chat_start refuses an effort the model doesn't take, and drops a carried one for the model's default", async (t) => {
  const { host, projectPath, chatId, calls } = steeringHost(t);
  await assert.rejects(
    host.startChat({ projectPath, chatId, prompt: "Go", effort: "minimal" }, "a", () => {}),
    /old takes effort low, high, not minimal/,
  );
  await host.startChat({ projectPath, chatId, prompt: "Go", provider: "codex", model: "new" }, "b", () => {});
  assert.equal(calls.at(-1)[1].effort, "medium");
});

test("chat_read and chat_list show the messages queued behind a running turn, with the line the Chat shows", async (t) => {
  const queued = [{ id: "q1", body: "Then run the tests", provider: "antigravity", model: "gemini", queuedAt: 5, turn: { permissionMode: "ask" } }];
  const { host, projectPath, chatId } = steeringHost(t, { run: {}, session: { queued } });
  const read = await host.readChat({ projectPath, chatId, limit: 5 });
  assert.deepEqual(read.queue, {
    status: "sends when this turn ends",
    messages: [{ id: "q1", body: "Then run the tests", provider: "antigravity", model: "gemini", queuedAt: 5 }],
  });
  assert.equal((await host.chats({ projectPath })).find((item) => item.chatId === chatId).queued, 1);
  const held = steeringHost(t, { session: { queued, queueHeld: true } });
  assert.equal(
    (await held.host.readChat({ projectPath: held.projectPath, chatId: held.chatId, limit: 5 })).queue.status,
    "on hold since the last turn stopped",
  );
  const empty = steeringHost(t);
  assert.equal("queue" in (await empty.host.readChat({ projectPath: empty.projectPath, chatId: empty.chatId, limit: 5 })), false);
});

test("chat_start into a busy Chat whose agent can't steer says the message waits for the running turn", async (t) => {
  const busy = steeringHost(t, { run: {}, turn: { provider: "antigravity" } });
  const waiting = await busy.host.startChat({ projectPath: busy.projectPath, chatId: busy.chatId, prompt: "Go" }, "a", () => {});
  assert.match(waiting.note, /starts this one after its running turn ends/);
  const steering = steeringHost(t, { run: {} });
  assert.equal("note" in (await steering.host.startChat({ projectPath: steering.projectPath, chatId: steering.chatId, prompt: "Go" }, "a", () => {})), false);
});
