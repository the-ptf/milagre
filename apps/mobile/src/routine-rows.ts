import { Clock01Icon, Comment01Icon, Exchange01Icon, Pulse01Icon, Tag01Icon, UserCheck01Icon, WebhookIcon } from "@hugeicons/core-free-icons";
import { clock, triggerText } from "@milagre/shared/routines";
import type { Routine, RoutineRun } from "@milagre/shared/model";
import type { IconData } from "./icons";

type RoutineLike = Routine & { runs?: RoutineRun[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A heartbeat checks back on one Chat; every other Routine starts a new Chat for each Run. */
export const isHeartbeat = (routine: Pick<Routine, "target">) => routine.target.kind === "chat";

/** The Routine's row icon: a pulse for a heartbeat, else what starts it. */
export function routineIcon(routine: Pick<Routine, "target" | "trigger">): IconData {
  if (isHeartbeat(routine)) return Pulse01Icon;
  const { trigger } = routine;
  if (trigger.kind === "webhook") return WebhookIcon;
  if (trigger.kind === "schedule") return Clock01Icon;
  if (trigger.event === "label-added") return Tag01Icon;
  if (trigger.event === "assigned") return UserCheck01Icon;
  if (trigger.event === "comment") return Comment01Icon;
  return Exchange01Icon;
}

/** How long ago, in a few words: "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago". */
export function ago(at: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** When a heartbeat ends: "3 runs left", "ends Oct 24" ("ends 18:00" today), or "" when it has no end. */
export function heartbeatEnd(routine: Pick<Routine, "maxRuns" | "runCount" | "expiresAt">, now: number) {
  if (typeof routine.maxRuns === "number") {
    const left = Math.max(0, routine.maxRuns - routine.runCount);
    return left === 1 ? "1 run left" : `${left} runs left`;
  }
  if (typeof routine.expiresAt !== "number") return "";
  const end = new Date(routine.expiresAt);
  return new Date(now).toDateString() === end.toDateString() ? `ends ${clock(end)}` : `ends ${MONTHS[end.getMonth()]} ${end.getDate()}`;
}

/** The newest Run, whichever order the Mac lists them in. */
function lastRun(runs: RoutineRun[] | undefined) {
  let last: RoutineRun | undefined;
  for (const run of runs ?? []) if (!last || run.startedAt > last.startedAt) last = run;
  return last;
}

/**
 * The line under a Routine's name. A heartbeat: "Every 15 min · next 10:45 · 3 runs left". A trigger: what starts it and
 * its last Run ("Linear · label agent added · MIL-142, 2 h ago"). Off, paused or failing says so, with the reason.
 */
export function routineMeta(routine: RoutineLike, now: number) {
  const parts = [capital(triggerText(routine.trigger))];
  if (routine.pausedReason) parts.push(`Paused: ${routine.pausedReason}`);
  else if (!routine.enabled) parts.push("Off");
  else if (isHeartbeat(routine)) {
    if (typeof routine.nextRunAt === "number") parts.push(`next ${clock(routine.nextRunAt)}`);
    const end = heartbeatEnd(routine, now);
    if (end) parts.push(end);
  } else {
    const last = lastRun(routine.runs);
    const event = last?.event;
    if (!last) parts.push("no Runs yet");
    else parts.push(event?.kind === "linear" ? `${event.issue.key}, ${ago(last.startedAt, now)}` : `last Run ${ago(last.startedAt, now)}`);
  }
  if (routine.lastError) parts.push(routine.lastError);
  return parts.join(" · ");
}
