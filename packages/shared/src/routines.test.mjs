import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canOpenRunChat,
  canRunNow,
  chatLeft,
  chatRoutine,
  clock,
  foldRuns,
  foldText,
  groupQuietRuns,
  hiddenRunChats,
  isRoutineRun,
  mergedRoutineRunText,
  parsePass,
  routineRunOf,
  routineRunText,
  runTitle,
  runWhen,
  triggerText,
  unreadRunChats,
  unreadRunRoutines,
} from "./routines.mjs";

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

test("canRunNow: schedules and Heartbeats run now; Linear and webhook triggers have no event to run with", () => {
  const newChat = { kind: "new-chat", projectPath: "/p", workspace: "worktree" };
  assert.equal(canRunNow({ trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" }, target: newChat }), true);
  assert.equal(canRunNow({ trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" }, target: { kind: "chat", chatId: "c" } }), true);
  assert.equal(canRunNow({ trigger: { kind: "linear", workspace: "w", event: "assigned" }, target: newChat }), false);
  assert.equal(canRunNow({ trigger: { kind: "webhook", hookId: "a", signed: false }, target: newChat }), false);
});

const run = (id, status, extra = {}) => ({ id, routineId: "r", startedAt: 100 - Number(id), status, ...extra });

test("foldRuns folds quiet, skipped, missed and refused stretches between acted Runs", () => {
  const entries = foldRuns([
    run("1", "acted"),
    run("2", "quiet"),
    run("3", "skipped-busy"),
    run("4", "missed"),
    run("5", "failed", { rejected: true }),
    run("6", "failed"),
    run("7", "quiet"),
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["run", "fold", "run", "fold"],
  );
  assert.deepEqual(entries[1].counts, { quiet: 1, skipped: 1, missed: 1, refused: 1 });
  assert.equal(entries[1].last, 98);
  assert.equal(entries[1].runs.length, 4);
  assert.equal(entries[2].run.id, "6");
  assert.equal(entries[3].runs[0].id, "7");
  assert.deepEqual(foldRuns([]), []);
});

test("foldRuns counts a refused Run only as refused, and keeps a running Run as its own row", () => {
  const entries = foldRuns([run("1", "running"), run("2", "quiet", { rejected: true }), run("3", "skipped-busy", { rejected: true })]);
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["run", "fold"],
  );
  assert.deepEqual(entries[1].counts, { quiet: 0, skipped: 0, missed: 0, refused: 2 });
});

test("runTitle prefers the Run's own title, then its Linear issue, then the Routine's name", () => {
  const issue = { key: "MIL-12", title: "Fix the flicker" };
  const linear = { kind: "linear", key: "k", change: "assigned", issue };
  assert.equal(runTitle({ id: "1", routineId: "r", startedAt: 1, status: "acted", title: "Fixed the flicker", event: linear }, "Triage"), "Fixed the flicker");
  assert.equal(runTitle({ id: "1", routineId: "r", startedAt: 1, status: "acted", event: linear }, "Triage"), "MIL-12 Fix the flicker");
  assert.equal(runTitle({ id: "1", routineId: "r", startedAt: 1, status: "acted", event: { kind: "schedule" } }, "Triage"), "Triage");
  assert.equal(runTitle({ id: "1", routineId: "r", startedAt: 1, status: "acted", title: "  " }, "Triage"), "Triage");
});

const session = (id, routine, extra = {}) => ({ id, worktree_id: 1, agent_name: "a", status: "Idle", ...(routine ? { routine } : {}), ...extra });

test("hiddenRunChats lists unarchived hidden Run Chats with their unread state", () => {
  const scopes = [
    {
      path: "/p",
      state: {
        sessions: {
          1: session(1, { routineId: "r1", runId: "u1", hidden: true }, { unread: true }),
          2: session(2, { routineId: "r1", runId: "u2", hidden: true }),
          3: session(3, { routineId: "r1", runId: "u3", hidden: true }, { archived: true }),
          4: session(4, { routineId: "r1", runId: "u4", hidden: false }),
          5: session(5, { routineId: "r1", runId: "u5" }),
          6: session(6),
        },
      },
    },
    { path: "/q", state: { sessions: { 7: session(7, { routineId: "r2", runId: "u7", hidden: true }) } } },
  ];
  assert.deepEqual(hiddenRunChats(scopes), [
    { chatKey: "/p#1", routineId: "r1", runId: "u1", unread: true },
    { chatKey: "/p#2", routineId: "r1", runId: "u2", unread: false },
    { chatKey: "/q#7", routineId: "r2", runId: "u7", unread: false },
  ]);
});

// Local times, so "today" and "yesterday" hold in any time zone.
const local = (day, hour, minute) => new Date(2026, 9, day, hour, minute).getTime();

test("runWhen says Today or Yesterday with the time, and the date before that", () => {
  const now = local(18, 12, 0);
  assert.equal(runWhen(local(18, 10, 15), now), "Today 10:15");
  assert.equal(runWhen(local(18, 0, 5), now), "Today 00:05");
  assert.equal(runWhen(local(17, 9, 0), now), "Yesterday 09:00");
  assert.equal(runWhen(local(17, 23, 59), local(18, 0, 1)), "Yesterday 23:59");
  assert.equal(runWhen(local(16, 9, 0), now), "Oct 16 09:00");
  assert.equal(runWhen(new Date(2026, 0, 3, 7, 30).getTime(), now), "Jan 3 07:30");
});

test("runWhen says Today for a Run just after midnight when the clock it is read with is a little stale", () => {
  // The Runs list's clock ticks every 30 s, so a Run that starts a few seconds into the day can be read with a `now` from
  // just before midnight.
  const at = new Date(2026, 9, 18, 0, 0, 5).getTime();
  assert.equal(runWhen(at, at - 20_000), "Today 00:00");
});

test("runWhen adds the year to a date from another year", () => {
  assert.equal(runWhen(new Date(2025, 11, 30, 8, 0).getTime(), local(18, 12, 0)), "Dec 30, 2025 08:00");
});

test("foldText counts a fold's Runs by kind, leaving out the kinds it has none of, and ends with the latest time", () => {
  const at = local(18, 10, 30);
  assert.equal(foldText({ quiet: 5, skipped: 2, missed: 0, refused: 0 }, at), "5 quiet · 2 skipped · last 10:30");
  assert.equal(foldText({ quiet: 0, skipped: 0, missed: 1, refused: 3 }, at), "1 missed · 3 refused · last 10:30");
  assert.equal(foldText({ quiet: 1, skipped: 1, missed: 1, refused: 1 }, at), "1 quiet · 1 skipped · 1 missed · 1 refused · last 10:30");
});

const runChat = (id, routineId, extra = {}) => ({ id, routine: { routineId, runId: `u${id}`, hidden: true }, ...extra });
// One Mac's Project states, the way a desktop window or the phone holds them: two Projects, a Link and another computer's.
const unreadStates = () => ({
  "/code/shop": { sessions: { 1: runChat(1, "r1", { unread: true }), 2: runChat(2, "r1"), 3: { id: 3, unread: true } } },
  "/code/web": {
    sessions: {
      1: runChat(1, "r2", { unread: true, archived: true }),
      2: { id: 2, unread: true, routine: { routineId: "r3", runId: "u9", hidden: false } },
      3: runChat(3, "r4", { unread: true }),
    },
  },
  "milagre-link:0b1f4a52-5c3e-4d7a-9a40-3c5b1e0d9f11": { sessions: { 1: runChat(1, "r5", { unread: true }) } },
  "mac-2|/code/api": { sessions: { 1: runChat(1, "r6", { unread: true }) } },
});

test("unreadRunRoutines: the Routines with a hidden Run Chat nobody opened, over this Mac's Projects only", () => {
  assert.deepEqual([...unreadRunRoutines(unreadStates())].toSorted(), ["r1", "r4"]);
  assert.equal(unreadRunRoutines({}).size, 0);
  assert.equal(unreadRunRoutines({ "/code/shop": { sessions: { 1: runChat(1, "r1") } } }).size, 0);
});

test("unreadRunChats: the keys of this Mac's hidden Run Chats nobody opened, for the Runs list's dots", () => {
  assert.deepEqual([...unreadRunChats(unreadStates())].toSorted(), ["/code/shop#1", "/code/web#3"]);
  assert.equal(unreadRunChats({}).size, 0);
});

test("chatLeft: a Chat is there to open while its Project holds its session, archived or not", () => {
  const states = { "/code/shop": { sessions: { 1: { id: 1 }, 2: { id: 2, archived: true } } } };
  assert.equal(chatLeft(states, "/code/shop#1"), true);
  // A quiet Run archives its Chat; one that ran in the Project folder (or a Worktree that wasn't clean) leaves it there.
  assert.equal(chatLeft(states, "/code/shop#2"), true);
  // A Worktree removed with its Chat leaves no session; a Project no state is held for can't tell.
  assert.equal(chatLeft(states, "/code/shop#3"), false);
  assert.equal(chatLeft(states, "/code/web#1"), false);
});

test("canOpenRunChat: a Run's Chat opens while its held Project has it, archived or not, and not once it is gone", () => {
  const states = { "/p": { sessions: { 4: { id: 4 }, 5: { id: 5, archived: true } } } };
  assert.equal(canOpenRunChat(states, "/p#4"), true);
  assert.equal(canOpenRunChat(states, "/p#5"), true);
  assert.equal(canOpenRunChat(states, "/p#6"), false);
});

test("canOpenRunChat: a Run's Chat in a Project the client holds no state for opens, and opening it loads that Project", () => {
  assert.equal(canOpenRunChat({}, "/q#4"), true);
  assert.equal(canOpenRunChat({ "/p": { sessions: {} } }, "/q#4"), true);
});

test("chatRoutine: a Run Chat's own Routine, else the enabled Heartbeat that checks back on the Chat", () => {
  const heartbeat = { id: "h1", enabled: true, target: { kind: "chat", chatId: "/code/milagre#12" } };
  const pausedHeartbeat = { ...heartbeat, id: "h2", enabled: false };
  const linear = { id: "l1", enabled: true, target: { kind: "new-chat", projectPath: "/code/milagre-ade", workspace: "worktree" } };
  const webhook = { id: "w1", enabled: false, target: { kind: "new-chat", projectPath: "/code/milagre-ade", workspace: "project" } };
  const routines = [heartbeat, pausedHeartbeat, linear, webhook];
  // A Run Chat, hidden or kept, names the Routine whose Run opened it, switched on or off.
  assert.equal(chatRoutine(routines, "/code/milagre-ade#4", { routineId: "l1" })?.id, "l1");
  assert.equal(chatRoutine(routines, "/code/milagre-ade#5", { routineId: "w1" })?.id, "w1");
  // A Heartbeat's Chat, while the Heartbeat is on.
  assert.equal(chatRoutine(routines, "/code/milagre#12")?.id, "h1");
  assert.equal(chatRoutine([pausedHeartbeat], "/code/milagre#12"), undefined);
  // A Run Chat whose Routine is gone, and a Chat no Routine knows.
  assert.equal(chatRoutine(routines, "/code/milagre-ade#6", { routineId: "gone" }), undefined);
  assert.equal(chatRoutine(routines, "/code/milagre#1"), undefined);
});
