import type { ModelProvider, Routine, RoutineFallback, RoutineTarget, RoutineTrigger } from "./model.ts";

export const EVERY_MINUTES: number[];
export const EVERY_HOURS: number[];
export function promptHint(trigger: RoutineFormState["trigger"]): string;
/** When a new Every or At a time schedule's first Run starts after `now`, in the schedule's own time zone; null otherwise. */
export function firstRunAt(state: RoutineFormState, now?: number): number | null;

/** A schedule as the form edits it: every N minutes or hours, at a time on chosen weekdays (0 is Sunday), or a raw cron. */
export type RoutineFormSchedule = {
  mode: "every" | "at" | "cron";
  every: number;
  unit: "min" | "h";
  time: string;
  days: number[];
  cron: string;
  timezone: string;
};

export type RoutineLinearEvent = "assigned" | "label-added" | "state" | "comment";

/** Everything the Routines form holds. Empty strings mean "not chosen". */
export type RoutineFormState = {
  name: string;
  trigger: "schedule" | "linear" | "webhook";
  schedule: RoutineFormSchedule;
  linear: { workspace: string; event: RoutineLinearEvent; team: string; label: string; state: string };
  webhook: { signed?: boolean; signingHeader: string; signingSecret: string };
  projectPath: string;
  runIn: "worktree" | "project" | "chat";
  chatId: string;
  provider: ModelProvider | "";
  model: string;
  permissionMode: string;
  /** The model a failed Run retries on; both empty is the automatic pick (another installed provider's recommended model). */
  fallbackProvider: ModelProvider | "";
  fallbackModel: string;
  /** The retry's effort; empty is the model's default. */
  fallbackEffort: string;
  prompt: string;
  /** `runs` is used with kind "runs", `at` (epoch ms) with kind "date". */
  stop: { kind: "never" | "runs" | "date"; runs: number; at: number };
};

export type RoutineFormField =
  | "name"
  | "trigger"
  | "schedule"
  | "timezone"
  | "workspace"
  | "label"
  | "state"
  | "signingSecret"
  | "project"
  | "runIn"
  | "chat"
  | "prompt"
  | "stop";
export type RoutineFormProblem = { field: RoutineFormField; error: string };

export type RoutineFormInput = {
  name: string;
  prompt: string;
  trigger: Exclude<RoutineTrigger, { kind: "webhook" }> | { kind: "webhook"; signed: boolean };
  target: RoutineTarget;
  provider?: ModelProvider;
  model?: string;
  permissionMode?: string;
  fallback?: RoutineFallback;
  maxRuns?: number;
  expiresAt?: number;
  signingSecret?: string;
  signingHeader?: string;
};

/** What `routines:update` takes from the form; `null` clears. A webhook trigger leaves its hook id out (only a rotate changes it). */
export type RoutineFormPatch = {
  name: string;
  prompt: string;
  trigger: Exclude<RoutineTrigger, { kind: "webhook" }> | { kind: "webhook"; signed: boolean };
  target?: RoutineTarget;
  provider: ModelProvider | null;
  model: string | null;
  permissionMode: string | null;
  /** Left out for a Routine whose Runs never retry (a Heartbeat, a comment Routine); null is the automatic pick. */
  fallback?: RoutineFallback | null;
  maxRuns: number | null;
  expiresAt: number | null;
  signingSecret?: string;
  /** Sent for a signed webhook: the header, or null to go back to the default. */
  signingHeader?: string | null;
};

export function emptyRoutineForm(timezone: string, now?: number): RoutineFormState;
/** The form with Runs landing in `runIn`. Moving to a Chat turns a Never end into a date 7 days ahead. */
export function withRunIn(state: RoutineFormState, runIn: RoutineFormState["runIn"], now?: number): RoutineFormState;
export function scheduleCron(schedule: RoutineFormSchedule): { cron: string; error?: undefined } | { error: string; cron?: undefined };
export function scheduleFromCron(cron: string, timezone: string): RoutineFormSchedule;
export function formToInput(
  state: RoutineFormState,
  now?: number,
): { input: RoutineFormInput; field?: undefined } | (RoutineFormProblem & { input?: undefined });
export function fallbackApplies(state: Pick<RoutineFormState, "runIn" | "trigger" | "linear">): boolean;
export function isCommentRoutine(state: Pick<RoutineFormState, "trigger" | "linear">): boolean;
export function formFromRoutine(routine: Routine, timezone: string, now?: number): RoutineFormState;
export function formToUpdate(
  state: RoutineFormState,
  routine: Routine,
  now?: number,
): { patch: RoutineFormPatch; field?: undefined } | (RoutineFormProblem & { patch?: undefined });
export const PROMPT_PLACEHOLDER: string;
export const PROMPT_HINT: string;
export function deleteWarning(routine: Pick<Routine, "target">): string;
