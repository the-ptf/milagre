import test from "node:test";
import assert from "node:assert/strict";
import { seenAgo } from "./seen-ago.ts";

const now = 1_000_000_000_000;
const ago = (minutes: number) => now - minutes * 60_000;

test("seenAgo says when this phone last used a computer, and nothing when it never has", () => {
  assert.equal(seenAgo(0, now), "");
  assert.equal(seenAgo(ago(0), now), "seen just now");
  assert.equal(seenAgo(ago(5), now), "seen 5m ago");
  assert.equal(seenAgo(ago(120), now), "seen 2h ago");
  assert.equal(seenAgo(ago(60 * 24 * 3), now), "seen 3d ago");
  assert.equal(seenAgo(now + 5 * 60_000, now), "seen just now");
});
