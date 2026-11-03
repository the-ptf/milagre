const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

test("runtime owns scope persistence, provider checks, observations and explicit next-turn expansion", async (t) => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "runtime-edit-scope-")));
  const project = path.join(temporary, "project");
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
  const sessions = [];
  const runtime = createRuntime({
    dataDir: path.join(temporary, "data"),
    chatsHome: path.join(temporary, "chats"),
    cwd: project,
    environmentReady: Promise.resolve(),
    titleModels: {},
    expandSkills: false,
    agentCli: async () => ({ command: "fixture" }),
    createSession(provider, options) {
      const session = {
        turnActive: false,
        closed: false,
        turns: [],
        startTurn: async (request) => {
          session.turnActive = true;
          session.turns.push(request);
          options.emit({ type: "turn-started", turnId: "t" });
          return { turnId: "t" };
        },
        interrupt: async () => {
          session.turnActive = false;
          options.emit({ type: "turn-cancelled" });
        },
        close: async () => {
          session.closed = true;
        },
        finish: () => {
          session.turnActive = false;
          options.emit({ type: "turn-completed" });
        },
        options,
      };
      sessions.push(session);
      return session;
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(project),
    id = Object.values(opened.state.sessions)[0].id,
    chatId = `${project}#${id}`;
  const policy = { allowed: [{ root: project, path: "allowed" }], protected: [{ root: project, path: "protected" }] };
  await runtime.invoke("chat:edit-scope:save", [{ chatId, revision: 0, policy }]);
  await runtime.invoke("chat:patch", [project, id, { editScope: { allowed: [{ root: project, path: "." }], protected: [] } }]);
  assert.deepEqual((await runtime.invoke("chat:edit-scope:read", [{ chatId }])).policy, policy, "generic Chat patches cannot widen host policy");
  const send = () =>
    runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "work", provider: "claude", model: "cm", permissionMode: "full" }]);
  await send();
  await waitUntil(() => sessions[0]?.turns.length === 1);
  assert.match(sessions[0].turns[0].prompt, /Active edit scope/);
  assert.match(sessions[0].options.editScopeCheck([path.join(project, "other")]), /outside/);
  await assert.rejects(runtime.invoke("chat:edit-scope:save", [{ chatId, revision: 1, policy: null }]), /Stop/);
  await fs.writeFile(path.join(project, "protected"), "shell write");
  const request = sessions[0].options.linked.tools.find((tool) => tool.name === "edit_scope_request");
  await request.run({ allowed: [{ root: project, path: "." }], protected: policy.protected, reason: "Need other files" });
  const waiting = await runtime.invoke("chat:edit-scope:read", [{ chatId }]);
  await runtime.invoke("chat:edit-scope:resolve", [{ chatId, id: waiting.pending.id, approved: true }]);
  assert.match(sessions[0].options.editScopeCheck([path.join(project, "other")]), /outside/);
  sessions[0].finish();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await runtime.invoke("chat:edit-scope:read", [{ chatId }])).busy) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const after = await runtime.invoke("chat:edit-scope:read", [{ chatId }]);
  assert.ok(after.warnings.some((w) => w.path === "protected"));
  await send();
  await waitUntil(() => sessions[0].turns.length === 2);
  assert.equal(sessions[0].options.editScopeCheck([path.join(project, "other")]), null);
  assert.match(sessions[0].options.editScopeCheck([path.join(project, "protected")]), /protected/);
  sessions[0].finish();
});
