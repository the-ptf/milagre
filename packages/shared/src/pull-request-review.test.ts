import assert from "node:assert/strict";
import { test } from "node:test";
import { checksSummary, mergeStatus, openThreads, type PullRequestDetail } from "./pull-request-review.ts";

const base: PullRequestDetail = {
  number: 7,
  url: "https://github.com/a/b/pull/7",
  title: "fix",
  body: "",
  state: "OPEN",
  isDraft: false,
  author: "v",
  createdAt: "",
  updatedAt: "",
  baseRefName: "main",
  headRefName: "x",
  headRefOid: "a",
  baseRefOid: "b",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  autoMerge: null,
  viewerCanMergeAsAdmin: false,
  viewerIsAuthor: true,
  checks: [
    { name: "unit", outcome: "pass" },
    { name: "smoke", outcome: "skipped" },
  ],
  reviewers: [{ login: "marcos", state: "APPROVED" }],
  labels: [],
  commits: [],
  files: [],
  threads: [],
  comments: [],
  pendingReview: null,
};

test("mergeStatus: ready reads the way the merge card shows it", () => {
  assert.deepEqual(mergeStatus(base), { tone: "ready", title: "Ready to merge", detail: "Checks passed · 1 approval · no conflicts" });
});
test("mergeStatus: conflicts outrank failing checks, which outrank a change request", () => {
  const failing = { ...base, checks: [{ name: "lint", outcome: "fail" as const }, ...base.checks] };
  assert.equal(mergeStatus({ ...failing, mergeStateStatus: "DIRTY" }).title, "Conflicts");
  assert.deepEqual(mergeStatus({ ...failing, mergeStateStatus: "BLOCKED" }), { tone: "blocked", title: "Checks failing", detail: "1 check failed of 3" });
  assert.equal(
    mergeStatus({ ...base, reviewDecision: "CHANGES_REQUESTED", reviewers: [{ login: "j", state: "CHANGES_REQUESTED" }] }).detail,
    "j asked for changes",
  );
});
test("mergeStatus: drafts, merged and closed PRs say so", () => {
  assert.equal(mergeStatus({ ...base, isDraft: true }).tone, "draft");
  assert.equal(mergeStatus({ ...base, state: "MERGED" }).detail, "Merged into main");
  assert.equal(mergeStatus({ ...base, state: "CLOSED" }).tone, "closed");
});

test("checksSummary and openThreads", () => {
  assert.equal(checksSummary([...base.checks, { name: "x", outcome: "running" }]), "1 running · 1 passed · 1 skipped");
  const comment = { id: "c", author: "j", body: "?", createdAt: "" };
  assert.deepEqual(
    openThreads({
      ...base,
      threads: [
        { id: "1", path: "a", line: 1, side: "RIGHT", resolved: false, outdated: false, comments: [comment] },
        { id: "2", path: "a", line: 2, side: "RIGHT", resolved: true, outdated: false, comments: [comment] },
        { id: "3", path: "a", line: 3, side: "RIGHT", resolved: false, outdated: false, comments: [{ ...comment, pending: true }] },
      ],
    }).map((thread) => thread.id),
    ["1"],
  );
});
