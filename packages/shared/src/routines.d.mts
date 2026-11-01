import type { AgentSession, ChatMessage, ModelProvider, Routine, RoutineRun, RoutineRunAttempt, RoutineRunContext, RoutineTrigger } from "./model.ts";

/**
 * The divider a message stands for, or null. A `routine-run` message gives its own context. A `linear-issue` message that
 * carries `routine` (a Linear Run's first message) gives `{ kind: "routine-run", ...routine }`.
 */
export function routineRunOf(message: ChatMessage | null | undefined): RoutineRunContext | null;
/**
 * Whether the message is a `routine-run` divider message, so `message.context` is a `RoutineRunContext`. A Linear Run's first
 * message is not one: it is a `linear-issue` message that carries `routine`, which only `routineRunOf` reads.
 */
export function isRoutineRun(message: ChatMessage | null | undefined): message is ChatMessage & { context: RoutineRunContext };
export function parsePass(text: string): { quiet: true; summary: string } | { quiet: false };
/** "HH:MM" on a 24 hour clock in `timeZone` (the computer's when left out); with `withDate`, "YYYY-MM-DD HH:MM". */
export function clock(at: number | Date, timeZone?: string, withDate?: boolean): string;
/**
 * The divider as text: `<label> · HH:MM` when the run acted (`label` defaults to "Heartbeat"), "HH:MM · quiet: <summary>"
 * (or "HH:MM · quiet") when it passed.
 */
export function routineRunText(context: RoutineRunContext, timeZone?: string): string;
export function mergedRoutineRunText(merged: { count: number; last: RoutineRunContext }, timeZone?: string): string;
export function groupQuietRuns(messages: ChatMessage[]): Array<{
  message: ChatMessage;
  hidden?: true;
  merged?: { count: number; last: RoutineRunContext };
}>;
/**
 * What starts a Routine, in a few words: "every 15 min", "every 2 h", "weekdays 08:30", "daily 08:30" or `cron "<expr>"`
 * for a schedule; "Linear · label agent added · team MIL", "Linear · assigned to me", "Linear · moved to Todo" or
 * "Linear · new comment" for Linear; "Webhook".
 */
export function triggerText(trigger: RoutineTrigger): string;
/**
 * Whether Run now works for the Routine: schedules and Heartbeats, not Linear or webhook triggers (no event to run with)
 * or a babysit Heartbeat (it runs only on what changed on its PR).
 */
export function canRunNow(routine: Pick<Routine, "trigger" | "target">): boolean;
/** Whether the Routine form can edit the Routine: not a babysit Heartbeat (pull-request trigger), which can still be paused and deleted. */
export function canEditRoutine(routine: Pick<Routine, "trigger">): boolean;

/** One entry of the Runs list: a Run that did something, or a stretch of Runs that did not. */
export type RunEntry =
  | { kind: "run"; run: RoutineRun }
  | { kind: "fold"; runs: RoutineRun[]; counts: { quiet: number; skipped: number; missed: number; refused: number }; last: number };
/**
 * The Runs list's entries from the Runs, newest first. Consecutive Runs that are `quiet`, `skipped-busy`, `missed` or
 * `rejected` fold into one entry (a refused Run counts only as `refused`); `last` is the newest `startedAt` in the fold.
 */
export function foldRuns(runs: readonly RoutineRun[]): RunEntry[];
/**
 * When a Run started, on the computer's clock: "Today 10:15", "Yesterday 09:00", "Oct 16 09:00", or "Dec 30, 2025 08:00"
 * for another year than `now`'s.
 */
export function runWhen(at: number, now: number): string;
export type RunFold = Extract<RunEntry, { kind: "fold" }>;
/**
 * A fold as one line: "4 quiet · <latest quiet summary>", or with other kinds in it "4 quiet · 1 skipped, its Chat was busy"
 * ("2 missed", "1 refused"); kinds with no Runs left out.
 */
export function foldText(fold: Pick<RunFold, "counts" | "runs">): string;
/** A fold's times: "06:00–09:00" from its oldest to its newest Run, or one time for one Run. */
export function foldTimes(fold: Pick<RunFold, "runs">): string;
/** A day's heading on the computer's calendar: "Today", "Yesterday", "Thu, Oct 16", "Tue, Dec 30, 2025". */
export function dayLabel(at: number, now: number): string;
/** One day of the Runs list: its heading, its Runs (newest first), their entries, and whether it is today or yesterday. */
export type RunDay = { key: string; label: string; at: number; runs: RoutineRun[]; entries: RunEntry[]; recent: boolean };
/** The Runs (newest first) by the computer's day, newest day first; folds never span midnight. */
export function runDays(runs: readonly RoutineRun[], now: number): RunDay[];
/** A day's Runs by kind: "2 acted · 1 failed · 12 quiet · 1 skipped · 1 missed · 1 refused", empty kinds left out. */
export function daySummary(runs: readonly RoutineRun[]): string;
export type RunFilter = "all" | "acted" | "failed" | "unread";
/** The Runs a filter keeps; `unread` says whether a Run's Chat has a result nobody opened. */
export function filterRuns(runs: readonly RoutineRun[], filter: RunFilter, unread: (run: RoutineRun) => boolean): RoutineRun[];
/** How many Runs each filter keeps. */
export function runFilterCounts(runs: readonly RoutineRun[], unread: (run: RoutineRun) => boolean): Record<RunFilter, number>;
/** A duration in its largest units: "38 s", "4 min", "1 h 5 min". */
export function runDuration(ms: number): string;
/** The Run Chat pane's meta line: "Run at 11:47 · acted in 38 s · main". */
export function runChatMeta(run: RoutineRun, branch?: string): string;
/** When a Routine ends: "3 of 20 Runs left" or "ends in 2 days"; null when it runs until switched off. */
export function routineEnd(routine: Pick<Routine, "maxRuns" | "runCount" | "expiresAt">, now: number): string | null;
/** The Routine page's times line: "Next Run 12:00 · last Run 11:47 · 3 of 20 Runs left", leaving out what doesn't apply; "" when nothing does. */
export function routineTimes(
  routine: Pick<Routine, "enabled" | "nextRunAt" | "lastRunAt"> &
    Partial<Pick<Routine, "maxRuns" | "runCount" | "expiresAt">> & { runs?: readonly RoutineRun[] },
  now: number,
): string;
/** A schedule as its chip says it: "Every 15 min", "Every hour", "Every 2 hours", "Daily at 08:30", "Weekdays at 08:30", "Cron <expr>". */
export function scheduleWords(cron: string): string;
/** A time zone as a place: "America/Sao_Paulo" is "Sao Paulo". */
export function zonePlace(zone: string): string;
/**
 * What starts a Routine as its chip says it: the schedule in words, else the capitalized trigger text. A time-of-day schedule
 * in another zone than `localZone` names it: "Weekdays at 08:30 (Sao Paulo)".
 */
export function triggerChipText(trigger: RoutineTrigger, localZone?: string): string;
/** Where a Routine's Runs land: "New Worktree in <project>", "New Chat in <project>", or "In <Chat title>" for a Heartbeat. */
export function routineWhereText(target: Routine["target"], chatTitle?: (chatId: string) => string | undefined): string;
/** A Run's name: its own `title`, else "<key> <title>" for a Linear event, else the Routine's name. */
export function runTitle(run: RoutineRun, routineName: string): string;
/** The line of a Run's attempt that failed and was retried: "First try on gpt-6.1-sol failed: <first line of its error>". */
export function attemptText(attempt: RoutineRunAttempt): string;
/** Whether a Routine's Runs retry on a fallback: only Runs in a Chat of their own. */
export function routineRetries(routine: Pick<Routine, "target" | "trigger">): boolean;
/** "Retry on <model name>[ · effort]", or "Retry on another provider" when the Routine names no fallback. */
export function fallbackText(routine: Pick<Routine, "fallback">, nameOf?: (provider: ModelProvider, model: string) => string | undefined): string;
/** "retried on <model>" for a Run that ran on its fallback, "" otherwise. */
export function retryNote(run: RoutineRun): string;
/** The not archived Chats whose `routine.hidden` is set, across Projects. `chatKey` is "<path>#<id>". */
export function hiddenRunChats(
  scopes: ReadonlyArray<{ path: string; state: { sessions: Record<string, AgentSession> } }>,
): Array<{ chatKey: string; routineId: string; runId: string; unread: boolean }>;

/** Project states by scope key ("<path>", a Link's or another computer's key), as a desktop window or the phone holds them. */
export type ScopeStates = Readonly<Record<string, { sessions: Readonly<Record<string, unknown>> }>>;
/**
 * The Routines with a hidden Run Chat nobody has opened yet, over every computer's Projects (no Links): the Routines button
 * and their rows show a dot. Another computer's Routine ids name it (`qualifyKey`), as the desktop lists them.
 */
export function unreadRunRoutines(states: ScopeStates): Set<string>;
/** The keys ("<path>#<id>") of the hidden Run Chats nobody has opened yet, Links' left out: their Runs show a dot on the Routine page. */
export function unreadRunChats(states: ScopeStates): Set<string>;
/** The keys of one Routine's hidden Run Chats nobody has opened yet, its id as unreadRunRoutines names it: Mark as read clears them. */
export function unreadRunChatsOf(states: ScopeStates, routineId: string): string[];
/**
 * Whether a Run's Chat is there to open: its Project's state has the session, archived or not. False for a Chat gone with
 * its Worktree, and for a Project no state is held for.
 */
export function chatLeft(states: ScopeStates, chatKey: string): boolean;
/**
 * Whether a Run's row opens its Chat: while its Project's state is held, only a Chat still there does (chatLeft); a Project
 * no state is held for can't tell, so the row opens and opening the Chat loads that Project.
 */
export function canOpenRunChat(states: ScopeStates, chatKey: string): boolean;
/**
 * The Routine a Chat's header names: the one whose Run opened it (`session.routine`, hidden or kept), else an enabled
 * Heartbeat that checks back on it. `run.routineId` is the id on the Chat's own computer; another computer's is read as its.
 */
export function chatRoutine<T extends Pick<Routine, "id" | "enabled" | "target">>(
  routines: readonly T[],
  chatKey: string,
  run?: { routineId: string },
): T | undefined;
