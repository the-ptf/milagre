// Routines in a Chat: the divider a run leaves, the "(pass)" reply that makes it quiet, how quiet runs fold away, and the
// words for a Routine's trigger. Types: routines.d.mts.

import { projectOfKey, sessionIdFromKey } from "./agent-runs.mjs";
import { computerOfKey, isLinkScopeKey, qualifyKey } from "./chat-scopes.mjs";

const SUMMARY_LIMIT = 80;

/**
 * The divider a message stands for, as a routine-run context, or null when it isn't one. A heartbeat's or a comment's
 * divider is a "routine-run" message. A Linear Run's first message is the issue card with `routine` on it, and reads as the
 * same divider.
 */
export function routineRunOf(message) {
  const context = message?.context;
  if (context?.kind === "routine-run") return context;
  if (context?.kind === "linear-issue" && context.routine && typeof context.routine === "object") return { kind: "routine-run", ...context.routine };
  return null;
}

/**
 * Whether the message is a "routine-run" divider message. A Linear Run's first message is not one: it is the issue card with
 * `routine` on it, which only routineRunOf reads.
 */
export function isRoutineRun(message) {
  return message?.context?.kind === "routine-run";
}

/**
 * A summary cut to 80 characters: on a word when the cut leaves most of the line (else mid-word), and ending in "…" so
 * the divider shows it goes on.
 */
function capSummary(line) {
  if (line.length <= SUMMARY_LIMIT) return line;
  const cut = line.slice(0, SUMMARY_LIMIT - 1);
  const word = cut.replace(/\s+\S*$/, "");
  return `${(word.length >= SUMMARY_LIMIT / 2 ? word : cut).trimEnd()}\u2026`;
}

/**
 * Whether a heartbeat reply is a pass: it starts with "(pass)" (leading whitespace, "*" and "_" ignored, any case), and the
 * rest of that line is the summary, at most 80 characters (capSummary).
 */
export function parsePass(text) {
  const match = /^[\s*_]*\(pass\)(.*)/i.exec(String(text ?? ""));
  if (!match) return { quiet: false };
  const line = match[1]
    .split("\n")[0]
    .replace(/^[\s*_]+/, "")
    .trim();
  return { quiet: true, summary: capSummary(line) };
}

/**
 * A moment as "HH:MM" on a 24 hour clock, in `timeZone` (the computer's when left out). With `withDate` it leads with the
 * date in that zone: "2026-10-16 08:30".
 */
export function clock(at, timeZone, withDate = false) {
  const options = {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
    ...(withDate ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
  };
  const parts = new Intl.DateTimeFormat("en-GB", options).formatToParts(at);
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? "00";
  const time = `${part("hour")}:${part("minute")}`;
  return withDate ? `${part("year")}-${part("month")}-${part("day")} ${time}` : time;
}

/**
 * The divider as text: "Heartbeat · 10:15" when the run acted, "10:30 · quiet: CI green" when it passed. An acted divider
 * with a label leads with it instead: "Routine · Triage · 10:15", "Linear comment · Ana · 10:15".
 */
export function routineRunText(context, timeZone) {
  const time = clock(context.at, timeZone);
  if (!context.quiet) return `${context.label ?? "Heartbeat"} · ${time}`;
  return context.summary ? `${time} · quiet: ${context.summary}` : `${time} · quiet`;
}

/** A folded run of quiet dividers as text: "2 quiet checks · last 10:30: CI green". */
export function mergedRoutineRunText(merged, timeZone) {
  const { count, last } = merged;
  const summary = last.summary ? `: ${last.summary}` : "";
  return `${count} quiet checks · last ${clock(last.at, timeZone)}${summary}`;
}

const isQuietRun = (message) => routineRunOf(message)?.quiet === true;

/**
 * One entry per message, in order. A quiet run's reply is hidden. Quiet dividers with only their own replies between them
 * collapse into the last of them, which carries how many there were and its own context.
 */
export function groupQuietRuns(messages) {
  // Silent compaction is absent from both the transcript and its navigation rail; failures remain visible.
  const entries = messages.map((message) => ({
    message,
    ...(message.context?.kind === "compaction" && message.context.quiet && message.context.status !== "failed" ? { hidden: true } : {}),
  }));
  let run = [];
  const close = () => {
    if (run.length > 1) {
      for (const index of run.slice(0, -1)) entries[index].hidden = true;
      const last = run[run.length - 1];
      entries[last].merged = { count: run.length, last: routineRunOf(messages[last]) };
    }
    run = [];
  };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isQuietRun(message)) {
      run.push(index);
      if (messages[index + 1]?.role === "assistant") {
        entries[index + 1].hidden = true;
        index += 1;
      }
    } else {
      close();
    }
  }
  close();
  return entries;
}

const STEP = /^\*\/([1-9]\d*)$/;
const NUMBER = /^\d{1,2}$/;

/** "08:30" for a cron's minute and hour fields when both are plain numbers on a clock, else null. */
function cronTime(minute, hour) {
  if (!NUMBER.test(minute) || !NUMBER.test(hour) || Number(minute) > 59 || Number(hour) > 23) return null;
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/**
 * A schedule in words when it is a shape the Routines form or a heartbeat's `every` makes ("every 15 min", "every 2 h",
 * "weekdays 08:30", "daily 08:30"), otherwise the cron expression itself.
 */
function scheduleText(cron) {
  const expression = String(cron ?? "").trim();
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = expression.split(/\s+/);
  if (rest.length === 0 && dayOfWeek !== undefined && dayOfMonth === "*" && month === "*") {
    const minutes = hour === "*" && dayOfWeek === "*" ? STEP.exec(minute)?.[1] : undefined;
    if (minutes && Number(minutes) <= 59) return `every ${minutes} min`;
    const hours = minute === "0" && dayOfWeek === "*" ? STEP.exec(hour)?.[1] : undefined;
    if (hours && Number(hours) <= 23) return `every ${hours} h`;
    const time = cronTime(minute, hour);
    if (time && dayOfWeek === "1-5") return `weekdays ${time}`;
    if (time && dayOfWeek === "*") return `daily ${time}`;
  }
  return `cron "${expression}"`;
}

function linearText({ event, team, label, state }) {
  const suffix = team ? ` · team ${team}` : "";
  switch (event) {
    case "label-added":
      return `Linear · label ${label ? `${label} ` : ""}added${suffix}`;
    case "assigned":
      return `Linear · assigned to me${suffix}`;
    case "state":
      return `Linear · moved${state ? ` to ${state}` : ""}${suffix}`;
    case "comment":
      return `Linear · new comment${suffix}`;
    default:
      return `Linear${suffix}`;
  }
}

/** What starts a Routine, in a few words: "every 15 min", "weekdays 08:30", "Linear · assigned to me", "Webhook". */
export function triggerText(trigger) {
  switch (trigger?.kind) {
    case "schedule":
      return scheduleText(trigger.cron);
    case "linear":
      return linearText(trigger);
    case "webhook":
      return "Webhook";
    case "pull-request":
      return `PR #${trigger.number}`;
    default:
      return String(trigger?.kind ?? "");
  }
}

/** Whether Run now works for the Routine: a schedule (Heartbeats are schedules too) has nothing to wait for; a Linear or
 * webhook trigger has no event to run with, and a babysit Heartbeat runs only on what changed on its PR, so the Mac
 * refuses it. */
export function canRunNow(routine) {
  if (routine?.trigger?.kind === "pull-request") return false;
  return routine?.target?.kind === "chat" || routine?.trigger?.kind === "schedule";
}

/** Whether the Routine form can edit the Routine: not a babysit Heartbeat, which Milagre sets up from the Babysit PRs
 * settings when a Chat opens a PR. It can still be paused and deleted. */
export function canEditRoutine(routine) {
  return routine?.trigger?.kind !== "pull-request";
}

/** Whether a Run folds into a stretch on the Runs list: it did nothing (quiet, skipped, missed) or was refused before it ran. */
const isFoldedRun = (run) => run.rejected === true || run.status === "quiet" || run.status === "skipped-busy" || run.status === "missed";

/**
 * The Runs list's entries from the Runs, newest first: a row for each Run that did something (acted, failed, running), and
 * one fold for every stretch of consecutive Runs that did not (quiet, skipped, missed, refused). A fold counts its Runs by
 * kind (a refused Run only as refused) and carries `last`, the newest start in it.
 */
export function foldRuns(runs) {
  const entries = [];
  let fold = null;
  for (const run of runs) {
    if (!isFoldedRun(run)) {
      fold = null;
      entries.push({ kind: "run", run });
      continue;
    }
    if (!fold) {
      fold = { kind: "fold", runs: [], counts: { quiet: 0, skipped: 0, missed: 0, refused: 0 }, last: run.startedAt };
      entries.push(fold);
    }
    fold.runs.push(run);
    fold.last = Math.max(fold.last, run.startedAt);
    if (run.rejected === true) fold.counts.refused += 1;
    else if (run.status === "quiet") fold.counts.quiet += 1;
    else if (run.status === "skipped-busy") fold.counts.skipped += 1;
    else fold.counts.missed += 1;
  }
  return entries;
}

const DAY = 24 * 60 * 60 * 1000;

/** The computer's midnight that starts the day `at` falls on. */
const midnight = (at) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/**
 * When a Run started, for the Runs list, on the computer's clock: "Today 10:15", "Yesterday 09:00", "Oct 16 09:00", and
 * "Dec 30, 2025 08:00" for a day in another year than `now`'s.
 */
export function runWhen(at, now) {
  const time = clock(at);
  // Rounded: a day that DST shortens or lengthens is still one day. A clock read a little before midnight (the lists tick
  // every 30 s or so) puts a Run just after it on "tomorrow", which is still today.
  const days = Math.round((midnight(now) - midnight(at)) / DAY);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
  return `${date} ${time}`;
}

const count = (n, word) => `${n} ${word}`;

/**
 * A fold of the Runs list as one line: how many were quiet, then the latest quiet summary ("4 quiet · no TODOs in
 * NOTES.md"), or the other kinds it holds, the skipped ones with why ("4 quiet · 1 skipped, its Chat was busy").
 */
export function foldText(fold) {
  const { quiet, skipped, missed, refused } = fold.counts;
  const others = [
    skipped > 0 ? `${count(skipped, "skipped")}, its Chat was busy` : null,
    missed > 0 ? count(missed, "missed") : null,
    refused > 0 ? count(refused, "refused") : null,
  ].filter(Boolean);
  if (quiet === 0) return others.join(" · ");
  const parts = [count(quiet, "quiet")];
  if (others.length) parts.push(...others);
  else {
    // The Runs are newest first, so the first quiet one with a summary is the latest.
    const summary = fold.runs.find((run) => run.status === "quiet" && !run.rejected && run.summary?.trim())?.summary?.trim();
    if (summary) parts.push(summary);
  }
  return parts.join(" · ");
}

/** A fold's times on the Runs list: "06:00–09:00" from its oldest Run to its newest, or one time for one Run. */
export function foldTimes(fold) {
  const starts = fold.runs.map((run) => run.startedAt);
  const first = clock(Math.min(...starts));
  const last = clock(Math.max(...starts));
  return first === last ? last : `${first}–${last}`;
}

const dayKey = (at) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/** A day's heading on the Runs list, on the computer's calendar: "Today", "Yesterday", "Thu, Oct 16", "Tue, Dec 30, 2025". */
export function dayLabel(at, now) {
  const days = Math.round((midnight(now) - midnight(at)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
}

/**
 * The Runs (newest first) by the computer's day, newest day first. Each day has its heading, its Runs, its Runs list
 * entries (foldRuns over that day alone, so a fold never spans midnight), and `recent` for today and yesterday, which show
 * their Runs; an older day shows as one summary line (daySummary) until opened.
 */
export function runDays(runs, now) {
  const days = [];
  for (const run of runs) {
    const key = dayKey(run.startedAt);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(run.startedAt, now), at: midnight(run.startedAt), runs: [] };
      days.push(day);
    }
    day.runs.push(run);
  }
  return days.map((day) => ({
    ...day,
    entries: foldRuns(day.runs),
    recent: Math.round((midnight(now) - day.at) / DAY) <= 1,
  }));
}

/** A day's Runs as one line, by kind, the empty kinds left out: "2 acted · 12 quiet · 1 missed". */
export function daySummary(runs) {
  const tally = { acted: 0, failed: 0, running: 0, quiet: 0, skipped: 0, missed: 0, refused: 0 };
  for (const run of runs) {
    if (run.rejected === true) tally.refused += 1;
    else if (run.status === "skipped-busy") tally.skipped += 1;
    else if (run.status in tally) tally[run.status] += 1;
  }
  return Object.entries(tally)
    .filter(([, n]) => n > 0)
    .map(([word, n]) => count(n, word))
    .join(" · ");
}

/** What the Runs filter shows: every Run, the ones that acted, the ones that failed, or the ones whose Chat is unread. */
const RUN_FILTERS = {
  all: () => true,
  acted: (run) => run.status === "acted" && run.rejected !== true,
  failed: (run) => run.status === "failed" && run.rejected !== true,
};

/** The Runs a filter keeps; `unread` says whether a Run's Chat has a result nobody opened. */
export function filterRuns(runs, filter, unread) {
  const keep = filter === "unread" ? unread : (RUN_FILTERS[filter] ?? RUN_FILTERS.all);
  return runs.filter((run) => keep(run));
}

/** How many Runs each filter keeps: "All 18 · Acted 3 · Failed 1 · Unread 2". */
export function runFilterCounts(runs, unread) {
  return {
    all: runs.length,
    acted: filterRuns(runs, "acted", unread).length,
    failed: filterRuns(runs, "failed", unread).length,
    unread: filterRuns(runs, "unread", unread).length,
  };
}

/** How long a Run took, in its largest units: "38 s", "4 min", "1 h 5 min". */
export function runDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const OUTCOME = { acted: "acted", quiet: "quiet", failed: "failed", running: "running" };

/** The Run Chat pane's line under its title: "Run at 11:47 · acted in 38 s · main" (outcome, duration and branch when known). */
export function runChatMeta(run, branch) {
  const parts = [`Run at ${clock(run.startedAt)}`];
  const outcome = OUTCOME[run.status];
  if (outcome === "running") parts.push("running");
  else if (outcome) parts.push(typeof run.endedAt === "number" ? `${outcome} in ${runDuration(run.endedAt - run.startedAt)}` : outcome);
  if (branch) parts.push(branch);
  return parts.join(" · ");
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long until `at`, rounded in the largest unit: "2 days", "5 h", "12 min" (a 2-day end read a moment later is still 2 days). */
function until(at, now) {
  const left = Math.max(0, at - now);
  if (left >= DAY) return plural(Math.round(left / DAY), "day");
  if (left >= HOUR) return `${Math.round(left / HOUR)} h`;
  return `${Math.max(1, Math.ceil(left / MINUTE))} min`;
}

/** When a Routine ends: "3 of 20 Runs left" or "ends in 2 days"; null when it runs until switched off. */
export function routineEnd(routine, now) {
  if (routine.maxRuns !== undefined) return `${Math.max(0, routine.maxRuns - (routine.runCount ?? 0))} of ${plural(routine.maxRuns, "Run")} left`;
  if (routine.expiresAt !== undefined) return `ends in ${until(routine.expiresAt, now)}`;
  return null;
}

/**
 * The Routine page's line under its chips: "Next Run 12:00 · last Run 11:47 · 3 of 20 Runs left", leaving out what doesn't
 * apply.
 */
export function routineTimes(routine, now) {
  const parts = [];
  if (routine.enabled && typeof routine.nextRunAt === "number") parts.push(`Next Run ${clock(routine.nextRunAt)}`);
  const last = routine.runs?.length ? Math.max(...routine.runs.map((run) => run.startedAt)) : routine.lastRunAt;
  if (typeof last === "number") {
    const when = runWhen(last, now);
    parts.push(`last Run ${when.startsWith("Today ") ? when.slice(6) : when.charAt(0).toLowerCase() + when.slice(1)}`);
  }
  const end = routineEnd(routine, now);
  if (end) parts.push(end);
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A schedule as its chip says it: "Every 15 min", "Every hour", "Every 2 hours", "Daily at 08:30", "Weekdays at 08:30",
 * "Mon, Wed at 08:30", else "Cron <expression>".
 */
export function scheduleWords(cron) {
  const expression = String(cron ?? "")
    .trim()
    .split(/\s+/)
    .join(" ");
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = expression.split(" ");
  if (rest.length === 0 && dayOfWeek !== undefined && dayOfMonth === "*" && month === "*") {
    const minutes = hour === "*" && dayOfWeek === "*" ? STEP.exec(minute)?.[1] : undefined;
    if (minutes && Number(minutes) <= 59) return `Every ${minutes} min`;
    const hours = minute === "0" && dayOfWeek === "*" ? STEP.exec(hour)?.[1] : undefined;
    if (hours && Number(hours) <= 23) return Number(hours) === 1 ? "Every hour" : `Every ${hours} hours`;
    if (minute === "0" && hour === "*" && dayOfWeek === "*") return "Every hour";
    const time = cronTime(minute, hour);
    if (time && dayOfWeek === "*") return `Daily at ${time}`;
    if (time && dayOfWeek === "1-5") return `Weekdays at ${time}`;
    if (time && /^[0-6](,[0-6])*$/.test(dayOfWeek)) {
      const days = [...new Set(dayOfWeek.split(",").map(Number))].sort((a, b) => a - b);
      if (days.length === 7) return `Daily at ${time}`;
      return `${days.map((day) => DAY_NAMES[day]).join(", ")} at ${time}`;
    }
  }
  return expression ? `Cron ${expression}` : "No schedule";
}

/** A time zone as a place: "America/Sao_Paulo" is "Sao Paulo", "UTC" stays "UTC". */
export const zonePlace = (zone) => String(zone).split("/").at(-1).replaceAll("_", " ");

/**
 * What starts a Routine, as its chip says it: the schedule in words, else the trigger ("Linear · assigned to me", "Webhook").
 * A schedule at a time of day in another zone than `localZone` (this computer's) names it, "Weekdays at 08:30 (Sao Paulo)",
 * since the Next Run line reads in this computer's time.
 */
export function triggerChipText(trigger, localZone) {
  if (trigger?.kind === "schedule") {
    const words = scheduleWords(trigger.cron);
    const zone = trigger.timezone;
    return localZone && zone && zone !== localZone && !words.startsWith("Every ") ? `${words} (${zonePlace(zone)})` : words;
  }
  const text = triggerText(trigger);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const lastSegment = (path) => String(path).split(/[\\/]/).findLast(Boolean) ?? String(path);

/** Where a Routine's Runs land, as its chip says it: "New Worktree in payments-api", "New Chat in payments-api", "In <Chat>". */
export function routineWhereText(target, chatTitle) {
  if (target.kind === "chat") return `In ${chatTitle?.(target.chatId) || "a Chat"}`;
  return `New ${target.workspace === "worktree" ? "Worktree" : "Chat"} in ${lastSegment(target.projectPath)}`;
}

/** A Run's name on the Runs list: what it did when it ended, else its Linear issue ("MIL-12 Fix the flicker"), else the Routine's name. */
export function runTitle(run, routineName) {
  if (run.title?.trim()) return run.title;
  const issue = run.event?.kind === "linear" ? run.event.issue : undefined;
  if (issue?.key) return issue.title ? `${issue.key} ${issue.title}` : issue.key;
  return routineName;
}

const firstErrorLine = (text) =>
  String(text ?? "")
    .split("\n")
    .find((line) => line.trim())
    ?.trim() ?? "";

/** What a model is called in a Run's history: its id, with the effort when one was named ("gpt-6.1-sol", "claude-opus-5-5 · high"). */
const modelText = ({ model, effort }) => (model ? `${model}${effort ? ` · ${effort}` : ""}` : "its model");

/** Whether a Routine's Runs retry on a fallback: Runs in a Chat of their own do; a Heartbeat's beat and a Linear comment don't. */
export function routineRetries(routine) {
  return routine.target?.kind === "new-chat" && !(routine.trigger?.kind === "linear" && routine.trigger.event === "comment");
}

/**
 * What a Routine's Runs retry on, as its page says it: "Retry on Opus 5.5 · high", or "Retry on another provider" when it
 * names no fallback. `nameOf(provider, model)` is the model's name as the picker lists it, or undefined.
 */
export function fallbackText(routine, nameOf = () => undefined) {
  const fallback = routine.fallback;
  if (!fallback) return "Retry on another provider";
  const name = nameOf(fallback.provider, fallback.model) ?? fallback.model;
  return `Retry on ${name}${fallback.effort ? ` · ${fallback.effort}` : ""}`;
}

/**
 * The line of a Run's attempt that failed and was retried, under the Run's row: "First try on gpt-6.1-sol failed: Selected
 * model is at capacity."
 */
export function attemptText(attempt) {
  const error = firstErrorLine(attempt.error);
  return `First try on ${modelText(attempt)} failed${error ? `: ${error}` : ""}`;
}

/** What a Run that ran on its fallback adds to its row ("retried on claude-opus-5-5"), or "" for any other Run. */
export function retryNote(run) {
  return run.fallback ? `retried on ${modelText(run.fallback)}` : "";
}

/**
 * The Chats Routines' Runs created and keep out of the lists, across Projects: not archived, with `routine.hidden`. `chatKey`
 * is `<path>#<id>`, as in the inbox; `unread` is whether the Chat has a result nobody has opened.
 */
export function hiddenRunChats(scopes) {
  const chats = [];
  for (const { path, state } of scopes)
    for (const session of Object.values(state.sessions)) {
      if (session.archived || session.routine?.hidden !== true) continue;
      chats.push({ chatKey: `${path}#${session.id}`, routineId: session.routine.routineId, runId: session.routine.runId, unread: Boolean(session.unread) });
    }
  return chats;
}

/**
 * The hidden Run Chats nobody has opened yet, read from the Project states a desktop window or the phone holds, one entry
 * per Project path (so the open Project, merged in with the others, counts once). A Link's Chats are left out: they belong
 * to Routines on the Macs of its Projects, listed under those Projects already. Another computer's Chats name the Routine
 * by its id on that computer (`qualifyKey`), as the window lists it.
 */
function unreadHiddenRunChats(states) {
  const scopes = Object.entries(states)
    .filter(([key]) => !isLinkScopeKey(key))
    .map(([path, state]) => ({ path, state }));
  return hiddenRunChats(scopes)
    .filter((chat) => chat.unread)
    .map((chat) => ({ ...chat, routineId: qualifyKey(computerOfKey(chat.chatKey), chat.routineId) }));
}

/** The Routines with a hidden Run Chat nobody has opened yet: the Routines button and their rows show a dot. */
export function unreadRunRoutines(states) {
  return new Set(unreadHiddenRunChats(states).map((chat) => chat.routineId));
}

/** The keys ("<path>#<id>") of the hidden Run Chats nobody has opened yet: their Runs show a dot on the Routine page. */
export function unreadRunChats(states) {
  return new Set(unreadHiddenRunChats(states).map((chat) => chat.chatKey));
}

/** The keys of one Routine's hidden Run Chats nobody has opened yet (its id as unreadRunRoutines names it): Mark as read clears them. */
export function unreadRunChatsOf(states, routineId) {
  return unreadHiddenRunChats(states)
    .filter((chat) => chat.routineId === routineId)
    .map((chat) => chat.chatKey);
}

/**
 * Whether a Run's Chat is there to open: its Project's state, as the client holds it, has the session, archived or not. A
 * quiet Run archives its Chat, which stays when it ran in the Project folder or its Worktree wasn't clean; a Worktree removed
 * with its Chat leaves no session. A Project the client holds no state for can't tell, so it counts as not there.
 */
export function chatLeft(states, chatKey) {
  return states[projectOfKey(chatKey)]?.sessions[sessionIdFromKey(chatKey)] !== undefined;
}

/**
 * The branch a Chat's header names: its Worktree's, or for a Run's Chat whose Worktree went once the Run left nothing in
 * it (`formerWorktree`), that Worktree's branch and that it was removed ("milagre/chat-ab12 · removed").
 */
export function chatBranchLabel(session, worktreeName) {
  const former = session?.formerWorktree;
  return former ? `${former.branch ?? former.name} · removed` : worktreeName;
}

/** Whether a Run's row can open its saved Chat, including after its Worktree was removed. */
export function canOpenRunChat(states, chatKey) {
  return !states[projectOfKey(chatKey)] || chatLeft(states, chatKey);
}

/**
 * The Routine a Chat's header names: the one whose Run opened the Chat (`session.routine`, hidden or kept), else an enabled
 * Heartbeat that checks back on it. Undefined when neither is listed. `run` names the Routine as the Chat's own Mac knows
 * it, so another computer's Chat reads it as that computer's.
 */
export function chatRoutine(routines, chatKey, run) {
  const routineId = run ? qualifyKey(computerOfKey(chatKey), run.routineId) : undefined;
  const own = routineId ? routines.find((routine) => routine.id === routineId) : undefined;
  return own ?? routines.find((routine) => routine.enabled && routine.target.kind === "chat" && routine.target.chatId === chatKey);
}
