const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRoutineStore } = require("./store.cjs");
const { createPullRequestPoller } = require("./pr-poller.cjs");

const START = Date.UTC(2026, 0, 5, 10, 0, 0);
const MINUTE = 60_000;

const snapshot = (patch = {}) => ({
  state: "OPEN",
  isDraft: false,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  headRef: "feature",
  headOid: "a1",
  baseRef: "main",
  behindBy: 0,
  failingChecks: [],
  pendingChecks: 0,
  totalChecks: 0,
  comments: [],
  unresolvedThreads: [],
  ...patch,
});
const comment = (id, body = "please rename this") => ({ id, body, author: "alice", threadId: null });

function fakeTimers() {
  const timers = [];
  return {
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    pending: () => timers.filter((timer) => !timer.cleared),
  };
}

function setup({ file, settings = {}, enabled = true } = {}) {
  const dir = file ? path.dirname(file) : fs.mkdtempSync(path.join(os.tmpdir(), "pr-poller-"));
  file ??= path.join(dir, "routines.json");
  const clock = { t: START };
  let n = 0;
  const store = createRoutineStore({ file, now: () => clock.t, id: () => `id${++n}` });
  if (enabled) store.setEnabled(true);
  const timers = fakeTimers();
  const world = { next: snapshot(), error: null, reads: [] };
  const delivered = [];
  const scheduler = {
    enqueueEvents(items) {
      const results = store.enqueueMany(items);
      delivered.push(...items);
      return results;
    },
  };
  const changes = [];
  const poller = createPullRequestPoller({
    store,
    scheduler,
    read: async (pr) => {
      world.reads.push(pr);
      if (world.error) throw world.error;
      return structuredClone(world.next);
    },
    onChange: () => changes.push(clock.t),
    now: () => clock.t,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const routine = () =>
    store.list().find((item) => item.trigger.kind === "pull-request") ??
    store.create({
      name: "Babysit PR #7",
      prompt: "babysit",
      trigger: { kind: "pull-request", url: "https://github.com/acme/app/pull/7", repo: "github.com/acme/app", number: 7, settings },
      target: { kind: "chat", chatId: "c1" },
      createdBy: { kind: "user" },
    });
  const poll = async () => {
    const id = routine().id;
    await poller.pollNow(id);
  };
  return { store, clock, timers, world, delivered, changes, poller, routine, poll, file };
}

// A Run of the Routine that has started and ended now.
function finishedRun(ctx, routine) {
  const { run } = ctx.store.startRun(routine.id, ctx.clock.t);
  ctx.store.finishRun(run.id, { status: "acted" });
}

test("quiet PR enqueues nothing", async () => {
  const ctx = setup();
  ctx.routine();
  ctx.poller.start();
  await ctx.poll();
  await ctx.poll();
  assert.deepEqual(ctx.delivered, []);
  assert.equal(ctx.world.reads.length, 2);
  assert.deepEqual(ctx.world.reads[0].repo, "github.com/acme/app");
  assert.equal(ctx.world.reads[0].number, 7);
});

test("a timer is kept per live Routine at its interval, and dropped with it", async () => {
  const ctx = setup({ settings: { intervalMinutes: 5 } });
  const routine = ctx.routine();
  ctx.poller.start();
  assert.deepEqual(
    ctx.timers.pending().map((timer) => timer.ms),
    [0],
  );
  await ctx.poll();
  assert.deepEqual(
    ctx.timers.pending().map((timer) => timer.ms),
    [5 * MINUTE],
  );
  ctx.store.complete(routine.id);
  ctx.poller.sync();
  assert.deepEqual(ctx.timers.pending(), []);
});

test("new comment enqueues one event", async () => {
  const ctx = setup();
  const routine = ctx.routine();
  ctx.poller.start();
  await ctx.poll();
  ctx.world.next = snapshot({ comments: [comment("c1", "Looks off")] });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);
  const { routineId, event, at } = ctx.delivered[0];
  assert.equal(routineId, routine.id);
  assert.equal(at, ctx.clock.t);
  assert.equal(event.kind, "pull-request");
  assert.match(event.key, /^pr:github\.com\/acme\/app#7:[0-9a-f]{40}$/);
  assert.equal(event.branch, "feature");
  assert.deepEqual(event.changes, [{ id: "comment:c1", text: "Review comment from @alice: Looks off" }]);
  assert.equal(event.summary, "Review comment from @alice: Looks off");
  // The same state again changes nothing.
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);
  assert.equal(ctx.store.list()[0].lastError, undefined);
});

test("merged PR completes the routine", async () => {
  const ctx = setup();
  const routine = ctx.routine();
  ctx.poller.start();
  await ctx.poll();
  ctx.world.next = snapshot({ state: "MERGED" });
  await ctx.poll();
  assert.ok(ctx.store.get(routine.id).completedAt);
  assert.deepEqual(ctx.delivered, []);
  assert.deepEqual(ctx.timers.pending(), []);
  assert.ok(ctx.changes.length > 0);
});

test("read failure sets lastError and backs off", async () => {
  const ctx = setup();
  const routine = ctx.routine();
  ctx.poller.start();
  ctx.world.error = new Error("GitHub didn't answer.");
  await ctx.poll();
  assert.equal(ctx.store.get(routine.id).lastError, "GitHub didn't answer.");
  assert.equal(ctx.timers.pending().at(-1).ms, 2 * MINUTE);
  await ctx.poll();
  assert.equal(ctx.timers.pending().at(-1).ms, 4 * MINUTE);
  for (let i = 0; i < 6; i += 1) await ctx.poll();
  assert.equal(ctx.timers.pending().at(-1).ms, 15 * MINUTE);
  ctx.world.error = null;
  await ctx.poll();
  assert.equal(ctx.store.get(routine.id).lastError, undefined);
  assert.equal(ctx.timers.pending().at(-1).ms, MINUTE);
});

test("restart reuses stored snapshot", async () => {
  const failing = snapshot({ failingChecks: ["lint"] });
  // Without a stored reading, the failing check is news.
  const cold = setup();
  cold.routine();
  cold.world.next = failing;
  cold.poller.start();
  await cold.poll();
  assert.equal(cold.delivered.length, 1);

  const ctx = setup();
  const routine = ctx.routine();
  ctx.store.setPrSnapshot(routine.id, { snapshot: failing, attempts: { "check:lint": 0 }, handed: { "check:lint": { at: START, head: "a1" } } });
  assert.notEqual(ctx.store.prSnapshot(routine.id), undefined);
  ctx.poller.stop();
  const again = setup({ file: ctx.file });
  assert.notEqual(again.store.prSnapshot(routine.id), undefined);
  again.world.next = failing;
  again.poller.start();
  await again.poll();
  assert.deepEqual(again.delivered, []);
});

test("failure cap completes after N repeats", async () => {
  const ctx = setup({ settings: { stopAfterFailures: { on: true, times: 2 } } });
  const routine = ctx.routine();
  ctx.poller.start();
  ctx.world.next = snapshot({ failingChecks: ["lint"] });
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);
  assert.deepEqual(ctx.delivered[0].event.changes, [{ id: "check:lint", text: "Check failed: lint" }]);

  // No Run has finished since: nothing is handed over again.
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);

  // A Run finished but pushed nothing: lint still fails, and that is no new attempt.
  ctx.clock.t += MINUTE;
  finishedRun(ctx, routine);
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);
  assert.equal(ctx.store.prSnapshot(routine.id).attempts["check:lint"], 0);

  // A Run pushed a commit and lint still fails: handed over again.
  ctx.clock.t += MINUTE;
  finishedRun(ctx, routine);
  ctx.world.next = snapshot({ failingChecks: ["lint"], headOid: "a2" });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 2);
  assert.notEqual(ctx.delivered[1].event.key, ctx.delivered[0].event.key);
  assert.ok(!ctx.store.get(routine.id).completedAt);

  // Another push, lint still fails: the second repeat reaches the cap.
  ctx.clock.t += MINUTE;
  finishedRun(ctx, routine);
  ctx.world.next = snapshot({ failingChecks: ["lint"], headOid: "a3" });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 2);
  assert.ok(ctx.store.get(routine.id).completedAt);
});

test("a red check at level 1 wakes the agent once, not every poll", async () => {
  const ctx = setup({ settings: { level: 1 } });
  const routine = ctx.routine();
  ctx.poller.start();
  ctx.world.next = snapshot({ failingChecks: ["lint"], totalChecks: 1 });
  for (let i = 0; i < 6; i += 1) {
    await ctx.poll();
    ctx.clock.t += MINUTE;
    finishedRun(ctx, routine);
    ctx.clock.t += MINUTE;
  }
  assert.equal(ctx.delivered.length, 1);
  assert.ok(!ctx.store.get(routine.id).completedAt);
});

test("a conflict nobody pushes for wakes once; a push that leaves it wakes again", async () => {
  const ctx = setup();
  const routine = ctx.routine();
  ctx.poller.start();
  await ctx.poll();
  ctx.world.next = snapshot({ mergeable: "CONFLICTING", mergeState: "DIRTY" });
  for (let i = 0; i < 3; i += 1) {
    ctx.clock.t += MINUTE;
    await ctx.poll();
    ctx.clock.t += MINUTE;
    finishedRun(ctx, routine);
  }
  assert.equal(ctx.delivered.length, 1);
  ctx.world.next = snapshot({ mergeable: "CONFLICTING", mergeState: "DIRTY", headOid: "a2" });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 2);
  assert.deepEqual(ctx.delivered[1].event.changes, [{ id: "conflict", text: "Merge conflicts with main" }]);
  assert.equal(ctx.store.prSnapshot(routine.id).attempts.conflict, 1);
});

test("a green poll with new comments hands them over and stops on the next poll", async () => {
  const ctx = setup();
  const routine = ctx.routine();
  ctx.poller.start();
  ctx.world.next = snapshot({ pendingChecks: 1, totalChecks: 1 });
  await ctx.poll();
  ctx.world.next = snapshot({ totalChecks: 1, comments: [comment("c1", "Approve, with a nit")] });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);
  assert.deepEqual(ctx.delivered[0].event.changes, [{ id: "comment:c1", text: "Review comment from @alice: Approve, with a nit" }]);
  assert.ok(!ctx.store.get(routine.id).completedAt);
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);
  assert.ok(ctx.store.get(routine.id).completedAt);
});

test("a closed PR stops at once, new comments or not", async () => {
  const ctx = setup();
  const routine = ctx.routine();
  ctx.poller.start();
  await ctx.poll();
  ctx.world.next = snapshot({ state: "CLOSED", comments: [comment("c1", "closing this")] });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.deepEqual(ctx.delivered, []);
  assert.ok(ctx.store.get(routine.id).completedAt);
});

test("a problem that is fixed is forgotten", async () => {
  const ctx = setup({ settings: { stopAfterFailures: { on: true, times: 2 } } });
  const routine = ctx.routine();
  ctx.poller.start();
  ctx.world.next = snapshot({ failingChecks: ["lint"] });
  await ctx.poll();
  ctx.world.next = snapshot();
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.deepEqual(ctx.store.prSnapshot(routine.id).handed, {});
  // Failing again later is a new problem, handed over under its own key.
  ctx.world.next = snapshot({ failingChecks: ["lint"] });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 2);
  assert.notEqual(ctx.delivered[1].event.key, ctx.delivered[0].event.key);
});

test("comments are never handed over again", async () => {
  const ctx = setup();
  const routine = ctx.routine();
  ctx.poller.start();
  await ctx.poll();
  ctx.world.next = snapshot({ comments: [comment("c1")] });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  finishedRun(ctx, routine);
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);
});

test("paused store polls nothing", async () => {
  const ctx = setup({ enabled: false });
  ctx.routine();
  ctx.poller.start();
  assert.deepEqual(ctx.timers.pending(), []);
  await ctx.poll();
  assert.equal(ctx.world.reads.length, 0);
  ctx.store.setEnabled(true);
  ctx.poller.sync();
  assert.equal(ctx.timers.pending().length, 1);
  ctx.store.setEnabled(false);
  ctx.poller.sync();
  assert.deepEqual(ctx.timers.pending(), []);
});

test("stop clears every timer", async () => {
  const ctx = setup();
  ctx.routine();
  ctx.poller.start();
  ctx.poller.stop();
  assert.deepEqual(ctx.timers.pending(), []);
});

test("failure cap survives a push that turns checks pending", async () => {
  const ctx = setup({ settings: { stopAfterFailures: { on: true, times: 2 } } });
  const routine = ctx.routine();
  ctx.poller.start();
  ctx.world.next = snapshot({ failingChecks: ["lint"], totalChecks: 1 });
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);
  for (const attempt of [1, 2]) {
    const headOid = `push${attempt}`;
    ctx.clock.t += MINUTE;
    finishedRun(ctx, routine);
    // The push restarted the checks: nothing is failing, one is pending, and the attempts stay.
    ctx.world.next = snapshot({ pendingChecks: 1, totalChecks: 1, headOid });
    ctx.clock.t += MINUTE;
    await ctx.poll();
    assert.equal(ctx.store.prSnapshot(routine.id).attempts["check:lint"], attempt - 1);
    // It fails again: that is a repeat.
    ctx.world.next = snapshot({ failingChecks: ["lint"], totalChecks: 1, headOid });
    ctx.clock.t += MINUTE;
    await ctx.poll();
    if (attempt === 1) {
      assert.equal(ctx.delivered.length, 2);
      assert.equal(ctx.store.prSnapshot(routine.id).attempts["check:lint"], 1);
      assert.ok(!ctx.store.get(routine.id).completedAt);
    }
  }
  assert.equal(ctx.delivered.length, 2);
  assert.ok(ctx.store.get(routine.id).completedAt);
});

test("a check that passes with nothing pending resets its attempts", async () => {
  const ctx = setup({ settings: { stopWhenGreen: false, stopAfterFailures: { on: true, times: 2 } } });
  const routine = ctx.routine();
  ctx.poller.start();
  ctx.world.next = snapshot({ failingChecks: ["lint"], totalChecks: 1 });
  await ctx.poll();
  ctx.clock.t += MINUTE;
  finishedRun(ctx, routine);
  ctx.world.next = snapshot({ failingChecks: ["lint"], totalChecks: 1, headOid: "a2" });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.store.prSnapshot(routine.id).attempts["check:lint"], 1);
  ctx.world.next = snapshot({ totalChecks: 1, headOid: "a2" });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.deepEqual(ctx.store.prSnapshot(routine.id).attempts, {});
  ctx.world.next = snapshot({ failingChecks: ["lint"], totalChecks: 1, headOid: "a2" });
  ctx.clock.t += MINUTE;
  await ctx.poll();
  assert.equal(ctx.delivered.length, 3);
  assert.equal(ctx.store.prSnapshot(routine.id).attempts["check:lint"], 0);
  assert.ok(!ctx.store.get(routine.id).completedAt);
});

test("a failure to hand changes over is not reported as a GitHub error", async () => {
  const ctx = setup();
  const routine = ctx.routine();
  ctx.poller.start();
  ctx.world.next = snapshot({ failingChecks: ["lint"] });
  const enqueue = ctx.store.enqueueMany;
  ctx.store.enqueueMany = () => {
    throw new Error("disk full");
  };
  await ctx.poll();
  ctx.store.enqueueMany = enqueue;
  assert.equal(ctx.store.get(routine.id).lastError, undefined);
  assert.equal(ctx.timers.pending().at(-1).ms, MINUTE);
  // The snapshot didn't move on, so the next poll hands the change over.
  await ctx.poll();
  assert.equal(ctx.delivered.length, 1);
});
