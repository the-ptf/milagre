import type { ChatMessage, RoutineRunContext, RoutineTrigger } from "./model.ts";

/**
 * The divider a message stands for, or null. A `routine-run` message gives its own context. A `linear-issue` message that
 * carries `routine` (a Linear Run's first message) gives `{ kind: "routine-run", ...routine }`.
 */
export function routineRunOf(message: ChatMessage | null | undefined): RoutineRunContext | null;
/**
 * Whether the message carries a routine divider, in either of the two shapes `routineRunOf` reads. The guard keeps the
 * shape the callers were written for: `message.context` is a `RoutineRunContext` only for a `routine-run` message, so for
 * a Linear Run's message read the divider with `routineRunOf`.
 */
export function isRoutineRun(message: ChatMessage | null | undefined): message is ChatMessage & { context: RoutineRunContext };
export function parsePass(text: string): { quiet: true; summary: string } | { quiet: false };
/** "HH:MM" on a 24 hour clock in `timeZone` (the computer's when left out); with `withDate`, "YYYY-MM-DD HH:MM". */
export function clock(at: number | Date, timeZone?: string, withDate?: boolean): string;
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
