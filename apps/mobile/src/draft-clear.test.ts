import assert from "node:assert/strict";
import test from "node:test";
import { clearSentDraft } from "./draft-clear.ts";

test("the draft that was sent clears", () => {
  assert.deepEqual(clearSentDraft({ a: "hi", b: "x" }, "a", "hi"), { a: "", b: "x" });
});

test("text typed while the send waited stays", () => {
  const drafts = { a: "hi and more" };
  assert.equal(clearSentDraft(drafts, "a", "hi"), drafts);
});

test("an issue start clears whatever is there", () => {
  assert.deepEqual(clearSentDraft({ a: "other" }, "a", "hi", true), { a: "" });
});
