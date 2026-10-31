import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequest } from "../model.ts";
import { updateBlockerDismissals } from "./pr-blockers.ts";
import { samePullRequest, withChatPullRequests, withPullRequests } from "./pull-request-answers.ts";

const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/example/repo/pull/${number}`,
  state: "OPEN",
  readyToMerge: false,
  hasConflicts: false,
  ...extra,
});

test("a branch PR read again with the same answer keeps the held PRs as they were", () => {
  const held = { "/w/a": pr(1), "/w/b": null };
  // gh's answer is a new object every time, equal or not.
  assert.equal(withPullRequests(held, { "/w/a": pr(1), "/w/b": null }), held);
  assert.equal(withPullRequests(held, {}), held);
  const changed = withPullRequests(held, { "/w/a": pr(1, { checks: "failed" }) });
  assert.notEqual(changed, held);
  assert.deepEqual(changed, { "/w/a": pr(1, { checks: "failed" }), "/w/b": null });
  // A Worktree read for the first time is news even when it has no PR.
  assert.deepEqual(withPullRequests(held, { "/w/c": null }), { ...held, "/w/c": null });
});

test("Chats' PRs read again keep every folder whose answers didn't change", () => {
  const held = { "/w/a": { "#1": pr(1), "#2": pr(2, { state: "MERGED" }) }, "/w/b": { "#3": null } };
  assert.equal(withChatPullRequests(held, { "/w/a": { "#1": pr(1) }, "/w/b": { "#3": null } }), held);
  const next = withChatPullRequests(held, { "/w/a": { "#1": pr(1, { readyToMerge: true }) }, "/w/b": { "#3": null } });
  assert.notEqual(next, held);
  assert.equal(next["/w/b"], held["/w/b"], "an unchanged folder keeps its object");
  assert.equal(next["/w/a"]!["#2"], held["/w/a"]["#2"], "refs not in the read stay");
  assert.equal(next["/w/a"]!["#1"]!.readyToMerge, true);
  assert.deepEqual(withChatPullRequests(held, { "/w/c": {} }), { ...held, "/w/c": {} });
});

test("PR answers compare by what they say", () => {
  assert.ok(samePullRequest(pr(1), pr(1)));
  assert.ok(samePullRequest(null, undefined));
  assert.ok(!samePullRequest(pr(1), pr(1, { isBehind: true })));
  assert.ok(!samePullRequest(pr(1), null));
});

test("reads that clear no dismissed blocker keep the dismissals as they were", () => {
  const dismissed = [pr(1).url];
  const answers = [pr(1, { hasConflicts: true }), null, pr(2)];
  assert.equal(
    answers.reduce((next, answer) => updateBlockerDismissals(next, answer), dismissed),
    dismissed,
  );
});
