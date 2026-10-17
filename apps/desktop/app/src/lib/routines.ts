import { useCallback, useEffect, useState } from "react";
import type { Routine, RoutineRun } from "@milagre/shared/model";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import { clock, triggerText } from "@milagre/shared/routines";

/** A Routine as `listRoutines` gives it: with its latest Runs, newest first. */
export type RoutineWithRuns = Routine & { runs: RoutineRun[] };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A heartbeat checks back on one Chat; every other Routine starts a new Chat per Run. */
export const isHeartbeat = (routine: Routine) => routine.target.kind === "chat";

/** The page's groups. Paused Routines (switched off) stay in their group too, so the chips' counts overlap. */
export function groupRoutines<T extends Routine>(routines: readonly T[]): { heartbeats: T[]; triggers: T[]; paused: T[] } {
  return {
    heartbeats: routines.filter(isHeartbeat),
    triggers: routines.filter((routine) => !isHeartbeat(routine)),
    paused: routines.filter((routine) => !routine.enabled),
  };
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** How long until `at`, in the largest whole unit: "2 days", "5 h", "12 min". */
function until(at: number, now: number): string {
  const left = Math.max(0, at - now);
  if (left >= DAY) return plural(Math.floor(left / DAY), "day");
  if (left >= HOUR) return `${Math.floor(left / HOUR)} h`;
  return `${Math.max(1, Math.ceil(left / MINUTE))} min`;
}

/** How long ago `at` was: "just now", "12 min ago", "2 h ago", "yesterday", "3 days ago". */
export function ago(at: number, now: number): string {
  const past = Math.max(0, now - at);
  if (past < MINUTE) return "just now";
  if (past < HOUR) return `${Math.floor(past / MINUTE)} min ago`;
  if (past < DAY) return `${Math.floor(past / HOUR)} h ago`;
  if (past < 2 * DAY) return "yesterday";
  return `${Math.floor(past / DAY)} days ago`;
}

/** When the Routine ends: "3 of 20 runs left" or "ends in 2 days"; null when it runs until switched off. */
export function routineEnd(routine: Routine, now: number): string | null {
  if (routine.maxRuns !== undefined) return `${Math.max(0, routine.maxRuns - routine.runCount)} of ${plural(routine.maxRuns, "run")} left`;
  if (routine.expiresAt !== undefined) return `ends in ${until(routine.expiresAt, now)}`;
  return null;
}

/** The model and mode a Routine's Runs use, "Opus 5.5 · Full permission", or null when it uses the Mac's defaults. */
export function routineModel(routine: Routine, modelName?: (provider: Routine["provider"], model: string) => string): string | null {
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
  if (!run) return "No runs yet";
  const key = run.event?.kind === "linear" ? run.event.issue.key : null;
  return key ? `${key} · ${ago(run.startedAt, now)}` : capitalized(ago(run.startedAt, now));
}

/**
 * This Mac's Routines and its Routines switch (`enabled` is null until read), refetched whenever the Mac says they changed.
 * Routines are this Mac's only, so this always asks this Mac's own bridge.
 */
export function useRoutines(): { enabled: boolean | null; routines: RoutineWithRuns[]; error: string | null; refresh(): void } {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [routines, setRoutines] = useState<RoutineWithRuns[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    Promise.resolve()
      .then(async () => {
        const on = (await window.milagre.readRoutinesEnabled())?.enabled === true;
        const list = on ? ((await window.milagre.listRoutines())?.routines ?? []) : [];
        setEnabled(on);
        setRoutines(list);
        setError(null);
      })
      .catch((failure: unknown) => {
        setEnabled((current) => current ?? false);
        setError(failure instanceof Error ? failure.message : String(failure));
      });
  }, []);
  useEffect(() => {
    refresh();
    return window.milagre.onRoutinesChanged?.(() => refresh());
  }, [refresh]);
  return { enabled, routines, error, refresh };
}
