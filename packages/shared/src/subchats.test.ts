import assert from "node:assert/strict";
import test from "node:test";
import { nestSubchats, parentKey, subchatRoot } from "./subchats.ts";

const parents: Record<string, string> = { "p#2": "p#1", "p#3": "p#1", "p#4": "p#3", "p#9": "p#8" };
const parentOf = (key: string) => parents[key];
const key = (row: string) => row;

test("a session's parent key shares its Project", () => {
  assert.equal(parentKey("/a/b#12", 7), "/a/b#7");
  assert.equal(parentKey("/a/b#12", undefined), undefined);
});

test("a subchat nests under its topmost listed ancestor", () => {
  assert.equal(
    subchatRoot("p#4", parentOf, () => true),
    "p#1",
  );
  assert.equal(
    subchatRoot("p#4", parentOf, (at) => at === "p#3"),
    "p#3",
  );
  assert.equal(
    subchatRoot("p#9", parentOf, () => false),
    undefined,
  );
  assert.equal(
    subchatRoot("p#1", parentOf, () => true),
    undefined,
  );
});

test("a looping chain stops where it repeats", () => {
  const loop: Record<string, string> = { "p#1": "p#2", "p#2": "p#1" };
  assert.equal(
    subchatRoot(
      "p#1",
      (at) => loop[at],
      () => true,
    ),
    "p#2",
  );
});

test("a family sits where its first member was, children in list order", () => {
  const nested = nestSubchats(["p#5", "p#3", "p#1", "p#2", "p#4", "p#9"], key, parentOf);
  assert.deepEqual(
    nested.map((group) => [group.row, group.children]),
    [
      ["p#5", []],
      ["p#1", ["p#3", "p#2", "p#4"]],
      ["p#9", []],
    ],
  );
});
