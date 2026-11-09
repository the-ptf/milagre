import assert from "node:assert/strict";
import test from "node:test";
import { chatBookmark, chatFamily, MAX_SUBCHAT_DEPTH, nestSubchats, parentKey, subchatRoot } from "./subchats.ts";

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

test("a family sits where its first member was, each child after the Chat above it", () => {
  const nested = nestSubchats(["p#5", "p#3", "p#1", "p#2", "p#4", "p#9"], key, parentOf);
  assert.deepEqual(
    nested.map((group) => [group.row, group.children]),
    [
      ["p#5", []],
      ["p#1", ["p#3", "p#4", "p#2"]],
      ["p#9", []],
    ],
  );
});

test("a subchat sits right after the Chat above it, one level deeper, up to the cap", () => {
  const chain: Record<string, string> = { "p#2": "p#1", "p#3": "p#1", "p#4": "p#2", "p#5": "p#4" };
  const [group] = nestSubchats(["p#1", "p#2", "p#3", "p#4", "p#5"], key, (at) => chain[at]);
  assert.deepEqual(group?.children, ["p#2", "p#4", "p#5", "p#3"]);
  assert.deepEqual(group?.depths, [1, 2, MAX_SUBCHAT_DEPTH, 1]);
});

const sessions = {
  1: { id: 1 },
  2: { id: 2, parent: 1 },
  3: { id: 3, parent: 2 },
  4: { id: 4, parent: 1, done_at: 10 },
  5: { id: 5, parent: 6 },
  6: { id: 6, parent: 1, archived: true },
};

test("a family leaves Done subchats out, but never the open one", () => {
  assert.deepEqual(chatFamily(sessions, "/a#1"), { root: "/a#1", children: ["/a#2", "/a#3", "/a#5"] });
  assert.deepEqual(chatFamily(sessions, "/a#4"), { root: "/a#1", children: ["/a#2", "/a#3", "/a#4", "/a#5"] });
});

test("the bookmark points at the nearest listed ancestor, with the rest above it", () => {
  assert.deepEqual(chatBookmark(sessions, "/a#2"), { parent: "/a#1", above: [] });
  assert.deepEqual(chatBookmark(sessions, "/a#3"), { parent: "/a#2", above: ["/a#1"] });
  assert.deepEqual(chatBookmark(sessions, "/a#5"), { parent: "/a#1", above: [] });
  assert.equal(chatBookmark(sessions, "/a#1"), null);
  assert.equal(chatBookmark({ 1: { id: 1, archived: true }, 2: { id: 2, parent: 1 } }, "/a#2"), null);
  assert.equal(chatBookmark({ 1: { id: 1, parent: 2 }, 2: { id: 2, parent: 1 } }, "/a#1")?.parent, "/a#2");
});
