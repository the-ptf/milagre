import { test } from "node:test";
import assert from "node:assert/strict";
import { cardTop, chatAreaWidth, rightDocks, sidebarFits, widthClass } from "./split-width.ts";

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

test("the pinned sidebar narrows the Chat", () => {
  assert.equal(chatAreaWidth(1366, true), 1034);
  assert.equal(chatAreaWidth(1366, false), 1366);
});

test("a card reaches the top as it reaches the bottom, clear of a window's controls", () => {
  assert.deepEqual(cardTop(24, false), { top: 24, controls: 0 }, "full screen: just under the status bar");
  assert.deepEqual(cardTop(0, false), { top: 12, controls: 0 }, "no status bar: a margin from the edge");
  assert.deepEqual(cardTop(0, true), { top: 12, controls: 32 }, "resizable window: content below the controls");
  assert.deepEqual(cardTop(24, true), { top: 24, controls: 20 });
});

test("the right panel docks beside the Chat wherever the Chat keeps a phone's width", () => {
  assert.equal(rightDocks(402), false, "iPhone: a page over the Chat");
  assert.equal(rightDocks(744), false, "iPad mini portrait: a card over the Chat");
  assert.equal(rightDocks(820), true, "11-inch iPad portrait");
  assert.equal(rightDocks(1366), true, "13-inch iPad landscape");
});

test("the pinned sidebar gives way to the docked panel only when the Chat would get too narrow", () => {
  assert.equal(sidebarFits(1194, false), true, "nothing docked");
  assert.equal(sidebarFits(1194, true), false, "11-inch iPad landscape");
  assert.equal(sidebarFits(1366, true), true, "13-inch iPad landscape");
});
