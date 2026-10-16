const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createProjectRegistry } = require("./project-registry.cjs");
const { resolveProject } = require("./project-identity.cjs");
const { reconcileState } = require("./project-state.cjs");
const { scopeKey } = require("@milagre/shared/chat-scopes");
let createLinkStore, createLinkWorkspaces;
try {
  ({ createLinkStore } = require("./link-store.cjs"));
  ({ createLinkWorkspaces } = require("./link-workspaces.cjs"));
} catch {}

async function fixture(t, options = {}) {
  assert.equal(typeof createLinkStore, "function");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-owned-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = createProjectRegistry(path.join(root, "registry.json"), { roots: [] });
  for (const name of ["api", "web"]) {
    const folder = path.join(root, name);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "hello.txt"), name);
    const git = (...args) => execFileSync("git", ["-C", folder, ...args], { stdio: "ignore" });
    git("init", "-qb", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("add", ".");
    git("commit", "-qm", "Initial");
    await registry.add(await resolveProject(folder));
  }
  // In the Link as api, then web: aliases and branch suffixes follow this order.
  const projects = (await registry.list()).sort((a, b) => a.name.localeCompare(b.name));
  const link = await registry.createProjectGroup({ name: "Food", projectIds: projects.map((p) => p.id) });
  const dataDir = path.join(root, "profile");
  const store = createLinkStore({ dataDir });
  t.after(() => store.close());
  const owned = [];
  const workspaces = createLinkWorkspaces({ store, registry, root: path.join(root, "worktrees"), ownProject: async (p) => owned.push(p), ...options });
  return { root, projects, link, store, dataDir, owned, workspaces, registry };
}
// A new Chat's workspace, its session saved as link:send does, and both Projects given their Worktrees.
async function readyChat(link, store, workspaces, request) {
  const prepared = await workspaces.prepareLinkChat(request);
  await store.update(link.id, (state) => ({
    ...state,
    sessions: { ...state.sessions, [request.chatId]: { id: request.chatId, workspacePath: prepared.workspacePath, worktrees: prepared.worktrees } },
  }));
  return prepared;
}
const addBoth = async (link, workspaces, chatId) => {
  const members = [];
  for (const project of ["api", "web"]) members.push((await workspaces.addLinkWorktree({ link, chatId, project })).member);
  return members;
};
test("a new Chat gets its workspace without creating a Worktree in any Project", async (t) => {
  const { link, store, workspaces, owned, projects } = await fixture(t);
  const prepared = await readyChat(link, store, workspaces, { link, chatId: 1, prompt: "change api", operationId: randomUUID() });
  assert.deepEqual(prepared.worktrees, []);
  assert.deepEqual(owned, []);
  assert.ok((await fs.stat(prepared.workspacePath)).isDirectory());
  for (const project of projects) assert.equal(execFileSync("git", ["-C", project.path, "worktree", "list"]).toString().trim().split("\n").length, 1);
});
test("a Project gets its Worktree when the Chat asks, once; the others stay untouched", async (t) => {
  const { link, store, dataDir, workspaces, owned, projects } = await fixture(t);
  const request = { link, chatId: 1, prompt: "change api", operationId: randomUUID() };
  const prepared = await readyChat(link, store, workspaces, request);
  const { member, created } = await workspaces.addLinkWorktree({ link, chatId: 1, project: "API" });
  assert.equal(created, true);
  assert.equal(member.projectName, "api");
  assert.equal(member.alias, "api-1");
  assert.equal(await fs.realpath(path.join(prepared.workspacePath, member.alias)), member.worktreePath);
  assert.deepEqual(owned, [projects[0].path]);
  const again = await workspaces.addLinkWorktree({ link, chatId: 1, project: "api" });
  assert.equal(again.created, false);
  assert.equal(again.member.worktreePath, member.worktreePath);
  const saved = await store.get(link.id);
  assert.deepEqual(
    saved.sessions[1].worktrees.map((item) => item.worktreePath),
    [member.worktreePath],
  );
  assert.equal(execFileSync("git", ["-C", projects[1].path, "worktree", "list"]).toString().trim().split("\n").length, 1);
  assert.deepEqual(await workspaces.prepareLinkChat(request), { workspacePath: prepared.workspacePath, worktrees: saved.sessions[1].worktrees });
  await store.close();
  const reopened = createLinkStore({ dataDir });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.get(link.id)).sessions, saved.sessions);
  assert.equal((await reopened.ownedWorktrees()).size, 1);
});
test("an unknown Project names the Link's Projects", async (t) => {
  const { link, store, workspaces } = await fixture(t);
  await readyChat(link, store, workspaces, { link, chatId: 1, prompt: "", operationId: randomUUID() });
  await assert.rejects(workspaces.addLinkWorktree({ link, chatId: 1, project: "mobile" }), /No Project "mobile" in this Link\. Its Projects: api, web/);
});
test("each Chat gets its own Worktree in a Project", async (t) => {
  const { link, store, workspaces } = await fixture(t);
  await readyChat(link, store, workspaces, { link, chatId: 1, prompt: "change both", operationId: randomUUID() });
  await readyChat(link, store, workspaces, { link, chatId: 2, prompt: "change both", operationId: randomUUID() });
  const first = await workspaces.addLinkWorktree({ link, chatId: 1, project: "web" });
  const second = await workspaces.addLinkWorktree({ link, chatId: 2, project: "web" });
  assert.notEqual(first.member.worktreePath, second.member.worktreePath);
  assert.equal(first.member.alias, "web-2");
});
test("failed setup retains a changed Worktree, names the Project and leaves it out of the Chat", async (t) => {
  const { root, link, store, workspaces } = await fixture(t, {
    getSettings: async () => ({ setupCommand: "setup" }),
    runSetup: async ({ cwd }) => {
      await fs.writeFile(path.join(cwd, "changed.txt"), "retain");
      return { status: "failed", output: "setup broke" };
    },
  });
  const operationId = randomUUID();
  await readyChat(link, store, workspaces, { link, chatId: 1, prompt: "", operationId });
  await assert.rejects(workspaces.addLinkWorktree({ link, chatId: 1, project: "api" }), /Project api: Setup failed: setup broke/);
  const state = await store.get(link.id);
  const [member] = state.preparations[operationId].members;
  assert.equal(member.retained, true);
  assert.ok(member.worktreePath.startsWith(root));
  assert.equal(await fs.readFile(path.join(member.worktreePath, "changed.txt"), "utf8"), "retain");
  assert.deepEqual(state.sessions[1].worktrees, []);
  await assert.rejects(workspaces.addLinkWorktree({ link, chatId: 1, project: "api" }), /Retained Worktree/);
});
test("a failed creation leaves nothing behind, and asking again starts over", async (t) => {
  let calls = 0;
  const { createWorktree } = require("./worktrees.cjs");
  const { link, store, workspaces } = await fixture(t, {
    createWorktree: async (args) => {
      if (++calls === 1) throw new Error("creation failed");
      return createWorktree(args);
    },
  });
  const operationId = randomUUID();
  await readyChat(link, store, workspaces, { link, chatId: 1, prompt: "", operationId });
  await assert.rejects(workspaces.addLinkWorktree({ link, chatId: 1, project: "api" }), /creation failed/);
  assert.deepEqual((await store.get(link.id)).preparations[operationId].members, []);
  const { member } = await workspaces.addLinkWorktree({ link, chatId: 1, project: "api" });
  assert.ok((await fs.stat(member.worktreePath)).isDirectory());
});
test("crash recovery verifies a created member before finishing it", async (t) => {
  const { link, store, workspaces } = await fixture(t);
  const request = { link, chatId: 1, prompt: "", operationId: randomUUID() };
  await readyChat(link, store, workspaces, request);
  const { member } = await workspaces.addLinkWorktree({ link, chatId: 1, project: "api" });
  // Interrupt after the creation record is durably saved, before its setup was marked done.
  await store.update(link.id, (state) => {
    const prep = state.preparations[request.operationId];
    return { ...state, preparations: { ...state.preparations, [request.operationId]: { ...prep, members: [{ ...prep.members[0], setupDone: false }] } } };
  });
  await store.flush(link.id);
  await workspaces.recoverLinkPreparations(link.id);
  const state = await store.get(link.id);
  assert.equal(state.preparations[request.operationId].members[0].setupDone, true);
  assert.deepEqual(
    state.sessions[1].worktrees.map((item) => item.worktreePath),
    [member.worktreePath],
  );
});
test("Project reconciliation references a shared Chat without a local starter", () => {
  const owned = new Map([["/work/api", { linkId: randomUUID(), sessionId: 4 }]]);
  const state = reconcileState(null, "api", [{ path: "/work/api", name: "shared" }], owned);
  assert.deepEqual(Object.values(state.worktrees)[0].sharedChat, owned.get("/work/api"));
  assert.deepEqual(state.sessions, {});
});
test("recovery retains an interrupted setup even when its changed files are ignored", async (t) => {
  const { link, store, workspaces } = await fixture(t);
  const request = { link, chatId: 1, prompt: "recover", operationId: randomUUID() };
  await readyChat(link, store, workspaces, request);
  const { member } = await workspaces.addLinkWorktree({ link, chatId: 1, project: "api" });
  await fs.writeFile(path.join(member.projectPath, ".git", "info", "exclude"), ".env\n");
  await fs.writeFile(path.join(member.worktreePath, ".env"), "keep this setup output");
  await store.update(link.id, (state) => {
    const prep = state.preparations[request.operationId];
    return {
      ...state,
      preparations: {
        ...state.preparations,
        [request.operationId]: { ...prep, members: [{ ...prep.members[0], setupCommand: "setup", setupStarted: true, setupDone: false }] },
      },
    };
  });
  await store.flush(link.id);
  await assert.rejects(workspaces.recoverLinkPreparations(link.id), /interrupted/);
  const [failed] = (await store.get(link.id)).preparations[request.operationId].members;
  assert.equal(failed.retained, true);
  assert.equal(await fs.readFile(path.join(member.worktreePath, ".env"), "utf8"), "keep this setup output");
});
test("a linked Worktree stays available after its agent switches it to another branch", async (t) => {
  const { createChatScopes } = require("./chat-scopes.cjs");
  const { link, store, workspaces } = await fixture(t);
  const ready = await readyChat(link, store, workspaces, { link, chatId: 1, prompt: "change both", operationId: randomUUID() });
  ready.worktrees = await addBoth(link, workspaces, 1);
  const scopes = createChatScopes({ projects: null, links: store, validateLink: async () => {} });
  const key = scopeKey({ kind: "link", linkId: link.id });
  assert.equal((await scopes.executionContext(key, 1)).cwd, ready.workspacePath);
  execFileSync("git", ["-C", ready.worktrees[0].worktreePath, "checkout", "-qb", "fix/rdp-2217"]);
  assert.equal((await scopes.executionContext(key, 1)).cwd, ready.workspacePath);
  await fs.rm(path.join(ready.workspacePath, ready.worktrees[1].alias));
  await assert.rejects(scopes.executionContext(key, 1), /its shared Worktree is unavailable/);
});
test("a Chat's agent reads the Projects it hasn't changed and owns the ones it has", async (t) => {
  const { createChatScopes } = require("./chat-scopes.cjs");
  const { link, store, workspaces, projects } = await fixture(t);
  await readyChat(link, store, workspaces, { link, chatId: 1, prompt: "", operationId: randomUUID() });
  const scopes = createChatScopes({ projects: null, links: store, validateLink: async () => projects });
  const key = scopeKey({ kind: "link", linkId: link.id });
  const before = await scopes.executionContext(key, 1);
  assert.deepEqual(before.workspaceRoots, []);
  assert.deepEqual(before.readOnlyRoots, [projects[0].path, projects[1].path]);
  assert.match(before.workspaceInstructions, /No Project has a Worktree in this Chat yet/);
  assert.match(before.workspaceInstructions, /link_worktree_create/);
  const { member } = await workspaces.addLinkWorktree({ link, chatId: 1, project: "web" });
  const after = await scopes.executionContext(key, 1);
  assert.deepEqual(after.workspaceRoots, [member.worktreePath]);
  assert.deepEqual(after.readOnlyRoots, [projects[0].path]);
  assert.match(after.workspaceInstructions, new RegExp(`web-2: ${member.worktreePath}`));
});
test("a deferred setup leaves its review for later and the Worktree is the Chat's at once", async (t) => {
  const deferred = [];
  const { link, store, workspaces } = await fixture(t, {
    getSettings: async () => ({ setupCommand: "setup" }),
    runSetup: async () => assert.fail("A deferred setup must not run here"),
    deferSetup: async (request) => deferred.push(request),
  });
  await readyChat(link, store, workspaces, { link, chatId: 1, prompt: "", operationId: randomUUID() });
  const { member } = await workspaces.addLinkWorktree({ link, chatId: 1, project: "api" });
  assert.equal(member.setupDeferred, true);
  assert.deepEqual(
    deferred.map((request) => [request.worktreePath, request.resolved.command, request.strict]),
    [[member.worktreePath, "setup", true]],
  );
  assert.deepEqual(
    (await store.get(link.id)).sessions[1].worktrees.map((item) => item.worktreePath),
    [member.worktreePath],
  );
  assert.equal((await workspaces.addLinkWorktree({ link, chatId: 1, project: "api" })).created, false);
});
