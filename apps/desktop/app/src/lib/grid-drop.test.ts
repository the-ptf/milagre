import assert from "node:assert/strict";
import test from "node:test";
import { dropSide, placeDropped, readGridPins, saveGridPins } from "./grid-drop.ts";

test("dropSide: the left half drops before, the right half after, with the bar on that edge", () => {
  const box = { left: 100, top: 40, width: 400, height: 300 };
  const before = dropSide(box, 150, 12);
  assert.equal(before.side, "before");
  assert.deepEqual(before.area, { left: 100, top: 40, width: 200, height: 300 });
  assert.deepEqual(before.bar, { left: 92, top: 56, height: 268 });
  const after = dropSide(box, 450, 12);
  assert.equal(after.side, "after");
  assert.deepEqual(after.area, { left: 300, top: 40, width: 200, height: 300 });
  assert.equal(after.bar.left, 504);
});

test("placeDropped: beside a tile, moved when already there, and beside the one Chat on screen", () => {
  assert.deepEqual(placeDropped(["/a#1", "/a#2"], "/b#3", { tile: "/a#2", side: "before" }, "/a#1"), ["/a#1", "/b#3", "/a#2"]);
  assert.deepEqual(placeDropped(["/a#1", "/a#2"], "/b#3", { tile: "/a#1", side: "after" }, "/a#1"), ["/a#1", "/b#3", "/a#2"]);
  assert.deepEqual(placeDropped(["/a#1", "/a#2", "/b#3"], "/b#3", { tile: "/a#1", side: "before" }, "/a#1"), ["/b#3", "/a#1", "/a#2"]);
  // No tiles yet: the drop goes beside the focused Chat.
  assert.deepEqual(placeDropped([], "/b#3", { tile: null, side: "before" }, "/a#1"), ["/b#3", "/a#1"]);
  assert.deepEqual(placeDropped([], "/b#3", { tile: null, side: "after" }, "/a#1"), ["/a#1", "/b#3"]);
  // A tile that left meanwhile: the drop joins at the end.
  assert.deepEqual(placeDropped(["/a#1"], "/b#3", { tile: "/a#9", side: "before" }, "/a#1"), ["/a#1", "/b#3"]);
});

test("grid pins round-trip and ignore what isn't a list of keys", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  assert.deepEqual(readGridPins(storage), []);
  saveGridPins(storage, ["/a#1", "/b#2"]);
  assert.deepEqual(readGridPins(storage), ["/a#1", "/b#2"]);
  store.set("milagre.chatGridPins", "{");
  assert.deepEqual(readGridPins(storage), []);
  store.set("milagre.chatGridPins", '["/a#1", 3]');
  assert.deepEqual(readGridPins(storage), ["/a#1"]);
});
