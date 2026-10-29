const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createRuntime } = require("./runtime.cjs");
const { runTool } = require("./linked-tools.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");
async function fixture(t, provider = "claude") {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "runtime-advisors-")));
  const project = path.join(dir, "project");
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
    dataDir: path.join(dir, "data"),
    chatsHome: path.join(dir, "chats"),
    worktreeRoot: path.join(dir, "worktrees"),
    cwd: project,
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    agentCliStatus: async () => ({ claude: { state: "ready" }, codex: { state: "ready" } }),
    agentModels: async () => ({ claude: [{ id: "cm", efforts: [] }], codex: [{ id: "xm", efforts: [] }] }),
    createSession(provider, options) {
      const session = {
        provider,
        options,
        turns: [],
        turnActive: false,
        startTurn: async (request) => {
          session.turns.push(request);
          session.turnActive = true;
          options.emit({ type: "turn-started", turnId: "turn" });
          return { turnId: "turn" };
        },
        interrupt: async () => {
          session.turnActive = false;
          options.emit({ type: "turn-cancelled" });
        },
        close: async () => {},
        setPermissionMode: async () => {},
        finish: (text = "Review result") => {
          session.turnActive = false;
          options.emit({ type: "text-delta", messageId: "reply", text });
          options.emit({ type: "turn-completed" });
        },
      };
      sessions.push(session);
      return session;
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(project);
  const id = Object.values(opened.state.sessions)[0].id;
  const chatId = `${project}#${id}`;
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "Review", provider, model: "cm", permissionMode: "full" }]);
  await waitUntil(() => sessions.length === 1 && sessions[0].turns.length === 1);
  const tool = (name) => sessions[0].options.linked.tools.find((t) => t.name === name);
  return { runtime, sessions, tool, chatId, id, project, dir };
}
test("main Chat tools launch the other provider with isolated reads and return labeled results", async (t) => {
  const f = await fixture(t);
  const reply = await runTool(f.tool("create_advisor"), { title: "Review", prompt: "Assess" });
  assert.equal(reply.isError, false);
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  assert.equal(f.sessions[1].provider, "codex");
  assert.equal(f.sessions[1].options.analysisOnly, true);
  assert.ok(f.sessions[1].options.linked.tools.every((t) => t.readOnly));
  assert.equal(f.sessions[1].options.cwd, f.project);
  f.sessions[1].finish();
  await waitUntil(() => f.sessions[0].turns.length === 2);
  const current = await f.runtime.openProject(f.project);
  const result = current.state.messages.find((m) => m.context?.kind === "advisor-result");
  assert.ok(result);
  assert.equal(result.context.provider, "codex");
  assert.equal(result.body, "Review result");
  const advisor = current.state.sessions[f.id].subagents.find((a) => a.source === "milagre-advisor");
  assert.equal(advisor.archived, undefined);
  await assert.rejects(f.runtime.invoke("advisor:stop", [`${f.project}#999`, advisor.id]), /Chat|belong/i);
});
test("parent Stop cancels owned advisors and late completion cannot resume the parent", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("create_advisor"), { title: "Review", prompt: "Assess" });
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  await f.runtime.invoke("agent:interrupt", [f.chatId]);
  f.sessions[1].finish();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.sessions[0].turns.length, 1);
  const current = await f.runtime.openProject(f.project);
  assert.equal(current.state.sessions[f.id].subagents[0].status, "cancelled");
});
test("execution advisors keep the parent provider and stop when Full permissions are revoked", async (t) => {
  const f = await fixture(t);
  const reply = await runTool(f.tool("create_advisor"), { title: "Run the app", prompt: "Run checks", mode: "execution" });
  assert.equal(reply.isError, false, reply.text);
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  const execution = f.sessions[1];
  assert.equal(execution.provider, "codex");
  assert.equal(execution.options.analysisOnly, false);
  assert.equal(execution.options.executionAdvisor, true);
  assert.equal(execution.turns[0].permissionMode, "full");
  assert.ok(execution.options.linked.tools.some((tool) => tool.name === "browser_attach"));
  await f.runtime.invoke("agent:set-permission-mode", [{ chatId: f.chatId, mode: "auto" }]);
  assert.equal(execution.turnActive, false, "revoking Full stops the live execution before returning");
  // Cancellation is published asynchronously so slow admission/storage cannot delay stopping the process.
  await waitUntil(() => f.runtime.snapshot().projects[0].state.sessions[f.id].subagents[0]?.status === "cancelled");
  const current = await f.runtime.openProject(f.project);
  assert.equal(current.state.sessions[f.id].provider, "claude");
  assert.equal(current.state.sessions[f.id].subagents[0].status, "cancelled");
  assert.equal((await runTool(f.tool("create_advisor"), { title: "Run", prompt: "Run", mode: "execution" })).isError, true);
});
test("execution screenshots are saved before delivery and survive deleting the original", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "evidence.png");
  await fs.writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6l8AAAAASUVORK5CYII=", "base64"));
  const reply = await runTool(f.tool("create_advisor"), { title: "Evidence", prompt: "Run checks", mode: "execution" });
  assert.equal(reply.isError, false, reply.text);
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  const body = `Passed. Command: \`cat ${file}\`.\n\n![Evidence](../evidence.png)`;
  f.sessions[1].finish(body);
  await waitUntil(() => f.sessions[0].turns.length === 2);
  const state = (await f.runtime.openProject(f.project)).state;
  const message = state.messages.find((item) => item.context?.kind === "advisor-result");
  assert.equal(message.context.mode, "execution");
  assert.match(f.sessions[0].turns[1].prompt, /execution report/);
  assert.equal(message.body, body);
  const saved = message.context.images[0].path;
  assert.notEqual(saved, file);
  await fs.rm(file);
  assert.ok((await fs.stat(saved)).size > 0);
});
test("advisor completion waits for a human question before steering", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("create_advisor"), { title: "Review", prompt: "Assess" });
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  f.sessions[0].options.emit({ type: "question-request", requestId: "human", questions: [] });
  await waitUntil(() => f.runtime.snapshot().runs.runs[f.chatId]?.questions.length === 1);
  f.sessions[1].finish();
  await waitUntil(() => f.runtime.snapshot().projects[0].state.sessions[f.id].subagents[0].status === "completed");
  assert.equal(f.sessions[0].turns.length, 1);
  f.sessions[0].options.emit({ type: "question-resolved", requestId: "human", outcome: "answered" });
  await waitUntil(() => f.sessions[0].turns.length === 2);
});
test("an idle parent resumes when its advisor settles", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("create_advisor"), { title: "Review", prompt: "Assess" });
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  f.sessions[0].finish("Waiting for advice");
  await waitUntil(() => !f.runtime.snapshot().runs.runs[f.chatId]);
  f.sessions[1].finish();
  await waitUntil(() => f.sessions[0].turns.length === 2);
  assert.equal(f.sessions[0].turns[1].model, "cm");
});

test("advisor results for Antigravity stay queued through Stop and send once when resumed", async (t) => {
  const f = await fixture(t, "antigravity");
  const result = await runTool(f.tool("create_advisor"), { title: "Review", prompt: "Assess", provider: "codex", model: "xm" });
  assert.equal(result.isError, false);
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  f.sessions[1].finish();
  await waitUntil(() => {
    const state = f.runtime.snapshot().projects[0].state;
    return state.sessions[f.id].queued?.length || state.messages.some((m) => m.context?.kind === "advisor-result");
  });
  const queued = f.runtime.snapshot().projects[0].state.sessions[f.id].queued;
  assert.equal(queued?.length, 1, "the result must wait visibly instead of entering the live provider turn");
  assert.equal(queued[0].context.kind, "advisor-result");
  assert.equal(f.sessions[0].turns.length, 1);
  await f.runtime.invoke("agent:interrupt", [f.chatId]);
  await waitUntil(() => !f.runtime.snapshot().runs.runs[f.chatId]);
  assert.equal(f.runtime.snapshot().projects[0].state.sessions[f.id].queued.length, 1);
  await f.runtime.invoke("chat:queue-send", [f.chatId, queued[0].id]);
  await waitUntil(() => f.sessions[0].turns.length === 2);
  assert.match(f.sessions[0].turns[1].prompt, /Review result/);
  assert.equal(f.runtime.snapshot().projects[0].state.messages.filter((m) => m.context?.kind === "advisor-result").length, 1);
});

for (const provider of ["claude", "antigravity"]) {
  test(`a shared Chat's ${provider} advisor result survives creating a Worktree`, async (t) => {
    const f = await fixture(t);
    const other = path.join(f.dir, "other");
    execFileSync("git", ["clone", "-q", f.project, other]);
    await fs.writeFile(path.join(f.project, "README.md"), "First Project");
    await fs.writeFile(path.join(other, "README.md"), "Other Project");
    await f.runtime.openProject(other);
    const projects = await f.runtime.invoke("project:registry");
    const link = await f.runtime.invoke("link:create", [{ name: "Review", projectIds: projects.map((p) => p.id) }]);
    await f.runtime.invoke("link:open", [link.id]);
    const sent = await f.runtime.invoke("link:send", [
      { linkId: link.id, operationId: randomUUID(), body: "Review", provider, model: "cm", permissionMode: "full" },
    ]);
    await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
    const parent = f.sessions[1];
    const tool = (name) => parent.options.linked.tools.find((item) => item.name === name);
    const advisor = await runTool(tool("create_advisor"), { title: "Review", prompt: "Assess", provider: "codex", model: "xm" });
    assert.equal(advisor.isError, false);
    await waitUntil(() => f.sessions.length === 3 && f.sessions[2].turns.length === 1);
    const read = f.sessions[2].options.linked.tools.find((item) => item.name === "advisor_read_file");
    for (const root of [f.project, other]) {
      const result = await runTool(read, { root, path: "README.md" });
      assert.equal(result.isError, false, "advisors can read Projects before a Worktree is created");
      assert.match(result.text, /Project/);
    }
    const created = await runTool(tool("link_worktree_create"), { project: "project" });
    assert.equal(created.isError, false);
    f.sessions[2].finish("Advice after expansion");
    let state;
    for (let i = 0; i < 200; i++) {
      state = (await f.runtime.invoke("link:snapshot", [link.id])).state;
      if (state.sessions[sent.sessionId].queued?.length || parent.turns.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (provider === "antigravity") {
      assert.equal(state.sessions[sent.sessionId].queued?.[0]?.context?.kind, "advisor-result");
      assert.equal(parent.turns.length, 1);
    } else {
      assert.equal(parent.turns.length, 2);
      assert.match(parent.turns[1].prompt, /Advice after expansion/);
    }
  });
}
