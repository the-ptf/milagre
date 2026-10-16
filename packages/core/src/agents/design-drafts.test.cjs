const assert = require("node:assert/strict");
const test = require("node:test");
const { mapClaudeMessage } = require("./events.cjs");
const { DRAFT_MS } = require("./design-drafts.cjs");

const stream = (event, parent = null) => ({ type: "stream_event", parent_tool_use_id: parent, event });
const start = (index, id, name) => stream({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
const piece = (index, partial_json) => stream({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
const stop = (index) => stream({ type: "content_block_stop", index });

function clock() {
  const state = { sessionId: null, turnId: "turn-a", hasText: false, time: 1000 };
  state.now = () => state.time;
  return state;
}

test("Claude: a design tool's input streams as step-draft pieces with the call's id, throttled, and whole at its end", () => {
  const state = clock();
  assert.deepEqual(mapClaudeMessage(start(1, "toolu_1", "mcp__milagre__design_show"), state), [
    { type: "step-draft", id: "toolu_1", tool: "design_show", offset: 0, text: "" },
  ]);
  // Within the throttle window the pieces wait.
  assert.deepEqual(mapClaudeMessage(piece(1, '{"title":"Lo'), state), []);
  state.time += DRAFT_MS;
  assert.deepEqual(mapClaudeMessage(piece(1, 'gin","document":{'), state), [
    { type: "step-draft", id: "toolu_1", tool: "design_show", offset: 0, text: '{"title":"Login","document":{' },
  ]);
  state.time += 10;
  assert.deepEqual(mapClaudeMessage(piece(1, '"width":390'), state), []);
  assert.deepEqual(mapClaudeMessage(stop(1), state), [{ type: "step-draft", id: "toolu_1", tool: "design_show", offset: 29, text: '"width":390', done: true }]);
  // The finished block becomes the step, with the same id.
  const [step] = mapClaudeMessage(
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__milagre__design_show", input: { title: "Login" } }] },
    },
    state,
  );
  assert.equal(step.type, "step-started");
  assert.equal(step.step.id, "toolu_1");
});

test("Claude: design_apply drafts too; other tools and other servers never send their input", () => {
  const state = clock();
  assert.deepEqual(mapClaudeMessage(start(0, "toolu_bash", "Bash"), state), []);
  assert.deepEqual(mapClaudeMessage(piece(0, '{"command":"ls"}'), state), []);
  assert.deepEqual(mapClaudeMessage(stop(0), state), []);
  assert.deepEqual(mapClaudeMessage(start(1, "toolu_other", "mcp__pencil__design_show"), state), []);
  assert.deepEqual(mapClaudeMessage(start(2, "toolu_read", "mcp__milagre__design_read"), state), []);
  assert.deepEqual(mapClaudeMessage(start(4, "toolu_apply", "mcp__milagre__design_apply"), state), [
    { type: "step-draft", id: "toolu_apply", tool: "design_apply", offset: 0, text: "" },
  ]);
  state.time += DRAFT_MS;
  assert.deepEqual(mapClaudeMessage(piece(4, '{"id":"login"'), state), [
    { type: "step-draft", id: "toolu_apply", tool: "design_apply", offset: 0, text: '{"id":"login"' },
  ]);
  // Nothing new at the end still says the input is whole.
  assert.deepEqual(mapClaudeMessage(stop(4), state), [{ type: "step-draft", id: "toolu_apply", tool: "design_apply", offset: 13, text: "", done: true }]);
  assert.equal(state.drafts.size, 0);
});

test("Claude: a new message drops a draft whose block never stopped", () => {
  const state = clock();
  mapClaudeMessage(start(1, "toolu_1", "mcp__milagre__design_show"), state);
  assert.deepEqual(mapClaudeMessage(stream({ type: "message_start", message: {} }), state), []);
  assert.deepEqual(mapClaudeMessage(piece(1, "{}"), state), []);
  assert.deepEqual(mapClaudeMessage(stop(1), state), []);
});

test("Claude: a subagent's design call drafts with the subagent's id, its blocks apart from the parent's", () => {
  const state = clock();
  assert.deepEqual(mapClaudeMessage(start(1, "toolu_main", "mcp__milagre__design_show"), state), [
    { type: "step-draft", id: "toolu_main", tool: "design_show", offset: 0, text: "" },
  ]);
  assert.deepEqual(
    mapClaudeMessage(
      stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_sub", name: "mcp__milagre__design_show" } }, "toolu_agent"),
      state,
    ),
    [{ type: "step-draft", id: "toolu_sub", tool: "design_show", offset: 0, text: "", agent: "toolu_agent" }],
  );
  state.time += DRAFT_MS;
  assert.deepEqual(mapClaudeMessage(piece(1, '{"title":"A"'), state), [
    { type: "step-draft", id: "toolu_main", tool: "design_show", offset: 0, text: '{"title":"A"' },
  ]);
  // The subagent's new message drops only its own unfinished block.
  assert.deepEqual(mapClaudeMessage(stream({ type: "message_start", message: {} }, "toolu_agent"), state), []);
  assert.deepEqual(mapClaudeMessage(stream({ type: "content_block_stop", index: 1 }, "toolu_agent"), state), []);
  assert.deepEqual(mapClaudeMessage(stop(1), state), [{ type: "step-draft", id: "toolu_main", tool: "design_show", offset: 12, text: "", done: true }]);
});

test("Claude: a subagent's design call is an artifact step of the reply, named for the subagent", () => {
  const state = clock();
  const call = { type: "tool_use", id: "toolu_sub", name: "mcp__milagre__design_show", input: { title: "Card" } };
  assert.deepEqual(mapClaudeMessage({ type: "assistant", parent_tool_use_id: "toolu_agent", message: { content: [call] } }, state), [
    { type: "step-started", step: { id: "toolu_sub", kind: "artifact", title: "Showed `Card`", tool: "design_show", agent: "toolu_agent" } },
  ]);
  const result = JSON.stringify({ id: "card", version: 1, title: "Card", format: "design" });
  const events = mapClaudeMessage(
    {
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: [{ type: "text", text: result }] }] },
    },
    state,
  );
  assert.deepEqual(events, [
    { type: "step-completed", id: "toolu_sub", status: "done", artifact: { id: "card", version: 1, title: "Card", format: "design" }, title: "Showed `Card`" },
  ]);
  // Its other tools stay in its own transcript.
  assert.deepEqual(
    mapClaudeMessage(
      { type: "assistant", parent_tool_use_id: "toolu_agent", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] } },
      state,
    ),
    [],
  );
});
