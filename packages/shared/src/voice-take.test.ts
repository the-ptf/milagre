import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingDictation } from "./voice-stream.ts";
import { provisionalRange, revertTake, splitProvisional, startTake, writeTake, type DictationTake } from "./voice-dictation.ts";

const speech = (seconds: number, value = 4000) => new Int16Array(Math.round(16000 * seconds)).fill(value);
const silence = (seconds: number) => speech(seconds, 0);

test("nothing is settled until a pause seals a segment", async () => {
  const partials: { text: string; settled: number }[] = [];
  let answer = "um dois";
  const stream = createStreamingDictation({
    transcribe: async () => answer,
    onPartial: (text, settled) => partials.push({ text, settled }),
  });
  stream.append(speech(1));
  await stream.idle();
  assert.deepEqual(partials.at(-1), { text: "um dois", settled: 0 }, "a segment still open can be rewritten whole");

  // A pause longer than the 700 ms gap seals the first segment; the next speech opens a second one.
  stream.append(silence(1));
  answer = "um dois três";
  stream.append(speech(1));
  await stream.idle();
  const last = partials.at(-1)!;
  assert.equal(last.text, "um dois um dois três", "the sealed segment keeps its words; the open one is appended");
  assert.equal(last.settled, "um dois ".length, "only the sealed, decoded segment has stopped moving");
  assert.equal(last.text.slice(0, last.settled), "um dois ", "settled always spells a prefix of the transcript");
  assert.equal(last.text[last.settled], "u", "the joining space belongs to neither side");
  await stream.finish();
});

test("a sealed segment settles as soon as its own text comes back", async () => {
  const partials: { text: string; settled: number }[] = [];
  const stream = createStreamingDictation({
    transcribe: async () => "palavra",
    onPartial: (text, settled) => partials.push({ text, settled }),
  });
  stream.append(speech(0.4));
  stream.append(silence(1));
  await stream.idle();
  assert.deepEqual(partials, [{ text: "palavra", settled: "palavra".length }], "a pause closed it, so nothing is provisional");
  assert.equal(await stream.finish(), "palavra");
});

test("a take writes its words in place and keeps rewriting the same run", () => {
  let take = startTake("Check the notes", { start: 15, end: 15 });
  const first = writeTake(take, "Check the notes", "and tell me", 0)!;
  assert.equal(first.value, "Check the notes and tell me");
  assert.equal(first.caret, first.value.length);
  take = first.take;
  assert.deepEqual(provisionalRange(take), { start: 16, end: 27 }, "every dictated word is still provisional");

  const second = writeTake(take, first.value, "and tell me whether it jumps", "and tell me".length)!;
  assert.equal(second.value, "Check the notes and tell me whether it jumps", "the run is replaced, not appended twice");
  take = second.take;
  assert.deepEqual(provisionalRange(take), { start: 16 + "and tell me".length, end: second.value.length });
});

test("a take replaces the selection it started on and puts it back when discarded", () => {
  const draft = "Send the old words now";
  const take = startTake(draft, { start: 9, end: 18 });
  const written = writeTake(take, draft, "brand new", 0)!;
  assert.equal(written.value, "Send the brand new now");
  const back = revertTake(written.take, written.value);
  assert.equal(back.value, draft, "discarding a take restores the draft it replaced");
  assert.deepEqual(back.selection, { start: 9, end: 18 }, "and the selection the user had");
});

test("discarding after the user typed around the take takes out only the dictated run", () => {
  const take = startTake("", { start: 0, end: 0 });
  const written = writeTake(take, "", "hello there", 0)!;
  const edited = `${written.value}!`;
  const back = revertTake(written.take, edited);
  assert.equal(back.value, "!", "their own characters survive");
});

test("an empty partial leaves the draft alone, and clears a run already written", () => {
  const take = startTake("draft", { start: 5, end: 5 });
  assert.equal(writeTake(take, "draft", "   ", 0), null);
  const written = writeTake(take, "draft", "words", 0)!;
  const cleared = writeTake(written.take, written.value, "", 0)!;
  assert.equal(cleared.value, "draft");
  assert.equal(provisionalRange(cleared.take), null);
});

test("settled is clamped to the words actually written", () => {
  const take = startTake("", { start: 0, end: 0 });
  const written = writeTake(take, "", "two words", 999)!;
  assert.equal(provisionalRange(written.take), null, "a settled count past the end leaves nothing provisional");
});

test("splitProvisional cuts text parts and never cuts a chip", () => {
  const parts = [
    { kind: "text", text: "run " },
    { kind: "skill", text: "/undo" },
    { kind: "text", text: " then stop here" },
  ];
  const pieces = splitProvisional(parts, { start: 15, end: 24 });
  assert.deepEqual(
    pieces.map((piece) => [piece.part.kind, piece.text, piece.provisional]),
    [
      ["text", "run ", false],
      ["skill", "/undo", false],
      ["text", " then ", false],
      ["text", "stop here", true],
    ],
  );
  assert.equal(pieces.map((piece) => piece.text).join(""), parts.map((part) => part.text).join(""), "the draft is unchanged");
});

test("splitProvisional with no range returns the parts as they are", () => {
  const parts = [{ kind: "text", text: "plain" }];
  assert.deepEqual(splitProvisional(parts, null), [{ part: parts[0], text: "plain", provisional: false }]);
  assert.deepEqual(splitProvisional(parts, { start: 2, end: 2 }), [{ part: parts[0], text: "plain", provisional: false }]);
});

test("a take type keeps its anchor across rewrites", () => {
  const take: DictationTake = startTake("x", { start: 1, end: 1 });
  const written = writeTake(take, "x", "y", 0)!;
  assert.deepEqual(written.take.anchor, { start: 1, end: 1 });
  assert.equal(written.take.base, "x");
});
