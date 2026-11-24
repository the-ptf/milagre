import test from "node:test";
import assert from "node:assert/strict";
import { simulatorKind, simulatorRuntimeLabel } from "./simulator.ts";

test("a device's kind comes from its catalog family, not its editable name", () => {
  assert.equal(simulatorKind({ platform: "ios", name: "My iPad", productFamily: "iPhone" }), "iPhone");
  assert.equal(simulatorKind({ platform: "ios", name: "QA", productFamily: "Watch" }), "Watch");
  assert.equal(simulatorKind({ platform: "android", name: "iPad_API_35", productFamily: null }), "Android");
});

test("an older host's device falls back to its model identifier, then its name", () => {
  assert.equal(simulatorKind({ platform: "ios", name: "QA", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4" }), "iPad");
  assert.equal(simulatorKind({ platform: "ios", name: "iPad (A16)" }), "iPad");
  assert.equal(simulatorKind({ platform: "ios", name: "Apple TV 4K" }), "TV");
  assert.equal(simulatorKind({ platform: "ios", name: "Whatever", productFamily: null, deviceType: null }), "iPhone");
});

test("the runtime label prefers the runtime's version", () => {
  assert.equal(simulatorRuntimeLabel({ platform: "ios", version: "26.4", runtimeVersion: "26.4.1" }), "iOS 26.4.1");
  assert.equal(simulatorRuntimeLabel({ platform: "ios", version: "26.4" }), "iOS 26.4");
  assert.equal(simulatorRuntimeLabel({ platform: "android", version: "16", runtimeVersion: null }), "Android 16");
  assert.equal(simulatorRuntimeLabel({ id: "baguette:00008150-00050D003C20401C", platform: "ios", version: "27.3" }), "On a cable · iOS 27.3");
  assert.equal(simulatorRuntimeLabel({ id: "baguette:00008150-00050D003C20401C", platform: "ios", version: "" }), "On a cable");
});
