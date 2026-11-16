import { projectOfKey, sessionIdFromKey } from "./agent-runs.mjs";
import { foldOrchestratorAnswers } from "./orchestrator.mjs";
import { computerOfKey, isLinkScopeKey, qualifyKey } from "./chat-scopes.mjs";

const SUMMARY_LIMIT = 80;

/**
 * The divider a message stands for, or null. A Linear Run's first message (the issue card with `routine`) reads as the
 * same divider.
 */
export function routineRunOf(message) {
  const context = message?.context;
  if (context?.kind === "routine-run") return context;
  if (context?.kind === "linear-issue" && context.routine && typeof context.routine === "object") return { kind: "routine-run", ...context.routine };
  return null;
}

export function isRoutineRun(message) {
  return message?.context?.kind === "routine-run";
}

function capSummary(line) {
  if (line.length <= SUMMARY_LIMIT) return line;
  const cut = line.slice(0, SUMMARY_LIMIT - 1);
  const word = cut.replace(/\s+\S*$/, "");
  return `${(word.length >= SUMMARY_LIMIT / 2 ? word : cut).trimEnd()}\u2026`;
}

/**
 * The summary (at most 80 characters) of a "(pass)" reply: it starts with "(pass)" (leading whitespace, "*" and "_"
 * ignored, any case); the rest of that line is the summary.
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
 * "HH:MM" on a 24 hour clock in `timeZone` (the computer's when omitted); `withDate` leads with the date in that zone:
 * "2026-10-16 08:30".
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

export function routineRunText(context, timeZone) {
  const time = clock(context.at, timeZone);
  if (!context.quiet) return `${context.label ?? "Heartbeat"} · ${time}`;
  return context.summary ? `${time} · quiet: ${context.summary}` : `${time} · quiet`;
}

export function mergedRoutineRunText(merged, timeZone) {
  const { count, last } = merged;
  const summary = last.summary ? `: ${last.summary}` : "";
  return `${count} quiet checks · last ${clock(last.at, timeZone)}${summary}`;
}

const isQuietRun = (message) => routineRunOf(message)?.quiet === true;

/**
 * One entry per message; quiet dividers with only their own replies between them collapse into the last, which carries
 * their count.
 */
export function groupQuietRuns(messages) {
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
  return foldOrchestratorAnswers(entries);
}

const STEP = /^\*\/([1-9]\d*)$/;
const NUMBER = /^\d{1,2}$/;

function cronTime(minute, hour) {
  if (!NUMBER.test(minute) || !NUMBER.test(hour) || Number(minute) > 59 || Number(hour) > 23) return null;
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

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
  const words = rest.length === 0 && dayOfWeek !== undefined ? cronWords(minute, hour, dayOfMonth, month, dayOfWeek) : null;
  return words ?? `cron "${expression}"`;
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LIST = /^\d{1,2}(,\d{1,2})+$/;

function evenStep(list, cycle) {
  const values = list.split(",").map(Number);
  const step = values[1] - values[0];
  if (step <= 0 || cycle % step !== 0 || values.length !== cycle / step) return null;
  return values.every((value, index) => value === values[0] + index * step && value < cycle) ? { step, first: values[0] } : null;
}

function cronWords(minute, hour, dayOfMonth, month, dayOfWeek) {
  const everyDay = dayOfMonth === "*" && month === "*" && dayOfWeek === "*";
  if (everyDay && hour === "*" && LIST.test(minute)) {
    const even = evenStep(minute, 60);
    if (even) return even.first === 0 ? `every ${even.step} min` : `every ${even.step} min from :${String(even.first).padStart(2, "0")}`;
  }
  if (everyDay && NUMBER.test(minute) && LIST.test(hour)) {
    const even = evenStep(hour, 24);
    const first = cronTime(minute, String(even?.first ?? 0));
    if (even && first) return `every ${even.step} h from ${first}`;
  }
  const time = cronTime(minute, hour);
  if (!time) return null;
  if (dayOfMonth === "*" && month === "*" && /^[0-7](,[0-7])*$/.test(dayOfWeek)) {
    const days = [...new Set(dayOfWeek.split(",").map((day) => Number(day) % 7))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    if (days.length === 1) return `${DAYS[days[0]]} ${time}`;
    if (days.length === 2 && days[0] === 6 && days[1] === 0) return `weekends ${time}`;
    return `${days.map((day) => DAYS_SHORT[day]).join(", ")} ${time}`;
  }
  if (NUMBER.test(dayOfMonth) && NUMBER.test(month) && dayOfWeek === "*" && Number(month) >= 1 && Number(month) <= 12)
    return `${MONTHS_SHORT[Number(month) - 1]} ${Number(dayOfMonth)} ${time}`;
  return null;
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

/**
 * Schedules (Heartbeats too) can Run now; Linear and webhook triggers have no event to run with, and a babysit
 * Heartbeat runs only on what changed on its PR.
 */
export function canRunNow(routine) {
  if (routine?.trigger?.kind === "pull-request") return false;
  return routine?.target?.kind === "chat" || routine?.trigger?.kind === "schedule";
}

/**
 * False for a babysit Heartbeat, which Milagre sets up from the Babysit PRs settings; it can still be paused and
 * deleted.
 */
export function canEditRoutine(routine) {
  return routine?.trigger?.kind !== "pull-request";
}

const isFoldedRun = (run) => run.rejected === true || run.status === "quiet" || run.status === "skipped-busy" || run.status === "missed";

/**
 * The Runs list entries, newest first: a row per Run that did something, one fold per stretch of consecutive Runs that
 * did not.
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

const midnight = (at) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** "Today 10:15", "Yesterday 09:00", "Oct 16 09:00", "Dec 30, 2025 08:00" for another year than `now`'s. */
export function runWhen(at, now) {
  const time = clock(at);
  const days = Math.round((midnight(now) - midnight(at)) / DAY);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
  return `${date} ${time}`;
}

/** "16:00" today (`today` true), "Fri 16:00" within the next six days, else "Nov 18 10:00". */
export function nextRunWhen(at, now) {
  const time = clock(at);
  const days = Math.round((midnight(at) - midnight(now)) / DAY);
  if (days <= 0) return { today: true, text: time };
  const date = new Date(at);
  if (days < 7) return { today: false, text: `${DAYS_SHORT[date.getDay()]} ${time}` };
  return { today: false, text: `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()} ${time}` };
}

const count = (n, word) => `${n} ${word}`;

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
    const summary = fold.runs.find((run) => run.status === "quiet" && !run.rejected && run.summary?.trim())?.summary?.trim();
    if (summary) parts.push(summary);
  }
  return parts.join(" · ");
}

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

export function dayLabel(at, now) {
  const days = Math.round((midnight(now) - midnight(at)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
}

/**
 * The Runs (newest first) by the computer's day; a fold never spans midnight, and only today and yesterday are
 * `recent`.
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

const RUN_FILTERS = {
  all: () => true,
  acted: (run) => run.status === "acted" && run.rejected !== true,
  failed: (run) => run.status === "failed" && run.rejected !== true,
};

export function filterRuns(runs, filter, unread) {
  const keep = filter === "unread" ? unread : (RUN_FILTERS[filter] ?? RUN_FILTERS.all);
  return runs.filter((run) => keep(run));
}

export function runFilterCounts(runs, unread) {
  return {
    all: runs.length,
    acted: filterRuns(runs, "acted", unread).length,
    failed: filterRuns(runs, "failed", unread).length,
    unread: filterRuns(runs, "unread", unread).length,
  };
}

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

export const zonePlace = (zone) => String(zone).split("/").at(-1).replaceAll("_", " ");

/**
 * The schedule in words, else the trigger; a time of day in another zone than `localZone` names it: "Weekdays at 08:30
 * (Sao Paulo)".
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

export function routineWhereText(target, chatTitle) {
  if (target.kind === "chat") return `In ${chatTitle?.(target.chatId) || "a Chat"}`;
  return `New ${target.workspace === "worktree" ? "Worktree" : "Chat"} in ${lastSegment(target.projectPath)}`;
}

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

const modelText = ({ model, effort }) => (model ? `${model}${effort ? ` · ${effort}` : ""}` : "its model");

export function routineRetries(routine) {
  return routine.target?.kind === "new-chat" && !(routine.trigger?.kind === "linear" && routine.trigger.event === "comment");
}

export function fallbackText(routine, nameOf = () => undefined) {
  const fallback = routine.fallback;
  if (!fallback) return "Retry on another provider";
  const name = nameOf(fallback.provider, fallback.model) ?? fallback.model;
  return `Retry on ${name}${fallback.effort ? ` · ${fallback.effort}` : ""}`;
}

export function attemptText(attempt) {
  const error = firstErrorLine(attempt.error);
  return `First try on ${modelText(attempt)} failed${error ? `: ${error}` : ""}`;
}

export function retryNote(run) {
  return run.fallback ? `retried on ${modelText(run.fallback)}` : "";
}

/** `chatKey` is `<path>#<id>`, as in the inbox; `unread` is whether the Chat has a result nobody has opened. */
export function hiddenRunChats(scopes) {
  const chats = [];
  for (const { path, state } of scopes)
    for (const session of Object.values(state.sessions)) {
      if (session.archived || session.routine?.hidden !== true) continue;
      chats.push({ chatKey: `${path}#${session.id}`, routineId: session.routine.routineId, runId: session.routine.runId, unread: Boolean(session.unread) });
    }
  return chats;
}

function unreadHiddenRunChats(states) {
  const scopes = Object.entries(states)
    .filter(([key]) => !isLinkScopeKey(key))
    .map(([path, state]) => ({ path, state }));
  return hiddenRunChats(scopes)
    .filter((chat) => chat.unread)
    .map((chat) => ({ ...chat, routineId: qualifyKey(computerOfKey(chat.chatKey), chat.routineId) }));
}

export function unreadRunRoutines(states) {
  return new Set(unreadHiddenRunChats(states).map((chat) => chat.routineId));
}

export function unreadRunChats(states) {
  return new Set(unreadHiddenRunChats(states).map((chat) => chat.chatKey));
}

export function unreadRunChatsOf(states, routineId) {
  return unreadHiddenRunChats(states)
    .filter((chat) => chat.routineId === routineId)
    .map((chat) => chat.chatKey);
}

/** A Project the client holds no state for counts as not there. */
export function chatLeft(states, chatKey) {
  return states[projectOfKey(chatKey)]?.sessions[sessionIdFromKey(chatKey)] !== undefined;
}

export function chatBranchLabel(session, worktreeName) {
  const former = session?.formerWorktree;
  return former ? `${former.branch ?? former.name} · removed` : worktreeName;
}

export const RUN_WORKTREE_REMOVED_NOTE = "This Run's Worktree was removed because the Run left nothing in it. Start a new Chat to continue.";

export function canOpenRunChat(states, chatKey) {
  return !states[projectOfKey(chatKey)] || chatLeft(states, chatKey);
}

/** Undefined when neither is listed; `run` names the Routine as the Chat's own computer knows it. */
export function chatRoutine(routines, chatKey, run) {
  const routineId = run ? qualifyKey(computerOfKey(chatKey), run.routineId) : undefined;
  const own = routineId ? routines.find((routine) => routine.id === routineId) : undefined;
  return own ?? routines.find((routine) => routine.enabled && routine.target.kind === "chat" && routine.target.chatId === chatKey);
}
