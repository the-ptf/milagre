import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, groupQuietRuns, isRoutineRun, mergedRoutineRunText, parsePass, routineRunOf, routineRunText, triggerText } from "./routines.mjs";

test("parsePass reads a leading (pass) as quiet, with the summary after it", () => {
  assert.deepEqual(parsePass("(pass) CI green"), { quiet: true, summary: "CI green" });
  assert.deepEqual(parsePass("**(pass)** CI green"), { quiet: true, summary: "CI green" });
  assert.deepEqual(parsePass("  (Pass) waiting\nmore"), { quiet: true, summary: "waiting" });
});

test("parsePass ignores a (pass) that is not at the start", () => {
  assert.deepEqual(parsePass("CI failed, so no (pass) today"), { quiet: false });
  assert.deepEqual(parsePass(""), { quiet: false });
});

test("parsePass caps the summary at 80 characters", () => {
  assert.equal(parsePass("(pass) " + "x".repeat(200)).summary.length, 80);
});

const context = (over = {}) => ({
  kind: "routine-run",
  routineId: "r1",
  runId: "run1",
  name: "Babysit",
  at: Date.UTC(2026, 9, 16, 13, 15),
  quiet: false,
  ...over,
});

test("routineRunText words the acted and the quiet divider", () => {
  assert.equal(routineRunText(context(), "UTC"), "Heartbeat · 13:15");
  assert.equal(routineRunText(context({ at: Date.UTC(2026, 9, 16, 13, 30), quiet: true, summary: "CI green" }), "UTC"), "13:30 · quiet: CI green");
  assert.equal(routineRunText(context({ quiet: true }), "UTC"), "13:15 · quiet");
});

test("routineRunText leads an acted divider with its label, and with Heartbeat when it has none", () => {
  assert.equal(routineRunText(context({ label: "Routine · Triage" }), "UTC"), "Routine · Triage · 13:15");
  assert.equal(routineRunText(context({ label: "Linear comment · Ana" }), "UTC"), "Linear comment · Ana · 13:15");
  assert.equal(routineRunText(context({ label: undefined }), "UTC"), "Heartbeat · 13:15");
});

test("a label leaves the quiet and the folded dividers as they were", () => {
  assert.equal(routineRunText(context({ label: "Routine · Triage", quiet: true, summary: "nothing new" }), "UTC"), "13:15 · quiet: nothing new");
  assert.equal(routineRunText(context({ label: "Routine · Triage", quiet: true }), "UTC"), "13:15 · quiet");
  const last = context({ label: "Linear comment · Ana", quiet: true, summary: "seen" });
  assert.equal(mergedRoutineRunText({ count: 2, last }, "UTC"), "2 quiet checks · last 13:15: seen");
});

test("mergedRoutineRunText counts the collapsed checks and words the last one", () => {
  const last = context({ at: Date.UTC(2026, 9, 16, 13, 30), quiet: true, summary: "CI green" });
  assert.equal(mergedRoutineRunText({ count: 2, last }, "UTC"), "2 quiet checks · last 13:30: CI green");
  assert.equal(mergedRoutineRunText({ count: 5, last: { ...last, summary: undefined } }, "UTC"), "5 quiet checks · last 13:30");
});

test("routineRunText uses the given zone and a 24 hour clock", () => {
  assert.equal(routineRunText(context({ at: Date.UTC(2026, 9, 16, 0, 5) }), "America/Sao_Paulo"), "Heartbeat · 21:05");
  assert.equal(routineRunText(context({ at: Date.UTC(2026, 9, 16, 3, 5) }), "UTC"), "Heartbeat · 03:05");
});

test("isRoutineRun spots the divider message", () => {
  assert.equal(isRoutineRun({ context: context() }), true);
  assert.equal(isRoutineRun({ context: { kind: "reload" } }), false);
  assert.equal(isRoutineRun(null), false);
});

const divider = (id, over) => ({ id, role: "user", text: "", context: context({ runId: id, ...over }) });
const reply = (id) => ({ id, role: "assistant", text: "(pass) ok" });

test("groupQuietRuns hides quiet replies and merges back-to-back quiet dividers into the last", () => {
  const user = { id: "u", role: "user", text: "hi" };
  const q1 = divider("q1", { quiet: true, summary: "one" });
  const q2 = divider("q2", { quiet: true, summary: "two" });
  const a3 = divider("a3", { quiet: false });
  const messages = [user, q1, reply("r1"), q2, reply("r2"), a3, reply("r3")];
  const grouped = groupQuietRuns(messages);

  assert.equal(grouped.length, messages.length);
  assert.deepEqual(
    grouped.map((entry) => entry.message),
    messages,
  );
  assert.deepEqual(
    grouped.map((entry) => entry.hidden === true),
    [false, true, true, false, true, false, false],
  );
  assert.deepEqual(grouped[3].merged, { count: 2, last: q2.context });
  assert.equal(grouped[1].merged, undefined);
  assert.equal(grouped[5].merged, undefined);
});

test("groupQuietRuns shows a single quiet divider unmerged and hides its reply", () => {
  const q = divider("q", { quiet: true, summary: "one" });
  const grouped = groupQuietRuns([q, reply("r"), { id: "u", role: "user", text: "later" }]);
  assert.equal(grouped[0].hidden, undefined);
  assert.equal(grouped[0].merged, undefined);
  assert.equal(grouped[1].hidden, true);
  assert.equal(grouped[2].hidden, undefined);
});

test("groupQuietRuns does not merge quiet dividers split by a person's message", () => {
  const q1 = divider("q1", { quiet: true });
  const q2 = divider("q2", { quiet: true });
  const grouped = groupQuietRuns([q1, reply("r1"), { id: "u", role: "user", text: "hi" }, q2, reply("r2")]);
  assert.deepEqual(
    grouped.map((entry) => [entry.hidden === true, entry.merged?.count]),
    [
      [false, undefined],
      [true, undefined],
      [false, undefined],
      [false, undefined],
      [true, undefined],
    ],
  );
});

// A Linear Run's first message is the issue card; `routine` makes it a routine divider too.
const linearRoutine = (over = {}) => ({ routineId: "r2", runId: "run2", name: "Triage", at: Date.UTC(2026, 9, 16, 13, 15), ...over });
const linearIssue = (id, routine) => ({
  id,
  role: "user",
  text: "",
  context: {
    kind: "linear-issue",
    key: "MIL-1",
    title: "Paste images in chat",
    url: "https://linear.app/milagre/issue/MIL-1",
    state: { name: "Todo", type: "unstarted", color: "#e2e2e2" },
    ...(routine ? { routine } : {}),
  },
});

test("routineRunOf returns a routine-run message's own context", () => {
  const message = { context: context() };
  assert.equal(routineRunOf(message), message.context);
});

test("routineRunOf reads the routine a linear-issue message carries as a routine-run context", () => {
  const message = linearIssue("l1", linearRoutine({ quiet: true, summary: "nothing new" }));
  const run = routineRunOf(message);
  assert.equal(run.runId, "run2");
  assert.deepEqual(run, {
    kind: "routine-run",
    routineId: "r2",
    runId: "run2",
    name: "Triage",
    at: Date.UTC(2026, 9, 16, 13, 15),
    quiet: true,
    summary: "nothing new",
  });
});

test("routineRunOf is null for a linear-issue message without routine and for anything else", () => {
  assert.equal(routineRunOf(linearIssue("l1")), null);
  assert.equal(routineRunOf({ context: { kind: "reload" } }), null);
  assert.equal(routineRunOf({ context: null }), null);
  assert.equal(routineRunOf({ context: "handover" }), null);
  assert.equal(routineRunOf({}), null);
  assert.equal(routineRunOf(null), null);
  assert.equal(routineRunOf(undefined), null);
});

test("isRoutineRun is for the routine-run message alone; a linear-issue message that carries routine is read through routineRunOf", () => {
  const issue = linearIssue("l1", linearRoutine());
  assert.equal(isRoutineRun({ context: context() }), true);
  assert.equal(isRoutineRun(issue), false);
  assert.equal(isRoutineRun(linearIssue("l2")), false);
  assert.equal(routineRunOf(issue)?.runId, "run2");
});

test("a quiet linear-issue routine message words its divider through routineRunOf", () => {
  const run = routineRunOf(linearIssue("l1", linearRoutine({ quiet: true, summary: "no change" })));
  assert.equal(routineRunText(run, "UTC"), "13:15 · quiet: no change");
});

test("groupQuietRuns hides the reply after a quiet linear-issue routine message", () => {
  const issue = linearIssue("l1", linearRoutine({ quiet: true, summary: "no change" }));
  const grouped = groupQuietRuns([issue, reply("r1"), { id: "u", role: "user", text: "later" }]);
  assert.deepEqual(
    grouped.map((entry) => entry.hidden === true),
    [false, true, false],
  );
  assert.equal(grouped[0].merged, undefined);
});

test("groupQuietRuns keeps the reply after an acted linear-issue routine message", () => {
  const grouped = groupQuietRuns([linearIssue("l1", linearRoutine({ quiet: false })), reply("r1")]);
  assert.deepEqual(
    grouped.map((entry) => entry.hidden === true),
    [false, false],
  );
});

test("groupQuietRuns folds a quiet linear-issue routine message into the quiet dividers around it", () => {
  const q1 = divider("q1", { quiet: true, summary: "one" });
  const q2 = linearIssue("q2", linearRoutine({ runId: "q2", quiet: true, summary: "two" }));
  const grouped = groupQuietRuns([q1, reply("r1"), q2, reply("r2")]);
  assert.deepEqual(
    grouped.map((entry) => entry.hidden === true),
    [true, true, false, true],
  );
  assert.deepEqual(grouped[2].merged, { count: 2, last: routineRunOf(q2) });
  assert.equal(grouped[2].merged.last.kind, "routine-run");
  assert.equal(mergedRoutineRunText(grouped[2].merged, "UTC"), "2 quiet checks · last 13:15: two");
});

test("clock gives HH:MM on a 24 hour clock in the given zone", () => {
  assert.equal(clock(Date.UTC(2026, 9, 16, 3, 5), "UTC"), "03:05");
  assert.equal(clock(Date.UTC(2026, 9, 16, 0, 0), "UTC"), "00:00");
  assert.equal(clock(Date.UTC(2026, 9, 16, 0, 5), "America/Sao_Paulo"), "21:05");
});

test("clock adds the date, in that zone, when asked", () => {
  assert.equal(clock(Date.UTC(2026, 9, 16, 8, 30), "UTC", true), "2026-10-16 08:30");
  assert.equal(clock(Date.UTC(2026, 9, 16, 1, 30), "America/Sao_Paulo", true), "2026-10-15 22:30");
  assert.equal(clock(Date.UTC(2026, 9, 16, 8, 30), "UTC", false), "08:30");
});

const schedule = (cron) => ({ kind: "schedule", cron, timezone: "UTC" });

test("triggerText words a schedule trigger", () => {
  assert.equal(triggerText(schedule("*/15 * * * *")), "every 15 min");
  assert.equal(triggerText(schedule("0 */2 * * *")), "every 2 h");
  assert.equal(triggerText(schedule("30 8 * * 1-5")), "weekdays 08:30");
  assert.equal(triggerText(schedule("30 8 * * *")), "daily 08:30");
});

test("triggerText reads every cadence a heartbeat's `every` makes", () => {
  assert.equal(triggerText(schedule("*/1 * * * *")), "every 1 min");
  assert.equal(triggerText(schedule("*/59 * * * *")), "every 59 min");
  assert.equal(triggerText(schedule("0 */1 * * *")), "every 1 h");
  assert.equal(triggerText(schedule("0 */23 * * *")), "every 23 h");
  assert.equal(triggerText(schedule("0 0 * * *")), "daily 00:00");
});

test("triggerText zero-pads the clock time", () => {
  assert.equal(triggerText(schedule("5 9 * * 1-5")), "weekdays 09:05");
  assert.equal(triggerText(schedule("0 0 * * 1-5")), "weekdays 00:00");
  assert.equal(triggerText(schedule("30 14 * * *")), "daily 14:30");
  assert.equal(triggerText(schedule("59 23 * * *")), "daily 23:59");
});

test("triggerText ignores extra spaces in the expression", () => {
  assert.equal(triggerText(schedule("  */15   *  * * *  ")), "every 15 min");
  assert.equal(triggerText(schedule(" 0 9 1 * * ")), 'cron "0 9 1 * *"');
});

test("triggerText leaves any other schedule as its cron expression", () => {
  for (const cron of [
    "0 9 1 * *",
    "*/15 8 * * *",
    "15 */2 * * *",
    "0,30 8 * * *",
    "0 9-17 * * 1-5",
    "30 8 * * 1",
    "30 8 * * 0,6",
    "30 8 * 6 *",
    "* * * * *",
    "0 * * * *",
    "61 8 * * *",
    "30 24 * * *",
    "*/0 * * * *",
    "*/60 * * * *",
    "0 */24 * * *",
    "not a cron",
    "",
  ]) {
    assert.equal(triggerText(schedule(cron)), `cron "${cron}"`, cron);
  }
});

const linear = (event, over = {}) => ({ kind: "linear", workspace: "milagre", event, ...over });

test("triggerText words a Linear trigger", () => {
  assert.equal(triggerText(linear("label-added", { label: "agent", team: "MIL" })), "Linear · label agent added · team MIL");
  assert.equal(triggerText(linear("label-added", { label: "agent" })), "Linear · label agent added");
  assert.equal(triggerText(linear("assigned")), "Linear · assigned to me");
  assert.equal(triggerText(linear("assigned", { team: "MIL" })), "Linear · assigned to me · team MIL");
  assert.equal(triggerText(linear("state", { state: "Todo" })), "Linear · moved to Todo");
  assert.equal(triggerText(linear("state", { state: "Todo", team: "MIL" })), "Linear · moved to Todo · team MIL");
  assert.equal(triggerText(linear("comment")), "Linear · new comment");
  assert.equal(triggerText(linear("comment", { team: "MIL" })), "Linear · new comment · team MIL");
});

test("triggerText never prints undefined for a Linear trigger missing its label or state", () => {
  assert.equal(triggerText(linear("label-added")), "Linear · label added");
  assert.equal(triggerText(linear("state")), "Linear · moved");
  assert.equal(triggerText(linear("label-added", { team: "MIL" })), "Linear · label added · team MIL");
});

test("triggerText words a webhook trigger", () => {
  assert.equal(triggerText({ kind: "webhook", hookId: "ab12", signed: false }), "Webhook");
  assert.equal(triggerText({ kind: "webhook", hookId: "ab12", signed: true }), "Webhook");
});

test("triggerText copes with a trigger from a newer version", () => {
  assert.equal(triggerText({ kind: "email" }), "email");
  assert.equal(triggerText(linear("teleport", { team: "MIL" })), "Linear · team MIL");
  assert.equal(triggerText(null), "");
  assert.equal(triggerText(undefined), "");
});
