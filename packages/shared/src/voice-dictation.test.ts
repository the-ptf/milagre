import assert from "node:assert/strict";
import test from "node:test";
import { ERRORS, IDLE, dictationReducer, insertDictation, joinSegments, meterLevel, type Dictation } from "./voice-dictation.ts";

const caret = (at: number) => ({ start: at, end: at });

test("a transcript lands at the caret with a space on each side that needs one", () => {
  assert.deepEqual(insertDictation("fix the bug", caret(7), "quick"), { value: "fix the quick bug", caret: 13 });
  assert.deepEqual(insertDictation("fix the", caret(7), "bug"), { value: "fix the bug", caret: 11 });
  assert.deepEqual(insertDictation("fix the ", caret(8), "bug"), { value: "fix the bug", caret: 11 });
});

test("an empty draft or a line start gets no leading space", () => {
  assert.deepEqual(insertDictation("", caret(0), "hello"), { value: "hello", caret: 5 });
  assert.deepEqual(insertDictation("one\n", caret(4), "two"), { value: "one\ntwo", caret: 7 });
  assert.deepEqual(insertDictation("see ()", caret(5), "this"), { value: "see (this)", caret: 9 });
});

test("punctuation after the caret stays attached and spaces are never doubled", () => {
  assert.deepEqual(insertDictation("hello.", caret(5), "world"), { value: "hello world.", caret: 11 });
  assert.deepEqual(insertDictation("a  b", caret(2), "x"), { value: "a x b", caret: 3 });
  assert.equal(insertDictation("a b", caret(2), "x")?.value, "a x b");
});

test("a selected range is replaced", () => {
  assert.deepEqual(insertDictation("fix the bug now", { start: 8, end: 11 }, "typo"), { value: "fix the typo now", caret: 12 });
});

test("a draft that changed since recording began still takes the transcript, clamped to its length", () => {
  assert.deepEqual(insertDictation("hi", caret(40), "there"), { value: "hi there", caret: 8 });
  assert.deepEqual(insertDictation("hi", { start: 5, end: 3 }, "there"), { value: "hi there", caret: 8 });
  assert.deepEqual(insertDictation("hello", { start: -2, end: 1 }, "oh"), { value: "oh ello", caret: 2 });
});

test("blank transcripts insert nothing and the text is trimmed", () => {
  assert.equal(insertDictation("hi", caret(2), "   "), null);
  assert.deepEqual(insertDictation("hi", caret(2), "  there \n"), { value: "hi there", caret: 8 });
});

test("segments join with single spaces and skip empty ones", () => {
  assert.equal(joinSegments([{ text: " Hello" }, { text: "" }, { text: "world. " }]), "Hello world.");
  assert.equal(joinSegments([]), "");
});

test("metering is silent at the -60 dB floor and full at 0 dB", () => {
  assert.equal(meterLevel(undefined), 0);
  assert.equal(meterLevel(Number.NaN), 0);
  assert.equal(meterLevel(-160), 0);
  assert.equal(meterLevel(-60), 0);
  assert.equal(meterLevel(0), 1);
  assert.equal(meterLevel(12), 1);
  const quiet = meterLevel(-40);
  const loud = meterLevel(-10);
  assert.ok(quiet > 0 && quiet < loud && loud < 1);
});

test("a take walks idle, preparing, recording, transcribing, idle", () => {
  let state: Dictation = IDLE;
  state = dictationReducer(state, { type: "start" });
  assert.equal(state.phase, "preparing");
  state = dictationReducer(state, { type: "recording" });
  assert.equal(state.phase, "recording");
  state = dictationReducer(state, { type: "stop" });
  assert.equal(state.phase, "transcribing");
  state = dictationReducer(state, { type: "done" });
  assert.deepEqual(state, IDLE);
});

test("out-of-order actions are ignored", () => {
  assert.equal(dictationReducer(IDLE, { type: "stop" }), IDLE);
  assert.equal(dictationReducer(IDLE, { type: "recording" }), IDLE);
  const recording: Dictation = { phase: "recording", error: null };
  assert.equal(dictationReducer(recording, { type: "start" }), recording);
  assert.equal(dictationReducer(IDLE, { type: "done" }), IDLE);
});

test("a failure ends the take with its message until it is dismissed or the next take starts", () => {
  const failed = dictationReducer({ phase: "preparing", error: null }, { type: "fail", error: ERRORS.permission });
  assert.deepEqual(failed, { phase: "idle", error: ERRORS.permission });
  assert.deepEqual(dictationReducer(failed, { type: "dismiss" }), IDLE);
  assert.deepEqual(dictationReducer(failed, { type: "start" }), { phase: "preparing", error: null });
});

test("a take whose model is missing downloads it before it records", () => {
  let state = dictationReducer(IDLE, { type: "start" });
  state = dictationReducer(state, { type: "download" });
  assert.equal(state.phase, "downloading");
  // Nothing records while the model downloads.
  assert.equal(dictationReducer(state, { type: "recording" }), state);
  state = dictationReducer(state, { type: "downloaded" });
  assert.equal(state.phase, "preparing");
  assert.equal(dictationReducer(state, { type: "recording" }).phase, "recording");
  assert.equal(dictationReducer(IDLE, { type: "download" }), IDLE);
  assert.deepEqual(dictationReducer({ phase: "downloading", error: null }, { type: "done" }), IDLE);
});

test("a fix-up rewrites a finished take only while the draft is exactly what the take left", async () => {
  const { correctTake, startTake, takeRange, writeTake } = await import("./voice-dictation.ts");
  const written = writeTake(startTake("Hi ", { start: 3, end: 3 }), "Hi ", "ask code X", 10)!;
  assert.deepEqual(takeRange(written.take), { start: 3, end: 13 });
  const fixed = correctTake(written.take, written.value, "ask Codex")!;
  assert.equal(fixed.value, "Hi ask Codex");
  assert.equal(fixed.caret, fixed.value.length);
  assert.equal(correctTake(written.take, `${written.value}!`, "ask Codex"), null, "an edit since wins");
  assert.equal(correctTake(written.take, written.value, " ask code X "), null, "the same words change nothing");
  assert.equal(correctTake(written.take, written.value, ""), null);
});
