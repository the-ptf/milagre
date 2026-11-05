import assert from "node:assert/strict";
import test from "node:test";
import { ancestorChats, escalationLine, isSubchatWake, suggestionOutcomeLine, suggestionOutcomes, waitingNote } from "./subchat-escalation.mjs";

test("the notes read the real wait", () => {
  assert.equal(waitingNote({ ask: "question", parentTitle: "Panel", waitedMs: 3 * 60_000 }), "Waiting 3 min. Asked Panel for help.");
  assert.equal(waitingNote({ ask: "approval", parentTitle: "Panel", waitedMs: 6 * 60_000 }), "Waiting 6 min. Reminded you in Panel.");
  assert.equal(escalationLine({ fromTitle: "Tests", waitedMs: 3 * 60_000 }), "Tests has been waiting on you for 3 min");
  assert.equal(escalationLine({ fromTitle: "Tests", waitedMs: 3 * 60_000, paused: true }), "Tests has been waiting on you for 3 min, paused until you reply");
});

test("a resolved suggestion says what really happened", () => {
  assert.equal(suggestionOutcomeLine({ outcome: "sent", fromTitle: "Tests", label: "Grey" }), 'Sent "Grey" to Tests');
  assert.equal(suggestionOutcomeLine({ outcome: "answered", fromTitle: "Tests", label: "Red" }), 'Answered "Red" in Tests');
  assert.equal(suggestionOutcomeLine({ outcome: "answered", fromTitle: "Tests" }), "Answered in Tests");
  assert.equal(suggestionOutcomeLine({ outcome: "cancelled", fromTitle: "Tests" }), "Cancelled");
  assert.equal(suggestionOutcomeLine({ outcome: "dismissed", fromTitle: "Tests" }), null);
});

test("outcomes are read from the transcript, the latest winning", () => {
  const first = { kind: "subchat-suggestion-outcome", id: "s1", fromTitle: "T", outcome: "cancelled" };
  const last = { ...first, outcome: "sent", label: "Grey" };
  const outcomes = suggestionOutcomes([{ context: first }, { context: { kind: "other" } }, {}, { context: last }]);
  assert.equal(outcomes.size, 1);
  assert.equal(outcomes.get("s1")?.outcome, "sent");
});

test("a Chat's ancestors, the nearest first, survive a chain that loops", () => {
  assert.deepEqual(ancestorChats({ 1: {}, 2: { parent: 1 }, 3: { parent: 2 } }, 3), [2, 1]);
  assert.deepEqual(ancestorChats({ 1: {} }, 1), []);
  assert.deepEqual(ancestorChats({ 1: { parent: 2 }, 2: { parent: 1 } }, 1), [2]);
  assert.deepEqual(ancestorChats(undefined, 1), []);
});

test("a wake's own message is told apart", () => {
  assert.equal(isSubchatWake({ context: { kind: "subchat-wake", requests: [] } }), true);
  assert.equal(isSubchatWake({ context: { kind: "subchat-escalation" } }), false);
  assert.equal(isSubchatWake(null), false);
});
