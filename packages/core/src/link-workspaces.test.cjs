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
  const projects = await registry.list();
  const link = await registry.createProjectGroup({ name: "Food", projectIds: projects.map((p) => p.id) });
  const dataDir = path.join(root, "profile");
  const store = createLinkStore({ dataDir });
  t.after(() => store.close());
  const owned = [];
  const workspaces = createLinkWorkspaces({ store, registry, root: path.join(root, "worktrees"), ownProject: async (p) => owned.push(p), ...options });
  return { root, projects, link, store, dataDir, owned, workspaces, registry };
}
const member = (workspaces, link, chatId, project) => workspaces.prepareLinkMember({ linkId: link.id, chatId, project });
test("a Chat makes no Worktree until a Project is changed, then reuses that one; a new Chat owns another set", async (t) => {
  const { link, store, dataDir, workspaces, owned } = await fixture(t);
  const request = { link, chatId: 1, prompt: "change both", operationId: randomUUID() };
  const first = await workspaces.prepareLinkChat(request);
  assert.deepEqual(first.worktrees, []);
  assert.deepEqual(first.projects.map((project) => project.projectName).sort(), ["api", "web"]);
  assert.deepEqual(owned, [], "reserving a Chat takes no repository");
  assert.deepEqual(await workspaces.prepareLinkChat(request), first);
  const api = await member(workspaces, link, 1, "API");
  assert.equal(api.created, true);
  assert.equal(api.member.projectName, "api");
  assert.deepEqual(
    api.worktrees.map((item) => item.projectName),
    ["api"],
  );
  assert.equal(await fs.realpath(path.join(first.workspacePath, api.member.alias)), api.member.worktreePath);
  await assert.rejects(
    fs.lstat(path.join(first.workspacePath, first.projects.find((project) => project.projectName === "web").alias)),
    { code: "ENOENT" },
    "the untouched Project has no Worktree",
  );
  const again = await member(workspaces, link, 1, api.member.alias);
  assert.equal(again.created, false);
  assert.equal(again.member.worktreePath, api.member.worktreePath);
  await assert.rejects(member(workspaces, link, 1, "mobile"), /No Project "mobile" in this Chat\. Choose one of: (api, web|web, api)\./);
  await workspaces.prepareLinkChat({ ...request, chatId: 2, operationId: randomUUID() });
  const other = await member(workspaces, link, 2, "api");
  assert.notEqual(other.member.worktreePath, api.member.worktreePath);
  const saved = await store.get(link.id);
  await store.close();
  const reopened = createLinkStore({ dataDir });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.get(link.id), saved);
  assert.equal((await reopened.ownedWorktrees()).size, 2);
});
test("a Chat prepared before Worktrees were made on demand keeps every member it made", async (t) => {
  const { link, store, workspaces } = await fixture(t);
  const operationId = randomUUID();
  const legacy = {
    operationId,
    chatId: 1,
    prompt: "",
    status: "ready",
    workspacePath: "/old/workspace",
    members: [
      { projectId: "a", projectPath: "/a", projectName: "api", alias: "api-1", worktreePath: "/w/api" },
      { projectId: "b", projectPath: "/b", projectName: "web", alias: "web-2", worktreePath: "/w/web" },
    ],
  };
  await store.update(link.id, (state) => ({ ...state, preparations: { [operationId]: legacy } }));
  const read = await workspaces.chatMembers(link.id, 1);
  assert.deepEqual(
    read.worktrees.map((item) => item.worktreePath),
    ["/w/api", "/w/web"],
  );
  assert.equal(read.projects.length, 2);
  assert.equal((await member(workspaces, link, 1, "web")).created, false);
});
test("failed setup retains a changed Worktree and names the failed Project", async (t) => {
  const { root, link, store, workspaces } = await fixture(t, {
    getSettings: async () => ({ setupCommand: "setup" }),
    runSetup: async ({ cwd }) => {
      await fs.writeFile(path.join(cwd, "changed.txt"), "retain");
      return { status: "failed", output: "setup broke" };
    },
  });
  const operationId = randomUUID();
  await workspaces.prepareLinkChat({ link, chatId: 1, prompt: "", operationId });
  await assert.rejects(member(workspaces, link, 1, "api"), /Project api: Setup failed: setup broke/);
  const failed = (await store.get(link.id)).preparations[operationId].members[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.retainedPaths.length, 1);
  assert.equal(await fs.readFile(path.join(failed.retainedPaths[0], "changed.txt"), "utf8"), "retain");
  assert.ok(failed.retainedPaths[0].startsWith(root));
  await assert.rejects(member(workspaces, link, 1, "api"), /Retained Worktree/, "a retained Worktree is never replaced");
});
test("a member that fails to be made can be made again", async (t) => {
  let calls = 0;
  const { createWorktree } = require("./worktrees.cjs");
  const { link, store, workspaces } = await fixture(t, {
    createWorktree: async (args) => {
      if (++calls === 1) throw new Error("creation failed");
      return createWorktree(args);
    },
  });
  const operationId = randomUUID();
  await workspaces.prepareLinkChat({ link, chatId: 1, prompt: "", operationId });
  await assert.rejects(member(workspaces, link, 1, "web"), /creation failed/);
  const failed = (await store.get(link.id)).preparations[operationId].members[0];
  assert.deepEqual(failed.retainedPaths, []);
  const made = await member(workspaces, link, 1, "web");
  assert.equal(made.created, true);
  assert.equal(made.worktrees.length, 1);
});
test("crash recovery verifies a member that was being made", async (t) => {
  const { link, store, workspaces } = await fixture(t);
  const request = { link, chatId: 1, prompt: "", operationId: randomUUID() };
  await workspaces.prepareLinkChat(request);
  const made = await member(workspaces, link, 1, "api");
  await store.update(link.id, (state) => {
    const prep = state.preparations[request.operationId];
    return { ...state, preparations: { ...state.preparations, [request.operationId]: { ...prep, members: [{ ...prep.members[0], status: "reserved" }] } } };
  });
  await store.flush(link.id);
  await workspaces.recoverLinkPreparations(link.id);
  assert.deepEqual((await workspaces.chatMembers(link.id, 1)).worktrees, made.worktrees);
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
  await workspaces.prepareLinkChat(request);
  const { member: made } = await member(workspaces, link, 1, "api");
  await fs.writeFile(path.join(made.projectPath, ".git", "info", "exclude"), ".env\n");
  await fs.writeFile(path.join(made.worktreePath, ".env"), "keep this setup output");
  await store.update(link.id, (state) => {
    const prep = state.preparations[request.operationId];
    return {
      ...state,
      preparations: {
        ...state.preparations,
        [request.operationId]: {
          ...prep,
          members: prep.members.map((item) => ({ ...item, status: "reserved", setupCommand: "setup", setupStarted: true, setupDone: false })),
        },
      },
    };
  });
  await store.flush(link.id);
  await assert.rejects(workspaces.recoverLinkPreparations(link.id), /interrupted/);
  const failed = (await store.get(link.id)).preparations[request.operationId].members[0];
  assert.ok(failed.retainedPaths.includes(made.worktreePath));
  assert.equal(await fs.readFile(path.join(made.worktreePath, ".env"), "utf8"), "keep this setup output");
});
test("a linked Worktree stays available after its agent switches it to another branch", async (t) => {
  const { createChatScopes } = require("./chat-scopes.cjs");
  const { link, store, workspaces } = await fixture(t);
  await workspaces.prepareLinkChat({ link, chatId: 1, prompt: "change both", operationId: randomUUID() });
  await member(workspaces, link, 1, "api");
  const ready = await member(workspaces, link, 1, "web");
  await store.update(link.id, (state) => ({ ...state, sessions: { 1: { id: 1, workspacePath: ready.workspacePath, worktrees: ready.worktrees } } }));
  const scopes = createChatScopes({ projects: null, links: store, validateLink: async () => {} });
  const key = scopeKey({ kind: "link", linkId: link.id });
  assert.equal((await scopes.executionContext(key, 1)).cwd, ready.workspacePath);
  execFileSync("git", ["-C", ready.worktrees[0].worktreePath, "checkout", "-qb", "fix/rdp-2217"]);
  assert.equal((await scopes.executionContext(key, 1)).cwd, ready.workspacePath);
  await fs.rm(path.join(ready.workspacePath, ready.worktrees[1].alias));
  await assert.rejects(scopes.executionContext(key, 1), /its shared Worktree is unavailable/);
});
