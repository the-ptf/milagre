import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { BRIEF_NOTICE_MS, clearNoticeOnNavigate, currentNotice, showNotice } from "./notice.ts";

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

test("a brief notice goes after 3 s", () => {
  assert.equal(BRIEF_NOTICE_MS, 3000);
  showNotice("Chat archived", { ms: BRIEF_NOTICE_MS });
  mock.timers.tick(2999);
  assert.equal(currentNotice()?.text, "Chat archived");
  mock.timers.tick(1);
  assert.equal(currentNotice(), null);
});

test("going to another Chat or a New chat clears a notice that asks for it, and no other", () => {
  showNotice("Chat archived", { ms: BRIEF_NOTICE_MS, leaveOnNavigate: true });
  clearNoticeOnNavigate();
  assert.equal(currentNotice(), null);

  showNotice("File not found");
  clearNoticeOnNavigate();
  assert.equal(currentNotice()?.text, "File not found");
});

test("a newer notice replaces the older one and its timer", () => {
  showNotice("Chat archived", { ms: BRIEF_NOTICE_MS, leaveOnNavigate: true });
  mock.timers.tick(2000);
  showNotice("File not found");
  mock.timers.tick(1500);
  assert.equal(currentNotice()?.text, "File not found");
});
