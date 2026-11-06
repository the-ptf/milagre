import { test } from "node:test";
import assert from "node:assert/strict";
import { isSilentNote, subchatNote, subchatNotes, suggestionArguments } from "./subchat-notes.ts";

const message = (id: number, context?: unknown) => ({ id, context });
const escalation = (requestId: string) => ({ kind: "subchat-escalation", from: "/p#2", fromTitle: "Write pill tests", requestId, waitedMs: 180_000 });
const suggestion = (id: string, requestId: string) => ({
  kind: "subchat-suggestion",
  id,
  from: "/p#2",
  fromTitle: "Write pill tests",
  requestId,
  question: "Which badge should Closed use?",
  answerLabel: "Grey, like Draft",
  answers: { q1: ["Grey, like Draft"] },
});

test("only the escalation notes are notes", () => {
  assert.equal(subchatNote(message(1)), null);
  assert.equal(subchatNote(message(1, "handover")), null);
  assert.equal(subchatNote(message(1, { kind: "git-action" })), null);
  assert.equal(subchatNote(message(1, escalation("r1")))?.kind, "subchat-escalation");
});

test("an escalation line is dropped when a suggestion for the same request follows, and kept for another", () => {
  const notes = subchatNotes([message(1, escalation("r1")), message(2, escalation("r2")), message(3, suggestion("s1", "r1"))], false);
  assert.deepEqual([...notes.silent], [1]);
});

test("a suggestion before its escalation does not drop it", () => {
  const notes = subchatNotes([message(1, suggestion("s1", "r1")), message(2, escalation("r1"))], false);
  assert.equal(notes.silent.size, 0);
});

test("a suggestion's outcome draws nothing itself and turns its card into the outcome", () => {
  const outcome = { kind: "subchat-suggestion-outcome", id: "s1", fromTitle: "Write pill tests", outcome: "sent", label: "Grey, like Draft" };
  const notes = subchatNotes([message(1, suggestion("s1", "r1")), message(2, outcome)], false);
  assert.deepEqual([...notes.silent], [2]);
  assert.equal(notes.outcomes.get("s1")?.outcome, "sent");
  assert.equal(notes.outcomes.get("s2"), undefined);
});

test("the waiting note moves above the open question; once answered it reads in the transcript again", () => {
  const waiting = (waitedMs: number) => ({ kind: "subchat-waiting", ask: "question", parentTitle: "Redesign the PR panel", waitedMs });
  const messages = [message(1, waiting(180_000)), message(2, waiting(360_000))];
  const open = subchatNotes(messages, true);
  assert.deepEqual([...open.silent], [2]);
  assert.equal(open.waiting?.waitedMs, 360_000);
  const answered = subchatNotes(messages, false);
  assert.equal(answered.silent.size, 0);
  assert.equal(answered.waiting, null);
});

test("Send answer answers the subchat's own request with the suggestion's answer, tagged with its id", () => {
  const note = suggestion("s1", "r1") as Parameters<typeof suggestionArguments>[0];
  assert.deepEqual(suggestionArguments(note), {
    chatId: "/p#2",
    requestId: "r1",
    answers: { q1: ["Grey, like Draft"] },
    summary: "Which badge should Closed use?: Grey, like Draft",
    suggestionId: "s1",
  });
});

test("the wake that starts the parent's escalation turn draws nothing", () => {
  const wake = { kind: "subchat-wake", requests: [{ from: "/p#2", fromTitle: "Write pill tests", requestId: "r1" }] };
  assert.deepEqual([...subchatNotes([message(1, wake), message(2, escalation("r1"))], false).silent], [1]);
});

test("the wake and a suggestion's outcome never draw, so the message rail skips them", () => {
  assert.equal(isSilentNote({ context: { kind: "subchat-wake" } }), true);
  assert.equal(isSilentNote({ context: { kind: "subchat-suggestion-outcome", id: "s", fromTitle: "T", outcome: "sent" } }), true);
  assert.equal(isSilentNote({ context: { kind: "subchat-escalation" } }), false);
  assert.equal(isSilentNote({}), false);
});
