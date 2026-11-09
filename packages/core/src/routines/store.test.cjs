const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRoutineStore } = require("./store.cjs");

const DAY = 864e5;
const START = Date.UTC(2026, 0, 5, 10, 0, 0); // a Monday, 10:00 UTC

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-store-"));
  const file = path.join(dir, "routines.json");
  const clock = { t: START };
  let n = 0;
  const options = { file, now: () => clock.t, id: () => `id${++n}` };
  return { dir, file, clock, options, store: createRoutineStore(options) };
}

const base = { chatId: "c1", name: "check", prompt: "look", every: "15m", timezone: "UTC", createdBy: { kind: "user" } };

test("a missing file means empty", () => {
  const { store } = setup();
  assert.deepEqual(store.list(), []);
  assert.equal(store.get("nope"), null);
  assert.deepEqual(store.runs("nope"), []);
});

test("runningCount counts the Runs under way in every Routine, an update's wait", () => {
  const { store } = setup();
  const first = store.upsertHeartbeat(base);
  const second = store.upsertHeartbeat({ ...base, chatId: "c2", name: "other" });
  assert.equal(store.runningCount(), 0);
  const { run } = store.startRun(first.id, START);
  store.startRun(second.id, START);
  assert.equal(store.runningCount(), 2);
  store.finishRun(run.id, { status: "acted" });
  assert.equal(store.runningCount(), 1);
});

test("a file from when Routines waited for AI sharing consent keeps its Routines and Runs, and drops the old switch", () => {
  const { store, options, file } = setup();
  const routine = store.upsertHeartbeat(base);
  const run = store.startRun(routine.id, START);
  store.finishRun(run.id, { status: "acted" });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const old of [{ enabled: false }, { enabled: true, aiConsentVersion: "2026-10-20" }, { enabled: false, aiConsentVersion: null }]) {
    fs.writeFileSync(file, JSON.stringify({ ...saved, ...old }));
    const migrated = createRoutineStore(options);
    assert.deepEqual(migrated.get(routine.id), store.get(routine.id));
    assert.deepEqual(migrated.runs(routine.id), store.runs(routine.id));
    migrated.setLinearCursor("acme", 1);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal("enabled" in written, false);
    assert.equal("aiConsentVersion" in written, false);
  }
});

test("upsertHeartbeat twice with the same name and chat keeps one Routine", () => {
  const { store } = setup();
  const first = store.upsertHeartbeat(base);
  store.upsertHeartbeat({ ...base, prompt: "look again" });
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, first.id);
  assert.equal(list[0].prompt, "look again");
});

test("upsert keeps runCount and does not match another chat or name", () => {
  const { store } = setup();
  const first = store.upsertHeartbeat(base);
  store.claimDue(first.nextRunAt);
  const run = store.runs(first.id)[0];
  store.finishRun(run.id, { status: "acted" });
  const again = store.upsertHeartbeat(base);
  assert.equal(again.id, first.id);
  assert.equal(again.runCount, 1);
  store.upsertHeartbeat({ ...base, chatId: "c2" });
  store.upsertHeartbeat({ ...base, name: "other" });
  assert.equal(store.list().length, 3);
});

test("a heartbeat with no limits expires in 7 days", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  assert.equal(routine.expiresAt, START + 7 * DAY);
  assert.equal(routine.maxRuns, undefined);
  assert.equal(routine.enabled, true);
  assert.deepEqual(routine.trigger, { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" });
  assert.deepEqual(routine.target, { kind: "chat", chatId: "c1" });
  assert.equal(routine.nextRunAt, START + 15 * 60_000);
});

test("maxRuns or expiresIn replace the default expiry", () => {
  const { store } = setup();
  const limited = store.upsertHeartbeat({ ...base, name: "a", maxRuns: 3 });
  assert.equal(limited.maxRuns, 3);
  assert.equal(limited.expiresAt, undefined);
  assert.equal(store.upsertHeartbeat({ ...base, name: "b", expiresIn: "30m" }).expiresAt, START + 30 * 60_000);
  assert.equal(store.upsertHeartbeat({ ...base, name: "c", expiresIn: "6h" }).expiresAt, START + 6 * 3600_000);
  assert.equal(store.upsertHeartbeat({ ...base, name: "d", expiresIn: "2d" }).expiresAt, START + 2 * DAY);
});

test("upsertHeartbeat validates its input", () => {
  const { store } = setup();
  assert.throws(() => store.upsertHeartbeat({ ...base, every: undefined }), /cron or every/);
  assert.throws(() => store.upsertHeartbeat({ ...base, cron: "* * * * *" }), /cron or every/);
  assert.throws(() => store.upsertHeartbeat({ ...base, timezone: undefined }), /timezone/);
  assert.throws(() => store.upsertHeartbeat({ ...base, every: "never" }), /Invalid every/);
  assert.throws(() => store.upsertHeartbeat({ ...base, timezone: "Mars/Base" }));
  assert.throws(() => store.upsertHeartbeat({ ...base, cron: "nope", every: undefined }));
  for (const expiresIn of ["0d", "7", "d", "7w", "never", "-1h"]) {
    assert.throws(() => store.upsertHeartbeat({ ...base, expiresIn }), /Invalid expiresIn/, expiresIn);
  }
  assert.deepEqual(store.list(), []);
});

test("claimDue claims once and moves nextRunAt to the next slot", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat(base);
  const at = routine.nextRunAt;
  clock.t = at;
  const claims = store.claimDue(at);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].routine.id, routine.id);
  assert.equal(claims[0].run.status, "running");
  assert.equal(claims[0].run.scheduledFor, at);
  assert.equal(claims[0].run.routineId, routine.id);
  assert.equal(store.get(routine.id).nextRunAt, at + 15 * 60_000);
  assert.deepEqual(store.claimDue(at), []);
  assert.equal(store.runs(routine.id).length, 1);
});

test("claimDue skips disabled Routines and ones not yet due", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  assert.deepEqual(store.claimDue(routine.nextRunAt - 1), []);
  store.update(routine.id, { enabled: false });
  assert.deepEqual(store.claimDue(routine.nextRunAt + 1000), []);
});

test("a slot missed by more than a minute records one missed Run and advances", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  const at = routine.nextRunAt + 5 * 60_000;
  assert.deepEqual(store.claimDue(at), []);
  const runs = store.runs(routine.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "missed");
  assert.equal(runs[0].scheduledFor, routine.nextRunAt);
  assert.equal(store.get(routine.id).nextRunAt, routine.nextRunAt + 15 * 60_000);
  assert.equal(store.get(routine.id).runCount, 0);
  assert.deepEqual(store.claimDue(at), []);
  assert.equal(store.runs(routine.id).length, 1);
});

test("finishRun counts runs and completes the Routine at maxRuns", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat({ ...base, maxRuns: 2 });
  let at = routine.nextRunAt;
  clock.t = at;
  const [first] = store.claimDue(at);
  clock.t = at + 1000;
  const done = store.finishRun(first.run.id, { status: "acted", summary: "did it", chatId: "c1" });
  assert.equal(done.runCount, 1);
  assert.equal(done.completedAt, undefined);
  const finished = store.runs(routine.id)[0];
  assert.equal(finished.status, "acted");
  assert.equal(finished.endedAt, at + 1000);
  assert.equal(finished.summary, "did it");
  assert.equal(finished.chatId, "c1");
  at = store.get(routine.id).nextRunAt;
  clock.t = at;
  const [second] = store.claimDue(at);
  const last = store.finishRun(second.run.id, { status: "quiet" });
  assert.equal(last.runCount, 2);
  assert.equal(last.completedAt, at);
  assert.equal(last.enabled, false);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.claimDue(at + DAY), []);
});

test("skipped-busy and missed runs do not count, failed ones do", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat(base);
  const claim = (status) => {
    const at = store.get(routine.id).nextRunAt;
    clock.t = at;
    const [c] = store.claimDue(at);
    return store.finishRun(c.run.id, { status, error: status === "failed" ? "boom" : undefined });
  };
  assert.equal(claim("skipped-busy").runCount, 0);
  assert.equal(claim("failed").runCount, 1);
  assert.equal(store.runs(routine.id)[0].error, "boom");
});

test("finishRun twice leaves the Run and runCount alone and returns null", () => {
  const { store, clock, file } = setup();
  const routine = store.upsertHeartbeat({ ...base, maxRuns: 2 });
  clock.t = routine.nextRunAt;
  const [claim] = store.claimDue(clock.t);
  clock.t += 1000;
  assert.equal(store.finishRun(claim.run.id, { status: "acted", summary: "first" }).runCount, 1);
  const before = fs.readFileSync(file, "utf8");
  clock.t += 1000;
  assert.equal(store.finishRun(claim.run.id, { status: "failed", error: "late" }), null);
  assert.equal(store.get(routine.id).runCount, 1);
  const [run] = store.runs(routine.id);
  assert.equal(run.status, "acted");
  assert.equal(run.summary, "first");
  assert.equal(run.error, undefined);
  assert.equal(run.endedAt, routine.nextRunAt + 1000);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("finishRun does not finish a missed Run and rejects statuses outside the finishing set", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  store.claimDue(routine.nextRunAt + 5 * 60_000);
  const [missed] = store.runs(routine.id);
  assert.equal(store.finishRun(missed.id, { status: "acted" }), null);
  assert.equal(store.runs(routine.id)[0].status, "missed");
  const next = setup();
  const r = next.store.upsertHeartbeat(base);
  next.clock.t = r.nextRunAt;
  const [claim] = next.store.claimDue(next.clock.t);
  for (const status of ["running", "missed", "bogus", undefined]) {
    assert.throws(() => next.store.finishRun(claim.run.id, { status }), /Invalid run status/, String(status));
  }
  assert.equal(next.store.runs(r.id)[0].status, "running");
});

test("finishRun on an unknown run returns null", () => {
  const { store } = setup();
  assert.equal(store.finishRun("nope", { status: "acted" }), null);
});

test("recoverInterrupted fails running Runs and advances overdue slots without missed Runs", () => {
  const { store, clock, options } = setup();
  const routine = store.upsertHeartbeat(base);
  const at = routine.nextRunAt;
  clock.t = at;
  store.claimDue(at);
  clock.t = at + 3 * 3600_000;
  const restarted = createRoutineStore(options);
  restarted.recoverInterrupted();
  const runs = restarted.runs(routine.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].error, "daemon restarted");
  assert.equal(runs[0].endedAt, clock.t);
  const after = restarted.get(routine.id);
  assert.equal(after.runCount, 1);
  assert.ok(after.nextRunAt > clock.t);
  assert.ok(after.nextRunAt <= clock.t + 15 * 60_000);
  assert.deepEqual(restarted.claimDue(clock.t), []);
});

test("recoverInterrupted can complete a Routine at maxRuns", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat({ ...base, maxRuns: 1 });
  clock.t = routine.nextRunAt;
  store.claimDue(clock.t);
  store.recoverInterrupted();
  assert.ok(store.get(routine.id).completedAt);
  assert.deepEqual(store.list(), []);
});

test("only the last 50 Runs are kept", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat({ ...base, expiresIn: "30d" });
  for (let i = 0; i < 60; i++) {
    const at = store.get(routine.id).nextRunAt;
    clock.t = at;
    const [c] = store.claimDue(at);
    store.finishRun(c.run.id, { status: "quiet" });
  }
  const runs = store.runs(routine.id);
  assert.equal(runs.length, 50);
  assert.ok(runs[0].scheduledFor > runs[49].scheduledFor);
  assert.equal(store.get(routine.id).runCount, 60);
});

// A Run of a trigger Routine, started, given a Chat (unless `chatId` is empty) and ended as `status`. Returns the Run's id.
function runOnce(store, routine, clock, n, chatId, status = "acted") {
  store.enqueue(routine.id, delivery(n));
  const [claim] = store.claimQueued(clock.t);
  if (chatId) store.attachChat(claim.run.id, { chatId });
  store.finishRun(claim.run.id, { status });
  return claim.run.id;
}

test("acted Runs keep their own 50, so quiet Runs can't push them out", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  const first = runOnce(store, routine, clock, 1, "", "acted");
  for (let n = 2; n <= 61; n += 1) runOnce(store, routine, clock, n, "", "quiet");
  let runs = store.runs(routine.id);
  assert.equal(runs.filter((run) => run.status === "acted").length, 1);
  assert.equal(runs.filter((run) => run.status === "quiet").length, 50);
  assert.ok(runs.some((run) => run.id === first));
  // The other way round: acted Runs are held to 50 whatever else is kept. A Run is trimmed when the next one is added, so
  // the newest acted Run (still running when it was added) is counted from the Run after it.
  for (let n = 62; n <= 120; n += 1) runOnce(store, routine, clock, n, "", "acted");
  runOnce(store, routine, clock, 121, "", "quiet");
  runs = store.runs(routine.id);
  const acted = runs.filter((run) => run.status === "acted");
  assert.equal(acted.length, 50);
  assert.ok(!acted.some((run) => run.id === first), "the oldest acted Run went");
  assert.ok(runs.some((run) => run.status === "quiet"));
});

test("failed Runs share the quiet Runs' 50, apart from the acted ones", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  const acted = runOnce(store, routine, clock, 1, "", "acted");
  // Alternating, because three failures in a row would pause the trigger.
  for (let n = 2; n <= 61; n += 1) runOnce(store, routine, clock, n, "", n % 2 === 0 ? "failed" : "quiet");
  const runs = store.runs(routine.id);
  assert.equal(runs.length, 51);
  assert.equal(runs.filter((run) => run.status === "failed").length, 25);
  assert.equal(runs.filter((run) => run.status === "quiet").length, 25);
  assert.ok(runs.some((run) => run.id === acted));
});

test("onRunsDropped hears the Runs a trim, a delete and a purge took, with their Chats", () => {
  const dropped = [];
  const hear = (list) => dropped.push(list);

  // A trim: the oldest acted Run goes when the Run after the 51st is added. One without a Chat is never reported.
  {
    const { options, clock } = setup();
    const store = createRoutineStore({ ...options, onRunsDropped: hear });
    const routine = store.create(spec);
    const ids = [];
    for (let n = 1; n <= 52; n += 1) ids.push(runOnce(store, routine, clock, n, n === 1 ? "" : `chat${n}`));
    assert.deepEqual(dropped, [], "the first Run had no Chat, so its trim says nothing");
    ids.push(runOnce(store, routine, clock, 53, "chat53"));
    assert.deepEqual(dropped, [[{ routineId: routine.id, runId: ids[1], chatId: "chat2" }]]);
    assert.equal(store.hasRun(ids[1]), false);
    assert.equal(store.hasRun(ids[2]), true);
  }

  // A delete: every Run with a Chat, in one call, in the order they were started.
  dropped.length = 0;
  {
    const { options, clock } = setup();
    const store = createRoutineStore({ ...options, onRunsDropped: hear });
    const routine = store.create({ ...spec, name: "gone" });
    const one = runOnce(store, routine, clock, 1, "chat-one");
    runOnce(store, routine, clock, 2, "");
    const three = runOnce(store, routine, clock, 3, "chat-three", "quiet");
    assert.deepEqual(dropped, []);
    assert.equal(store.remove(routine.id), true);
    assert.deepEqual(dropped, [
      [
        { routineId: routine.id, runId: one, chatId: "chat-one" },
        { routineId: routine.id, runId: three, chatId: "chat-three" },
      ],
    ]);
    // Deleting what isn't there, or a Routine with no Chats, is silent.
    assert.equal(store.remove(routine.id), false);
    const bare = store.create({ ...spec, name: "bare", trigger: webhook(OTHER_HOOK) });
    runOnce(store, bare, clock, 4, "");
    store.remove(bare.id);
    assert.equal(dropped.length, 1);
  }

  // A purge 30 days after the Routine ended, on a write...
  dropped.length = 0;
  {
    const { options, clock } = setup();
    const store = createRoutineStore({ ...options, onRunsDropped: hear });
    const routine = store.create(spec);
    const run = runOnce(store, routine, clock, 1, "chat-old");
    runOnce(store, routine, clock, 2, "");
    store.complete(routine.id, "done");
    clock.t += 31 * DAY;
    assert.deepEqual(dropped, []);
    store.create({ ...spec, name: "other", trigger: webhook(OTHER_HOOK) });
    assert.deepEqual(dropped, [[{ routineId: routine.id, runId: run, chatId: "chat-old" }]]);
  }

  // ...and on load.
  dropped.length = 0;
  {
    const { options, clock } = setup();
    const store = createRoutineStore(options);
    const routine = store.create(spec);
    const run = runOnce(store, routine, clock, 1, "chat-late");
    runOnce(store, routine, clock, 2, "");
    store.complete(routine.id, "done");
    clock.t += 31 * DAY;
    const loaded = createRoutineStore({ ...options, onRunsDropped: hear });
    assert.equal(loaded.get(routine.id), null);
    assert.deepEqual(dropped, [[{ routineId: routine.id, runId: run, chatId: "chat-late" }]]);
  }
});

test("a store whose onRunsDropped throws still writes, and says so in the log", () => {
  const { options, clock, file } = setup();
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    const store = createRoutineStore({
      ...options,
      onRunsDropped: () => {
        throw new Error("archive failed");
      },
    });
    const routine = store.create(spec);
    runOnce(store, routine, clock, 1, "chat1");
    assert.equal(store.remove(routine.id), true);
    assert.equal(store.get(routine.id), null);
    assert.deepEqual(saved({ file }).routines, []);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /dropped Runs/);
});

test("finishRun and setRunTitle save a Run's title", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 2; n += 1) store.enqueue(routine.id, delivery(n));
  const [one, two] = store.claimQueued(clock.t, 3);
  assert.notEqual(store.finishRun(one.run.id, { status: "acted", summary: "did it", title: "Fix the flaky test" }), null);
  const titled = (id) => store.runs(routine.id).find((run) => run.id === id);
  assert.equal(titled(one.run.id).title, "Fix the flaky test");
  assert.equal(titled(one.run.id).summary, "did it");
  // No title given: none is stored.
  store.finishRun(two.run.id, { status: "quiet" });
  assert.equal("title" in titled(two.run.id), false);
  // Set afterwards, on the Run that ended.
  assert.equal(store.setRunTitle(two.run.id, "Nothing to do"), true);
  assert.equal(titled(two.run.id).title, "Nothing to do");
  assert.equal(store.setRunTitle(one.run.id, "A better name"), true);
  assert.equal(titled(one.run.id).title, "A better name");
  assert.throws(() => store.setRunTitle(one.run.id, ""), /title/);
  assert.equal(titled(one.run.id).title, "A better name");
  // Saved: a store opened on the same file reads the titles back.
  const again = createRoutineStore(options);
  assert.deepEqual(
    again.runs(routine.id).map((run) => run.title),
    ["Nothing to do", "A better name"],
  );
  // A Run that is gone is false, and nothing is written.
  assert.equal(store.setRunTitle("nope", "x"), false);
  store.remove(routine.id);
  assert.equal(store.setRunTitle(one.run.id, "late"), false);
});

test("hasRun says whether a Run is still in the store", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  const run = runOnce(store, routine, clock, 1, "chat1");
  assert.equal(store.hasRun(run), true);
  assert.equal(store.hasRun("nope"), false);
  store.remove(routine.id);
  assert.equal(store.hasRun(run), false);
});

test("readOnlyReason is null for a store that writes", () => {
  assert.equal(setup().store.readOnlyReason(), null);
});

test("a re-created store reads back the same Routines and Runs", () => {
  const { store, clock, options } = setup();
  const routine = store.upsertHeartbeat(base);
  clock.t = routine.nextRunAt;
  store.claimDue(clock.t);
  const again = createRoutineStore(options);
  assert.deepEqual(again.list(), store.list());
  assert.deepEqual(again.runs(routine.id), store.runs(routine.id));
  assert.deepEqual(fs.readdirSync(path.dirname(options.file)), ["routines.json"]);
});

test("complete and expireDue end Routines", () => {
  const { store, clock } = setup();
  const a = store.upsertHeartbeat({ ...base, name: "a", expiresIn: "1h" });
  const b = store.upsertHeartbeat({ ...base, name: "b", expiresIn: "2h" });
  const c = store.upsertHeartbeat({ ...base, name: "c" });
  clock.t = START + 90 * 60_000;
  store.expireDue(clock.t);
  assert.ok(store.get(a.id).completedAt);
  assert.equal(store.get(a.id).enabled, false);
  assert.equal(store.get(b.id).completedAt, undefined);
  store.complete(c.id, "done early");
  assert.equal(store.get(c.id).completedAt, clock.t);
  assert.deepEqual(
    store.list().map((r) => r.id),
    [b.id],
  );
});

test("complete and expireDue keep why a Routine ended and tell onEnded once, after the write", () => {
  const { options, clock } = setup();
  const told = [];
  const store = createRoutineStore({
    ...options,
    onEnded: (ended) => {
      // Told after the write: the store already holds the ended Routine.
      for (const entry of ended) assert.ok(store.get(entry.routine.id).completedAt);
      told.push(...ended.map((entry) => [entry.routine.name, entry.reason]));
    },
  });
  const a = store.upsertHeartbeat({ ...base, name: "a", expiresIn: "1h" });
  const c = store.upsertHeartbeat({ ...base, name: "c" });
  clock.t = START + 90 * 60_000;
  store.expireDue(clock.t);
  store.complete(c.id, "green");
  assert.equal(store.get(a.id).completedReason, "expired");
  assert.equal(store.get(c.id).completedReason, "green");
  assert.equal(createRoutineStore(options).get(c.id).completedReason, "green");
  // Completing an ended Routine again tells nobody, and keeps the first reason.
  store.complete(c.id, "chat gone");
  assert.equal(store.get(c.id).completedReason, "green");
  assert.deepEqual(told, [
    ["a", "expired"],
    ["c", "green"],
  ]);
  // A Routine ended without a reason keeps none; an onEnded that throws doesn't undo the end.
  const quiet = createRoutineStore({
    ...options,
    onEnded: () => {
      throw new Error("boom");
    },
  });
  const d = quiet.upsertHeartbeat({ ...base, name: "d" });
  const warn = console.warn;
  console.warn = () => {};
  try {
    quiet.complete(d.id);
  } finally {
    console.warn = warn;
  }
  assert.ok(quiet.get(d.id).completedAt);
  assert.equal(quiet.get(d.id).completedReason, undefined);
});

test("list returns disabled Routines, newest first", () => {
  const { store, clock } = setup();
  const a = store.upsertHeartbeat({ ...base, name: "a" });
  clock.t += 1000;
  const b = store.upsertHeartbeat({ ...base, name: "b" });
  store.update(a.id, { enabled: false });
  assert.deepEqual(
    store.list().map((r) => r.id),
    [b.id, a.id],
  );
});

test("update recomputes nextRunAt on cron, timezone and re-enable", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat(base);
  const hourly = store.update(routine.id, { cron: "0 * * * *" });
  assert.equal(hourly.trigger.cron, "0 * * * *");
  assert.equal(hourly.nextRunAt, START + 3600_000);
  const tokyo = store.update(routine.id, { cron: "0 9 * * *", timezone: "Asia/Tokyo" });
  assert.equal(tokyo.trigger.timezone, "Asia/Tokyo");
  assert.equal(tokyo.nextRunAt, Date.UTC(2026, 0, 6, 0, 0));
  store.update(routine.id, { enabled: false });
  clock.t = START + 5 * 3600_000;
  const back = store.update(routine.id, { enabled: true });
  assert.equal(back.enabled, true);
  assert.ok(back.nextRunAt > clock.t);
  assert.equal(store.update(routine.id, { name: "renamed", prompt: "new" }).name, "renamed");
});

test("update rejects bad input and unknown Routines", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  assert.throws(() => store.update(routine.id, { cron: "nope" }));
  assert.throws(() => store.update(routine.id, { timezone: "Mars/Base" }));
  assert.throws(() => store.update(routine.id, { color: "red" }), /color/);
  assert.throws(() => store.update("nope", { name: "x" }), /not found/);
  assert.equal(store.get(routine.id).trigger.cron, "*/15 * * * *");
});

test("update keeps an end on every heartbeat", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  assert.throws(() => store.update(routine.id, { expiresAt: null }), /Heartbeats need an end/);
  assert.equal(store.update(routine.id, { expiresAt: null, maxRuns: 5 }).maxRuns, 5);
  assert.throws(() => store.update(routine.id, { maxRuns: null }), /Heartbeats need an end/);
});

test("remove deletes the Routine and its Runs", () => {
  const { store, clock, options } = setup();
  const routine = store.upsertHeartbeat(base);
  clock.t = routine.nextRunAt;
  store.claimDue(clock.t);
  assert.equal(store.remove(routine.id), true);
  assert.equal(store.remove(routine.id), false);
  assert.equal(store.get(routine.id), null);
  assert.deepEqual(store.runs(routine.id), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.file, "utf8")).runs, {});
});

test("an unparsable file is moved aside and the store starts empty", () => {
  const { file, options } = setup();
  fs.writeFileSync(file, "{ not json");
  const store = createRoutineStore(options);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.readFileSync(`${file}.corrupt`, "utf8"), "{ not json");
  store.upsertHeartbeat(base);
  assert.equal(createRoutineStore(options).list().length, 1);
});

test("returned Routines are copies", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  routine.name = "mutated";
  store.get(routine.id).trigger.cron = "bad";
  assert.equal(store.get(routine.id).name, "check");
  assert.equal(store.get(routine.id).trigger.cron, "*/15 * * * *");
});

test("startRun appends a running Run without moving nextRunAt", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat(base);
  clock.t += 1000;
  const started = store.startRun(routine.id, clock.t);
  assert.equal(started.run.status, "running");
  assert.equal(started.run.routineId, routine.id);
  assert.equal(started.run.scheduledFor, clock.t);
  assert.equal(started.routine.nextRunAt, routine.nextRunAt);
  assert.equal(store.get(routine.id).nextRunAt, routine.nextRunAt);
  assert.equal(store.runs(routine.id).length, 1);
  assert.equal(store.finishRun(started.run.id, { status: "acted" }).runCount, 1);
});

test("startRun returns null for unknown and completed Routines", () => {
  const { store, clock } = setup();
  assert.equal(store.startRun("nope", clock.t), null);
  const routine = store.upsertHeartbeat(base);
  store.complete(routine.id, "done");
  assert.equal(store.startRun(routine.id, clock.t), null);
});

test("three failed Runs in a row complete the heartbeat; an acted or quiet Run resets the streak", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  const beat = (status, extra = {}) => {
    const { run } = store.startRun(routine.id, START);
    return store.finishRun(run.id, { status, ...extra });
  };
  assert.equal(beat("failed", { error: "boom" }).failedStreak, 1);
  assert.equal(beat("failed", { error: "boom" }).failedStreak, 2);
  assert.equal(beat("skipped-busy").failedStreak, 2);
  assert.equal(beat("quiet").failedStreak, 0);
  beat("failed", { error: "boom" });
  beat("acted");
  beat("failed", { error: "boom" });
  beat("failed", { error: "boom" });
  assert.ok(!store.get(routine.id).completedAt);
  const ended = beat("failed", { error: "no CLI" });
  assert.equal(ended.failedStreak, 3);
  assert.ok(ended.completedAt);
  assert.equal(ended.enabled, false);
  assert.deepEqual(store.list(), []);
  assert.equal(store.runs(routine.id)[0].error, "no CLI · 3 failed beats in a row");
});

test("a Heartbeat missing its name, prompt or timezone is refused, in words that name a Heartbeat", () => {
  const { store } = setup();
  assert.throws(() => store.upsertHeartbeat({ ...base, name: " " }), { message: "A Heartbeat needs a name" });
  assert.throws(() => store.upsertHeartbeat({ ...base, prompt: "" }), { message: "A Heartbeat needs a prompt" });
  assert.throws(() => store.upsertHeartbeat({ ...base, timezone: "" }), { message: "A Heartbeat needs a timezone" });
  assert.throws(() => store.upsertHeartbeat({ ...base, expiresIn: "31d" }), /a Heartbeat runs for at most 30d/);
  assert.deepEqual(store.list(), []);
});

test("expiresIn is capped at 30 days, and nothing is saved past it", () => {
  const { store, options } = setup();
  assert.equal(store.upsertHeartbeat({ ...base, name: "a", expiresIn: "30d" }).expiresAt, START + 30 * DAY);
  for (const expiresIn of ["31d", "721h", "43201m", "99999999999d"]) {
    assert.throws(() => store.upsertHeartbeat({ ...base, name: "b", expiresIn }), /at most 30d/, expiresIn);
  }
  assert.deepEqual(
    createRoutineStore(options)
      .list()
      .map((routine) => routine.name),
    ["a"],
  );
});

test("update keeps expiresAt within 30 days of now", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  assert.throws(() => store.update(routine.id, { expiresAt: START + 31 * DAY }), /at most 30d/);
  assert.throws(() => store.update(routine.id, { expiresAt: Number.MAX_VALUE }), /at most 30d/);
  assert.throws(() => store.update(routine.id, { expiresAt: "soon" }), /expiresAt/);
  assert.equal(store.get(routine.id).expiresAt, START + 7 * DAY);
  assert.equal(store.update(routine.id, { expiresAt: START + 30 * DAY }).expiresAt, START + 30 * DAY);
});

test("setting a heartbeat again without an end keeps the end it had", () => {
  const { store, clock } = setup();
  const first = store.upsertHeartbeat({ ...base, expiresIn: "2d" });
  clock.t += DAY;
  const again = store.upsertHeartbeat({ ...base, prompt: "look again" });
  assert.equal(again.expiresAt, first.expiresAt);
  const limited = store.upsertHeartbeat({ ...base, name: "limited", maxRuns: 4 });
  clock.t += DAY;
  const limitedAgain = store.upsertHeartbeat({ ...base, name: "limited", prompt: "p2" });
  assert.equal(limitedAgain.maxRuns, 4);
  assert.equal(limitedAgain.expiresAt, limited.expiresAt);
  // A new end given replaces the old one.
  assert.equal(store.upsertHeartbeat({ ...base, expiresIn: "1h" }).expiresAt, clock.t + 3600_000);
});

// Triggers: create, validated update, the event queue and the failure pause.

const HOOK = "ab".repeat(32);
const OTHER_HOOK = "cd".repeat(32);
const NEW_CHAT = { kind: "new-chat", projectPath: "/repo", workspace: "worktree" };
const HOURLY = { kind: "schedule", cron: "0 * * * *", timezone: "UTC" };
const webhook = (hookId = HOOK, signed = false) => ({ kind: "webhook", hookId, signed });
const linear = (event = "assigned", extra = {}) => ({ kind: "linear", workspace: "acme", event, ...extra });
const spec = { name: "triage", prompt: "look at {{body}}", trigger: webhook(), target: NEW_CHAT, createdBy: { kind: "user" } };
const delivery = (n) => ({ kind: "webhook", key: `hook:${n}`, deliveryId: `d${n}` });
const change = (n, kind = "assigned") => ({
  kind: "linear",
  key: kind === "comment" ? `linear-comment:c${n}` : `linear:i${n}:h${n}`,
  change: kind,
  issue: {
    id: `i${n}`,
    key: `MIL-${n}`,
    title: "Fix it",
    description: "It is broken",
    url: `https://linear.app/acme/issue/MIL-${n}`,
    labels: [],
    state: "Todo",
    team: "MIL",
    workspace: "acme",
  },
  ...(kind === "comment" ? { comment: { id: `c${n}`, body: "ping", author: "Ana", createdAt: START } } : {}),
});
const saved = (options) => JSON.parse(fs.readFileSync(options.file, "utf8"));
const hex = (digit) => digit.repeat(64);

// How many times `fn` wrote the store file: every save renames a temp file over it.
function countSaves(fn) {
  const rename = fs.renameSync;
  let saves = 0;
  fs.renameSync = (...args) => {
    saves += 1;
    return rename(...args);
  };
  try {
    fn();
  } finally {
    fs.renameSync = rename;
  }
  return saves;
}

test("create makes a trigger that runs on a schedule in a new Chat, with no end", () => {
  const { store, options } = setup();
  const routine = store.create({ ...spec, trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" } });
  assert.equal(routine.expiresAt, undefined);
  assert.equal(routine.maxRuns, undefined);
  assert.equal(routine.enabled, true);
  assert.equal(routine.runCount, 0);
  assert.equal(routine.createdAt, START);
  assert.equal(routine.updatedAt, START);
  assert.deepEqual(routine.createdBy, { kind: "user" });
  assert.deepEqual(routine.target, NEW_CHAT);
  assert.equal(routine.nextRunAt, Date.UTC(2026, 0, 6, 9, 0));
  assert.deepEqual(createRoutineStore(options).get(routine.id), routine);
  assert.deepEqual(store.list(), [routine]);
});

test("create gives a Heartbeat the 7 day end unless it names one, and a trigger none", () => {
  const { store } = setup();
  const heartbeat = { ...spec, trigger: HOURLY, target: { kind: "chat", chatId: "c1" } };
  assert.equal(store.create(heartbeat).expiresAt, START + 7 * DAY);
  assert.equal(store.create({ ...heartbeat, name: "b", maxRuns: 3 }).expiresAt, undefined);
  assert.equal(store.create({ ...heartbeat, name: "c", expiresAt: START + DAY }).expiresAt, START + DAY);
  assert.equal(store.create({ ...heartbeat, name: "d", createdBy: { kind: "agent", chatId: "c1" } }).createdBy.chatId, "c1");
  assert.equal(store.create({ ...spec, name: "e" }).expiresAt, undefined);
  assert.equal(store.create({ ...spec, name: "f", trigger: linear() }).expiresAt, undefined);
  assert.equal(store.create({ ...spec, name: "g", trigger: webhook(OTHER_HOOK), maxRuns: 4, expiresAt: START + DAY }).maxRuns, 4);
});

test("a webhook trigger that doesn't say is unsigned, on create and on update", () => {
  const { store } = setup();
  const routine = store.create({ ...spec, trigger: { kind: "webhook", hookId: HOOK } });
  assert.deepEqual(routine.trigger, webhook(HOOK, false));
  const signed = store.update(routine.id, { trigger: webhook(HOOK, true) });
  assert.equal(signed.trigger.signed, true);
  assert.equal(store.update(routine.id, { trigger: { kind: "webhook", hookId: OTHER_HOOK } }).trigger.signed, false);
});

test("create keeps only a trigger's own fields and gives a webhook or Linear trigger no schedule", () => {
  const { store, clock } = setup();
  const hooked = store.create({
    ...spec,
    trigger: { ...webhook(HOOK.toUpperCase(), true), extra: "x" },
    provider: "codex",
    model: "gpt-5",
    permissionMode: "plan",
  });
  assert.deepEqual(hooked.trigger, { kind: "webhook", hookId: HOOK, signed: true });
  assert.equal(hooked.provider, "codex");
  assert.equal(hooked.model, "gpt-5");
  assert.equal(hooked.permissionMode, "plan");
  assert.equal(hooked.nextRunAt ?? null, null);
  const labelled = store.create({ ...spec, name: "l", trigger: { ...linear("label-added", { team: "MIL", label: "agent" }), junk: 1 } });
  assert.deepEqual(labelled.trigger, { kind: "linear", workspace: "acme", event: "label-added", team: "MIL", label: "agent" });
  assert.equal(labelled.nextRunAt ?? null, null);
  const state = store.create({ ...spec, name: "s", trigger: linear("state", { state: "Todo" }) });
  assert.deepEqual(state.trigger, { kind: "linear", workspace: "acme", event: "state", state: "Todo" });
  clock.t += 400 * DAY;
  assert.deepEqual(store.claimDue(clock.t), []);
  assert.deepEqual(store.runs(hooked.id), []);
});

test("create rejects what a Routine cannot be, and saves nothing", () => {
  const { store, options } = setup();
  const bad = (patch, pattern) => assert.throws(() => store.create({ ...spec, ...patch }), pattern, JSON.stringify(patch));
  const chatTarget = { kind: "chat", chatId: "c1" };
  bad({ trigger: linear(), target: chatTarget }, /Only schedule triggers can target an existing Chat/);
  bad({ trigger: webhook(), target: chatTarget }, /Only schedule triggers can target an existing Chat/);
  bad({ name: "", trigger: { kind: "linear" }, target: chatTarget }, /Only schedule triggers can target an existing Chat/);
  bad({ trigger: { kind: "webhook" }, target: { kind: "chat" }, createdBy: undefined }, /Only schedule triggers can target an existing Chat/);
  bad({ maxRuns: "3" }, /maxRuns/);
  for (const maxRuns of [0, -1, 1001, 1.5, NaN, Infinity, true, []]) bad({ maxRuns }, /maxRuns/);
  bad({ trigger: webhook("x") }, /hookId/);
  bad({ trigger: webhook(HOOK.slice(1)) }, /hookId/);
  bad({ trigger: webhook(`${HOOK}0`) }, /hookId/);
  bad({ trigger: webhook("g".repeat(64)) }, /hookId/);
  bad({ trigger: { kind: "webhook", hookId: HOOK, signed: "yes" } }, /signed/);
  bad({ trigger: { kind: "webhook", signed: false } }, /hookId/);
  bad({ name: "" }, /name/);
  bad({ name: "   " }, /name/);
  bad({ name: 5 }, /name/);
  bad({ name: "n".repeat(81) }, /name/);
  bad({ prompt: "" }, /prompt/);
  bad({ prompt: undefined }, /prompt/);
  bad({ prompt: "p".repeat(4001) }, /prompt/);
  bad({ expiresAt: NaN }, /expiresAt/);
  bad({ expiresAt: Infinity }, /expiresAt/);
  bad({ expiresAt: "soon" }, /expiresAt/);
  bad({ expiresAt: START + 31 * DAY }, /at most 30d/);
  bad({ trigger: { kind: "schedule", cron: "nope", timezone: "UTC" } }, /Invalid cron/);
  bad({ trigger: { kind: "schedule", cron: "* * * * *", timezone: "Mars/Base" } }, /Invalid cron/);
  bad({ trigger: { kind: "schedule", cron: "* * * * *" } }, /timezone/);
  bad({ trigger: { kind: "schedule", timezone: "UTC" } }, /cron/);
  bad({ trigger: { kind: "linear", workspace: "acme", event: "deleted" } }, /event/);
  bad({ trigger: { kind: "linear", event: "assigned" } }, /workspace/);
  for (const key of ["team", "label", "state"]) bad({ trigger: linear("assigned", { [key]: 5 }) }, new RegExp(key));
  bad({ trigger: { kind: "email" } }, /trigger kind/);
  bad({ trigger: undefined }, /trigger/);
  bad({ trigger: "webhook" }, /trigger/);
  bad({ target: { kind: "new-chat", projectPath: "/repo", workspace: "elsewhere" } }, /workspace/);
  bad({ target: { kind: "new-chat", projectPath: "", workspace: "project" } }, /projectPath/);
  bad({ target: { kind: "new-chat", workspace: "project" } }, /projectPath/);
  bad({ trigger: HOURLY, target: { kind: "chat" } }, /chatId/);
  bad({ target: { kind: "folder" } }, /target kind/);
  bad({ target: undefined }, /target/);
  bad({ createdBy: undefined }, /createdBy/);
  bad({ createdBy: { kind: "agent" } }, /createdBy/);
  bad({ createdBy: { kind: "robot" } }, /createdBy/);
  bad({ provider: 5 }, /provider/);
  bad({ model: "" }, /model/);
  bad({ permissionMode: {} }, /permissionMode/);
  assert.throws(() => store.create(undefined), /Routine/);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(options.file), false);
});

test("create accepts the edges of every limit", () => {
  const { store } = setup();
  const routine = store.create({ ...spec, name: "n".repeat(80), prompt: "p".repeat(4000), maxRuns: 1000, expiresAt: START + 30 * DAY });
  assert.equal(routine.name.length, 80);
  assert.equal(routine.prompt.length, 4000);
  assert.equal(routine.maxRuns, 1000);
  assert.equal(routine.expiresAt, START + 30 * DAY);
  assert.equal(store.create({ ...spec, name: "one", trigger: webhook(OTHER_HOOK), maxRuns: 1, provider: null, model: null, expiresAt: null }).maxRuns, 1);
});

test("create returns a copy", () => {
  const { store } = setup();
  const routine = store.create(spec);
  routine.name = "mutated";
  routine.trigger.hookId = "bad";
  assert.equal(store.get(routine.id).name, "triage");
  assert.equal(store.get(routine.id).trigger.hookId, HOOK);
});

test("create refuses a webhook another live Routine already uses, but not one that ended", () => {
  const { store } = setup();
  const first = store.create(spec);
  assert.throws(() => store.create({ ...spec, name: "again" }), /webhook/);
  assert.throws(() => store.create({ ...spec, name: "again", trigger: webhook(HOOK.toUpperCase()) }), /webhook/);
  store.update(first.id, { enabled: false });
  assert.throws(() => store.create({ ...spec, name: "again" }), /webhook/);
  assert.equal(store.list().length, 1);
  store.complete(first.id, "done");
  assert.equal(store.create({ ...spec, name: "again" }).trigger.hookId, HOOK);
});

test("update can't change a Routine's trigger or target kind", () => {
  const { store } = setup();
  const heartbeat = store.upsertHeartbeat(base);
  assert.throws(() => store.update(heartbeat.id, { trigger: { kind: "webhook" } }), /trigger kind/);
  assert.throws(() => store.update(heartbeat.id, { trigger: webhook() }), /trigger kind/);
  assert.throws(() => store.update(heartbeat.id, { target: NEW_CHAT }), /target kind/);
  const hooked = store.create(spec);
  assert.throws(() => store.update(hooked.id, { target: { kind: "chat", chatId: "c1" } }), /target kind/);
  assert.throws(() => store.update(hooked.id, { trigger: linear() }), /trigger kind/);
  assert.deepEqual(store.get(hooked.id), hooked);
  assert.equal(store.get(heartbeat.id).trigger.kind, "schedule");
});

test("update replaces a trigger or target after validating it, and a webhook can change its hookId", () => {
  const { store } = setup();
  const routine = store.create(spec);
  const rotated = store.update(routine.id, { trigger: webhook(OTHER_HOOK, true) });
  assert.deepEqual(rotated.trigger, webhook(OTHER_HOOK, true));
  assert.deepEqual(store.hookIds(), [OTHER_HOOK]);
  store.create({ ...spec, name: "other", trigger: webhook(HOOK) });
  assert.throws(() => store.update(routine.id, { trigger: webhook(HOOK) }), /webhook/);
  assert.deepEqual(store.get(routine.id).trigger, webhook(OTHER_HOOK, true));
  assert.deepEqual(store.update(routine.id, { trigger: webhook(OTHER_HOOK, false) }).trigger, webhook(OTHER_HOOK, false));
  assert.throws(() => store.update(routine.id, { trigger: webhook("x") }), /hookId/);
  assert.throws(() => store.update(routine.id, { trigger: "webhook" }), /trigger/);
  const moved = store.update(routine.id, { target: { kind: "new-chat", projectPath: "/other", workspace: "project" } });
  assert.deepEqual(moved.target, { kind: "new-chat", projectPath: "/other", workspace: "project" });
  assert.throws(() => store.update(routine.id, { target: { kind: "new-chat", projectPath: "/other", workspace: "nope" } }), /workspace/);
  assert.throws(() => store.update(routine.id, { target: "x" }), /target/);
  assert.deepEqual(store.get(routine.id).target, moved.target);
});

test("update reschedules a schedule trigger, and a Linear or webhook trigger never gets a nextRunAt", () => {
  const { store } = setup();
  const issues = store.create({ ...spec, trigger: linear("assigned") });
  const updated = store.update(issues.id, { trigger: linear("state", { state: "Todo" }) });
  assert.deepEqual(updated.trigger, { kind: "linear", workspace: "acme", event: "state", state: "Todo" });
  assert.throws(() => store.update(issues.id, { cron: "0 * * * *" }), /schedule/);
  assert.throws(() => store.update(issues.id, { timezone: "UTC" }), /schedule/);
  store.update(issues.id, { enabled: false });
  assert.equal(store.update(issues.id, { enabled: true }).nextRunAt ?? null, null);
  const hooked = store.create({ ...spec, name: "h" });
  store.update(hooked.id, { enabled: false });
  assert.equal(store.update(hooked.id, { enabled: true, name: "h2" }).nextRunAt ?? null, null);
  const scheduled = store.create({ ...spec, name: "s", trigger: HOURLY });
  assert.equal(scheduled.nextRunAt, START + 3600_000);
  const changed = store.update(scheduled.id, { trigger: { kind: "schedule", cron: "30 * * * *", timezone: "UTC" } });
  assert.equal(changed.nextRunAt, START + 30 * 60_000);
  assert.throws(() => store.update(scheduled.id, { trigger: { kind: "schedule", cron: "nope", timezone: "UTC" } }), /Invalid cron/);
  assert.equal(store.get(scheduled.id).trigger.cron, "30 * * * *");
  assert.equal(store.update(scheduled.id, { cron: "15 * * * *" }).nextRunAt, START + 15 * 60_000);
  const both = store.update(scheduled.id, { trigger: { kind: "schedule", cron: "45 * * * *", timezone: "UTC" }, cron: "5 * * * *" });
  assert.equal(both.trigger.cron, "5 * * * *");
  assert.equal(both.nextRunAt, START + 5 * 60_000);
});

test("update validates the type of everything it sets, and a failed update changes nothing", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  clock.t += 1000;
  const bad = (patch, pattern) => assert.throws(() => store.update(routine.id, patch), pattern, JSON.stringify(patch));
  bad({ name: "" }, /name/);
  bad({ name: 5 }, /name/);
  bad({ name: "n".repeat(81) }, /name/);
  bad({ prompt: "" }, /prompt/);
  bad({ prompt: "p".repeat(4001) }, /prompt/);
  bad({ enabled: "yes" }, /enabled/);
  bad({ enabled: null }, /enabled/);
  for (const maxRuns of ["3", 0, 1001, 1.5, NaN, true]) bad({ maxRuns }, /maxRuns/);
  bad({ provider: 5 }, /provider/);
  bad({ model: "" }, /model/);
  bad({ permissionMode: false }, /permissionMode/);
  bad({ expiresAt: "soon" }, /expiresAt/);
  bad({ expiresAt: NaN }, /expiresAt/);
  bad({ expiresAt: clock.t + 31 * DAY }, /at most 30d/);
  bad({ name: "fine", maxRuns: "3" }, /maxRuns/);
  assert.deepEqual(store.get(routine.id), routine);
  const set = store.update(routine.id, { provider: "codex", model: "gpt-5", permissionMode: "plan", maxRuns: 10, expiresAt: clock.t + DAY });
  assert.deepEqual([set.provider, set.model, set.permissionMode, set.maxRuns, set.expiresAt], ["codex", "gpt-5", "plan", 10, clock.t + DAY]);
  const cleared = store.update(routine.id, { provider: null, model: null, permissionMode: null, maxRuns: null, expiresAt: null });
  for (const key of ["provider", "model", "permissionMode", "maxRuns", "expiresAt"]) assert.equal(key in cleared, false, key);
});

test("a trigger needs no end, a Heartbeat still does", () => {
  const { store } = setup();
  const routine = store.create({ ...spec, maxRuns: 5, expiresAt: START + DAY });
  const open = store.update(routine.id, { maxRuns: null, expiresAt: null });
  assert.equal(open.maxRuns, undefined);
  assert.equal(open.expiresAt, undefined);
  const heartbeat = store.create({ ...spec, name: "hb", trigger: HOURLY, target: { kind: "chat", chatId: "c1" } });
  assert.throws(() => store.update(heartbeat.id, { expiresAt: null }), /Heartbeats need an end/);
  const scheduled = store.create({ ...spec, name: "sched", trigger: HOURLY });
  assert.equal(store.update(scheduled.id, { expiresAt: null }).expiresAt, undefined);
});

test("enqueue queues an event once: the same key again is seen, even after its Run finished", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  assert.deepEqual(store.enqueue(routine.id, delivery(1)), { queued: true });
  assert.deepEqual(store.enqueue(routine.id, delivery(1)), { queued: false, reason: "seen" });
  assert.deepEqual(store.enqueue(routine.id, { ...delivery(1), deliveryId: "another" }), { queued: false, reason: "seen" });
  const [claim] = store.claimQueued(clock.t);
  store.finishRun(claim.run.id, { status: "acted" });
  assert.deepEqual(store.enqueue(routine.id, delivery(1)), { queued: false, reason: "seen" });
  const other = store.create({ ...spec, name: "o", trigger: webhook(OTHER_HOOK) });
  assert.deepEqual(store.enqueue(other.id, delivery(1)), { queued: true });
  assert.deepEqual(createRoutineStore(options).enqueue(routine.id, delivery(1)), { queued: false, reason: "seen" });
});

test("enqueue keeps the event it was given apart from the caller's object", () => {
  const { store, clock } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  const event = change(1, "comment");
  store.enqueue(routine.id, event);
  event.issue.title = "changed after";
  const [claim] = store.claimQueued(clock.t);
  assert.equal(claim.run.event.issue.title, "Fix it");
  claim.run.event.issue.title = "changed in the claim";
  assert.equal(store.runs(routine.id)[0].event.issue.title, "Fix it");
});

test("enqueue remembers every event key of a Routine, past the old cap of 500", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  for (let n = 0; n <= 500; n += 1) {
    assert.equal(store.enqueue(routine.id, delivery(n)).queued, true, String(n));
    for (const claim of store.claimQueued(clock.t)) store.finishRun(claim.run.id, { status: "quiet" });
  }
  assert.deepEqual(store.enqueue(routine.id, delivery(500)), { queued: false, reason: "seen" });
  assert.deepEqual(store.enqueue(routine.id, delivery(1)), { queued: false, reason: "seen" });
  assert.deepEqual(store.enqueue(routine.id, delivery(0)), { queued: false, reason: "seen" });
});

test("enqueue drops events for a disabled, paused or completed Routine and records no Run", () => {
  const { store } = setup();
  const routine = store.create(spec);
  store.update(routine.id, { enabled: false });
  assert.deepEqual(store.enqueue(routine.id, delivery(1)), { queued: false, reason: "disabled" });
  store.update(routine.id, { enabled: true });
  assert.deepEqual(store.enqueue(routine.id, delivery(1)), { queued: true });
  store.pause(routine.id, "Project is gone");
  assert.deepEqual(store.enqueue(routine.id, delivery(2)), { queued: false, reason: "disabled" });
  store.complete(routine.id, "done");
  assert.deepEqual(store.enqueue(routine.id, delivery(3)), { queued: false, reason: "disabled" });
  assert.deepEqual(store.enqueue("nope", delivery(3)), { queued: false, reason: "disabled" });
  assert.deepEqual(store.runs(routine.id), []);
});

test("enqueue takes only a Linear or webhook event with a key", () => {
  const { store } = setup();
  const routine = store.create(spec);
  assert.throws(() => store.enqueue(routine.id, { kind: "schedule" }), /event/);
  assert.throws(() => store.enqueue(routine.id, { kind: "webhook", deliveryId: "d" }), /key/);
  assert.throws(() => store.enqueue(routine.id, { kind: "webhook", key: "", deliveryId: "d" }), /key/);
  assert.throws(() => store.enqueue(routine.id, null), /event/);
  assert.deepEqual(store.enqueue(routine.id, delivery(1)), { queued: true });
});

test("the 21st queued event records a missed Run, and its key counts as seen", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 20; n += 1) assert.deepEqual(store.enqueue(routine.id, delivery(n)), { queued: true }, String(n));
  clock.t += 5000;
  assert.deepEqual(store.enqueue(routine.id, delivery(21)), { queued: false, reason: "full" });
  const [run] = store.runs(routine.id);
  assert.equal(store.runs(routine.id).length, 1);
  assert.equal(run.status, "missed");
  assert.equal(run.error, "queue full");
  assert.deepEqual(run.event, delivery(21));
  assert.equal(run.startedAt, clock.t);
  assert.equal(run.endedAt, clock.t);
  assert.equal(store.get(routine.id).runCount, 0);
  assert.deepEqual(store.enqueue(routine.id, delivery(21)), { queued: false, reason: "seen" });
  assert.equal(store.runs(routine.id).length, 1);
  assert.deepEqual(
    saved(options).queues[routine.id].map((item) => item.event.key),
    Array.from({ length: 20 }, (_, n) => `hook:${n + 1}`),
  );
  assert.equal(store.claimQueued(clock.t).length, 3);
  assert.deepEqual(store.enqueue(routine.id, delivery(22)), { queued: true });
});

test("claimQueued claims up to three at a time per Routine, oldest first, as running Runs carrying their event", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 5; n += 1) {
    clock.t += 1000;
    store.enqueue(routine.id, delivery(n));
  }
  const at = clock.t + 5000;
  const claims = store.claimQueued(at, 3);
  assert.deepEqual(
    claims.map((claim) => claim.run.event),
    [delivery(1), delivery(2), delivery(3)],
  );
  for (const [index, claim] of claims.entries()) {
    assert.equal(claim.routine.id, routine.id);
    assert.equal(claim.run.routineId, routine.id);
    assert.equal(claim.run.status, "running");
    assert.equal(claim.run.startedAt, at);
    assert.equal(claim.run.scheduledFor, START + 1000 * (index + 1));
  }
  assert.deepEqual(store.claimQueued(at, 3), []);
  assert.equal(store.runs(routine.id).length, 3);
  store.finishRun(claims[1].run.id, { status: "acted" });
  assert.deepEqual(
    store.claimQueued(at, 3).map((claim) => claim.run.event.key),
    ["hook:4"],
  );
  assert.deepEqual(store.claimQueued(at), []);
  store.finishRun(claims[0].run.id, { status: "quiet" });
  assert.deepEqual(
    store.claimQueued(at).map((claim) => claim.run.event.key),
    ["hook:5"],
  );
  assert.deepEqual(store.claimQueued(at), []);
});

test("claimQueued takes a limit, and counts only the Routine's own running Runs", () => {
  const { store, clock } = setup();
  const a = store.create(spec);
  const b = store.create({ ...spec, name: "b", trigger: webhook(OTHER_HOOK) });
  for (let n = 1; n <= 4; n += 1) {
    store.enqueue(a.id, delivery(n));
    store.enqueue(b.id, delivery(n));
  }
  const first = store.claimQueued(clock.t, 1);
  assert.deepEqual(
    first.map((claim) => [claim.routine.id, claim.run.event.key]),
    [
      [a.id, "hook:1"],
      [b.id, "hook:1"],
    ],
  );
  assert.equal(store.claimQueued(clock.t, 2).length, 2);
  assert.equal(store.claimQueued(clock.t, 2).length, 0);
  assert.equal(store.claimQueued(clock.t, 4).length, 4);
  assert.equal(store.claimQueued(clock.t, 4).length, 0);
  assert.equal(store.runs(a.id).length, 4);
  assert.equal(store.runs(b.id).length, 4);
});

test("claimQueued leaves a disabled, paused or completed Routine's queue alone", () => {
  const { store, clock, options } = setup();
  const off = store.create(spec);
  const done = store.create({ ...spec, name: "done", trigger: webhook(OTHER_HOOK) });
  for (const routine of [off, done]) store.enqueue(routine.id, delivery(1));
  store.update(off.id, { enabled: false });
  store.complete(done.id, "done");
  assert.deepEqual(store.claimQueued(clock.t), []);
  assert.deepEqual(store.runs(off.id), []);
  assert.equal(saved(options).queues[off.id].length, 1);
  store.update(off.id, { enabled: true });
  assert.deepEqual(
    store.claimQueued(clock.t).map((claim) => claim.run.event.key),
    ["hook:1"],
  );
});

test("claimQueued writes the store file once per call, and not at all when it claims nothing", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 5; n += 1) store.enqueue(routine.id, delivery(n));
  assert.equal(
    countSaves(() => assert.equal(store.claimQueued(clock.t, 3).length, 3)),
    1,
  );
  assert.equal(
    countSaves(() => assert.equal(store.claimQueued(clock.t, 3).length, 0)),
    0,
  );
  assert.equal(
    countSaves(() => store.claimQueued(clock.t, 0)),
    0,
  );
});

test("claimQueued never starts more Runs than a Routine's maxRuns leaves", () => {
  const { store, clock } = setup();
  const routine = store.create({ ...spec, maxRuns: 2 });
  for (let n = 1; n <= 5; n += 1) store.enqueue(routine.id, delivery(n));
  const claims = store.claimQueued(clock.t, 3);
  assert.equal(claims.length, 2);
  store.finishRun(claims[0].run.id, { status: "acted" });
  assert.deepEqual(store.claimQueued(clock.t, 3), []);
  const done = store.finishRun(claims[1].run.id, { status: "acted" });
  assert.equal(done.runCount, 2);
  assert.ok(done.completedAt);
  assert.deepEqual(store.claimQueued(clock.t, 3), []);
});

test("a Routine whose maxRuns was lowered to what already ran ends at the next claim, with its queue", () => {
  for (const maxRuns of [3, 1]) {
    const { store, clock, options } = setup();
    const routine = store.create({ ...spec, trigger: linear("assigned"), maxRuns: 10 });
    for (let n = 1; n <= 3; n += 1) store.enqueue(routine.id, change(n));
    for (const claim of store.claimQueued(clock.t, 3)) store.finishRun(claim.run.id, { status: "acted" });
    for (let n = 4; n <= 5; n += 1) store.enqueue(routine.id, change(n));
    assert.equal(store.update(routine.id, { maxRuns }).completedAt, undefined);
    assert.equal(saved(options).queues[routine.id].length, 2);
    clock.t += 1000;
    assert.deepEqual(store.claimQueued(clock.t, 3), [], String(maxRuns));
    const ended = store.get(routine.id);
    assert.equal(ended.completedAt, clock.t);
    assert.equal(ended.enabled, false);
    assert.equal(ended.runCount, 3);
    assert.equal(saved(options).queues[routine.id], undefined);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.enqueue(routine.id, change(6)), { queued: false, reason: "disabled" });
    assert.deepEqual(
      store.runs(routine.id).filter((run) => run.status !== "acted"),
      [],
    );
  }
});

test("a Routine whose maxRuns was lowered while a Run is still going keeps its queue until that Run ends it", () => {
  const { store, clock, options } = setup();
  const routine = store.create({ ...spec, maxRuns: 10 });
  for (let n = 1; n <= 3; n += 1) store.enqueue(routine.id, delivery(n));
  const claims = store.claimQueued(clock.t, 3);
  store.finishRun(claims[0].run.id, { status: "acted" });
  store.finishRun(claims[1].run.id, { status: "acted" });
  store.enqueue(routine.id, delivery(4));
  store.update(routine.id, { maxRuns: 2 });
  assert.deepEqual(store.claimQueued(clock.t, 3), []);
  assert.equal(store.get(routine.id).completedAt, undefined);
  assert.equal(saved(options).queues[routine.id].length, 1);
  assert.ok(store.finishRun(claims[2].run.id, { status: "acted" }).completedAt);
});

test("claimQueued turns a Linear comment that waited more than 2 h into a missed Run, not a claim", () => {
  const { store, clock } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  const hours = 3600_000;
  store.enqueue(routine.id, change(1, "comment"));
  store.enqueue(routine.id, change(2, "assigned"));
  clock.t = START + hours;
  store.enqueue(routine.id, change(3, "comment"));
  clock.t = START + 2 * hours;
  const exactly = store.claimQueued(clock.t, 1);
  assert.deepEqual(
    exactly.map((claim) => claim.run.event.key),
    [change(1, "comment").key],
  );
  store.finishRun(exactly[0].run.id, { status: "acted" });
  clock.t = START + 2 * hours + 1;
  const late = store.claimQueued(clock.t, 3);
  assert.deepEqual(
    late.map((claim) => claim.run.event.key),
    [change(2).key, change(3, "comment").key],
  );
  clock.t = START + 3 * hours + 1;
  store.enqueue(routine.id, change(4, "comment"));
  store.enqueue(routine.id, change(5, "comment"));
  store.enqueue(routine.id, change(6, "comment"));
  clock.t += 2 * hours + 1;
  store.enqueue(routine.id, change(7, "comment"));
  for (const claim of late) store.finishRun(claim.run.id, { status: "quiet" });
  const fresh = store.claimQueued(clock.t, 3);
  assert.deepEqual(
    fresh.map((claim) => claim.run.event.key),
    [change(7, "comment").key],
  );
  const missed = store.runs(routine.id).filter((run) => run.status === "missed");
  assert.deepEqual(
    missed.map((run) => run.event.key),
    [change(6, "comment").key, change(5, "comment").key, change(4, "comment").key],
  );
  for (const run of missed) {
    assert.equal(run.error, "comment waited 2 h");
    assert.equal(run.endedAt, clock.t);
    assert.equal(run.startedAt, clock.t);
  }
  assert.equal(store.get(routine.id).runCount, 3);
});

test("a comment that waited more than 2 h is missed even while the Routine's Runs are all busy", () => {
  const { store, clock } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  for (let n = 1; n <= 4; n += 1) store.enqueue(routine.id, change(n, "comment"));
  assert.equal(store.claimQueued(clock.t, 3).length, 3);
  clock.t = START + 2 * 3600_000 + 1;
  assert.deepEqual(store.claimQueued(clock.t, 3), []);
  const missed = store.runs(routine.id).filter((run) => run.status === "missed");
  assert.deepEqual(
    missed.map((run) => run.event.key),
    [change(4, "comment").key],
  );
});

test("deferRun puts the event back at the head with notBefore, and claimQueued skips it until then", () => {
  const { store, clock, options } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  for (let n = 1; n <= 4; n += 1) {
    clock.t += 1000;
    store.enqueue(routine.id, change(n, "comment"));
  }
  const [first, second, third] = store.claimQueued(clock.t, 3);
  const until = clock.t + 15_000;
  assert.equal(store.deferRun(second.run.id, until), true);
  assert.deepEqual(
    store
      .runs(routine.id)
      .map((run) => run.id)
      .toSorted(),
    [first.run.id, third.run.id].toSorted(),
  );
  assert.equal(store.get(routine.id).runCount, 0);
  const queue = saved(options).queues[routine.id];
  assert.deepEqual(
    queue.map((item) => item.event.key),
    [change(2, "comment").key, change(4, "comment").key],
  );
  assert.equal(queue[0].notBefore, until);
  assert.equal(queue[0].enqueuedAt, second.run.scheduledFor);
  assert.deepEqual(queue[0].event, second.run.event);
  assert.equal(typeof queue[0].id, "string");
  assert.notEqual(queue[0].id, second.run.id);
  assert.equal(queue[1].notBefore, undefined);
  const early = store.claimQueued(until - 1, 3);
  assert.deepEqual(
    early.map((claim) => claim.run.event.key),
    [change(4, "comment").key],
  );
  assert.deepEqual(store.claimQueued(until, 3), []);
  store.finishRun(first.run.id, { status: "acted" });
  const later = store.claimQueued(until, 3);
  assert.deepEqual(
    later.map((claim) => claim.run.event),
    [change(2, "comment")],
  );
  assert.equal(later[0].run.scheduledFor, second.run.scheduledFor);
  assert.equal(later[0].run.startedAt, until);
  assert.notEqual(later[0].run.id, second.run.id);
  assert.deepEqual(store.enqueue(routine.id, change(2, "comment")), { queued: false, reason: "seen" });
});

test("deferring a Run again keeps its first enqueue time, so a deferred comment still ends after 2 h", () => {
  const { store, clock } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  store.enqueue(routine.id, change(1, "comment"));
  const [claim] = store.claimQueued(clock.t + 1000, 3);
  assert.equal(store.deferRun(claim.run.id, clock.t + 16_000), true);
  const [again] = store.claimQueued(clock.t + 16_000, 3);
  assert.equal(again.run.scheduledFor, START);
  assert.equal(store.deferRun(again.run.id, clock.t + 31_000), true);
  assert.deepEqual(store.claimQueued(START + 2 * 3600_000 + 1, 3), []);
  const [run] = store.runs(routine.id);
  assert.equal(run.status, "missed");
  assert.equal(run.error, "comment waited 2 h");
  assert.deepEqual(run.event, change(1, "comment"));
  assert.equal(store.runs(routine.id).length, 1);
});

test("Runs deferred in claim order come back in that order, ahead of the events that arrived after them", () => {
  const { store, clock, options } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  const keys = [1, 2, 3, 4].map((n) => change(n, "comment").key);
  // All four arrive in the same millisecond, where the arrival time alone can't tell them apart.
  for (let n = 1; n <= 4; n += 1) store.enqueue(routine.id, change(n, "comment"));
  const claims = store.claimQueued(clock.t, 3);
  assert.deepEqual(
    claims.map((claim) => claim.run.event.key),
    keys.slice(0, 3),
  );
  const until = clock.t + 15_000;
  for (const claim of claims) assert.equal(store.deferRun(claim.run.id, until), true);
  assert.deepEqual(
    saved(options).queues[routine.id].map((item) => item.event.key),
    keys,
  );
  assert.deepEqual(
    store.claimQueued(until, 3).map((claim) => claim.run.event.key),
    keys.slice(0, 3),
  );
});

test("a deferred Run goes back where its event's arrival puts it, whichever Run is deferred first", () => {
  const { store, clock, options } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  const keys = [1, 2, 3, 4].map((n) => change(n, "comment").key);
  for (let n = 1; n <= 4; n += 1) {
    clock.t += 1000;
    store.enqueue(routine.id, change(n, "comment"));
  }
  const claims = store.claimQueued(clock.t, 3);
  const until = clock.t + 15_000;
  for (const index of [2, 0, 1]) assert.equal(store.deferRun(claims[index].run.id, until), true);
  const queued = () => saved(options).queues[routine.id].map((item) => item.event.key);
  assert.deepEqual(queued(), keys);
  const [first] = store.claimQueued(until, 1);
  assert.equal(first.run.event.key, keys[0]);
  assert.equal(store.deferRun(first.run.id, until + 15_000), true);
  assert.deepEqual(queued(), keys);
  assert.deepEqual(
    store.claimQueued(until, 3).map((claim) => claim.run.event.key),
    [keys[1], keys[2], keys[3]],
  );
});

// Comment `n` on issue `issue`: several comments can share an issue, unlike change()'s.
const commentOn = (n, issue, over = {}) => ({
  ...change(issue, "comment"),
  key: `linear-comment:c${n}`,
  comment: { id: `c${n}`, body: `ping ${n}`, author: "Ana", createdAt: START },
  ...over,
});
const claimedKeys = (claims) => claims.map((claim) => claim.run.event.key);

test("a comment waiting for its busy Chat holds back the later comments on its issue, and no other issue's", () => {
  const { store, clock } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  store.enqueue(routine.id, commentOn(1, 1));
  const [first] = store.claimQueued(clock.t, 3);
  // Its Chat was busy.
  assert.equal(store.deferRun(first.run.id, START + 15_000), true);
  clock.t = START + 5_000;
  store.enqueue(routine.id, commentOn(2, 1));
  store.enqueue(routine.id, commentOn(3, 2));
  assert.deepEqual(claimedKeys(store.claimQueued(clock.t, 3)), ["linear-comment:c3"]);
  clock.t = START + 15_000;
  assert.deepEqual(claimedKeys(store.claimQueued(clock.t, 3)), ["linear-comment:c1", "linear-comment:c2"]);
});

test("a comment is held by its issue's id too, so a move to another team doesn't let it overtake", () => {
  const { store, clock } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  store.enqueue(routine.id, commentOn(1, 1));
  const [first] = store.claimQueued(clock.t, 3);
  assert.equal(store.deferRun(first.run.id, START + 15_000), true);
  const moved = commentOn(2, 1);
  store.enqueue(routine.id, { ...moved, issue: { ...moved.issue, key: "WEB-9" } });
  assert.deepEqual(store.claimQueued(START + 5_000, 3), []);
  assert.deepEqual(claimedKeys(store.claimQueued(START + 15_000, 3)), ["linear-comment:c1", "linear-comment:c2"]);
});

test("a comment that waited too long is missed and no longer holds back the next one on its issue", () => {
  const { store, clock } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  store.enqueue(routine.id, commentOn(1, 1));
  const [first] = store.claimQueued(clock.t, 3);
  const late = START + 2 * 3600_000 + 1;
  assert.equal(store.deferRun(first.run.id, late + 15_000), true);
  clock.t = START + 2 * 3600_000;
  store.enqueue(routine.id, commentOn(2, 1));
  assert.deepEqual(claimedKeys(store.claimQueued(late, 3)), ["linear-comment:c2"]);
  const missed = store.runs(routine.id).find((run) => run.status === "missed");
  assert.equal(missed.event.key, "linear-comment:c1");
});

test("deferRun refuses a Run that is not running, has no event, or does not exist", () => {
  const { store, clock, options } = setup();
  const routine = store.create({ ...spec, trigger: linear("comment") });
  store.enqueue(routine.id, change(1, "comment"));
  const [claim] = store.claimQueued(clock.t, 3);
  const manual = store.startRun(routine.id, clock.t);
  const before = fs.readFileSync(options.file, "utf8");
  assert.equal(store.deferRun(manual.run.id, clock.t + 1000), false);
  assert.equal(store.deferRun("nope", clock.t + 1000), false);
  assert.throws(() => store.deferRun(claim.run.id, "soon"), /notBefore/);
  assert.throws(() => store.deferRun(claim.run.id, NaN), /notBefore/);
  assert.equal(fs.readFileSync(options.file, "utf8"), before);
  store.finishRun(claim.run.id, { status: "acted" });
  assert.equal(store.deferRun(claim.run.id, clock.t + 1000), false);
  assert.equal(fs.readFileSync(options.file, "utf8").includes('"notBefore"'), false);
  assert.equal(store.runs(routine.id).length, 2);
});

test("attachChat records the Chat and Worktree a Run started in", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 2; n += 1) store.enqueue(routine.id, delivery(n));
  const [one, two] = store.claimQueued(clock.t, 3);
  assert.equal(store.attachChat(one.run.id, { chatId: "/repo#s1", worktreeId: "w1" }), true);
  assert.equal(store.attachChat(two.run.id, { chatId: "/repo#s2" }), true);
  const runs = Object.fromEntries(store.runs(routine.id).map((run) => [run.id, run]));
  assert.equal(runs[one.run.id].chatId, "/repo#s1");
  assert.equal(runs[one.run.id].worktreeId, "w1");
  assert.equal(runs[two.run.id].chatId, "/repo#s2");
  assert.equal("worktreeId" in runs[two.run.id], false);
  assert.equal(
    createRoutineStore(options)
      .runs(routine.id)
      .find((run) => run.id === one.run.id).worktreeId,
    "w1",
  );
  assert.equal(store.attachChat("nope", { chatId: "c" }), false);
  assert.throws(() => store.attachChat(one.run.id, { chatId: "" }), /chatId/);
  assert.throws(() => store.attachChat(one.run.id, {}), /chatId/);
  assert.throws(
    () => store.attachChat(one.run.id, null),
    (error) => !(error instanceof TypeError) && /chatId/.test(error.message),
  );
  assert.throws(() => store.attachChat(one.run.id, { chatId: "c", worktreeId: 5 }), /worktreeId/);
  assert.equal(store.runs(routine.id).find((run) => run.id === one.run.id).chatId, "/repo#s1");
  assert.equal(store.finishRun(one.run.id, { status: "acted", chatId: "/repo#s1" }).runCount, 1);
});

test("pause switches a Routine off with a reason and keeps it listed; switching it on clears the reason", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  clock.t += 1000;
  const paused = store.pause(routine.id, "Project is gone");
  assert.equal(paused.enabled, false);
  assert.equal(paused.pausedReason, "Project is gone");
  assert.equal(paused.completedAt, undefined);
  assert.equal(paused.updatedAt, clock.t);
  assert.deepEqual(
    store.list().map((item) => item.id),
    [routine.id],
  );
  assert.equal(store.update(routine.id, { name: "renamed" }).pausedReason, "Project is gone");
  assert.equal(store.pause("nope", "x"), null);
  assert.throws(() => store.pause(routine.id, ""), /reason/);
  assert.throws(() => store.pause(routine.id, 5), /reason/);
  const back = store.update(routine.id, { enabled: true });
  assert.equal(back.enabled, true);
  assert.equal("pausedReason" in back, false);
  store.complete(routine.id, "done");
  assert.equal(store.pause(routine.id, "late"), null);
  assert.equal("pausedReason" in store.get(routine.id), false);
});

test("three failed Runs in a row pause a trigger instead of ending it; switching it on starts the count over", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  let n = 0;
  const start = () => {
    store.enqueue(routine.id, delivery((n += 1)));
    return store.claimQueued(clock.t, 3)[0];
  };
  const fail = (claim, error) => store.finishRun(claim.run.id, { status: "failed", error });
  assert.equal(fail(start(), "boom 1").failedStreak, 1);
  assert.equal(fail(start(), "boom 2").enabled, true);
  const third = start();
  store.enqueue(routine.id, delivery(100));
  const paused = fail(third, "boom 3");
  assert.equal(paused.enabled, false);
  assert.equal(paused.pausedReason, "3 failed runs in a row: boom 3");
  assert.equal(paused.failedStreak, 3);
  assert.equal(paused.runCount, 3);
  assert.equal(paused.completedAt, undefined);
  assert.deepEqual(
    store.list().map((item) => item.id),
    [routine.id],
  );
  assert.equal(store.runs(routine.id)[0].error, "boom 3");
  assert.deepEqual(store.enqueue(routine.id, delivery(99)), { queued: false, reason: "disabled" });
  assert.deepEqual(store.claimQueued(clock.t, 3), []);
  assert.equal(saved(options).queues[routine.id].length, 1);
  const back = store.update(routine.id, { enabled: true });
  assert.equal(back.enabled, true);
  assert.equal("pausedReason" in back, false);
  assert.equal(back.failedStreak ?? 0, 0);
  const waiting = store.claimQueued(clock.t, 3);
  assert.deepEqual(
    waiting.map((claim) => claim.run.event.key),
    ["hook:100"],
  );
  assert.equal(fail(waiting[0], "again 1").failedStreak, 1);
  assert.equal(fail(start(), "again 2").enabled, true);
});

test("a success resets a trigger's failure count and a skipped Run does not, and a pause keeps an earlier reason", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  let n = 0;
  const start = () => {
    store.enqueue(routine.id, delivery((n += 1)));
    return store.claimQueued(clock.t, 3)[0];
  };
  const finish = (status, error) => store.finishRun(start().run.id, { status, error });
  finish("failed", "e");
  finish("failed", "e");
  assert.equal(finish("skipped-busy").failedStreak, 2);
  assert.equal(finish("quiet").failedStreak, 0);
  finish("failed", "e");
  finish("acted");
  finish("failed", "e");
  assert.equal(finish("failed", "e").enabled, true);
  const late = start();
  store.pause(routine.id, "Project is gone");
  assert.equal(store.finishRun(late.run.id, { status: "failed", error: "late failure" }).pausedReason, "Project is gone");
});

test("a schedule trigger pauses on three failed Runs too, and a Heartbeat still ends", () => {
  const { store } = setup();
  const scheduled = store.create({ ...spec, trigger: HOURLY });
  const heartbeat = store.upsertHeartbeat(base);
  for (const routine of [scheduled, heartbeat]) {
    for (let i = 0; i < 3; i += 1) {
      const { run } = store.startRun(routine.id, START);
      store.finishRun(run.id, { status: "failed" });
    }
  }
  const trigger = store.get(scheduled.id);
  assert.equal(trigger.enabled, false);
  assert.equal(trigger.pausedReason, "3 failed runs in a row");
  assert.equal(trigger.completedAt, undefined);
  const ended = store.get(heartbeat.id);
  assert.ok(ended.completedAt);
  assert.equal("pausedReason" in ended, false);
  assert.deepEqual(
    store.list().map((item) => item.id),
    [scheduled.id],
  );
});

test("setLastError sets and clears a Routine's last error, and writes only when it changes", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  clock.t += 1000;
  assert.equal(store.setLastError(routine.id, "Linear sign-in needed").lastError, "Linear sign-in needed");
  assert.equal(store.get(routine.id).updatedAt, clock.t);
  assert.equal(createRoutineStore(options).get(routine.id).lastError, "Linear sign-in needed");
  assert.equal(
    countSaves(() => store.setLastError(routine.id, "Linear sign-in needed")),
    0,
  );
  assert.equal(
    countSaves(() => store.setLastError(routine.id, "offline")),
    1,
  );
  assert.equal(
    countSaves(() => store.setLastError(routine.id, null)),
    1,
  );
  assert.equal("lastError" in store.get(routine.id), false);
  assert.equal(
    countSaves(() => store.setLastError(routine.id, null)),
    0,
  );
  assert.equal(store.setLastError("nope", "x"), null);
  assert.throws(() => store.setLastError(routine.id, 5), /lastError/);
  assert.throws(() => store.setLastError(routine.id, ""), /lastError/);
  assert.equal("lastError" in store.get(routine.id), false);
});

test("Linear cursors are kept per workspace and survive a restart", () => {
  const { store, options } = setup();
  assert.equal(store.linearCursor("acme"), undefined);
  assert.equal(store.linearCursor("constructor"), undefined);
  store.setLinearCursor("acme", 1000);
  store.setLinearCursor("beta", 2000);
  store.setLinearCursor("acme", 3000);
  assert.equal(store.linearCursor("acme"), 3000);
  assert.equal(store.linearCursor("beta"), 2000);
  assert.equal(store.linearCursor("gamma"), undefined);
  const again = createRoutineStore(options);
  assert.equal(again.linearCursor("acme"), 3000);
  assert.equal(again.linearCursor("beta"), 2000);
  assert.equal(
    countSaves(() => store.setLinearCursor("acme", 3000)),
    0,
  );
  assert.throws(() => store.setLinearCursor("", 1), /workspace/);
  assert.throws(() => store.setLinearCursor(5, 1), /workspace/);
  assert.throws(() => store.setLinearCursor("acme", NaN), /cursor/);
  assert.throws(() => store.setLinearCursor("acme", "soon"), /cursor/);
  assert.equal(store.linearCursor("acme"), 3000);
  assert.throws(() => store.linearCursor(5), /workspace/);
});

test("hookIds lists the webhooks of enabled, live webhook Routines only", () => {
  const { store } = setup();
  const live = store.create({ ...spec, name: "live", trigger: webhook(hex("1")) });
  const off = store.create({ ...spec, name: "off", trigger: webhook(hex("2")) });
  const done = store.create({ ...spec, name: "done", trigger: webhook(hex("3")) });
  const paused = store.create({ ...spec, name: "paused", trigger: webhook(hex("4")) });
  store.create({ ...spec, name: "linear", trigger: linear() });
  store.create({ ...spec, name: "schedule", trigger: HOURLY });
  store.upsertHeartbeat(base);
  store.update(off.id, { enabled: false });
  store.complete(done.id, "done");
  store.pause(paused.id, "Project is gone");
  assert.deepEqual(store.hookIds(), [hex("1")]);
  store.update(live.id, { trigger: webhook(hex("5")) });
  store.update(off.id, { enabled: true });
  assert.deepEqual(store.hookIds(), [hex("5"), hex("2")]);
});

test("queues, seen keys and cursors survive a store re-created on the same file", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 5; n += 1) store.enqueue(routine.id, delivery(n));
  store.claimQueued(clock.t, 3);
  store.setLinearCursor("acme", 4242);
  const again = createRoutineStore(options);
  assert.equal(again.linearCursor("acme"), 4242);
  assert.deepEqual(again.enqueue(routine.id, delivery(5)), { queued: false, reason: "seen" });
  assert.equal(again.claimQueued(clock.t, 3).length, 0);
  for (const run of again.runs(routine.id)) again.finishRun(run.id, { status: "acted" });
  assert.deepEqual(
    again.claimQueued(clock.t, 3).map((claim) => claim.run.event.key),
    ["hook:4", "hook:5"],
  );
  assert.deepEqual(Object.keys(saved(options)).toSorted(), [
    "linear",
    "pullRequests",
    "queues",
    "rejections",
    "removed",
    "routines",
    "runs",
    "seen",
    "version",
  ]);
});

test("remove deletes a Routine's queue and seen keys, and keeps the Linear cursors", () => {
  const { store, options } = setup();
  const routine = store.create(spec);
  const keep = store.create({ ...spec, name: "keep", trigger: webhook(OTHER_HOOK) });
  for (const item of [routine, keep]) store.enqueue(item.id, delivery(1));
  store.setLinearCursor("acme", 7);
  assert.equal(store.remove(routine.id), true);
  const file = saved(options);
  assert.deepEqual(Object.keys(file.queues), [keep.id]);
  assert.deepEqual(Object.keys(file.seen), [keep.id]);
  assert.deepEqual(file.linear, { acme: 7 });
  assert.deepEqual(store.enqueue(keep.id, delivery(1)), { queued: false, reason: "seen" });
});

test("a file saved before triggers existed loads with empty queues, and a damaged one is cleaned", () => {
  const { file, options } = setup();
  fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, routines: [], runs: {} }));
  const old = createRoutineStore(options);
  assert.equal(old.linearCursor("acme"), undefined);
  const routine = old.create(spec);
  assert.deepEqual(old.enqueue(routine.id, delivery(1)), { queued: true });
  assert.deepEqual(saved(options).linear, {});
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, enabled: false, routines: [], runs: {}, queues: { x: "junk" }, seen: [], linear: { acme: "soon", beta: 5 } }),
  );
  const damaged = createRoutineStore(options);
  assert.equal(damaged.linearCursor("acme"), undefined);
  assert.equal(damaged.linearCursor("beta"), 5);
  damaged.setLinearCursor("beta", 6);
  assert.deepEqual(saved(options).queues, {});
  assert.deepEqual(saved(options).seen, {});
  assert.deepEqual(saved(options).linear, { beta: 6 });
});

test("recoverInterrupted fails running Runs, an event's included, and keeps what is still queued", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 5; n += 1) store.enqueue(routine.id, delivery(n));
  store.claimQueued(clock.t, 3);
  clock.t += 3600_000;
  const restarted = createRoutineStore(options);
  restarted.recoverInterrupted();
  const runs = restarted.runs(routine.id);
  assert.equal(runs.length, 3);
  for (const run of runs) {
    assert.equal(run.status, "failed");
    assert.equal(run.error, "daemon restarted");
    assert.equal(run.endedAt, clock.t);
    assert.equal(typeof run.event.key, "string");
  }
  assert.deepEqual(
    saved(options).queues[routine.id].map((item) => item.event.key),
    ["hook:4", "hook:5"],
  );
  assert.deepEqual(
    restarted.claimQueued(clock.t, 3).map((claim) => claim.run.event.key),
    ["hook:4", "hook:5"],
  );
});

test("a restart is one failure, however many Runs it cut short, so it does not pause a busy trigger", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 3; n += 1) store.enqueue(routine.id, delivery(n));
  store.claimQueued(clock.t, 3);
  const restarted = createRoutineStore(options);
  restarted.recoverInterrupted();
  const after = restarted.get(routine.id);
  assert.equal(after.failedStreak, 1);
  assert.equal(after.runCount, 3);
  assert.equal(after.enabled, true);
  assert.equal("pausedReason" in after, false);
  for (let n = 4; n <= 5; n += 1) restarted.enqueue(routine.id, delivery(n));
  for (let n = 0; n < 2; n += 1) {
    for (const claim of restarted.claimQueued(clock.t, 3)) restarted.finishRun(claim.run.id, { status: "failed", error: "boom" });
  }
  assert.equal(restarted.get(routine.id).enabled, false);
  assert.equal(restarted.get(routine.id).pausedReason, "3 failed runs in a row: boom");
});

test("a flood of missed Runs never pushes out a Run that is still running", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 3; n += 1) store.enqueue(routine.id, delivery(n));
  const claims = store.claimQueued(clock.t, 3);
  for (let n = 4; n <= 100; n += 1) store.enqueue(routine.id, delivery(n));
  const runs = store.runs(routine.id);
  assert.equal(runs.length, 53);
  assert.equal(runs.filter((run) => run.status === "running").length, 3);
  assert.equal(runs.filter((run) => run.status === "missed").length, 50);
  assert.notEqual(store.finishRun(claims[0].run.id, { status: "acted" }), null);
  assert.equal(store.runs(routine.id).length, 53);
});

// Hardening (Astra review): failed writes, batches, seen keys by age, retention, load safety and schedules with no next run.

// Runs `fn` with `fs[method]` failing like the disk would. A failing writeFileSync leaves a partial temp file behind first.
function failing(method, fn, code = "EIO") {
  const original = fs[method];
  fs[method] = (...args) => {
    if (method === "writeFileSync") original(args[0], "partial");
    throw Object.assign(new Error(`${code}: injected ${method} failure`), { code });
  };
  try {
    return fn();
  } finally {
    fs[method] = original;
  }
}

const bytes = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const temps = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));

for (const method of ["writeFileSync", "renameSync"]) {
  test(`a failed ${method} in claimQueued leaves memory and disk as they were, and the same events are claimed next time`, () => {
    const { store, clock, dir, file } = setup();
    const routine = store.create(spec);
    for (let n = 1; n <= 5; n += 1) store.enqueue(routine.id, delivery(n));
    const before = bytes(file);
    assert.throws(() => failing(method, () => store.claimQueued(clock.t, 3)), /injected/);
    assert.equal(bytes(file), before);
    assert.deepEqual(temps(dir), []);
    assert.deepEqual(store.runs(routine.id), []);
    assert.deepEqual(
      store.claimQueued(clock.t, 3).map((claim) => claim.run.event.key),
      ["hook:1", "hook:2", "hook:3"],
    );
    assert.equal(store.runs(routine.id).filter((run) => run.status === "running").length, 3);
  });

  test(`a failed ${method} in enqueue, claimDue, finishRun and create changes nothing`, () => {
    const { store, clock, dir, file } = setup();
    const trigger = store.create(spec);
    let before = bytes(file);
    assert.throws(() => failing(method, () => store.enqueue(trigger.id, delivery(1))), /injected/);
    assert.equal(bytes(file), before);
    assert.deepEqual(store.enqueue(trigger.id, delivery(1)), { queued: true });

    const heartbeat = store.upsertHeartbeat(base);
    clock.t = heartbeat.nextRunAt;
    before = bytes(file);
    assert.throws(() => failing(method, () => store.claimDue(clock.t)), /injected/);
    assert.equal(bytes(file), before);
    assert.equal(store.get(heartbeat.id).nextRunAt, heartbeat.nextRunAt);
    assert.deepEqual(store.runs(heartbeat.id), []);
    const [claim] = store.claimDue(clock.t);
    assert.equal(claim.routine.id, heartbeat.id);

    before = bytes(file);
    assert.throws(() => failing(method, () => store.finishRun(claim.run.id, { status: "acted" })), /injected/);
    assert.equal(bytes(file), before);
    assert.equal(store.runs(heartbeat.id)[0].status, "running");
    assert.equal(store.get(heartbeat.id).runCount, 0);
    assert.equal(store.finishRun(claim.run.id, { status: "acted" }).runCount, 1);

    before = bytes(file);
    const count = store.list().length;
    assert.throws(() => failing(method, () => store.create({ ...spec, name: "other", trigger: webhook(OTHER_HOOK) })), /injected/);
    assert.equal(bytes(file), before);
    assert.equal(store.list().length, count);
    assert.deepEqual(temps(dir), []);
    assert.equal(store.create({ ...spec, name: "other", trigger: webhook(OTHER_HOOK) }).name, "other");
  });
}

test("enqueueMany queues a batch with one write and answers each event in order, like enqueue", () => {
  const { store } = setup();
  const routine = store.create(spec);
  const other = store.create({ ...spec, name: "other", trigger: webhook(OTHER_HOOK) });
  const items = [
    ...Array.from({ length: 30 }, (_, n) => ({ routineId: routine.id, event: delivery(n + 1) })),
    ...Array.from({ length: 170 }, (_, n) => ({ routineId: other.id, event: delivery(n + 1) })),
  ];
  let results;
  assert.equal(
    countSaves(() => (results = store.enqueueMany(items))),
    1,
  );
  assert.equal(results.length, 200);
  assert.deepEqual(
    results.slice(0, 20),
    Array.from({ length: 20 }, () => ({ queued: true })),
  );
  assert.deepEqual(
    results.slice(20, 30),
    Array.from({ length: 10 }, () => ({ queued: false, reason: "full" })),
  );
  assert.deepEqual(
    results.slice(30, 50),
    Array.from({ length: 20 }, () => ({ queued: true })),
  );
  // A full queue answers every overflow event with a missed Run, in the same write.
  const missed = store.runs(routine.id);
  assert.equal(missed.length, 10);
  assert.ok(missed.every((run) => run.status === "missed" && run.error === "queue full"));
  assert.deepEqual(
    missed.map((run) => run.event.key).toReversed(),
    Array.from({ length: 10 }, (_, n) => `hook:${n + 21}`),
  );
  // Nothing new: no write at all. A key twice in one batch is seen the second time.
  assert.equal(
    countSaves(() =>
      assert.deepEqual(
        store.enqueueMany(items.slice(0, 3)),
        Array.from({ length: 3 }, () => ({ queued: false, reason: "seen" })),
      ),
    ),
    0,
  );
  assert.deepEqual(
    store.enqueueMany([
      { routineId: routine.id, event: delivery(99) },
      { routineId: routine.id, event: delivery(99) },
      { routineId: "nope", event: delivery(99) },
    ]),
    [
      { queued: false, reason: "full" },
      { queued: false, reason: "seen" },
      { queued: false, reason: "disabled" },
    ],
  );
  assert.throws(() => store.enqueueMany([{ routineId: routine.id, event: { kind: "schedule" } }]), /event/);
  assert.throws(() => store.enqueueMany("nope"), /array/);
});

test("a burst of 600 events, each run, then all 600 again, starts no second Run", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  for (let n = 0; n < 600; n += 1) {
    assert.deepEqual(store.enqueue(routine.id, delivery(n)), { queued: true }, String(n));
    for (const claim of store.claimQueued(clock.t)) store.finishRun(claim.run.id, { status: "quiet" });
    clock.t += 10;
  }
  for (let n = 0; n < 600; n += 1) assert.deepEqual(store.enqueue(routine.id, delivery(n)), { queued: false, reason: "seen" }, String(n));
  assert.deepEqual(store.claimQueued(clock.t), []);
  assert.equal(store.get(routine.id).runCount, 600);
});

test("seen keys are kept 48 h, then pruned, except the keys of queued and running events", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  store.enqueue(routine.id, delivery(1));
  for (const claim of store.claimQueued(clock.t)) store.finishRun(claim.run.id, { status: "acted" });
  store.enqueue(routine.id, delivery(2));
  const [running] = store.claimQueued(clock.t);
  store.update(routine.id, { enabled: false });
  store.update(routine.id, { enabled: true });
  for (let n = 3; n <= 5; n += 1) store.enqueue(routine.id, delivery(n));
  // Nothing is claimed for 48 h: hook:2 runs and hook:3-5 wait (the Routine is full).
  store.enqueue(routine.id, delivery(6));
  store.enqueue(routine.id, delivery(7));
  clock.t += 47 * 3600_000;
  assert.deepEqual(store.enqueue(routine.id, delivery(1)), { queued: false, reason: "seen" });
  clock.t += 2 * 3600_000;
  store.enqueue(routine.id, delivery(8));
  const keys = saved(options).seen[routine.id];
  assert.ok(keys.every((entry) => typeof entry.key === "string" && Number.isFinite(entry.at)));
  assert.deepEqual(keys.map((entry) => entry.key).toSorted(), ["hook:2", "hook:3", "hook:4", "hook:5", "hook:6", "hook:7", "hook:8"]);
  assert.equal(running.run.event.key, "hook:2");
  // Pruned, hook:1 is new again.
  assert.deepEqual(store.enqueue(routine.id, delivery(1)), { queued: true });
});

test("seen keys saved as plain strings load as seen now", () => {
  const { store, clock, options, file } = setup();
  const routine = store.create(spec);
  const text = saved(options);
  text.seen = { [routine.id]: ["hook:1"] };
  fs.writeFileSync(file, JSON.stringify(text));
  clock.t += 1000;
  const again = createRoutineStore(options);
  assert.deepEqual(again.enqueue(routine.id, delivery(1)), { queued: false, reason: "seen" });
  assert.deepEqual(again.enqueue(routine.id, delivery(2)), { queued: true });
  assert.deepEqual(saved(options).seen[routine.id], [
    { key: "hook:1", at: clock.t },
    { key: "hook:2", at: clock.t },
  ]);
});

test("past 5000 young seen keys a Routine refuses new events with a missed Run instead of forgetting any", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  const results = store.enqueueMany(Array.from({ length: 5001 }, (_, n) => ({ routineId: routine.id, event: delivery(n) })));
  assert.deepEqual(results.at(-1), { queued: false, reason: "too-many" });
  assert.equal(results.filter((result) => result.reason === "too-many").length, 1);
  const [refused] = store.runs(routine.id);
  assert.equal(refused.status, "missed");
  assert.equal(refused.error, "too many events");
  assert.equal(refused.event.key, "hook:5000");
  assert.deepEqual(store.enqueue(routine.id, delivery(0)), { queued: false, reason: "seen" });
  // Once the old keys pass 48 h they make room.
  clock.t += 49 * 3600_000;
  assert.deepEqual(store.enqueue(routine.id, delivery(5000)), { queued: false, reason: "full" });
});

test("a missed or skipped flood keeps the newest 50 of them and leaves the Runs that ran alone", () => {
  const { store, clock } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 10; n += 1) {
    store.enqueue(routine.id, delivery(n));
    for (const claim of store.claimQueued(clock.t)) store.finishRun(claim.run.id, { status: "acted" });
  }
  for (let n = 11; n <= 30; n += 1) store.enqueue(routine.id, delivery(n));
  for (let n = 31; n <= 90; n += 1) store.enqueue(routine.id, delivery(n));
  const runs = store.runs(routine.id);
  assert.equal(runs.filter((run) => run.status === "acted").length, 10);
  const missed = runs.filter((run) => run.status === "missed");
  assert.equal(missed.length, 50);
  assert.equal(missed.at(-1).event.key, "hook:41");
});

test("complete clears the Routine's queue and seen keys", () => {
  const { store, options } = setup();
  const routine = store.create(spec);
  const keep = store.create({ ...spec, name: "keep", trigger: webhook(OTHER_HOOK) });
  for (const item of [routine, keep]) for (let n = 1; n <= 3; n += 1) store.enqueue(item.id, delivery(n));
  store.complete(routine.id, "done");
  const file = saved(options);
  assert.deepEqual(Object.keys(file.queues), [keep.id]);
  assert.deepEqual(Object.keys(file.seen), [keep.id]);
});

test("a completed Routine goes 30 days after it ended, with its Runs and the Linear cursor only it used, on load", () => {
  const { store, clock, options } = setup();
  const alone = store.create({ ...spec, name: "alone", trigger: linear("assigned", { workspace: "Solo" }) });
  const shared = store.create({ ...spec, name: "shared", trigger: linear("assigned") });
  const sibling = store.create({ ...spec, name: "sibling", trigger: linear("comment") });
  store.setLinearCursor("solo", 1);
  store.setLinearCursor("solo:comments", 2);
  store.setLinearCursor("acme", 3);
  store.setLinearCursor("acme:comments", 4);
  for (const routine of [alone, shared]) {
    store.enqueue(routine.id, change(1));
    for (const claim of store.claimQueued(clock.t)) store.finishRun(claim.run.id, { status: "acted" });
    store.complete(routine.id, "done");
  }
  const ended = clock.t;
  clock.t = ended + 30 * DAY - 1;
  assert.notEqual(createRoutineStore(options).get(alone.id), null);
  clock.t = ended + 30 * DAY;
  const later = createRoutineStore(options);
  for (const routine of [alone, shared]) {
    assert.equal(later.get(routine.id), null);
    assert.deepEqual(later.runs(routine.id), []);
    assert.equal(later.finishRun(`id-of-${routine.id}`, { status: "acted" }), null);
  }
  assert.equal(later.linearCursor("solo"), undefined);
  assert.equal(later.linearCursor("solo:comments"), undefined);
  assert.equal(later.linearCursor("acme"), 3);
  assert.equal(later.linearCursor("acme:comments"), 4);
  assert.notEqual(later.get(sibling.id), null);
  later.setLinearCursor("acme", 5);
  const file = saved(options);
  assert.deepEqual(
    file.routines.map((routine) => routine.id),
    [sibling.id],
  );
  assert.deepEqual(Object.keys(file.runs), []);
});

test("a running store purges ended Routines from claimDue, at most once an hour", () => {
  const { store, clock } = setup();
  const first = store.create({ ...spec, name: "first" });
  store.complete(first.id, "done");
  clock.t += 30 * DAY;
  store.claimDue(clock.t);
  assert.equal(store.get(first.id), null);
  const second = store.create({ ...spec, name: "second", trigger: webhook(OTHER_HOOK) });
  store.complete(second.id, "done");
  clock.t += 30 * DAY - 30 * 60_000;
  store.claimDue(clock.t);
  assert.notEqual(store.get(second.id), null);
  clock.t += 31 * 60_000;
  store.claimDue(clock.t);
  assert.notEqual(store.get(second.id), null, "the last purge was less than an hour ago");
  clock.t += 30 * 60_000;
  store.claimDue(clock.t);
  assert.equal(store.get(second.id), null);
});

test("a Run is found by id after trims, purges and a reload", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  for (let n = 1; n <= 3; n += 1) store.enqueue(routine.id, delivery(n));
  const claims = store.claimQueued(clock.t);
  assert.equal(store.attachChat(claims[0].run.id, { chatId: "c1" }), true);
  const again = createRoutineStore(options);
  assert.notEqual(again.finishRun(claims[1].run.id, { status: "acted" }), null);
  assert.equal(again.remove(routine.id), true);
  assert.equal(again.finishRun(claims[2].run.id, { status: "acted" }), null);
  assert.equal(again.attachChat(claims[2].run.id, { chatId: "c1" }), false);
});

function captureErrors(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    return { value: fn(), logged };
  } finally {
    console.error = original;
  }
}

for (const code of ["EACCES", "EIO"]) {
  test(`a store file that can't be read (${code}) opens read-only and is never written`, () => {
    const { store, options, file, dir } = setup();
    store.create(spec);
    const before = bytes(file);
    const { value: blind, logged } = captureErrors(() => failing("readFileSync", () => createRoutineStore(options), code));
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(code));
    assert.deepEqual(blind.list(), []);
    for (const mutate of [
      () => blind.create({ ...spec, name: "x" }),
      () => blind.upsertHeartbeat(base),
      () => blind.setLinearCursor("acme", 5),
      () => blind.enqueueMany([]),
    ]) {
      assert.throws(mutate, /^Error: Routine store is read-only: /);
    }
    assert.equal(bytes(file), before);
    assert.deepEqual(fs.readdirSync(dir), ["routines.json"]);
    assert.equal(captureErrors(() => blind.list()).logged.length, 0);
  });
}

test("a file from a newer version opens read-only", () => {
  const { file, options } = setup();
  const text = JSON.stringify({ version: 2, enabled: true, routines: [], runs: {}, journal: [] });
  fs.writeFileSync(file, text);
  const { value: store, logged } = captureErrors(() => createRoutineStore(options));
  assert.equal(logged.length, 1);
  assert.throws(() => store.upsertHeartbeat(base), /Routine store is read-only: .*version 2/);
  assert.match(store.readOnlyReason(), /version 2/);
  // A daemon start recovers interrupted Runs: a store that holds none and can't write has nothing to recover.
  store.recoverInterrupted();
  assert.equal(bytes(file), text);
});

test("a file of the wrong shape opens read-only rather than being moved aside", () => {
  const { file, options, dir } = setup();
  const text = JSON.stringify({ version: 1, routines: {}, runs: {} });
  fs.writeFileSync(file, text);
  const { value: store } = captureErrors(() => createRoutineStore(options));
  assert.throws(() => store.create(spec), /Routine store is read-only/);
  assert.equal(bytes(file), text);
  assert.deepEqual(fs.readdirSync(dir), ["routines.json"]);
});

test("invalid Routines and Runs are quarantined next to the store and the valid ones load", () => {
  const { store, clock, options, file, dir } = setup();
  const good = store.create(spec);
  store.enqueue(good.id, delivery(1));
  const [claim] = store.claimQueued(clock.t);
  const text = saved(options);
  const brokenRun = { id: "r-bad", routineId: good.id, status: "exploded" };
  const orphanOwner = { ...text.routines[0], id: "bad1", trigger: { kind: "carrier-pigeon" } };
  text.routines = [null, text.routines[0], orphanOwner, { ...text.routines[0], id: "bad2", createdAt: "yesterday" }, 7];
  text.runs[good.id].push(brokenRun);
  text.runs.bad1 = [{ id: "r-orphan", routineId: "bad1", status: "acted" }];
  fs.writeFileSync(file, JSON.stringify(text));
  clock.t += 1000;
  const again = createRoutineStore(options);
  assert.deepEqual(
    again.list().map((routine) => routine.id),
    [good.id],
  );
  assert.deepEqual(
    again.runs(good.id).map((run) => run.id),
    [claim.run.id],
  );
  assert.deepEqual(again.claimDue(clock.t), []);
  const invalid = path.join(dir, "routines.invalid.json");
  assert.equal(fs.statSync(invalid).mode & 0o777, 0o600);
  const [entry] = JSON.parse(fs.readFileSync(invalid, "utf8"));
  assert.equal(entry.at, clock.t);
  assert.deepEqual(entry.routines, [null, orphanOwner, text.routines[3], 7]);
  assert.deepEqual(entry.runs, [brokenRun, ...text.runs.bad1]);
  // The live store no longer holds them, and a second load quarantines nothing more.
  assert.deepEqual(
    saved(options).routines.map((routine) => routine.id),
    [good.id],
  );
  createRoutineStore(options);
  assert.equal(JSON.parse(fs.readFileSync(invalid, "utf8")).length, 1);
  assert.equal(bytes(`${file}.corrupt`), null);
});

const LEAP_DAY = { kind: "schedule", cron: "0 0 29 2 *", timezone: "UTC" };

test("a leap-day schedule made in March 2028 fires on 2032-02-29", () => {
  const { store, clock } = setup();
  clock.t = Date.UTC(2028, 2, 1, 12);
  const routine = store.create({ ...spec, trigger: LEAP_DAY });
  assert.equal(routine.nextRunAt, Date.UTC(2032, 1, 29));
  clock.t = routine.nextRunAt;
  const [claim] = store.claimDue(clock.t);
  assert.equal(claim.routine.id, routine.id);
  assert.equal(store.get(routine.id).nextRunAt, Date.UTC(2036, 1, 29));
});

// A store holding a schedule with no next run (the file was edited, or saved by a Milagre that took it), next to a good one.
function withImpossibleSchedule() {
  const ctx = setup();
  const bad = ctx.store.create({ ...spec, name: "bad", trigger: HOURLY });
  const good = ctx.store.create({ ...spec, name: "good", trigger: HOURLY });
  const text = saved(ctx.options);
  text.routines.find((routine) => routine.id === bad.id).trigger.cron = "0 0 31 2 *";
  fs.writeFileSync(ctx.file, JSON.stringify(text));
  ctx.clock.t = good.nextRunAt;
  return { ...ctx, bad, good, store: createRoutineStore(ctx.options) };
}

test("a schedule with no next run pauses itself with lastError, and the other Routines of the tick still fire", () => {
  const { store, clock, bad, good } = withImpossibleSchedule();
  const claims = store.claimDue(clock.t);
  assert.deepEqual(
    claims.map((claim) => claim.routine.id),
    [good.id],
  );
  const paused = store.get(bad.id);
  assert.equal(paused.enabled, false);
  assert.equal(paused.pausedReason, "schedule has no next run");
  assert.equal(paused.lastError, "No run within 8 years");
  assert.deepEqual(store.runs(bad.id), []);
  assert.deepEqual(store.claimDue(clock.t + 3600_000).length, 1);
});

test("startup recovery with a schedule that has no next run does not throw", () => {
  const { store, clock, bad, good } = withImpossibleSchedule();
  store.claimDue(clock.t);
  const ctx = withImpossibleSchedule();
  ctx.clock.t += 2 * 3600_000;
  ctx.store.recoverInterrupted();
  assert.equal(ctx.store.get(ctx.bad.id).pausedReason, "schedule has no next run");
  assert.equal(ctx.store.get(ctx.good.id).nextRunAt, ctx.good.nextRunAt + 3 * 3600_000);
  assert.ok(store.get(good.id).enabled && !store.get(bad.id).enabled);
});

test("an event is only queued for a Routine whose trigger is of its kind", () => {
  const { store } = setup();
  const schedule = store.create({ ...spec, name: "s", trigger: { kind: "schedule", cron: "0 8 * * *", timezone: "UTC" } });
  const linear = store.create({ ...spec, name: "l", trigger: { kind: "linear", workspace: "acme", event: "assigned" } });
  const hook = store.create({ ...spec, name: "w" });
  assert.deepEqual(store.enqueue(schedule.id, delivery(1)), { queued: false, reason: "kind" });
  assert.deepEqual(store.enqueue(linear.id, delivery(2)), { queued: false, reason: "kind" });
  assert.deepEqual(
    store.enqueueMany([
      { routineId: hook.id, event: { kind: "linear", key: "linear:i:h", change: "assigned", issue: {} } },
      { routineId: hook.id, event: delivery(3) },
    ]),
    [{ queued: false, reason: "kind" }, { queued: true }],
  );
  assert.deepEqual(store.runs(schedule.id), []);
});

test("rejectEvent records a failed Run that doesn't count toward a pause, and remembers its key", () => {
  const { store, clock } = setup();
  const hook = store.create({ ...spec, trigger: webhook(HOOK, true) });
  for (let n = 1; n <= 4; n += 1) {
    clock.t += 1000;
    const run = store.rejectEvent(hook.id, delivery(n), "signature mismatch");
    assert.equal(run.status, "failed");
    assert.equal(run.error, "signature mismatch");
    assert.equal(run.startedAt, clock.t);
    assert.equal(run.endedAt, clock.t);
    assert.deepEqual(run.event, delivery(n));
  }
  const routine = store.get(hook.id);
  assert.equal(routine.enabled, true, "not paused");
  assert.equal(routine.failedStreak ?? 0, 0);
  assert.equal(routine.runCount, 0);
  assert.equal(store.runs(hook.id).length, 4);
  assert.deepEqual(store.enqueue(hook.id, delivery(1)), { queued: false, reason: "seen" });
  assert.equal(store.rejectEvent(hook.id, delivery(1), "signature mismatch"), null, "a redelivery adds no second Run");
  assert.equal(store.runs(hook.id).length, 4);
  assert.equal(store.rejectEvent("missing", delivery(9), "signature mismatch"), null);
  const schedule = store.create({ ...spec, name: "s", trigger: { kind: "schedule", cron: "0 8 * * *", timezone: "UTC" } });
  assert.equal(store.rejectEvent(schedule.id, delivery(10), "signature mismatch"), null);
});

test("a webhook Routine keeps the header its signature comes in, lowercased; only webhooks take one", () => {
  const { store, options } = setup();
  const hook = store.create({ ...spec, trigger: webhook(HOOK, true), signingHeader: "X-Hub-Signature-256" });
  assert.equal(hook.signingHeader, "x-hub-signature-256");
  assert.equal(createRoutineStore(options).get(hook.id).signingHeader, "x-hub-signature-256");
  assert.equal(store.create({ ...spec, name: "plain", trigger: webhook(OTHER_HOOK) }).signingHeader, undefined);
  assert.equal(store.update(hook.id, { signingHeader: "Sentry-Hook-Signature" }).signingHeader, "sentry-hook-signature");
  assert.equal(store.update(hook.id, { signingHeader: null }).signingHeader, undefined);
  assert.throws(() => store.update(hook.id, { signingHeader: "bad header" }), /header name/);
  assert.throws(() => store.create({ ...spec, name: "bad", trigger: webhook("ef".repeat(32)), signingHeader: "a:b" }), /header name/);
  const schedule = store.create({ ...spec, name: "s", trigger: HOURLY });
  assert.throws(() => store.update(schedule.id, { signingHeader: "x-sig" }), /webhook/);
  assert.throws(() => store.create({ ...spec, name: "s2", trigger: HOURLY, signingHeader: "x-sig" }), /webhook/);
});

test("a flood of bad signatures takes no place in the seen ledger and keeps the file bounded; a good delivery still runs", () => {
  const { store, clock, file } = setup();
  const hook = store.create({ ...spec, trigger: webhook(HOOK, true) });
  for (let n = 1; n <= 6000; n += 1) {
    clock.t += 1;
    store.rejectEvent(hook.id, delivery(n), "signature mismatch");
  }
  // The newest 50 rejections stay listed, with how many there were.
  const rejected = store.runs(hook.id).filter((run) => run.error === "signature mismatch");
  assert.equal(rejected.length, 50);
  const keys = new Set(rejected.map((run) => run.event.key));
  assert.ok(keys.has("hook:6000") && keys.has("hook:5951") && !keys.has("hook:5950"));
  assert.equal(store.rejections(hook.id), 6000);
  assert.ok(fs.statSync(file).size < 64 * 1024, `routines.json is ${fs.statSync(file).size} bytes`);
  // A redelivery of a recent rejection is still answered once.
  assert.equal(store.rejectEvent(hook.id, delivery(6000), "signature mismatch"), null);
  assert.deepEqual(store.enqueue(hook.id, delivery(6000)), { queued: false, reason: "seen" });
  // A valid delivery is admitted: the seen ledger has room.
  assert.deepEqual(store.enqueue(hook.id, delivery(7000)), { queued: true });
  // The count survives a restart; a deleted Routine takes it along.
  const reopened = createRoutineStore({ file, now: () => clock.t });
  assert.equal(reopened.rejections(hook.id), 6000);
  reopened.remove(hook.id);
  assert.equal(reopened.rejections(hook.id), 0);
});

test("a queue that can't move on this tick is checked without copying the store", () => {
  const { store, clock, file } = setup();
  const hook = store.create({ ...spec });
  store.enqueue(hook.id, delivery(1));
  store.enqueue(hook.id, delivery(2));
  store.enqueue(hook.id, delivery(3));
  store.enqueue(hook.id, delivery(4));
  assert.equal(store.claimQueued(clock.t, 3).length, 3);
  // Three Runs going and one event waiting: nothing can move, so nothing is written.
  const written = fs.statSync(file).mtimeMs;
  const before = fs.readFileSync(file, "utf8");
  const original = structuredClone;
  let clones = 0;
  globalThis.structuredClone = (value) => {
    clones += 1;
    return original(value);
  };
  try {
    assert.deepEqual(store.claimQueued(clock.t, 3), []);
  } finally {
    globalThis.structuredClone = original;
  }
  assert.equal(clones, 0, "no transaction copy");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.statSync(file).mtimeMs, written);
});

test("the store says which Routines its upkeep purged, so their webhook secrets go with them", () => {
  const { options, clock } = setup();
  const purged = [];
  const store = createRoutineStore({ ...options, onPurged: (ids) => purged.push(...ids) });
  const hook = store.create({ ...spec });
  store.complete(hook.id, "done");
  // 30 days on, the hourly upkeep purges it on the next write.
  clock.t += 31 * 864e5;
  store.create({ ...spec, name: "other", trigger: webhook(OTHER_HOOK) });
  assert.deepEqual(purged, [hook.id]);
  // A purge on load says so too.
  const loaded = [];
  const other = store.list()[0];
  store.complete(other.id, "done");
  clock.t += 31 * 864e5;
  createRoutineStore({ ...options, onPurged: (ids) => loaded.push(...ids) });
  assert.deepEqual(loaded, [other.id]);
});

test("a deleted or purged Routine is remembered as removed, across a reload, for good", () => {
  const { store, clock, options } = setup();
  const gone = store.create(spec);
  const ended = store.create({ ...spec, name: "ended", trigger: webhook(OTHER_HOOK) });
  assert.equal(store.wasRemoved(gone.id), false);
  assert.equal(store.remove(gone.id), true);
  assert.equal(store.wasRemoved(gone.id), true);
  assert.equal(store.wasRemoved("never-here"), false);
  assert.deepEqual(saved(options).removed, { [gone.id]: START });
  // A Routine purged 30 days after it ended is remembered too, from the write that purged it.
  store.complete(ended.id, "done");
  clock.t += 31 * DAY;
  store.create({ ...spec, name: "later" });
  assert.equal(store.get(ended.id), null);
  assert.equal(store.wasRemoved(ended.id), true);
  const reloaded = createRoutineStore(options);
  assert.equal(reloaded.wasRemoved(gone.id), true);
  assert.equal(reloaded.wasRemoved(ended.id), true);
  // Upkeep never forgets one: 100 days after the delete, its Run Chats are still known to be left behind by it.
  clock.t = START + 100 * DAY;
  reloaded.create({ ...spec, name: "much later", trigger: webhook("ef".repeat(32)) });
  assert.equal(reloaded.wasRemoved(gone.id), true);
  assert.equal(reloaded.wasRemoved(ended.id), true);
  assert.deepEqual(Object.keys(saved(options).removed).toSorted(), [gone.id, ended.id].toSorted());
  assert.equal(createRoutineStore(options).wasRemoved(gone.id), true);
});

test("a file saved before removed Routines were remembered loads with none, and a damaged entry is dropped", () => {
  const { file, options } = setup();
  fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, routines: [], runs: {} }));
  const store = createRoutineStore(options);
  assert.equal(store.wasRemoved("r1"), false);
  fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, routines: [], runs: {}, removed: { r1: START, r2: "soon" } }));
  const damaged = createRoutineStore(options);
  assert.equal(damaged.wasRemoved("r1"), true);
  assert.equal(damaged.wasRemoved("r2"), false);
});

const PR_TRIGGER = { kind: "pull-request", url: "https://github.com/acme/app/pull/7", repo: "github.com/acme/app", number: 7, settings: {} };
const prSpec = { name: "Babysit PR #7", prompt: "babysit", trigger: PR_TRIGGER, target: { kind: "chat", chatId: "c1" }, createdBy: { kind: "user" } };
const prEvent = (n, extra = {}) => ({
  kind: "pull-request",
  key: `pr7:${n}`,
  summary: `change ${n}`,
  changes: [{ kind: "comment", id: String(n), text: "fix this" }],
  branch: "feature",
  ...extra,
});

test("create accepts a pull-request trigger on a chat target", () => {
  const { store, options } = setup();
  const routine = store.create(prSpec);
  assert.equal(routine.trigger.kind, "pull-request");
  assert.equal(routine.trigger.repo, "github.com/acme/app");
  assert.equal(routine.trigger.number, 7);
  // The settings are normalized: a copy of the defaults when none were given.
  assert.equal(routine.trigger.settings.intervalMinutes, 1);
  assert.equal(routine.trigger.settings.level, 3);
  assert.equal(routine.expiresAt, START + 7 * DAY);
  assert.equal(routine.nextRunAt, undefined);
  assert.deepEqual(createRoutineStore(options).get(routine.id), routine);
  // A pull-request trigger only ever targets an existing Chat.
  assert.throws(() => store.create({ ...prSpec, target: NEW_CHAT }), /existing Chat/);
});

test("pull-request trigger rejects a missing number", () => {
  const { store } = setup();
  for (const bad of [undefined, 0, -1, 1.5, "7"]) {
    assert.throws(() => store.create({ ...prSpec, trigger: { ...PR_TRIGGER, number: bad } }), /number/);
  }
  assert.throws(() => store.create({ ...prSpec, trigger: { ...PR_TRIGGER, url: "ftp://x/y" } }), /url/);
  assert.throws(() => store.create({ ...prSpec, trigger: { ...PR_TRIGGER, repo: "acme" } }), /repo/);
  assert.deepEqual(store.list(), []);
});

test("enqueue accepts a pull-request event for its routine", () => {
  const { store } = setup();
  const routine = store.create(prSpec);
  assert.deepEqual(store.enqueue(routine.id, prEvent(1)), { queued: true });
  assert.deepEqual(store.enqueue(routine.id, prEvent(1)), { queued: false, reason: "seen" });
  const linear = store.create({ ...spec, name: "linear", trigger: { kind: "linear", workspace: "w", event: "assigned" } });
  assert.deepEqual(store.enqueue(linear.id, prEvent(2)), { queued: false, reason: "kind" });
});

test("findPullRequest finds the live routine only", () => {
  const { store } = setup();
  const routine = store.create(prSpec);
  assert.equal(store.findPullRequest("github.com/acme/app", 7).id, routine.id);
  assert.equal(store.findPullRequest("github.com/acme/app", 8), undefined);
  assert.equal(store.findPullRequest("github.com/acme/other", 7), undefined);
  store.complete(routine.id);
  assert.equal(store.findPullRequest("github.com/acme/app", 7), undefined);
});

test("heartbeat_create cannot replace a babysit heartbeat", () => {
  const { store } = setup();
  store.create(prSpec);
  assert.throws(
    () => store.upsertHeartbeat({ ...base, chatId: "c1", name: "Babysit PR #7", every: "5m" }),
    /Babysit PR #7 is watched by Milagre; delete it from its Routine page first/,
  );
  // Another name in the same Chat still works.
  assert.equal(store.upsertHeartbeat({ ...base, chatId: "c1", name: "other" }).name, "other");
});

test("prSnapshot survives reload and is dropped on complete", () => {
  const { store, options } = setup();
  const routine = store.create(prSpec);
  assert.equal(store.prSnapshot(routine.id), undefined);
  const value = { snapshot: { head: "abc" }, attempts: 1, handed: ["k"] };
  store.setPrSnapshot(routine.id, value);
  assert.deepEqual(createRoutineStore(options).prSnapshot(routine.id), value);
  store.complete(routine.id);
  assert.equal(store.prSnapshot(routine.id), undefined);
  assert.equal(createRoutineStore(options).prSnapshot(routine.id), undefined);
  const other = store.create({ ...prSpec, trigger: { ...PR_TRIGGER, number: 8 } });
  store.setPrSnapshot(other.id, value);
  store.remove(other.id);
  assert.equal(store.prSnapshot(other.id), undefined);
});

test("setPrSnapshot writes the store only when the snapshot changed", () => {
  const { store } = setup();
  const routine = store.create(prSpec);
  const value = { snapshot: { head: "abc", comments: [] }, attempts: { "check:ci": 0 }, handed: { "check:ci": { at: 1, head: "abc" } } };
  assert.equal(
    countSaves(() => assert.equal(store.setPrSnapshot(routine.id, value), true)),
    1,
  );
  // The same reading again, even built in another key order, leaves the file alone.
  const same = { handed: { "check:ci": { head: "abc", at: 1 } }, attempts: { "check:ci": 0 }, snapshot: { comments: [], head: "abc" } };
  assert.equal(
    countSaves(() => assert.equal(store.setPrSnapshot(routine.id, same), true)),
    0,
  );
  assert.equal(
    countSaves(() => store.setPrSnapshot(routine.id, { ...value, attempts: { "check:ci": 1 } })),
    1,
  );
  assert.deepEqual(store.prSnapshot(routine.id).attempts, { "check:ci": 1 });
  // An ended Routine still keeps none.
  store.complete(routine.id);
  assert.equal(store.setPrSnapshot(routine.id, value), false);
});

test("only one pull-request run per routine runs at a time", () => {
  const { store } = setup();
  const routine = store.create(prSpec);
  for (let n = 1; n <= 3; n += 1) store.enqueue(routine.id, prEvent(n));
  const first = store.claimQueued(START);
  assert.equal(first.length, 1);
  assert.equal(first[0].run.event.key, "pr7:1");
  assert.deepEqual(store.claimQueued(START), []);
  store.finishRun(first[0].run.id, { status: "acted" });
  const second = store.claimQueued(START);
  assert.equal(second.length, 1);
  assert.equal(second[0].run.event.key, "pr7:2");
});

test("a pull-request event waits its turn and never expires", () => {
  const { store, clock: time } = setup();
  const routine = store.create(prSpec);
  store.enqueue(routine.id, prEvent(1));
  store.enqueue(routine.id, prEvent(2));
  const [head] = store.claimQueued(time.t);
  // The head goes back to wait; the one behind it may not jump ahead.
  store.deferRun(head.run.id, time.t + 60_000);
  assert.deepEqual(store.claimQueued(time.t), []);
  time.t += 3 * 3600_000;
  const [again] = store.claimQueued(time.t);
  assert.equal(again.run.event.key, "pr7:1");
});

test("pull-request routine always has an expiry", () => {
  const { store } = setup();
  const routine = store.create({ ...prSpec, maxRuns: 50 });
  assert.equal(routine.maxRuns, 50);
  assert.equal(routine.expiresAt, START + 7 * DAY);
  assert.equal(store.create({ ...prSpec, trigger: { ...PR_TRIGGER, number: 8 }, expiresAt: START + DAY }).expiresAt, START + DAY);
  assert.throws(() => store.create({ ...prSpec, trigger: { ...PR_TRIGGER, number: 9 }, expiresAt: START + 31 * DAY }), /30d/);
  assert.throws(() => store.update(routine.id, { expiresAt: null }), /end/);
  assert.equal(store.get(routine.id).expiresAt, START + 7 * DAY);
});

test("second live routine for the same PR is refused", () => {
  const { store } = setup();
  const first = store.create(prSpec);
  assert.throws(
    () => store.create({ ...prSpec, target: { kind: "chat", chatId: "c2" }, trigger: { ...PR_TRIGGER, repo: "GitHub.com/Acme/App" } }),
    /already being babysat/,
  );
  const other = store.create({ ...prSpec, name: "Babysit PR #8", trigger: { ...PR_TRIGGER, number: 8 } });
  // Moving a routine onto a watched PR is refused; keeping its own is fine.
  assert.throws(() => store.update(other.id, { trigger: { ...PR_TRIGGER, number: 7 } }), /already being babysat/);
  assert.equal(store.update(first.id, { trigger: PR_TRIGGER }).trigger.number, 7);
  assert.equal(store.list().length, 2);
});

test("a completed babysit routine frees the PR", () => {
  const { store } = setup();
  const first = store.create(prSpec);
  store.complete(first.id);
  assert.equal(store.create(prSpec).trigger.number, 7);
});

test("upsertHeartbeat works again after the babysit routine completes", () => {
  const { store } = setup();
  const babysit = store.create(prSpec);
  store.complete(babysit.id);
  const heartbeat = store.upsertHeartbeat({ ...base, chatId: "c1", name: "Babysit PR #7", every: "5m" });
  assert.equal(heartbeat.trigger.kind, "schedule");
});

const OPUS = { provider: "claude", model: "claude-opus-5-5", effort: "high" };

test("a Routine keeps a checked fallback; update replaces it and null clears it", () => {
  const { store, options } = setup();
  const routine = store.create({ ...spec, fallback: { ...OPUS, extra: "dropped" } });
  assert.deepEqual(routine.fallback, OPUS);
  assert.deepEqual(createRoutineStore(options).get(routine.id).fallback, OPUS);
  assert.deepEqual(store.update(routine.id, { fallback: { provider: "codex", model: "gpt-6.1-sol" } }).fallback, { provider: "codex", model: "gpt-6.1-sol" });
  assert.equal("fallback" in store.update(routine.id, { fallback: null }), false);
  for (const fallback of [{ provider: "claude" }, { model: "x" }, "claude", { provider: "claude", model: "" }]) {
    assert.throws(() => store.create({ ...spec, fallback }), /fallback/);
    assert.throws(() => store.update(routine.id, { fallback }), /fallback/);
  }
});

test("retryRun keeps the failed attempt on the Run, which runs on and finishes and counts once", () => {
  const { store, clock, options } = setup();
  const routine = store.create(spec);
  store.enqueue(routine.id, delivery(1));
  const [{ run }] = store.claimQueued(clock.t, 3);
  store.attachChat(run.id, { chatId: "/repo#s1", worktreeId: "w1" });
  clock.t += 60_000;
  const retried = store.retryRun(run.id, { error: "Selected model is at capacity.", provider: "codex", model: "gpt-6.1-sol", fallback: OPUS });
  assert.equal(retried.status, "running");
  assert.deepEqual(retried.fallback, OPUS);
  assert.deepEqual(retried.attempts, [
    {
      startedAt: run.startedAt,
      endedAt: clock.t,
      error: "Selected model is at capacity.",
      chatId: "/repo#s1",
      worktreeId: "w1",
      provider: "codex",
      model: "gpt-6.1-sol",
    },
  ]);
  // One retry per Run.
  assert.equal(store.retryRun(run.id, { error: "again", fallback: OPUS }), null);
  store.attachChat(run.id, { chatId: "/repo#s2", worktreeId: "w1" });
  store.finishRun(run.id, { status: "failed", error: "Claude hit its usage limit" });
  const saved = createRoutineStore(options).runs(routine.id)[0];
  assert.equal(saved.chatId, "/repo#s2");
  assert.equal(saved.attempts.length, 1);
  const after = store.get(routine.id);
  assert.equal(after.runCount, 1);
  assert.equal(after.failedStreak, 1);
  // A finished Run has nothing to retry.
  assert.equal(store.retryRun(run.id, { error: "late", fallback: OPUS }), null);
});
