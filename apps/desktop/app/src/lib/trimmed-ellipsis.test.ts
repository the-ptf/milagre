import assert from "node:assert/strict";
import test from "node:test";
import { trimmedEllipsis } from "./trimmed-ellipsis.ts";

// One unit per character, so widths are character counts.
const measure = (text: string) => text.length;

test("a title that fits keeps CSS truncation (nothing to replace)", () => {
  assert.equal(trimmedEllipsis("Keep the Chat timer running", 40, measure), null);
});

test("a cut right after a space drops the space before the ellipsis", () => {
  // Room for 20 characters plus the ellipsis: "Keep the Chat timer " ends in a space.
  assert.equal(trimmedEllipsis("Keep the Chat timer running", 21, measure), "Keep the Chat timer…");
});

test("a cut inside a word is left to CSS", () => {
  assert.equal(trimmedEllipsis("Keep the Chat timer running", 19, measure), null);
});

test("no room at all draws nothing of its own", () => {
  assert.equal(trimmedEllipsis("Keep", 0, measure), null);
  assert.equal(trimmedEllipsis(" Keep the timer", 2, measure), null);
});
