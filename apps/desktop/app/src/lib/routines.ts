import { useSyncExternalStore } from "react";
import type { Routine, RoutineRun } from "@milagre/shared/model";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import { clock, routineEnd as sharedRoutineEnd, triggerText } from "@milagre/shared/routines";
import { deleteWarning } from "@milagre/shared/routine-form";
import { ipcErrorMessage } from "@milagre/shared/result";

/** A Routine as `listRoutines` gives it: with its latest Runs, newest first. */
export type RoutineWithRuns = Routine & { runs: RoutineRun[] };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A heartbeat checks back on one Chat; every other Routine starts a new Chat per Run. */
export const isHeartbeat = (routine: Routine) => routine.target.kind === "chat";

/**
 * What the delete confirmation says. A Heartbeat only checks back on a Chat that is someone's own, and the delete leaves
 * that Chat alone; every other Routine opens Run Chats, and the delete archives the ones nobody has kept.
 */
export function routineDeleteQuestion(routine: Routine): string {
  return `Delete ${routine.name}? ${routineDeleteWarning(routine)}`;
}

/** What deleting does, as the Edit form's Delete Routine row says it (shared with the phone). */
export const routineDeleteWarning = (routine: Routine): string => deleteWarning(routine);

/** The page's groups. Paused Routines (switched off) stay in their group too, so the chips' counts overlap. */
export function groupRoutines<T extends Routine>(routines: readonly T[]): { heartbeats: T[]; triggers: T[]; paused: T[] } {
  return {
    heartbeats: routines.filter(isHeartbeat),
    triggers: routines.filter((routine) => !isHeartbeat(routine)),
    paused: routines.filter((routine) => !routine.enabled),
  };
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Local calendar days from `at` to `now`: 0 the same day, 1 yesterday. */
function daysBetween(at: number, now: number): number {
  const midnight = (time: number) => {
    const date = new Date(time);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  return Math.round((midnight(now) - midnight(at)) / DAY);
}

/** How long ago `at` was: "just now", "12 min ago", "2 h ago" (today), "yesterday", "3 days ago". */
function ago(at: number, now: number): string {
  const past = Math.max(0, now - at);
  if (past < MINUTE) return "just now";
  if (past < HOUR) return `${Math.floor(past / MINUTE)} min ago`;
  const days = daysBetween(at, now);
  if (days <= 0) return `${Math.floor(past / HOUR)} h ago`;
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** When the Routine ends: "3 of 20 Runs left" or "ends in 2 days"; null when it runs until switched off (shared with the phone). */
export const routineEnd = (routine: Routine, now: number): string | null => sharedRoutineEnd(routine, now);

/** The model and mode a Routine's Runs use, "Opus 5.5 · Full permission", or null when it uses the Mac's defaults. */
function routineModel(routine: Routine, modelName?: (provider: Routine["provider"], model: string) => string): string | null {
  const model = routine.model ? (modelName?.(routine.provider, routine.model) ?? routine.model) : null;
  const mode = routine.permissionMode ? (PERMISSION_MODES.find((entry) => entry.id === routine.permissionMode)?.name ?? routine.permissionMode) : null;
  const parts = [model, mode].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * A row's second line: what starts it, where it runs, then for a heartbeat when it ends, for a trigger its model and mode
 * (or its end when it has neither). "Every 10 min · in Notification chimes · 3 of 20 runs left".
 */
export function routineMeta(
  routine: Routine,
  options: { chatTitle?: (chatId: string) => string | undefined; modelName?: (provider: Routine["provider"], model: string) => string; now: number },
): string {
  const { target } = routine;
  const where =
    target.kind === "chat"
      ? `in ${options.chatTitle?.(target.chatId) ?? "a Chat"}`
      : `new ${target.workspace === "worktree" ? "Worktree" : "Chat"} in ${projectName(target.projectPath)}`;
  const last = target.kind === "chat" ? routineEnd(routine, options.now) : (routineModel(routine, options.modelName) ?? routineEnd(routine, options.now));
  return [capitalized(triggerText(routine.trigger)), where, last].filter(Boolean).join(" · ");
}

/** The row's right-hand text: "Paused", "Next 10:45" for a schedule, else its last Run ("MIL-142 · 2 h ago"). */
export function routineStatus(routine: RoutineWithRuns, now: number): string {
  if (!routine.enabled) return "Paused";
  if (routine.trigger.kind === "schedule" && typeof routine.nextRunAt === "number") return `Next ${clock(routine.nextRunAt)}`;
  const run = routine.runs[0];
  if (!run) return "No Runs yet";
  const key = run.event?.kind === "linear" ? run.event.issue.key : null;
  const when = ago(run.startedAt, now);
  if (key) return `${key} · ${when}`;
  return when === "yesterday" ? `Yesterday ${clock(run.startedAt)}` : capitalized(when);
}

/** The chip's narrowest box over the Chat before it gives up being centered (its name truncates below that). */
const CHIP_ROOM = 200;
const STRIP_EDGE = 12;

/**
 * The Routine chip's strip over the open Chat: left and right padding inside <main> (`width` wide, `rightGap` short of the
 * window's right edge) that keep the chip clear of the window corner's buttons (`reserve` px from that edge). The chip
 * stays centered while it has CHIP_ROOM; on a narrower <main> the left side gives way first, never the right.
 */
export function chipStripInsets(width: number, rightGap: number, reserve: number): { left: number; right: number } {
  const right = Math.max(STRIP_EDGE, reserve - rightGap);
  const left = Math.max(STRIP_EDGE, Math.min(right, width - right - CHIP_ROOM));
  return { left, right };
}

type RoutinesSnapshot = { enabled: boolean | null; routines: RoutineWithRuns[]; error: string | null };

// One read of this Mac's Routines shared by every component that shows them (the page, the sidebar's marks, a Chat's
// Next check and Heartbeat card), refetched once per routines:changed while anything listens.
let snapshot: RoutinesSnapshot = { enabled: null, routines: [], error: null };
const listeners = new Set<() => void>();
let latestRead = 0;
let stopListening: (() => void) | undefined;

function publish(next: Partial<RoutinesSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

/** Reads the switch and the list again. Only the newest read lands; one that answers late is dropped. */
export function refreshRoutines() {
  const read = ++latestRead;
  Promise.resolve()
    .then(async () => {
      const on = (await window.milagre.readRoutinesEnabled())?.enabled === true;
      const list = on ? ((await window.milagre.listRoutines())?.routines ?? []) : [];
      if (read !== latestRead) return;
      // A read that finds what is already shown publishes nothing, so no surface re-renders for it.
      if (on === snapshot.enabled && snapshot.error === null && JSON.stringify(list) === JSON.stringify(snapshot.routines)) return;
      publish({ enabled: on, routines: list, error: null });
    })
    .catch((failure: unknown) => {
      // A failed read is an error, not "Routines are off": the switch keeps what was last read (null at first).
      if (read === latestRead) publish({ error: ipcErrorMessage(failure) });
    });
}

/** The current read, as useRoutines sees it. */
export const routinesSnapshot = () => snapshot;

/** Listens for new reads; the first listener starts reading and listening to the Mac, the last one stops it. */
export function subscribeRoutines(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    refreshRoutines();
    stopListening = window.milagre.onRoutinesChanged?.(() => refreshRoutines());
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    // Nothing shows Routines now: drop any read in flight and stop listening.
    latestRead += 1;
    stopListening?.();
    stopListening = undefined;
  };
}

/**
 * This Mac's Routines and its Routines switch (`enabled` is null until read), refetched whenever the Mac says they changed.
 * Routines are this Mac's only, so this always asks this Mac's own bridge.
 */
export function useRoutines(): RoutinesSnapshot & { refresh(): void } {
  const current = useSyncExternalStore(subscribeRoutines, routinesSnapshot);
  return { ...current, refresh: refreshRoutines };
}
