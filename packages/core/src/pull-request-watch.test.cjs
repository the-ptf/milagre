const test = require("node:test");
const assert = require("node:assert/strict");
const { createPullRequestWatch, queries, RUNNING_MS, SHOWN_MS, IDLE_MS, LEASE_MS, FORGET_MS } = require("./pull-request-watch.cjs");

const node = (number, state = "OPEN", rollup = "SUCCESS") => ({
  number,
  url: `https://github.com/example/project/pull/${number}`,
  state,
  title: `PR ${number}`,
  isDraft: false,
  reviewDecision: null,
  mergeStateStatus: "BLOCKED",
  commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { state: rollup } : null } }] },
});

// A clock and timers the test moves by hand.
function clock() {
  let at = 1_000_000;
  const pending = new Set();
  const timers = {
    setTimeout(fn, ms) {
      const timer = { fn, due: at + ms };
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      pending.delete(timer);
    },
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** Moves the clock `ms` forward, running each timer as it comes due. */
  async function advance(ms) {
    const end = at + ms;
    for (;;) {
      await settle();
      const next = [...pending].filter((timer) => timer.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      at = Math.max(at, next.due);
      pending.delete(next);
      next.fn();
    }
    at = end;
    await settle();
  }
  return { now: () => at, timers, advance, settle };
}

// GitHub as a fake gh: `branches` maps a branch to its latest PR node, `numbers` a PR number to its node.
function github({ branches = {}, numbers = {}, remote = {}, rate = { remaining: 5000, limit: 5000 } } = {}) {
  const calls = [];
  let failing = false;
  const exec = async (command, args, options) => {
    assert.equal(command, "gh");
    const query = args[args.indexOf("-f") + 1].slice("query=".length);
    calls.push({ query, cwd: options.cwd });
    if (failing) throw Object.assign(new Error("timeout"), { stdout: "" });
    const repository = { id: "R" };
    const data = { rateLimit: { ...rate, resetAt: new Date(2_000_000).toISOString() }, repository };
    const errors = [];
    for (const [, alias, branch] of query.matchAll(/(a\d+): pullRequests\(headRefName: ("(?:[^"\\]|\\.)*")/g))
      repository[alias] = { nodes: branches[JSON.parse(branch)] ? [branches[JSON.parse(branch)]] : [] };
    for (const [, alias, number] of query.matchAll(/(a\d+): pullRequest\(number: (\d+)\)/g)) {
      repository[alias] = numbers[number] ?? null;
      if (!numbers[number]) errors.push({ type: "NOT_FOUND", message: `Could not resolve to a PullRequest with the number of ${number}.` });
    }
    for (const [, alias, owner, name, number] of query.matchAll(/(a\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g))
      data[alias] = { pullRequest: remote[`${owner}/${name}#${number}`] ?? null };
    const stdout = JSON.stringify({ data, ...(errors.length && { errors }) });
    if (errors.length) throw Object.assign(new Error(errors[0].message), { stdout });
    return { stdout };
  };
  return { exec, calls, fail: (on) => (failing = on) };
}

function setup({ heads = {}, repos = {}, ...gh } = {}) {
  const time = clock();
  const hub = github(gh);
  const changes = [];
  const gitCalls = [];
  const git = {
    commonDir: async (path) => {
      if (repos[path] === null) throw new Error("not a git repository");
      return repos[path] ?? "/repo/.git";
    },
    out: async (path, args) => {
      gitCalls.push([path, ...args]);
      return heads[path] ?? null;
    },
  };
  const watch = createPullRequestWatch({ exec: hub.exec, git, now: time.now, timers: time.timers, onChange: (paths) => changes.push(paths.sort()) });
  return { watch, hub, time, changes, gitCalls };
}

test("one query answers every Worktree's branch and the Chats' PRs; a second read answers from it", async () => {
  const { watch, hub, time } = setup({
    heads: { "/a": "feature/a", "/b": "feature/b", "/c": "feature/c" },
    branches: { "feature/a": node(1), "feature/b": node(2, "MERGED"), "feature/c": node(3, "CLOSED") },
    numbers: { 7: node(7) },
    remote: { "other/lib#4": node(4) },
  });
  const read = Promise.all([
    watch.branch("/a"),
    watch.branch("/b"),
    watch.branch("/c"),
    watch.refs("/a", ["7", "https://github.com/other/lib/pull/4", "9", "--flag"]),
  ]);
  await time.advance(100);
  const [a, b, c, refs] = await read;
  assert.equal(a.number, 1);
  assert.equal(b.state, "MERGED");
  assert.equal(c.state, "CLOSED", "a closed latest PR shows as closed, as the per-branch gh query reads it");
  assert.deepEqual(
    refs.map((pr) => pr?.number ?? null),
    [7, 4, null, null],
  );
  assert.equal(hub.calls.length, 1);
  assert.equal(await watch.branch("/a"), a);
  assert.equal(hub.calls.length, 1, "a read with a value never asks GitHub");
  watch.close();
});

test("a detached HEAD and a folder outside Git have no PR, without asking GitHub", async () => {
  const { watch, hub, time } = setup({ heads: { "/a": null }, repos: { "/plain": null } });
  const read = Promise.all([watch.branch("/a"), watch.branch("/plain")]);
  await time.advance(100);
  assert.deepEqual(await read, [null, null]);
  assert.equal(hub.calls.length, 0);
  watch.close();
});

test("more than 25 reads split into several documents", () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ kind: "branch", branch: `b${index}`, alias: `a${index}` }));
  const documents = queries(items);
  assert.deepEqual(
    documents.map((document) => document.items.length),
    [25, 5],
  );
  assert.match(documents[1].query, /a29: pullRequests\(headRefName: "b29"/);
});

test("a branch name is quoted as a GraphQL string", () => {
  const [document] = queries([{ kind: "branch", branch: 'we"ird\\name', alias: "a0" }]);
  assert.match(document.query, /headRefName: "we\\"ird\\\\name"/);
});

test("a snapshot answers at once, reads what it lacks, and reports it through onChange", async () => {
  const { watch, time, changes } = setup({ heads: { "/a": "feature/a" }, branches: { "feature/a": node(1) }, numbers: { 5: node(5) } });
  const first = watch.snapshot([{ path: "/a", refs: ["5"] }]);
  assert.deepEqual(first, { worktrees: {}, chats: {}, pending: true });
  await time.advance(100);
  assert.deepEqual(changes, [["/a"]]);
  const second = watch.snapshot([{ path: "/a", refs: ["5"] }]);
  assert.equal(second.pending, false);
  assert.equal(second.worktrees["/a"].number, 1);
  assert.equal(second.chats["/a"]["5"].number, 5);
  watch.close();
});

test("polls on the cadence: running checks fast, a shown Worktree each minute, an unwatched one every five", async () => {
  const branches = { "feature/a": node(1, "OPEN", "PENDING") };
  const { watch, hub, time, changes } = setup({ heads: { "/a": "feature/a" }, branches });
  const read = watch.branch("/a");
  await time.advance(100);
  assert.equal((await read).checks, "running");
  await time.advance(RUNNING_MS + 5000);
  assert.equal(hub.calls.length, 2, "read again within RUNNING_MS while its checks run");
  branches["feature/a"] = node(1, "OPEN", "SUCCESS");
  await time.advance(RUNNING_MS + 5000);
  assert.equal(hub.calls.length, 3);
  assert.equal(changes.length, 2, "the first read and the checks finishing; unchanged reads say nothing");
  await time.advance(SHOWN_MS - 10_000);
  assert.equal(hub.calls.length, 3, "checks done: no read before SHOWN_MS");
  await time.advance(LEASE_MS);
  const lapsed = hub.calls.length;
  await time.advance(SHOWN_MS * 2);
  assert.equal(hub.calls.length, lapsed, "nobody asked for LEASE_MS: the minute cadence stops");
  await time.advance(IDLE_MS);
  assert.equal(hub.calls.length, lapsed + 1, "the idle cadence");
  watch.close();
});

test("a poke reads again within a second; a client asking again brings an idle repository back to the minute", async () => {
  const { watch, hub, time } = setup({ heads: { "/a": "feature/a" }, branches: { "feature/a": node(1) } });
  const read = watch.branch("/a");
  await time.advance(100);
  await read;
  watch.poke("/a");
  await time.advance(1000);
  assert.equal(hub.calls.length, 2);
  watch.poke("/unknown");
  await time.advance(LEASE_MS + SHOWN_MS);
  const idle = hub.calls.length;
  await watch.branch("/a");
  await time.advance(SHOWN_MS + 5000);
  assert.equal(hub.calls.length, idle + 1);
  watch.close();
});

test("a failed read keeps the last answer and backs off; a first read that fails settles as null", async () => {
  const { watch, hub, time } = setup({ heads: { "/a": "feature/a", "/b": "feature/b" }, branches: { "feature/a": node(1) } });
  const read = watch.branch("/a");
  await time.advance(100);
  assert.equal((await read).number, 1);
  hub.fail(true);
  const before = hub.calls.length;
  const second = watch.branch("/b");
  await time.advance(100);
  assert.equal(await second, null, "GitHub didn't answer: no PR known yet");
  assert.equal((await watch.branch("/a")).number, 1, "the last answer stays");
  assert.ok(hub.calls.length > before);
  const failed = hub.calls.length;
  await time.advance(25_000);
  assert.equal(hub.calls.length, failed, "waits BACKOFF_MS after a failure");
  await time.advance(10_000);
  assert.equal(hub.calls.length, failed + 1);
  watch.close();
});

test("a merged PR a Chat named is not asked for again", async () => {
  const { watch, hub, time } = setup({ heads: { "/a": null }, numbers: { 5: node(5, "MERGED"), 6: node(6) } });
  const read = watch.refs("/a", ["5", "6"]);
  await time.advance(100);
  await read;
  watch.poke("/a");
  await time.advance(1000);
  assert.equal(hub.calls.length, 2);
  assert.doesNotMatch(hub.calls[1].query, /number: 5\b/);
  assert.match(hub.calls[1].query, /number: 6\b/);
  assert.equal((await watch.refs("/a", ["5"]))[0].state, "MERGED");
  watch.close();
});

test("low quota pauses background polling until GitHub resets it", async () => {
  const { watch, hub, time } = setup({
    heads: { "/a": "feature/a" },
    branches: { "feature/a": node(1, "OPEN", "PENDING") },
    rate: { remaining: 100, limit: 5000 },
  });
  const read = watch.branch("/a");
  await time.advance(100);
  await read;
  await time.advance(RUNNING_MS * 3);
  assert.equal(hub.calls.length, 1);
  watch.close();
});

test("a Worktree nobody asked about for FORGET_MS is dropped", async () => {
  const { watch, hub, time, gitCalls } = setup({ heads: { "/a": "feature/a" }, branches: { "feature/a": node(1) } });
  const read = watch.branch("/a");
  await time.advance(100);
  await read;
  await time.advance(FORGET_MS + IDLE_MS * 2);
  const calls = hub.calls.length;
  const reads = gitCalls.length;
  await time.advance(IDLE_MS * 3);
  assert.equal(hub.calls.length, calls);
  assert.equal(gitCalls.length, reads);
  watch.close();
});
