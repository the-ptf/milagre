const assert = require("node:assert/strict");
const test = require("node:test");
const { withTaskChat } = require("./orchestrator-wiring.cjs");
const { isHiddenTaskChat, isListedChat } = require("@milagre/shared/chats");

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
