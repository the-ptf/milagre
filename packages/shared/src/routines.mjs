// Routines in a Chat: the divider a run leaves, the "(pass)" reply that makes it quiet, how quiet runs fold away, and the
// words for a Routine's trigger. Types: routines.d.mts.

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
 * Whether a heartbeat reply is a pass: it starts with "(pass)" (leading whitespace, "*" and "_" ignored, any case), and the
 * rest of that line is the summary, at most 80 characters.
 */
export function parsePass(text) {
  const match = /^[\s*_]*\(pass\)(.*)/i.exec(String(text ?? ""));
  if (!match) return { quiet: false };
  const line = match[1]
    .split("\n")[0]
    .replace(/^[\s*_]+/, "")
    .trim();
  return { quiet: true, summary: line.slice(0, SUMMARY_LIMIT) };
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
  const entries = messages.map((message) => ({ message }));
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
    default:
      return String(trigger?.kind ?? "");
  }
}

/** Whether Run now works for the Routine: a schedule (Heartbeats are schedules too) has nothing to wait for; a Linear or
 * webhook trigger has no event to run with, so the Mac refuses it. */
export function canRunNow(routine) {
  return routine?.target?.kind === "chat" || routine?.trigger?.kind === "schedule";
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

/** A Run's name on the Runs list: what it did when it ended, else its Linear issue ("MIL-12 Fix the flicker"), else the Routine's name. */
export function runTitle(run, routineName) {
  if (run.title?.trim()) return run.title;
  const issue = run.event?.kind === "linear" ? run.event.issue : undefined;
  if (issue?.key) return issue.title ? `${issue.key} ${issue.title}` : issue.key;
  return routineName;
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
