import assert from "node:assert/strict";
import test from "node:test";
import { rovingIndex } from "./roving.ts";

test("a list wraps, Home and End go to the ends, other keys don't move", () => {
  assert.equal(rovingIndex("ArrowRight", 2, 3), 0);
  assert.equal(rovingIndex("ArrowLeft", 0, 3), 2);
  assert.equal(rovingIndex("ArrowDown", 1, 3), 2);
  assert.equal(rovingIndex("Home", 2, 3), 0);
  assert.equal(rovingIndex("End", 0, 3), 2);
  assert.equal(rovingIndex("Enter", 1, 3), -1);
  assert.equal(rovingIndex("ArrowDown", 0, 0), -1);
});

test("with nothing focused, forward picks the first and back the last", () => {
  assert.equal(rovingIndex("ArrowDown", -1, 4), 0);
  assert.equal(rovingIndex("ArrowUp", -1, 4), 3);
});

test("an axis ignores the other arrows", () => {
  assert.equal(rovingIndex("ArrowUp", 1, 3, { axis: "horizontal" }), -1);
  assert.equal(rovingIndex("ArrowRight", 1, 3, { axis: "vertical" }), -1);
});

test("a grid moves a row with Up and Down and stops at its edges", () => {
  assert.equal(rovingIndex("ArrowDown", 1, 8, { columns: 4 }), 5);
  assert.equal(rovingIndex("ArrowUp", 5, 8, { columns: 4 }), 1);
  assert.equal(rovingIndex("ArrowDown", 5, 8, { columns: 4 }), -1);
  assert.equal(rovingIndex("ArrowRight", 7, 8, { columns: 4 }), -1);
});
