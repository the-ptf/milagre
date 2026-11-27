import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequestList, PullRequestListItem } from "@milagre/shared/pull-request-list";

const STUDIO = "5b1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const OLD = "7c1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";

function item(number: number, patch: Partial<PullRequestListItem> = {}): PullRequestListItem {
  return {
    url: `https://github.com/acme/app/pull/${number}`,
    repo: "acme/app",
    number,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "ana", avatarUrl: null },
    headRefName: `feat/${number}`,
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    createdAt: "2026-11-20T10:00:00Z",
    updatedAt: "2026-11-20T10:00:00Z",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    reviewRequested: false,
    authored: true,
    labels: [],
    checks: { state: "pass", passed: 1, failed: 0, running: 0, skipped: 0, total: 1 },
    projects: [{ path: "/code/app", name: "app", cwd: "/code/app" }],
    chats: [],
    ...patch,
  };
}
const list = (items: PullRequestListItem[], errors: string[] = []): PullRequestList => ({ viewer: "ana", fetchedAt: 1, repos: ["acme/app"], items, errors });

type Pending = { state?: string; force?: boolean; resolve: (value: PullRequestList) => void; reject: (error: Error) => void };
const local: Pending[] = [];
const studio: Pending[] = [];
const old: Array<{ state?: string }> = [];
let computersChanged: (snapshot: { thisMac: string; computers: Array<{ id: string; state: string }> }) => void = () => {};
const reader =
  (queue: Pending[]) =>
  (request: { state?: string; force?: boolean } = {}) =>
    new Promise<PullRequestList>((resolve, reject) => queue.push({ ...request, resolve, reject }));

(globalThis as unknown as { window: unknown }).window = {
  addEventListener: () => {},
  milagre: {
    listPullRequests: reader(local),
    computers: {
      list: async () => ({
        thisMac: "here",
        computers: [
          { id: STUDIO, state: "online" },
          { id: OLD, state: "online" },
        ],
      }),
    },
    onComputersChanged: (callback: typeof computersChanged) => {
      computersChanged = callback;
      return () => {};
    },
    on: (id: string) =>
      id === OLD
        ? {
            listPullRequests: async (request: { state?: string }) => {
              old.push(request);
              throw new Error("Error invoking remote method 'pull-requests:list': Error: Not available on a remote computer");
            },
          }
        : { listPullRequests: reader(studio) },
  },
};

const { parsePullRequestPrefs, pullRequestsSnapshot, refreshPullRequests, setPullRequestListState, subscribePullRequests } = await import("./pull-requests.ts");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("every computer's PRs merge into one list, this computer first; stale and older hosts' answers drop out", async () => {
  const stop = subscribePullRequests(() => {});
  try {
    await settle();
    computersChanged({
      thisMac: "here",
      computers: [
        { id: STUDIO, state: "online" },
        { id: OLD, state: "online" },
      ],
    });
    await settle();
    assert.equal(local.length, 1);
    assert.equal(studio.length, 1);
    assert.equal(local[0]!.state, "open");
    assert.equal(pullRequestsSnapshot().loading, true);

    studio[0]!.resolve(list([item(1), item(2)]));
    local[0]!.resolve(list([item(1, { chats: [{ projectPath: "/code/app", chatId: 4, title: "Fix it" }] })], ["acme/web: gh: rate limited\nretry later"]));
    await settle();
    const first = pullRequestsSnapshot();
    assert.equal(first.loading, false);
    assert.deepEqual(
      first.rows.map((row) => [row.number, row.computerId, row.computerIds]),
      [
        [1, "local", ["local", STUDIO]],
        [2, STUDIO, [STUDIO]],
      ],
    );
    assert.deepEqual(first.rows[0]!.chats, [{ projectPath: "/code/app", chatId: 4, title: "Fix it", computerId: "local" }]);
    assert.deepEqual(first.errors, ["acme/web: gh: rate limited"], "Only the first line of a gh error, and nothing from the older host");
    assert.equal(first.byComputer[OLD]?.unsupported, true);
    const probes = old.length;

    refreshPullRequests({ force: true });
    setPullRequestListState("merged");
    await settle();
    assert.equal(local.at(-2)!.force, true);
    assert.equal(local.at(-1)!.state, "merged");
    assert.equal(old.length, probes, "A host without pull-requests:list isn't asked again until it reconnects");
    local.at(-2)!.resolve(list([item(9)]));
    await settle();
    assert.deepEqual(
      pullRequestsSnapshot().rows.map((row) => row.number),
      [],
      "The answer to the read that a newer one replaced is dropped, and the open rows go with the state change",
    );
    assert.equal(pullRequestsSnapshot().loading, true, "Switching state shows loading rows, not an empty list");
    local.at(-1)!.resolve(list([item(3, { state: "MERGED" })]));
    await settle();
    assert.deepEqual(
      pullRequestsSnapshot().rows.map((row) => row.number),
      [3],
    );
  } finally {
    stop();
    setPullRequestListState("open");
  }
});

test("an offline computer keeps its last rows, dimmed, and is read again when it comes back", async () => {
  const stop = subscribePullRequests(() => {});
  try {
    await settle();
    computersChanged({ thisMac: "here", computers: [{ id: STUDIO, state: "online" }] });
    await settle();
    local.at(-1)!.resolve(list([]));
    studio.at(-1)!.resolve(list([item(5)]));
    await settle();
    const reads = studio.length;
    computersChanged({ thisMac: "here", computers: [{ id: STUDIO, state: "offline" }] });
    assert.deepEqual(
      pullRequestsSnapshot().rows.map((row) => [row.number, row.offline]),
      [[5, true]],
    );
    refreshPullRequests();
    await settle();
    assert.equal(studio.length, reads, "An offline computer isn't asked");
    computersChanged({ thisMac: "here", computers: [{ id: STUDIO, state: "online" }] });
    await settle();
    assert.equal(studio.length, reads + 1);
    studio.at(-1)!.reject(new Error("gh: not logged in"));
    await settle();
    const after = pullRequestsSnapshot();
    assert.deepEqual(
      after.rows.map((row) => [row.number, row.offline]),
      [[5, false]],
      "A failed read keeps the last list",
    );
    assert.deepEqual(after.errors, ["gh: not logged in"]);
    computersChanged({ thisMac: "here", computers: [{ id: STUDIO, state: "off" }] });
    assert.deepEqual(pullRequestsSnapshot().rows, [], "A computer switched off drops out");
  } finally {
    stop();
  }
});

test("saved prefs keep what they know and fall back for anything else", () => {
  assert.deepEqual(parsePullRequestPrefs(null).filters.state, "open");
  assert.equal(parsePullRequestPrefs("{").sort, "updated");
  const prefs = parsePullRequestPrefs(
    JSON.stringify({ sort: "blocked", computer: STUDIO, filters: { state: "merged", draft: "only", review: "nope", author: "ana", label: "", project: 4 } }),
  );
  assert.equal(prefs.sort, "blocked");
  assert.equal(prefs.computer, STUDIO);
  assert.deepEqual(prefs.filters, {
    state: "merged",
    involvement: "all",
    author: "ana",
    label: null,
    draft: "only",
    review: "all",
    checks: "all",
    chat: "any",
    project: null,
  });
});
