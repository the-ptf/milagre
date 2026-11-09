import type { ModelProvider, Routine, RoutineFallback, RoutineTarget, RoutineTrigger } from "./model.ts";

export const EVERY_MINUTES: number[];
export const EVERY_HOURS: number[];
/** The hint under the prompt for a trigger; Linear and webhook say their event is passed as data, not instructions. */
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
  /** `signed` is the stored setting when editing; a new signing secret always signs. The secret is write-only. */
  webhook: { signed?: boolean; signingHeader: string; signingSecret: string };
  projectPath: string;
  /** "worktree" and "project" start a new Chat per Run; "chat" is a heartbeat on `chatId` (schedules only). A comment Routine ignores it. */
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

/** Which field a problem belongs to, so the form can show it there. */
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

/** What `routines:create` takes from the form. A webhook trigger has no hook id yet: the Mac mints it with the URL. */
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
  /** Left out for a comment Routine, which keeps the target it has. */
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

/** A new Routine's form: a schedule every 15 minutes in a new worktree, running until switched off. */
export function emptyRoutineForm(timezone: string, now?: number): RoutineFormState;
/** The form with Runs landing in `runIn`. Moving to a Chat turns a Never end into a date 7 days ahead. */
export function withRunIn(state: RoutineFormState, runIn: RoutineFormState["runIn"], now?: number): RoutineFormState;
/** The cron a schedule makes, in the shapes `triggerText` reads back as words, or why it can't make one. */
export function scheduleCron(schedule: RoutineFormSchedule): { cron: string; error?: undefined } | { error: string; cron?: undefined };
/** The form's schedule for a stored cron: Every or At when the form could have made it, Advanced (raw cron) otherwise. */
export function scheduleFromCron(cron: string, timezone: string): RoutineFormSchedule;
/** The `routines:create` input the form makes, or the field that is wrong and why. */
export function formToInput(
  state: RoutineFormState,
  now?: number,
): { input: RoutineFormInput; field?: undefined } | (RoutineFormProblem & { input?: undefined });
/** Whether the form's Routine retries a failed Run on a fallback model: only Runs in a Chat of their own do. */
export function fallbackApplies(state: Pick<RoutineFormState, "runIn" | "trigger" | "linear">): boolean;
/** A Linear Routine on new comments: it has no Each run, because comments go into the Chat linked to the issue. */
export function isCommentRoutine(state: Pick<RoutineFormState, "trigger" | "linear">): boolean;
/** The form for editing `routine`. A webhook's signing header is the Routine's own (blank for the default). */
export function formFromRoutine(routine: Routine, timezone: string, now?: number): RoutineFormState;
/**
 * The `routines:update` patch for an edited Routine. The trigger kind and Chat-or-new-Chat stay as they were; a comment
 * Routine keeps its stored target, left out of the patch.
 */
export function formToUpdate(
  state: RoutineFormState,
  routine: Routine,
  now?: number,
): { patch: RoutineFormPatch; field?: undefined } | (RoutineFormProblem & { patch?: undefined });
/** The New Routine and Edit forms' prompt placeholder and the hint under it. */
export const PROMPT_PLACEHOLDER: string;
export const PROMPT_HINT: string;
/** What deleting a Routine does: "Its Chats stay." for a Heartbeat, else that its Runs stop and unkept Run Chats are archived. */
export function deleteWarning(routine: Pick<Routine, "target">): string;
