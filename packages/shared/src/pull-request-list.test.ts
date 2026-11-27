import assert from "node:assert/strict";
import test from "node:test";
import {
  PULL_REQUEST_FILTER_DEFAULTS,
  activePullRequestFilters,
  filterPullRequests,
  groupPullRequests,
  mergePullRequestLists,
  parsePullRequestQuery,
  pullRequestChecksLabel,
  pullRequestChecksSummary,
  pullRequestFilterValues,
  pullRequestReviewBadge,
  sortPullRequests,
} from "./pull-request-list.mjs";
import type { PullRequestList, PullRequestListItem } from "./pull-request-list.d.mts";

const checks = (passed: number, failed = 0, running = 0, skipped = 0) => ({
  state: failed ? ("fail" as const) : running ? ("running" as const) : passed ? ("pass" as const) : ("none" as const),
  passed,
  failed,
  running,
  skipped,
  total: passed + failed + running + skipped,
});

function pr(number: number, change: Partial<PullRequestListItem> = {}): PullRequestListItem {
  return {
    url: `https://github.com/acme/web/pull/${number}`,
    repo: "acme/web",
    number,
    title: `Change ${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "dana", avatarUrl: null },
    headRefName: `branch-${number}`,
    baseRefName: "main",
    additions: 10,
    deletions: 2,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    reviewRequested: false,
    authored: false,
    labels: [],
    checks: checks(3),
    projects: [{ path: "/code/web", name: "web", cwd: "/code/web" }],
    chats: [],
    ...change,
  };
}

test("the search box reads GitHub-style terms and free words", () => {
  assert.deepEqual(parsePullRequestQuery('fix label:bug author:Dana repo:web is:draft "login"'), {
    words: ["fix", '"login"'],
    labels: ["bug"],
    authors: ["dana"],
    repos: ["web"],
    draft: true,
  });
  assert.equal(parsePullRequestQuery("-is:draft").draft, false);
  assert.deepEqual(parsePullRequestQuery('label:"needs review"').labels, ["needs review"]);
});

test("search matches title, number, author, labels and repo", () => {
  const items = [pr(1, { title: "Fix login", labels: [{ name: "bug", color: "d73a4a" }] }), pr(2, { author: { login: "lee", avatarUrl: null } })];
  assert.deepEqual(
    filterPullRequests(items, PULL_REQUEST_FILTER_DEFAULTS, "login").map((item) => item.number),
    [1],
  );
  assert.deepEqual(
    filterPullRequests(items, PULL_REQUEST_FILTER_DEFAULTS, "#2").map((item) => item.number),
    [2],
  );
  assert.deepEqual(
    filterPullRequests(items, PULL_REQUEST_FILTER_DEFAULTS, "label:bug").map((item) => item.number),
    [1],
  );
  assert.deepEqual(
    filterPullRequests(items, PULL_REQUEST_FILTER_DEFAULTS, "author:lee").map((item) => item.number),
    [2],
  );
  assert.equal(filterPullRequests(items, PULL_REQUEST_FILTER_DEFAULTS, "repo:other").length, 0);
});

test("filters narrow by involvement, checks, review, drafts, Chats and Project", () => {
  const items = [
    pr(1, { reviewRequested: true }),
    pr(2, { authored: true, isDraft: true, chats: [{ projectPath: "/code/web", chatId: 4, title: "Login" }] }),
    pr(3, { checks: checks(2, 1), reviewDecision: "CHANGES_REQUESTED" }),
    pr(4, { state: "MERGED", projects: [{ path: "/code/api", name: "api", cwd: "/code/api" }] }),
  ];
  const numbers = (change: Partial<typeof PULL_REQUEST_FILTER_DEFAULTS>) =>
    filterPullRequests(items, { ...PULL_REQUEST_FILTER_DEFAULTS, ...change }).map((item) => item.number);
  assert.deepEqual(numbers({}), [1, 2, 3]);
  assert.deepEqual(numbers({ state: "all" }), [1, 2, 3, 4]);
  assert.deepEqual(numbers({ state: "merged" }), [4]);
  assert.deepEqual(numbers({ involvement: "review" }), [1]);
  assert.deepEqual(numbers({ involvement: "authored" }), [2]);
  assert.deepEqual(numbers({ checks: "failing" }), [3]);
  assert.deepEqual(numbers({ review: "changes" }), [3]);
  assert.deepEqual(numbers({ draft: "hide" }), [1, 3]);
  assert.deepEqual(numbers({ draft: "only" }), [2]);
  assert.deepEqual(numbers({ chat: "chat" }), [2]);
  assert.deepEqual(numbers({ chat: "none" }), [1, 3]);
  assert.deepEqual(numbers({ state: "all", project: "/code/api" }), [4]);
  assert.equal(activePullRequestFilters({ ...PULL_REQUEST_FILTER_DEFAULTS, state: "all", chat: "chat", label: "bug" }), 2);
});

test("groups put review requests first, then yours, then the rest", () => {
  const groups = groupPullRequests([pr(1), pr(2, { authored: true }), pr(3, { reviewRequested: true, authored: true })]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((item) => item.number)]),
    [
      ["Review requested", [3]],
      ["Yours", [2]],
      ["Others", [1]],
    ],
  );
  assert.deepEqual(
    groupPullRequests([pr(1)]).map((group) => group.id),
    ["other"],
  );
});

test("sorts by update time, size, age, readiness and what blocks you", () => {
  const items = [
    pr(1, { updatedAt: "2026-11-03T00:00:00Z", additions: 500, createdAt: "2026-10-01T00:00:00Z", checks: checks(2, 1) }),
    pr(2, { updatedAt: "2026-11-05T00:00:00Z", additions: 1, createdAt: "2026-11-01T00:00:00Z", reviewRequested: true }),
    pr(3, { updatedAt: "2026-11-04T00:00:00Z", additions: 50, createdAt: "2026-10-15T00:00:00Z", reviewDecision: "APPROVED" }),
  ];
  const order = (sort: Parameters<typeof sortPullRequests>[1]) => sortPullRequests(items, sort).map((item) => item.number);
  assert.deepEqual(order("updated"), [2, 3, 1]);
  assert.deepEqual(order("largest"), [1, 3, 2]);
  assert.deepEqual(order("smallest"), [2, 3, 1]);
  assert.deepEqual(order("newest"), [2, 3, 1]);
  assert.deepEqual(order("oldest"), [1, 3, 2]);
  assert.deepEqual(order("readiness"), [2, 3, 1]);
  assert.deepEqual(order("blocked")[0], 2);
});

test("checks read as passed over counted, or failures first", () => {
  assert.equal(pullRequestChecksLabel(checks(9)), "9/9");
  assert.equal(pullRequestChecksLabel(checks(4, 0, 5)), "4/9");
  assert.equal(pullRequestChecksLabel(checks(7, 2)), "2 failed");
  assert.equal(pullRequestChecksLabel(checks(6, 0, 0, 3)), "6/6");
  assert.equal(pullRequestChecksLabel(checks(0)), "");
  assert.equal(pullRequestChecksSummary(checks(6, 1, 2, 3)), "1 failed · 2 running · 6 passed · 3 skipped");
});

test("the review badge follows state, draft and review decision", () => {
  assert.equal(pullRequestReviewBadge(pr(1, { state: "MERGED" })).label, "Merged");
  assert.equal(pullRequestReviewBadge(pr(1, { isDraft: true, reviewDecision: "APPROVED" })).label, "Draft");
  assert.equal(pullRequestReviewBadge(pr(1, { reviewDecision: "CHANGES_REQUESTED" })).tone, "red");
  assert.equal(pullRequestReviewBadge(pr(1)).label, "No review");
});

test("filter menus offer the authors, labels and Projects loaded", () => {
  const values = pullRequestFilterValues([
    pr(1, { labels: [{ name: "ui", color: "fff" }], author: { login: "zed", avatarUrl: null } }),
    pr(2, { labels: [{ name: "bug", color: "fff" }] }),
  ]);
  assert.deepEqual(values.authors, ["dana", "zed"]);
  assert.deepEqual(values.labels, ["bug", "ui"]);
  assert.deepEqual(values.projects, [{ path: "/code/web", name: "web" }]);
});

test("a PR two computers see shows once, from an online computer, with both computers' Projects and Chats", () => {
  const list = (items: PullRequestListItem[]): PullRequestList => ({ viewer: "dana", fetchedAt: 1, repos: ["acme/web"], items, errors: [] });
  const merged = mergePullRequestLists([
    { computerId: "studio", list: list([pr(1, { title: "old copy", projects: [{ path: "/s/web", name: "web", cwd: "/s/web" }] })]), offline: true },
    { computerId: "local", list: list([pr(1, { chats: [{ projectPath: "/code/web", chatId: 2, title: "Login" }] }), pr(2)]) },
    { computerId: "mbp", list: null },
  ]);
  assert.equal(merged.length, 2);
  const first = merged.find((item) => item.number === 1)!;
  assert.equal(first.computerId, "local");
  assert.equal(first.offline, false);
  assert.equal(first.title, "Change 1");
  assert.deepEqual(first.computerIds, ["local", "studio"]);
  assert.deepEqual(
    first.projects.map((project) => [project.computerId, project.path]),
    [
      ["local", "/code/web"],
      ["studio", "/s/web"],
    ],
  );
  assert.deepEqual(first.chats, [{ projectPath: "/code/web", chatId: 2, title: "Login", computerId: "local" }]);
});
