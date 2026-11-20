import assert from "node:assert/strict";
import test from "node:test";
import type { DesignPageShare } from "@milagre/shared/artifact";
import { scopeLabel, shareNotice, shareState, shareStatusLine, shareTitle, shareTone } from "./page-share-status.ts";

const now = 1_780_000_000_000;
const share = (extra: Partial<DesignPageShare> = {}): DesignPageShare => ({
  id: "a",
  url: "https://share.milagre.cloud/s/a",
  title: "Chat",
  createdAt: now - 10 * 60_000,
  designCount: 2,
  ...extra,
});

test("a live link says when it last changed", () => {
  assert.equal(shareStatusLine(share({ live: true }), now), "Live · published 10 min ago");
  assert.equal(shareStatusLine(share({ live: true, updatedAt: now - 2 * 60_000 }), now), "Live · updated 2 min ago");
  assert.equal(shareStatusLine(share({ live: true, updatedAt: now - 5_000 }), now), "Live · updated just now");
  assert.equal(shareTone(share({ live: true })), "green");
});

test("paused, retrying and frozen links each say so", () => {
  assert.equal(shareStatusLine(share({ live: true, paused: true }), now), "Paused");
  assert.equal(
    shareStatusLine(share({ live: true, stale: true, lastError: "The sharing service could not be reached." }), now),
    "Couldn't update: The sharing service could not be reached. Retrying.",
  );
  assert.equal(shareStatusLine(share({ live: true, stale: true }), now), "Couldn't update yet. Retrying.");
  assert.equal(shareTone(share({ live: true, stale: true })), "red");
  assert.equal(shareStatusLine(share(), now), "Snapshot · published 10 min ago");
  assert.equal(shareTone(share()), "muted");
});

test("published pages name their scope and state", () => {
  assert.deepEqual([share({ kind: "workspace" }), share({ kind: "design", designId: "login" }), share({ kind: "artifacts" }), share()].map(scopeLabel), [
    "Workspace",
    "Design",
    "Page",
    "Designs",
  ]);
  assert.deepEqual([share({ live: true }), share({ live: true, paused: true }), share(), share({ live: true, revoked: true })].map(shareState), [
    "Live",
    "Paused",
    "Snapshot",
    "Revoked",
  ]);
});

test("each scope warns what the link shows", () => {
  assert.equal(shareTitle({ kind: "workspace" }), "Share");
  assert.equal(shareTitle({ kind: "design", designId: "login" }), "Share this design");
  assert.equal(shareTitle({ kind: "artifacts" }), "Share this page");
  assert.match(shareNotice({ kind: "workspace" }), /^Anyone with the link can see every design and the page.*keeps updating as the agent works\.$/);
  assert.match(shareNotice({ kind: "design" }), /this design\./);
  assert.match(shareNotice({ kind: "artifacts" }, true), /Share again for a link that keeps updating/);
});
