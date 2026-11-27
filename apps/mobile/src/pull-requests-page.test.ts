import { test } from "node:test";
import assert from "node:assert/strict";
import { PULL_REQUEST_FILTER_DEFAULTS, type PullRequestList, type PullRequestListItem, type PullRequestRow } from "@milagre/shared/pull-request-list";
import { createPullRequestsStore, type PullRequestsHost } from "./pull-requests-store.ts";
import {
  PULL_REQUESTS_DEFAULTS,
  RESET_FILTERS,
  activeFilterCount,
  applyFilterChoice,
  mentionsUrl,
  pullRequestFilterGroups,
  reviewPrompt,
  reviewingUrls,
} from "./pull-requests-page.ts";

const item = (number: number, patch: Partial<PullRequestListItem> = {}): PullRequestListItem => ({
  url: `https://github.com/o/r/pull/${number}`,
  repo: "o/r",
  number,
  title: `PR ${number}`,
  state: "OPEN",
  isDraft: false,
  author: { login: "ana", avatarUrl: null },
  headRefName: "feat",
  baseRefName: "main",
  additions: 1,
  deletions: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  mergeable: null,
  reviewDecision: null,
  reviewRequested: false,
  authored: false,
  labels: [],
  checks: { state: "none", passed: 0, failed: 0, running: 0, skipped: 0, total: 0 },
  projects: [{ path: "/p", name: "p", cwd: "/p" }],
  chats: [],
  ...patch,
});
const list = (items: PullRequestListItem[], errors: string[] = []): PullRequestList => ({ viewer: "ana", fetchedAt: 0, repos: ["o/r"], items, errors });

function host(hostId: string, answer: () => Promise<unknown>, online = true): PullRequestsHost & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    hostId,
    online,
    calls,
    client: {
      call: async <T>(method: string, args: unknown[]) => {
        calls.push([method, ...args]);
        return (await answer()) as T;
      },
    },
  };
}

test("merges computers with the connected one first and passes state and force", async () => {
  const store = createPullRequestsStore();
  const here = host("here", async () => list([item(1)]));
  const there = host("there", async () => list([item(1), item(2)]));
  await store.read([here, there], "merged", true);
  assert.deepEqual(here.calls, [["pull-requests:list", { state: "merged", force: true }]]);
  const view = store.view(["here", "there"], "merged");
  assert.deepEqual(
    view.rows.map((row) => [row.number, row.computerId, row.computerIds]),
    [
      [1, "here", ["here", "there"]],
      [2, "there", ["there"]],
    ],
  );
  assert.equal(view.loaded, true);
  assert.equal(view.reading, false);
});

test("a state change shows nothing from the old state until that state is read", async () => {
  const store = createPullRequestsStore();
  const here = host("here", async () => list([item(1)]));
  await store.read([here], "open");
  const switching = store.view(["here"], "merged");
  assert.deepEqual(switching.rows, []);
  assert.equal(switching.loaded, false, "The page shows loading rows, not an empty list");
});

test("a computer that fails keeps its last list, marked offline, and an older one is left out", async () => {
  const store = createPullRequestsStore();
  let fail = false;
  const flaky = host("flaky", async () => {
    if (fail) throw new Error("socket closed");
    return list([item(3)]);
  });
  const old = host("old", async () => {
    throw new Error("Command is not available from mobile");
  });
  await store.read([flaky, old], "open");
  fail = true;
  await store.read([flaky, old], "open");
  const view = store.view(["flaky", "old"], "open");
  assert.deepEqual(
    view.rows.map((row) => [row.number, row.offline]),
    [[3, true]],
  );
  assert.equal(view.error, "");
  assert.equal(view.older, false);
  assert.equal(store.view(["old"], "open").older, true);
});

test("an unreachable computer dims what it had without calling it", async () => {
  const store = createPullRequestsStore();
  const box = host("box", async () => list([item(4)]));
  await store.read([box], "open");
  const asleep = { ...box, online: false };
  await store.read([asleep], "open");
  assert.equal(box.calls.length, 1);
  assert.equal(store.view(["box"], "open").rows[0]?.offline, true);
});

test("shows the first gh error, and a failure only when nothing loaded", async () => {
  const store = createPullRequestsStore();
  await store.read([host("a", async () => list([], ["gh: not logged in"])), host("b", async () => Promise.reject(new Error("timed out")))], "open");
  assert.equal(store.view(["a", "b"], "open").error, "gh: not logged in");
  const lone = createPullRequestsStore();
  await lone.read([host("b", async () => Promise.reject(new Error("timed out")))], "open");
  assert.equal(lone.view(["b"], "open").error, "timed out");
});

test("a slow answer from an earlier read never replaces a newer one", async () => {
  const store = createPullRequestsStore();
  let release: (value: unknown) => void = () => {};
  let first = true;
  const box = host("box", () => {
    if (!first) return Promise.resolve(list([item(6)]));
    first = false;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const slow = store.read([box], "open");
  await store.read([box], "open");
  release(list([item(5)]));
  await slow;
  assert.deepEqual(
    store.view(["box"], "open").rows.map((row) => row.number),
    [6],
  );
});

test("loaded waits for an answer for the state in view", async () => {
  const store = createPullRequestsStore();
  await store.read([host("a", async () => list([]))], "open");
  assert.equal(store.view(["a"], "open").loaded, true);
  assert.equal(store.view(["a"], "closed").loaded, false);
  assert.equal(store.view([], "closed").loaded, true);
});

const rows = [
  { ...item(1, { labels: [{ name: "bug", color: "f00" }], author: { login: "jo", avatarUrl: null } }), computerId: "a", computerIds: ["a"], offline: false },
] as unknown as PullRequestRow[];

test("filter groups check what is in use and offer the loaded values", () => {
  const groups = pullRequestFilterGroups(PULL_REQUESTS_DEFAULTS, rows);
  assert.deepEqual(
    groups.map((group) => group.title),
    ["State", "Involvement", "Author", "Labels", "Draft", "Review", "Checks", "Chat", "Project", "Sort"],
  );
  const state = groups[0]!;
  assert.equal(state.value, "Open");
  assert.deepEqual(
    state.choices.filter((choice) => choice.checked).map((choice) => choice.id),
    ["state:open"],
  );
  assert.deepEqual(
    groups[2]!.choices.map((choice) => [choice.id, choice.checked]),
    [
      ["any:author", true],
      ["author:jo", false],
    ],
  );
  assert.equal(groups.at(-1)!.value, "Recently updated");
});

test("choices change one filter, Any clears it, reset keeps the state", () => {
  let settings = applyFilterChoice(PULL_REQUESTS_DEFAULTS, "label:area:mobile");
  assert.equal(settings.filters.label, "area:mobile");
  settings = applyFilterChoice(settings, "checks:failing");
  settings = applyFilterChoice(settings, "state:merged");
  settings = applyFilterChoice(settings, "sort:largest");
  assert.equal(activeFilterCount(settings), 2);
  assert.equal(settings.sort, "largest");
  assert.equal(applyFilterChoice(settings, "any:label").filters.label, null);
  assert.equal(applyFilterChoice(settings, "checks:sideways"), settings);
  assert.equal(applyFilterChoice(settings, "sort:sideways"), settings);
  const reset = applyFilterChoice(settings, RESET_FILTERS);
  assert.deepEqual(reset.filters, { ...PULL_REQUEST_FILTER_DEFAULTS, state: "merged" });
  assert.equal(reset.sort, "largest");
});

test("the review prompt names the PR and forbids writing to GitHub", () => {
  const prompt = reviewPrompt({ url: "https://github.com/o/r/pull/7", repo: "o/r", number: 7, title: "Fix it" });
  assert.match(prompt, /^Review pull request https:\/\/github\.com\/o\/r\/pull\/7 \(o\/r#7: Fix it\)\./);
  assert.match(prompt, /Don't push, comment on GitHub, approve or merge\.$/);
});

test("an open task reviewing a PR marks only that PR", () => {
  const url = "https://github.com/o/r/pull/12";
  assert.equal(mentionsUrl(`Review pull request ${url} (o/r#12)`, url), true);
  assert.equal(mentionsUrl(`Review ${url}3 now`, url), false);
  assert.equal(mentionsUrl(`See ${url}/files`, url), false);
  assert.equal(mentionsUrl(`Review ${url}`, url), true);
  const other = "https://github.com/o/r/pull/9";
  const items = [
    { task: { prompt: `Review ${url}.` }, column: "running", kind: "chat" },
    { task: { prompt: `Review ${other}.` }, column: "done", kind: "chat" },
    { task: { prompt: `Review ${other}.` }, column: "needs", kind: "failed" },
  ];
  assert.deepEqual([...reviewingUrls([url, other], items)], [url]);
});
