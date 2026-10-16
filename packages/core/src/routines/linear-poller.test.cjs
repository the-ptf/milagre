const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { LinearError } = require("../linear/errors.cjs");
const { createRoutineStore } = require("./store.cjs");
const { createLinearPoller } = require("./linear-poller.cjs");
const { POLL_ISSUES, POLL_ISSUES_RESUME, POLL_COMMENTS, ISSUE_HISTORY } = require("../linear/issues.cjs");

const START = Date.UTC(2026, 0, 5, 10, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const target = { kind: "new-chat", projectPath: "/p", workspace: "worktree" };

// A fake Linear that filters and pages as Linear does: issues by updatedAt > since, oldest first when sorted so; comments by
// since < createdAt <= until, in the order given (Linear can't sort them); an issue's whole history from `histories`.
// `errors` per workspace are thrown once each (a code, or { message, code, extensions }); `pageSize` is the fake's page
// length. Page cursors are offsets, or with `cursor: "id"` the last node's id, found again in the list as it is now (so an
// issue edited since a page was read moves, and a cursor whose node is gone fails). `notFound` holds issue ids Linear no
// longer finds. Every query is recorded.
const missing = (what) => Object.assign(new LinearError(`Entity not found: ${what}`, "failed"), { extensions: { type: "invalid input" } });

function fakeLinear() {
  const data = {
    issues: {},
    comments: {},
    histories: {},
    errors: {},
    workspaces: ["a", "b"],
    calls: [],
    pageSize: 50,
    hold: null,
    cursor: "offset",
    notFound: new Set(),
  };
  const page = (list, after) => {
    let from = after ? Number(after) : 0;
    if (data.cursor === "id" && after) {
      const index = list.findIndex((node) => node.id === after);
      if (index < 0) throw new LinearError("Invalid cursor", "failed");
      from = index + 1;
    }
    const nodes = list.slice(from, from + data.pageSize);
    const hasNextPage = from + data.pageSize < list.length;
    const endCursor = hasNextPage ? (data.cursor === "id" ? nodes.at(-1).id : String(from + data.pageSize)) : null;
    return { nodes, pageInfo: { hasNextPage, endCursor } };
  };
  return {
    data,
    enabled: () => true,
    workspaces: () => data.workspaces.map((id) => ({ id, viewer: { name: "Me", email: "me@x" }, organization: { name: id.toUpperCase() }, canWrite: true })),
    async query(workspace, document, variables) {
      data.calls.push({ workspace, document, variables });
      if (data.hold) await data.hold;
      const error = data.errors[workspace]?.shift();
      if (typeof error === "string") throw new LinearError(error, error);
      if (error) throw Object.assign(new LinearError(error.message, error.code), { extensions: error.extensions });
      if (document.includes("PollIssues")) {
        const since = Date.parse(variables.since);
        const all = data.issues[workspace] ?? [];
        const list = all.filter((item) => Date.parse(item.updatedAt) > since).sort((x, y) => Date.parse(x.updatedAt) - Date.parse(y.updatedAt));
        // Without the ascending sort Linear lists the newest first.
        if (!document.includes("updatedAt: { order: Ascending }")) list.reverse();
        const result = {};
        if (document.includes("anchor:")) {
          const anchor = all.find((item) => item.id === variables.anchor);
          if (!anchor || data.notFound.has(variables.anchor)) throw missing("Issue");
          result.anchor = { id: anchor.id, updatedAt: anchor.updatedAt };
        }
        return { ...result, issues: page(list, variables.after) };
      }
      if (document.includes("IssueHistory")) {
        if (data.notFound.has(variables.id)) throw missing("Issue");
        return { issue: { history: page(data.histories[variables.id] ?? [], variables.after) } };
      }
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

function setup({ linked = () => false, ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-poller-"));
  const clock = { t: START };
  let n = 0;
  const store = createRoutineStore({ file: path.join(dir, "routines.json"), now: () => clock.t, id: () => `id${++n}` });
  store.setEnabled(true);
  const linear = fakeLinear();
  const timers = fakeTimers();
  // What the store queued, every event handed to the scheduler (one entry per batch in `batches`), and those it hadn't
  // seen before (queued, or answered with a missed Run when the queue was full).
  const enqueued = [];
  const delivered = [];
  const fresh = [];
  const batches = [];
  const scheduler = {
    enqueueEvents(items) {
      batches.push(items.length);
      const results = store.enqueueMany(items);
      items.forEach((item, index) => {
        delivered.push(item);
        if (results[index].queued) enqueued.push(item);
        if (results[index].queued || results[index].reason === "full") fresh.push(item);
      });
      return results;
    },
    // Kept so an older poller still runs here; each call is a batch of one.
    enqueueEvent(routineId, event) {
      return scheduler.enqueueEvents([{ routineId, event }])[0];
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
    ...options,
  });
  const routine = (trigger, name = "r") =>
    store.create({ name, prompt: "Look at {{issue.key}}", trigger: { kind: "linear", workspace: "a", ...trigger }, target, createdBy: { kind: "user" } });
  // Polls `a` and returns the queries it made.
  const poll = async (workspace = "a") => {
    const from = linear.data.calls.length;
    await poller.pollNow(workspace);
    return linear.data.calls.slice(from);
  };
  return { store, clock, linear, timers, enqueued, delivered, fresh, batches, poller, routine, linkedCalls, poll, dir };
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
      let name = /^[A-Za-z_]\w*/.exec(document.slice(i))[0];
      i += name.length;
      space();
      if (document[i] === ":") {
        // An alias: the field's own name follows.
        i += 1;
        space();
        name = /^[A-Za-z_]\w*/.exec(document.slice(i))[0];
        i += name.length;
        space();
      }
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
  assert.equal(Math.round(complexity("{ x: a { b } }") * 10) / 10, 1.1);
  for (const [name, document] of Object.entries({ POLL_ISSUES, POLL_ISSUES_RESUME, POLL_COMMENTS, ISSUE_HISTORY })) {
    assert.equal(typeof document, "string", name);
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

test("issues past the request budget aren't lost: the next poll reads on from where the last one stopped", async () => {
  const ctx = setup({ requestBudget: 5 });
  ctx.routine({ event: "assigned" });
  ctx.linear.data.pageSize = 2;
  ctx.linear.data.issues.a = assignedIssues(13);
  ctx.clock.t = START + 600_000;
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  // Five pages of two.
  assert.equal(ctx.enqueued.length, 10);
  // Not saved until the read is done: a restart reads it again rather than skip what's left.
  assert.equal(ctx.store.linearCursor("a"), undefined);
  await ctx.poller.pollNow("a");
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    Array.from({ length: 13 }, (_, index) => `linear:i${index}:h${index}`),
  );
  assert.equal(ctx.store.linearCursor("a"), START + 130_000);
  ctx.poller.stop();
});

test("comments past the request budget aren't lost: the window is read on across polls, then queued and the comment cursor moves on", async () => {
  const ctx = setup({ linked: () => true, requestBudget: 3 });
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
  // With no issue Routine, issues aren't read at all.
  assert.equal(ctx.store.linearCursor("a"), undefined);
  assert.ok(!ctx.linear.data.calls.some((call) => call.document.includes("PollIssues")));
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
  ctx.routine({ event: "comment" }, "comments");
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

test("an issue history longer than the request budget is read on next poll, and the cursor waits for it", async () => {
  const ctx = setup({ requestBudget: 5 });
  ctx.routine({ event: "assigned" });
  ctx.linear.data.pageSize = 2;
  // Fourteen changes: the poll reads the issues and four pages of two, the match is on the seventh page.
  const whole = Array.from({ length: 14 }, (_, index) => ({
    id: `n${index}`,
    createdAt: iso(START + 1_000 + index),
    addedLabels: [],
    toAssignee: null,
    toState: null,
  }));
  whole[13] = assignedToMe("mine", START + 2_000);
  ctx.linear.data.histories["issue-1"] = whole;
  ctx.linear.data.issues.a = [issue({ updatedAt: iso(START + 3_000), history: { nodes: whole.slice(0, 2), pageInfo: { hasNextPage: true, endCursor: "2" } } })];
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.deepEqual(ctx.enqueued, []);
  assert.equal(ctx.store.linearCursor("a"), undefined, "the cursor doesn't pass an issue whose history wasn't all read");
  await ctx.poller.pollNow("a");
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    ["linear:issue-1:mine"],
  );
  assert.equal(ctx.store.linearCursor("a"), START + 3_000);
  ctx.poller.stop();
});

test("a bulk update with more than a page of issues sharing one updatedAt is read through, and the cursor moves past it", async () => {
  const ctx = setup({ requestBudget: 5 });
  ctx.routine({ event: "assigned" });
  ctx.linear.data.pageSize = 1;
  const at = START + 10_000;
  ctx.linear.data.issues.a = Array.from({ length: 12 }, (_, index) =>
    issue({
      id: `i${index}`,
      identifier: `MIL-${index}`,
      updatedAt: iso(at),
      history: { nodes: [assignedToMe(`h${index}`, at)], pageInfo: { hasNextPage: false } },
    }),
  );
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  await ctx.poller.pollNow("a");
  assert.equal(ctx.enqueued.length, 5);
  await ctx.poller.pollNow("a");
  assert.equal(ctx.enqueued.length, 10);
  await ctx.poller.pollNow("a");
  assert.equal(ctx.enqueued.length, 12);
  assert.equal(ctx.store.linearCursor("a"), at);
  const calls = ctx.linear.data.calls.length;
  await ctx.poller.pollNow("a");
  // The next read starts 5 s before the cursor and finds only what it already queued.
  assert.equal(ctx.enqueued.length, 12);
  assert.equal(ctx.linear.data.calls.slice(calls).find((call) => call.document.includes("PollIssues")).variables.since, iso(at - 5_000));
  ctx.poller.stop();
});

test("a dense burst of comments in one second is read forward across polls and every comment is queued once", async () => {
  const ctx = setup({ linked: () => true, requestBudget: 5 });
  ctx.routine({ event: "comment" });
  ctx.linear.data.pageSize = 2;
  const at = START + 10_000;
  ctx.linear.data.comments.a = Array.from({ length: 18 }, (_, index) => ({
    id: `c${index}`,
    body: "Hi",
    createdAt: iso(at),
    botActor: null,
    user: { name: "V" },
    issue: issue(),
  }));
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  const afters = [];
  for (let poll = 0; poll < 2; poll += 1) {
    const from = ctx.linear.data.calls.length;
    await ctx.poller.pollNow("a");
    afters.push(ctx.linear.data.calls.slice(from).find((call) => call.document.includes("PollComments")).variables.after);
    if (poll < 1) assert.equal(ctx.store.linearCursor("a:comments"), undefined, "no cursor move across unread pages");
  }
  // Each poll starts where the last stopped.
  assert.deepEqual(afters, [null, "10"]);
  // 18, under the store's 20-item queue cap.
  assert.equal(ctx.enqueued.length, 18);
  assert.equal(new Set(ctx.enqueued.map(({ event }) => event.key)).size, 18);
  // The cursor is the newest comment Linear sent, not the Mac's clock.
  assert.equal(ctx.store.linearCursor("a:comments"), at);
  ctx.poller.stop();
});

const comment = (id, at, issueNumber = 1, extra = {}) => ({
  id,
  body: "Hi",
  createdAt: iso(at),
  botActor: null,
  user: { name: "Victor" },
  issue: issue({ id: `issue-${issueNumber}`, identifier: `MIL-${issueNumber}` }),
  ...extra,
});
const byIssue = (items) => {
  const groups = new Map();
  for (const { event } of items) groups.set(event.issue.key, [...(groups.get(event.issue.key) ?? []), event.comment.createdAt]);
  return groups;
};

test("3000 comments are each handed over once, oldest first per issue, in batches no bigger than the 1000-event buffer", async (t) => {
  const ctx = setup({ linked: () => true });
  ctx.routine({ event: "comment" });
  const count = 3000;
  // Listed newest first, across seven issues.
  ctx.linear.data.comments.a = Array.from({ length: count }, (_, index) => comment(`c${index}`, START + 1_000 + index * 10, index % 7)).toReversed();
  ctx.clock.t = START + 1_000 + count * 10 + 1_000;
  ctx.poller.start();
  let polls = 0;
  for (; polls < 60 && ctx.fresh.length < count; polls += 1) {
    const calls = await ctx.poll();
    assert.ok(calls.length <= 40, `poll ${polls} made ${calls.length} requests`);
    ctx.clock.t += 60_000;
  }
  t.diagnostic(`${polls} polls, batches ${ctx.batches.join(" ")}`);
  assert.equal(ctx.fresh.length, count);
  assert.equal(new Set(ctx.fresh.map(({ event }) => event.key)).size, count);
  for (const [key, times] of byIssue(ctx.fresh)) {
    assert.deepEqual(
      times,
      times.toSorted((x, y) => x - y),
      `${key} oldest first`,
    );
  }
  assert.ok(Math.max(...ctx.batches) <= 1000, `largest batch ${Math.max(...ctx.batches)}`);
  assert.ok(ctx.batches.length < count / 10, "handed over in batches, not one by one");
  ctx.poller.stop();
});

test("one poll never makes more than its 40-request budget, and under a backlog issues and comments both move", async () => {
  const ctx = setup({ linked: () => true });
  ctx.routine({ event: "assigned" });
  ctx.routine({ event: "comment" }, "comments");
  ctx.linear.data.pageSize = 5;
  // 200 issues, each with a three-page history.
  ctx.linear.data.issues.a = Array.from({ length: 200 }, (_, index) => {
    const at = START + 10_000 + index * 100;
    const id = `i${index}`;
    const whole = Array.from({ length: 14 }, (_, n) => ({ id: `${id}-n${n}`, createdAt: iso(at - 50 + n), addedLabels: [], toAssignee: null, toState: null }));
    whole.push(assignedToMe(`${id}-mine`, at));
    ctx.linear.data.histories[id] = whole;
    return issue({
      id,
      identifier: `MIL-${index}`,
      updatedAt: iso(at),
      history: { nodes: whole.slice(0, 5), pageInfo: { hasNextPage: true, endCursor: "5" } },
    });
  });
  ctx.linear.data.comments.a = Array.from({ length: 150 }, (_, index) => comment(`c${index}`, START + 10_000 + index * 10, index % 3));
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  for (let poll = 0; poll < 3; poll += 1) {
    const calls = await ctx.poll();
    assert.ok(calls.length <= 40, `poll ${poll} made ${calls.length} requests`);
    ctx.clock.t += 60_000;
  }
  const kinds = new Set(ctx.delivered.map(({ event }) => event.change));
  assert.ok(kinds.has("assigned"), "issue changes came through");
  assert.ok(kinds.has("comment"), "comments came through");
  ctx.poller.stop();
});

test("a workspace with only comment Routines reads no issues, and one with only issue Routines reads no comments", async () => {
  const ctx = setup({ linked: () => true });
  ctx.routine({ event: "comment" });
  ctx.routine({ event: "assigned", workspace: "b" }, "on b");
  ctx.linear.data.issues.a = [issue({ history: { nodes: [assignedToMe("h1", START + 10_000)] } })];
  ctx.linear.data.comments.b = [comment("c1", START + 10_000)];
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  const onA = await ctx.poll("a");
  const onB = await ctx.poll("b");
  assert.deepEqual(
    onA.map((call) => call.document.match(/query (\w+)/)[1]),
    ["PollComments"],
  );
  assert.deepEqual(
    onB.map((call) => call.document.match(/query (\w+)/)[1]),
    ["PollIssues"],
  );
  ctx.poller.stop();
});

test("an issue no Routine's team filter takes never has its long history read", async () => {
  const ctx = setup();
  ctx.routine({ event: "assigned", team: "MIL" });
  ctx.linear.data.pageSize = 2;
  ctx.linear.data.histories["web-1"] = Array.from({ length: 6 }, (_, n) => assignedToMe(`w${n}`, START + 1_000 + n));
  ctx.linear.data.issues.a = [
    issue({ id: "web-1", identifier: "WEB-1", team: { key: "WEB" }, history: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "2" } } }),
  ];
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  const calls = await ctx.poll();
  assert.ok(!calls.some((call) => call.document.includes("IssueHistory")));
  ctx.poller.stop();
});

test("a Mac clock an hour ahead, then put right, never hides a comment made after it", async () => {
  const ctx = setup({ linked: () => true });
  ctx.routine({ event: "comment" });
  ctx.linear.data.comments.a = [comment("c1", START + 10_000)];
  ctx.clock.t = START + 60 * 60_000;
  ctx.poller.start();
  await ctx.poll();
  ctx.clock.t = START + 60_000;
  ctx.linear.data.comments.a.push(comment("c2", START + 30_000));
  await ctx.poll();
  await ctx.poll();
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    ["linear-comment:c1", "linear-comment:c2"],
  );
  ctx.poller.stop();
});

test("a saved cursor more than 5 minutes ahead of the clock is read as now minus the overlap", async () => {
  const ctx = setup({ linked: () => true });
  ctx.routine({ event: "assigned" });
  ctx.routine({ event: "comment" }, "comments");
  ctx.clock.t = START + 60_000;
  ctx.store.setLinearCursor("a", ctx.clock.t + 60 * 60_000);
  ctx.store.setLinearCursor("a:comments", ctx.clock.t + 60 * 60_000);
  ctx.poller.start();
  const calls = await ctx.poll();
  const since = (name) => calls.find((call) => call.document.includes(name)).variables.since;
  assert.equal(since("PollIssues"), iso(ctx.clock.t - 10_000));
  assert.equal(since("PollComments"), iso(ctx.clock.t - 10_000));
  ctx.poller.stop();
});

test("a linked-Chat lookup that fails holds the comment scan back, and the next poll delivers the comment once", async () => {
  let fail = true;
  const ctx = setup({
    linked: () => {
      if (fail) {
        fail = false;
        throw new Error("daemon busy");
      }
      return true;
    },
  });
  ctx.routine({ event: "comment" });
  ctx.routine({ event: "assigned" }, "assigned");
  ctx.linear.data.issues.a = [issue({ history: { nodes: [assignedToMe("h1", START + 10_000)] } })];
  ctx.linear.data.comments.a = [comment("c1", START + 10_000)];
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  await ctx.poll();
  // The issue scan went through; the comment wasn't dropped as unlinked and the comment cursor stayed put.
  assert.deepEqual(
    ctx.delivered.map(({ event }) => event.key),
    ["linear:issue-1:h1"],
  );
  assert.equal(ctx.store.linearCursor("a:comments"), undefined);
  await ctx.poll();
  await ctx.poll();
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key).filter((key) => key.startsWith("linear-comment")),
    ["linear-comment:c1"],
  );
  ctx.poller.stop();
});

test("three failed polls in a row say so on the workspace's Routines, without tokens or bodies, and a good poll clears it", async () => {
  const ctx = setup();
  const routine = ctx.routine({ event: "assigned" });
  const message = `Bad request with Bearer lin_oauth_secret123 ${"y".repeat(300)} {"query":"query PollIssues { issues { nodes { id } } }"}`;
  ctx.linear.data.errors.a = [1, 2, 3].map(() => ({ message, code: "failed" }));
  ctx.poller.start();
  await ctx.poll();
  await ctx.poll();
  assert.equal(ctx.store.get(routine.id).lastError, undefined, "two failures stay quiet");
  await ctx.poll();
  const error = ctx.store.get(routine.id).lastError;
  assert.ok(error.startsWith("Linear polling failed: Bad request"), error);
  assert.ok(error.length <= 200, `${error.length} characters`);
  assert.ok(!/lin_oauth|secret123|\{|query/.test(error), error);
  await ctx.poll();
  assert.equal(ctx.store.get(routine.id).lastError, undefined);
  ctx.poller.stop();
});

test("a long history held across polls whose issue is then deleted is dropped, and other issues keep coming", async () => {
  const ctx = setup({ requestBudget: 3 });
  ctx.routine({ event: "assigned" });
  ctx.linear.data.pageSize = 2;
  ctx.linear.data.histories["issue-1"] = Array.from({ length: 14 }, (_, n) => ({
    id: `n${n}`,
    createdAt: iso(START + 1_000 + n),
    addedLabels: [],
    toAssignee: null,
    toState: null,
  }));
  ctx.linear.data.issues.a = [issue({ updatedAt: iso(START + 3_000), history: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "2" } } })];
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  await ctx.poll();
  assert.equal(ctx.store.linearCursor("a"), undefined, "the history is held");
  ctx.linear.data.notFound.add("issue-1");
  ctx.linear.data.issues.a = [
    issue({ id: "issue-2", identifier: "MIL-2", updatedAt: iso(START + 40_000), history: { nodes: [assignedToMe("h2", START + 40_000)] } }),
  ];
  for (let poll = 0; poll < 3; poll += 1) await ctx.poll();
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    ["linear:issue-2:h2"],
  );
  assert.equal(ctx.store.linearCursor("a"), START + 40_000);
  ctx.poller.stop();
});

test("a held comment page cursor Linear stops taking is dropped after the failure, and the window is read again", async () => {
  const ctx = setup({ linked: () => true, requestBudget: 5 });
  ctx.routine({ event: "comment" });
  ctx.linear.data.pageSize = 2;
  ctx.linear.data.cursor = "id";
  ctx.linear.data.comments.a = Array.from({ length: 14 }, (_, index) => comment(`c${index}`, START + 1_000 + index * 1_000));
  ctx.clock.t = START + 60_000;
  ctx.poller.start();
  await ctx.poll();
  assert.deepEqual(ctx.enqueued, [], "the window isn't read through yet");
  // The node the held cursor points at goes away.
  ctx.linear.data.comments.a = ctx.linear.data.comments.a.filter((item) => item.id !== "c9");
  for (let poll = 0; poll < 6; poll += 1) await ctx.poll();
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    Array.from({ length: 14 }, (_, index) => `linear-comment:c${index}`).filter((key) => key !== "linear-comment:c9"),
  );
  assert.equal(ctx.store.linearCursor("a:comments"), START + 14_000);
  ctx.poller.stop();
});

// Linear's page cursor names a node, found again where that node sits now.
test("an issue scan held across polls starts over when the issue its cursor names was edited since, so nothing is skipped", async () => {
  const ctx = setup({ requestBudget: 5 });
  ctx.routine({ event: "assigned" });
  ctx.linear.data.pageSize = 2;
  ctx.linear.data.cursor = "id";
  ctx.linear.data.issues.a = assignedIssues(14);
  ctx.clock.t = START + 600_000;
  ctx.poller.start();
  await ctx.poll();
  assert.equal(ctx.enqueued.length, 10);
  // The cursor issue (the tenth) is edited, then the first is edited later still.
  const issues = ctx.linear.data.issues.a;
  issues[9] = { ...issues[9], updatedAt: iso(START + 200_000) };
  issues[0] = { ...issues[0], updatedAt: iso(START + 210_000) };
  for (let poll = 0; poll < 3; poll += 1) await ctx.poll();
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    Array.from({ length: 14 }, (_, index) => `linear:i${index}:h${index}`),
  );
  assert.equal(ctx.store.linearCursor("a"), START + 210_000);
  ctx.poller.stop();
});

test("an issue scan held across polls whose cursor issue was deleted starts over from that issue's time", async () => {
  const ctx = setup({ requestBudget: 5 });
  ctx.routine({ event: "assigned" });
  ctx.linear.data.pageSize = 2;
  ctx.linear.data.cursor = "id";
  ctx.linear.data.issues.a = assignedIssues(14);
  ctx.clock.t = START + 600_000;
  ctx.poller.start();
  await ctx.poll();
  ctx.linear.data.issues.a = ctx.linear.data.issues.a.filter((item) => item.id !== "i9");
  for (let poll = 0; poll < 3; poll += 1) await ctx.poll();
  assert.deepEqual(
    ctx.enqueued.map(({ event }) => event.key),
    Array.from({ length: 14 }, (_, index) => `linear:i${index}:h${index}`),
  );
  assert.equal(ctx.store.linearCursor("a"), START + 140_000);
  ctx.poller.stop();
});
