import assert from "node:assert/strict";
import test from "node:test";
import { choiceOf, mainSyncChoices, mainSyncStatusLine, overrideOf } from "./main-sync.ts";

const now = 1_760_000_000_000;
const MINUTE = 60_000;

test("status lines name the outcome and how long ago", () => {
  assert.equal(mainSyncStatusLine(null, now), "Not synced yet");
  assert.equal(mainSyncStatusLine({ at: now - 3 * MINUTE, outcome: "updated", branch: "main", commit: "a1b2c3d" }, now), "Synced main 3 min ago (a1b2c3d)");
  assert.equal(mainSyncStatusLine({ at: now - 10_000, outcome: "up-to-date", branch: "trunk", commit: "a1b2c3d" }, now), "trunk was up to date just now");
  assert.equal(
    mainSyncStatusLine({ at: now - 2 * 60 * MINUTE, outcome: "skipped", branch: "main", message: "The main checkout has uncommitted changes" }, now),
    "Skipped 2 h ago: The main checkout has uncommitted changes",
  );
  assert.equal(
    mainSyncStatusLine({ at: now - 3 * 24 * 60 * MINUTE, outcome: "failed", branch: "main", message: "Could not reach origin" }, now),
    "Couldn't sync 3 d ago: Could not reach origin",
  );
  assert.equal(mainSyncStatusLine({ at: now + MINUTE, outcome: "updated", branch: "main" }, now), "Synced main just now");
});

test("choices map to the stored override and back", () => {
  assert.equal(choiceOf(null), "default");
  assert.equal(choiceOf(true), "on");
  assert.equal(choiceOf(false), "off");
  assert.equal(overrideOf("default"), null);
  assert.equal(overrideOf("on"), true);
  assert.equal(overrideOf("off"), false);
  assert.deepEqual(
    mainSyncChoices(false).map((choice) => choice.title),
    ["Default (Off)", "On", "Off"],
  );
  assert.equal(mainSyncChoices(true)[0].title, "Default (On)");
});
