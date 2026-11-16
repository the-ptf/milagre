import assert from "node:assert/strict";
import test from "node:test";
import { canStack, placeInSplit, removeFromSplit, splitColumns, swapStacked } from "./split-columns.ts";

test("splitColumns: a stacked Chat joins the column before it, two at most", () => {
  assert.deepEqual(splitColumns(["a", "b", "c"], []), [["a"], ["b"], ["c"]]);
  assert.deepEqual(splitColumns(["a", "b", "c"], ["b"]), [["a", "b"], ["c"]]);
  assert.deepEqual(splitColumns(["a", "b", "c", "d"], ["b", "d"]), [
    ["a", "b"],
    ["c", "d"],
  ]);
  assert.deepEqual(splitColumns(["a", "b", "c"], ["b", "c"]), [["a", "b"], ["c"]], "a full column starts a new one");
});

test("placeInSplit: above and below stack in the column, sides go beside it", () => {
  const one = { keys: [], stacked: [] };
  assert.deepEqual(placeInSplit(one, "b", { tile: null, axis: "y", side: "after" }, "a"), { keys: ["a", "b"], stacked: ["b"] });
  assert.deepEqual(placeInSplit(one, "b", { tile: null, axis: "y", side: "before" }, "a"), { keys: ["b", "a"], stacked: ["a"] });
  const two = { keys: ["a", "b"], stacked: [] };
  assert.deepEqual(placeInSplit(two, "c", { tile: "b", axis: "y", side: "after" }, "a"), { keys: ["a", "b", "c"], stacked: ["c"] });
  const column = { keys: ["a", "b", "c"], stacked: ["b"] };
  assert.deepEqual(placeInSplit(column, "d", { tile: "a", axis: "x", side: "after" }, "a"), { keys: ["a", "b", "d", "c"], stacked: ["b"] });
  assert.deepEqual(placeInSplit(column, "d", { tile: "b", axis: "x", side: "before" }, "a"), { keys: ["d", "a", "b", "c"], stacked: ["b"] });
  assert.deepEqual(
    placeInSplit(column, "d", { tile: "a", axis: "y", side: "after" }, "a"),
    { keys: ["a", "b", "d", "c"], stacked: ["b"] },
    "a full column takes the drop beside it",
  );
});

test("removeFromSplit: the Chat under a closed top moves up", () => {
  assert.deepEqual(removeFromSplit({ keys: ["a", "b", "c"], stacked: ["b"] }, "a"), { keys: ["b", "c"], stacked: [] });
  assert.deepEqual(removeFromSplit({ keys: ["a", "b", "c"], stacked: ["b"] }, "b"), { keys: ["a", "c"], stacked: [] });
  assert.deepEqual(removeFromSplit({ keys: ["a", "b", "c", "d"], stacked: ["d"] }, "a"), { keys: ["b", "c", "d"], stacked: ["d"] });
});

test("canStack and swapStacked", () => {
  const layout = { keys: ["a", "b", "c"], stacked: ["b"] };
  assert.deepEqual([canStack(layout, "a", "a"), canStack(layout, "b", "a"), canStack(layout, "c", "a")], [false, false, true]);
  assert.equal(canStack({ keys: [], stacked: [] }, null, "a"), true);
  assert.deepEqual(swapStacked(["b"], "b", "x"), ["x"]);
  assert.deepEqual(swapStacked(["b"], "a", "x"), ["b"]);
});
