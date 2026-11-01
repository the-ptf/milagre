const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const { normalizeBabysitSettings } = require("@milagre/shared/babysit");
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
  "fallback",
  "trigger",
  "target",
  "signingHeader",
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
// A pull request's repository as the Babysit poller names it: host/owner/repo, no spaces.
const PR_REPO = /^[^/\s]+(\/[^/\s]+){2,}$/;
// A babysit Routine works one pull request at a time, and its events wait for their turn in order.
const PULL_REQUEST_RUNS = 1;
// Events of a Linear or webhook Routine wait here when it already has this many Runs going, in order.
const CONCURRENT_RUNS = 3;
const QUEUE_MAX = 20;
// A Routine remembers the key of every event it saw for at least this long (a poll reaches back 24 h, a relay holds a
// delivery 24 h), so seeing a change again never starts a second Run for it. Older keys go, unless their event still waits
// or runs.
const SEEN_MAX_AGE_MS = 48 * 3600_000;
// Past this many young keys a Routine refuses new events (a missed Run each) rather than forget one.
const SEEN_MAX = 5000;
// A comment is only worth answering while it is fresh.
const COMMENT_MAX_WAIT_MS = 2 * 3600_000;
// Runs that never ran are kept apart, so a flood of them can't push out the Runs that did.
const SKIPPED = new Set(["missed", "skipped-busy"]);
const SKIPPED_KEPT = 50;
// Events refused for a bad signature: the newest ones kept as Runs (how many there were is counted apart), so a flood of
// them neither pushes real Runs out nor fills the seen ledger.
const REJECTED_KEPT = 50;
const RUN_STATUSES = new Set(["running", "acted", "quiet", "failed", "skipped-busy", "missed"]);
// A completed Routine stays this long after it ended, then goes with everything it kept.
const PURGE_AFTER_MS = 30 * 864e5;
const MAINTAIN_EVERY_MS = 3600_000;
const NO_NEXT_RUN = "schedule has no next run";
const VERSION = 1;

function parseExpiresIn(value) {
  const match = typeof value === "string" ? /^(\d+)([mhd])$/.exec(value) : null;
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid expiresIn: ${JSON.stringify(value)} (use e.g. 30m, 6h or 7d)`);
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  if (ms > MAX_EXPIRY_MS) throw new Error(`expiresIn ${JSON.stringify(value)} is too long: a Heartbeat runs for at most 30d`);
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

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
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
      // The event's own filter: which label was added, or which state the issue moved to.
      if (trigger.event === "label-added" && trigger.label === undefined) throw new Error("A label-added trigger needs a label");
      if (trigger.event === "state" && trigger.state === undefined) throw new Error("A state trigger needs a state");
      return trigger;
    }
    case "webhook": {
      if (typeof value.hookId !== "string" || !HOOK_ID.test(value.hookId)) throw new Error("hookId must be 64 hex characters");
      // hookId is a lowercase sha256 everywhere else, so one spelling is all a lookup has to know. Unsigned unless it says so.
      return { kind: "webhook", hookId: value.hookId.toLowerCase(), signed: value.signed === undefined ? false : checkFlag(value.signed, "signed") };
    }
    case "pull-request": {
      if (typeof value.url !== "string" || !isHttpUrl(value.url)) throw new Error("url must be an http(s) address");
      if (typeof value.repo !== "string" || !PR_REPO.test(value.repo)) throw new Error("repo must look like host/owner/repo");
      if (!Number.isInteger(value.number) || value.number < 1) throw new Error("number must be a positive whole number");
      // The settings are the ones in force when the PR is first watched; this Routine keeps its own copy.
      return { kind: "pull-request", url: value.url, repo: value.repo, number: value.number, settings: normalizeBabysitSettings(value.settings) };
    }
    default:
      throw new Error("trigger kind must be schedule, linear, webhook or pull-request");
  }
}

// The request header a webhook's HMAC signature comes in (an HTTP token), kept lowercased.
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
function checkSigningHeader(value, trigger) {
  if (trigger.kind !== "webhook") throw new Error("Only a webhook Routine has a signature header");
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!HEADER_NAME.test(name)) throw new Error("signingHeader must be a header name, such as x-hub-signature-256");
  return name;
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

// The model a Run in a Chat of its own retries on once when its own model fails for a provider-side reason (see
// scheduler.cjs providerFailure): a provider and a model, and an effort when it names one.
function checkFallback(value) {
  if (!isObject(value)) throw new Error("fallback must be an object with a provider and a model");
  const fallback = { provider: checkText(value.provider, "fallback provider", 40), model: checkText(value.model, "fallback model", 200) };
  if (value.effort != null) fallback.effort = checkText(value.effort, "fallback effort", 40);
  return fallback;
}

function checkCreatedBy(value) {
  if (isObject(value) && value.kind === "user") return { kind: "user" };
  if (isObject(value) && value.kind === "agent") return { kind: "agent", chatId: checkText(value.chatId, "createdBy chatId") };
  throw new Error("createdBy must be the user or an agent Chat");
}

// The names a comment event's issue goes by: its id, and its key, which changes when the issue moves to another team.
function issueNames(event) {
  const names = [];
  if (event.issue?.id) names.push(`id:${event.issue.id}`);
  if (event.issue?.key) names.push(`key:${event.issue.key}`);
  return names;
}

function assertEvent(value) {
  const kinds = ["linear", "webhook", "pull-request"];
  if (!isObject(value) || !kinds.includes(value.kind) || typeof value.key !== "string" || value.key === "") {
    throw new Error("An event needs a kind of linear, webhook or pull-request, and a key");
  }
}

function markCompleted(state, routine, at) {
  routine.completedAt = at;
  routine.enabled = false;
  routine.nextRunAt = null;
  routine.updatedAt = at;
  // Nothing it waited for will run, and nothing it sees will start a Run.
  delete state.queues[routine.id];
  delete state.seen[routine.id];
  delete state.pullRequests[routine.id];
}

// `countsToFailures` is false for a failed Run that must not add to the streak (see recoverInterrupted).
function finish(state, routine, run, status, extra, at, countsToFailures = true) {
  run.status = status;
  run.endedAt = at;
  if (extra.summary !== undefined) run.summary = extra.summary;
  if (extra.title !== undefined) run.title = extra.title;
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
  if (routine.maxRuns !== undefined && routine.runCount >= routine.maxRuns) markCompleted(state, routine, at);
  else if (routine.failedStreak >= MAX_FAILED_IN_A_ROW) {
    if (routine.target.kind === "new-chat") {
      // A trigger stays listed with the reason. One already switched off keeps whatever reason it had.
      if (routine.enabled) {
        routine.enabled = false;
        routine.pausedReason = `${MAX_FAILED_IN_A_ROW} failed runs in a row${run.error ? `: ${run.error}` : ""}`;
      }
    } else {
      run.error = `${run.error ?? "failed"} · ${MAX_FAILED_IN_A_ROW} failed beats in a row`;
      markCompleted(state, routine, at);
    }
  }
}

// The newest SKIPPED_KEPT Runs that never ran, the newest MAX_RUNS_KEPT acted ones (the Runs people open) and the newest
// MAX_RUNS_KEPT of the rest (quiet, failed and running), oldest out first, so a run of quiet Runs can't push out the ones
// that did something. A Run still in flight is never dropped, whatever floods in after it: finishing it needs its record.
function trimRuns(runs) {
  let skippedOver = -SKIPPED_KEPT;
  let rejectedOver = -REJECTED_KEPT;
  let actedOver = -MAX_RUNS_KEPT;
  let restOver = -MAX_RUNS_KEPT;
  for (const run of runs) {
    if (run.rejected === true) rejectedOver += 1;
    else if (SKIPPED.has(run.status)) skippedOver += 1;
    else if (run.status === "acted") actedOver += 1;
    else restOver += 1;
  }
  if (skippedOver <= 0 && rejectedOver <= 0 && actedOver <= 0 && restOver <= 0) return runs;
  return runs.filter((run) => {
    if (run.rejected === true) return rejectedOver-- <= 0;
    if (SKIPPED.has(run.status)) return skippedOver-- <= 0;
    if (run.status === "acted") return actedOver-- <= 0;
    return run.status === "running" || restOver-- <= 0;
  });
}

// The keys of the refused events a Routine still lists: a redelivery of one is answered already.
const rejectedKeys = (state, routineId) => (state.runs[routineId] ?? []).filter((run) => run.rejected === true && run.event).map((run) => run.event.key);

function empty() {
  return { version: VERSION, routines: [], runs: {}, queues: {}, seen: {}, rejections: {}, linear: {}, removed: {}, pullRequests: {} };
}

// The entries of a saved object that pass `valid`; what a damaged file holds besides that is left out.
const keepValid = (value, valid) => Object.fromEntries(Object.entries(isObject(value) ? value : {}).filter(([, entry]) => valid(entry)));

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const text = (value) => typeof value === "string";
const lower = (value) => String(value ?? "").toLowerCase();
const errorText = (error) => error?.message ?? String(error);

function validTrigger(trigger) {
  if (!isObject(trigger)) return false;
  if (trigger.kind === "schedule") return text(trigger.cron) && text(trigger.timezone);
  if (trigger.kind === "linear") return text(trigger.workspace) && LINEAR_EVENTS.includes(trigger.event);
  if (trigger.kind === "webhook") return text(trigger.hookId);
  if (trigger.kind === "pull-request") {
    return text(trigger.url) && text(trigger.repo) && Number.isInteger(trigger.number) && trigger.number >= 1 && isObject(trigger.settings);
  }
  return false;
}

function validTarget(target) {
  if (!isObject(target)) return false;
  if (target.kind === "chat") return text(target.chatId);
  if (target.kind === "new-chat") return text(target.projectPath);
  return false;
}

// Whether a saved Routine is whole enough to run: what the scheduler reads without checking is there and of its type.
function validRoutine(routine) {
  if (!isObject(routine) || !text(routine.id) || routine.id === "" || !text(routine.name) || !text(routine.prompt)) return false;
  if (typeof routine.enabled !== "boolean" || !validTrigger(routine.trigger) || !validTarget(routine.target)) return false;
  if (![routine.createdAt, routine.updatedAt, routine.runCount].every(finite)) return false;
  if (routine.nextRunAt != null && !finite(routine.nextRunAt)) return false;
  return ["maxRuns", "expiresAt", "completedAt", "lastRunAt", "failedStreak"].every((key) => routine[key] === undefined || finite(routine[key]));
}

const validRun = (run, routineId) => isObject(run) && text(run.id) && run.id !== "" && run.routineId === routineId && RUN_STATUSES.has(run.status);

// A saved queue item claimQueued can read.
const validQueued = (item) => isObject(item) && isObject(item.event) && text(item.event.key) && finite(item.enqueuedAt);

// Seen keys as `{ key, at }`. A file saved before they had an age gives its plain keys the age of now.
function readSeen(value, at) {
  return keepValid(
    Object.fromEntries(
      Object.entries(keepValid(value, Array.isArray)).map(([routineId, keys]) => [
        routineId,
        keys.flatMap((entry) => {
          if (text(entry) && entry !== "") return [{ key: entry, at }];
          if (isObject(entry) && text(entry.key) && entry.key !== "" && finite(entry.at)) return [{ key: entry.key, at: entry.at }];
          return [];
        }),
      ]),
    ),
    (keys) => keys.length > 0,
  );
}

function appendRun(state, routineId, run) {
  state.runs[routineId] = trimRuns([...(state.runs[routineId] ?? []), run]);
}

// Drops a Routine's seen keys older than 48 h, but never the key of an event still queued or running.
function pruneSeen(state, routineId, at) {
  const keys = state.seen[routineId];
  if (!keys) return false;
  const live = new Set((state.queues[routineId] ?? []).map((item) => item.event.key));
  for (const run of state.runs[routineId] ?? []) if (run.status === "running" && run.event) live.add(run.event.key);
  const kept = keys.filter((entry) => at - entry.at < SEEN_MAX_AGE_MS || live.has(entry.key));
  if (kept.length === keys.length) return false;
  if (kept.length) state.seen[routineId] = kept;
  else delete state.seen[routineId];
  return true;
}

// Upkeep, on load and at most hourly after: a Routine completed 30 days ago goes, with its Runs, queue, seen keys and any
// Linear cursor no other Routine reads, and is remembered as removed for good (`removed`, a few bytes each: a Project left
// closed for months still learns its Run Chats were left behind by it); seen keys past their age go. Says whether anything
// went.
function maintain(state, at, purgedIds = []) {
  let changed = false;
  state.removed ??= {};
  const purged = state.routines.filter((routine) => finite(routine.completedAt) && routine.completedAt + PURGE_AFTER_MS <= at);
  purgedIds.push(...purged.map((routine) => routine.id));
  if (purged.length) {
    changed = true;
    state.routines = state.routines.filter((routine) => !purged.includes(routine));
    for (const routine of purged) {
      state.removed[routine.id] = at;
      delete state.runs[routine.id];
      delete state.queues[routine.id];
      delete state.seen[routine.id];
      delete state.rejections[routine.id];
      delete state.pullRequests[routine.id];
    }
    const read = new Set(state.routines.filter((routine) => routine.trigger.kind === "linear").map((routine) => lower(routine.trigger.workspace)));
    for (const routine of purged) {
      if (routine.trigger.kind !== "linear") continue;
      const workspace = lower(routine.trigger.workspace);
      if (read.has(workspace)) continue;
      // The poller keeps one cursor for a workspace's issues and one for its comments.
      delete state.linear[workspace];
      delete state.linear[`${workspace}:comments`];
    }
  }
  for (const routineId of Object.keys(state.seen)) if (pruneSeen(state, routineId, at)) changed = true;
  return changed;
}

// The next time a schedule fires, or null when it never does: the Routine is then paused with the reason and the error,
// so the other Routines of the tick (or of a restart) go on.
function nextOrPause(routine, at) {
  try {
    return nextRun(routine.trigger.cron, routine.trigger.timezone, at);
  } catch (error) {
    routine.enabled = false;
    routine.pausedReason = NO_NEXT_RUN;
    routine.lastError = errorText(error);
    routine.nextRunAt = null;
    routine.updatedAt = at;
    return null;
  }
}

// No other live Routine may use the webhook: the URL would start both.
function assertHookFree(state, hookId, exceptId) {
  const taken = state.routines.some(
    (routine) => routine.id !== exceptId && !routine.completedAt && routine.trigger.kind === "webhook" && routine.trigger.hookId === hookId,
  );
  if (taken) throw new Error("Another Routine already uses that webhook");
}

// Whether a Routine is the live babysitter of pull request `number` of `repo` (host/owner/repo, any case).
const watchesPullRequest = (routine, repo, number) =>
  !routine.completedAt && routine.trigger.kind === "pull-request" && routine.trigger.number === number && lower(routine.trigger.repo) === lower(repo);

// One live Routine per pull request: two would answer every change twice.
function assertPullRequestFree(state, repo, number, exceptId) {
  if (state.routines.some((routine) => routine.id !== exceptId && watchesPullRequest(routine, repo, number))) {
    throw new Error(`Pull request #${number} is already being babysat`);
  }
}

// How many Runs a Routine may have going at once: a babysit Routine one, any other `limit`.
const slots = (routine, limit) => (routine.trigger.kind === "pull-request" ? Math.min(limit, PULL_REQUEST_RUNS) : limit);

const isDue = (routine, at) => routine.enabled && !routine.completedAt && routine.nextRunAt != null && routine.nextRunAt <= at;

const expired = (routine, at) => !routine.completedAt && routine.expiresAt !== undefined && routine.expiresAt <= at;

// Which Routine each Run belongs to, so a Run is found without scanning the others.
function indexRuns(state) {
  const index = new Map();
  for (const [routineId, runs] of Object.entries(state.runs)) for (const run of runs) index.set(run.id, routineId);
  return index;
}

// The Runs that have a Chat, as `{ routineId, runId, chatId }`. Taken before a change, they say which Chats lost their Run.
function chatRuns(state) {
  const found = [];
  for (const [routineId, runs] of Object.entries(state.runs)) {
    for (const run of runs) if (text(run.chatId) && run.chatId !== "") found.push({ routineId, runId: run.id, chatId: run.chatId });
  }
  return found;
}

/**
 * The daemon's Routines and their Runs in one JSON file, with the queue of events each trigger is waiting to run (`queues`),
 * the keys of the events it has seen (`seen`) and how far each Linear workspace has been read (`linear`). Reads are cached
 * in memory. Every mutation is synchronous and goes through `transact`: it changes a copy, writes the whole file once
 * (temp file plus rename, like limit-switch.cjs), and only then makes the copy current, so a failed write changes nothing.
 * A file it can't read (other than a missing one) or doesn't understand is never written: the store opens read-only.
 * `onPurged(ids)` hears which Routines upkeep purged (on load, and after the write that purged them), so what lives
 * outside the store, a webhook's secret, can go with them. `onRunsDropped([{ routineId, runId, chatId }])` hears the Runs
 * that had a Chat and are no longer in the store (trimmed, deleted with their Routine, or purged, on load too), once per
 * write or load, after it, so the Chats they left can be tidied. A Run without a Chat is never reported.
 */
function createRoutineStore({
  file,
  now = Date.now,
  id = () => crypto.randomBytes(4).toString("hex"),
  onPurged = () => {},
  onRunsDropped = () => {},
  onEnded = () => {},
}) {
  // Why every mutation is refused, or null.
  let readOnly = null;
  let maintainedAt = now();
  let data;
  let runIndex;
  let positions;
  publish(load());
  const purgedOnLoad = [];
  const chatRunsOnLoad = chatRuns(data);
  maintain(data, maintainedAt, purgedOnLoad);
  publish(data);
  if (purgedOnLoad.length) told(purgedOnLoad);
  toldDropped(droppedSince(chatRunsOnLoad));

  // The Routines a change ended, each once, with why ("expired" or what complete was given), after the write.
  function toldEnded(ended) {
    if (ended.length === 0) return;
    try {
      onEnded(ended);
    } catch (error) {
      console.warn("[routines] couldn't follow up on ended Routines", error);
    }
  }

  function told(ids) {
    try {
      onPurged(ids);
    } catch (error) {
      console.warn("[routines] couldn't clear up after purged Routines", error);
    }
  }

  // Of the Runs with a Chat taken before a change, those the published store no longer holds.
  function droppedSince(before) {
    return before.filter((run) => !runIndex.has(run.runId));
  }

  function toldDropped(dropped) {
    if (dropped.length === 0) return;
    try {
      onRunsDropped(dropped);
    } catch (error) {
      console.warn("[routines] couldn't clear up after dropped Runs", error);
    }
  }

  function publish(state) {
    data = state;
    runIndex = indexRuns(state);
    positions = new Map(state.routines.map((routine, index) => [routine.id, index]));
  }

  function openReadOnly(reason) {
    readOnly = reason;
    console.error(`[routines] Routine store is read-only: ${reason}`);
    return empty();
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      // Only a missing file means there is nothing yet; anything else may hide Routines a write would destroy.
      if (error?.code === "ENOENT") return empty();
      return openReadOnly(`could not read ${file}: ${errorText(error)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        fs.renameSync(file, `${file}.corrupt`);
      } catch {}
      return empty();
    }
    if (!isObject(parsed) || !Array.isArray(parsed.routines) || !isObject(parsed.runs)) return openReadOnly(`${file} has an unexpected shape`);
    if (parsed.version !== undefined && parsed.version !== VERSION) {
      return openReadOnly(
        finite(parsed.version) && parsed.version > VERSION
          ? `${file} is version ${parsed.version}, newer than this Milagre reads`
          : `${file} has an unknown version ${JSON.stringify(parsed.version)}`,
      );
    }
    const at = now();
    const invalid = { routines: [], runs: [] };
    const ids = new Set();
    const routines = [];
    for (const routine of parsed.routines) {
      if (validRoutine(routine) && !ids.has(routine.id)) {
        ids.add(routine.id);
        routines.push(routine);
      } else invalid.routines.push(routine);
    }
    const dropped = new Set(invalid.routines.filter(isObject).map((routine) => routine.id));
    const validRuns = {};
    for (const [routineId, saved] of Object.entries(parsed.runs)) {
      // The Runs of a Routine set aside go with it.
      if (!Array.isArray(saved) || (dropped.has(routineId) && !ids.has(routineId))) {
        invalid.runs.push(...(Array.isArray(saved) ? saved : [saved]));
        continue;
      }
      validRuns[routineId] = [];
      for (const run of saved) (validRun(run, routineId) ? validRuns[routineId] : invalid.runs).push(run);
    }
    const state = {
      // Files from before every computer ran Routines also have `enabled` and `aiConsentVersion`; they are dropped.
      version: VERSION,
      routines,
      runs: validRuns,
      // Files saved before triggers existed have none of these.
      queues: keepValid(
        Object.fromEntries(Object.entries(keepValid(parsed.queues, Array.isArray)).map(([routineId, queue]) => [routineId, queue.filter(validQueued)])),
        (queue) => queue.length > 0,
      ),
      seen: readSeen(parsed.seen, at),
      // Files saved before rejections were counted apart have none.
      rejections: keepValid(parsed.rejections, (count) => Number.isInteger(count) && count > 0),
      linear: keepValid(parsed.linear, Number.isFinite),
      // Files saved before deleted Routines were remembered have none.
      removed: keepValid(parsed.removed, Number.isFinite),
      // What the babysit poller last saw of each pull request (the store never reads inside it). Older files have none.
      pullRequests: keepValid(parsed.pullRequests, isObject),
    };
    if (invalid.routines.length || invalid.runs.length) {
      try {
        quarantine({ at, ...invalid });
      } catch (error) {
        return openReadOnly(`could not set invalid records aside: ${errorText(error)}`);
      }
      // Written back without them, so the next start doesn't set them aside again.
      try {
        write(state);
      } catch (error) {
        console.error("[routines] could not save the store without its invalid records", error);
      }
    }
    return state;
  }

  // Appends invalid records to `<file>.invalid.json` (without .json), an array of `{ at, routines, runs }`, mode 0600.
  function quarantine(entry) {
    const target = `${file.replace(/\.json$/, "")}.invalid.json`;
    let entries = [];
    try {
      const saved = JSON.parse(fs.readFileSync(target, "utf8"));
      if (!Array.isArray(saved)) throw new Error("not a list");
      entries = saved;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // One it can't read stays readable as it was; one it can read but not parse is moved aside, not overwritten.
        if (error?.code) throw error;
        fs.renameSync(target, `${target}.corrupt`);
      }
    }
    entries.push(entry);
    write(entries, target, 0o600);
  }

  function write(state, target = file, mode) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(state), mode === undefined ? undefined : { mode });
      fs.renameSync(temp, target);
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {}
      throw error;
    }
  }

  function assertWritable() {
    if (readOnly) throw new Error(`Routine store is read-only: ${readOnly}`);
  }

  const maintenanceDue = () => now() - maintainedAt >= MAINTAIN_EVERY_MS;

  /**
   * Runs `change(draft, tx)` on a copy of the store. When it sets `tx.changed` (or the hourly upkeep finds something to
   * drop), the copy is written and becomes the store; when anything throws, the store and its file stay as they were.
   */
  function transact(change) {
    assertWritable();
    const draft = structuredClone(data);
    const tx = { changed: false };
    const result = change(draft, tx);
    const at = now();
    const upkeep = at - maintainedAt >= MAINTAIN_EVERY_MS;
    const purgedIds = [];
    if (upkeep && maintain(draft, at, purgedIds)) tx.changed = true;
    let dropped = [];
    if (tx.changed) {
      const before = chatRuns(data);
      write(draft);
      publish(draft);
      dropped = droppedSince(before);
    }
    if (purgedIds.length) told(purgedIds);
    toldDropped(dropped);
    if (upkeep) maintainedAt = at;
    return result;
  }

  function find(state, routineId) {
    const routine = state.routines[positions.get(routineId)];
    // A Routine added or removed in this transaction moves the others; then it is looked for.
    return routine?.id === routineId ? routine : state.routines.find((item) => item.id === routineId);
  }

  function findRun(state, runId) {
    const routineId = runIndex.get(runId);
    const run = routineId === undefined ? undefined : state.runs[routineId]?.find((item) => item.id === runId);
    const routine = run && find(state, routineId);
    return routine ? { routine, run } : null;
  }

  function list() {
    return data.routines
      .filter((routine) => !routine.completedAt)
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .map(copy);
  }
  function get(routineId) {
    return copy(find(data, routineId) ?? null);
  }
  function runs(routineId) {
    return (data.runs[routineId] ?? []).toReversed().map(copy);
  }

  function upsertHeartbeat({ chatId, name, prompt, cron, every, timezone, maxRuns, expiresIn, provider, model, permissionMode, createdBy }) {
    assertWritable();
    if ((cron === undefined) === (every === undefined)) throw new Error("Give exactly one of cron or every");
    if (typeof timezone !== "string" || timezone === "") throw new Error("A Heartbeat needs a timezone");
    if (typeof name !== "string" || name.trim() === "") throw new Error("A Heartbeat needs a name");
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("A Heartbeat needs a prompt");
    const at = now();
    const expression = cron ?? everyToCron(every);
    // Worked out before anything changes: a schedule that never fires is refused here.
    const nextRunAt = nextRun(expression, timezone, at);
    return transact((state, tx) => {
      const existing = state.routines.find((routine) => !routine.completedAt && routine.name === name && routine.target.chatId === chatId);
      // Milagre's own babysit Routine is not a Heartbeat an agent can set again: it would turn into a schedule.
      if (existing?.trigger.kind === "pull-request") {
        throw new Error(`Babysit PR #${existing.trigger.number} is watched by Milagre; delete it from its Routine page first`);
      }
      // Set again with no end of its own, a heartbeat keeps the end it had rather than run 7 more days.
      const keepEnd = expiresIn === undefined && maxRuns === undefined && existing && (existing.expiresAt !== undefined || existing.maxRuns !== undefined);
      const runsCap = keepEnd ? existing.maxRuns : maxRuns;
      const expiresAt = keepEnd
        ? existing.expiresAt
        : expiresIn !== undefined
          ? at + parseExpiresIn(expiresIn)
          : runsCap === undefined
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
      if (runsCap !== undefined) routine.maxRuns = runsCap;
      if (expiresAt !== undefined) routine.expiresAt = expiresAt;
      if (existing?.lastRunAt !== undefined) routine.lastRunAt = existing.lastRunAt;
      if (existing) state.routines[state.routines.indexOf(existing)] = routine;
      else state.routines.push(routine);
      tx.changed = true;
      return copy(routine);
    });
  }

  /**
   * A new Routine of any trigger. `trigger`, `target` and `createdBy` are required; only a schedule or pull-request trigger
   * can target an existing Chat (a Heartbeat, which always ends: 7 days unless it names an end), a pull-request trigger can
   * target nothing else, and every other Routine may run forever.
   */
  function create(input) {
    assertWritable();
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
    if (trigger.kind === "pull-request" && target.kind !== "chat") throw new Error("A pull-request trigger must target an existing Chat");
    const createdBy = checkCreatedBy(input.createdBy);
    const routine = { id: id(), name, prompt, trigger, target, enabled: true, createdBy, runCount: 0, createdAt: at, updatedAt: at };
    for (const key of ["provider", "model", "permissionMode"]) if (input[key] != null) routine[key] = checkText(input[key], key);
    if (input.fallback != null) routine.fallback = checkFallback(input.fallback);
    if (input.maxRuns != null) routine.maxRuns = checkMaxRuns(input.maxRuns);
    if (input.signingHeader != null) routine.signingHeader = checkSigningHeader(input.signingHeader, trigger);
    if (input.expiresAt != null) routine.expiresAt = checkExpiresAt(input.expiresAt, at);
    // A pull-request Routine only advances on events, so a maxRuns alone would never end it: it always has an expiry.
    else if (target.kind === "chat" && (routine.maxRuns === undefined || trigger.kind === "pull-request")) routine.expiresAt = at + DEFAULT_EXPIRY_MS;
    if (trigger.kind === "schedule") routine.nextRunAt = nextRun(trigger.cron, trigger.timezone, at);
    return transact((state, tx) => {
      if (trigger.kind === "webhook") assertHookFree(state, trigger.hookId);
      if (trigger.kind === "pull-request") assertPullRequestFree(state, trigger.repo, trigger.number);
      state.routines.push(routine);
      tx.changed = true;
      return copy(routine);
    });
  }

  /**
   * Changes a Routine. `trigger` and `target` replace the stored one whole, after the same checks as `create`, and must be
   * of the same kind. `null` clears provider, model, permissionMode, fallback, maxRuns and expiresAt. Nothing changes unless all of it is valid.
   */
  function update(routineId, patch) {
    return transact((state, tx) => {
      const routine = find(state, routineId);
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
      if (patch.fallback === null) delete next.fallback;
      else if (patch.fallback !== undefined) next.fallback = checkFallback(patch.fallback);
      if (patch.maxRuns === null) delete next.maxRuns;
      else if (patch.maxRuns !== undefined) next.maxRuns = checkMaxRuns(patch.maxRuns);
      if (patch.expiresAt === null) {
        if (routine.trigger.kind === "pull-request") throw new Error("A babysit Routine always has an end: keep expiresAt");
        delete next.expiresAt;
      } else if (patch.expiresAt !== undefined) next.expiresAt = checkExpiresAt(patch.expiresAt, at);
      if (patch.trigger !== undefined) {
        if (!isObject(patch.trigger)) throw new Error("trigger must be an object");
        if (patch.trigger.kind !== routine.trigger.kind) throw new Error("Can't change a Routine's trigger kind");
        next.trigger = checkTrigger(patch.trigger);
        if (next.trigger.kind === "webhook") assertHookFree(state, next.trigger.hookId, routine.id);
        if (next.trigger.kind === "pull-request") assertPullRequestFree(state, next.trigger.repo, next.trigger.number, routine.id);
      }
      if (patch.target !== undefined) {
        if (!isObject(patch.target)) throw new Error("target must be an object");
        if (patch.target.kind !== routine.target.kind) throw new Error("Can't change a Routine's target kind");
        next.target = checkTarget(patch.target);
      }
      if (patch.signingHeader === null) delete next.signingHeader;
      else if (patch.signingHeader !== undefined) next.signingHeader = checkSigningHeader(patch.signingHeader, next.trigger);
      // A cron or timezone given next to a whole trigger changes that trigger.
      if (patch.cron !== undefined || patch.timezone !== undefined) {
        if (next.trigger.kind !== "schedule") throw new Error("Only a schedule trigger has a cron or timezone");
        if (patch.cron !== undefined) next.trigger.cron = checkText(patch.cron, "cron");
        if (patch.timezone !== undefined) next.trigger.timezone = checkText(patch.timezone, "timezone");
      }
      if (next.target.kind === "chat" && next.maxRuns === undefined && next.expiresAt === undefined) {
        throw new Error("Heartbeats need an end: keep maxRuns or expiresAt");
      }
      // Switching a Routine on starts its failure count over, and ends the pause that count (or a schedule that had no next
      // run) may have caused.
      const switchedOn = patch.enabled === true && !routine.enabled;
      if (switchedOn) {
        if (routine.pausedReason === NO_NEXT_RUN) delete next.lastError;
        delete next.pausedReason;
        delete next.failedStreak;
      }
      const retimed = patch.trigger !== undefined || patch.cron !== undefined || patch.timezone !== undefined;
      if (next.trigger.kind === "schedule" && (retimed || switchedOn)) next.nextRunAt = nextRun(next.trigger.cron, next.trigger.timezone, at);
      next.updatedAt = at;
      state.routines[state.routines.indexOf(routine)] = next;
      tx.changed = true;
      return copy(next);
    });
  }

  function remove(routineId) {
    return transact((state, tx) => {
      const routine = find(state, routineId);
      if (!routine) return false;
      state.routines.splice(state.routines.indexOf(routine), 1);
      delete state.runs[routineId];
      delete state.queues[routineId];
      delete state.seen[routineId];
      delete state.rejections[routineId];
      delete state.pullRequests[routineId];
      (state.removed ??= {})[routineId] = now();
      tx.changed = true;
      return true;
    });
  }

  function claimDue(at) {
    assertWritable();
    if (!maintenanceDue() && !data.routines.some((routine) => isDue(routine, at))) return [];
    return transact((state, tx) => {
      const claims = [];
      for (const routine of state.routines) {
        if (!isDue(routine, at)) continue;
        tx.changed = true;
        // The next slot is worked out before the Run is recorded: a schedule with none pauses and records nothing.
        const next = nextOrPause(routine, at);
        if (next === null) continue;
        const scheduledFor = routine.nextRunAt;
        const late = scheduledFor < at - MISSED_AFTER_MS;
        const run = { id: id(), routineId: routine.id, scheduledFor, startedAt: at, status: late ? "missed" : "running" };
        if (late) run.endedAt = at;
        appendRun(state, routine.id, run);
        routine.nextRunAt = next;
        routine.updatedAt = at;
        if (!late) claims.push({ routine: copy(routine), run: copy(run) });
      }
      return claims;
    });
  }

  // A Run outside the schedule (run now): same shape as a claimed one, but nextRunAt stays where it is.
  function startRun(routineId, at) {
    return transact((state, tx) => {
      const routine = find(state, routineId);
      if (!routine || routine.completedAt) return null;
      const run = { id: id(), routineId, scheduledFor: at, startedAt: at, status: "running" };
      appendRun(state, routineId, run);
      tx.changed = true;
      return { routine: copy(routine), run: copy(run) };
    });
  }

  // A missed Run that answers an event which won't run: it never counts.
  function missedRun(state, routineId, at, error, event) {
    appendRun(state, routineId, { id: id(), routineId, scheduledFor: at, startedAt: at, endedAt: at, status: "missed", error, event: copy(event) });
  }

  /**
   * Queues events of Linear or webhook Routines (`[{ routineId, event }]`) for a free slot, with one write for the whole
   * batch (none when nothing changed), and answers each in order as `enqueue` does. A key is remembered from now on, so
   * seeing the same change again (the next poll, a redelivery) never starts a second Run, however the first one ends.
   */
  function enqueueMany(items) {
    assertWritable();
    if (!Array.isArray(items)) throw new Error("enqueueMany takes an array of { routineId, event }");
    for (const item of items) assertEvent(item?.event);
    if (items.length === 0) return [];
    return transact((state, tx) => {
      const at = now();
      // routineId -> the keys it has seen or holds queued, read once per batch after its old keys are pruned.
      const known = new Map();
      return items.map(({ routineId, event }) => {
        const routine = find(state, routineId);
        if (!routine || !routine.enabled || routine.completedAt) return { queued: false, reason: "disabled" };
        // A webhook event never starts a Linear or schedule Routine, nor a Linear event a webhook one.
        if (event.kind !== routine.trigger.kind) return { queued: false, reason: "kind" };
        if (!known.has(routineId)) {
          if (pruneSeen(state, routineId, at)) tx.changed = true;
          known.set(
            routineId,
            new Set([
              ...[...(state.seen[routineId] ?? []), ...(state.queues[routineId] ?? []).map((item) => item.event)].map((entry) => entry.key),
              ...rejectedKeys(state, routineId),
            ]),
          );
        }
        const keys = known.get(routineId);
        if (keys.has(event.key)) return { queued: false, reason: "seen" };
        tx.changed = true;
        const seen = state.seen[routineId] ?? (state.seen[routineId] = []);
        if (seen.length >= SEEN_MAX) {
          // Forgetting a key could start its event twice; refusing this one is the lesser harm.
          missedRun(state, routineId, at, "too many events", event);
          return { queued: false, reason: "too-many" };
        }
        seen.push({ key: event.key, at });
        keys.add(event.key);
        const queue = state.queues[routineId] ?? (state.queues[routineId] = []);
        if (queue.length >= QUEUE_MAX) {
          // The event is answered with a Run of its own, so it is also not tried again later.
          missedRun(state, routineId, at, "queue full", event);
          return { queued: false, reason: "full" };
        }
        queue.push({ id: id(), event: copy(event), enqueuedAt: at });
        return { queued: true };
      });
    });
  }

  /**
   * Answers an event of a trigger Routine with a failed Run of its own instead of queuing it (a webhook whose signature
   * doesn't match). It never ran, so it doesn't count toward the Routine's runs or its pause: anyone holding the URL could
   * otherwise switch the Routine off. Nor does it take a place in the seen ledger, which admits real events: the newest
   * REJECTED_KEPT refusals stay listed (their keys answer a redelivery) and the rest are only counted (`rejections`), so a
   * flood can't grow the file. Null when the Routine is gone or of another kind, or the event was seen or refused before.
   */
  function rejectEvent(routineId, event, error) {
    assertWritable();
    assertEvent(event);
    checkText(error, "error");
    return transact((state, tx) => {
      const routine = find(state, routineId);
      if (!routine || routine.completedAt || routine.trigger.kind !== event.kind) return null;
      const at = now();
      // The same delivery again (a redelivery) was answered already.
      if ((state.seen[routineId] ?? []).some((entry) => entry.key === event.key) || rejectedKeys(state, routineId).includes(event.key)) return null;
      const run = { id: id(), routineId, scheduledFor: at, startedAt: at, endedAt: at, status: "failed", error, event: copy(event), rejected: true };
      appendRun(state, routineId, run);
      state.rejections[routineId] = (state.rejections[routineId] ?? 0) + 1;
      tx.changed = true;
      return copy(run);
    });
  }

  // One event: `enqueueMany` with one item.
  function enqueue(routineId, event) {
    return enqueueMany([{ routineId, event }])[0];
  }

  // Whether a claim at `at` would change anything for this Routine, read from the live data so a tick where nothing can
  // move (every slot taken, every event waiting for its time) copies nothing: an event can start in a free slot, a comment
  // has waited too long, or a used-up Routine can end.
  function claimable(routine, at = now(), limit = CONCURRENT_RUNS) {
    const queue = data.queues[routine.id];
    if (!queue?.length || !routine.enabled || routine.completedAt) return false;
    const running = (data.runs[routine.id] ?? []).filter((run) => run.status === "running").length;
    if (routine.maxRuns !== undefined && routine.runCount >= routine.maxRuns && running === 0) return true;
    const room = Math.min(slots(routine, limit) - running, routine.maxRuns === undefined ? Infinity : routine.maxRuns - routine.runCount - running);
    // A pull-request event goes in order and never expires: only the head can start, once it is due.
    if (routine.trigger.kind === "pull-request") return room > 0 && (queue[0].notBefore ?? 0) <= at;
    return queue.some(
      (item) =>
        (item.event.kind === "linear" && item.event.change === "comment" && at - item.enqueuedAt > COMMENT_MAX_WAIT_MS) ||
        (room > 0 && (item.notBefore ?? 0) <= at),
    );
  }

  // Moves queued events into running Runs, oldest first. A Routine never has more than `limit` Runs going (or more than its
  // maxRuns leaves), and an event not due yet (`notBefore`) waits without holding back the ones behind it, except the
  // comments on its issue: those go out in the order they came, so a comment waiting for its busy Chat holds back the later
  // ones on that issue. A Routine whose maxRuns is already used up, with no Run left to end it through finish(), ends here
  // and its queue goes with it.
  function claimQueued(at, limit = CONCURRENT_RUNS) {
    assertWritable();
    if (!maintenanceDue() && !data.routines.some((routine) => claimable(routine, at, limit))) return [];
    return transact((state, tx) => {
      const claims = [];
      for (const routine of state.routines) {
        const queue = state.queues[routine.id];
        if (!queue?.length || !routine.enabled || routine.completedAt) continue;
        const running = (state.runs[routine.id] ?? []).filter((run) => run.status === "running").length;
        if (routine.maxRuns !== undefined && routine.runCount >= routine.maxRuns && running === 0) {
          markCompleted(state, routine, at);
          tx.changed = true;
          continue;
        }
        let room = Math.min(slots(routine, limit) - running, routine.maxRuns === undefined ? Infinity : routine.maxRuns - routine.runCount - running);
        const waiting = [];
        // A pull-request event may not start ahead of one that came before it and still waits.
        const inOrder = routine.trigger.kind === "pull-request";
        // The issues of the comments left waiting so far in this pass.
        const held = new Set();
        for (const item of queue) {
          const { event } = item;
          const comment = event.kind === "linear" && event.change === "comment";
          const issue = comment ? issueNames(event) : [];
          if (comment && at - item.enqueuedAt > COMMENT_MAX_WAIT_MS) {
            // Answering a comment hours late helps no one, and it takes no slot.
            appendRun(state, routine.id, {
              id: id(),
              routineId: routine.id,
              scheduledFor: item.enqueuedAt,
              startedAt: at,
              endedAt: at,
              status: "missed",
              error: "comment waited 2 h",
              event,
            });
          } else if (room > 0 && (item.notBefore ?? 0) <= at && !issue.some((name) => held.has(name)) && !(inOrder && waiting.length > 0)) {
            // scheduledFor is when the event arrived, which deferRun hands back to the queue.
            const run = { id: id(), routineId: routine.id, scheduledFor: item.enqueuedAt, startedAt: at, status: "running", event };
            appendRun(state, routine.id, run);
            claims.push({ routine: copy(routine), run: copy(run) });
            room -= 1;
          } else {
            for (const name of issue) held.add(name);
            waiting.push(item);
            continue;
          }
          tx.changed = true;
        }
        if (waiting.length === queue.length) continue;
        if (waiting.length) state.queues[routine.id] = waiting;
        else delete state.queues[routine.id];
      }
      return claims;
    });
  }

  // Gives a running event Run back to the queue, not before `notBefore`, as if it had not started: its record goes and
  // nothing is counted. It keeps the time its event arrived, so a comment that keeps waiting still ends. Deferred events
  // wait at the head in the order they arrived, ahead of everything never deferred, so Runs deferred in claim order are
  // claimed again in claim order (events that arrived in the same millisecond keep the order they were deferred in).
  function deferRun(runId, notBefore) {
    if (typeof notBefore !== "number" || !Number.isFinite(notBefore)) throw new Error("notBefore must be a time in milliseconds");
    return transact((state, tx) => {
      const found = findRun(state, runId);
      if (!found || found.run.status !== "running" || !found.run.event) return false;
      const { routine, run } = found;
      state.runs[routine.id].splice(state.runs[routine.id].indexOf(run), 1);
      const enqueuedAt = run.scheduledFor ?? now();
      const queue = state.queues[routine.id] ?? (state.queues[routine.id] = []);
      let index = 0;
      while (index < queue.length && queue[index].notBefore !== undefined && queue[index].enqueuedAt <= enqueuedAt) index += 1;
      queue.splice(index, 0, { id: id(), event: run.event, enqueuedAt, notBefore });
      tx.changed = true;
      return true;
    });
  }

  // Records where a Run's Chat was started. The Worktree is left out when the Run works in the Project folder.
  function attachChat(runId, chat) {
    const { chatId, worktreeId } = isObject(chat) ? chat : {};
    checkText(chatId, "chatId");
    if (worktreeId !== undefined) checkText(worktreeId, "worktreeId");
    return transact((state, tx) => {
      const found = findRun(state, runId);
      if (!found) return false;
      found.run.chatId = chatId;
      if (worktreeId !== undefined) found.run.worktreeId = worktreeId;
      tx.changed = true;
      return true;
    });
  }

  /**
   * Turns a Run whose attempt failed for a provider-side reason into its retry on `fallback` ({ provider, model, effort? }).
   * The failed attempt is kept on the Run (`attempts`: its Chat, the settings it ran on, its error and when it ended), and
   * the Run goes on running, so it ends, and counts, once. A Run retries once: null when it already did, or isn't running.
   */
  function retryRun(runId, { error, provider, model, effort, fallback }) {
    checkText(error, "error");
    const next = checkFallback(fallback);
    return transact((state, tx) => {
      const found = findRun(state, runId);
      if (!found || found.run.status !== "running" || found.run.fallback) return null;
      const at = now();
      const attempt = { startedAt: found.run.startedAt, endedAt: at, error };
      if (found.run.chatId !== undefined) attempt.chatId = found.run.chatId;
      if (found.run.worktreeId !== undefined) attempt.worktreeId = found.run.worktreeId;
      if (provider != null) attempt.provider = provider;
      if (model != null) attempt.model = model;
      if (effort != null) attempt.effort = effort;
      found.run.attempts = [...(found.run.attempts ?? []), attempt];
      found.run.fallback = next;
      tx.changed = true;
      return copy(found.run);
    });
  }

  function finishRun(runId, { status, summary, error, chatId, title }) {
    if (!FINISH_STATUSES.has(status)) throw new Error(`Invalid run status: ${JSON.stringify(status)}`);
    return transact((state, tx) => {
      const found = findRun(state, runId);
      // Only a run still in flight can be finished; a second call must not recount it.
      if (!found || found.run.status !== "running") return null;
      finish(state, found.routine, found.run, status, { summary, error, chatId, title }, now());
      tx.changed = true;
      return copy(found.routine);
    });
  }

  // Names a Run, usually once it has ended. False when the Run is gone (trimmed, or its Routine deleted).
  function setRunTitle(runId, title) {
    checkText(title, "title");
    return transact((state, tx) => {
      const found = findRun(state, runId);
      if (!found) return false;
      found.run.title = title;
      tx.changed = true;
      return true;
    });
  }

  // Switches a Routine off and says why. It stays listed, and switching it on again (update) clears the reason.
  function pause(routineId, reason) {
    checkText(reason, "reason");
    return transact((state, tx) => {
      const routine = find(state, routineId);
      if (!routine || routine.completedAt) return null;
      routine.enabled = false;
      routine.pausedReason = reason;
      routine.updatedAt = now();
      tx.changed = true;
      return copy(routine);
    });
  }

  // What is wrong with a Routine right now, apart from its Runs (Linear sign-in needed); null clears it. Writes only on a change.
  function setLastError(routineId, message) {
    if (message !== null && (typeof message !== "string" || message === "")) throw new Error("lastError must be a message or null");
    return transact((state, tx) => {
      const routine = find(state, routineId);
      if (!routine) return null;
      if (routine.lastError === (message ?? undefined)) return copy(routine);
      if (message === null) delete routine.lastError;
      else routine.lastError = message;
      routine.updatedAt = now();
      tx.changed = true;
      return copy(routine);
    });
  }

  // The live Routine babysitting pull request `number` of `repo` (host/owner/repo, any case), in any Chat.
  function findPullRequest(repo, number) {
    return copy(data.routines.find((routine) => watchesPullRequest(routine, repo, number)));
  }

  // What the babysit poller last saw of a Routine's pull request. The store keeps it whole and never reads inside it. A
  // poll that saw nothing new hands back what is kept already: compared as the file holds it, that writes nothing.
  const prSnapshot = (routineId) => copy(data.pullRequests[routineId]);
  const asSaved = (value) => JSON.parse(JSON.stringify(value));
  function setPrSnapshot(routineId, snapshot) {
    if (!isObject(snapshot)) throw new Error("A pull request snapshot must be an object");
    const kept = data.pullRequests[routineId];
    const live = data.routines.some((routine) => routine.id === routineId && !routine.completedAt);
    if (live && kept !== undefined && util.isDeepStrictEqual(asSaved(kept), asSaved(snapshot))) return true;
    return transact((state, tx) => {
      const routine = find(state, routineId);
      // A Routine deleted or ended while the poller was reading has no snapshot to keep.
      if (!routine || routine.completedAt) return false;
      state.pullRequests[routineId] = copy(snapshot);
      tx.changed = true;
      return true;
    });
  }

  // How far a Linear workspace has been read, as a time in milliseconds.
  function linearCursor(workspace) {
    checkText(workspace, "workspace");
    return Object.hasOwn(data.linear, workspace) ? data.linear[workspace] : undefined;
  }
  function setLinearCursor(workspace, at) {
    assertWritable();
    checkText(workspace, "workspace");
    if (typeof at !== "number" || !Number.isFinite(at)) throw new Error("cursor must be a time in milliseconds");
    if (data.linear[workspace] === at) return;
    transact((state, tx) => {
      state.linear[workspace] = at;
      tx.changed = true;
    });
  }

  // The webhooks a relay should hold deliveries for.
  function hookIds() {
    return data.routines
      .filter((routine) => routine.enabled && !routine.completedAt && routine.trigger.kind === "webhook")
      .map((routine) => routine.trigger.hookId);
  }

  // Ends a Routine and keeps why (a babysit stop reason, "max runs", "chat gone"…). Ending one that already ended keeps
  // the first reason and tells nobody again.
  function complete(routineId, reason) {
    const ended = [];
    const result = transact((state, tx) => {
      const routine = find(state, routineId);
      if (!routine) return null;
      const first = !routine.completedAt;
      markCompleted(state, routine, now());
      if (first && typeof reason === "string" && reason) routine.completedReason = reason;
      if (first) ended.push({ routine: copy(routine), reason: routine.completedReason });
      tx.changed = true;
      return copy(routine);
    });
    toldEnded(ended);
    return result;
  }

  function expireDue(at) {
    assertWritable();
    if (!maintenanceDue() && !data.routines.some((routine) => expired(routine, at))) return;
    const ended = [];
    transact((state, tx) => {
      for (const routine of state.routines) {
        if (!expired(routine, at)) continue;
        markCompleted(state, routine, at);
        routine.completedReason = "expired";
        ended.push({ routine: copy(routine), reason: "expired" });
        tx.changed = true;
      }
    });
    toldEnded(ended);
  }

  // Runs left running by a stop fail, and queued events stay queued. A restart is one failure however many Runs it cut
  // short (a busy trigger has up to three), so only the first adds to the failure streak. A schedule whose next run can't
  // be worked out pauses, and the others recover all the same. A read-only store holds no Runs and can't write: a daemon
  // start with one recovers nothing rather than fail.
  function recoverInterrupted() {
    if (readOnly) return;
    transact((state, tx) => {
      const at = now();
      for (const routine of state.routines) {
        let cut = 0;
        for (const run of state.runs[routine.id] ?? []) {
          if (run.status !== "running") continue;
          finish(state, routine, run, "failed", { error: "daemon restarted" }, at, cut === 0);
          cut += 1;
          tx.changed = true;
        }
        if (routine.enabled && !routine.completedAt && routine.nextRunAt != null && routine.nextRunAt <= at) {
          const next = nextOrPause(routine, at);
          if (next !== null) routine.nextRunAt = next;
          tx.changed = true;
        }
      }
    });
  }

  return {
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
    enqueueMany,
    rejectEvent,
    // How many events a Routine refused for a bad signature, the ones no longer listed included.
    rejections: (routineId) => data.rejections[routineId] ?? 0,
    claimQueued,
    deferRun,
    attachChat,
    retryRun,
    finishRun,
    setRunTitle,
    // How many Runs are under way, in every Routine, a completed one's last Run included.
    runningCount: () => Object.values(data.runs).reduce((count, runs) => count + runs.filter((run) => run.status === "running").length, 0),
    // Whether a Run is still in the store.
    hasRun: (runId) => runIndex.has(runId),
    // Whether Routine `routineId` has an event waiting (deferred ones included) or a Run under way: completing it now would
    // drop what it was handed.
    hasPending: (routineId) => (data.queues[routineId]?.length ?? 0) > 0 || (data.runs[routineId] ?? []).some((run) => run.status === "running"),
    // Whether Routine `routineId` was deleted or purged here, ever.
    wasRemoved: (routineId) => Object.hasOwn(data.removed ?? {}, routineId),
    // Why every write is refused (a file this Milagre can't read or understand), or null when the store writes.
    readOnlyReason: () => readOnly,
    complete,
    pause,
    setLastError,
    linearCursor,
    setLinearCursor,
    findPullRequest,
    prSnapshot,
    setPrSnapshot,
    hookIds,
    expireDue,
    recoverInterrupted,
  };
}

module.exports = { createRoutineStore };
