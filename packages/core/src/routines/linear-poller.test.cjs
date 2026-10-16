const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { LinearError } = require("../linear/errors.cjs");
const { createRoutineStore } = require("./store.cjs");
const { createLinearPoller } = require("./linear-poller.cjs");
const { POLL_ISSUES, POLL_COMMENTS, ISSUE_HISTORY } = require("../linear/issues.cjs");

const START = Date.UTC(2026, 0, 5, 10, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const target = { kind: "new-chat", projectPath: "/p", workspace: "worktree" };

// A fake Linear that filters and pages as Linear does: issues by updatedAt > since, oldest first when sorted so; comments by
// since < createdAt <= until, in the order given (Linear can't sort them); an issue's whole history from `histories`.
// `errors` per workspace are thrown once each; `pageSize` is the fake's page length. Every query is recorded.
function fakeLinear() {
  const data = { issues: {}, comments: {}, histories: {}, errors: {}, workspaces: ["a", "b"], calls: [], pageSize: 50, hold: null };
  const page = (list, after) => {
    const from = after ? Number(after) : 0;
    const nodes = list.slice(from, from + data.pageSize);
    const hasNextPage = from + data.pageSize < list.length;
    return { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? String(from + data.pageSize) : null } };
  };
  return {
    data,
    enabled: () => true,
    workspaces: () => data.workspaces.map((id) => ({ id, viewer: { name: "Me", email: "me@x" }, organization: { name: id.toUpperCase() }, canWrite: true })),
    async query(workspace, document, variables) {
      data.calls.push({ workspace, document, variables });
      if (data.hold) await data.hold;
      const error = data.errors[workspace]?.shift();
      if (error) throw new LinearError(error, error);
      if (document.includes("PollIssues")) {
        const since = Date.parse(variables.since);
        const list = (data.issues[workspace] ?? [])
          .filter((item) => Date.parse(item.updatedAt) > since)
          .sort((x, y) => Date.parse(x.updatedAt) - Date.parse(y.updatedAt));
        // Without the ascending sort Linear lists the newest first.
        if (!document.includes("updatedAt: { order: Ascending }")) list.reverse();
        return { issues: page(list, variables.after) };
      }
      if (document.includes("IssueHistory")) return { issue: { history: page(data.histories[variables.id] ?? [], variables.after) } };
      if (document.includes("PollComments")) {
        const [since, until] = [Date.parse(variables.since), Date.parse(variables.until)];
        const list = (data.comments[workspace] ?? []).filter((item) => Date.parse(item.createdAt) > since && Date.parse(item.createdAt) <= until);
        return { comments: page(list, variables.after) };
      }
      throw new Error(`unexpected query ${document}`);
    },
  };
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    // The pending poll timers (the 60 s rescan is the other kind; both are 60 s at rest).
    pending: () => timers.filter((timer) => !timer.cleared),
  };
}

function setup({ linked = () => false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-poller-"));
  const clock = { t: START };
  let n = 0;
  const store = createRoutineStore({ file: path.join(dir, "routines.json"), now: () => clock.t, id: () => `id${++n}` });
  store.setEnabled(true);
  const linear = fakeLinear();
  const timers = fakeTimers();
  const enqueued = [];
  const scheduler = {
    enqueueEvent(routineId, event) {
      const result = store.enqueue(routineId, event);
      if (result.queued) enqueued.push({ routineId, event });
      return result;
    },
  };
  const linkedCalls = [];
  const poller = createLinearPoller({
    linear,
    store,
    scheduler,
    linkedIssue: async (issue) => {
      linkedCalls.push(issue);
      return linked(issue);
    },
    now: () => clock.t,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const routine = (trigger, name = "r") =>
    store.create({ name, prompt: "Look at {{issue.key}}", trigger: { kind: "linear", workspace: "a", ...trigger }, target, createdBy: { kind: "user" } });
  return { store, clock, linear, timers, enqueued, poller, routine, linkedCalls };
}

const issue = (overrides = {}) => ({
  id: "issue-1",
  identifier: "MIL-1",
  title: "Fix it",
  description: "Steps",
  url: "https://linear.app/a/issue/MIL-1",
  state: { name: "Todo" },
  team: { key: "MIL" },
  assignee: { name: "Me" },
  labels: { nodes: [{ name: "agent" }] },
  updatedAt: iso(START + 20_000),
  history: { nodes: [] },
  ...overrides,
});
const labelAdded = (id, at, name = "agent") => ({ id, createdAt: iso(at), addedLabels: [{ name }], toAssignee: null, toState: null });
const assignedToMe = (id, at) => ({ id, createdAt: iso(at), addedLabels: [], toAssignee: { isMe: true }, toState: null });

test("one poll gives a label Routine and an assigned Routine one event each, and an overlapping poll gives none", async () => {
  const ctx = setup();
  const label = ctx.routine({ event: "label-added", label: "Agent" }, "label");
  const assigned = ctx.routine({ event: "assigned" }, "assigned");
  ctx.linear.data.issues.a = [issue({ history: { nodes: [labelAdded("h1", START + 10_000), assignedToMe("h2", START + 15_000)] } })];
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.deepEqual(
    ctx.enqueued.map(({ routineId, event }) => [routineId, event.key, event.change]),
    [
      [label.id, "linear:issue-1:h1", "label-added"],
      [assigned.id, "linear:issue-1:h2", "assigned"],
    ],
  );
  assert.deepEqual(ctx.enqueued[0].event.issue, {
    id: "issue-1",
    key: "MIL-1",
    title: "Fix it",
    description: "Steps",
    url: "https://linear.app/a/issue/MIL-1",
    labels: ["agent"],
    state: "Todo",
    team: "MIL",
    assignee: "Me",
    workspace: "a",
  });
  // The first query starts 5 s before the earliest Routine; the cursor is the newest change seen.
  assert.equal(ctx.linear.data.calls[0].variables.since, iso(START - 5_000));
  assert.equal(ctx.store.linearCursor("a"), START + 20_000);
  ctx.clock.t = START + 120_000;
  await ctx.poller.pollNow("a");
  assert.equal(ctx.enqueued.length, 2);
  // The next query overlaps the cursor by 5 s.
  assert.equal(ctx.linear.data.calls.findLast((call) => call.document.includes("PollIssues")).variables.since, iso(START + 15_000));
  ctx.poller.stop();
});

test("a team filter skips another team's issue", async () => {
  const ctx = setup();
  ctx.routine({ event: "assigned", team: "mil" });
  ctx.linear.data.issues.a = [
    issue({ id: "web-1", identifier: "WEB-1", team: { key: "WEB" }, history: { nodes: [assignedToMe("h1", START + 10_000)] } }),
    issue({ history: { nodes: [assignedToMe("h2", START + 10_000)] } }),
  ];
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    ["linear:issue-1:h2"],
  );
  ctx.poller.stop();
});

test("a bot's comment is skipped, my comment on a linked issue is queued, and one on an unlinked issue is dropped", async () => {
  const ctx = setup({ linked: ({ key }) => key === "MIL-1" });
  const comments = ctx.routine({ event: "comment" });
  ctx.clock.t = START + 60_000;
  const body = "x".repeat(9_000);
  ctx.linear.data.comments.a = [
    { id: "c1", body: "Deployed", createdAt: iso(START + 10_000), botActor: { type: "oauthClient" }, user: null, issue: issue() },
    { id: "c2", body, createdAt: iso(START + 11_000), botActor: null, user: { name: "Victor", displayName: "victor" }, issue: issue() },
    { id: "c3", body: "Hi", createdAt: iso(START + 12_000), botActor: null, user: { name: "Victor" }, issue: issue({ id: "issue-2", identifier: "MIL-2" }) },
  ];
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.equal(ctx.enqueued.length, 1);
  const { routineId, event } = ctx.enqueued[0];
  assert.equal(routineId, comments.id);
  assert.equal(event.key, "linear-comment:c2");
  assert.equal(event.change, "comment");
  assert.equal(event.issue.key, "MIL-1");
  assert.deepEqual({ ...event.comment, body: undefined }, { id: "c2", body: undefined, author: "victor", createdAt: START + 11_000 });
  // Long text is cut to 8 000 characters with an ellipsis.
  assert.equal(event.comment.body.length, 8_001);
  assert.ok(event.comment.body.endsWith("…"));
  assert.deepEqual(
    ctx.linkedCalls.map(({ key, workspace }) => `${workspace}:${key}`),
    ["a:MIL-1", "a:MIL-2"],
  );
  // The unlinked comment left no Run either.
  assert.deepEqual(ctx.store.runs(comments.id), []);
  ctx.poller.stop();
});

test("revoked stops one workspace and says sign-in is needed on its Routines; the other keeps polling", async () => {
  const ctx = setup();
  const onA = ctx.routine({ event: "assigned" }, "on a");
  const onB = ctx.routine({ event: "assigned", workspace: "b" }, "on b");
  ctx.linear.data.errors.a = ["revoked"];
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  await ctx.poller.pollNow("b");
  assert.equal(ctx.store.get(onA.id).lastError, "Linear sign-in needed");
  assert.equal(ctx.store.get(onB.id).lastError, undefined);
  const before = ctx.linear.data.calls.length;
  await ctx.poller.pollNow("a");
  assert.equal(ctx.linear.data.calls.length, before, "a stopped polling");
  await ctx.poller.pollNow("b");
  assert.ok(ctx.linear.data.calls.length > before, "b still polls");
  ctx.poller.stop();
});

test("a sign-in error clears on the next successful poll after signing in again", async () => {
  const ctx = setup();
  const onA = ctx.routine({ event: "assigned" });
  ctx.linear.data.errors.a = ["revoked"];
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.equal(ctx.store.get(onA.id).lastError, "Linear sign-in needed");
  // Revoked clears the token, so the workspace leaves the list; signing in again brings it back.
  ctx.linear.data.workspaces = ["b"];
  ctx.poller.sync();
  ctx.linear.data.workspaces = ["a", "b"];
  ctx.poller.sync();
  await ctx.poller.pollNow("a");
  assert.equal(ctx.store.get(onA.id).lastError, undefined);
  ctx.poller.stop();
});

test("rate-limited puts that workspace's next poll 120 s out, and success brings it back to 60 s", async () => {
  const ctx = setup();
  ctx.routine({ event: "assigned" });
  ctx.linear.data.errors.a = ["rate-limited"];
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.equal(ctx.timers.pending().at(-1).ms, 120_000);
  ctx.linear.data.errors.a = ["offline"];
  await ctx.poller.pollNow("a");
  assert.equal(ctx.timers.pending().at(-1).ms, 240_000);
  await ctx.poller.pollNow("a");
  assert.equal(ctx.timers.pending().at(-1).ms, 60_000);
  ctx.poller.stop();
  assert.deepEqual(ctx.timers.pending(), []);
});

test("an issue changed before the Routine was made isn't queued", async () => {
  const ctx = setup();
  ctx.clock.t = START + 30_000;
  ctx.routine({ event: "assigned" });
  ctx.linear.data.issues.a = [issue({ updatedAt: iso(START + 29_000), history: { nodes: [assignedToMe("old", START + 28_000)] } })];
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.deepEqual(ctx.enqueued, []);
  ctx.poller.stop();
});

test("only workspaces with an enabled Linear Routine poll, and only while Routines are on", async () => {
  const ctx = setup();
  const routine = ctx.routine({ event: "assigned" });
  ctx.poller.start();
  await ctx.poller.pollNow("b");
  assert.equal(ctx.linear.data.calls.length, 0);
  ctx.store.update(routine.id, { enabled: false });
  ctx.poller.sync();
  await ctx.poller.pollNow("a");
  assert.equal(ctx.linear.data.calls.length, 0);
  ctx.store.update(routine.id, { enabled: true });
  ctx.store.setEnabled(false);
  ctx.poller.sync();
  await ctx.poller.pollNow("a");
  assert.equal(ctx.linear.data.calls.length, 0);
  ctx.poller.stop();
});

test("a state Routine matches the new state by name, case-insensitively", async () => {
  const ctx = setup();
  ctx.routine({ event: "state", state: "in review" });
  ctx.linear.data.issues.a = [
    issue({
      history: {
        nodes: [
          { id: "h1", createdAt: iso(START + 5_000), addedLabels: [], toAssignee: null, toState: { name: "In Progress" } },
          { id: "h2", createdAt: iso(START + 6_000), addedLabels: [], toAssignee: null, toState: { name: "In Review" } },
        ],
      },
    }),
  ];
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    ["linear:issue-1:h2"],
  );
  ctx.poller.stop();
});

// Linear's documented query complexity (linear.app/developers/rate-limiting): an object costs 1, a property 0.1, and a
// connection multiplies its children's cost by its `first`. Arguments, braces and all, are skipped.
function complexity(document) {
  let i = document.indexOf("{");
  const space = () => {
    while (/\s/.test(document[i] ?? "")) i += 1;
  };
  function args() {
    const from = i;
    let depth = 0;
    do {
      if (document[i] === "(") depth += 1;
      else if (document[i] === ")") depth -= 1;
      i += 1;
    } while (depth > 0);
    return document.slice(from, i);
  }
  function selection() {
    i += 1; // {
    let cost = 0;
    for (;;) {
      space();
      if (document[i] === "}") {
        i += 1;
        return cost;
      }
      const name = /^[A-Za-z_]\w*/.exec(document.slice(i))[0];
      i += name.length;
      space();
      const given = document[i] === "(" ? args() : "";
      space();
      if (document[i] === "{") {
        const first = /first:\s*(\d+)/.exec(given);
        cost += (1 + selection()) * (first ? Number(first[1]) : 1);
      } else cost += 0.1;
    }
  }
  return selection();
}

test("each poll query stays well under Linear's 10 000-point complexity cap", (t) => {
  assert.equal(Math.round(complexity("{ a { b c } d(first: 2) { e } }") * 10) / 10, 3.4); // 1 + 0.2 + (1 + 0.1) × 2
  for (const [name, document] of Object.entries({ POLL_ISSUES, POLL_COMMENTS, ISSUE_HISTORY })) {
    const cost = complexity(document);
    t.diagnostic(`${name}: ${cost.toFixed(1)}`);
    assert.ok(cost < 5_000, `${name} costs ${cost}`);
  }
});

// `count` issues updated 10 s apart from START + 10 s, each with one change assigning me.
const assignedIssues = (count) =>
  Array.from({ length: count }, (_, index) => {
    const at = START + (index + 1) * 10_000;
    return issue({
      id: `i${index}`,
      identifier: `MIL-${index}`,
      updatedAt: iso(at),
      history: { nodes: [assignedToMe(`h${index}`, at)], pageInfo: { hasNextPage: false } },
    });
  });

test("issues past the page cap aren't lost: the cursor stops at the last issue read and the next poll goes on from there", async () => {
  const ctx = setup();
  ctx.routine({ event: "assigned" });
  ctx.linear.data.pageSize = 2;
  ctx.linear.data.issues.a = assignedIssues(13);
  ctx.clock.t = START + 600_000;
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  // Five pages of two.
  assert.equal(ctx.enqueued.length, 10);
  assert.equal(ctx.store.linearCursor("a"), START + 100_000);
  await ctx.poller.pollNow("a");
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    Array.from({ length: 13 }, (_, index) => `linear:i${index}:h${index}`),
  );
  assert.equal(ctx.store.linearCursor("a"), START + 130_000);
  ctx.poller.stop();
});

test("comments past the page cap aren't lost: the window narrows until it fits, and the comment cursor moves on", async () => {
  const ctx = setup({ linked: () => true });
  ctx.routine({ event: "comment" });
  ctx.linear.data.pageSize = 2;
  // Listed newest first: Linear's comment order isn't one the poller can rely on.
  ctx.linear.data.comments.a = Array.from({ length: 12 }, (_, index) => ({
    id: `c${index}`,
    body: "Hi",
    createdAt: iso(START + (index + 1) * 1_000),
    botActor: null,
    user: { name: "Victor" },
    issue: issue(),
  })).reverse();
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.equal(ctx.enqueued.length, 0, "a window cut short queues nothing");
  assert.equal(ctx.store.linearCursor("a:comments"), undefined);
  for (let poll = 0; poll < 30 && ctx.enqueued.length < 12; poll += 1) await ctx.poller.pollNow("a");
  assert.deepEqual(new Set(ctx.enqueued.map(({ event }) => event.key)), new Set(Array.from({ length: 12 }, (_, index) => `linear-comment:c${index}`)));
  assert.equal(ctx.enqueued.length, 12);
  // Each queued window was fully read, so they come in order.
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.comment.createdAt),
    ctx.enqueued.map(({ event }) => event.comment.createdAt).toSorted((x, y) => x - y),
  );
  // The issue cursor is its own.
  assert.equal(ctx.store.linearCursor("a"), START - 5_000);
  ctx.poller.stop();
});

for (const order of ["newest first", "oldest first"]) {
  test(`an issue whose history is longer than one page is read whole (${order}), changes before the window left out`, async () => {
    const ctx = setup();
    ctx.clock.t = START + 100_000;
    ctx.routine({ event: "assigned" });
    ctx.routine({ event: "label-added", label: "agent" }, "label");
    const whole = [
      assignedToMe("old", START + 50_000), // before the Routines
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `n${index}`,
        createdAt: iso(START + 101_000 + index),
        addedLabels: [],
        toAssignee: null,
        toState: null,
      })),
      labelAdded("label", START + 120_000),
      assignedToMe("mine", START + 121_000),
    ];
    const listed = order === "newest first" ? whole.toReversed() : whole;
    ctx.linear.data.pageSize = 5;
    ctx.linear.data.histories["issue-1"] = listed;
    ctx.linear.data.issues.a = [
      issue({ updatedAt: iso(START + 121_000), history: { nodes: listed.slice(0, 5), pageInfo: { hasNextPage: true, endCursor: "5" } } }),
    ];
    ctx.clock.t = START + 200_000;
    ctx.poller.start();
    await ctx.poller.pollNow("a");
    assert.deepEqual(
      ctx.enqueued.map(({ event }) => event.key),
      ["linear:issue-1:label", "linear:issue-1:mine"],
    );
    ctx.poller.stop();
  });
}

test("a poll never reaches back more than 24 hours", async () => {
  const ctx = setup();
  ctx.routine({ event: "assigned" });
  ctx.store.setLinearCursor("a", START + 1_000);
  ctx.clock.t = START + 3 * 24 * 60 * 60_000;
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  const dayAgo = iso(ctx.clock.t - 24 * 60 * 60_000);
  assert.equal(ctx.linear.data.calls.find((call) => call.document.includes("PollIssues")).variables.since, dayAgo);
  assert.equal(ctx.linear.data.calls.find((call) => call.document.includes("PollComments")).variables.since, dayAgo);
  ctx.poller.stop();
});

test("a poll still under way when polling stops queues nothing and moves no cursor", async () => {
  const ctx = setup();
  const routine = ctx.routine({ event: "assigned" });
  ctx.linear.data.issues.a = [issue({ history: { nodes: [assignedToMe("h1", START + 10_000)] } })];
  ctx.store.setLastError(routine.id, "Linear sign-in needed");
  let release;
  ctx.linear.data.hold = new Promise((resolve) => (release = resolve));
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  const polling = ctx.poller.pollNow("a");
  ctx.poller.stop();
  release();
  await polling;
  assert.deepEqual(ctx.enqueued, []);
  assert.equal(ctx.store.linearCursor("a"), undefined);
  assert.equal(ctx.store.get(routine.id).lastError, "Linear sign-in needed");
  assert.deepEqual(ctx.timers.pending(), []);
});
