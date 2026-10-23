import assert from "node:assert/strict";
import test from "node:test";
import { dropSlot, showSlot, trimSlots } from "./transcript-slots.ts";

test("showing a Chat appends its slot once and updates it in place after", () => {
  let slots = showSlot([], "a", "a1");
  slots = showSlot(slots, "b", "b1");
  const again = showSlot(slots, "a", "a2");
  assert.deepEqual(
    again.map((slot) => [slot.key, slot.element]),
    [
      ["a", "a2"],
      ["b", "b1"],
    ],
    "a keeps its place before b",
  );
  assert.equal(showSlot(again, "a", "a2"), again, "the same element shown again changes nothing");
});

test("trimming drops the parked slots shown longest ago and never the active one", () => {
  let slots: ReturnType<typeof showSlot<string>> = [];
  for (const key of ["a", "b", "c", "d", "e", "f"]) slots = showSlot(slots, key, key);
  slots = showSlot(slots, "a", "a again");
  const trimmed = trimSlots(slots, "a", 2);
  assert.deepEqual(
    trimmed.map((slot) => slot.key),
    ["a", "e", "f"],
  );
  assert.equal(trimSlots(trimmed, "a", 2), trimmed, "within the limit nothing changes");
  assert.deepEqual(
    trimSlots(slots, "b", 1).map((slot) => slot.key),
    ["a", "b"],
    "the active slot stays even when it was shown long ago",
  );
});

test("dropping a slot leaves the others in order", () => {
  let slots: ReturnType<typeof showSlot<string>> = [];
  for (const key of ["a", "b", "c"]) slots = showSlot(slots, key, key);
  assert.deepEqual(
    dropSlot(slots, "b").map((slot) => slot.key),
    ["a", "c"],
  );
  assert.equal(dropSlot(slots, "zzz"), slots);
});
