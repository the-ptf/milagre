const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { LinearError } = require("../linear/errors.cjs");
const { createRoutineStore } = require("./store.cjs");
const { createLinearPoller } = require("./linear-poller.cjs");

const START = Date.UTC(2026, 0, 5, 10, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const target = { kind: "new-chat", projectPath: "/p", workspace: "worktree" };

// A fake Linear: `issues` and `comments` per workspace, `errors` per workspace (thrown once each), every query recorded.
function fakeLinear() {
  const data = { issues: {}, comments: {}, errors: {}, workspaces: ["a", "b"], calls: [] };
  return {
    data,
    enabled: () => true,
    workspaces: () => data.workspaces.map((id) => ({ id, viewer: { name: "Me", email: "me@x" }, organization: { name: id.toUpperCase() }, canWrite: true })),
    async query(workspace, document, variables) {
      data.calls.push({ workspace, document, variables });
      const error = data.errors[workspace]?.shift();
      if (error) throw new LinearError(error, error);
      if (document.includes("PollIssues")) return { issues: { nodes: data.issues[workspace] ?? [], pageInfo: { hasNextPage: false, endCursor: null } } };
      if (document.includes("PollComments")) return { comments: { nodes: data.comments[workspace] ?? [], pageInfo: { hasNextPage: false, endCursor: null } } };
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
  assert.equal(ctx.linear.data.calls.at(-1).variables.since, iso(START + 15_000));
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
