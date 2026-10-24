import assert from "node:assert/strict";
import test from "node:test";
import { createOpenGuard } from "./archived-open.ts";

test("while one open is pending no other starts, and rows can read that synchronously", () => {
  let cancelled = 0;
  const guard = createOpenGuard(() => void cancelled++);
  const first = guard.begin();
  assert.ok(first);
  assert.equal(guard.pending(), true);
  assert.equal(guard.begin(), null, "a second tap in the same frame is refused");
  assert.equal(cancelled, 1, "starting cancelled the session's other navigations once");
  first.end();
  assert.equal(guard.pending(), false);
  assert.ok(guard.begin(), "the next open may start once the first ended");
});

test("leaving the page makes a pending open stale and cancels the session's switch", () => {
  let cancelled = 0;
  const guard = createOpenGuard(() => void cancelled++);
  const ticket = guard.begin()!;
  assert.equal(ticket.current(), true);
  guard.leave();
  assert.equal(ticket.current(), false, "the stale open must not switch computers or navigate");
  assert.equal(cancelled, 2, "begin and leave each cancelled the session's navigation");
  assert.equal(guard.pending(), false);
});

test("a stale ticket ending does not unlock a newer open", () => {
  const guard = createOpenGuard(() => {});
  const stale = guard.begin()!;
  guard.leave();
  const fresh = guard.begin()!;
  stale.end();
  assert.equal(guard.pending(), true, "the newer open is still pending");
  assert.equal(guard.begin(), null);
  assert.equal(stale.current(), false);
  assert.equal(fresh.current(), true);
  fresh.end();
  assert.equal(guard.pending(), false);
});

test("leaving with nothing pending cancels nothing, so a finished open's navigation is not cut short", () => {
  let cancelled = 0;
  const guard = createOpenGuard(() => void cancelled++);
  guard.begin()!.end();
  const before = cancelled;
  guard.leave();
  assert.equal(cancelled, before);
});

test("a slow open to another computer is stale after the page is left even if a tap on the current one came first", async () => {
  const guard = createOpenGuard(() => {});
  const switched: string[] = [];
  const slow = guard.begin()!;
  // Tapping a Chat on the current computer while that open is pending does nothing.
  assert.equal(guard.begin(), null);
  guard.leave();
  await Promise.resolve();
  if (slow.current()) switched.push("B");
  assert.deepEqual(switched, []);
});
