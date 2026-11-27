const assert = require("node:assert/strict");
const test = require("node:test");
const { chatPage, chatSearch } = require("./chat-pages.cjs");

// Chat 1 has 6 turns (a question and a reply each); chat 2's messages sit between them.
const messages = [];
for (let turn = 0; turn < 6; turn++) {
  messages.push({ id: messages.length + 1, session_id: 1, role: "user", body: `question ${turn}` });
  messages.push({ id: messages.length + 1, session_id: 2, role: "user", body: "other chat" });
  messages.push({ id: messages.length + 1, session_id: 1, role: "assistant", body: `answer ${turn}` });
}
const bodies = (page) => page.messages.map((message) => message.body);

test("the first page is the Chat's latest turns, and older pages follow on a cursor", () => {
  const latest = chatPage(messages, 1, { turns: 2 });
  assert.deepEqual(bodies(latest), ["question 4", "answer 4", "question 5", "answer 5"]);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.total, 12);
  const older = chatPage(messages, 1, { turns: 2, before: latest.messages[0].id });
  assert.deepEqual(bodies(older), ["question 2", "answer 2", "question 3", "answer 3"]);
  const oldest = chatPage(messages, 1, { turns: 5, before: older.messages[0].id });
  assert.deepEqual(bodies(oldest), ["question 0", "answer 0", "question 1", "answer 1"]);
  assert.equal(oldest.hasMore, false);
});

test("a page stops at its message limit, and an unknown cursor reads from the end", () => {
  assert.deepEqual(bodies(chatPage(messages, 1, { turns: 10, limit: 3 })), ["answer 4", "question 5", "answer 5"]);
  assert.deepEqual(bodies(chatPage(messages, 1, { turns: 1, before: 999 })), ["question 5", "answer 5"]);
  assert.deepEqual(chatPage(messages, 3), { messages: [], hasMore: false, total: 0 });
});

test("search covers Chats that aren't archived and says where each match is", () => {
  const state = { sessions: { 1: { id: 1 }, 2: { id: 2, archived: true } }, messages };
  const found = chatSearch(state, "answr 3");
  assert.deepEqual(found[0].message, { id: 12, session_id: 1 });
  assert.equal(found[0].term, "answer", "with a typo, the first word it matched");
  assert.equal(chatSearch(state, "other").length, 0, "an archived Chat isn't searched");
});

test("search covers archived Chats when asked", () => {
  const state = { sessions: { 1: { id: 1 }, 2: { id: 2, archived: true } }, messages };
  assert.equal(chatSearch(state, "other", { archived: true })[0].message.session_id, 2);
});
