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
test("a Worktree made mid-turn lets Auto edit there without a card, and the next turn starts with it", async (t) => {
  const { PendingPermissions } = require("./permissions.cjs");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-added-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const manager = new SessionManager({
    createSession: (_provider, context) => {
      const session = { ...context, startTurn() {}, close() {} };
      calls.push(session);
      return session;
    },
    send() {},
  });
  t.after(() => manager.closeAll());
  const request = { chatId: "link#1", provider: "codex", cwd: "/workspace", workspaceRoots: [], workspaceInstructions: "None yet" };
  await manager.startTurn(request);
  assert.equal(manager.extendWorkspace("link#1", root), true);
  assert.equal(manager.extendWorkspace("link#1", root), false, "a Worktree already known changes nothing");
  assert.deepEqual(calls[0].workspaceRoots, [root]);
  assert.deepEqual(calls[0].addedRoots, [root]);
  await manager.startTurn({ ...request, workspaceRoots: [root], workspaceInstructions: "Owned" });
  assert.equal(calls.length, 2, "the next turn's session knows the Worktree from its start");

  const answers = [];
  const permissions = new PendingPermissions(() => {});
  permissions.setMode("auto");
  permissions.add({ requestId: "a", kind: "edit" }, (decision) => answers.push(decision), { inWorkspace: true, addedRoot: true });
  permissions.add({ requestId: "b", kind: "command" }, (decision) => answers.push(decision), { addedRoot: true });
  permissions.add({ requestId: "c", kind: "edit" }, (decision) => answers.push(decision), { inWorkspace: true });
  assert.deepEqual(answers, ["allow"]);
  assert.equal(permissions.size, 2, "commands, and edits the agent's own rules ask about, still ask");
});
test("Claude reads a shared Chat's main checkouts without a card, but never edits them unasked", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-read-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, "api");
  await fs.mkdir(main);
  await fs.writeFile(path.join(main, "a.txt"), "a");
  const events = [];
  const session = new ClaudeSession({ cwd: path.join(root, "workspace"), readRoots: [main], emit: (event) => events.push(event), command: "/claude" });
  t.after(() => session.close());
  session.turnActive = true;
  assert.equal((await session.askPermission("Read", { file_path: path.join(main, "a.txt") }, { requestId: "r" })).behavior, "allow");
  assert.equal((await session.askPermission("Grep", { pattern: "a", path: main }, { requestId: "g" })).behavior, "allow");
  assert.equal(events.length, 0);
  void session.askPermission("Write", { file_path: path.join(main, "a.txt"), content: "b" }, { requestId: "w" });
  void session.askPermission("Read", { file_path: path.join(root, "other.txt") }, { requestId: "o" });
  assert.deepEqual(
    events.filter((event) => event.type === "permission-request").map((event) => event.requestId),
    ["w", "o"],
  );
});
