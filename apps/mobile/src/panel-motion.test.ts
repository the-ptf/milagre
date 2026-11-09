import { test } from "node:test";
import assert from "node:assert/strict";
import { dragTo, entered, settle } from "./panel-motion.ts";

test("a drag follows the finger inside the sides it may reach", () => {
  assert.equal(dragTo(0, 100, 400, -1, 1), 0.25);
  assert.equal(dragTo(0, -500, 400, -1, 1), -1);
  assert.equal(dragTo(0, -100, 400, 0, 1), 0, "no right panel: a leftward drag stays on the screen");
  assert.equal(dragTo(1, 100, 400, 0, 1), 1, "an open left panel cannot be pulled past open");
});

test("opening settles past a third of the width or on a flick toward the panel", () => {
  assert.equal(settle(0, 0.2, 0), 0);
  assert.equal(settle(0, 0.4, 0), 1);
  assert.equal(settle(0, -0.4, 0), -1);
  assert.equal(settle(0, 0.1, 800), 1, "a flick opens from a short drag");
  assert.equal(settle(0, 0.6, -800), 0, "a flick back cancels a long drag");
  assert.equal(settle(0, 0, 0), 0);
});

test("closing settles once a third is pulled back or on a flick away", () => {
  assert.equal(settle(1, 0.8, 0), 1);
  assert.equal(settle(1, 0.6, 0), 0);
  assert.equal(settle(-1, -0.8, 0), -1);
  assert.equal(settle(-1, -0.9, 800), 0, "a rightward flick closes the right panel");
  assert.equal(settle(1, 0.5, 800), 1, "a flick back toward the panel keeps it open");
});

test("a drag names each panel it moves into, once", () => {
  assert.equal(entered(0, 0.1), "left");
  assert.equal(entered(0.1, 0.3), null);
  assert.equal(entered(0.1, -0.05), "right", "a drag that swings back past the screen reaches the other panel");
  assert.equal(entered(-0.05, 0.2), "left");
  assert.equal(entered(0.2, 0), null, "back on the screen reaches no panel");
});
