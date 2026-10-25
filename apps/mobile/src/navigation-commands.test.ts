import { test } from "node:test";
import assert from "node:assert/strict";
import { requestNavigation, subscribeNavigation, takeNavigation } from "./navigation-commands.ts";

test("a request is taken once and announced to the lists on screen", () => {
  let calls = 0;
  const stop = subscribeNavigation(() => calls++);
  requestNavigation({ kind: "chat", index: 2 });
  assert.equal(calls, 1);
  assert.deepEqual(takeNavigation(), { kind: "chat", index: 2 });
  assert.equal(takeNavigation(), null, "a second list finds nothing left");
  stop();
});

test("a request nothing picked up in time is dropped", () => {
  requestNavigation({ kind: "new" });
  assert.equal(takeNavigation(Date.now() + 5000), null);
});
