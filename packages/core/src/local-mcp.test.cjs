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

test("revoking an MCP connection fences an account assignment waiting in the host queue", async (t) => {
  const { createLocalMcpRegistry } = require("./local-mcp-registry.cjs");
  const { managementToolGroups } = require("./local-mcp-tools.cjs");
  const { createLocalMcpHost } = require("./local-mcp-host.cjs");
  const projectPath = fs.realpathSync(fixture(t));
  let revision = 1;
  let queued;
  let signalQueued;
  const queuedReady = new Promise((resolve) => {
    signalQueued = resolve;
  });
  let wrote = false;
  const host = createLocalMcpHost({
    projects: async () => [{ path: projectPath }],
    assignProjectAccount: (_project, _provider, _id, canAssign) =>
      new Promise((resolve, reject) => {
        queued = () => {
          try {
            canAssign();
            wrote = true;
            resolve({});
          } catch (error) {
            reject(error);
          }
        };
        signalQueued();
      }),
  });
  const registry = createLocalMcpRegistry({
    connection: () => ({ revision, grants: { projects: { projectPaths: [projectPath], capabilities: ["create"] } } }),
  });
  for (const group of managementToolGroups({ host })) registry.registerToolGroup(group);
  const tool = registry.toolsFor("outside").find((item) => item.name === "project_set_account");
  const pending = tool.run({ projectPath, provider: "codex", accountId: null });
  await queuedReady;
  revision++;
  queued();
  await assert.rejects(pending, /changed or revoked/);
  assert.equal(wrote, false);
});

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
    // A second Worktree Milagre made, for worktree_remove, with any Chats a test puts on it.
    readProject: async (root) => {
      const base = state(root);
      return {
        state: {
          ...base,
          worktrees: {
            ...base.worktrees,
            2: {
              id: 2,
              path: path.join(root, "wt"),
              name: "milagre/wt",
              base: "main",
              ...(overrides.sharedWorktree ? { sharedChat: { linkId: "l", sessionId: 1 } } : {}),
            },
          },
          sessions: { ...base.sessions, ...overrides.sessions },
        },
      };
    },
    scopeStates: { chatMessages: async () => [] },
    permissionMode: (chatId, fallback = "ask") => (chatId in modes ? modes[chatId] : fallback),
    chats: {
      runs: overrides.run ? { [`${projectPath}#1`]: { approvals: [], questions: [], ...overrides.run } } : {},
      turnSettings: () => ({ provider: "claude", model: "old", effort: "low", ...overrides.turn }),
      send: async (request) => {
        calls.push(["send", request]);
        return { sessionId: 1 };
      },
      ...(overrides.runs ? { runs: overrides.runs(projectPath) } : {}),
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
    worktreeStatus: async () => ({ uncommitted: 0, unpushed: 0, branch: "milagre/wt", removable: true, ...overrides.status }),
    removeWorktree: async (...args) => (calls.push(["remove", ...args]), { removed: true, branch: "milagre/wt", branchDeleted: true }),
    approve: async (chatId, request) => {
      calls.push(["approve", chatId, request.title]);
      return overrides.approve ? overrides.approve(request) : (overrides.decision ?? "allow");
    },
    ...(overrides.botOf ? { botOf: overrides.botOf } : {}),
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

test("chat_start into a Chat already in more than the caller's mode asks first and waits; a denial sends nothing", async (t) => {
  let answer;
  const { host, projectPath, chatId, caller, calls } = steeringHost(t, {
    modes: (root) => ({ [`${root}#1`]: "full" }),
    approve: (request) =>
      new Promise((resolve) => {
        answer = { request, allow: () => resolve("allow") };
      }),
  });
  const pending = host.startChat({ projectPath, chatId, prompt: "Delete the build" }, "a", () => {}, caller);
  // The card waits on the user: nothing is sent until they answer.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [["approve", caller, 'Run a prompt in "Target" in Full permission?']]);
  assert.deepEqual(JSON.parse(answer.request.detail), { permissionMode: "full", prompt: "Delete the build" });
  assert.equal(answer.request.kind, "other");
  answer.allow();
  await pending;
  assert.equal(calls.at(-1)[0], "send");
  assert.equal(calls.at(-1)[1].permissionMode, "full");

  const denied = steeringHost(t, { modes: (root) => ({ [`${root}#1`]: "auto" }), decision: "deny" });
  await assert.rejects(
    denied.host.startChat({ projectPath: denied.projectPath, chatId: denied.chatId, prompt: "Go" }, "a", () => {}, denied.caller),
    /declined/,
  );
  assert.equal(denied.calls.filter(([kind]) => kind === "send").length, 0);
  // An outside client counts as Ask and has nowhere to show the card.
  await assert.rejects(
    denied.host.startChat({ projectPath: denied.projectPath, chatId: denied.chatId, prompt: "Go" }, "b", () => {}),
    /outside client/,
  );
});

test("chat_start into a Chat in the caller's mode or less, or with no live agent, sends without a card", async (t) => {
  for (const [target, callerMode] of [
    ["ask", "ask"],
    ["auto", "full"],
    [undefined, "auto"],
  ]) {
    const { host, projectPath, chatId, caller, calls } = steeringHost(t, {
      modes: (root) => ({ [`${root}#2`]: callerMode, ...(target ? { [`${root}#1`]: target } : {}) }),
    });
    await host.startChat({ projectPath, chatId, prompt: "Go" }, "a", () => {}, caller);
    assert.equal(calls.filter(([kind]) => kind === "approve").length, 0, `${target} from ${callerMode}`);
    assert.equal(calls.findLast(([kind]) => kind === "send")[1].permissionMode, target ?? callerMode);
  }
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

test("chat_start tells the receiving agent who sent it, and leaves the Chat's own bubble as typed", async (t) => {
  const { host, projectPath, chatId, calls } = steeringHost(t);
  await host.startChat({ projectPath, chatId, prompt: "Please rebase" }, "a", () => {}, `${projectPath}#2`);
  const fromChat = calls.at(-1)[1];
  assert.equal(fromChat.body, "Please rebase", "the Chat shows the message as sent");
  assert.ok(
    fromChat.prompt.startsWith(
      `Message from the agent of Chat ${path.basename(projectPath)} / main / Chat (${projectPath}#2), sent with Milagre's chat_start (not the user):\n\nPlease rebase`,
    ),
    fromChat.prompt,
  );
  await host.startChat({ projectPath, chatId, prompt: "Please rebase" }, "b", () => {}, undefined, "Local editor");
  const fromClient = calls.at(-1)[1];
  assert.equal(fromClient.body, "Please rebase");
  assert.equal(fromClient.prompt, "Message sent by Local editor through Milagre's MCP (not the user):\n\nPlease rebase");
  await host.startChat({ projectPath, chatId, prompt: "Hi" }, "c", () => {});
  assert.match(calls.at(-1)[1].prompt, /^Message sent by an outside client through Milagre's MCP \(not the user\):/);
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

test("worktree_remove removes a clean Worktree Milagre made, archiving its empty Chats, after the card in Ask mode", async (t) => {
  const sessions = { 5: { id: 5, worktree_id: 2, title: "Worker", archived: true, summary: { count: 4 } }, 6: { id: 6, worktree_id: 2 } };
  const { host, projectPath, caller, calls } = steeringHost(t, { sessions });
  assert.deepEqual(await host.removeWorktree({ projectPath, worktreeId: 2 }, caller), { removed: true, branch: "milagre/wt", branchDeleted: true });
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["approve", "patch", "remove"],
  );
  assert.deepEqual(calls[1], ["patch", projectPath, 6, { archived: true }], "the empty Chat is archived; the archived one is left alone");
  assert.deepEqual(calls[2], ["remove", projectPath, path.join(projectPath, "wt")]);
  // An outside client with the Project in scope, and an agent in Full permission, get no card.
  const outside = steeringHost(t, { sessions });
  await outside.host.removeWorktree({ projectPath: outside.projectPath, worktreeId: 2 });
  assert.equal(outside.calls.filter(([kind]) => kind === "approve").length, 0);
  const trusted = steeringHost(t, { sessions, modes: (root) => ({ [`${root}#2`]: "full" }) });
  await trusted.host.removeWorktree({ projectPath: trusted.projectPath, worktreeId: 2 }, trusted.caller);
  assert.equal(trusted.calls.filter(([kind]) => kind === "approve").length, 0);
});

test("worktree_remove keeps a Worktree that isn't safe to remove, and says why", async (t) => {
  const refused = async (overrides, worktreeId = 2, asCaller = false) => {
    const fixture = steeringHost(t, overrides);
    const error = await fixture.host
      .removeWorktree({ projectPath: fixture.projectPath, worktreeId }, asCaller ? fixture.caller : undefined)
      .catch((caught) => caught);
    assert.ok(error instanceof Error, "refused");
    assert.equal(fixture.calls.filter(([kind]) => kind === "remove" || kind === "patch").length, 0, "nothing removed or archived");
    return error.message;
  };
  assert.match(await refused({}, 1), /Milagre didn't create this Worktree/);
  assert.match(await refused({ sharedWorktree: true }), /belongs to a shared Link Chat/);
  assert.match(await refused({ sessions: { 2: { id: 2, worktree_id: 2 } } }, 2, true), /can't remove the Worktree it runs in/);
  const worker = { 5: { id: 5, worktree_id: 2, title: "Worker", summary: { count: 2 } } };
  assert.match(await refused({ sessions: worker, runs: (root) => ({ [`${root}#5`]: {} }) }), /Stop "Worker" .*#5\) first/);
  assert.match(await refused({ sessions: worker }), /Archive "Worker" .*#5\) first/);
  assert.match(await refused({ status: { uncommitted: 3, removable: false } }), /3 uncommitted files/);
  assert.match(await refused({ status: { unpushed: 1, removable: false } }), /1 commit on neither main nor its upstream/);
  assert.match(await refused({ status: { branch: null, removable: false } }), /detached HEAD/);
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

test("a bot's Chat can't be started, stopped, switched, answered for or renamed through Milagre's MCP", async (t) => {
  const run = { approvals: [{ requestId: "r1", kind: "command", tool: "Bash", title: "Run?", command: "ls" }], questions: [] };
  const { host, projectPath, chatId, caller, calls } = steeringHost(t, { run, botOf: (id) => (id.endsWith("#1") ? "Ops" : null) });
  const refused = { message: "Ops runs this Chat; open it in Milagre to take it over." };
  await assert.rejects(
    host.startChat({ projectPath, chatId, prompt: "Go" }, "a", () => {}, caller),
    refused,
  );
  await assert.rejects(
    host.startChat({ projectPath, chatId, prompt: "Go" }, "b", () => {}),
    refused,
  );
  await assert.rejects(host.stopChat({ projectPath, chatId }), refused);
  await assert.rejects(host.setMode({ projectPath, chatId, permissionMode: "ask" }, caller), refused);
  await assert.rejects(host.respond({ projectPath, chatId, requestId: "r1", decision: "allow" }, caller), refused);
  await assert.rejects(host.updateChat({ projectPath, chatId, title: "Mine now" }), refused);
  assert.deepEqual(calls, []);
  // Its other Chats are steered as ever.
  await host.updateChat({ projectPath, chatId: caller, title: "Fine" });
  assert.equal(calls.at(-1)[0], "patch");
});

test("a caller in Bot rules counts as Ask: it raises nothing and links nothing without the user", async (t) => {
  const { host, projectPath, otherPath, chatId, caller, calls } = steeringHost(t, { modes: (root) => ({ [`${root}#2`]: "bot" }) });
  // A Chat with no live agent takes Ask from it, never Bot rules.
  await host.startChat({ projectPath, chatId, prompt: "Go" }, "a", () => {}, caller);
  assert.equal(calls.findLast(([kind]) => kind === "send")[1].permissionMode, "ask");
  assert.equal(calls.filter(([kind]) => kind === "approve").length, 0);
  await host.startChat({ projectPath, chatId, prompt: "Go", permissionMode: "auto" }, "b", () => {}, caller);
  assert.deepEqual(
    calls.findLast(([kind]) => kind === "approve"),
    ["approve", caller, 'Run "Target" in Auto mode?'],
  );
  await host.linkWorktrees({ projectPath, worktreeId: 1, targetProjectPath: otherPath, targetWorktreeId: 1 }, caller, () => true);
  assert.deepEqual(
    calls.findLast(([kind]) => kind === "approve"),
    ["approve", caller, "Link this Worktree to another?"],
  );
});

test("a Chat running in Bot rules counts as more than Full: a prompt sent there always asks first", async (t) => {
  const { host, projectPath, chatId, caller, calls } = steeringHost(t, {
    modes: (root) => ({ [`${root}#1`]: "bot", [`${root}#2`]: "full" }),
    run: { approvals: [], questions: [] },
  });
  await host.startChat({ projectPath, chatId, prompt: "Go" }, "a", () => {}, caller);
  assert.deepEqual(
    calls.find(([kind]) => kind === "approve"),
    ["approve", caller, 'Run a prompt in "Target" in Bot rules?'],
  );
});

test("worktree_link defaults targetWorktreeId to the target Project's main checkout Worktree when omitted", async (t) => {
  const { host, projectPath, otherPath, caller, links } = steeringHost(t);
  const made = await host.linkWorktrees({ projectPath, worktreeId: 1, targetProjectPath: otherPath }, caller, () => false);
  assert.equal(made.created, true);
  assert.deepEqual(links()[0].b, { project_id: otherPath, worktree_path: otherPath });
});

test("project_list marks inScope for agent callers, filters outside callers, and supports wildcard Project grants", async (t) => {
  const { createLocalMcp } = require("./local-mcp.cjs");
  const dataDir = fixture(t);
  const { host, projectPath, otherPath, caller } = steeringHost(t);
  const mcp = createLocalMcp({
    dataDir,
    host,
    agentScope: () => ({
      projects: { projectPaths: [projectPath], capabilities: ["read", "create"] },
      worktrees: { projectPaths: [projectPath], capabilities: ["read", "create"] },
    }),
  });
  t.after(() => mcp.close());
  const httpCall = async (cred, name, args = {}) => {
    const res = await fetch(cred.url, {
      method: "POST",
      headers: { authorization: `Bearer ${cred.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.json();
    if (body.result.isError) throw Error(body.result.content[0].text);
    return JSON.parse(body.result.content[0].text);
  };

  const agentList = mcp.agentTools(caller).find((tool) => tool.name === "project_list");
  assert.deepEqual(JSON.parse(await agentList.run({})), [
    { id: projectPath, path: projectPath, inScope: true },
    { id: otherPath, path: otherPath, inScope: false },
  ]);

  const narrow = await mcp.create({
    label: "Narrow",
    grants: { projects: { projectPaths: [projectPath], capabilities: ["read"] } },
  });
  assert.deepEqual(await httpCall(narrow, "project_list"), [{ id: projectPath, path: projectPath }]);

  const wildcard = await mcp.create({
    label: "All",
    grants: { projects: { projectPaths: "*", capabilities: ["read"] } },
  });
  assert.deepEqual(await httpCall(wildcard, "project_list"), [
    { id: projectPath, path: projectPath },
    { id: otherPath, path: otherPath },
  ]);
});

test("out-of-scope Project calls prompt in the caller's Chat, deduplicate concurrent cards, and persist Always allow in this chat", async (t) => {
  const { createLocalMcp } = require("./local-mcp.cjs");
  const dataDir = fixture(t);
  let nextDecision = "allow";
  let gate = null;
  const approvals = [];
  const { host, projectPath, otherPath, caller } = steeringHost(t, {
    approve: async (request) => {
      approvals.push(request);
      if (gate) await gate;
      return nextDecision;
    },
  });
  const makeMcp = () =>
    createLocalMcp({
      dataDir,
      host,
      agentScope: () => ({
        projects: { projectPaths: [projectPath], capabilities: ["read", "create"] },
        worktrees: { projectPaths: [projectPath], capabilities: ["read", "create"] },
      }),
    });
  let mcp = makeMcp();
  t.after(() => mcp.close());

  // Cache tool definitions once up front (like Claude's in-process SDK MCP server) to prove currentScope() updates live.
  const cachedTools = mcp.agentTools(caller);
  const worktreeList = cachedTools.find((tool) => tool.name === "worktree_list");
  const projectList = cachedTools.find((tool) => tool.name === "project_list");

  // Two concurrent Allow-once calls share one card and do not persist the grant.
  let release;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = worktreeList.run({ projectPath: otherPath });
  const second = worktreeList.run({ projectPath: otherPath });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].allowForChat, true);
  release();
  gate = null;
  await Promise.all([first, second]);
  assert.deepEqual(mcp.grantedProjects(caller), []);

  // Deny rejects without running.
  nextDecision = "deny";
  await assert.rejects(worktreeList.run({ projectPath: otherPath }), /declined access/);
  assert.equal(approvals.length, 2);

  // Always allow in this chat persists across calls (even on cached tool definitions) and across restarts.
  nextDecision = "allow-for-chat";
  await worktreeList.run({ projectPath: otherPath });
  assert.equal(approvals.length, 3);
  assert.deepEqual(mcp.grantedProjects(caller), [otherPath]);
  await worktreeList.run({ projectPath: otherPath });
  assert.equal(approvals.length, 3, "cached tool definition sees the live Chat grant without prompting again");
  assert.equal(JSON.parse(await projectList.run({})).find((item) => item.path === otherPath).inScope, true);

  await mcp.close();
  mcp = makeMcp();
  assert.deepEqual(mcp.grantedProjects(caller), [otherPath]);
  await mcp
    .agentTools(caller)
    .find((tool) => tool.name === "worktree_list")
    .run({ projectPath: otherPath });
  assert.equal(approvals.length, 3, "persisted Chat grant survives restart");
});

test("project_add validates a Git repo, asks on a card below Full mode, registers the Project, and grants the calling Chat access", async (t) => {
  const { execFileSync } = require("node:child_process");
  const { createLocalMcpHost } = require("./local-mcp-host.cjs");
  const { createLocalMcp } = require("./local-mcp.cjs");
  const dataDir = fixture(t);
  const projectPath = fs.realpathSync(fixture(t));
  const plainDir = fs.realpathSync(fixture(t));
  const gitRepo = fs.realpathSync(fixture(t));
  execFileSync("git", ["init", "-qb", "main", gitRepo]);

  const registered = [{ id: projectPath, path: projectPath, name: "Main" }];
  const approvals = [];
  let mode = "ask";
  const caller = `${projectPath}#2`;
  const host = createLocalMcpHost({
    projects: async () => registered,
    registerProject: async (targetPath) => {
      if (!registered.some((item) => item.path === targetPath))
        registered.push({ id: path.join(targetPath, ".git"), path: targetPath, name: path.basename(targetPath) });
    },
    readProject: async (root) => ({
      state: { worktrees: { 1: { id: 1, path: root, name: "main" } }, sessions: { 2: { id: 2, worktree_id: 1 } } },
    }),
    scopeStates: { chatMessages: async () => [] },
    permissionMode: () => mode,
    chats: { runs: {}, turnSettings: () => ({}), send: async () => ({ sessionId: 2 }) },
    links: { list: async () => [], add: async () => {}, remove: async () => {} },
    activeWorktrees: async (root) => [root],
    approve: async (_chatId, request) => (approvals.push(request.title), "allow"),
  });
  const mcp = createLocalMcp({
    dataDir,
    host,
    agentScope: () => ({
      projects: { projectPaths: [projectPath], capabilities: ["read", "create"] },
      worktrees: { projectPaths: [projectPath], capabilities: ["read", "create"] },
    }),
  });
  t.after(() => mcp.close());

  const tools = mcp.agentTools(caller);
  const projectAdd = tools.find((tool) => tool.name === "project_add");
  const worktreeList = tools.find((tool) => tool.name === "worktree_list");

  await assert.rejects(projectAdd.run({ projectPath: plainDir }), /isn't a Git repository/);
  await assert.rejects(host.addProject({ projectPath: gitRepo }, undefined), /outside client/);

  const added = JSON.parse(await projectAdd.run({ projectPath: gitRepo }));
  assert.deepEqual(added, { id: path.join(gitRepo, ".git"), path: gitRepo, name: path.basename(gitRepo), created: true, inScope: true });
  assert.equal(approvals.length, 1);
  assert.deepEqual(mcp.grantedProjects(caller), [gitRepo]);
  assert.equal(JSON.parse(await worktreeList.run({ projectPath: gitRepo })).length, 1);
  assert.equal(approvals.length, 1, "project_add already granted the calling Chat access");

  mode = "full";
  const again = JSON.parse(await projectAdd.run({ projectPath: gitRepo }));
  assert.equal(again.created, false);
  assert.equal(approvals.length, 1, "Full mode needs no card");
});

test("Bot rules hide unrelated Projects from project_list, Full mode does not persist grants across a return to Ask, forgetProjectGrants prunes grants, and worktree_link requires a main Worktree when targetWorktreeId is omitted", async (t) => {
  const { execFileSync } = require("node:child_process");
  const { createLocalMcpHost } = require("./local-mcp-host.cjs");
  const { createLocalMcp } = require("./local-mcp.cjs");
  const dataDir = fixture(t);
  const projectPath = fs.realpathSync(fixture(t));
  const otherPath = fs.realpathSync(fixture(t));
  const internalRepo = fs.realpathSync(fixture(t));
  execFileSync("git", ["init", "-qb", "main", internalRepo]);

  let mode = "full";
  let botActive = false;
  const approvals = [];
  const caller = `${projectPath}#7`;
  const host = createLocalMcpHost({
    projects: async () => [
      { id: "p-main", path: projectPath, name: "Main" },
      { id: "p-other", path: otherPath, name: "Other" },
    ],
    assertRegistrableProject: async (folder) => {
      if (folder === internalRepo) throw Error("That folder belongs to Milagre's internal state and cannot be registered as a Project.");
    },
    readProject: async (root) => ({
      state: {
        // Other has only a feature Worktree (no path === otherPath) to test default targetWorktreeId safety.
        worktrees: { 1: { id: 1, path: root === otherPath ? path.join(otherPath, "feature") : root, name: "main" } },
        sessions: { 7: { id: 7, worktree_id: 1 } },
      },
    }),
    scopeStates: { chatMessages: async () => [] },
    permissionMode: () => mode,
    botOf: () => (botActive ? "Triager" : null),
    chats: { runs: {}, turnSettings: () => ({}), send: async () => ({ sessionId: 7 }) },
    links: { list: async () => [], add: async () => {}, remove: async () => {} },
    activeWorktrees: async (root) => [root === otherPath ? path.join(otherPath, "feature") : root],
    approve: async (_chatId, request) => (approvals.push(request), "allow-for-chat"),
  });
  const mcp = createLocalMcp({
    dataDir,
    host,
    agentScope: () => ({
      projects: { projectPaths: [projectPath], capabilities: botActive ? ["read"] : ["read", "create"] },
      worktrees: { projectPaths: [projectPath], capabilities: botActive ? ["read"] : ["read", "create"] },
    }),
  });
  t.after(() => mcp.close());

  const cachedTools = mcp.agentTools(caller);
  const projectList = cachedTools.find((tool) => tool.name === "project_list");
  const worktreeList = cachedTools.find((tool) => tool.name === "worktree_list");
  const worktreeLink = cachedTools.find((tool) => tool.name === "worktree_link");
  const projectAdd = cachedTools.find((tool) => tool.name === "project_add");

  // Full mode approves out-of-scope calls without persisting a permanent Chat grant.
  await worktreeList.run({ projectPath: otherPath });
  assert.deepEqual(mcp.grantedProjects(caller), []);
  assert.equal(approvals.length, 0);

  // Returning to Ask mode prompts again because Full mode did not persist the grant.
  mode = "ask";
  await assert.rejects(projectAdd.run({ projectPath: internalRepo }), /internal state/);
  assert.equal(approvals.length, 0, "disallowed internal paths fail before showing an approval card");

  // Omitting targetWorktreeId refuses to guess a feature Worktree when no main Worktree matches projectPath.
  await assert.rejects(worktreeLink.run({ projectPath, worktreeId: 1, targetProjectPath: otherPath }), /No main Worktree in .* pass targetWorktreeId/);

  // Always allow in Ask mode persists the grant; forgetting either Project prunes chat-grants.json.
  await worktreeList.run({ projectPath: otherPath });
  assert.deepEqual(mcp.grantedProjects(caller), [otherPath]);

  // Entering Bot rules hides out-of-scope Projects on both cached and fresh tool definitions and blocks out-of-scope calls.
  botActive = true;
  assert.deepEqual(JSON.parse(await projectList.run({})), [{ id: "p-main", path: projectPath, name: "Main" }]);
  assert.deepEqual(
    JSON.parse(
      await mcp
        .agentTools(caller)
        .find((tool) => tool.name === "project_list")
        .run({}),
    ),
    [{ id: "p-main", path: projectPath, name: "Main" }],
  );

  botActive = false;
  mcp.forgetProjectGrants(otherPath);
  assert.deepEqual(mcp.grantedProjects(caller), []);
});
