const assert = require("node:assert/strict");
const test = require("node:test");
const { taskBlockedText } = require("@milagre/shared/orchestrator");
const { withTaskChat } = require("../runtime/orchestrator-wiring.cjs");
const { createTaskTools } = require("./task-tools.cjs");

function setup() {
  let state = { sessions: { 1: { id: 1 }, 2: { id: 2, orchestrator: { taskId: "t2", hidden: true } } } };
  const sessionId = (chatId) => Number(chatId.split("#")[1]);
  const tools = createTaskTools({
    taskOf: (chatId) => state.sessions[sessionId(chatId)]?.orchestrator ?? null,
    setBlocked: (chatId, blocked) =>
      new Promise((resolve) =>
        setImmediate(() => {
          state = withTaskChat(state, sessionId(chatId), { blocked: blocked ?? undefined });
          resolve();
        }),
      ),
    now: () => 42,
  });
  return { tools, session: (id) => state.sessions[id], settled: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("only an Orchestrator task Chat's agent gets task_blocked", () => {
  const { tools } = setup();
  assert.deepEqual(tools.definitions("/p#1"), []);
  assert.deepEqual(
    tools.definitions("/p#2").map((tool) => [tool.name, tool.readOnly]),
    [["task_blocked", false]],
  );
});

test("task_blocked keeps the task in Needs you with its reason until the next turn starts", async () => {
  const { tools, session, settled } = setup();
  const [blocked] = tools.definitions("/p#2");
  const reply = await blocked.run({ reason: "Sign in to the resend MCP server with /mcp,\nthen reply continue." });
  assert.match(reply, /Needs you/);
  assert.deepEqual(session(2).orchestrator.blocked, { reason: "Sign in to the resend MCP server with /mcp, then reply continue.", at: 42 });
  assert.equal(taskBlockedText(session(2)), "Blocked: Sign in to the resend MCP server with /mcp, then reply continue.");
  tools.observe("/p#2", { type: "turn-completed" });
  await settled();
  assert.ok(session(2).orchestrator.blocked, "ending the turn keeps it");
  tools.observe("/p#2", { type: "turn-started" });
  await settled();
  assert.equal(Object.hasOwn(session(2).orchestrator, "blocked"), false);
  assert.equal(session(2).orchestrator.taskId, "t2", "clearing it keeps the task mark");
  await assert.rejects(blocked.run({ reason: " \n " }), /what the owner must do/);
});
