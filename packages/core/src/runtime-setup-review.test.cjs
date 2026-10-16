const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createRuntime } = require("./runtime.cjs");
const { scopeKey } = require("@milagre/shared/chat-scopes");

const command = `node -e "require('fs').writeFileSync('setup-marker','ran')"`;
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(read) {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (value) return value;
    await delay();
  }
  assert.fail("The expected setup state did not arrive");
}

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-setup-review-")));
  const dataDir = path.join(dir, "profile");
  const runtimes = [],
    turns = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const make = () => {
    const runtime = createRuntime({
      dataDir,
      worktreeRoot: path.join(dir, "worktrees"),
      registryRoots: [],
      environmentReady: Promise.resolve(),
      titleModels: {},
      expandSkills: false,
      agentCli: async () => ({ command: "/fake" }),
      createSession: (_provider, context) => ({
        turnActive: false,
        startTurn(request) {
          turns.push({ cwd: context.cwd, ...request });
          context.emit({ type: "turn-started", turnId: randomUUID() });
          context.emit({ type: "text-delta", messageId: "reply", text: "Done" });
          context.emit({ type: "turn-completed" });
          return { turnId: "turn" };
        },
        close() {},
        interrupt() {},
      }),
    });
    runtimes.push(runtime);
    return runtime;
  };
  async function project(name) {
    const folder = path.join(dir, name);
    await fs.mkdir(path.join(folder, ".milagre"), { recursive: true });
    await config(folder, command);
    execFileSync("git", ["init", "-qb", "main", folder]);
    execFileSync("git", ["-C", folder, "add", "."]);
    execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Initial"]);
    return folder;
  }
  async function create(runtime, projectPath) {
    await runtime.openProject(projectPath);
    const made = await runtime.invoke("worktree:create", [{ projectPath, baseBranch: "main", prompt: "test setup" }]);
    const session = Object.values(made.project.state.sessions).find((s) => s.worktree_id === made.worktreeId);
    return { projectPath, sessionId: session.id, chatId: `${projectPath}#${session.id}`, cwd: made.project.state.worktrees[made.worktreeId].path };
  }
  return { dir, dataDir, make, project, create, turns };
}
async function config(projectPath, setup) {
  await fs.writeFile(path.join(projectPath, ".milagre/worktree.json"), JSON.stringify({ setup }));
}
async function send(runtime, target) {
  await runtime.invoke("chat:send", [
    { projectPath: target.projectPath, sessionId: target.sessionId, body: "Work", provider: "codex", model: "test", permissionMode: "full" },
  ]);
}
async function approval(runtime, chatId) {
  return until(async () => (await runtime.invoke("chat:runs")).runs[chatId]?.approvals.find((r) => r.kind === "setup"));
}
const answer = (runtime, chatId, requestId, decision) => runtime.invoke("agent:respond-permission", [{ chatId, requestId, decision }]);
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
async function finished(runtime, chatId) {
  await until(async () => !(await runtime.invoke("chat:runs")).runs[chatId]);
  await runtime.flush();
}

test("repository setup blocks even full permission until the exact Chat request is approved", async (t) => {
  const f = await fixture(t),
    runtime = f.make(),
    project = await f.project("app");
  const target = await f.create(runtime, project);
  await send(runtime, target);
  const review = await approval(runtime, target.chatId);
  assert.equal(f.turns.length, 0);
  assert.equal(await exists(path.join(target.cwd, "setup-marker")), false);
  assert.equal(review.command, command);
  assert.equal(review.cwd, target.cwd);
  assert.equal(review.setup.projectPath, project);
  assert.equal(review.setup.source, path.join(project, ".milagre/worktree.json"));
  assert.ok(review.setup.computer);
  assert.equal(await answer(runtime, `${project}#9999`, review.requestId, "allow"), false);
  assert.equal(await answer(runtime, target.chatId, review.requestId, "invalid"), false);
  assert.deepEqual(
    await Promise.all([answer(runtime, target.chatId, review.requestId, "allow"), answer(runtime, target.chatId, review.requestId, "allow-for-chat")]),
    [true, false],
    "Only the first client can answer; a competing trust decision must not persist",
  );
  await finished(runtime, target.chatId);
  assert.equal(await fs.readFile(path.join(target.cwd, "setup-marker"), "utf8"), "ran");
  assert.equal(f.turns.length, 1);
  assert.equal(await answer(runtime, target.chatId, review.requestId, "allow"), false);
  const second = await f.create(runtime, project);
  await send(runtime, second);
  const again = await approval(runtime, second.chatId);
  await answer(runtime, second.chatId, again.requestId, "deny");
  await finished(runtime, second.chatId);
  assert.equal(await exists(path.join(second.cwd, "setup-marker")), false);
  assert.equal(f.turns.length, 2, "Skip setup continues the Chat without running the command");
});

test("trusted setup survives restart but is scoped to its Project and exact command", async (t) => {
  const f = await fixture(t),
    runtime = f.make(),
    project = await f.project("app");
  const first = await f.create(runtime, project);
  await send(runtime, first);
  await answer(runtime, first.chatId, (await approval(runtime, first.chatId)).requestId, "allow-for-chat");
  await finished(runtime, first.chatId);
  await runtime.close();
  const next = f.make();
  const second = await f.create(next, project);
  await send(next, second);
  await finished(next, second.chatId);
  assert.equal(await exists(path.join(second.cwd, "setup-marker")), true);
  const other = await f.create(next, await f.project("other"));
  await send(next, other);
  await answer(next, other.chatId, (await approval(next, other.chatId)).requestId, "deny");
  await finished(next, other.chatId);
  await config(project, `${command}; echo changed`);
  const changed = await f.create(next, project);
  await send(next, changed);
  const review = await approval(next, changed.chatId);
  assert.equal(review.command, `${command}; echo changed`);
  assert.equal(await exists(path.join(changed.cwd, "setup-marker")), false);
  await next.invoke("agent:interrupt", [changed.chatId]);
});

test("a changed command cannot use an approval of the previous version", async (t) => {
  const f = await fixture(t),
    runtime = f.make(),
    project = await f.project("app");
  const target = await f.create(runtime, project);
  await send(runtime, target);
  const old = await approval(runtime, target.chatId);
  await config(project, `${command}; echo new`);
  await answer(runtime, target.chatId, old.requestId, "allow-for-chat");
  const current = await until(async () => {
    const requests = (await runtime.invoke("chat:runs")).runs[target.chatId]?.approvals ?? [];
    return requests.find((r) => r.kind === "setup" && r.requestId !== old.requestId);
  });
  assert.equal(current.command, `${command}; echo new`);
  assert.equal(await exists(path.join(target.cwd, "setup-marker")), false);
  assert.equal(f.turns.length, 0);
  await answer(runtime, target.chatId, current.requestId, "deny");
  await finished(runtime, target.chatId);
});

test("a Worktree created before restart still requires review; Stop runs nothing", async (t) => {
  const f = await fixture(t),
    runtime = f.make(),
    project = await f.project("app");
  const target = await f.create(runtime, project);
  await runtime.close();
  const next = f.make();
  await next.openProject(project);
  await send(next, target);
  const old = await approval(next, target.chatId);
  await next.invoke("agent:interrupt", [target.chatId]);
  assert.equal(await exists(path.join(target.cwd, "setup-marker")), false);
  assert.equal(f.turns.length, 0);
  assert.equal(await answer(next, target.chatId, old.requestId, "allow"), false);
  await send(next, target);
  const again = await approval(next, target.chatId);
  await answer(next, target.chatId, again.requestId, "deny");
  await finished(next, target.chatId);
});

test("Named Link member setups use the same review before starting its shared agent", async (t) => {
  const f = await fixture(t),
    runtime = f.make();
  for (const name of ["api", "web"]) await runtime.openProject(await f.project(name));
  const projects = await runtime.invoke("project:registry");
  const link = await runtime.invoke("link:create", [{ name: "Both", projectIds: projects.map((p) => p.id) }]);
  await runtime.invoke("link:open", [link.id]);
  const sent = await runtime.invoke("link:send", [{ linkId: link.id, operationId: randomUUID(), body: "Work", provider: "codex", model: "test" }]);
  const chatId = `${scopeKey({ kind: "link", linkId: link.id })}#${sent.sessionId}`;
  const first = await approval(runtime, chatId);
  assert.equal(f.turns.length, 0);
  assert.equal(await exists(path.join(first.cwd, "setup-marker")), false);
  await answer(runtime, chatId, first.requestId, "allow");
  const second = await until(async () =>
    (await runtime.invoke("chat:runs")).runs[chatId]?.approvals.find((r) => r.kind === "setup" && r.requestId !== first.requestId),
  );
  assert.notEqual(second.setup.projectPath, first.setup.projectPath);
  assert.equal(f.turns.length, 0);
  await answer(runtime, chatId, second.requestId, "deny");
  await finished(runtime, chatId);
  assert.equal(f.turns.length, 1);
  assert.equal(await exists(path.join(first.cwd, "setup-marker")), true);
  assert.equal(await exists(path.join(second.cwd, "setup-marker")), false);
});

test("restarting during review keeps setup blocked and rejects the old response", async (t) => {
  const f = await fixture(t),
    runtime = f.make(),
    project = await f.project("app");
  const target = await f.create(runtime, project);
  await send(runtime, target);
  const old = await approval(runtime, target.chatId);
  await runtime.close();
  const next = f.make();
  await next.openProject(project);
  assert.equal(await answer(next, target.chatId, old.requestId, "allow"), false);
  await send(next, target);
  const current = await approval(next, target.chatId);
  assert.notEqual(current.requestId, old.requestId);
  assert.equal(f.turns.length, 0);
  assert.equal(await exists(path.join(target.cwd, "setup-marker")), false);
  await answer(next, target.chatId, current.requestId, "deny");
  await finished(next, target.chatId);
});

test("a failed trust save runs neither the command nor the agent", async (t) => {
  const f = await fixture(t),
    runtime = f.make(),
    project = await f.project("app");
  const target = await f.create(runtime, project);
  await send(runtime, target);
  const review = await approval(runtime, target.chatId);
  const settingsFile = path.join(f.dataDir, "project-settings.json");
  await fs.mkdir(settingsFile);
  await answer(runtime, target.chatId, review.requestId, "allow-for-chat");
  await finished(runtime, target.chatId);
  assert.equal(await exists(path.join(target.cwd, "setup-marker")), false);
  assert.equal(f.turns.length, 0);
  await fs.rmdir(settingsFile);
  await send(runtime, target);
  await answer(runtime, target.chatId, (await approval(runtime, target.chatId)).requestId, "deny");
  await finished(runtime, target.chatId);
});

test("a persisted interrupted setup requires review even when its exact command was trusted", async (t) => {
  const f = await fixture(t),
    runtime = f.make(),
    project = await f.project("app");
  const target = await f.create(runtime, project);
  await runtime.close();
  // Recovery input from a host that died after recording the start, before recording completion.
  const file = path.join(f.dataDir, "worktree-setups.json");
  const entries = JSON.parse(await fs.readFile(file, "utf8"));
  entries[0][1].status = "started";
  await fs.writeFile(file, JSON.stringify(entries));
  const { createProjectSettings } = require("./project-settings.cjs");
  await createProjectSettings(path.join(f.dataDir, "project-settings.json")).trustSetup(project, command);
  const next = f.make();
  await next.openProject(project);
  await send(next, target);
  const review = await approval(next, target.chatId);
  assert.match(review.description, /previous setup did not finish/);
  assert.equal(f.turns.length, 0);
  assert.equal(await exists(path.join(target.cwd, "setup-marker")), false);
  await answer(next, target.chatId, review.requestId, "deny");
  await finished(next, target.chatId);
});
