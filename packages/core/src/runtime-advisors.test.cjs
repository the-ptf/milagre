const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { runTool } = require("./linked-tools.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");
async function fixture(t) {
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
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "Review", provider: "claude", model: "cm", permissionMode: "full" }]);
  await waitUntil(() => sessions.length === 1 && sessions[0].turns.length === 1);
  const tool = (name) => sessions[0].options.linked.tools.find((t) => t.name === name);
  return { runtime, sessions, tool, chatId, id, project };
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
test("new advisors inherit the current host Designs availability", async (t) => {
  const f = await fixture(t);
  await f.runtime.invoke("designs:enabled:save", [false]);
  const reply = await runTool(f.tool("create_advisor"), { title: "Review", prompt: "Assess" });
  assert.equal(reply.isError, false);
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1);
  assert.equal(f.sessions[1].options.designsEnabled, false);
  assert.ok(!f.sessions[1].options.linked.tools.some((tool) => tool.name.startsWith("design_")));
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
