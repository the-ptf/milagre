import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandheldSpotStore, DEFAULT_HANDHELD_SPOT, handheldSpotPoint, landHandheldSpot, parseHandheldSpot } from "./handheld-spot.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("the floating button settles against the nearer side edge, wherever it is let go", () => {
  assert.deepEqual(landHandheldSpot(40, 0, 50, 400, 800), { side: "left", y: 0 });
  assert.deepEqual(landHandheldSpot(180, 375, 50, 400, 800), { side: "right", y: 0.5 });
  assert.deepEqual(landHandheldSpot(-30, 900, 50, 400, 800), { side: "left", y: 1 });
  assert.deepEqual(handheldSpotPoint({ side: "right", y: 0.5 }, 50, 400, 800), { x: 350, y: 375 });
  assert.deepEqual(handheldSpotPoint({ side: "left", y: 1 }, 50, 400, 800), { x: 0, y: 750 });
});

test("a rotated or resized room keeps the button on its side, the same share of the way down", () => {
  const spot = landHandheldSpot(10, 225, 50, 400, 500);
  assert.deepEqual(handheldSpotPoint(spot, 50, 800, 300), { x: 0, y: 125 });
});

test("the spot survives a relaunch, and anything unreadable falls back to the default", async () => {
  const disk = storage();
  const first = createHandheldSpotStore(disk);
  assert.deepEqual(await first.load(), DEFAULT_HANDHELD_SPOT);
  await first.save({ side: "left", y: 0.25 });
  assert.deepEqual(await createHandheldSpotStore(disk).load(), { side: "left", y: 0.25 });
  for (const raw of ["", "{", '{"side":"top","y":0.2}', '{"side":"left","y":"x"}', "null"]) assert.deepEqual(parseHandheldSpot(raw), DEFAULT_HANDHELD_SPOT);
  assert.deepEqual(parseHandheldSpot('{"side":"right","y":4}'), { side: "right", y: 1 });
});
