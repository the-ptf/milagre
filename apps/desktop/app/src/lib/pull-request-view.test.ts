import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequestThread, ReviewGuide } from "@milagre/shared/pull-request-review";
import { parsePatch } from "./diff-parse.ts";
import {
  age,
  checksFixMessage,
  guideStale,
  nextStop,
  openThreadCount,
  readMergeMethod,
  repoOf,
  saveMergeMethod,
  threadFixMessage,
  threadsByPath,
  threadsOnLine,
  unplacedThreads,
  viewedCount,
} from "./pull-request-view.ts";

const thread = (overrides: Partial<PullRequestThread> = {}): PullRequestThread => ({
  id: "T1",
  path: "src/a.ts",
  line: 2,
  side: "RIGHT",
  resolved: false,
  outdated: false,
  comments: [{ id: "C1", author: "jefo3", body: "Wait for the picker?", createdAt: "2026-10-25T10:00:00Z" }],
  ...overrides,
});

const PATCH = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n");

test("a thread sits on the line GitHub anchored it to, by side", () => {
  const lines = parsePatch(PATCH).flatMap((hunk) => hunk.lines);
  const right = thread();
  const left = thread({ id: "T2", side: "LEFT", line: 2 });
  const context = thread({ id: "T3", line: 3 });
  const placed = (line: (typeof lines)[number]) => threadsOnLine([right, left, context], line).map((entry) => entry.id);
  // " one" (1/1), "-two" (old 2), "+TWO" (new 2), " three" (3/3).
  assert.deepEqual(lines.map(placed), [[], ["T2"], ["T1"], ["T3"]]);
  assert.deepEqual(
    unplacedThreads([right, thread({ id: "T4", line: 40 }), thread({ id: "T5", line: null, outdated: true })], lines).map((entry) => entry.id),
    ["T4", "T5"],
  );
});

test("threadsByPath keeps a file's array while its threads stay the same", () => {
  const first = threadsByPath([thread(), thread({ id: "T9", path: "b.ts" })]);
  const second = threadsByPath([thread(), thread({ id: "T9", path: "b.ts", resolved: true })], first);
  assert.equal(second.get("src/a.ts"), first.get("src/a.ts"));
  assert.notEqual(second.get("b.ts"), first.get("b.ts"));
});

test("counts: open threads leave out resolved and draft ones, viewed counts files", () => {
  assert.equal(
    openThreadCount([
      thread(),
      thread({ id: "R", resolved: true }),
      thread({ id: "P", comments: [{ id: "x", author: "me", body: "draft", createdAt: "", pending: true }] }),
    ]),
    1,
  );
  assert.deepEqual(
    viewedCount({
      files: [
        { path: "a", additions: 1, deletions: 0, status: "added", viewed: "VIEWED" },
        { path: "b", additions: 1, deletions: 0, status: "added", viewed: "DISMISSED" },
      ],
    }),
    { viewed: 1, total: 2 },
  );
});

test("the merge method is remembered per repository", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  const url = "https://github.com/the-ptf/milagre/pull/673";
  assert.equal(repoOf(url), "the-ptf/milagre");
  assert.equal(readMergeMethod(url, storage), "squash");
  saveMergeMethod(url, "rebase", storage);
  assert.equal(readMergeMethod(url, storage), "rebase");
  assert.equal(readMergeMethod("https://github.com/other/repo/pull/1", storage), "squash");
});

test("Fix in Chat messages carry where and what", () => {
  const message = threadFixMessage({ number: 673 }, thread());
  assert.match(message, /PR #673, at src\/a\.ts:2/);
  assert.match(message, /jefo3 wrote:\n> Wait for the picker\?/);
  const checks = checksFixMessage({ number: 7 }, [
    { name: "unit", outcome: "pass" },
    { name: "lint", workflow: "CI", outcome: "fail", url: "https://ci/1" },
  ]);
  assert.match(checks, /- CI \/ lint \(https:\/\/ci\/1\)/);
  assert.doesNotMatch(checks, /unit/);
});

test("guide helpers: stale after a push, continue at the first unread stop", () => {
  const guide = { headRefOid: "a", provider: "claude", writtenAt: "", notCovered: [], stops: [{}, {}, {}] } as unknown as ReviewGuide;
  assert.equal(guideStale(guide, { headRefOid: "a" }), false);
  assert.equal(guideStale(guide, { headRefOid: "b" }), true);
  assert.equal(nextStop(guide, [0]), 1);
  assert.equal(nextStop(guide, [0, 1, 2]), 0);
});

test("age", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(age("2026-10-25T11:20:00Z", now), "40m");
  assert.equal(age("2026-10-25T10:00:00Z", now), "2h");
  assert.equal(age("2026-10-23T12:00:00Z", now), "2d");
  assert.equal(age("nope", now), "");
});
