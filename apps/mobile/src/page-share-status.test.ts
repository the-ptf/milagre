import assert from "node:assert/strict";
import test from "node:test";
import { shareScopeLabel, shareStateLabel, shareStatusLine } from "./page-share-status.ts";

const base = { id: "s", url: "https://share.milagre.cloud/s/s", title: "Chat", createdAt: 0, designCount: 2 };

test("a link's status line says whether it follows the agent and when it last changed", () => {
  const minute = 60_000;
  assert.equal(shareStatusLine({ ...base, live: true, updatedAt: minute }, 3 * minute), "Live · updated 2 min ago");
  assert.equal(shareStatusLine({ ...base, live: true }, 10_000), "Live · published just now");
  assert.equal(shareStatusLine({ ...base, live: true, paused: true }, minute), "Paused");
  assert.equal(
    shareStatusLine({ ...base, live: true, stale: true, lastError: "The sharing service is down." }, minute),
    "Couldn't update: The sharing service is down. Retrying.",
  );
  assert.equal(shareStatusLine({ ...base, live: true, stale: true }, minute), "Couldn't update yet. Retrying.");
  assert.equal(shareStatusLine({ ...base }, 3 * 60 * minute), "Snapshot · published 3 h ago");
});

test("Published pages rows name each link's scope and state", () => {
  assert.deepEqual((["workspace", "design", "artifacts", "designs", undefined] as const).map(shareScopeLabel), [
    "Workspace",
    "Design",
    "Page",
    "Designs",
    "Designs",
  ]);
  assert.equal(shareStateLabel({ ...base, live: true }), "Live");
  assert.equal(shareStateLabel({ ...base, live: true, paused: true }), "Paused");
  assert.equal(shareStateLabel({ ...base }), "Snapshot");
  assert.equal(shareStateLabel({ ...base, live: true, revoked: true }), "Revoked");
});
