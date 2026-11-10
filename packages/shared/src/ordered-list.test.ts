import assert from "node:assert/strict";
import test from "node:test";
import { orderedListDigits } from "./ordered-list.ts";

test("orderedListDigits counts the digits of the list's highest number", () => {
  assert.equal(orderedListDigits(undefined, 9), 1);
  assert.equal(orderedListDigits(1, 10), 2);
  assert.equal(orderedListDigits(1, 12), 2);
  assert.equal(orderedListDigits(95, 10), 3);
});

test("orderedListDigits follows a list that starts past 9, as one continued after a code block does", () => {
  assert.equal(orderedListDigits(10, 1), 2);
  assert.equal(orderedListDigits(8, 3), 2);
  assert.equal(orderedListDigits(0, 3), 1);
});

test("orderedListDigits counts a reversed list down from its start or its length", () => {
  assert.equal(orderedListDigits(undefined, 12, true), 2);
  assert.equal(orderedListDigits(10, 3, true), 2);
  assert.equal(orderedListDigits(5, 8, true), 2);
});

test("orderedListDigits treats an empty list as one item", () => {
  assert.equal(orderedListDigits(undefined, 0), 1);
});
