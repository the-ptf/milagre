const assert = require("node:assert/strict");
const test = require("node:test");
const { withTaskChat } = require("./orchestrator-wiring.cjs");
const { isHiddenTaskChat, isListedChat } = require("@milagre/shared/chats");
const { applyStatePatch, diffState } = require("@milagre/shared/state-patch");

test("a task Chat keeps its Orchestrator mark, so the sidebar hides it until it is moved there", () => {
  const state = { sessions: { 7: { id: 7, title: "Fix the rest timer", summary: { count: 2 } } } };
  const marked = withTaskChat(state, 7, { taskId: "task", hidden: true, accounts: { claude: "personal" } });
  assert.deepEqual(marked.sessions[7].orchestrator, { taskId: "task", hidden: true, accounts: { claude: "personal" } });
  assert.equal(isHiddenTaskChat(marked.sessions[7]), true);
  assert.equal(isListedChat(marked.sessions[7], 2), false);
  const shown = withTaskChat(marked, 7, { hidden: false });
  assert.deepEqual(shown.sessions[7].orchestrator, { taskId: "task", hidden: false, accounts: { claude: "personal" } });
  assert.equal(isListedChat(shown.sessions[7], 2), true);
  assert.equal(withTaskChat(state, 99, { hidden: true }), state);
});

test("clearing a task's block removes it for the Chat's viewers too, through the state patch", () => {
  const blocked = { reason: "Sign in to resend", at: 1 };
  const state = { sessions: { 7: { id: 7, orchestrator: { taskId: "task", hidden: true, blocked } } } };
  const cleared = withTaskChat(state, 7, { blocked: undefined });
  assert.deepEqual(cleared.sessions[7].orchestrator, { taskId: "task", hidden: true });
  const patch = JSON.parse(JSON.stringify(diffState(state, cleared)));
  assert.deepEqual(applyStatePatch(state, patch).sessions[7].orchestrator, { taskId: "task", hidden: true });
});
