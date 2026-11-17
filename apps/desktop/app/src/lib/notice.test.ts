import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { currentNotice, showNotice } from "./notice.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => {
  mock.timers.tick(10_000);
  mock.timers.reset();
});

test("a notice stays 3.5 s by default", () => {
  showNotice("File not found");
  mock.timers.tick(3499);
  assert.equal(currentNotice()?.text, "File not found");
  mock.timers.tick(1);
  assert.equal(currentNotice(), null);
});

test("a newer notice replaces the older one and its timer", () => {
  showNotice("Chat archived");
  mock.timers.tick(2000);
  showNotice("File not found");
  mock.timers.tick(1500);
  assert.equal(currentNotice()?.text, "File not found");
});
