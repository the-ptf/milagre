const assert = require("node:assert/strict");
const test = require("node:test");
const { withChatSummaries } = require("./chat-summaries.cjs");

const reply = (id, session_id, extra = {}) => ({ id, session_id, role: "assistant", body: "Done", context: null, ...extra });
const ask = (id, session_id, body) => ({ id, session_id, role: "user", body, context: null });
const state = () => ({
  next_id: 5,
  sessions: { 1: { id: 1, agent_name: "a" }, 2: { id: 2, agent_name: "b" }, 3: { id: 3, agent_name: "empty" } },
  messages: [ask(1, 1, "First chat"), ask(2, 2, "Second chat"), reply(3, 1, { outcome: "completed" }), reply(4, 2, { outcome: "failed" })],
});

test("a state read without summaries gets one for every Chat, an empty one included", () => {
  const next = withChatSummaries(state(), null);
  assert.deepEqual(next.sessions[1].summary, { count: 2, firstId: 1, lastId: 3, titleLine: "First chat", lastOutcome: "completed" });
  assert.deepEqual(next.sessions[2].summary, { count: 2, firstId: 2, lastId: 4, titleLine: "Second chat", lastOutcome: "failed" });
  assert.deepEqual(next.sessions[3].summary, { count: 0 });
  assert.equal(withChatSummaries(next, next), next, "an unchanged state comes back as is");
});

test("a reply updates its own Chat's summary only, and a rename keeps every summary", () => {
  const before = withChatSummaries(state(), null);
  const after = withChatSummaries({ ...before, next_id: 6, messages: [...before.messages, reply(5, 2, { outcome: "completed" })] }, before, () => 9);
  assert.equal(after.sessions[1], before.sessions[1]);
  assert.equal(after.sessions[3], before.sessions[3]);
  assert.deepEqual(after.sessions[2].summary, { count: 3, firstId: 2, lastId: 5, lastAt: 9, titleLine: "Second chat", lastOutcome: "completed" });
  const renamed = { ...after, sessions: { ...after.sessions, 1: { ...after.sessions[1], title: "Named" } } };
  const kept = withChatSummaries(renamed, after);
  assert.equal(kept, renamed);
  assert.equal(kept.sessions[1].summary, after.sessions[1].summary);
});

test("a Chat whose messages are gone, or a session rebuilt without its summary, is summarized again", () => {
  const before = withChatSummaries(state(), null);
  const without = withChatSummaries({ ...before, messages: before.messages.filter((message) => message.session_id !== 1) }, before, () => 9);
  assert.deepEqual(without.sessions[1].summary, { count: 0, lastAt: 9 });
  const rebuilt = { ...without, sessions: { ...without.sessions, 2: { id: 2, agent_name: "b" } } };
  assert.equal(withChatSummaries(rebuilt, without).sessions[2].summary.count, 2);
});

test("a new message or an ended reply stamps lastAt; a rename, a reread or a rebuilt session keeps it", () => {
  const read = withChatSummaries(state(), null, () => 100);
  assert.equal(read.sessions[1].summary.lastAt, undefined, "a state read from disk has no time to give");
  const replied = withChatSummaries({ ...read, messages: [...read.messages, reply(5, 2, { outcome: "completed" })] }, read, () => 200);
  assert.equal(replied.sessions[2].summary.lastAt, 200);
  assert.equal(replied.sessions[1], read.sessions[1]);
  const streamed = replied.messages.map((message) => (message.id === 5 ? { ...message, body: "Done, and more" } : message));
  const kept = withChatSummaries({ ...replied, messages: streamed }, replied, () => 300);
  assert.equal(kept.sessions[2].summary.lastAt, 200, "a reply growing in place is not new activity");
  const rebuilt = withChatSummaries({ ...kept, sessions: { ...kept.sessions, 2: { id: 2, agent_name: "b" } } }, kept, () => 400);
  assert.equal(rebuilt.sessions[2].summary.lastAt, 200);
  const created = withChatSummaries(
    { ...rebuilt, sessions: { ...rebuilt.sessions, 4: { id: 4, agent_name: "c" } }, messages: [...rebuilt.messages, ask(6, 4, "New")] },
    rebuilt,
    () => 500,
  );
  assert.equal(created.sessions[4].summary.lastAt, 500);
});

test("firstAt is stamped when a Chat gets its first message and then never moves; a Chat without messages has none", () => {
  const read = withChatSummaries(state(), null, () => 100);
  assert.equal(read.sessions[1].summary.firstAt, undefined, "a state read from disk has no time to give");
  assert.equal(read.sessions[3].summary.firstAt, undefined, "a Chat with no messages has no first message");
  const first = withChatSummaries({ ...read, messages: [...read.messages, ask(5, 3, "Third chat")] }, read, () => 200);
  assert.equal(first.sessions[3].summary.firstAt, 200);
  assert.equal(first.sessions[3].summary.lastAt, 200);
  assert.equal(first.sessions[1], read.sessions[1]);
  const replied = withChatSummaries({ ...first, messages: [...first.messages, reply(6, 3, { outcome: "completed" })] }, first, () => 300);
  assert.equal(replied.sessions[3].summary.firstAt, 200, "later activity keeps when the Chat began");
  assert.equal(replied.sessions[3].summary.lastAt, 300);
  assert.equal(replied.sessions[2].summary.firstAt, undefined, "a Chat that had messages before the host kept firstAt doesn't invent one");
  const created = withChatSummaries(
    { ...replied, sessions: { ...replied.sessions, 4: { id: 4, agent_name: "c" } }, messages: [...replied.messages, ask(7, 4, "New")] },
    replied,
    () => 400,
  );
  assert.equal(created.sessions[4].summary.firstAt, 400);
  const emptied = withChatSummaries({ ...created, messages: created.messages.filter((message) => message.session_id !== 4) }, created, () => 500);
  assert.equal(emptied.sessions[4].summary.firstAt, undefined);
});
