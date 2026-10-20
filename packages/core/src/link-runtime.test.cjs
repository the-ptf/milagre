const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { scopeKey, chatKeyForScope } = require("@milagre/shared/chat-scopes");
// `approvals`: sessions keep their turn's permission mode and hold Milagre's approval cards in it, as real ones do.
async function fixture(t, { approvals = null } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-link-runtime-")));
  const events = [],
    created = [],
    runtimes = [],
    turns = [],
    // The Projects the fake agent changes, by name: each gets the shared Chat's Worktree first, as a real agent's would.
    edits = ["api", "web", "admin"];
  const options = {
    dataDir: path.join(dir, "profile"),
    worktreeRoot: path.join(dir, "worktrees"),
    registryRoots: [],
    version: "test",
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "/fake" }),
    emit: (channel, payload) => events.push({ channel, payload }),
    createSession: (provider, context) => {
      created.push(context);
      const permissions = approvals && {
        mode: "ask",
        add(request, answer) {
          if (this.mode === "full") return answer("allow");
          approvals.push({ chat: context, request, answer });
        },
      };
      return {
        turnActive: false,
        ...(permissions ? { permissions } : {}),
        startTurn(request) {
          if (permissions && request?.permissionMode) permissions.mode = request.permissionMode;
          const run = (async () => {
            const create = context.linked?.tools.find((tool) => tool.name === "link_worktree_create");
            // A Project outside the Link refuses; the agent goes on with the others.
            if (create) for (const project of edits) await create.run({ project }).catch(() => {});
            // The turn id it announces is the one it returns, as a real session's: a Delegation follows its turn by it.
            const turnId = randomUUID();
            context.emit({ type: "session-started", nativeId: "native" });
            context.emit({ type: "turn-started", turnId });
            context.emit({ type: "text-delta", messageId: "reply", text: "Changed both" });
            context.emit({ type: "turn-completed" });
            return { turnId };
          })();
          turns.push(run);
          return run;
        },
        close() {},
        interrupt() {},
      };
    },
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const make = () => {
    const runtime = createRuntime(options);
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = make();
  for (const name of ["api", "web"]) {
    const folder = path.join(dir, name);
    await fs.mkdir(folder);
    execFileSync("git", ["init", "-qb", "main", folder]);
    execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Initial"]);
    await runtime.openProject(folder);
  }
  const projects = await runtime.invoke("project:registry");
  // link:send resolves before its turn starts: this waits for the first `count` turns and saves what they did.
  const settle = async (count, current = runtime) => {
    for (let i = 0; i < 200 && turns.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    await Promise.all(turns);
    await current.flush();
  };
  return { dir, runtime, make, projects, events, created, edits, settle };
}
test("shared Chat keeps one canonical transcript and exact Worktrees across retries and restart", async (t) => {
  const { runtime, make, projects, events, created, settle } = await fixture(t);
  assert.ok(runtime.methods.includes("link:create"));
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((p) => p.id) }]);
  const opened = await runtime.invoke("link:open", [link.id]);
  assert.deepEqual(opened.state.sessions, {});
  const request = { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Edit both", provider: "codex", model: "test", permissionMode: "auto" };
  const sent = await runtime.invoke("link:send", [request]);
  await settle(1);
  const state = (await runtime.invoke("link:snapshot", [link.id])).state;
  const session = state.sessions[sent.sessionId];
  assert.equal(session.worktrees.length, 2);
  // The agent started with no Worktree and owns each one it made, in the same session.
  assert.equal(created.length, 1);
  assert.equal(created[0].access.roots.length, 2);
  assert.equal(created[0].cwd, session.workspacePath);
  assert.equal(state.messages.filter((m) => m.body === "Changed both").length, 1);
  assert.deepEqual(await runtime.invoke("link:send", [request]), sent);
  await runtime.close();
  const next = make();
  const reopened = await next.invoke("link:open", [link.id]);
  assert.deepEqual(reopened.state.sessions[sent.sessionId].worktrees, session.worktrees);
  const owner = scopeKey({ kind: "link", linkId: link.id });
  await next.invoke("chat:patch", [owner, sent.sessionId, { title: "Shared saved", archived: true }]);
  assert.equal((await next.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId].title, "Shared saved");
  assert.ok(events.some((event) => event.channel === "link:state"));
  for (const project of projects) {
    const view = await next.openProject(project.path);
    const shared = Object.values(view.state.worktrees).find((w) => w.sharedChat);
    assert.ok(shared);
    assert.equal(
      Object.values(view.state.sessions).some((s) => s.worktree_id === shared.id),
      false,
    );
  }
});
test("desktop and phone can open a linked Chat Terminal before its first Worktree exists", async (t) => {
  const { runtime, projects, edits, settle } = await fixture(t);
  edits.length = 0;
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const request = { linkId: link.id, operationId: randomUUID(), body: "Read the projects", provider: "codex", model: "test", permissionMode: "auto" };
  const sent = await runtime.invoke("link:send", [request]);
  await settle(1);
  const session = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  const scope = { kind: "link", linkId: link.id };
  const chatId = chatKeyForScope(scope, sent.sessionId);
  assert.deepEqual(session.worktrees, []);
  for (const clientId of ["desktop", "phone"]) {
    const context = { clientId };
    const terminal = await runtime.invoke("terminal:open", [{ chatId }], context);
    assert.equal(terminal.cwd, session.workspacePath);
    assert.equal(terminal.label, "Workspace");
    await runtime.invoke("terminal:close", [{ terminalId: terminal.id }], context);
    await assert.rejects(runtime.invoke("terminal:open", [{ chatId, cwd: projects[0].path }], context), /Choose one of this Chat's Worktrees/);
  }
  assert.deepEqual((await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId].worktrees, []);
  for (const project of projects) assert.equal(execFileSync("git", ["-C", project.path, "worktree", "list"]).toString().trim().split("\n").length, 1);

  // Once a member Worktree exists, new Terminals use it as before.
  edits.push("web");
  await runtime.invoke("link:send", [{ ...request, sessionId: sent.sessionId, operationId: randomUUID(), body: "Edit web" }]);
  await settle(2);
  const updated = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  const context = { clientId: "desktop" };
  const terminal = await runtime.invoke("terminal:open", [{ chatId }], context);
  assert.equal(terminal.cwd, updated.worktrees[0].worktreePath);
  await runtime.invoke("terminal:close", [{ terminalId: terminal.id }], context);
  await runtime.invoke("chat:patch", [scopeKey(scope), sent.sessionId, { archived: true }]);
  await assert.rejects(runtime.invoke("terminal:open", [{ chatId }], context), /archived/);
});

test("missing Project leaves shared history readable but blocks sends", async (t) => {
  const { runtime, projects } = await fixture(t);
  assert.ok(runtime.methods.includes("link:create"));
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((p) => p.id) }]);
  await runtime.invoke("link:open", [link.id]);
  await fs.rename(projects[0].path, projects[0].path + "-moved");
  try {
    assert.ok((await runtime.invoke("link:open", [link.id])).state);
    await assert.rejects(runtime.invoke("link:send", [{ linkId: link.id, operationId: randomUUID(), body: "Edit" }]), /unavailable/);
  } finally {
    await fs.rename(projects[0].path + "-moved", projects[0].path);
  }
});

test("Git accepts a selected member and refuses the aggregate workspace; editor roots are explicitly validated", async (t) => {
  const { runtime, projects, settle } = await fixture(t);
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((p) => p.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const sent = await runtime.invoke("link:send", [
    { linkId: link.id, operationId: randomUUID(), sessionId: null, body: "Edit", provider: "codex", model: "test", permissionMode: "auto" },
  ]);
  await settle(1);
  const session = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  await assert.rejects(runtime.invoke("git:changes", [{ cwd: session.workspacePath }]), /folder/);
  assert.ok((await runtime.invoke("git:changes", [{ cwd: session.worktrees[1].worktreePath }])).isRepo);
  assert.deepEqual(
    await runtime.invoke("link:workspace-roots", [session.workspacePath]),
    session.worktrees.map((member) => member.worktreePath),
  );
  await assert.rejects(runtime.invoke("link:workspace-roots", ["/"]), /workspace/);
});
test("a plain directory replacing a registered member Worktree cannot start a provider", async (t) => {
  const { runtime, projects, created, settle } = await fixture(t);
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const request = { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Edit", provider: "codex", model: "test", permissionMode: "auto" };
  const sent = await runtime.invoke("link:send", [request]);
  await settle(1);
  const session = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  const member = session.worktrees[0];
  execFileSync("git", ["-C", member.projectPath, "worktree", "remove", member.worktreePath]);
  await fs.mkdir(member.worktreePath);
  const count = created.length;
  await assert.rejects(runtime.invoke("link:send", [{ ...request, sessionId: session.id, operationId: randomUUID() }]), /Worktree.*unavailable/);
  assert.equal(created.length, count);
});
test("unavailable owned Worktrees keep an interrupted turn resumable after repair", async (t) => {
  const { runtime, projects, dir, make, settle } = await fixture(t);
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const sent = await runtime.invoke("link:send", [
    { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Edit", provider: "codex", model: "test", permissionMode: "auto" },
  ]);
  await settle(1);
  const owner = scopeKey({ kind: "link", linkId: link.id });
  const resumeTurn = { stoppedAt: Date.now(), provider: "codex", model: "test", permissionMode: "auto", prompt: "Continue" };
  const session = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  const root = session.worktrees[0].worktreePath;
  await runtime.close();
  const file = path.join(dir, "profile", "links", link.id, ".milagre", "coordination.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.sessions[sent.sessionId].resumeTurn = resumeTurn;
  await fs.writeFile(file, JSON.stringify(saved));
  const next = make();
  await fs.rename(root, root + "-moved");
  try {
    await next.invoke("link:open", [link.id]);
    assert.deepEqual((await next.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId].resumeTurn, resumeTurn);
  } finally {
    await fs.rename(root + "-moved", root);
  }
  assert.equal(await next.invoke("chat:resume", [owner, sent.sessionId]), true);
});
test("shared Chats retain canvas reads and external readers see the canonical transcript", async (t) => {
  const { runtime, projects, created, settle } = await fixture(t);
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const request = { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Edit", provider: "codex", model: "test", permissionMode: "auto" };
  const sent = await runtime.invoke("link:send", [request]);
  await settle(1);
  const session = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  const member = session.worktrees[0],
    external = projects.find((project) => project.id !== member.projectId);
  await runtime.invoke("canvas:link-add", [
    { project_id: member.projectId, worktree_path: member.worktreePath },
    { project_id: external.id, worktree_path: external.path },
  ]);
  const tools = created[0].linked.tools;
  assert.ok((await tools.find((tool) => tool.name === "linked_overview").run()).includes(external.path));
  const current = await runtime.openProject(external.path),
    starter = Object.values(current.state.sessions)[0];
  await runtime.invoke("chat:send", [
    { projectPath: external.path, sessionId: starter.id, body: "Read shared work", provider: "codex", model: "test", permissionMode: "auto" },
  ]);
  await settle(2);
  assert.equal(created.length, 2, "External provider started");
  const ordinaryTools = created.at(-1).linked.tools;
  const ref = chatKeyForScope({ kind: "link", linkId: link.id }, session.id);
  assert.match(await ordinaryTools.find((tool) => tool.name === "linked_overview").run(), new RegExp(ref));
  assert.match(await ordinaryTools.find((tool) => tool.name === "read_linked_chat").run({ chat: ref }), /Changed both/);
  await assert.rejects(
    ordinaryTools.find((tool) => tool.name === "delegate").run({ worktree: member.worktreePath, chat: ref, message: "Edit this" }),
    /Delegation into a shared Link Chat is not supported/,
  );
});
test("editing a Link adds and removes member Projects for new Chats; existing Chats keep their Worktrees", async (t) => {
  const { dir, runtime, projects, edits, settle } = await fixture(t);
  const folder = path.join(dir, "admin");
  await fs.mkdir(folder);
  execFileSync("git", ["init", "-qb", "main", folder]);
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Initial"]);
  await runtime.openProject(folder);
  const admin = (await runtime.invoke("project:registry")).find((project) => project.path === folder);
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const request = { linkId: link.id, sessionId: null, provider: "codex", model: "test", permissionMode: "auto", body: "Edit" };
  // The fake agent changes the Projects in the Link's order, so each Chat lists them in it.
  edits.splice(0, edits.length, ...projects.map((project) => path.basename(project.path)), "admin");
  const first = await runtime.invoke("link:send", [{ ...request, operationId: randomUUID() }]);
  await settle(1);
  assert.ok(runtime.methods.includes("link:update"), "Link membership can be edited");
  const edited = await runtime.invoke("link:update", [{ id: link.id, name: " Food v2 ", projectIds: [projects[1].id, admin.id] }]);
  assert.deepEqual(edited, { ...link, name: "Food v2", projectIds: [projects[1].id, admin.id] });
  assert.deepEqual(await runtime.invoke("link:list"), [edited]);
  await assert.rejects(runtime.invoke("link:update", [{ id: link.id, name: "Food", projectIds: [admin.id] }]), /two/);
  const second = await runtime.invoke("link:send", [{ ...request, operationId: randomUUID() }]);
  await settle(2);
  const state = (await runtime.invoke("link:snapshot", [link.id])).state;
  assert.deepEqual(
    state.sessions[second.sessionId].worktrees.map((member) => member.projectId),
    [projects[1].id, admin.id],
  );
  assert.deepEqual(
    state.sessions[first.sessionId].worktrees.map((member) => member.projectId),
    projects.map((project) => project.id),
  );
  await runtime.invoke("link:send", [{ ...request, sessionId: first.sessionId, operationId: randomUUID() }]);
});
test("a shared Chat that changes one Project creates no branch or Worktree in the other", async (t) => {
  const { runtime, projects, created, edits, settle } = await fixture(t);
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  edits.splice(0, edits.length, "web");
  const sent = await runtime.invoke("link:send", [
    { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Fix the web header", provider: "codex", model: "test", permissionMode: "auto" },
  ]);
  await settle(1);
  const session = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  const [web, api] = ["web", "api"].map((name) => projects.find((project) => path.basename(project.path) === name));
  assert.deepEqual(
    session.worktrees.map((member) => member.projectId),
    [web.id],
  );
  assert.equal(execFileSync("git", ["-C", api.path, "branch", "--list", "milagre/*"]).toString().trim(), "");
  assert.equal(execFileSync("git", ["-C", api.path, "worktree", "list"]).toString().trim().split("\n").length, 1);
  // The agent was told to read api from its main checkout, and now owns web's Worktree.
  assert.match(created[0].workspaceInstructions, new RegExp(`api: ${api.path}`));
  assert.deepEqual(created[0].access.roots, [session.worktrees[0].worktreePath]);
  assert.deepEqual(created[0].access.readOnlyRoots, [api.path]);
});

test("a shared Chat manages its Link's Projects through Milagre's tools and delegates to their Chats", async (t) => {
  const { runtime, projects, created, settle } = await fixture(t);
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const request = { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Plan", provider: "codex", model: "test", permissionMode: "auto" };
  const sent = await runtime.invoke("link:send", [request]);
  await settle(1);
  const tools = created[0].linked.tools;
  const tool = (name) => tools.find((item) => item.name === name);
  for (const name of ["worktree_list", "worktree_create", "chat_list", "chat_start", "delegate"]) assert.ok(tool(name), `${name} is there`);
  const web = projects.find((project) => path.basename(project.path) === "web");
  assert.ok(JSON.parse(await tool("worktree_list").run({ projectPath: web.path })).some((item) => item.path === web.path));
  const outside = path.join(path.dirname(web.path), "elsewhere");
  await assert.rejects(tool("worktree_list").run({ projectPath: outside }), /scope/);

  const shared = chatKeyForScope({ kind: "link", linkId: link.id }, sent.sessionId);
  assert.match(await tool("delegate").run({ worktree: web.path, chat: "new", message: "Add the menu route" }), /^Delegation sent to web \/ main \/ a new Chat/);
  await assert.rejects(tool("delegate").run({ worktree: web.path, chat: "new", message: "Agree first", negotiation: true }), /do not host Negotiations/);
  await settle(2);
  const report = await (async () => {
    for (let i = 0; i < 200; i++) {
      const state = (await runtime.invoke("link:snapshot", [link.id])).state;
      const found = state.messages.find((message) => message.session_id === sent.sessionId && message.context?.kind === "delegation-report");
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  })();
  assert.ok(report, "the report comes back to the shared Chat");
  assert.equal(report.body, "Changed both");
  const received = Object.values((await runtime.invoke("project:snapshot", [web.path])).state.messages).find(
    (message) => message.context?.kind === "delegation",
  );
  assert.equal(received.context.from, shared);
  assert.equal(received.context.fromLabel, "Food / Plan");
});

test("a shared Chat in Ask asks before its delegate or chat_start reaches a member-Project Chat in Full", async (t) => {
  const approvals = [];
  const { runtime, projects, created, settle } = await fixture(t, { approvals });
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  await runtime.invoke("link:send", [
    { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Plan", provider: "codex", model: "test", permissionMode: "ask" },
  ]);
  await settle(1);
  const tool = (name) => created[0].linked.tools.find((item) => item.name === name);
  const web = projects.find((project) => path.basename(project.path) === "web");
  const starter = Object.values((await runtime.openProject(web.path)).state.sessions)[0];
  await runtime.invoke("chat:send", [{ projectPath: web.path, sessionId: starter.id, body: "Work", provider: "codex", model: "test", permissionMode: "full" }]);
  await settle(2);
  const target = `${web.path}#${starter.id}`;
  const received = async () =>
    Object.values((await runtime.invoke("project:snapshot", [web.path])).state.messages).filter((message) => message.body === "Delete the build");

  // The card shows in the shared Chat, found by the same key its session and its MCP caller use.
  const delegating = tool("delegate").run({ worktree: web.path, chat: target, message: "Delete the build" });
  for (let i = 0; i < 200 && !approvals.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(approvals[0].chat, created[0]);
  assert.equal(approvals[0].request.title, `Send a Delegation to web / main / Work in Full permission?`);
  assert.equal(approvals[0].request.allowForChat, false);
  approvals[0].answer("deny");
  await assert.rejects(delegating, /denied/);

  const starting = tool("chat_start").run({ projectPath: web.path, chatId: target, prompt: "Delete the build", requestId: "r1" });
  for (let i = 0; i < 200 && approvals.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(approvals[1].chat, created[0]);
  assert.match(approvals[1].request.title, /^Run a prompt in .* in Full permission\?$/);
  approvals[1].answer("deny");
  await assert.rejects(starting, /declined/);
  assert.deepEqual(await received(), [], "nothing reached the Full Chat");
});
