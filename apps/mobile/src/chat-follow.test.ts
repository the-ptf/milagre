import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./chat-follow.ts", import.meta.url), "utf8");
const pure = source.slice(source.indexOf("export function nextFollow"), source.indexOf("export function useTranscriptFollow"));
const { nextFollow } = (await import("data:text/javascript," + encodeURIComponent(stripTypeScriptTypes(pure)))) as typeof import("./chat-follow.ts");

const state = { following: true, scrollingToBottom: false, dragging: false, scrolledFirstRow: 1 };
const scrollEvent = { offset: 500, previous: 490, distance: 0, firstRowId: 1 };

test("a jump to the end ignores scroll events until it reaches the end", () => {
  const moving = nextFollow({ ...state, scrollingToBottom: true }, { ...scrollEvent, distance: 300 });
  assert.equal(moving.scrollingToBottom, true);
  assert.equal(moving.stop, true);
  assert.equal(moving.scrolledFirstRow, 1, "the first row is not read while the jump runs");
  const arrived = nextFollow({ ...state, scrollingToBottom: true }, { ...scrollEvent, distance: 1 });
  assert.equal(arrived.scrollingToBottom, false);
  assert.equal(arrived.stop, true);
});

test("rows leaving the top while following jump on to the end, unless the reader drags", () => {
  const left = nextFollow(state, { ...scrollEvent, distance: 200, firstRowId: 2 });
  assert.deepEqual(left, { following: true, scrollingToBottom: false, scrolledFirstRow: 2, toBottom: true, stop: true });
  const dragged = nextFollow({ ...state, dragging: true }, { ...scrollEvent, distance: 200, firstRowId: 2 });
  assert.equal(dragged.toBottom, false);
  assert.equal(dragged.stop, false);
});

test("following holds within 120 of the end; once paused, only scrolling down to the end resumes it", () => {
  assert.equal(nextFollow(state, { ...scrollEvent, distance: 119 }).following, true);
  assert.equal(nextFollow(state, { ...scrollEvent, distance: 120 }).following, false);
  const paused = { ...state, following: false };
  assert.equal(nextFollow(paused, { ...scrollEvent, distance: 50 }).following, false);
  assert.equal(nextFollow(paused, { ...scrollEvent, offset: 480, distance: 0 }).following, false, "an upward move to the end does not resume");
  assert.equal(nextFollow(paused, { ...scrollEvent, distance: 0 }).following, true);
});
