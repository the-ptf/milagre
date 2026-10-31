const assert = require("node:assert/strict");
const test = require("node:test");
const { createLimitResume, DAY_MS, RESET_ALLOWANCE_MS } = require("./limit-resume.cjs");

const NOW = 1_800_000_000_000;
const limitEvent = (at) => ({ type: "turn-failed", limit: { provider: "claude", resetsAt: at } });
function harness({ selected = "default", automatic = true, readState, prepareScope } = {}) {
  let clock = NOW;
  let valid = true;
  const scheduled = [],
    delivered = [],
    cancelled = [],
    errors = [];
  const pending = {
    at: new Date(NOW + 120_000).toISOString(),
    expiresAt: NOW + 180_000 + DAY_MS,
    provider: "claude",
    accountId: "default",
    sourceMessageId: 2,
    sendId: "once",
    mode: "automatic",
    stoppedAt: NOW,
  };
  const state = { sessions: { 1: { id: 1, limitTurn: pending, limitResume: pending } } };
  let reads = 0;
  let interval;
  const chats = {
    limitResumeToken: () => ({ valid: () => valid }),
    scheduleLimitResume: async (...args) => {
      scheduled.push(args);
      return true;
    },
    cancelLimitResume: async (...args) => {
      cancelled.push(args);
    },
    runLimitResume: async (...args) => {
      delivered.push(args);
    },
  };
  const resume = createLimitResume({
    chats,
    settings: { resumeAtReset: () => automatic },
    scopes: async () => ["/closed", "milagre-link:test"],
    readState: async (key) => {
      reads++;
      return readState ? readState(key) : state;
    },
    prepareScope: prepareScope ?? (async () => {}),
    accountId: async () => (typeof selected === "function" ? selected() : selected),
    now: () => clock,
    onError: (...args) => errors.push(args),
    timers: {
      setInterval: (fn, ms) => {
        interval = { fn, ms, unref() {} };
        return interval;
      },
      clearInterval: (value) => {
        assert.equal(value, interval);
      },
    },
  });
  return {
    resume,
    state,
    pending,
    scheduled,
    delivered,
    cancelled,
    errors,
    reads: () => reads,
    time: (value) => {
      clock = value;
    },
    invalidate: () => {
      valid = false;
    },
    interval: () => interval,
  };
}

test("wall-clock polling recovers unopened Projects and Links, waits the allowance, and avoids repeated disk reads", async () => {
  const h = harness();
  h.resume.start();
  await h.resume.tick();
  assert.equal(h.interval().ms, 30_000);
  h.time(NOW + 120_000 + RESET_ALLOWANCE_MS - 1);
  await h.resume.tick();
  assert.equal(h.delivered.length, 0);
  h.time(NOW + 120_000 + RESET_ALLOWANCE_MS);
  await h.resume.tick();
  assert.deepEqual(
    h.delivered.map(([scope]) => scope),
    ["/closed", "milagre-link:test"],
  );
  assert.equal(h.reads(), 2);
  h.resume.trackState("/closed", { sessions: {} });
  h.resume.trackState("milagre-link:test", { sessions: {} });
  await h.resume.tick();
  assert.equal(h.delivered.length, 2);
  await h.resume.stop();
});

test("sleep catch-up fires within the grace and drops days-overdue schedules", async () => {
  const h = harness();
  h.time(NOW + 10 * 60_000);
  await h.resume.tick();
  assert.equal(h.delivered.length, 2);
  h.time(h.pending.expiresAt + 1);
  await h.resume.tick();
  assert.equal(h.cancelled.length, 2);
  await h.resume.stop();
});

test("automatic scheduling needs a known reset within 24 hours and the setting, and respects cancellation during account lookup", async () => {
  const h = harness();
  const token = { valid: () => true };
  for (const at of [undefined, "bad", new Date(NOW - 1).toISOString(), new Date(NOW + DAY_MS + 1).toISOString()]) {
    assert.equal(await h.resume.observe("/closed#1", limitEvent(at), token), false);
  }
  assert.equal(h.scheduled.length, 0);
  await h.resume.observe("/closed#1", limitEvent(new Date(NOW + DAY_MS).toISOString()), token);
  assert.equal(h.scheduled.length, 1);
  const off = harness({ automatic: false });
  await off.resume.observe("/closed#1", limitEvent(new Date(NOW + 1000).toISOString()), token);
  assert.equal(off.scheduled.length, 0);
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const race = harness({ selected: () => waiting });
  let valid = true;
  const observing = race.resume.observe("/closed#1", limitEvent(new Date(NOW + 1000).toISOString()), { valid: () => valid });
  valid = false;
  release("default");
  assert.equal(await observing, false);
  assert.equal(race.scheduled.length, 0);
  await Promise.all([h.resume.stop(), off.resume.stop(), race.resume.stop()]);
});

test("ticks serialize; shutdown fences and drains an in-flight delivery; one unreadable scope does not block another", async () => {
  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const preparing = new Promise((resolve) => {
    entered = resolve;
  });
  const h = harness({
    prepareScope: async () => {
      entered();
      await gate;
    },
  });
  h.time(NOW + 180_000);
  const first = h.resume.tick();
  assert.equal(h.resume.tick(), first);
  await preparing;
  const stopped = h.resume.stop();
  release();
  await stopped;
  assert.equal(h.delivered.length, 0);
  const good = { sessions: { 1: { id: 1, limitResume: h.pending } } };
  const isolated = harness({
    readState: (key) => {
      if (key === "/closed") throw new Error("unreadable");
      return good;
    },
  });
  isolated.time(NOW + 180_000);
  await isolated.resume.tick();
  assert.equal(isolated.errors.length, 1);
  assert.equal(isolated.delivered.length, 1);
  await isolated.resume.stop();
});

test("a paused bot's pending Chat waits without delivering", async () => {
  const h = harness({ prepareScope: async () => false });
  h.time(NOW + 180_000);
  await h.resume.tick();
  assert.equal(h.delivered.length, 0);
  assert.equal(h.cancelled.length, 0);
  await h.resume.stop();
});
