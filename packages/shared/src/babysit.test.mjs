import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BABYSIT_DEFAULTS,
  BABYSIT_LEVELS,
  DAYS_OPTIONS,
  FAILURE_OPTIONS,
  INTERVAL_OPTIONS,
  babysitStoppedText,
  isBabysitStopped,
  normalizeBabysitSettings,
} from "./babysit.mjs";

test("defaults match the spec", () => {
  assert.deepEqual(BABYSIT_DEFAULTS, {
    enabled: false,
    intervalMinutes: 1,
    wake: ["comments", "checks", "conflicts"],
    level: 3,
    resolveThreads: true,
    stopWhenGreen: true,
    stopAfterDays: { on: true, days: 7 },
    stopAfterFailures: { on: false, times: 3 },
    ownRule: false,
    ownRuleText: "",
    instructions: "",
  });
});

test("the option lists", () => {
  assert.deepEqual(INTERVAL_OPTIONS, [1, 2, 5, 10, 15, 30]);
  assert.deepEqual(DAYS_OPTIONS, [1, 3, 7, 14, 30]);
  assert.deepEqual(FAILURE_OPTIONS, [2, 3, 5]);
});

test("normalize drops invalid values", () => {
  const out = normalizeBabysitSettings({ intervalMinutes: 4, level: 9, wake: ["checks", "nope"], extra: 1, instructions: 5 });
  assert.equal(out.intervalMinutes, 1);
  assert.equal(out.level, 3);
  assert.deepEqual(out.wake, ["checks"]);
  assert.equal(out.instructions, "");
  assert.equal("extra" in out, false);
});

test("normalize of garbage returns defaults", () => {
  for (const value of ["x", null, undefined, 5, [], true]) assert.deepEqual(normalizeBabysitSettings(value), BABYSIT_DEFAULTS);
});

test("normalize returns a fresh object each time", () => {
  const out = normalizeBabysitSettings({});
  assert.notEqual(out, BABYSIT_DEFAULTS);
  assert.notEqual(out.wake, BABYSIT_DEFAULTS.wake);
  assert.notEqual(out.stopAfterDays, BABYSIT_DEFAULTS.stopAfterDays);
});

test("normalize keeps valid values", () => {
  const input = {
    enabled: true,
    intervalMinutes: 15,
    wake: ["behind", "comments"],
    level: 5,
    resolveThreads: false,
    stopWhenGreen: false,
    stopAfterDays: { on: false, days: 30 },
    stopAfterFailures: { on: true, times: 5 },
    ownRule: true,
    ownRuleText: "the PR has a human thumbs-up",
    instructions: "Keep commits small.",
  };
  assert.deepEqual(normalizeBabysitSettings(input), { ...input, wake: ["comments", "behind"] });
});

test("wake is deduplicated and kept in canonical order", () => {
  assert.deepEqual(normalizeBabysitSettings({ wake: ["behind", "checks", "behind", "comments"] }).wake, ["comments", "checks", "behind"]);
  assert.deepEqual(normalizeBabysitSettings({ wake: [] }).wake, []);
  assert.deepEqual(normalizeBabysitSettings({ wake: "checks" }).wake, ["comments", "checks", "conflicts"]);
});

test("nested rules fall back per field and keep their value when off", () => {
  const out = normalizeBabysitSettings({ stopAfterDays: { on: false, days: 4 }, stopAfterFailures: { on: true, times: 2 } });
  assert.deepEqual(out.stopAfterDays, { on: false, days: 7 });
  assert.deepEqual(out.stopAfterFailures, { on: true, times: 2 });
  assert.deepEqual(normalizeBabysitSettings({ stopAfterDays: 3 }).stopAfterDays, { on: true, days: 7 });
  const off = normalizeBabysitSettings({ ownRule: false, ownRuleText: "keep me" });
  assert.equal(off.ownRule, false);
  assert.equal(off.ownRuleText, "keep me");
});

test("text fields are capped", () => {
  assert.equal(normalizeBabysitSettings({ instructions: "a".repeat(5000) }).instructions.length, 4000);
  assert.equal(normalizeBabysitSettings({ ownRuleText: "b".repeat(500) }).ownRuleText.length, 300);
});

test("non-boolean flags fall back to defaults", () => {
  const out = normalizeBabysitSettings({ enabled: "yes", resolveThreads: 0, stopWhenGreen: null });
  assert.equal(out.enabled, false);
  assert.equal(out.resolveThreads, true);
  assert.equal(out.stopWhenGreen, true);
});

test("levels carry their steps", () => {
  assert.deepEqual(
    BABYSIT_LEVELS.map((l) => l.steps),
    [["report"], ["fix"], ["fix", "push"], ["fix", "push", "reply"], ["fix", "push", "reply", "rerequest"]],
  );
  assert.deepEqual(
    BABYSIT_LEVELS.map((l) => l.level),
    [1, 2, 3, 4, 5],
  );
  assert.equal(BABYSIT_LEVELS[0].title, "Report only");
  assert.equal(BABYSIT_LEVELS[4].description, "Then asks the reviewers who left changes to look again.");
});

test("the line a Chat shows when babysitting its PR stopped says why", () => {
  const stopped = (reason, extra = {}) => babysitStoppedText({ kind: "babysit-stopped", routineId: "r1", pr: 1, reason, ...extra });
  assert.equal(stopped("merged"), "Stopped babysitting PR #1: merged.");
  assert.equal(stopped("closed"), "Stopped babysitting PR #1: closed.");
  assert.equal(stopped("green"), "Stopped babysitting PR #1: checks pass and it's approved.");
  assert.equal(stopped("failures", { times: 3 }), "Stopped babysitting PR #1: the same problem failed 3 times.");
  assert.equal(stopped("expired", { days: 7 }), "Stopped babysitting PR #1: watched for 7 days.");
  assert.equal(stopped("expired", { days: 1 }), "Stopped babysitting PR #1: watched for 1 day.");
  assert.equal(stopped("own-rule"), "Stopped babysitting PR #1: your own stop rule held.");
  assert.equal(stopped("deleted"), "Stopped babysitting PR #1: its Heartbeat was deleted.");
  // A reason this build doesn't know still reads as a stop.
  assert.equal(stopped("later"), "Stopped babysitting PR #1.");
  assert.equal(isBabysitStopped({ context: { kind: "babysit-stopped", routineId: "r1", pr: 1, reason: "merged" } }), true);
  assert.equal(isBabysitStopped({ context: { kind: "reload" } }), false);
  assert.equal(isBabysitStopped(null), false);
});
