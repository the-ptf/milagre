import { test } from "node:test";
import assert from "node:assert/strict";
import type { PullRequestDetail, PullRequestThread } from "@milagre/shared/pull-request-review";
import { diffRows } from "./diff-rows.ts";
import {
  ago,
  agoLabel,
  attachThreads,
  commentItems,
  filesByFolder,
  lineMessage,
  lineTarget,
  middleTruncate,
  neighbours,
  notInPrLine,
  repoOf,
  splitDiffRows,
  withLabels,
  withResolved,
  withReviewers,
} from "./pr-review.ts";

const thread = (overrides: Partial<PullRequestThread> = {}): PullRequestThread => ({
  id: "T1",
  path: "src/a.ts",
  line: 2,
  side: "RIGHT",
  resolved: false,
  outdated: false,
  comments: [{ id: "C1", author: "jefo3", body: "Wait for the picker?", createdAt: "" }],
  ...overrides,
});

const pr: PullRequestDetail = {
  number: 673,
  url: "https://github.com/acme/app/pull/673",
  title: "fix: shared files",
  body: "",
  state: "OPEN",
  isDraft: false,
  author: "victor",
  createdAt: "2026-10-25T10:00:00Z",
  updatedAt: "",
  baseRefName: "main",
  headRefName: "milagre/fix-shared-file-picker-error-aghp",
  headRefOid: "a".repeat(40),
  baseRefOid: "b".repeat(40),
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  autoMerge: null,
  viewerCanMergeAsAdmin: false,
  viewerIsAuthor: true,
  checks: [{ name: "lint", outcome: "fail", url: "https://ci/lint" }],
  reviewers: [{ login: "marcos", state: "APPROVED" }],
  labels: [],
  commits: [],
  files: [
    { path: "src/b.ts", additions: 1, deletions: 0, status: "added" },
    { path: "src/a.ts", additions: 8, deletions: 2, status: "modified" },
    { path: "README.md", additions: 1, deletions: 0, status: "modified" },
  ],
  threads: [thread()],
  comments: [],
  pendingReview: null,
};

const patch = ["@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three", ""].join("\n");

test("files group under their folders", () => {
  assert.deepEqual(
    filesByFolder(pr.files).map((group) => [group.folder, group.files.map((file) => file.path)]),
    [
      ["", ["README.md"]],
      ["src", ["src/a.ts", "src/b.ts"]],
    ],
  );
});

test("threads sit under their line, unified or side by side; the rest come back apart", () => {
  const away = thread({ id: "T2", line: 40 });
  const left = thread({ id: "T3", line: 2, side: "LEFT" });
  const unified = attachThreads(diffRows(patch), [thread(), away, left]);
  const order = unified.items.map((item) => (item.type === "thread" ? item.thread.id : item.row.type === "line" ? `${item.row.line.kind}` : "hunk"));
  // The old line 2 ("-two") carries the LEFT thread, the new line 2 ("+TWO") the RIGHT one.
  assert.deepEqual(order, ["hunk", "context", "remove", "T3", "add", "T1", "context"]);
  assert.deepEqual(
    unified.detached.map((entry) => entry.id),
    ["T2"],
  );
  const split = attachThreads(splitDiffRows(patch), [thread(), left]);
  assert.equal(split.items.filter((item) => item.type === "thread").length, 2);
  assert.equal(split.detached.length, 0);
});

test("a diff line comments on its new number, a removed one on its old number", () => {
  assert.deepEqual(lineTarget({ kind: "add", text: "x", newNumber: 4 }), { line: 4, side: "RIGHT" });
  assert.deepEqual(lineTarget({ kind: "remove", text: "x", oldNumber: 3 }), { line: 3, side: "LEFT" });
});

test("a line sent to the Chat carries the PR, the place and what was said", () => {
  assert.equal(lineMessage(pr, "src/a.ts", 2, "RIGHT", " why? "), "About src/a.ts:2 in PR #673:\n\nwhy?");
  assert.match(lineMessage(pr, "src/a.ts", 3, "LEFT", "x"), /src\/a\.ts, old line 3/);
});

test("optimistic writes change only their thread, labels or reviewers", () => {
  assert.equal(withResolved(pr, "T1", true).threads[0]?.resolved, true);
  const labelled = withLabels({ ...pr, labels: [{ name: "bug", color: "d73a4a" }] }, ["enhancement"], ["bug"], [{ name: "enhancement", color: "a2eeef" }]);
  assert.deepEqual(labelled.labels, [{ name: "enhancement", color: "a2eeef" }]);
  const asked = withReviewers(pr, ["eric"], ["marcos"]);
  assert.deepEqual(asked.reviewers, [{ login: "eric", state: "REQUESTED" }]);
});

test("comments and open threads by time, resolved threads apart", () => {
  const withComments = {
    ...pr,
    comments: [{ id: "P1", author: "eric", body: "LGTM", createdAt: "2026-10-25T11:00:00Z" }],
    threads: [thread({ comments: [{ id: "C1", author: "jefo3", body: "?", createdAt: "2026-10-25T12:00:00Z" }] }), thread({ id: "T2", resolved: true })],
  };
  const newest = commentItems(withComments, true);
  assert.deepEqual(
    newest.items.map((item) => (item.type === "comment" ? item.comment.id : item.thread.id)),
    ["T1", "P1"],
  );
  assert.deepEqual(
    commentItems(withComments, false).items.map((item) => item.type),
    ["comment", "thread"],
  );
  assert.deepEqual(
    newest.resolved.map((entry) => entry.id),
    ["T2"],
  );
});

test("small words: repo, local work, branches, time, neighbours", () => {
  assert.equal(repoOf(pr.url), "acme/app");
  assert.equal(notInPrLine(2, 1), "2 files and 1 commit not in the PR yet");
  assert.equal(notInPrLine(0, 3), "3 commits not in the PR yet");
  assert.equal(notInPrLine(0, 0), "");
  assert.equal(agoLabel("2026-10-25T11:21:00Z", Date.parse("2026-10-25T12:00:00Z")), "39m ago");
  assert.equal(agoLabel("2026-10-25T12:00:00Z", Date.parse("2026-10-25T12:00:00Z")), "just now");
  assert.equal(middleTruncate("milagre/fix-shared-file-picker-error-aghp", 20), "milagre/fi…rror-aghp");
  assert.equal(ago("2026-10-25T10:00:00Z", Date.parse("2026-10-25T12:00:00Z")), "2h");
  const around = neighbours(pr.files, "src/a.ts");
  assert.equal(around.index, 1);
  assert.equal(around.previous?.path, "src/b.ts");
  assert.equal(around.next?.path, "README.md");
});
