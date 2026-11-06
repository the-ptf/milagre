import assert from "node:assert/strict";
import test from "node:test";
import { besideParent, familySplit, swapTile } from "./subchat-split.ts";

test("besideParent puts the parent before the open Chat", () => {
  assert.deepEqual(besideParent("/a#1", "/a#3"), ["/a#1", "/a#3"]);
});

test("familySplit lists the family and always includes the focused Chat", () => {
  const family = { root: "/a#1", children: ["/a#2", "/a#3"] };
  assert.deepEqual(familySplit(family, "/a#2"), ["/a#1", "/a#2", "/a#3"]);
  assert.deepEqual(familySplit(family, null), ["/a#1", "/a#2", "/a#3"]);
  // A focused Chat the family dropped (a Done one) still joins.
  assert.deepEqual(familySplit(family, "/a#9"), ["/a#1", "/a#2", "/a#3", "/a#9"]);
});

test("swapTile replaces one tile, and nothing when the pick is on screen already or the tile isn't", () => {
  const split = ["/a#1", "/a#2"];
  assert.deepEqual(swapTile(split, "/a#2", "/a#3"), ["/a#1", "/a#3"]);
  assert.equal(swapTile(split, "/a#2", "/a#1"), split);
  assert.equal(swapTile(split, "/a#9", "/a#3"), split);
});
