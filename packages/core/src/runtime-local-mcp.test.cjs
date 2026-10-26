const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "runtime-mcp-")));
  const project = path.join(directory, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-qb", "main", project]);
  execFileSync("git", [
    "-C",
    project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-qm",
    "Initial",
  ]);
  const events = [],
    sessions = [],
    runtimes = [];
  const make = () => {
    const runtime = createRuntime({
      dataDir: path.join(directory, "data"),
      cwd: project,
      localMcpClients: { home: path.join(directory, "home"), env: {}, platform: "darwin" },
      worktreeRoot: path.join(directory, "worktrees"),
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: async () => ({ command: "fixture" }),
      emit: (channel, payload) => events.push({ channel, payload }),
      createSession(provider, options) {
        const session = {
          provider,
          options,
          turns: [],
          turnActive: false,
          permissions: { mode: "ask" },
          startTurn: async (request) => {
            session.turns.push(request);
            session.permissions.mode = request.permissionMode;
            session.turnActive = true;
            options.emit({ type: "turn-started", turnId: "turn" });
            return { turnId: "turn" };
          },
          close: async () => {},
          interrupt: async () => {
            session.turnActive = false;
            options.emit({ type: "turn-cancelled" });
          },
        };
        sessions.push(session);
        return session;
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const runtime = make();
  const opened = await runtime.openProject(project);
  return { runtime, make, project, opened, directory, events, sessions };
}
async function call(connection, name, args = {}) {
  const response = await fetch(connection.url, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const payload = await response.json();
  if (payload.result.isError) throw Error(payload.result.content[0].text);
  // design_show and design_apply put their JSON summary on the first line, then notes for the agent.
  return JSON.parse(payload.result.content[0].text.split("\n", 1)[0]);
}

test("a local MCP send stays queued through Stop and a retry after restart", async (t) => {
  const f = await fixture(t);
  const grants = { chats: { projectPaths: [f.project], capabilities: ["read", "create", "start"] } };
  const connection = await f.runtime.invoke("local-mcp:create", [{ label: "Local editor", grants }]);
  const id = Object.values(f.opened.state.sessions)[0].id;
  const chatId = `${f.project}#${id}`;
  await f.runtime.invoke("chat:send", [{ projectPath: f.project, sessionId: id, body: "Working", provider: "antigravity", model: "fixture" }]);
  await waitUntil(() => f.sessions[0]?.turns.length === 1);
  const args = { projectPath: f.project, chatId, prompt: "Next task", requestId: "queued-task" };
  await call(connection, "chat_start", args);
  const queued = f.runtime.snapshot().projects[0].state.sessions[id].queued;
  assert.equal(queued?.length, 1, "MCP messages must enter the durable Chat queue");
  assert.equal(f.sessions[0].turns.length, 1);
  await f.runtime.invoke("agent:interrupt", [chatId]);
  await f.runtime.close();
  const journalFile = path.join(f.directory, "data/local-mcp/operations.json");
  const journal = JSON.parse(await fs.readFile(journalFile, "utf8"));
  for (const record of Object.values(journal)) {
    record.status = "pending";
    delete record.result;
  }
  await fs.writeFile(journalFile, JSON.stringify(journal), { mode: 0o600 });
  const restarted = f.make();
  await restarted.openProject(f.project);
  await restarted.invoke("local-mcp:status");
  assert.deepEqual(await call(connection, "chat_start", args), { chatId, accepted: true });
  assert.equal(restarted.snapshot().projects[0].state.sessions[id].queued.length, 1);
  assert.equal(f.sessions.length, 1, "reconciling the queued operation must not start another turn");
  await restarted.invoke("chat:queue-send", [chatId, queued[0].id]);
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  // The queued message keeps who sent it through the restart, and the Chat's queue line and bubble show only what was typed.
  assert.equal(queued[0].body, "Next task");
  assert.equal(f.sessions[1].turns[0].prompt, "Message sent by Local editor through Milagre's MCP (not the user):\n\nNext task");
});

test("host MCP registers Worktrees, prepares setup, starts Chats in Ask mode and preserves retry results after restart", async (t) => {
  const f = await fixture(t);
  const grants = Object.fromEntries(
    [
      ["projects", ["read"]],
      ["worktrees", ["read", "create"]],
      ["chats", ["read", "create", "start"]],
    ].map(([group, capabilities]) => [group, { projectPaths: [f.project], capabilities }]),
  );
  const connection = await f.runtime.invoke("local-mcp:create", [{ label: "Local editor", grants }]);
  await f.runtime.invoke("worktree-setup:save", [f.project, `node -e "require('fs').writeFileSync('setup-proof','ready')"`]);
  assert.equal((await call(connection, "project_list"))[0].path, f.project);
  await assert.rejects(call(connection, "worktree_list", { projectPath: path.dirname(f.project) }), /scope/);
  const created = await call(connection, "worktree_create", { projectPath: f.project, baseBranch: "main", prompt: "MCP task", requestId: "worktree-1" });
  assert.ok(created.worktreeId);
  assert.deepEqual(
    await call(connection, "worktree_create", { projectPath: f.project, baseBranch: "main", prompt: "MCP task", requestId: "worktree-1" }),
    created,
  );
  const tree = (await call(connection, "worktree_list", { projectPath: f.project })).find((item) => item.id === created.worktreeId);
  assert.ok(tree.path.startsWith(path.join(f.directory, "worktrees")));
  assert.ok(f.events.some((event) => event.channel === "project:state"));
  const chat = await call(connection, "chat_create", { projectPath: f.project, worktreeId: created.worktreeId, requestId: "chat-1" });
  const sent = await call(connection, "chat_start", {
    projectPath: f.project,
    chatId: chat.chatId,
    prompt: "Inspect the project",
    provider: "claude",
    model: "fixture",
    requestId: "turn-1",
  });
  await waitUntil(() => f.sessions.length === 1 && f.sessions[0].turns.length === 1);
  assert.equal(f.sessions[0].turns[0].prompt, "Message sent by Local editor through Milagre's MCP (not the user):\n\nInspect the project");
  assert.equal(await fs.readFile(path.join(tree.path, "setup-proof"), "utf8"), "ready");
  assert.equal(f.sessions[0].turns[0].permissionMode, "ask");
  const agentUrl = await f.sessions[0].options.linked.url();
  assert.equal(new URL(agentUrl).port, new URL(connection.url).port);
  assert.ok(f.sessions[0].options.linked.tools.some((tool) => tool.name === "worktree_create"));
  assert.deepEqual(
    await call(connection, "chat_start", {
      projectPath: f.project,
      chatId: chat.chatId,
      prompt: "Inspect the project",
      provider: "claude",
      model: "fixture",
      requestId: "turn-1",
    }),
    sent,
  );
  assert.equal(f.sessions[0].turns.length, 1);
  await assert.rejects(
    call(connection, "chat_start", { projectPath: f.project, chatId: chat.chatId, prompt: "Escalate", permissionMode: "full", requestId: "turn-2" }),
    /outside client can't ask for/,
  );
  assert.ok(
    (await call(connection, "chat_read", { projectPath: f.project, chatId: chat.chatId })).messages.some((message) => message.body === "Inspect the project"),
  );
  await f.runtime.invoke("agent:interrupt", [chat.chatId]);
  await f.runtime.close();
  // Simulate a crash after host persistence but before the journal acknowledged completion.
  const journalFile = path.join(f.directory, "data/local-mcp/operations.json");
  const journal = JSON.parse(await fs.readFile(journalFile, "utf8"));
  for (const record of Object.values(journal)) {
    record.status = "pending";
    delete record.result;
  }
  await fs.writeFile(journalFile, JSON.stringify(journal), { mode: 0o600 });
  const restarted = f.make();
  const status = await restarted.invoke("local-mcp:status");
  assert.equal(status.url, connection.url);
  assert.deepEqual(
    await call(connection, "worktree_create", { projectPath: f.project, baseBranch: "main", prompt: "MCP task", requestId: "worktree-1" }),
    created,
  );
  assert.deepEqual(await call(connection, "chat_create", { projectPath: f.project, worktreeId: created.worktreeId, requestId: "chat-1" }), chat);
  assert.deepEqual(
    await call(connection, "chat_start", {
      projectPath: f.project,
      chatId: chat.chatId,
      prompt: "Inspect the project",
      provider: "claude",
      model: "fixture",
      requestId: "turn-1",
    }),
    sent,
  );
  assert.equal(f.sessions.length, 1, "reconciliation must not start a second provider session");
  assert.ok(!JSON.stringify(status).includes(connection.token));
});

test("a Chat an agent starts through its own MCP takes the calling Chat's permission mode", async (t) => {
  const f = await fixture(t);
  const caller = Object.values(f.opened.state.sessions)[0];
  await f.runtime.invoke("chat:send", [
    { projectPath: f.project, sessionId: caller.id, body: "Delegate", provider: "claude", model: "fixture", permissionMode: "full" },
  ]);
  await waitUntil(() => f.sessions.length === 1 && f.sessions[0].turns.length === 1);
  const agent = { url: await f.sessions[0].options.linked.url(), token: "" };
  const created = await call(agent, "worktree_create", { projectPath: f.project, baseBranch: "main", requestId: "worktree-1" });
  const chat = await call(agent, "chat_create", { projectPath: f.project, worktreeId: created.worktreeId, requestId: "chat-1" });
  await call(agent, "chat_start", { projectPath: f.project, chatId: chat.chatId, prompt: "Review the PR", model: "fixture", requestId: "turn-1" });
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  assert.equal(f.sessions[1].turns[0].permissionMode, "full");
  // The agent is told another agent sent it; the Chat's bubble shows the message as sent.
  assert.match(f.sessions[1].turns[0].prompt, /^Message from the agent of Chat .*, sent with Milagre's chat_start \(not the user\):\n\nReview the PR$/);
  const bubble = (await f.runtime.invoke("project:snapshot", [f.project])).state.messages.find((m) => m.role === "user" && m.body === "Review the PR");
  assert.ok(bubble, "the message shows as typed");
});

test("design-only configuration never exposes management or public publishing", async (t) => {
  const f = await fixture(t);
  const chatId = `${f.project}#${Object.values(f.opened.state.sessions)[0].id}`;
  const connection = await f.runtime.invoke("local-mcp:create", [
    { label: "Designs", grants: { designs: { chatId, designIds: "*", capabilities: ["read", "write"] } } },
  ]);
  await assert.rejects(call(connection, "project_list"), /unavailable/);
  await assert.rejects(call(connection, "worktree_create", {}), /unavailable/);
  await assert.rejects(call(connection, "design_publish", {}), /unavailable/);
  const document = { schemaVersion: 1, width: 390, height: 844, nodes: [] };
  const created = await call(connection, "design_show", { id: "page", title: "Page", document });
  assert.equal(created.version, 1);
  assert.equal((await call(connection, "design_list"))[0].id, "page");
  assert.deepEqual((await call(connection, "design_read", { id: "page" })).document, document);
  const edited = await call(connection, "design_apply", {
    id: "page",
    expectedVersion: 1,
    operations: [{ op: "insert", node: { id: "box", type: "rectangle", width: 10, height: 10 } }],
  });
  assert.equal(edited.version, 2);
  assert.equal((await call(connection, "design_read", { id: "page" })).document.nodes[0].id, "box");
  await f.runtime.invoke("designs:enabled:save", [false]);
  await assert.rejects(call(connection, "design_list"), /unavailable/);
  await f.runtime.invoke("designs:enabled:save", [true]);
  assert.equal((await call(connection, "design_list"))[0].version, 2);
  await f.runtime.invoke("local-mcp:revoke", [connection.connection.id]);
  assert.equal((await fetch(connection.url, { headers: { authorization: `Bearer ${connection.token}` } })).status, 401);
});

test("client setup uses the owning runtime and status never returns installed credentials", async (t) => {
  const f = await fixture(t);
  const result = await f.runtime.invoke("local-mcp:enableClient", [
    "claude-code",
    {
      label: "Claude Code CLI",
      grants: { projects: { projectPaths: [f.project], capabilities: ["read"] } },
    },
  ]);
  assert.equal(result.state, "configured");
  const clientConfig = JSON.parse(await fs.readFile(result.configPath, "utf8")).mcpServers["milagre-local"];
  const token = clientConfig.headers.Authorization.slice(7);
  const connection = { url: clientConfig.url, token };
  assert.equal((await call(connection, "project_list"))[0].path, f.project);
  await assert.rejects(call(connection, "worktree_create", { projectPath: f.project, baseBranch: "main", requestId: "denied" }), /unavailable/);
  assert.ok(!JSON.stringify(await f.runtime.invoke("local-mcp:status")).includes(token));
  assert.ok(!JSON.stringify(f.events).includes(token));
  await f.runtime.invoke("local-mcp:disableClient", ["claude-code"]);
  assert.equal((await fetch(connection.url, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.ok(!(await fs.readFile(result.configPath, "utf8")).includes(token));
});

test("host MCP removes a clean Worktree it made, and keeps one with uncommitted files", async (t) => {
  const f = await fixture(t);
  const grants = Object.fromEntries(
    [
      ["worktrees", ["read", "create"]],
      ["chats", ["read", "create", "start"]],
    ].map(([group, capabilities]) => [group, { projectPaths: [f.project], capabilities }]),
  );
  const connection = await f.runtime.invoke("local-mcp:create", [{ label: "Cleaner", grants }]);
  const created = await call(connection, "worktree_create", { projectPath: f.project, baseBranch: "main", prompt: "", requestId: "worktree-1" });
  const tree = (await call(connection, "worktree_list", { projectPath: f.project })).find((item) => item.id === created.worktreeId);
  await fs.writeFile(path.join(tree.path, "draft.txt"), "work in progress");
  await assert.rejects(call(connection, "worktree_remove", { projectPath: f.project, worktreeId: created.worktreeId }), /1 uncommitted file, so it is kept/);
  assert.ok((await fs.stat(tree.path)).isDirectory(), "kept");
  await fs.rm(path.join(tree.path, "draft.txt"));
  const removed = await call(connection, "worktree_remove", { projectPath: f.project, worktreeId: created.worktreeId });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchDeleted, true);
  await assert.rejects(fs.stat(tree.path), { code: "ENOENT" });
  assert.equal(
    (await call(connection, "worktree_list", { projectPath: f.project })).some((item) => item.id === created.worktreeId),
    false,
  );
  await assert.rejects(call(connection, "worktree_remove", { projectPath: f.project, worktreeId: 1 }), /Milagre didn't create this Worktree/);
});

test("a Chat mention reaches an active steering turn without repeating linked context", async (t) => {
  const f = await fixture(t);
  const source = Object.values(f.opened.state.sessions)[0];
  await f.runtime.invoke("chat:send", [
    { projectPath: f.project, sessionId: source.id, body: "Decision: keep the daemon state in SQLite", provider: "claude", model: "fixture" },
  ]);
  await waitUntil(() => f.sessions[0]?.turns.length === 1);
  f.sessions[0].turnActive = false;
  f.sessions[0].options.emit({ type: "turn-completed" });
  await f.runtime.invoke("chat:patch", [f.project, source.id, { title: "Storage decision" }]);
  const receiver = await f.runtime.invoke("chat:send", [
    { projectPath: f.project, worktreeId: source.worktree_id, body: "Begin work", provider: "claude", model: "fixture" },
  ]);
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  await f.runtime.invoke("chat:send", [
    { projectPath: f.project, sessionId: receiver.sessionId, body: `While working, read @chat:${source.id}`, provider: "claude", model: "fixture" },
  ]);
  await waitUntil(() => f.sessions[1].turns.length === 2);
  const steering = f.sessions[1].turns[1].prompt;
  assert.ok(steering.includes("<chat_mentions>"));
  assert.ok(steering.includes(`chatId: "${f.project}#${source.id}"`));
  assert.ok(!steering.includes("<linked_worktrees>"));
});
