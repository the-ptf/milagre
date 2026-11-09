// The Routines form's state and what it saves: the `routines:create` input for a new Routine, the `routines:update` patch
// for an edited one. Desktop and phone both edit this state, so they validate the same way and send the same thing.
// Types: routine-form.d.mts.

const DAY_MS = 864e5;
// The store's limits (packages/core/src/routines/store.cjs, cron.cjs), so the form says no before the Mac does.
const MAX_EXPIRY_MS = 30 * DAY_MS;
const MAX_RUNS_LIMIT = 1000;
const NAME_MAX = 80;
const PROMPT_MAX = 4000;
const HEARTBEAT_DAYS = 7;
export const EVERY_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];
const MINUTES_RULE = `Every N minutes must divide 60 (${EVERY_MINUTES.join(", ")})`;
const HOURS_RULE = `Every N hours must divide 24 (${EVERY_HOURS.join(", ")})`;
const CHAT_ONLY_SCHEDULE = "Only schedule triggers can target an existing Chat";
const SIGNED_NEEDS_SECRET = "A signed webhook needs a signing secret";

/** The New Routine and Edit forms' prompt copy, the same on desktop and the phone. */
export const PROMPT_PLACEHOLDER = "What should the agent do on each Run? End with (pass) when there's nothing to do.";
export const PROMPT_HINT = "Type {{ for the Run's fields";
const DATA_NOTES = {
  linear: "Issue text is passed as data, not instructions.",
  webhook: "The request is passed as data, not instructions.",
};

/** The hint under the prompt for a trigger: an event's fields are data the agent reads, never instructions it follows. */
export function promptHint(trigger) {
  const note = DATA_NOTES[trigger];
  return note ? `${PROMPT_HINT}. ${note}` : PROMPT_HINT;
}

/**
 * What deleting a Routine does, as its delete confirmation and the Edit form's Delete Routine row say it. A Heartbeat checks
 * back on a Chat that is someone's own, and the delete leaves that Chat alone; any other Routine opens Run Chats, and the
 * delete archives the ones nobody has kept.
 */
export function deleteWarning(routine) {
  return routine?.target?.kind === "chat" ? "Its Chats stay." : "Its Runs stop, and its Run Chats you haven't kept are archived.";
}

const text = (value) => (typeof value === "string" ? value.trim() : "");
const fail = (field, error) => ({ field, error });

/**
 * Whether a Routine's Runs can retry on a fallback model: only a Run in a Chat of its own does. A Heartbeat's beat and a
 * Linear comment go into a Chat that runs on its own model.
 */
export function fallbackApplies(state) {
  return state.runIn !== "chat" && !isCommentRoutine(state);
}

// The fallback the form names ({ provider, model, effort? }), or null for the automatic pick.
function fallbackOf(state) {
  const provider = text(state.fallbackProvider);
  const model = text(state.fallbackModel);
  if (!provider || !model) return null;
  const effort = text(state.fallbackEffort);
  return { provider, model, ...(effort ? { effort } : {}) };
}

/** A new Routine's form: a schedule every hour in a new worktree, running until switched off. */
export function emptyRoutineForm(timezone, now = Date.now()) {
  return {
    name: "",
    trigger: "schedule",
    schedule: { mode: "every", every: 1, unit: "h", time: "09:00", days: [1, 2, 3, 4, 5], cron: "", timezone },
    linear: { workspace: "", event: "label-added", team: "", label: "", state: "" },
    webhook: { signingHeader: "", signingSecret: "" },
    projectPath: "",
    runIn: "worktree",
    chatId: "",
    provider: "",
    model: "",
    permissionMode: "",
    fallbackProvider: "",
    fallbackModel: "",
    fallbackEffort: "",
    prompt: "",
    stop: { kind: "never", runs: 10, at: now + HEARTBEAT_DAYS * DAY_MS },
  };
}

/** The form with Runs landing in `runIn`. A heartbeat can't run forever, so moving to a Chat turns Never into 7 days. */
export function withRunIn(state, runIn, now = Date.now()) {
  const stop = runIn === "chat" && state.stop.kind === "never" ? { ...state.stop, kind: "date", at: now + HEARTBEAT_DAYS * DAY_MS } : state.stop;
  return { ...state, runIn, stop };
}

const pad = (value) => String(value).padStart(2, "0");

/** The cron a schedule makes, in the shapes `triggerText` reads back as words, or why it can't make one. */
export function scheduleCron(schedule) {
  if (schedule.mode === "cron") {
    const cron = text(schedule.cron).split(/\s+/).join(" ");
    return cron ? { cron } : { error: "Give a cron expression" };
  }
  if (schedule.mode === "at") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(text(schedule.time));
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return { error: "Give a time as HH:MM" };
    const days = [...new Set(schedule.days ?? [])].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
    if (days.length === 0) return { error: "Pick at least one day" };
    const dayField = days.length === 7 ? "*" : days.join(",") === "1,2,3,4,5" ? "1-5" : days.join(",");
    return { cron: `${Number(match[2])} ${Number(match[1])} * * ${dayField}` };
  }
  let amount = Number(schedule.every);
  let unit = schedule.unit;
  if (unit === "min" && amount >= 60 && amount % 60 === 0) {
    amount /= 60;
    unit = "h";
  }
  if (unit === "min") return EVERY_MINUTES.includes(amount) ? { cron: `*/${amount} * * * *` } : { error: MINUTES_RULE };
  if (!EVERY_HOURS.includes(amount)) return { error: HOURS_RULE };
  return { cron: amount === 24 ? "0 0 * * *" : `0 */${amount} * * *` };
}

/** `at` on the wall clock of `timeZone`: its date, minutes into the day and weekday (0 is Sunday). */
function wallClock(at, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(at);
  const part = (type) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return { year: part("year"), month: part("month"), day: part("day"), minutes: (part("hour") % 24) * 60 + part("minute") };
}

/** The moment the wall clock of `timeZone` reads `minutes` into the day `offset` days after `wall`'s (minutes may run past midnight). */
function wallMoment(wall, offset, minutes, timeZone) {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day + offset, 0, minutes);
  let at = target;
  // The zone's offset at the guess, twice, so a day that changes its clock lands right.
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallClock(at, timeZone);
    at += target - Date.UTC(seen.year, seen.month - 1, seen.day, 0, seen.minutes);
  }
  return at;
}

/**
 * When a new schedule's first Run would start after `now`, on the wall clock of the schedule's own time zone (an Every or
 * At a time schedule; a raw cron, another trigger or an unknown zone gives null).
 */
export function firstRunAt(state, now = Date.now()) {
  if (state.trigger !== "schedule") return null;
  const { schedule } = state;
  let wall;
  try {
    wall = wallClock(now, schedule.timezone || undefined);
  } catch {
    return null;
  }
  const zone = schedule.timezone || undefined;
  if (schedule.mode === "every") {
    const made = scheduleCron(schedule);
    if (made.error) return null;
    const step = (schedule.unit === "h" ? 60 : 1) * Number(schedule.every);
    const next = (Math.floor(wall.minutes / step) + 1) * step;
    return wallMoment(wall, 0, next >= 1440 ? 1440 : next, zone);
  }
  const match = schedule.mode === "at" ? /^(\d{1,2}):(\d{2})$/.exec(schedule.time) : null;
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  for (let offset = 0; offset <= 7; offset += 1) {
    const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + offset)).getUTCDay();
    if (!schedule.days.includes(weekday)) continue;
    const at = wallMoment(wall, offset, minutes, zone);
    if (at > now) return at;
  }
  return null;
}

/** The form's schedule for a stored cron: Every or At when the form could have made it, Advanced (raw cron) otherwise. */
export function scheduleFromCron(cron, timezone) {
  const expression = text(cron);
  const base = { mode: "cron", every: 15, unit: "min", time: "09:00", days: [1, 2, 3, 4, 5], cron: expression, timezone };
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = expression.split(/\s+/);
  if (rest.length || dayOfWeek === undefined || dayOfMonth !== "*" || month !== "*") return base;
  const minutes = /^\*\/(\d+)$/.exec(minute)?.[1];
  if (minutes && hour === "*" && dayOfWeek === "*" && EVERY_MINUTES.includes(Number(minutes)))
    return { ...base, mode: "every", every: Number(minutes), unit: "min" };
  const hours = /^\*\/(\d+)$/.exec(hour)?.[1];
  if (hours && minute === "0" && dayOfWeek === "*" && EVERY_HOURS.includes(Number(hours))) return { ...base, mode: "every", every: Number(hours), unit: "h" };
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || Number(minute) > 59 || Number(hour) > 23) return base;
  let days;
  if (dayOfWeek === "*") days = [0, 1, 2, 3, 4, 5, 6];
  else if (dayOfWeek === "1-5") days = [1, 2, 3, 4, 5];
  else if (/^[0-6](,[0-6])*$/.test(dayOfWeek)) days = dayOfWeek.split(",").map(Number);
  else return base;
  return { ...base, mode: "at", time: `${pad(hour)}:${pad(minute)}`, days };
}

function triggerOf(state) {
  if (state.trigger === "schedule") {
    const made = scheduleCron(state.schedule);
    if (made.error) return fail("schedule", made.error);
    const timezone = text(state.schedule.timezone);
    if (!timezone) return fail("timezone", "Pick a timezone");
    return { trigger: { kind: "schedule", cron: made.cron, timezone } };
  }
  if (state.trigger === "linear") {
    const { workspace, event, team, label, state: linearState } = state.linear;
    if (!text(workspace)) return fail("workspace", "Pick a Linear workspace");
    const trigger = { kind: "linear", workspace: text(workspace), event };
    if (text(team)) trigger.team = text(team);
    if (event === "label-added") {
      if (!text(label)) return fail("label", "Pick the label to watch");
      trigger.label = text(label);
    }
    if (event === "state") {
      if (!text(linearState)) return fail("state", "Pick the state to watch");
      trigger.state = text(linearState);
    }
    return { trigger };
  }
  if (state.trigger === "webhook") return { trigger: { kind: "webhook" } };
  return fail("trigger", "Pick a trigger");
}

/** A Linear Routine on new comments: it has no Each run, because comments go into the Chat linked to the issue. */
export function isCommentRoutine(state) {
  return state.trigger === "linear" && state.linear?.event === "comment";
}

function targetOf(state) {
  // The Mac still keeps a new-chat target on a listed Project for a comment Routine (store.cjs checkTarget); its Runs
  // never use it, so the form fills it from the Project it has, in a Worktree.
  if (isCommentRoutine(state)) {
    if (!text(state.projectPath)) return fail("project", "Pick a Project");
    return { target: { kind: "new-chat", projectPath: state.projectPath, workspace: "worktree" } };
  }
  if (state.runIn === "chat") {
    if (state.trigger !== "schedule") return fail("runIn", CHAT_ONLY_SCHEDULE);
    if (!text(state.chatId)) return fail("chat", "Pick the Chat to check on");
    return { target: { kind: "chat", chatId: state.chatId } };
  }
  if (!text(state.projectPath)) return fail("project", "Pick a Project");
  return { target: { kind: "new-chat", projectPath: state.projectPath, workspace: state.runIn === "project" ? "project" : "worktree" } };
}

function endOf(state, now) {
  const { stop } = state;
  if (stop.kind === "runs") {
    const runs = Number(stop.runs);
    if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS_LIMIT) return fail("stop", `Give a number of runs from 1 to ${MAX_RUNS_LIMIT}`);
    return { maxRuns: runs };
  }
  if (stop.kind === "date") {
    const at = Number(stop.at);
    if (!Number.isFinite(at) || at <= now) return fail("stop", "Pick a date after today");
    if (at > now + MAX_EXPIRY_MS) return fail("stop", "A Routine ends at most 30 days from now");
    return { expiresAt: at };
  }
  if (state.runIn === "chat") return fail("stop", "A Heartbeat needs an end");
  return {};
}

function common(form, now) {
  // A comment Routine's Each run is hidden: whatever it last held (even an existing Chat) doesn't count.
  const state = isCommentRoutine(form) ? { ...form, runIn: "worktree" } : form;
  const name = text(state.name);
  if (!name) return fail("name", "Give the Routine a name");
  if (name.length > NAME_MAX) return fail("name", `A name is at most ${NAME_MAX} characters`);
  const trigger = triggerOf(state);
  if (trigger.error) return trigger;
  const target = targetOf(state);
  if (target.error) return target;
  const prompt = text(state.prompt);
  if (!prompt) return fail("prompt", "Write what the agent should do");
  if (prompt.length > PROMPT_MAX) return fail("prompt", `A prompt is at most ${PROMPT_MAX} characters`);
  const end = endOf(state, now);
  if (end.error) return end;
  return { name, prompt, trigger: trigger.trigger, target: target.target, end };
}

/** The `routines:create` input the form makes, or the field that is wrong and why. */
export function formToInput(state, now = Date.now()) {
  const made = common(state, now);
  if (made.error) return made;
  const input = { name: made.name, prompt: made.prompt, trigger: made.trigger, target: made.target };
  if (made.trigger.kind === "webhook") {
    // The Mac mints the URL and its hook id; the form only says whether a signature is checked.
    const secret = text(state.webhook.signingSecret);
    const signed = state.webhook.signed === true || Boolean(secret);
    if (signed && !secret) return fail("signingSecret", SIGNED_NEEDS_SECRET);
    input.trigger = { kind: "webhook", signed };
    if (signed) {
      input.signingSecret = secret;
      if (text(state.webhook.signingHeader)) input.signingHeader = text(state.webhook.signingHeader);
    }
  }
  for (const key of ["provider", "model", "permissionMode"]) if (text(state[key])) input[key] = text(state[key]);
  const fallback = fallbackOf(state);
  if (fallback && fallbackApplies(state)) input.fallback = fallback;
  return { input: { ...input, ...made.end } };
}

/** The form for editing `routine`. A webhook's signing header is the Routine's own (blank for the default). */
export function formFromRoutine(routine, timezone, now = Date.now()) {
  const empty = emptyRoutineForm(timezone, now);
  const { trigger, target } = routine;
  const state = {
    ...empty,
    name: routine.name,
    prompt: routine.prompt,
    trigger: trigger.kind,
    provider: routine.provider ?? "",
    model: routine.model ?? "",
    permissionMode: routine.permissionMode ?? "",
    fallbackProvider: routine.fallback?.provider ?? "",
    fallbackModel: routine.fallback?.model ?? "",
    fallbackEffort: routine.fallback?.effort ?? "",
  };
  if (trigger.kind === "schedule") state.schedule = scheduleFromCron(trigger.cron, trigger.timezone);
  if (trigger.kind === "linear")
    state.linear = { workspace: trigger.workspace, event: trigger.event, team: trigger.team ?? "", label: trigger.label ?? "", state: trigger.state ?? "" };
  if (trigger.kind === "webhook") state.webhook = { signed: trigger.signed, signingHeader: routine.signingHeader ?? "", signingSecret: "" };
  if (target.kind === "chat") {
    state.runIn = "chat";
    state.chatId = target.chatId;
  } else {
    state.runIn = target.workspace;
    state.projectPath = target.projectPath;
  }
  // The form shows one end; a Routine with both keeps its expiry in `at`, so an edit doesn't drop it (see formToUpdate).
  const at = routine.expiresAt ?? empty.stop.at;
  if (routine.maxRuns !== undefined) state.stop = { ...empty.stop, kind: "runs", runs: routine.maxRuns, at };
  else if (routine.expiresAt !== undefined) state.stop = { ...empty.stop, kind: "date", at };
  return state;
}

/**
 * The `routines:update` patch for an edited Routine: everything the form holds, with `null` clearing the model, mode and
 * end. The trigger kind and whether Runs land in a Chat stay as they were; a webhook keeps its hook id, and a comment
 * Routine its target (left out).
 */
export function formToUpdate(state, routine, now = Date.now()) {
  if (state.trigger !== routine.trigger.kind) return fail("trigger", "A Routine's trigger kind can't change");
  const comment = isCommentRoutine(state) && routine.target.kind === "new-chat";
  if (!comment && (state.runIn === "chat") !== (routine.target.kind === "chat"))
    return fail("runIn", "Where a Routine's Runs land can't change between a Chat and new Chats");
  const made = common(comment ? { ...state, projectPath: routine.target.projectPath } : state, now);
  if (made.error) return made;
  // A comment Routine keeps the target it has, left out of the patch: the form shows no Project or Each run for it, and
  // sending it would check again a Project the form hides, which may have left the list since.
  const patch = { name: made.name, prompt: made.prompt, trigger: made.trigger, ...(comment ? {} : { target: made.target }) };
  if (routine.trigger.kind === "webhook") {
    const secret = text(state.webhook.signingSecret);
    const signed = Boolean(secret) || (state.webhook.signed ?? routine.trigger.signed) === true;
    // Signing a webhook that had no secret needs one now, or every delivery would fail its check.
    if (signed && !secret && routine.trigger.signed !== true) return fail("signingSecret", SIGNED_NEEDS_SECRET);
    // No hook id: only a rotate changes it, and the one this form opened with is stale after a rotate.
    patch.trigger = { kind: "webhook", signed };
    if (secret) patch.signingSecret = secret;
    // A cleared header (null) goes back to the default.
    if (signed) patch.signingHeader = text(state.webhook.signingHeader) || null;
  }
  for (const key of ["provider", "model", "permissionMode"]) patch[key] = text(state[key]) || null;
  // A Routine whose Runs never retry (a Heartbeat, a comment Routine) keeps whatever it has.
  if (fallbackApplies(state)) patch.fallback = fallbackOf(state);
  patch.maxRuns = made.end.maxRuns ?? null;
  patch.expiresAt = made.end.expiresAt ?? null;
  // A run cap picked over a stored expiry keeps that expiry: the form shows only one end.
  if (state.stop.kind === "runs" && routine.maxRuns !== undefined && routine.expiresAt !== undefined) patch.expiresAt = routine.expiresAt;
  return { patch };
}
