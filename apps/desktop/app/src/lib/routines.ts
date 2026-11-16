import { useSyncExternalStore } from "react";
import type { Routine, RoutineRun } from "@milagre/shared/model";
import { PERMISSION_MODE_LABEL } from "@milagre/shared/model-copy";
import { clock, nextRunWhen, routineEnd as sharedRoutineEnd, triggerText } from "@milagre/shared/routines";
import { deleteWarning } from "@milagre/shared/routine-form";
import { ipcErrorMessage } from "@milagre/shared/result";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { ComputersSnapshot, ComputerState } from "../electron.d.ts";
import { bridgeFor } from "./computer-bridge.ts";
import { computersSnapshot, subscribeComputers } from "./computers-store.ts";

export type RoutineWithRuns = Routine & { runs: RoutineRun[] };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const isHeartbeat = (routine: Routine) => routine.target.kind === "chat";

export function routineDeleteQuestion(routine: Routine): string {
  return `Delete ${routine.name}? ${routineDeleteWarning(routine)}`;
}

export const routineDeleteWarning = (routine: Routine): string => deleteWarning(routine);

export function groupRoutines<T extends Routine>(routines: readonly T[]): { heartbeats: T[]; triggers: T[]; paused: T[] } {
  return {
    heartbeats: routines.filter(isHeartbeat),
    triggers: routines.filter((routine) => !isHeartbeat(routine)),
    paused: routines.filter((routine) => !routine.enabled),
  };
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const projectName = (path: string) => path.split(/[\\/]/).findLast(Boolean) ?? path;

function daysBetween(at: number, now: number): number {
  const midnight = (time: number) => {
    const date = new Date(time);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  return Math.round((midnight(now) - midnight(at)) / DAY);
}

function ago(at: number, now: number): string {
  const past = Math.max(0, now - at);
  if (past < MINUTE) return "just now";
  if (past < HOUR) return `${Math.floor(past / MINUTE)} min ago`;
  const days = daysBetween(at, now);
  if (days <= 0) return `${Math.floor(past / HOUR)} h ago`;
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export const routineEnd = (routine: Routine, now: number): string | null => sharedRoutineEnd(routine, now);

function routineModel(routine: Routine, modelName?: (provider: Routine["provider"], model: string) => string): string | null {
  const model = routine.model ? (modelName?.(routine.provider, routine.model) ?? routine.model) : null;
  const mode = routine.permissionMode ? (PERMISSION_MODE_LABEL[routine.permissionMode as keyof typeof PERMISSION_MODE_LABEL] ?? routine.permissionMode) : null;
  const parts = [model, mode].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

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

export function routineStatus(routine: RoutineWithRuns, now: number): string {
  if (!routine.enabled) return "Paused";
  if (routine.trigger.kind === "schedule" && typeof routine.nextRunAt === "number") {
    const next = nextRunWhen(routine.nextRunAt, now);
    return next.today ? `Next ${next.text}` : next.text;
  }
  const run = routine.runs[0];
  if (!run) return "No Runs yet";
  const key = run.event?.kind === "linear" ? run.event.issue.key : null;
  const when = ago(run.startedAt, now);
  if (key) return `${key} · ${when}`;
  return when === "yesterday" ? `Yesterday ${clock(run.startedAt)}` : capitalized(when);
}

const CHIP_ROOM = 200;
const STRIP_EDGE = 12;

export function chipStripInsets(width: number, rightGap: number, reserve: number, leftReserve = 0): { left: number; right: number } {
  const right = Math.max(STRIP_EDGE, reserve - rightGap);
  const left = Math.max(STRIP_EDGE, leftReserve, Math.min(right, width - right - CHIP_ROOM));
  return { left, right };
}

type ComputerRoutines = { enabled: boolean | null; routines: RoutineWithRuns[]; error: string | null };
type RoutinesSnapshot = ComputerRoutines & { byComputer: Readonly<Record<string, ComputerRoutines>> };

const NOT_READ: ComputerRoutines = { enabled: null, routines: [], error: null };

let byComputer: Record<string, ComputerRoutines> = {};
let snapshot: RoutinesSnapshot = { ...NOT_READ, byComputer };
const listeners = new Set<() => void>();
const latestRead = new Map<string, number>();
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
    byComputer: Object.fromEntries(
      ids.flatMap((id) => {
        const read = byComputer[id];
        return read ? [[id, read]] : [];
      }),
    ),
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

function read(computerId: string) {
  const id = (latestRead.get(computerId) ?? 0) + 1;
  latestRead.set(computerId, id);
  const bridge = bridgeFor(computerId);
  Promise.resolve()
    .then(async () => {
      const on = (await bridge.readRoutinesEnabled())?.enabled === true;
      const list = (await bridge.listRoutines())?.routines ?? [];
      if (latestRead.get(computerId) !== id || !tracked.has(computerId)) return;
      const current = byComputer[computerId];
      if (current && on === current.enabled && current.error === null && JSON.stringify(list) === JSON.stringify(current.routines)) return;
      publish(computerId, { enabled: on, routines: list, error: null });
    })
    .catch((failure: unknown) => {
      if (latestRead.get(computerId) === id && tracked.has(computerId))
        publish(computerId, { ...(byComputer[computerId] ?? NOT_READ), error: ipcErrorMessage(failure) });
    });
}

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
  } else if (state === "online" && before !== "online") read(computerId);
}

function untrack(computerId: string) {
  tracked.delete(computerId);
  latestRead.set(computerId, (latestRead.get(computerId) ?? 0) + 1);
  stopListening.get(computerId)?.();
  stopListening.delete(computerId);
  if (byComputer[computerId]) publish(computerId, null);
}

function followComputers(next: ComputersSnapshot | null | undefined) {
  if (!next || !Array.isArray(next.computers)) return;
  const on = new Map(next.computers.filter((computer) => computer.state !== "off").map((computer) => [computer.id, computer.state] as const));
  for (const id of Array.from(tracked.keys())) if (id !== LOCAL_COMPUTER && !on.has(id)) untrack(id);
  for (const [id, state] of on) track(id, state);
}

export const routinesSnapshot = () => snapshot;

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
    stopComputers?.();
    stopComputers = undefined;
    for (const id of Array.from(tracked.keys())) {
      tracked.delete(id);
      latestRead.set(id, (latestRead.get(id) ?? 0) + 1);
      stopListening.get(id)?.();
    }
    stopListening.clear();
  };
}

export function useRoutines(): RoutinesSnapshot & { refresh(computerId?: string): void } {
  const current = useSyncExternalStore(subscribeRoutines, routinesSnapshot);
  return { ...current, refresh: refreshRoutines };
}

export const computerOfRoutine = (routine: Pick<Routine, "id">) => computerOfKey(routine.id);
