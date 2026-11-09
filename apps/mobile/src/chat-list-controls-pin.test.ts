import assert from "node:assert/strict";
import test from "node:test";
import { pinsControls, shownHidden } from "./chat-list-controls-pin.ts";

test("a dictation in any phase, or a focused search field, keeps the controls on screen", () => {
  assert.equal(pinsControls("idle", false), false);
  for (const phase of ["preparing", "recording", "transcribing"] as const) assert.equal(pinsControls(phase, false), true, phase);
  assert.equal(pinsControls("idle", true), true, "focus holds them for as long as the field is focused");
  assert.equal(pinsControls("recording", true), true);
});

test("pinned controls ignore the list hiding them, and follow it again once released", () => {
  assert.equal(shownHidden(1, 1), 0);
  assert.equal(shownHidden(1, 0), 1);
  assert.equal(shownHidden(0, 1), 0);
  assert.equal(shownHidden(1, 0.5), 0.5, "midway through the release it eases back");
});
