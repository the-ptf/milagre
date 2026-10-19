import type { AgentSession, ChatMessage, Routine, RoutineRun, RoutineRunContext, RoutineTrigger } from "./model.ts";

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
/** Whether Run now works for the Routine: schedules and Heartbeats, not Linear or webhook triggers (no event to run with). */
export function canRunNow(routine: Pick<Routine, "trigger" | "target">): boolean;

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
/** A fold as one line: "5 quiet · 2 skipped · last 10:30" (kinds with no Runs left out; "missed", "refused" likewise). */
export function foldText(counts: Extract<RunEntry, { kind: "fold" }>["counts"], last: number): string;
/** A Run's name: its own `title`, else "<key> <title>" for a Linear event, else the Routine's name. */
export function runTitle(run: RoutineRun, routineName: string): string;
/** The not archived Chats whose `routine.hidden` is set, across Projects. `chatKey` is "<path>#<id>". */
export function hiddenRunChats(
  scopes: ReadonlyArray<{ path: string; state: { sessions: Record<string, AgentSession> } }>,
): Array<{ chatKey: string; routineId: string; runId: string; unread: boolean }>;

/** Project states by scope key ("<path>", a Link's or another computer's key), as a desktop window or the phone holds them. */
export type ScopeStates = Readonly<Record<string, { sessions: Readonly<Record<string, unknown>> }>>;
/**
 * The Routines with a hidden Run Chat nobody has opened yet, over this Mac's Projects only (no Links, no other computer's):
 * the Routines button and their rows show a dot.
 */
export function unreadRunRoutines(states: ScopeStates): Set<string>;
/** The keys ("<path>#<id>") of this Mac's hidden Run Chats nobody has opened yet: their Runs show a dot on the Routine page. */
export function unreadRunChats(states: ScopeStates): Set<string>;
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
 * Heartbeat that checks back on it.
 */
export function chatRoutine<T extends Pick<Routine, "id" | "enabled" | "target">>(
  routines: readonly T[],
  chatKey: string,
  run?: { routineId: string },
): T | undefined;
