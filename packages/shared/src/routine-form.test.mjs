import assert from "node:assert/strict";
import test from "node:test";
import {
  EVERY_HOURS,
  EVERY_MINUTES,
  deleteWarning,
  emptyRoutineForm,
  fallbackApplies,
  firstRunAt,
  promptHint,
  formFromRoutine,
  isCommentRoutine,
  formToInput,
  formToUpdate,
  scheduleCron,
  scheduleFromCron,
  withRunIn,
} from "./routine-form.mjs";

const NOW = Date.UTC(2026, 9, 17, 12, 0);
const DAY = 864e5;

const linearForm = () => ({
  ...emptyRoutineForm("America/Sao_Paulo"),
  name: " Take issues labelled agent ",
  trigger: "linear",
  linear: { workspace: "milagre", event: "label-added", team: "MIL", label: "agent", state: "" },
  projectPath: "/code/milagre",
  runIn: "worktree",
  prompt: "Work on {{issue.key}}",
  provider: "claude",
  model: "claude-opus-5-5",
  permissionMode: "full",
});

test("a Linear label trigger becomes a routines:create input for a new Chat in a worktree", () => {
  assert.deepEqual(formToInput(linearForm(), NOW), {
    input: {
      name: "Take issues labelled agent",
      prompt: "Work on {{issue.key}}",
      trigger: { kind: "linear", workspace: "milagre", event: "label-added", team: "MIL", label: "agent" },
      target: { kind: "new-chat", projectPath: "/code/milagre", workspace: "worktree" },
      provider: "claude",
      model: "claude-opus-5-5",
      permissionMode: "full",
    },
  });
});

test("a heartbeat targets the Chat and ends 7 days ahead by default", () => {
  const form = {
    ...withRunIn(emptyRoutineForm("UTC", NOW), "chat", NOW),
    name: "Babysit PR #473",
    trigger: "schedule",
    schedule: { mode: "every", every: 15, unit: "min", time: "08:30", days: [1, 2, 3, 4, 5], cron: "", timezone: "UTC" },
    projectPath: "/code/milagre",
    chatId: "/code/milagre::12",
    prompt: "Check CI",
  };
  assert.equal(emptyRoutineForm("UTC", NOW).stop.kind, "never");
  // A new Routine starts every hour.
  assert.deepEqual(scheduleCron(emptyRoutineForm("UTC", NOW).schedule), { cron: "0 */1 * * *" });
  assert.equal(form.runIn, "chat");
  const result = formToInput(form, NOW);
  assert.deepEqual(result, {
    input: {
      name: "Babysit PR #473",
      prompt: "Check CI",
      trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" },
      target: { kind: "chat", chatId: "/code/milagre::12" },
      expiresAt: NOW + 7 * DAY,
    },
  });
});

test("an existing-Chat target is refused for a Linear trigger", () => {
  const result = formToInput({ ...linearForm(), runIn: "chat", chatId: "c1" }, NOW);
  assert.deepEqual(result, { field: "runIn", error: "Only schedule triggers can target an existing Chat" });
});

test("a Linear trigger needs its label or state, and a workspace", () => {
  const label = linearForm();
  label.linear = { ...label.linear, label: "" };
  assert.equal(formToInput(label, NOW).field, "label");
  const state = linearForm();
  state.linear = { ...state.linear, event: "state", state: "" };
  assert.equal(formToInput(state, NOW).field, "state");
  const workspace = linearForm();
  workspace.linear = { ...workspace.linear, workspace: "" };
  assert.equal(formToInput(workspace, NOW).field, "workspace");
  // A state trigger drops the label the form still holds.
  const moved = linearForm();
  moved.linear = { ...moved.linear, event: "state", state: "Todo" };
  assert.deepEqual(formToInput(moved, NOW).input.trigger, { kind: "linear", workspace: "milagre", event: "state", team: "MIL", state: "Todo" });
});

test("name, prompt and project are required", () => {
  assert.equal(formToInput({ ...linearForm(), name: "  " }, NOW).field, "name");
  assert.equal(formToInput({ ...linearForm(), prompt: "" }, NOW).field, "prompt");
  assert.equal(formToInput({ ...linearForm(), projectPath: "" }, NOW).field, "project");
  assert.equal(formToInput({ ...linearForm(), trigger: "schedule", runIn: "chat", chatId: "" }, NOW).field, "chat");
});

test("schedules become the cron shapes triggerText reads, and uneven intervals are refused with the store's words", () => {
  const base = { mode: "every", every: 15, unit: "min", time: "08:30", days: [], cron: "", timezone: "UTC" };
  assert.deepEqual(scheduleCron(base), { cron: "*/15 * * * *" });
  assert.deepEqual(scheduleCron({ ...base, every: 2, unit: "h" }), { cron: "0 */2 * * *" });
  assert.deepEqual(scheduleCron({ ...base, every: 24, unit: "h" }), { cron: "0 0 * * *" });
  assert.deepEqual(scheduleCron({ ...base, every: 60, unit: "min" }), { cron: "0 */1 * * *" });
  assert.deepEqual(scheduleCron({ ...base, every: 59 }), { error: "Every N minutes must divide 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30)" });
  assert.deepEqual(scheduleCron({ ...base, every: 5, unit: "h" }), { error: "Every N hours must divide 24 (1, 2, 3, 4, 6, 8, 12, 24)" });
  assert.deepEqual(scheduleCron({ ...base, mode: "at", days: [1, 2, 3, 4, 5] }), { cron: "30 8 * * 1-5" });
  assert.deepEqual(scheduleCron({ ...base, mode: "at", days: [0, 1, 2, 3, 4, 5, 6] }), { cron: "30 8 * * *" });
  assert.deepEqual(scheduleCron({ ...base, mode: "at", days: [6, 0] }), { cron: "30 8 * * 0,6" });
  assert.equal(scheduleCron({ ...base, mode: "at", days: [] }).error, "Pick at least one day");
  assert.equal(scheduleCron({ ...base, mode: "at", time: "25:00", days: [1] }).error, "Give a time as HH:MM");
  assert.deepEqual(scheduleCron({ ...base, mode: "cron", cron: " 5 4 * * 0 " }), { cron: "5 4 * * 0" });
  assert.equal(scheduleCron({ ...base, mode: "cron", cron: "" }).error, "Give a cron expression");
});

test("a cron the form made reads back into the same schedule, and anything else opens as Advanced", () => {
  for (const cron of ["*/15 * * * *", "0 */2 * * *", "30 8 * * 1-5", "30 8 * * *", "0 9 * * 0,6"]) {
    const schedule = scheduleFromCron(cron, "UTC");
    assert.equal(schedule.mode === "cron", false, cron);
    assert.equal(scheduleCron(schedule).cron, cron);
  }
  assert.equal(scheduleFromCron("0 9 1 * *", "UTC").mode, "cron");
  assert.equal(scheduleFromCron("0 9 1 * *", "UTC").cron, "0 9 1 * *");
});

test("stop after N runs or on a date; a heartbeat can't run forever", () => {
  // Moving to a Chat swaps Never for a date 7 days ahead; a chosen end stays.
  assert.deepEqual(withRunIn(linearForm(), "chat", NOW).stop, { kind: "date", runs: 10, at: NOW + 7 * DAY });
  const capped = { ...linearForm(), stop: { kind: "runs", runs: 3, at: NOW } };
  assert.deepEqual(withRunIn(capped, "chat", NOW).stop, capped.stop);
  assert.equal(withRunIn(linearForm(), "project", NOW).runIn, "project");
  const runs = formToInput({ ...linearForm(), stop: { kind: "runs", runs: 20, at: NOW } }, NOW);
  assert.equal(runs.input.maxRuns, 20);
  const date = formToInput({ ...linearForm(), stop: { kind: "date", runs: 10, at: NOW + 3 * DAY } }, NOW);
  assert.equal(date.input.expiresAt, NOW + 3 * DAY);
  assert.equal(formToInput({ ...linearForm(), stop: { kind: "runs", runs: 0, at: NOW } }, NOW).field, "stop");
  assert.equal(formToInput({ ...linearForm(), stop: { kind: "date", runs: 10, at: NOW - 1 } }, NOW).field, "stop");
  assert.equal(formToInput({ ...linearForm(), stop: { kind: "date", runs: 10, at: NOW + 31 * DAY } }, NOW).field, "stop");
  const heartbeat = { ...linearForm(), trigger: "schedule", runIn: "chat", chatId: "c1", stop: { kind: "never", runs: 10, at: NOW } };
  assert.deepEqual(formToInput(heartbeat, NOW), { field: "stop", error: "A Heartbeat needs an end" });
});

test("a webhook trigger asks the Mac for a URL and is signed only with a secret", () => {
  const form = { ...linearForm(), trigger: "webhook", webhook: { signingHeader: "", signingSecret: "" } };
  assert.deepEqual(formToInput(form, NOW).input.trigger, { kind: "webhook", signed: false });
  assert.equal("signingSecret" in formToInput(form, NOW).input, false);
  const signed = formToInput({ ...form, webhook: { signingHeader: " x-sig ", signingSecret: "s3" } }, NOW).input;
  assert.deepEqual(signed.trigger, { kind: "webhook", signed: true });
  assert.equal(signed.signingSecret, "s3");
  assert.equal(signed.signingHeader, "x-sig");
});

test("a Routine opens in the form and saves back as an update of what changed", () => {
  const routine = {
    id: "r1",
    name: "Take issues",
    prompt: "Work on {{issue.key}}",
    trigger: { kind: "linear", workspace: "milagre", event: "label-added", label: "agent" },
    target: { kind: "new-chat", projectPath: "/code/milagre", workspace: "project" },
    model: "gpt-5.5",
    provider: "codex",
    enabled: true,
    createdBy: { kind: "user" },
    maxRuns: 5,
    runCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const form = formFromRoutine(routine, "UTC", NOW);
  assert.equal(form.trigger, "linear");
  assert.equal(form.runIn, "project");
  assert.deepEqual(form.stop, { kind: "runs", runs: 5, at: NOW + 7 * DAY });
  assert.deepEqual(formToUpdate({ ...form, name: "Take agent issues", stop: { ...form.stop, kind: "never" }, model: "" }, routine, NOW), {
    patch: {
      name: "Take agent issues",
      prompt: "Work on {{issue.key}}",
      trigger: { kind: "linear", workspace: "milagre", event: "label-added", label: "agent" },
      target: { kind: "new-chat", projectPath: "/code/milagre", workspace: "project" },
      provider: "codex",
      model: null,
      permissionMode: null,
      fallback: null,
      maxRuns: null,
      expiresAt: null,
    },
  });
});

test("an edited heartbeat keeps its Chat and its webhook patch leaves the hook id out", () => {
  const heartbeat = {
    id: "h1",
    name: "Watch CI",
    prompt: "Check",
    trigger: { kind: "schedule", cron: "*/10 * * * *", timezone: "UTC" },
    target: { kind: "chat", chatId: "c9" },
    enabled: true,
    createdBy: { kind: "agent", chatId: "c9" },
    expiresAt: NOW + 2 * DAY,
    runCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const form = formFromRoutine(heartbeat, "UTC", NOW);
  assert.equal(form.runIn, "chat");
  assert.equal(form.chatId, "c9");
  const { patch } = formToUpdate(form, heartbeat, NOW);
  assert.deepEqual(patch.target, { kind: "chat", chatId: "c9" });
  assert.deepEqual(patch.trigger, { kind: "schedule", cron: "*/10 * * * *", timezone: "UTC" });
  assert.equal(patch.expiresAt, NOW + 2 * DAY);
  assert.equal(patch.maxRuns, null);

  const hook = {
    ...heartbeat,
    trigger: { kind: "webhook", hookId: "a".repeat(64), signed: true },
    target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
  };
  const hookForm = formFromRoutine(hook, "UTC", NOW);
  assert.equal(hookForm.trigger, "webhook");
  // The hook id stays out of the patch: only a rotate changes it, and a stale one would be refused after a rotate.
  assert.deepEqual(formToUpdate(hookForm, hook, NOW).patch.trigger, { kind: "webhook", signed: true });
  assert.equal("signingSecret" in formToUpdate(hookForm, hook, NOW).patch, false);
  // A new secret is sent; clearing the switch makes it unsigned.
  const resigned = formToUpdate({ ...hookForm, webhook: { signingHeader: "", signingSecret: "new" } }, hook, NOW).patch;
  assert.equal(resigned.signingSecret, "new");
  const unsigned = formToUpdate({ ...hookForm, webhook: { signed: false, signingHeader: "", signingSecret: "" } }, hook, NOW).patch;
  assert.deepEqual(unsigned.trigger, { kind: "webhook", signed: false });
});

test("the trigger kind and where a Run lands can't change on an edit", () => {
  const routine = {
    id: "r1",
    name: "n",
    prompt: "p",
    trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" },
    target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
    enabled: true,
    createdBy: { kind: "user" },
    runCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const form = formFromRoutine(routine, "UTC", NOW);
  assert.equal(formToUpdate({ ...form, trigger: "linear" }, routine, NOW).field, "trigger");
  assert.equal(formToUpdate({ ...form, runIn: "chat", chatId: "c" }, routine, NOW).field, "runIn");
});

test("an unsigned webhook can't become signed on an edit without a secret", () => {
  const hook = {
    id: "w1",
    name: "n",
    prompt: "p",
    trigger: { kind: "webhook", hookId: "b".repeat(64), signed: false },
    target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
    enabled: true,
    createdBy: { kind: "user" },
    runCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const form = formFromRoutine(hook, "UTC", NOW);
  assert.deepEqual(formToUpdate({ ...form, webhook: { signed: true, signingHeader: "", signingSecret: "" } }, hook, NOW), {
    field: "signingSecret",
    error: "A signed webhook needs a signing secret",
  });
  // An already signed one keeps its stored secret.
  const signed = { ...hook, trigger: { ...hook.trigger, signed: true } };
  assert.equal(formToUpdate(formFromRoutine(signed, "UTC", NOW), signed, NOW).patch.trigger.signed, true);
});

test("an edit keeps an expiry the form doesn't show when the Routine also has a run cap", () => {
  const routine = {
    id: "r2",
    name: "n",
    prompt: "p",
    trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" },
    target: { kind: "chat", chatId: "c" },
    enabled: true,
    createdBy: { kind: "agent", chatId: "c" },
    maxRuns: 5,
    expiresAt: NOW + 2 * DAY,
    runCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const form = formFromRoutine(routine, "UTC", NOW);
  assert.equal(form.stop.kind, "runs");
  const { patch } = formToUpdate(form, routine, NOW);
  assert.equal(patch.maxRuns, 5);
  assert.equal(patch.expiresAt, NOW + 2 * DAY);
  // Picking a date instead drops the cap.
  const dated = formToUpdate({ ...form, stop: { ...form.stop, kind: "date" } }, routine, NOW).patch;
  assert.equal(dated.maxRuns, null);
  assert.equal(dated.expiresAt, NOW + 2 * DAY);
});

test("name and prompt lengths follow the store's limits", () => {
  assert.deepEqual(formToInput({ ...linearForm(), name: "n".repeat(81) }, NOW), { field: "name", error: "A name is at most 80 characters" });
  assert.equal(formToInput({ ...linearForm(), name: "n".repeat(80) }, NOW).input.name.length, 80);
  assert.deepEqual(formToInput({ ...linearForm(), prompt: "p".repeat(4001) }, NOW), { field: "prompt", error: "A prompt is at most 4000 characters" });
});

test("the form's cadences are the ones the Mac's cron accepts", async () => {
  const { readFile } = await import("node:fs/promises");
  const cron = await readFile(new URL("../../core/src/routines/cron.cjs", import.meta.url), "utf8");
  const list = (name) => JSON.parse(cron.match(new RegExp(`const ${name} = (\\[[^\\]]*\\])`))[1]);
  assert.deepEqual(EVERY_MINUTES, list("EVERY_MINUTES"));
  assert.deepEqual(EVERY_HOURS, list("EVERY_HOURS"));
  const store = await readFile(new URL("../../core/src/routines/store.cjs", import.meta.url), "utf8");
  assert.match(store, /const NAME_MAX = 80;/);
  assert.match(store, /const PROMPT_MAX = 4000;/);
});

test("a signed webhook's header opens in the form, and clearing it sends null so it goes back to the default", () => {
  const hook = {
    id: "w2",
    name: "n",
    prompt: "p",
    trigger: { kind: "webhook", hookId: "c".repeat(64), signed: true },
    target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
    signingHeader: "x-hub-signature",
    enabled: true,
    createdBy: { kind: "user" },
    runCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const form = formFromRoutine(hook, "UTC", NOW);
  assert.equal(form.webhook.signingHeader, "x-hub-signature");
  assert.equal(formToUpdate(form, hook, NOW).patch.signingHeader, "x-hub-signature");
  assert.equal(formToUpdate({ ...form, webhook: { ...form.webhook, signingHeader: " " } }, hook, NOW).patch.signingHeader, null);
  // Unsigned, the header means nothing and isn't sent.
  const unsigned = formToUpdate({ ...form, webhook: { ...form.webhook, signed: false } }, hook, NOW).patch;
  assert.equal("signingHeader" in unsigned, false);
});

test("a Linear comment Routine has no Each run: comments go into the Chat linked to the issue", () => {
  const comment = { ...linearForm(), linear: { workspace: "milagre", event: "comment", team: "", label: "agent", state: "" }, runIn: "project" };
  assert.equal(isCommentRoutine(comment), true);
  assert.equal(isCommentRoutine(linearForm()), false);
  assert.equal(isCommentRoutine({ ...comment, trigger: "schedule" }), false);
  // The Mac still keeps a new-chat target on a listed Project; the form fills it, whatever Each run held.
  assert.deepEqual(formToInput(comment, NOW).input.target, { kind: "new-chat", projectPath: "/code/milagre", workspace: "worktree" });
  assert.deepEqual(formToInput({ ...comment, runIn: "chat", chatId: "c1" }, NOW).input.target, {
    kind: "new-chat",
    projectPath: "/code/milagre",
    workspace: "worktree",
  });
  assert.deepEqual(formToInput(comment, NOW).input.trigger, { kind: "linear", workspace: "milagre", event: "comment" });
  // An edit keeps the stored target as it is.
  const routine = {
    id: "c1",
    name: "Answer comments",
    prompt: "Reply to {{comment.body}}",
    trigger: { kind: "linear", workspace: "milagre", event: "comment" },
    target: { kind: "new-chat", projectPath: "/code/other", workspace: "project" },
    enabled: true,
    createdBy: { kind: "user" },
    runCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const edited = formFromRoutine(routine, "UTC", NOW);
  assert.equal(isCommentRoutine(edited), true);
  // An edit leaves the stored target out of the patch: its hidden Project may have left the list, and isn't checked again.
  const { patch } = formToUpdate({ ...edited, projectPath: "", runIn: "worktree" }, routine, NOW);
  assert.equal("target" in patch, false);
  assert.equal(patch.prompt, "Reply to {{comment.body}}");
});

test("deleteWarning: a Heartbeat's Chat stays; a Routine that opens Chats archives the Run Chats nobody kept", () => {
  assert.equal(deleteWarning({ target: { kind: "chat", chatId: "/p#1" } }), "Its Chats stay.");
  assert.equal(
    deleteWarning({ target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" } }),
    "Its Runs stop, and its Run Chats you haven't kept are archived.",
  );
});

test("promptHint says an event's fields are data, not instructions", () => {
  assert.equal(promptHint("schedule"), "Type {{ for the Run's fields");
  assert.equal(promptHint("linear"), "Type {{ for the Run's fields. Issue text is passed as data, not instructions.");
  assert.equal(promptHint("webhook"), "Type {{ for the Run's fields. The request is passed as data, not instructions.");
});

test("firstRunAt reads the schedule on its own time zone's clock", () => {
  // 2026-10-19 14:20 UTC is 11:20 in Sao Paulo (UTC-3) and 23:20 in Tokyo (UTC+9), a Monday everywhere.
  const now = Date.UTC(2026, 9, 19, 14, 20);
  const form = (schedule) => ({ ...emptyRoutineForm("UTC", now), schedule: { ...emptyRoutineForm("UTC", now).schedule, ...schedule } });
  // At 09:00 on weekdays: Sao Paulo's 09:00 has passed today, so tomorrow 12:00 UTC.
  assert.equal(firstRunAt(form({ mode: "at", time: "09:00", timezone: "America/Sao_Paulo" }), now), Date.UTC(2026, 9, 20, 12, 0));
  // At 23:45 in Tokyo is later today there: 14:45 UTC.
  assert.equal(firstRunAt(form({ mode: "at", time: "23:45", timezone: "Asia/Tokyo", days: [1] }), now), Date.UTC(2026, 9, 19, 14, 45));
  // Every 4 hours in Tokyo: the next is midnight there (15:00 UTC).
  assert.equal(firstRunAt(form({ mode: "every", every: 4, unit: "h", timezone: "Asia/Tokyo" }), now), Date.UTC(2026, 9, 19, 15, 0));
  // Every 15 minutes, the zone aside.
  assert.equal(firstRunAt(form({ mode: "every", every: 15, unit: "min", timezone: "UTC" }), now), Date.UTC(2026, 9, 19, 14, 30));
  assert.equal(firstRunAt(form({ mode: "cron", cron: "0 9 * * *" }), now), null);
  assert.equal(firstRunAt({ ...form({}), trigger: "linear" }, now), null);
  assert.equal(firstRunAt(form({ mode: "every", every: 7, unit: "min" }), now), null);
});

test("a picked fallback goes into the input and the patch; automatic leaves create without one and clears it on update", () => {
  const form = { ...linearForm(), fallbackProvider: "codex", fallbackModel: " gpt-6.1-sol ", fallbackEffort: "high" };
  assert.deepEqual(formToInput(form, NOW).input.fallback, { provider: "codex", model: "gpt-6.1-sol", effort: "high" });
  assert.equal("fallback" in formToInput(linearForm(), NOW).input, false);
  const routine = { ...formToInput(form, NOW).input, id: "r1", enabled: true, runCount: 0, createdAt: NOW, updatedAt: NOW, createdBy: { kind: "user" } };
  const opened = formFromRoutine(routine, "UTC", NOW);
  assert.deepEqual([opened.fallbackProvider, opened.fallbackModel, opened.fallbackEffort], ["codex", "gpt-6.1-sol", "high"]);
  assert.deepEqual(formToUpdate({ ...opened, fallbackEffort: "" }, routine, NOW).patch.fallback, { provider: "codex", model: "gpt-6.1-sol" });
  assert.equal(formToUpdate({ ...opened, fallbackProvider: "", fallbackModel: "" }, routine, NOW).patch.fallback, null);
});

test("only Runs in a Chat of their own retry: a Heartbeat and a comment Routine have no fallback", () => {
  assert.equal(fallbackApplies(linearForm()), true);
  assert.equal(fallbackApplies({ ...linearForm(), runIn: "project" }), true);
  assert.equal(fallbackApplies({ ...linearForm(), runIn: "chat" }), false);
  assert.equal(fallbackApplies({ ...linearForm(), linear: { ...linearForm().linear, event: "comment" } }), false);
  const heartbeat = withRunIn(
    {
      ...emptyRoutineForm("UTC", NOW),
      name: "beat",
      prompt: "p",
      chatId: "/code/app#3",
      projectPath: "/code/app",
      fallbackProvider: "codex",
      fallbackModel: "gpt-6.1-sol",
    },
    "chat",
    NOW,
  );
  assert.equal("fallback" in formToInput(heartbeat, NOW).input, false);
});
