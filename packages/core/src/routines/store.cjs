const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { everyToCron, nextRun } = require("./cron.cjs");

const DEFAULT_EXPIRY_MS = 7 * 864e5;
// Every heartbeat ends, and none runs for longer than this.
const MAX_EXPIRY_MS = 30 * 864e5;
const MISSED_AFTER_MS = 60_000;
const MAX_RUNS_KEPT = 50;
const UNIT_MS = { m: 60_000, h: 3600_000, d: 864e5 };
const UPDATABLE = new Set([
  "name",
  "prompt",
  "cron",
  "timezone",
  "maxRuns",
  "expiresAt",
  "enabled",
  "provider",
  "model",
  "permissionMode",
  "trigger",
  "target",
]);
// These end a run's life in a count: skipped-busy and missed runs never ran, so they are not counted.
const FINISH_STATUSES = new Set(["acted", "quiet", "failed", "skipped-busy"]);
const COUNTED = new Set(["acted", "quiet", "failed"]);
// A heartbeat that keeps failing (no agent CLI, a Chat that can't take turns) ends itself rather than fail forever;
// a trigger is paused instead, so its owner can fix what fails and switch it back on.
const MAX_FAILED_IN_A_ROW = 3;
const NAME_MAX = 80;
const PROMPT_MAX = 4000;
const MAX_RUNS_LIMIT = 1000;
const LINEAR_EVENTS = ["assigned", "label-added", "state", "comment"];
const HOOK_ID = /^[0-9a-f]{64}$/i;
// Events of a Linear or webhook Routine wait here when it already has this many Runs going, in order.
const CONCURRENT_RUNS = 3;
const QUEUE_MAX = 20;
// The event keys a Routine remembers, so a poll that sees a change again can't start a second Run for it.
const SEEN_KEPT = 500;
// A comment is only worth answering while it is fresh.
const COMMENT_MAX_WAIT_MS = 2 * 3600_000;

function parseExpiresIn(value) {
  const match = typeof value === "string" ? /^(\d+)([mhd])$/.exec(value) : null;
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid expiresIn: ${JSON.stringify(value)} (use e.g. 30m, 6h or 7d)`);
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  if (ms > MAX_EXPIRY_MS) throw new Error(`expiresIn ${JSON.stringify(value)} is too long: a heartbeat runs for at most 30d`);
  return ms;
}

const copy = (value) => (value === undefined ? value : structuredClone(value));

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// What a Routine is made of is checked here, the same way for a new one and for a change. Each check returns the clean
// value or throws, and nothing is saved until every one has passed.
function checkText(value, field, max = Infinity) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new Error(`${field} must be a non-empty string${max === Infinity ? "" : ` of at most ${max} characters`}`);
  }
  return value;
}

function checkFlag(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be true or false`);
  return value;
}

function checkMaxRuns(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RUNS_LIMIT) throw new Error(`maxRuns must be a whole number from 1 to ${MAX_RUNS_LIMIT}`);
  return value;
}

function checkExpiresAt(value, at) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("expiresAt must be a time in milliseconds");
  if (value > at + MAX_EXPIRY_MS) throw new Error("A Routine ends at most 30d from now");
  return value;
}

// A trigger with only the fields its kind has. A schedule's cron and timezone are checked by `nextRun`, which the caller
// runs because it needs the time anyway.
function checkTrigger(value) {
  if (!isObject(value)) throw new Error("A Routine needs a trigger");
  switch (value.kind) {
    case "schedule":
      return { kind: "schedule", cron: checkText(value.cron, "cron"), timezone: checkText(value.timezone, "timezone") };
    case "linear": {
      if (!LINEAR_EVENTS.includes(value.event)) throw new Error(`event must be one of ${LINEAR_EVENTS.join(", ")}`);
      const trigger = { kind: "linear", workspace: checkText(value.workspace, "workspace"), event: value.event };
      for (const key of ["team", "label", "state"]) if (value[key] !== undefined) trigger[key] = checkText(value[key], key);
      return trigger;
    }
    case "webhook": {
      if (typeof value.hookId !== "string" || !HOOK_ID.test(value.hookId)) throw new Error("hookId must be 64 hex characters");
      // hookId is a lowercase sha256 everywhere else, so one spelling is all a lookup has to know. Unsigned unless it says so.
      return { kind: "webhook", hookId: value.hookId.toLowerCase(), signed: value.signed === undefined ? false : checkFlag(value.signed, "signed") };
    }
    default:
      throw new Error("trigger kind must be schedule, linear or webhook");
  }
}

function checkTarget(value) {
  if (!isObject(value)) throw new Error("A Routine needs a target");
  switch (value.kind) {
    case "chat":
      return { kind: "chat", chatId: checkText(value.chatId, "chatId") };
    case "new-chat":
      if (value.workspace !== "worktree" && value.workspace !== "project") throw new Error("target workspace must be worktree or project");
      return { kind: "new-chat", projectPath: checkText(value.projectPath, "projectPath"), workspace: value.workspace };
    default:
      throw new Error("target kind must be chat or new-chat");
  }
}

function checkCreatedBy(value) {
  if (isObject(value) && value.kind === "user") return { kind: "user" };
  if (isObject(value) && value.kind === "agent") return { kind: "agent", chatId: checkText(value.chatId, "createdBy chatId") };
  throw new Error("createdBy must be the user or an agent Chat");
}

function assertEvent(value) {
  if (!isObject(value) || (value.kind !== "linear" && value.kind !== "webhook") || typeof value.key !== "string" || value.key === "") {
    throw new Error("An event needs a kind of linear or webhook, and a key");
  }
}

function markCompleted(routine, at) {
  routine.completedAt = at;
  routine.enabled = false;
  routine.nextRunAt = null;
  routine.updatedAt = at;
}

// `countsToFailures` is false for a failed Run that must not add to the streak (see recoverInterrupted).
function finish(routine, run, status, extra, at, countsToFailures = true) {
  run.status = status;
  run.endedAt = at;
  if (extra.summary !== undefined) run.summary = extra.summary;
  if (extra.error !== undefined) run.error = extra.error;
  if (extra.chatId !== undefined) run.chatId = extra.chatId;
  routine.lastRunAt = run.startedAt;
  routine.updatedAt = at;
  if (COUNTED.has(status)) routine.runCount += 1;
  // How many counted Runs in a row failed: skipped-busy and missed ones neither break nor extend it.
  if (status === "failed") {
    if (countsToFailures) routine.failedStreak = (routine.failedStreak ?? 0) + 1;
  } else if (COUNTED.has(status)) routine.failedStreak = 0;
  if (routine.completedAt) return;
  if (routine.maxRuns !== undefined && routine.runCount >= routine.maxRuns) markCompleted(routine, at);
  else if (routine.failedStreak >= MAX_FAILED_IN_A_ROW) {
    if (routine.target.kind === "new-chat") {
      // A trigger stays listed with the reason. One already switched off keeps whatever reason it had.
      if (routine.enabled) {
        routine.enabled = false;
        routine.pausedReason = `${MAX_FAILED_IN_A_ROW} failed runs in a row${run.error ? `: ${run.error}` : ""}`;
      }
    } else {
      run.error = `${run.error ?? "failed"} · ${MAX_FAILED_IN_A_ROW} failed beats in a row`;
      markCompleted(routine, at);
    }
  }
}

function empty() {
  return { version: 1, enabled: false, routines: [], runs: {}, queues: {}, seen: {}, linear: {} };
}

// The entries of a saved object that pass `valid`; what a damaged file holds besides that is left out.
const keepValid = (value, valid) => Object.fromEntries(Object.entries(isObject(value) ? value : {}).filter(([, entry]) => valid(entry)));

/**
 * The daemon's Routines and their Runs in one JSON file, with the queue of events each trigger is waiting to run (`queues`),
 * the keys of the events it has seen (`seen`) and how far each Linear workspace has been read (`linear`). Reads are cached
 * in memory; every mutation is synchronous and rewrites the whole file once (temp file plus rename, like limit-switch.cjs).
 */
function createRoutineStore({ file, now = Date.now, id = () => crypto.randomBytes(4).toString("hex") }) {
  let data = load();

  function load() {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return empty();
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.routines) || !parsed.runs || typeof parsed.runs !== "object") {
        throw new Error("unexpected shape");
      }
      return {
        version: 1,
        enabled: parsed.enabled === true,
        routines: parsed.routines,
        runs: parsed.runs,
        // Files saved before triggers existed have none of these.
        queues: keepValid(parsed.queues, Array.isArray),
        seen: keepValid(parsed.seen, Array.isArray),
        linear: keepValid(parsed.linear, Number.isFinite),
      };
    } catch {
      try {
        fs.renameSync(file, `${file}.corrupt`);
      } catch {}
      return empty();
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data));
    fs.renameSync(temp, file);
  }

  const find = (routineId) => data.routines.find((routine) => routine.id === routineId);

  function findRun(runId) {
    for (const routine of data.routines) {
      const run = (data.runs[routine.id] ?? []).find((item) => item.id === runId);
      if (run) return { routine, run };
    }
    return null;
  }

  function appendRun(routineId, run) {
    const kept = data.runs[routineId] ?? (data.runs[routineId] = []);
    kept.push(run);
    // The newest MAX_RUNS_KEPT stay, oldest out first. A Run still in flight is never dropped, whatever floods in after
    // it (missed Runs of a full queue): finishing it needs its record.
    for (let index = 0; kept.length > MAX_RUNS_KEPT && index < kept.length - 1;) {
      if (kept[index].status === "running") index += 1;
      else kept.splice(index, 1);
    }
  }

  // No other live Routine may use the webhook: the URL would start both.
  function assertHookFree(hookId, exceptId) {
    const taken = data.routines.some(
      (routine) => routine.id !== exceptId && !routine.completedAt && routine.trigger.kind === "webhook" && routine.trigger.hookId === hookId,
    );
    if (taken) throw new Error("Another Routine already uses that webhook");
  }

  function enabled() {
    return data.enabled;
  }
  function setEnabled(value) {
    data.enabled = value === true;
    save();
    return data.enabled;
  }

  function list() {
    return data.routines
      .filter((routine) => !routine.completedAt)
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .map(copy);
  }
  function get(routineId) {
    return copy(find(routineId) ?? null);
  }
  function runs(routineId) {
    return (data.runs[routineId] ?? []).toReversed().map(copy);
  }

  function upsertHeartbeat({ chatId, name, prompt, cron, every, timezone, maxRuns, expiresIn, provider, model, permissionMode, createdBy }) {
    if ((cron === undefined) === (every === undefined)) throw new Error("Give exactly one of cron or every");
    if (typeof timezone !== "string" || timezone === "") throw new Error("A heartbeat needs a timezone");
    if (typeof name !== "string" || name.trim() === "") throw new Error("A heartbeat needs a name");
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("A heartbeat needs a prompt");
    const at = now();
    const expression = cron ?? everyToCron(every);
    const nextRunAt = nextRun(expression, timezone, at);
    const existing = data.routines.find((routine) => !routine.completedAt && routine.name === name && routine.target.chatId === chatId);
    // Set again with no end of its own, a heartbeat keeps the end it had rather than run 7 more days.
    const keepEnd = expiresIn === undefined && maxRuns === undefined && existing && (existing.expiresAt !== undefined || existing.maxRuns !== undefined);
    if (keepEnd) maxRuns = existing.maxRuns;
    const expiresAt = keepEnd
      ? existing.expiresAt
      : expiresIn !== undefined
        ? at + parseExpiresIn(expiresIn)
        : maxRuns === undefined
          ? at + DEFAULT_EXPIRY_MS
          : undefined;
    const routine = {
      id: existing?.id ?? id(),
      name,
      prompt,
      trigger: { kind: "schedule", cron: expression, timezone },
      target: { kind: "chat", chatId },
      enabled: true,
      createdBy,
      nextRunAt,
      runCount: existing?.runCount ?? 0,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    if (provider !== undefined) routine.provider = provider;
    if (model !== undefined) routine.model = model;
    if (permissionMode !== undefined) routine.permissionMode = permissionMode;
    if (maxRuns !== undefined) routine.maxRuns = maxRuns;
    if (expiresAt !== undefined) routine.expiresAt = expiresAt;
    if (existing?.lastRunAt !== undefined) routine.lastRunAt = existing.lastRunAt;
    if (existing) data.routines[data.routines.indexOf(existing)] = routine;
    else data.routines.push(routine);
    save();
    return copy(routine);
  }

  /**
   * A new Routine of any trigger. `trigger`, `target` and `createdBy` are required; only a schedule trigger can target an
   * existing Chat (a Heartbeat, which always ends: 7 days unless it names an end), and every other Routine may run forever.
   */
  function create(input) {
    if (!isObject(input)) throw new Error("A Routine needs its settings");
    const at = now();
    // This mistake is named before any field of the trigger or target is checked.
    if (input.target?.kind === "chat" && (input.trigger?.kind === "linear" || input.trigger?.kind === "webhook")) {
      throw new Error("Only schedule triggers can target an existing Chat");
    }
    const name = checkText(input.name, "name", NAME_MAX);
    const prompt = checkText(input.prompt, "prompt", PROMPT_MAX);
    const trigger = checkTrigger(input.trigger);
    const target = checkTarget(input.target);
    const createdBy = checkCreatedBy(input.createdBy);
    const routine = { id: id(), name, prompt, trigger, target, enabled: true, createdBy, runCount: 0, createdAt: at, updatedAt: at };
    for (const key of ["provider", "model", "permissionMode"]) if (input[key] != null) routine[key] = checkText(input[key], key);
    if (input.maxRuns != null) routine.maxRuns = checkMaxRuns(input.maxRuns);
    if (input.expiresAt != null) routine.expiresAt = checkExpiresAt(input.expiresAt, at);
    else if (target.kind === "chat" && routine.maxRuns === undefined) routine.expiresAt = at + DEFAULT_EXPIRY_MS;
    if (trigger.kind === "schedule") routine.nextRunAt = nextRun(trigger.cron, trigger.timezone, at);
    if (trigger.kind === "webhook") assertHookFree(trigger.hookId);
    data.routines.push(routine);
    save();
    return copy(routine);
  }

  /**
   * Changes a Routine. `trigger` and `target` replace the stored one whole, after the same checks as `create`, and must be
   * of the same kind. `null` clears provider, model, permissionMode, maxRuns and expiresAt. Nothing changes unless all of it is valid.
   */
  function update(routineId, patch) {
    const routine = find(routineId);
    if (!routine) throw new Error(`Routine not found: ${routineId}`);
    if (routine.completedAt) throw new Error(`Routine is completed: ${routineId}`);
    if (!isObject(patch)) throw new Error("A Routine change must be an object");
    for (const key of Object.keys(patch)) if (!UPDATABLE.has(key)) throw new Error(`Cannot update ${key}`);
    const at = now();
    const next = copy(routine);
    if (patch.name !== undefined) next.name = checkText(patch.name, "name", NAME_MAX);
    if (patch.prompt !== undefined) next.prompt = checkText(patch.prompt, "prompt", PROMPT_MAX);
    if (patch.enabled !== undefined) next.enabled = checkFlag(patch.enabled, "enabled");
    for (const key of ["provider", "model", "permissionMode"]) {
      if (patch[key] === null) delete next[key];
      else if (patch[key] !== undefined) next[key] = checkText(patch[key], key);
    }
    if (patch.maxRuns === null) delete next.maxRuns;
    else if (patch.maxRuns !== undefined) next.maxRuns = checkMaxRuns(patch.maxRuns);
    if (patch.expiresAt === null) delete next.expiresAt;
    else if (patch.expiresAt !== undefined) next.expiresAt = checkExpiresAt(patch.expiresAt, at);
    if (patch.trigger !== undefined) {
      if (!isObject(patch.trigger)) throw new Error("trigger must be an object");
      if (patch.trigger.kind !== routine.trigger.kind) throw new Error("Can't change a Routine's trigger kind");
      next.trigger = checkTrigger(patch.trigger);
      if (next.trigger.kind === "webhook") assertHookFree(next.trigger.hookId, routine.id);
    }
    if (patch.target !== undefined) {
      if (!isObject(patch.target)) throw new Error("target must be an object");
      if (patch.target.kind !== routine.target.kind) throw new Error("Can't change a Routine's target kind");
      next.target = checkTarget(patch.target);
    }
    // A cron or timezone given next to a whole trigger changes that trigger.
    if (patch.cron !== undefined || patch.timezone !== undefined) {
      if (next.trigger.kind !== "schedule") throw new Error("Only a schedule trigger has a cron or timezone");
      if (patch.cron !== undefined) next.trigger.cron = checkText(patch.cron, "cron");
      if (patch.timezone !== undefined) next.trigger.timezone = checkText(patch.timezone, "timezone");
    }
    if (next.target.kind === "chat" && next.maxRuns === undefined && next.expiresAt === undefined) {
      throw new Error("Heartbeats need an end: keep maxRuns or expiresAt");
    }
    // Switching a Routine on starts its failure count over, and ends the pause that count may have caused.
    const switchedOn = patch.enabled === true && !routine.enabled;
    if (switchedOn) {
      delete next.pausedReason;
      delete next.failedStreak;
    }
    const retimed = patch.trigger !== undefined || patch.cron !== undefined || patch.timezone !== undefined;
    if (next.trigger.kind === "schedule" && (retimed || switchedOn)) next.nextRunAt = nextRun(next.trigger.cron, next.trigger.timezone, at);
    next.updatedAt = at;
    data.routines[data.routines.indexOf(routine)] = next;
    save();
    return copy(next);
  }

  function remove(routineId) {
    const routine = find(routineId);
    if (!routine) return false;
    data.routines.splice(data.routines.indexOf(routine), 1);
    delete data.runs[routineId];
    delete data.queues[routineId];
    delete data.seen[routineId];
    save();
    return true;
  }

  function claimDue(at) {
    const claims = [];
    let changed = false;
    for (const routine of data.routines) {
      if (!routine.enabled || routine.completedAt || routine.nextRunAt == null || routine.nextRunAt > at) continue;
      const scheduledFor = routine.nextRunAt;
      const late = scheduledFor < at - MISSED_AFTER_MS;
      const run = { id: id(), routineId: routine.id, scheduledFor, startedAt: at, status: late ? "missed" : "running" };
      if (late) run.endedAt = at;
      appendRun(routine.id, run);
      routine.nextRunAt = nextRun(routine.trigger.cron, routine.trigger.timezone, at);
      routine.updatedAt = at;
      if (!late) claims.push({ routine: copy(routine), run: copy(run) });
      changed = true;
    }
    if (changed) save();
    return claims;
  }

  // A Run outside the schedule (run now): same shape as a claimed one, but nextRunAt stays where it is.
  function startRun(routineId, at) {
    const routine = find(routineId);
    if (!routine || routine.completedAt) return null;
    const run = { id: id(), routineId, scheduledFor: at, startedAt: at, status: "running" };
    appendRun(routineId, run);
    save();
    return { routine: copy(routine), run: copy(run) };
  }

  // An event of a Linear or webhook Routine waits for a free slot. Its key is remembered from now on, so seeing the same
  // change again (the next poll, a redelivery) never starts a second Run, however the first one ends.
  function enqueue(routineId, event) {
    assertEvent(event);
    const routine = find(routineId);
    if (!routine || !routine.enabled || routine.completedAt) return { queued: false, reason: "disabled" };
    const waiting = data.queues[routineId] ?? [];
    if ((data.seen[routineId] ?? []).includes(event.key) || waiting.some((item) => item.event.key === event.key)) return { queued: false, reason: "seen" };
    const at = now();
    const keys = data.seen[routineId] ?? (data.seen[routineId] = []);
    keys.push(event.key);
    if (keys.length > SEEN_KEPT) keys.splice(0, keys.length - SEEN_KEPT);
    if (waiting.length >= QUEUE_MAX) {
      // The event is answered with a Run of its own, so it is also not tried again later.
      appendRun(routineId, { id: id(), routineId, scheduledFor: at, startedAt: at, endedAt: at, status: "missed", error: "queue full", event: copy(event) });
      save();
      return { queued: false, reason: "full" };
    }
    (data.queues[routineId] ?? (data.queues[routineId] = [])).push({ id: id(), event: copy(event), enqueuedAt: at });
    save();
    return { queued: true };
  }

  // Moves queued events into running Runs, oldest first. A Routine never has more than `limit` Runs going (or more than its
  // maxRuns leaves), and an event not due yet (`notBefore`) waits without holding back the ones behind it.
  function claimQueued(at, limit = CONCURRENT_RUNS) {
    const claims = [];
    let changed = false;
    for (const routine of data.routines) {
      const queue = data.queues[routine.id];
      if (!queue?.length || !routine.enabled || routine.completedAt) continue;
      const running = (data.runs[routine.id] ?? []).filter((run) => run.status === "running").length;
      let room = Math.min(limit - running, routine.maxRuns === undefined ? Infinity : routine.maxRuns - routine.runCount - running);
      const waiting = [];
      for (const item of queue) {
        const { event } = item;
        if (event.kind === "linear" && event.change === "comment" && at - item.enqueuedAt > COMMENT_MAX_WAIT_MS) {
          // Answering a comment hours late helps no one, and it takes no slot.
          appendRun(routine.id, {
            id: id(),
            routineId: routine.id,
            scheduledFor: item.enqueuedAt,
            startedAt: at,
            endedAt: at,
            status: "missed",
            error: "comment waited 2 h",
            event,
          });
        } else if (room > 0 && (item.notBefore ?? 0) <= at) {
          // scheduledFor is when the event arrived, which deferRun hands back to the queue.
          const run = { id: id(), routineId: routine.id, scheduledFor: item.enqueuedAt, startedAt: at, status: "running", event };
          appendRun(routine.id, run);
          claims.push({ routine: copy(routine), run: copy(run) });
          room -= 1;
        } else {
          waiting.push(item);
          continue;
        }
        changed = true;
      }
      if (waiting.length === queue.length) continue;
      if (waiting.length) data.queues[routine.id] = waiting;
      else delete data.queues[routine.id];
    }
    if (changed) save();
    return claims;
  }

  // Gives a running event Run back to the queue, at its head and not before `notBefore`, as if it had not started: its
  // record goes and nothing is counted. It keeps the time its event arrived, so a comment that keeps waiting still ends.
  function deferRun(runId, notBefore) {
    if (typeof notBefore !== "number" || !Number.isFinite(notBefore)) throw new Error("notBefore must be a time in milliseconds");
    const found = findRun(runId);
    if (!found || found.run.status !== "running" || !found.run.event) return false;
    const { routine, run } = found;
    data.runs[routine.id].splice(data.runs[routine.id].indexOf(run), 1);
    (data.queues[routine.id] ?? (data.queues[routine.id] = [])).unshift({ id: id(), event: run.event, enqueuedAt: run.scheduledFor ?? now(), notBefore });
    save();
    return true;
  }

  // Records where a Run's Chat was started. The Worktree is left out when the Run works in the Project folder.
  function attachChat(runId, chat) {
    const { chatId, worktreeId } = isObject(chat) ? chat : {};
    checkText(chatId, "chatId");
    if (worktreeId !== undefined) checkText(worktreeId, "worktreeId");
    const found = findRun(runId);
    if (!found) return false;
    found.run.chatId = chatId;
    if (worktreeId !== undefined) found.run.worktreeId = worktreeId;
    save();
    return true;
  }

  function finishRun(runId, { status, summary, error, chatId }) {
    if (!FINISH_STATUSES.has(status)) throw new Error(`Invalid run status: ${JSON.stringify(status)}`);
    const found = findRun(runId);
    // Only a run still in flight can be finished; a second call must not recount it.
    if (!found || found.run.status !== "running") return null;
    finish(found.routine, found.run, status, { summary, error, chatId }, now());
    save();
    return copy(found.routine);
  }

  // Switches a Routine off and says why. It stays listed, and switching it on again (update) clears the reason.
  function pause(routineId, reason) {
    checkText(reason, "reason");
    const routine = find(routineId);
    if (!routine || routine.completedAt) return null;
    routine.enabled = false;
    routine.pausedReason = reason;
    routine.updatedAt = now();
    save();
    return copy(routine);
  }

  // What is wrong with a Routine right now, apart from its Runs (Linear sign-in needed); null clears it. Writes only on a change.
  function setLastError(routineId, message) {
    if (message !== null && (typeof message !== "string" || message === "")) throw new Error("lastError must be a message or null");
    const routine = find(routineId);
    if (!routine) return null;
    if (routine.lastError === (message ?? undefined)) return copy(routine);
    if (message === null) delete routine.lastError;
    else routine.lastError = message;
    routine.updatedAt = now();
    save();
    return copy(routine);
  }

  // How far a Linear workspace has been read, as a time in milliseconds.
  function linearCursor(workspace) {
    checkText(workspace, "workspace");
    return Object.hasOwn(data.linear, workspace) ? data.linear[workspace] : undefined;
  }
  function setLinearCursor(workspace, at) {
    checkText(workspace, "workspace");
    if (typeof at !== "number" || !Number.isFinite(at)) throw new Error("cursor must be a time in milliseconds");
    if (data.linear[workspace] === at) return;
    data.linear[workspace] = at;
    save();
  }

  // The webhooks a relay should hold deliveries for.
  function hookIds() {
    return data.routines
      .filter((routine) => routine.enabled && !routine.completedAt && routine.trigger.kind === "webhook")
      .map((routine) => routine.trigger.hookId);
  }

  function complete(routineId, _reason) {
    const routine = find(routineId);
    if (!routine) return null;
    markCompleted(routine, now());
    save();
    return copy(routine);
  }

  function expireDue(at) {
    let changed = false;
    for (const routine of data.routines) {
      if (routine.completedAt || routine.expiresAt === undefined || routine.expiresAt > at) continue;
      markCompleted(routine, at);
      changed = true;
    }
    if (changed) save();
  }

  // Runs left running by a stop fail, and queued events stay queued. A restart is one failure however many Runs it cut
  // short (a busy trigger has up to three), so only the first adds to the failure streak.
  function recoverInterrupted() {
    const at = now();
    for (const routine of data.routines) {
      let cut = 0;
      for (const run of data.runs[routine.id] ?? []) {
        if (run.status !== "running") continue;
        finish(routine, run, "failed", { error: "daemon restarted" }, at, cut === 0);
        cut += 1;
      }
      if (routine.enabled && !routine.completedAt && routine.nextRunAt != null && routine.nextRunAt <= at) {
        routine.nextRunAt = nextRun(routine.trigger.cron, routine.trigger.timezone, at);
      }
    }
    save();
  }

  return {
    enabled,
    setEnabled,
    list,
    get,
    runs,
    upsertHeartbeat,
    create,
    update,
    remove,
    claimDue,
    startRun,
    enqueue,
    claimQueued,
    deferRun,
    attachChat,
    finishRun,
    complete,
    pause,
    setLastError,
    linearCursor,
    setLinearCursor,
    hookIds,
    expireDue,
    recoverInterrupted,
  };
}

module.exports = { createRoutineStore };
