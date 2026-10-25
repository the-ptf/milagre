import { test } from "node:test";
import assert from "node:assert/strict";
import { chatAreaWidth, readingInset, widthClass } from "./split-width.ts";

test("phones and narrow iPad windows keep the phone stack", () => {
  assert.equal(widthClass(402), "compact", "iPhone");
  assert.equal(widthClass(678), "compact", "half of a 13-inch iPad in landscape Split View");
  assert.equal(widthClass(375), "compact", "Slide Over");
});

test("iPad portrait slides the sidebar over and landscape pins it", () => {
  assert.equal(widthClass(744), "regular", "iPad mini portrait");
  assert.equal(widthClass(1024), "regular", "13-inch iPad portrait");
  assert.equal(widthClass(1133), "wide", "iPad mini landscape");
  assert.equal(widthClass(1366), "wide", "13-inch iPad landscape");
});

test("the pinned sidebar narrows the Chat and the reading column centers in what is left", () => {
  assert.equal(chatAreaWidth(1366, true), 1034);
  assert.equal(chatAreaWidth(1366, false), 1366);
  assert.equal(readingInset(1034), 137);
  assert.equal(readingInset(700), 0, "a column wider than the Chat adds nothing");
});
