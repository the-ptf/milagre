const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { insideWorkspace } = require("./permissions.cjs");
const { codexPolicy } = require("./codex-provider.cjs");
const { SessionManager } = require("./session-manager.cjs");
const { ClaudeSession } = require("./claude-provider.cjs");
test("owned roots permit member paths but reject symlinks escaping to another repository", async (t) => {
  assert.equal(typeof insideWorkspace, "function");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-roots-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const member = path.join(root, "member"),
    external = path.join(root, "external");
  await fs.mkdir(member);
  await fs.mkdir(external);
  await fs.symlink(external, path.join(member, "escape"));
  assert.equal(await insideWorkspace([member], [path.join(member, "new.txt")]), true);
  assert.equal(await insideWorkspace([member], [path.join(member, "escape", "new.txt")]), false);
  assert.equal(await insideWorkspace([member], [path.join(external, "new.txt")]), false);
});
test("Codex includes all owned Worktrees without widening to main checkouts", () => {
  assert.deepEqual(codexPolicy("auto", "/workspace", ["/work/api", "/work/web"]).sandboxPolicy.writableRoots, ["/workspace", "/work/api", "/work/web"]);
});
test("Claude receives additional directories and owned workspace instructions", async (t) => {
  let options;
  const session = new ClaudeSession({
    cwd: "/workspace",
    workspaceRoots: ["/work/api", "/work/web"],
    workspaceInstructions: "Owned: api and web",
    emit() {},
    command: "/claude",
    loadSdk: async () => ({
      query: (input) => {
        options = input.options;
        return { async *[Symbol.asyncIterator]() {}, close() {} };
      },
    }),
  });
  t.after(() => session.close());
  await session.start("model", "default");
  assert.deepEqual(options.additionalDirectories, ["/work/api", "/work/web"]);
  assert.match(options.systemPrompt.append, /Owned: api and web/);
});
test("a provider session is replaced when its owned root set changes", async (t) => {
  const calls = [];
  const manager = new SessionManager({
    createSession: (_provider, context) => {
      calls.push(context);
      return { startTurn() {}, close() {} };
    },
    send() {},
  });
  t.after(() => manager.closeAll());
  const request = { chatId: "link#1", provider: "codex", cwd: "/workspace", workspaceRoots: ["/work/api"], workspaceInstructions: "Owned" };
  await manager.startTurn(request);
  await manager.startTurn(request);
  await manager.startTurn({ ...request, workspaceRoots: ["/work/api", "/work/web"] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].workspaceRoots, ["/work/api", "/work/web"]);
});
test("a Link Project without a Worktree is read-only, and one made mid-session is owned in Auto", async (t) => {
  const { WorkspaceAccess } = require("./permissions.cjs");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-roots-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const [main, late] = [path.join(root, "web"), path.join(root, "worktrees", "api")];
  await fs.mkdir(main);
  await fs.mkdir(late, { recursive: true });
  // A missing main checkout leaves only its own requests to the usual cards.
  const access = new WorkspaceAccess({ cwd: root, workspaceRoots: [], readOnlyRoots: [main, path.join(root, "gone")] });
  const request = (kind, file) => ({ kind, files: [file] });
  assert.equal(access.answer(request("edit", path.join(main, "a.ts")), "auto").decision, "deny");
  assert.deepEqual(access.answer(request("read", path.join(main, "a.ts")), "ask"), { decision: "allow", learn: [] });
  assert.equal(access.answer(request("command", path.join(main, "a.ts")), "auto"), null);
  access.own([late], [main]);
  assert.equal(access.contains([path.join(late, "a.ts")]), true);
  assert.deepEqual(access.answer(request("edit", path.join(late, "a.ts")), "auto"), { decision: "allow", learn: [late] });
  assert.equal(access.answer(request("edit", path.join(late, "a.ts")), "ask"), null);
  assert.equal(access.answer(request("edit", path.join(root, "elsewhere.ts")), "auto"), null);
  access.learned();
  assert.equal(access.answer(request("edit", path.join(late, "a.ts")), "auto"), null);
});
test("Claude refuses edits in a main checkout and adds a Worktree made mid-session for the rest of it", async (t) => {
  const { WorkspaceAccess } = require("./permissions.cjs");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-roots-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const [main, late] = [path.join(root, "web"), path.join(root, "worktrees", "api")];
  await fs.mkdir(main);
  await fs.mkdir(late, { recursive: true });
  const access = new WorkspaceAccess({ cwd: root, workspaceRoots: [], readOnlyRoots: [main] });
  const session = new ClaudeSession({ cwd: root, access, emit() {}, command: "/claude" });
  t.after(() => session.close());
  session.turnActive = true;
  session.permissions.setMode("auto");
  const edit = (file) => session.askPermission("Edit", { file_path: file, old_string: "a", new_string: "b" }, { toolUseID: file });
  assert.equal((await edit(path.join(main, "a.ts"))).behavior, "deny");
  const read = await session.askPermission("Read", { file_path: path.join(main, "a.ts") }, { toolUseID: "read" });
  assert.deepEqual(read, { behavior: "allow", updatedInput: { file_path: path.join(main, "a.ts") } });
  access.own([late], []);
  const allowed = await edit(path.join(late, "a.ts"));
  assert.equal(allowed.behavior, "allow");
  assert.deepEqual(allowed.updatedPermissions, [{ type: "addDirectories", directories: [late], destination: "session" }]);
  assert.deepEqual(access.known, [late]);
});
test("a Worktree made mid-session updates the running session without replacing it", async (t) => {
  const calls = [];
  const manager = new SessionManager({
    createSession: (_provider, context) => {
      calls.push(context);
      return { startTurn() {}, close() {} };
    },
    send() {},
  });
  t.after(() => manager.closeAll());
  const request = {
    chatId: "link#1",
    provider: "claude",
    cwd: "/workspace",
    workspaceRoots: [],
    readOnlyRoots: ["/main/api"],
    workspaceInstructions: "None yet",
  };
  await manager.startTurn(request);
  assert.deepEqual(calls[0].access.readOnlyRoots, ["/main/api"]);
  const next = { workspaceRoots: ["/work/api"], readOnlyRoots: [], workspaceInstructions: "Owned: api" };
  manager.updateWorkspace("link#1", next);
  assert.deepEqual([calls[0].access.roots, calls[0].access.readOnlyRoots], [["/work/api"], []]);
  await manager.startTurn({ ...request, ...next });
  assert.equal(calls.length, 1);
});

test("Milagre's bundled skills are readable without a card, never editable", async (t) => {
  const { WorkspaceAccess } = require("./permissions.cjs");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-roots-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skills = path.join(root, "bundled-skills");
  await fs.mkdir(path.join(skills, "desktop"), { recursive: true });
  const access = new WorkspaceAccess({ cwd: path.join(root, "chat"), skillsDirectory: skills });
  const file = path.join(skills, "desktop", "SKILL.md");
  assert.deepEqual(access.answer({ kind: "read", files: [file] }, "ask"), { decision: "allow", learn: [] });
  assert.equal(access.answer({ kind: "edit", files: [file] }, "ask"), null);
  assert.equal(access.answer({ kind: "read", files: [file, path.join(root, "secret.txt")] }, "ask"), null);
});
