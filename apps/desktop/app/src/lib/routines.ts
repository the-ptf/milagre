import { useSyncExternalStore } from "react";
import type { Routine, RoutineRun } from "@milagre/shared/model";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import { clock, routineEnd as sharedRoutineEnd, triggerText } from "@milagre/shared/routines";
import { deleteWarning } from "@milagre/shared/routine-form";
import { ipcErrorMessage } from "@milagre/shared/result";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { ComputersSnapshot, ComputerState } from "../electron.d.ts";
import { bridgeFor } from "./computer-bridge.ts";
import { aiConsent } from "./ai-consent.ts";
import { computersSnapshot, subscribeComputers } from "./computers-store.ts";

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

/** One computer's Routines as last read: `enabled` is null until its switch is read, `error` the last read's failure. */
type ComputerRoutines = { enabled: boolean | null; routines: RoutineWithRuns[]; error: string | null };
/**
 * Every computer's Routines in one list, this Mac's first: `enabled` is true while any computer has them on (null until
 * this Mac's switch is read), `error` this Mac's read failure. `byComputer` keeps each computer's own read, keyed by
 * computer id ("local" for this Mac); another computer's ids, Chat keys and Project paths name it (computer-routing.cjs).
 */
type RoutinesSnapshot = ComputerRoutines & { byComputer: Readonly<Record<string, ComputerRoutines>> };

const NOT_READ: ComputerRoutines = { enabled: null, routines: [], error: null };

// One read per computer shared by every component that shows Routines (the page, the sidebar's marks, a Chat's Next
// check and Heartbeat card), refetched once per routines:changed from that computer while anything listens.
let byComputer: Record<string, ComputerRoutines> = {};
let snapshot: RoutinesSnapshot = { ...NOT_READ, byComputer };
const listeners = new Set<() => void>();
const latestRead = new Map<string, number>();
// The computers read: this Mac, and each paired computer that isn't switched off, with how it stood when last seen.
const tracked = new Map<string, ComputerState | "local">();
const stopListening = new Map<string, () => void>();
let stopComputers: (() => void) | undefined;

function merge(): RoutinesSnapshot {
  const ids = [LOCAL_COMPUTER, ...[...tracked.keys()].filter((id) => id !== LOCAL_COMPUTER)];
  const reads = ids.map((id) => byComputer[id]).filter((read): read is ComputerRoutines => Boolean(read));
  const local = byComputer[LOCAL_COMPUTER] ?? NOT_READ;
  const anyOn = reads.some((read) => read.enabled === true);
  return {
    enabled: anyOn ? true : local.enabled,
    routines: reads.flatMap((read) => read.routines),
    error: local.error,
    byComputer: Object.fromEntries(ids.filter((id) => byComputer[id]).map((id) => [id, byComputer[id]])),
  };
}

function publish(computerId: string, next: ComputerRoutines | null) {
  if (next) byComputer = { ...byComputer, [computerId]: next };
  else {
    const { [computerId]: _gone, ...rest } = byComputer;
    byComputer = rest;
  }
  snapshot = merge();
  for (const listener of listeners) listener();
}

/** Reads one computer's switch and list again. Only its newest read lands; one that answers late is dropped. */
function read(computerId: string) {
  const id = (latestRead.get(computerId) ?? 0) + 1;
  latestRead.set(computerId, id);
  const bridge = bridgeFor(computerId);
  Promise.resolve()
    .then(async () => {
      let on = (await bridge.readRoutinesEnabled())?.enabled === true;
      // This Mac runs Routines once this device has allowed AI sharing (a profile from before, or a decision whose
      // follow-up failed, catches up here). Another computer is authorized only by a Routine write from here.
      if (!on && computerId === LOCAL_COMPUTER && (await aiConsent.allowed())) on = (await bridge.saveRoutinesEnabled(true))?.enabled === true;
      const list = (await bridge.listRoutines())?.routines ?? [];
      if (latestRead.get(computerId) !== id || !tracked.has(computerId)) return;
      // A read that finds what is already shown publishes nothing, so no surface re-renders for it.
      const current = byComputer[computerId];
      if (current && on === current.enabled && current.error === null && JSON.stringify(list) === JSON.stringify(current.routines)) return;
      publish(computerId, { enabled: on, routines: list, error: null });
    })
    .catch((failure: unknown) => {
      // A failed read is an error, not "Routines are off": the switch keeps what was last read (null at first).
      if (latestRead.get(computerId) === id && tracked.has(computerId))
        publish(computerId, { ...(byComputer[computerId] ?? NOT_READ), error: ipcErrorMessage(failure) });
    });
}

/** Reads `computerId`'s Routines again, or every computer's without one. */
export function refreshRoutines(computerId?: string) {
  if (computerId !== undefined) {
    if (tracked.has(computerId)) read(computerId);
    return;
  }
  for (const id of tracked.keys()) read(id);
}

function track(computerId: string, state: ComputerState | "local") {
  const before = tracked.get(computerId);
  tracked.set(computerId, state);
  if (before === undefined) {
    const bridge = bridgeFor(computerId);
    const stop = bridge.onRoutinesChanged?.(() => refreshRoutines(computerId));
    if (stop) stopListening.set(computerId, stop);
    read(computerId);
  } else if (state === "online" && before !== "online") read(computerId); // back: what changed while it was away
}

function untrack(computerId: string) {
  tracked.delete(computerId);
  latestRead.set(computerId, (latestRead.get(computerId) ?? 0) + 1);
  stopListening.get(computerId)?.();
  stopListening.delete(computerId);
  if (byComputer[computerId]) publish(computerId, null);
}

/** Follows the paired computers: one switched on is read, one switched off or removed drops out. */
function followComputers(next: ComputersSnapshot | null | undefined) {
  if (!next || !Array.isArray(next.computers)) return;
  const on = new Map(next.computers.filter((computer) => computer.state !== "off").map((computer) => [computer.id, computer.state] as const));
  for (const id of [...tracked.keys()]) if (id !== LOCAL_COMPUTER && !on.has(id)) untrack(id);
  for (const [id, state] of on) track(id, state);
}

/** The current read, as useRoutines sees it. */
export const routinesSnapshot = () => snapshot;

/** Listens for new reads; the first listener starts reading and listening to every computer, the last one stops it. */
export function subscribeRoutines(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    track(LOCAL_COMPUTER, "local");
    stopComputers = subscribeComputers(() => followComputers(computersSnapshot()));
    followComputers(computersSnapshot());
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    // Nothing shows Routines now: drop any read in flight and stop listening.
    stopComputers?.();
    stopComputers = undefined;
    for (const id of [...tracked.keys()]) {
      tracked.delete(id);
      latestRead.set(id, (latestRead.get(id) ?? 0) + 1);
      stopListening.get(id)?.();
    }
    stopListening.clear();
  };
}

/**
 * Every computer's Routines and whether any has them on (`enabled` is null until read), refetched whenever a computer
 * says they changed. Act on a Routine through `bridgeForKey(routine.id)`: its id names the computer that runs it.
 */
export function useRoutines(): RoutinesSnapshot & { refresh(computerId?: string): void } {
  const current = useSyncExternalStore(subscribeRoutines, routinesSnapshot);
  return { ...current, refresh: refreshRoutines };
}

/** The computer a Routine runs on: "local" for this Mac. */
export const computerOfRoutine = (routine: Pick<Routine, "id">) => computerOfKey(routine.id);
