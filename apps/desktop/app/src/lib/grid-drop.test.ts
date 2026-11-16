import assert from "node:assert/strict";
import test from "node:test";
import { dropSide, placeDropped, readGridPins, readSplitChats, saveGridPins, saveSplitChats } from "./grid-drop.ts";

test("dropSide: the left half drops before, the right half after, with the bar on that edge", () => {
  const box = { left: 100, top: 40, width: 400, height: 300 };
  const before = dropSide(box, 150, 12);
  assert.equal(before.side, "before");
  assert.deepEqual(before.area, { left: 100, top: 40, width: 200, height: 300 });
  assert.equal(before.axis, "x");
  assert.deepEqual(before.bar, { left: 92, top: 56, width: 4, height: 268 });
  const after = dropSide(box, 450, 12);
  assert.equal(after.side, "after");
  assert.deepEqual(after.area, { left: 300, top: 40, width: 200, height: 300 });
  assert.equal(after.bar.left, 504);
});

test("dropSide: given y, a point nearer the top or bottom edge than a side drops above or below", () => {
  const box = { left: 100, top: 40, width: 400, height: 300 };
  const above = dropSide(box, 300, 12, 60);
  assert.deepEqual([above.axis, above.side], ["y", "before"]);
  assert.deepEqual(above.area, { left: 100, top: 40, width: 400, height: 150 });
  assert.deepEqual(above.bar, { left: 116, top: 32, width: 368, height: 4 });
  const below = dropSide(box, 300, 12, 330);
  assert.deepEqual([below.axis, below.side, below.area.top], ["y", "after", 190]);
  assert.deepEqual([dropSide(box, 110, 12, 190).axis, dropSide(box, 300, 12).axis], ["x", "x"]);
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

test("saveSplitChats: keeps the order and leaves a new Chat's draft tile out", () => {
  const items = new Map<string, string>();
  const storage = { getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => void items.set(name, value) };
  assert.deepEqual(readSplitChats(storage), []);
  saveSplitChats(storage, ["/b#2", "/a#0", "/a#1"]);
  assert.deepEqual(readSplitChats(storage), ["/b#2", "/a#1"]);
});

test("readSplitChats: a split saved under the old key (auto-split by focus) is not restored", () => {
  const items = new Map<string, string>([["milagre.chatSplit", '["/a#1", "/b#2"]']]);
  const storage = { getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => void items.set(name, value) };
  assert.deepEqual(readSplitChats(storage), []);
});
