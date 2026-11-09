import assert from "node:assert/strict";
import test from "node:test";
import { queueStatus } from "./queued-messages.mjs";
import { pendingChatSessionId } from "./chats.mjs";

test("the queue line says when queued messages go", () => {
  assert.equal(queueStatus({ count: 1, held: false, running: true }), "sends when this turn ends");
  assert.equal(queueStatus({ count: 2, held: false, running: true }), "each sends in its own turn, in order, after this one");
  assert.equal(queueStatus({ count: 2, held: true, running: false }), "on hold since the last turn stopped");
  assert.equal(queueStatus({ count: 1, held: false, running: false }), "starting next");
});

test("a send preview finds its Chat once the message waits in that Chat's queue", () => {
  const state = {
    sessions: { 4: { id: 4, queued: [{ id: "q", body: "next", clientMessageId: "c-9", model: "m", provider: "antigravity", queuedAt: 1 }] } },
    messages: [],
  };
  assert.equal(pendingChatSessionId(state, { message: { clientMessageId: "c-9" } }), 4);
  assert.equal(pendingChatSessionId(state, { message: { clientMessageId: "other" } }), null);
});
