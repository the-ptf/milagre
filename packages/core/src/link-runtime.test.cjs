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
// `hold`: each turn stays running until the promise it returns settles.
async function fixture(t, { approvals = null, hold = null } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-link-runtime-")));
  const events = [],
    created = [],
    runtimes = [],
    turns = [],
    // The Projects the fake agent changes, by name: each gets the shared Chat's Worktree first, as a real agent's would.
    edits = ["api", "web", "admin"];
  const options = {
    dataDir: path.join(dir, "profile"),
    chatsHome: path.join(dir, "chats"),
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
            if (hold) await hold();
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
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
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

async function existingLink(fixture) {
  const { runtime, projects, dir } = fixture;
  const sides = [];
  for (const [index, project] of projects.entries()) {
    const folder = path.join(dir, `existing-${index}`);
    execFileSync("git", ["-C", project.path, "worktree", "add", "-qb", `existing-${index}`, folder]);
    await fs.writeFile(path.join(folder, "keep.txt"), `unsaved ${index}`);
    const opened = await runtime.openProject(project.path);
    const worktree = Object.values(opened.state.worktrees).find((item) => item.path === folder);
    const session = Object.values(opened.state.sessions).find((item) => item.worktree_id === worktree.id);
    sides.push({ project, worktree, session });
  }
  const links = await runtime.invoke(
    "canvas:link-add",
    sides.map(({ project, worktree }) => ({ project_id: project.id, worktree_path: worktree.path })),
  );
  return { sides, link: links.at(-1) };
}

test("canvas Chat modes adopt exact Worktrees, preserve old histories, and release without deleting work", async (t) => {
  const f = await fixture(t);
  f.edits.length = 0;
  const { sides, link } = await existingLink(f);
  for (const [index, side] of sides.entries()) {
    await f.runtime.invoke("chat:send", [
      { projectPath: side.project.path, sessionId: side.session.id, body: `Original ${index}`, provider: "codex", model: "test", permissionMode: "full" },
    ]);
    await f.settle(index + 1);
  }
  const result = await f.runtime.invoke("canvas:chat-mode", [link.id, "shared"]);
  const owner = result.find((item) => item.id === link.id).sharedChat;
  assert.ok(owner);
  const opened = await f.runtime.invoke("link:open", [owner.linkId]);
  assert.equal(opened.state.sessions[1].permissionMode, "ask");
  assert.deepEqual(
    opened.state.sessions[1].worktrees.map((item) => item.worktreePath),
    sides.map((side) => side.worktree.path),
  );
  for (const [index, side] of sides.entries()) {
    const view = await f.runtime.openProject(side.project.path);
    assert.ok(view.state.sessions[side.session.id].readOnlyReason);
    assert.ok(view.state.messages.some((message) => message.body === `Original ${index}`));
    await assert.rejects(
      f.runtime.invoke("chat:send", [{ projectPath: side.project.path, sessionId: side.session.id, body: "Must not run", provider: "codex", model: "test" }]),
      /read-only/,
    );
    assert.equal(await fs.readFile(path.join(side.worktree.path, "keep.txt"), "utf8"), `unsaved ${index}`);
  }
  await assert.rejects(f.runtime.invoke("canvas:link-remove", [link.id]), /separate Chats/);
  await assert.rejects(f.runtime.invoke("link:delete", [owner.linkId]), /canvas/);
  const request = {
    linkId: owner.linkId,
    sessionId: 1,
    operationId: randomUUID(),
    body: "Shared work",
    provider: "codex",
    model: "test",
    permissionMode: "full",
  };
  await f.runtime.invoke("link:send", [request]);
  await f.settle(3);
  assert.equal((await f.runtime.invoke("link:snapshot", [owner.linkId])).state.sessions[1].permissionMode, "ask");
  assert.deepEqual(new Set(f.created.at(-1).access.roots), new Set(sides.map((side) => side.worktree.path)));
  const again = await f.runtime.invoke("canvas:chat-mode", [link.id, "shared"]);
  assert.deepEqual(again.find((item) => item.id === link.id).sharedChat, owner);
  await f.runtime.close();
  const next = f.make();
  await next.invoke("link:open", [owner.linkId]);
  await next.invoke("canvas:chat-mode", [link.id, "separate"]);
  const history = (await next.invoke("link:open", [owner.linkId])).state;
  assert.ok(history.sessions[1].readOnlyReason);
  assert.ok(history.messages.some((message) => message.body === "Shared work"));
  await assert.rejects(next.invoke("link:send", [{ ...request, operationId: randomUUID() }]), /read-only/);
  for (const side of sides) {
    const view = await next.openProject(side.project.path);
    assert.equal(view.state.worktrees[side.worktree.id].sharedChat, undefined);
    assert.ok(view.state.sessions[side.session.id].readOnlyReason);
    assert.ok(Object.values(view.state.sessions).some((session) => session.worktree_id === side.worktree.id && !session.readOnlyReason));
    assert.ok((await fs.stat(side.worktree.path)).isDirectory());
  }
  await next.invoke("canvas:link-remove", [link.id]);
});

test("canvas sharing refuses a running Chat before changing ownership", async (t) => {
  let finish;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture(t, { hold: () => held });
  t.after(() => finish());
  const { sides, link } = await existingLink(f);
  const side = sides[0];
  await f.runtime.invoke("chat:send", [{ projectPath: side.project.path, sessionId: side.session.id, body: "Keep working", provider: "codex", model: "test" }]);
  await assert.rejects(f.runtime.invoke("canvas:chat-mode", [link.id, "shared"]), /work pending/);
  assert.equal((await f.runtime.openProject(side.project.path)).state.sessions[side.session.id].readOnlyReason, undefined);
  finish();
  await f.settle(1);
});

test("interrupted canvas adoption and release keep ownership guarded and finish on retry", async (t) => {
  const f = await fixture(t);
  const { sides, link } = await existingLink(f);
  const links = await f.runtime.invoke("canvas:chat-mode", [link.id, "shared"]);
  const { linkId } = links.find((item) => item.id === link.id).sharedChat;
  await f.runtime.close();
  const { createLinkStore } = require("./link-store.cjs");
  // Simulate shutdown after the ownership journal reached disk but before adoption was marked complete.
  let store = createLinkStore({ dataDir: path.join(f.dir, "profile") });
  await store.update(linkId, (state) => ({ ...state, adoptionPending: true }), { chats: [] });
  await store.close();
  const recovered = f.make();
  await assert.rejects(recovered.invoke("link:open", [linkId]), /Finish changing/);
  for (const side of sides) {
    const opened = await recovered.openProject(side.project.path);
    assert.ok(opened.state.sessions[side.session.id].readOnlyReason);
    await assert.rejects(
      recovered.invoke("chat:send", [{ projectPath: side.project.path, sessionId: side.session.id, body: "Blocked", provider: "codex", model: "test" }]),
      /read-only/,
    );
  }
  await recovered.invoke("canvas:chat-mode", [link.id, "shared"]);
  assert.equal((await recovered.invoke("link:open", [linkId])).state.adoptionPending, false);
  await recovered.close();
  store = createLinkStore({ dataDir: path.join(f.dir, "profile") });
  await store.update(linkId, (state) => ({ ...state, adoptionPending: true, separating: true }), { chats: [] });
  await store.close();
  const release = f.make();
  await assert.rejects(release.invoke("canvas:chat-mode", [link.id, "shared"]), /Finish switching/);
  await release.invoke("canvas:chat-mode", [link.id, "separate"]);
  assert.ok((await release.invoke("link:open", [linkId])).state.sessions[1].readOnlyReason);
  const again = await release.invoke("canvas:chat-mode", [link.id, "shared"]);
  assert.notEqual(again.find((item) => item.id === link.id).sharedChat.linkId, linkId);
});
test("a client's Link send remembers explicit turn defaults and an omitted choice inherits them", async (t) => {
  const { dir, runtime, projects, edits, created, settle } = await fixture(t);
  edits.length = 0;
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const request = { linkId: link.id, body: "Read the projects", provider: "claude", model: "test", permissionMode: "auto" };
  const sent = await runtime.invoke("link:send", [{ ...request, operationId: randomUUID(), replies: "normal", tldrEnabled: false }]);
  await settle(1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "profile", "turn-defaults.json"), "utf8")), { replies: "normal", tldrEnabled: false });
  await runtime.invoke("link:send", [{ ...request, sessionId: sent.sessionId, operationId: randomUUID() }]);
  await settle(2);
  assert.equal(created.length, 1, "the phone's omitted choice keeps the existing session");
  assert.equal(created[0].tldrEnabled, false);
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
  assert.ok(created[0].workspaceInstructions.includes(`api: ${api.path}`), created[0].workspaceInstructions);
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
  for (let i = 0; i < 3000 && !approvals.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(approvals[0].chat, created[0]);
  assert.equal(approvals[0].request.title, `Send a Delegation to web / main / Work in Full permission?`);
  assert.equal(approvals[0].request.allowForChat, false);
  approvals[0].answer("deny");
  await assert.rejects(delegating, /denied/);

  const starting = tool("chat_start").run({ projectPath: web.path, chatId: target, prompt: "Delete the build", requestId: "r1" });
  for (let i = 0; i < 3000 && approvals.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(approvals[1].chat, created[0]);
  assert.match(approvals[1].request.title, /^Run a prompt in .* in Full permission\?$/);
  approvals[1].answer("deny");
  await assert.rejects(starting, /declined/);
  assert.deepEqual(await received(), [], "nothing reached the Full Chat");
});

test("deleting a Link archives its Chats, removes untouched Worktrees and gives changed ones back to their Projects", async (t) => {
  const { dir, runtime, projects, settle } = await fixture(t);
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const sent = await runtime.invoke("link:send", [
    { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Edit both", provider: "codex", model: "test", permissionMode: "auto" },
  ]);
  await settle(1);
  const session = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  const [api, web] = ["api", "web"].map((name) => session.worktrees.find((member) => path.basename(member.projectPath) === name));
  await fs.writeFile(path.join(web.worktreePath, "notes.txt"), "unsaved");
  assert.ok(runtime.methods.includes("link:delete"));
  assert.deepEqual(await runtime.invoke("link:delete-check", [link.id]), { chats: 1, running: [] });

  assert.deepEqual(await runtime.invoke("link:delete", [link.id]), { removed: [api.worktreePath], kept: [web.worktreePath] });
  assert.deepEqual(await runtime.invoke("link:list"), []);
  await assert.rejects(runtime.invoke("link:open", [link.id]), /no longer exists/);
  await assert.rejects(runtime.invoke("link:delete", [link.id]), /no longer exists/);
  // The untouched Worktree went with its branch; the changed one kept both.
  const git = (folder, ...args) =>
    execFileSync("git", ["-C", folder, ...args])
      .toString()
      .trim();
  assert.equal(git(api.projectPath, "worktree", "list").split("\n").length, 1);
  assert.equal(git(api.projectPath, "branch", "--list", api.branch), "");
  assert.equal(await fs.readFile(path.join(web.worktreePath, "notes.txt"), "utf8"), "unsaved");
  assert.notEqual(git(web.projectPath, "branch", "--list", web.branch), "");
  // The transcript stays on disk, its Chat archived.
  await runtime.flush();
  const saved = JSON.parse(await fs.readFile(path.join(dir, "profile", "links", link.id, ".milagre", "coordination.json"), "utf8"));
  assert.equal(saved.sessions[sent.sessionId].archived, true);
  assert.ok(saved.deletedAt);
  // The kept Worktree is web's own now: no shared Chat, a Chat of its own, and the base its removal checks against.
  const view = await runtime.openProject(web.projectPath);
  const worktree = Object.values(view.state.worktrees).find((item) => item.path === web.worktreePath);
  assert.equal(worktree.sharedChat, undefined);
  assert.equal(worktree.base, web.base);
  assert.ok(Object.values(view.state.sessions).some((item) => item.worktree_id === worktree.id && !item.archived));
});

test("a Link with a running Chat is not deleted until that Chat stops", async (t) => {
  let release;
  const running = new Promise((resolve) => (release = resolve));
  const { runtime, projects, settle } = await fixture(t, { hold: () => running });
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  await runtime.invoke("link:send", [
    { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Edit both", provider: "codex", model: "test", permissionMode: "auto" },
  ]);
  let check;
  for (let i = 0; i < 200; i++) {
    check = await runtime.invoke("link:delete-check", [link.id]);
    if (check.running.length) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(check, { chats: 1, running: ["Edit both"] });
  await assert.rejects(runtime.invoke("link:delete", [link.id]), /^Error: Edit both is running\. Stop it before deleting the Link\.$/);
  assert.equal((await runtime.invoke("link:list")).length, 1);
  release();
  await settle(1);
  for (let i = 0; i < 200 && (await runtime.invoke("link:delete-check", [link.id])).running.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const result = await runtime.invoke("link:delete", [link.id]);
  assert.equal(result.removed.length, 2);
  assert.deepEqual(await runtime.invoke("link:list"), []);
});

// link-runtime alone, with each step of a delete held or failed on purpose.
function deleteFixture() {
  const { registerLinkRuntime } = require("./link-runtime.cjs");
  const handlers = new Map();
  const id = randomUUID();
  const fixture = {
    id,
    groups: [{ id, name: "Food", projectIds: ["/api/.git", "/web/.git"], createdAt: "2026-11-01T00:00:00.000Z" }],
    state: { next_id: 2, sessions: { 1: { id: 1, agent_name: "Food", status: "Idle", workspacePath: "/w/1", worktrees: [] } }, messages: [], preparations: {} },
    broadcasts: [],
    retired: [],
    failRegistry: false,
    failTidy: false,
    hold: null,
    call: (name, ...args) => handlers.get(name)({}, ...args),
  };
  fixture.runtime = registerLinkRuntime({
    commands: { handle: (name, handler) => handlers.set(name, handler) },
    registry: () => ({
      listProjectGroups: async () => fixture.groups,
      updateProjectGroup: async (request) => request,
      snapshot: async () => ({ projects: [] }),
      deleteProjectGroup: async (gone) => {
        if (fixture.failRegistry) throw new Error("Could not save the registry");
        fixture.groups = fixture.groups.filter((group) => group.id !== gone);
      },
    }),
    store: {
      has: () => true,
      ids: () => [id],
      cached: () => fixture.state,
      get: async () => fixture.state,
      update: async (_id, change) => {
        fixture.state = change(fixture.state);
      },
      flush: async () => {},
    },
    workspaces: {
      recoverLinkPreparations: async () => {},
      membersAvailable: async () => [],
      releaseLinkWorktrees: async () => {
        await fixture.hold?.();
        return { removed: [], kept: [{ worktreePath: "/w/web-1", projectPath: "/web" }] };
      },
    },
    chats: { busyChats: () => new Set(), resumeInterrupted: async () => {}, recoverHandoffs: async () => {} },
    broadcast: (_key, state) => fixture.broadcasts.push(state),
    titles: { resume() {} },
    retire: async (_scope, sessionId) => {
      fixture.retired.push(sessionId);
      const session = fixture.state.sessions[sessionId];
      fixture.state = { ...fixture.state, sessions: { ...fixture.state.sessions, [sessionId]: { ...session, archived: true } } };
    },
    released: async () => {
      if (fixture.failTidy) throw new Error("Canvas busy");
    },
  });
  return fixture;
}

test("nothing new starts in a Link while it is being deleted, and reads still answer", async () => {
  const fixture = deleteFixture();
  let release, reached;
  const releasing = new Promise((resolve) => (release = resolve));
  const atRelease = new Promise((resolve) => (reached = resolve));
  fixture.hold = () => (reached(), releasing);
  fixture.failTidy = true;
  const deleting = fixture.call("link:delete", fixture.id);
  await atRelease;
  await assert.rejects(fixture.call("link:open", fixture.id), /being deleted/);
  await assert.rejects(fixture.runtime.usable(fixture.id), /being deleted/);
  assert.equal((await fixture.call("link:snapshot", fixture.id)).link.id, fixture.id);
  // An edit asked for meanwhile waits behind the delete, then finds the Link gone.
  const editing = fixture.call("link:update", { id: fixture.id, name: "Food 2", projectIds: ["/api/.git", "/web/.git"] });
  release();
  // A tidy-up that fails after the registry entry went doesn't turn the delete into a failure.
  assert.deepEqual(await deleting, { removed: [], kept: ["/w/web-1"] });
  await assert.rejects(editing, /no longer exists/);
  assert.deepEqual(fixture.retired, [1]);
  assert.ok(fixture.broadcasts.at(-1).deletedAt, "the last word every device hears is the deleted state");
  await assert.rejects(fixture.call("link:open", fixture.id), /no longer exists/);
});

test("a delete that stops before the registry entry goes leaves a Link that takes no work until it is deleted again", async () => {
  const fixture = deleteFixture();
  fixture.failRegistry = true;
  await assert.rejects(fixture.call("link:delete", fixture.id), /Could not save the registry/);
  const marked = fixture.state.deletedAt;
  assert.ok(marked);
  assert.equal(fixture.groups.length, 1);
  await assert.rejects(fixture.call("link:open", fixture.id), /partly deleted\. Delete it again/);
  await assert.rejects(fixture.call("link:update", { id: fixture.id, name: "Food", projectIds: ["/api/.git", "/web/.git"] }), /partly deleted/);
  assert.deepEqual(await fixture.call("link:delete-check", fixture.id), { chats: 0, running: [] });
  fixture.failRegistry = false;
  assert.deepEqual(await fixture.call("link:delete", fixture.id), { removed: [], kept: ["/w/web-1"] });
  assert.deepEqual(fixture.groups, []);
  assert.equal(fixture.state.deletedAt, marked, "the first mark stays");
});

test("a Link not opened since a restart is deleted, and a Worktree with a commit not pushed stays", async (t) => {
  const { runtime, make, projects, settle } = await fixture(t);
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((project) => project.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const sent = await runtime.invoke("link:send", [
    { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Edit both", provider: "codex", model: "test", permissionMode: "auto" },
  ]);
  await settle(1);
  const session = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  const [api, web] = ["api", "web"].map((name) => session.worktrees.find((member) => path.basename(member.projectPath) === name));
  execFileSync("git", ["-C", api.worktreePath, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Work"]);
  await runtime.close();

  const next = make();
  assert.deepEqual(await next.invoke("link:delete", [link.id]), { removed: [web.worktreePath], kept: [api.worktreePath] });
  assert.deepEqual(await next.invoke("link:list"), []);
  // The shared workspace is no Chat's now, and the kept Worktree is api's own, checked against where it started.
  await assert.rejects(next.invoke("link:workspace-roots", [session.workspacePath]), /workspace/);
  const view = await next.openProject(api.projectPath);
  const worktree = Object.values(view.state.worktrees).find((item) => item.path === api.worktreePath);
  assert.equal(worktree.sharedChat, undefined);
  assert.equal(worktree.base, api.base);
});

test("a Link lists its member Projects' skills, and a shared Chat its Worktrees' and main checkouts' skills", async (t) => {
  const { runtime, projects, edits, settle } = await fixture(t);
  for (const project of projects) {
    const file = path.join(project.path, ".agents", "skills", `${project.name}-skill`, "SKILL.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\nname: ${project.name}-skill\ndescription: From ${project.name}\n---\nInstructions`);
    execFileSync("git", ["-C", project.path, "add", "."]);
    execFileSync("git", ["-C", project.path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Skill"]);
  }
  const link = await runtime.invoke("link:create", [{ name: "Food", projectIds: projects.map((p) => p.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const owner = scopeKey({ kind: "link", linkId: link.id });
  const names = (catalog) =>
    catalog.skills
      .filter((skill) => skill.scope === "workspace")
      .map((skill) => skill.name)
      .sort();
  assert.deepEqual(names(await runtime.invoke("skills:list", [owner])), ["api-skill", "web-skill"]);
  // The agent changes only api: web has no Worktree, and its skills come from its main checkout.
  edits.splice(0, edits.length, "api");
  const sent = await runtime.invoke("link:send", [
    { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "Edit", provider: "codex", model: "test", permissionMode: "auto" },
  ]);
  await settle(1);
  const session = (await runtime.invoke("link:snapshot", [link.id])).state.sessions[sent.sessionId];
  assert.equal(session.worktrees.length, 1);
  const catalog = await runtime.invoke("skills:list", [session.workspacePath]);
  assert.deepEqual(names(catalog), ["api-skill", "web-skill"]);
  const web = projects.find((project) => project.name === "web");
  assert.ok(catalog.skills.find((skill) => skill.name === "api-skill").path.startsWith(session.worktrees[0].worktreePath));
  assert.ok(catalog.skills.find((skill) => skill.name === "web-skill").path.startsWith(web.path));
  await assert.rejects(runtime.invoke("skills:list", [scopeKey({ kind: "link", linkId: randomUUID() })]), /Link/);
});

test("adopted Chat permissions start Ask and only the permission-change path can escalate", async (t) => {
  const f = await fixture(t);
  f.edits.length = 0;
  const { link } = await existingLink(f);
  const shared = (await f.runtime.invoke("canvas:chat-mode", [link.id, "shared"])).find((item) => item.id === link.id).sharedChat;
  const chatId = chatKeyForScope({ kind: "link", linkId: shared.linkId }, 1);
  await f.runtime.invoke("link:open", [shared.linkId]);
  assert.equal((await f.runtime.invoke("link:snapshot", [shared.linkId])).state.sessions[1].permissionMode, "ask");
  await f.runtime.invoke("agent:set-permission-mode", [{ chatId, mode: "full" }]);
  const request = { linkId: shared.linkId, sessionId: 1, provider: "codex", model: "test", body: "Explicit Full", permissionMode: "ask" };
  await f.runtime.invoke("link:send", [{ ...request, operationId: randomUUID() }]);
  await f.settle(1);
  assert.equal((await f.runtime.invoke("link:snapshot", [shared.linkId])).state.sessions[1].permissionMode, "full");
  await f.runtime.close();
  const restarted = f.make();
  await restarted.invoke("link:open", [shared.linkId]);
  await restarted.invoke("agent:set-permission-mode", [{ chatId, mode: "ask" }]);
  await restarted.invoke("link:send", [{ ...request, permissionMode: "full", operationId: randomUUID() }]);
  await f.settle(2, restarted);
  assert.equal((await restarted.invoke("link:snapshot", [shared.linkId])).state.sessions[1].permissionMode, "ask");
});

test("canvas conversion refuses scheduled Heartbeats, and read-only histories cannot acquire new ones", async (t) => {
  const f = await fixture(t);
  const { sides, link } = await existingLink(f);
  const target = { kind: "chat", chatId: `${sides[0].project.path}#${sides[0].session.id}` };
  const input = { name: "Watch", prompt: "Watch CI", trigger: { kind: "schedule", cron: "0 0 1 1 *", timezone: "UTC" }, target };
  const { routine } = await f.runtime.invoke("routines:create", [input]);
  await assert.rejects(f.runtime.invoke("canvas:chat-mode", [link.id, "shared"]), /End.*Heartbeats.*Babysit/);
  assert.equal((await f.runtime.invoke("routines:list")).routines[0].completedAt, undefined, "conversion does not silently end scheduled work");
  await f.runtime.invoke("routines:delete", [routine.id]);
  const shared = (await f.runtime.invoke("canvas:chat-mode", [link.id, "shared"])).find((item) => item.id === link.id).sharedChat;
  await assert.rejects(f.runtime.invoke("routines:create", [input]), /read-only/);
  // Existing lifecycle: Named/shared Chats cannot schedule Heartbeats or Babysit PR in the first place.
  await assert.rejects(
    f.runtime.invoke("routines:create", [{ ...input, target: { kind: "chat", chatId: chatKeyForScope({ kind: "link", linkId: shared.linkId }, 1) } }]),
    /Project|listed/,
  );
  await f.runtime.invoke("canvas:chat-mode", [link.id, "separate"]);
  await assert.rejects(f.runtime.invoke("routines:create", [input]), /read-only/);
  const state = (await f.runtime.openProject(sides[0].project.path)).state;
  const fresh = Object.values(state.sessions).find((session) => session.worktree_id === sides[0].worktree.id && !session.readOnlyReason);
  await f.runtime.invoke("routines:create", [{ ...input, target: { kind: "chat", chatId: `${sides[0].project.path}#${fresh.id}` } }]);
});

for (const removal of ["missing", "forgotten"]) {
  test(`${removal} Project can release shared ownership and remove its Link without reopening it`, async (t) => {
    const f = await fixture(t);
    const { sides, link } = await existingLink(f);
    const shared = (await f.runtime.invoke("canvas:chat-mode", [link.id, "shared"])).find((item) => item.id === link.id).sharedChat;
    const removed = sides[0].project.path;
    if (removal === "missing") {
      await fs.rename(removed, `${removed}-moved`);
      await f.runtime.invoke("project:registry");
    } else await f.runtime.invoke("project:forget", [removed]);
    await f.runtime.invoke("canvas:chat-mode", [link.id, "separate"]);
    await f.runtime.invoke("canvas:link-remove", [link.id]);
    if (removal === "missing") assert.ok(!(await f.runtime.invoke("project:registry")).some((project) => project.path === removed));
    else assert.ok(!(await f.runtime.invoke("project:recent")).some((project) => project.path === removed));
    const sharedState = (await f.runtime.invoke("link:snapshot", [shared.linkId])).state;
    assert.ok(sharedState.releasedAt);
    assert.ok(sharedState.sessions[1].readOnlyReason);
    assert.ok((await fs.stat(sides[1].worktree.path)).isDirectory());
  });
}

test("pending adoption with a nonempty conversation refuses to overwrite it and offers recovery", async (t) => {
  const f = await fixture(t);
  f.edits.length = 0;
  const { link } = await existingLink(f);
  const shared = (await f.runtime.invoke("canvas:chat-mode", [link.id, "shared"])).find((item) => item.id === link.id).sharedChat;
  await f.runtime.invoke("link:send", [
    { linkId: shared.linkId, sessionId: 1, operationId: randomUUID(), provider: "codex", model: "test", body: "Keep this conversation" },
  ]);
  await f.settle(1);
  await f.runtime.close();
  const { createLinkStore } = require("./link-store.cjs");
  const store = createLinkStore({ dataDir: path.join(f.dir, "profile") });
  await store.update(shared.linkId, (state) => ({ ...state, adoptionPending: true }), { chats: [] });
  await store.close();
  const restarted = f.make();
  assert.equal((await restarted.invoke("canvas:links")).find((item) => item.id === link.id).chatModeTransition, "shared");
  await assert.rejects(restarted.invoke("canvas:chat-mode", [link.id, "shared"]), /conversation history/);
  await restarted.invoke("canvas:chat-mode", [link.id, "separate"]);
  const saved = (await restarted.invoke("link:open", [shared.linkId])).state;
  assert.ok(saved.messages.some((message) => message.body === "Keep this conversation"));
  assert.ok(saved.sessions[1].readOnlyReason);
});

test("repeated adoption does not reserve ordinary Named Link choices or deduplicate them", async (t) => {
  const f = await fixture(t);
  const { link } = await existingLink(f);
  for (let i = 0; i < 2; i++) {
    await f.runtime.invoke("canvas:chat-mode", [link.id, "shared"]);
    await f.runtime.invoke("canvas:chat-mode", [link.id, "separate"]);
  }
  const named = await f.runtime.invoke("link:create", [{ name: "Independent", projectIds: f.projects.map((p) => p.id) }]);
  assert.equal(named.canvasLinkId, undefined);
  assert.equal((await f.runtime.invoke("link:list")).filter((group) => group.canvasLinkId).length, 2);
});

test("read-only original and released shared Chats retain checkpoint previews but refuse Undo and Redo", async (t) => {
  let finish;
  let held = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture(t, { hold: () => held });
  f.edits.length = 0;
  const { sides, link } = await existingLink(f);
  const side = sides[0];
  const chatId = `${side.project.path}#${side.session.id}`;
  const file = path.join(side.worktree.path, "keep.txt");
  const wait = require("./agents/test-helpers.cjs").waitUntil;
  await f.runtime.invoke("chat:send", [{ projectPath: side.project.path, sessionId: side.session.id, body: "Edit", provider: "codex", model: "test" }]);
  await wait(() => f.created.length === 1);
  await fs.writeFile(file, "original agent edit");
  finish();
  await f.settle(1);
  await wait(async () => (await f.runtime.invoke("checkpoint:list", [{ chatId }]))[0]?.completedAt);
  const checkpoint = (await f.runtime.invoke("checkpoint:list", [{ chatId }]))[0];
  const preview = await f.runtime.invoke("checkpoint:preview", [{ chatId, id: checkpoint.id }]);
  const undoRequest = { chatId, token: preview.token, approved: true, decisions: Object.fromEntries(preview.files.map((file) => [file.key, "restore"])) };
  const restored = await f.runtime.invoke("checkpoint:restore", [undoRequest]);
  assert.equal(restored.restored, 1);
  const redo = await f.runtime.invoke("checkpoint:preview", [{ chatId, id: restored.recoveryId }]);
  const shared = (await f.runtime.invoke("canvas:chat-mode", [link.id, "shared"])).find((item) => item.id === link.id).sharedChat;
  await assert.rejects(f.runtime.invoke("checkpoint:restore", [{ ...undoRequest, token: redo.token }]), /read-only/);
  assert.ok((await f.runtime.invoke("checkpoint:list", [{ chatId }])).length >= 2);
  assert.ok((await f.runtime.invoke("checkpoint:preview", [{ chatId, id: restored.recoveryId }])).files.length);
  const sharedId = chatKeyForScope({ kind: "link", linkId: shared.linkId }, 1);
  held = new Promise((resolve) => {
    finish = resolve;
  });
  await f.runtime.invoke("link:send", [
    { linkId: shared.linkId, sessionId: 1, operationId: randomUUID(), provider: "codex", model: "test", body: "Shared edit" },
  ]);
  await wait(() => f.created.length === 2);
  await fs.writeFile(file, "shared agent edit");
  finish();
  await f.settle(2);
  await wait(async () => (await f.runtime.invoke("checkpoint:list", [{ chatId: sharedId }]))[0]?.completedAt);
  const sharedCheckpoint = (await f.runtime.invoke("checkpoint:list", [{ chatId: sharedId }]))[0];
  const sharedPreview = await f.runtime.invoke("checkpoint:preview", [{ chatId: sharedId, id: sharedCheckpoint.id }]);
  await f.runtime.invoke("canvas:chat-mode", [link.id, "separate"]);
  await assert.rejects(f.runtime.invoke("checkpoint:restore", [{ chatId: sharedId, token: sharedPreview.token, approved: true, decisions: {} }]), /read-only/);
  assert.ok((await f.runtime.invoke("checkpoint:preview", [{ chatId: sharedId, id: sharedCheckpoint.id }])).files.length);
  assert.equal(await fs.readFile(file, "utf8"), "shared agent edit");
});
