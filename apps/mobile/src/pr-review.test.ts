import { test } from "node:test";
import assert from "node:assert/strict";
import type { PullRequestDetail, PullRequestThread, ReviewGuide } from "@milagre/shared/pull-request-review";
import { diffRows } from "./diff-rows.ts";
import {
  ago,
  attachThreads,
  blockerMessage,
  filesByFolder,
  guideRow,
  lineTarget,
  middleTruncate,
  neighbours,
  nextStop,
  reviewsSummary,
  splitDiffRows,
  threadMessage,
  threadsMessage,
  viewedCount,
  withResolved,
  withViewed,
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
    { path: "src/b.ts", additions: 1, deletions: 0, status: "added", viewed: "UNVIEWED" },
    { path: "src/a.ts", additions: 8, deletions: 2, status: "modified", viewed: "VIEWED" },
    { path: "README.md", additions: 1, deletions: 0, status: "modified", viewed: "DISMISSED" },
  ],
  threads: [thread()],
  comments: [],
  pendingReview: null,
};

const patch = ["@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three", ""].join("\n");

test("files group under their folders, and only VIEWED counts as viewed", () => {
  assert.deepEqual(
    filesByFolder(pr.files).map((group) => [group.folder, group.files.map((file) => file.path)]),
    [
      ["", ["README.md"]],
      ["src", ["src/a.ts", "src/b.ts"]],
    ],
  );
  assert.deepEqual(viewedCount(pr.files), { viewed: 1, total: 3 });
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

test("messages to the Chat carry the PR, the place and what was said", () => {
  const one = threadMessage(pr, thread());
  assert.match(one, /PR #673 \(https:\/\/github\.com\/acme\/app\/pull\/673\), on src\/a\.ts:2/);
  assert.match(one, /> Wait for the picker\?/);
  assert.match(threadsMessage(pr, [thread(), thread({ id: "T2", path: "b.ts", line: 9 })]), /the 2 open review threads/);
  const failing = blockerMessage(pr, { tone: "blocked", title: "Checks failing", detail: "" });
  assert.match(failing ?? "", /- lint \(https:\/\/ci\/lint\)/);
  assert.equal(blockerMessage(pr, { tone: "ready", title: "Ready to merge", detail: "" }), null);
});

test("optimistic writes change only their file or thread", () => {
  assert.equal(withViewed(pr, "src/b.ts", true).files[0]?.viewed, "VIEWED");
  assert.equal(withViewed(pr, "src/b.ts", true).files[1], pr.files[1]);
  assert.equal(withResolved(pr, "T1", true).threads[0]?.resolved, true);
});

test("the guide row starts, continues, waits or asks for a rewrite", () => {
  const guide: ReviewGuide = { headRefOid: pr.headRefOid, provider: "claude", writtenAt: "", stops: [], notCovered: [] };
  const stops = [1, 2, 3].map((n) => ({ title: `S${n}`, kind: "ui" as const, summary: "", excerpts: [], files: [], questions: [] }));
  assert.equal(guideRow(null, pr).action, "start");
  assert.equal(guideRow({ ok: true, guide: null, read: [], writing: true }, pr).action, "writing");
  assert.deepEqual(guideRow({ ok: true, guide: { ...guide, stops }, read: [0], writing: false }, pr), { action: "open", value: "1 of 3 read", stale: false });
  assert.equal(guideRow({ ok: true, guide: { ...guide, stops, headRefOid: "c".repeat(40) }, read: [], writing: false }, pr).stale, true);
  assert.equal(guideRow({ ok: false, message: "Sign in" }, pr).error, "Sign in");
  assert.equal(nextStop({ ...guide, stops }, [0, 1]), 2);
  assert.equal(nextStop({ ...guide, stops }, [0, 1, 2]), 0);
});

test("small words: reviews, branches, time, neighbours", () => {
  assert.equal(reviewsSummary({ ...pr, threads: [] }), "Approved by marcos");
  assert.equal(reviewsSummary(pr), "1 open thread");
  assert.equal(middleTruncate("milagre/fix-shared-file-picker-error-aghp", 20), "milagre/fi…rror-aghp");
  assert.equal(ago("2026-10-25T10:00:00Z", Date.parse("2026-10-25T12:00:00Z")), "2h");
  const around = neighbours(pr.files, "src/a.ts");
  assert.equal(around.index, 1);
  assert.equal(around.previous?.path, "src/b.ts");
  assert.equal(around.next?.path, "README.md");
});
