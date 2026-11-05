import assert from "node:assert/strict";
import test from "node:test";
import { hiddenSubchatNotes, pendingWaitingNote, subchatNote } from "./subchat-transcript.ts";

const note = (id: number, context: unknown, role: "user" | "assistant" = "assistant") => ({ id, role, context });

test("subchatNote reads only the escalation kinds", () => {
  assert.equal(subchatNote({ context: { kind: "subchat-waiting", ask: "question", parentTitle: "A", waitedMs: 1 } })?.kind, "subchat-waiting");
  assert.equal(subchatNote({ context: { kind: "delegation-report" } }), null);
  assert.equal(subchatNote({ context: null }), null);
  assert.equal(subchatNote({ context: "handover" }), null);
});

test("hiddenSubchatNotes: an escalation line goes when a suggestion for its request follows, outcomes and waiting notes always", () => {
  const messages = [
    note(1, { kind: "subchat-escalation", from: "/p#2", fromTitle: "T", requestId: "r1", waitedMs: 1 }),
    note(2, { kind: "subchat-escalation", from: "/p#3", fromTitle: "U", requestId: "r2", waitedMs: 1 }),
    note(3, { kind: "subchat-suggestion", id: "s1", from: "/p#2", fromTitle: "T", requestId: "r1", question: "Q", answerLabel: "A", answers: {} }),
    note(4, { kind: "subchat-suggestion-outcome", id: "s1", fromTitle: "T", outcome: "sent", label: "A" }),
    note(5, { kind: "subchat-waiting", ask: "question", parentTitle: "P", waitedMs: 1 }),
  ];
  assert.deepEqual([...hiddenSubchatNotes(messages)].sort(), [1, 4, 5]);
  // A suggestion that comes before the line doesn't drop it: the line is the newer news.
  const later = [messages[2]!, note(6, { kind: "subchat-escalation", from: "/p#2", fromTitle: "T", requestId: "r1", waitedMs: 1 })];
  assert.deepEqual([...hiddenSubchatNotes(later)], []);
});

test("pendingWaitingNote: the latest note, until a person writes in the Chat", () => {
  const waiting = note(2, { kind: "subchat-waiting", ask: "question", parentTitle: "Redesign", waitedMs: 190_000 });
  assert.deepEqual(pendingWaitingNote([note(1, null, "user"), waiting]), { ask: "question", text: "Waiting 3 min. Asked Redesign for help." });
  assert.equal(pendingWaitingNote([waiting, note(3, null, "user")]), null);
  assert.equal(pendingWaitingNote([note(1, null, "assistant")]), null);
});

test("the wake's turn message is the host's: nothing shows, and it doesn't end a wait", () => {
  const wake = { id: 2, role: "user" as const, context: { kind: "subchat-wake" } };
  const waiting = { id: 1, role: "assistant" as const, context: { kind: "subchat-waiting", ask: "question", parentTitle: "Panel", waitedMs: 180_000 } };
  assert.ok(hiddenSubchatNotes([wake]).has(2));
  assert.equal(pendingWaitingNote([waiting, wake])?.ask, "question");
});
