import assert from "node:assert/strict";
import test from "node:test";
import {
  isBlockerDismissed,
  pullRequestAction,
  pullRequestBlockers,
  pullRequestPresentation,
  rowPullRequests,
  updateBlockerDismissals,
} from "./pr-blockers.ts";

const pr = { number: 77, url: "https://github.com/example/repo/pull/77", state: "OPEN", hasConflicts: true };

test("a clicked conflict action stays dismissed through refreshes and failed lookups", () => {
  const dismissed = updateBlockerDismissals([], pr, "conflicts");
  assert.deepEqual(dismissed, [pr.url]);
  assert.deepEqual(updateBlockerDismissals(dismissed, pr), dismissed);
  assert.deepEqual(updateBlockerDismissals(dismissed, null), dismissed);
  assert.deepEqual(updateBlockerDismissals(dismissed, { ...pr, hasConflicts: false, conflictStatusKnown: false }), dismissed);
});

test("confirmed resolution allows the action for a later conflict", () => {
  const dismissed = updateBlockerDismissals([], pr, "conflicts");
  const cleared = updateBlockerDismissals(dismissed, { ...pr, hasConflicts: false });
  assert.deepEqual(cleared, []);
  assert.deepEqual(updateBlockerDismissals(cleared, pr), []);
});

test("PR dismissal is independent of other repositories and PRs", () => {
  const other = { ...pr, url: "https://github.com/example/other/pull/77" };
  const dismissed = updateBlockerDismissals([other.url], pr, "conflicts");
  assert.deepEqual(updateBlockerDismissals(dismissed, { ...pr, state: "MERGED" }), [other.url]);
});

test("blockers are ordered conflicts, requested changes, failed CI, then an outdated branch", () => {
  assert.deepEqual(pullRequestBlockers({ ...pr, isBehind: true, changesRequested: true, checks: "failed" }), [
    "conflicts",
    "changes-requested",
    "checks-failed",
    "behind",
  ]);
  assert.deepEqual(pullRequestBlockers({ ...pr, hasConflicts: false, isBehind: true, checks: "failed" }), ["checks-failed", "behind"]);
  assert.deepEqual(pullRequestBlockers({ ...pr, hasConflicts: false, checks: "running" }), [], "Running checks block nothing yet");
  assert.deepEqual(pullRequestBlockers({ ...pr, hasConflicts: false, isBehind: true }), ["behind"]);
  assert.deepEqual(pullRequestBlockers({ ...pr, state: "MERGED", changesRequested: true }), []);
  assert.deepEqual(pullRequestBlockers(null), []);
});

test("each blocker is dismissed and cleared on its own", () => {
  const blocked = { ...pr, hasConflicts: false, isBehind: true, changesRequested: true };
  let dismissed = updateBlockerDismissals([], blocked, "behind");
  dismissed = updateBlockerDismissals(dismissed, blocked, "changes-requested");
  assert.ok(isBlockerDismissed(dismissed, "behind", blocked));
  assert.ok(isBlockerDismissed(dismissed, "changes-requested", blocked));
  assert.ok(!isBlockerDismissed(dismissed, "conflicts", blocked));

  // The branch was updated but the reviewer hasn't approved yet.
  dismissed = updateBlockerDismissals(dismissed, { ...blocked, isBehind: false });
  assert.ok(!isBlockerDismissed(dismissed, "behind", blocked));
  assert.ok(isBlockerDismissed(dismissed, "changes-requested", blocked));
});

test("an unknown merge state doesn't clear an outdated-branch dismissal", () => {
  const behind = { ...pr, hasConflicts: false, isBehind: true };
  const dismissed = updateBlockerDismissals([], behind, "behind");
  assert.deepEqual(updateBlockerDismissals(dismissed, { ...behind, isBehind: false, conflictStatusKnown: false }), dismissed);
});

test("clicking an action for a blocker the PR no longer has dismisses nothing", () => {
  assert.deepEqual(updateBlockerDismissals([], pr, "behind"), []);
});

test("a failed CI action clears as soon as the checks are no longer failing", () => {
  const failing = { ...pr, hasConflicts: false, checks: "failed" as const };
  const dismissed = updateBlockerDismissals([], failing, "checks-failed");
  assert.ok(isBlockerDismissed(dismissed, "checks-failed", failing));
  assert.deepEqual(updateBlockerDismissals(dismissed, failing), dismissed);
  // A push reruns CI: the checks are running, so the fix is being verified and a later failure can offer the action again.
  assert.deepEqual(updateBlockerDismissals(dismissed, { ...failing, checks: "running" }), []);
});

test("the composer's action comes from any of the chat's PRs, skipping blockers already being fixed", () => {
  const other = { number: 80, url: "https://github.com/example/repo/pull/80", title: "", state: "OPEN" as const, readyToMerge: false, hasConflicts: false };
  const reviewed = { ...other, number: 81, url: "https://github.com/example/repo/pull/81", changesRequested: true };
  assert.deepEqual(pullRequestAction([other, reviewed]), { pr: reviewed, blocker: "changes-requested" });
  const dismissed = updateBlockerDismissals([], reviewed, "changes-requested");
  assert.equal(pullRequestAction([other, reviewed], dismissed), null);
  const failing = { ...reviewed, checks: "failed" as const };
  assert.deepEqual(pullRequestAction([other, failing], dismissed), { pr: failing, blocker: "checks-failed" });
  assert.equal(pullRequestAction([]), null);
});

test("every PR state has its own badge: merged, closed, draft, blocked, ready, running, open", () => {
  const base = { number: 5, url: "https://github.com/example/repo/pull/5", state: "OPEN" };
  const look = (extra: object) => {
    const { tone, icon, label } = pullRequestPresentation({ ...base, ...extra });
    return [tone, icon, label];
  };
  assert.deepEqual(look({ state: "MERGED" }), ["purple", "merged", "Merged"]);
  assert.deepEqual(look({ state: "CLOSED" }), ["ink3", "closed", "Closed"]);
  assert.deepEqual(look({ isDraft: true, checks: "running" }), ["ink3", "draft", "Draft"]);
  // A blocker still outranks draft: a draft's failing CI is the thing to fix.
  assert.deepEqual(look({ isDraft: true, checks: "failed" }), ["red", "open", "CI failed"]);
  assert.deepEqual(look({ readyToMerge: true }), ["green", "ready", "Ready"]);
  assert.deepEqual(look({ checks: "running" }), ["orange", "checking", "CI running"]);
  assert.deepEqual(look({}), ["green", "open", ""]);
  assert.equal(pullRequestPresentation({ ...base, isDraft: true }).description, "Draft pull request #5");
  assert.equal(pullRequestPresentation({ ...base, isDraft: true }).spoken, "draft pull request #5");
  assert.equal(pullRequestPresentation({ ...base, readyToMerge: true }).spoken, "pull request #5, ready to merge");
  assert.equal(pullRequestPresentation({ ...base, state: "CLOSED" }).spoken, "closed pull request #5");
});

test("a Chat's row lists blocked, open, merged, then closed PRs", () => {
  const make = (number: number, extra: object) => ({
    number,
    title: "",
    url: `https://github.com/example/repo/pull/${number}`,
    state: "OPEN" as const,
    readyToMerge: false,
    hasConflicts: false,
    ...extra,
  });
  const ordered = rowPullRequests([make(1, { state: "CLOSED" }), make(2, { state: "MERGED" }), make(3, {}), make(4, { hasConflicts: true })]);
  assert.deepEqual(
    ordered.map((entry) => entry.number),
    [4, 3, 2, 1],
  );
});
