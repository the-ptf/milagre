import { useSyncExternalStore } from "react";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import { bridgeForKey } from "./computer-bridge.ts";

/*
 * SNOOZE, AT ONCE
 * Snoozing a Chat (or waking it) moves its row before its host has saved it, as Done does (done-pending.ts). The row keeps
 * the asked-for place until the host's rows agree, the patch fails, or a minute passes without an answer. Once the host
 * has answered, its rows win within a few seconds even when they never agree: a question can wake a Chat right after
 * its Snooze is saved, before this sidebar ever drew it snoozed (statechart, #1039).
 */

// Chat key (`<scope>#<id>`) to the wake time the row shows meanwhile: a time while snoozed, null once woken.
let pending: ReadonlyMap<string, number | null> = new Map();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const PENDING_MS = 60_000;
// How long a mark outlives its host's answer: time for that host's rows to arrive, from another computer too.
const ANSWERED_MS = 5_000;

function set(chatKey: string, until: number | null | undefined, ms = PENDING_MS) {
  const next = new Map(pending);
  clearTimeout(timers.get(chatKey));
  timers.delete(chatKey);
  if (until === undefined) next.delete(chatKey);
  else {
    next.set(chatKey, until);
    timers.set(
      chatKey,
      setTimeout(() => set(chatKey, undefined), ms),
    );
  }
  pending = next;
  for (const listener of listeners) listener();
}

// Chat key to the latest Snooze or Wake asked of it: only that one's answer moves its mark. Wake is always null and
// Tomorrow a fixed time, so an older patch can carry the same value as the one the row shows.
const latest = new Map<string, number>();
let asked = 0;

/** Snoozes a Chat on its computer until `until` (ms), or wakes it (null); the row moves at once. */
export async function snoozeChat(scopeKey: string, sessionId: number, until: number | null): Promise<void> {
  const chatKey = `${scopeKey}#${sessionId}`;
  const ask = ++asked;
  latest.set(chatKey, ask);
  set(chatKey, until);
  // Unless a later Snooze or Wake of it, a Done or a sent message took the row since.
  const ours = () => latest.get(chatKey) === ask && pending.get(chatKey) === until;
  try {
    await bridgeForKey(scopeKey).patchChat(scopeKey, sessionId, { snoozed_until: until ?? false });
  } catch (error) {
    if (ours()) set(chatKey, undefined);
    throw error;
  } finally {
    if (latest.get(chatKey) === ask) {
      if (pending.get(chatKey) === until) set(chatKey, until, ANSWERED_MS);
      latest.delete(chatKey);
    }
  }
}

/** Forgets a Chat's pending Snooze or Wake: Done or a sent message clears its snooze on the host anyway. */
export function dropSnoozePending(scopeKey: string, sessionId: number | string) {
  if (pending.has(`${scopeKey}#${sessionId}`)) set(`${scopeKey}#${sessionId}`, undefined);
}

export const pendingSnoozeMarks = (): ReadonlyMap<string, number | null> => pending;

export function useSnoozePending(): ReadonlyMap<string, number | null> {
  return useSyncExternalStore(subscribe, pendingSnoozeMarks);
}

/** A scope's rows as the pending Snooze marks show them; the same array when none applies. */
export function withSnoozePending(scopeKey: string, rows: SidebarRecent[], marks: ReadonlyMap<string, number | null>): SidebarRecent[] {
  if (marks.size === 0) return rows;
  let changed = false;
  const shown = rows.map((row) => {
    const until = marks.get(`${scopeKey}#${row.id}`);
    if (until === undefined || until === (row.snoozedUntil ?? null)) return row;
    changed = true;
    if (until) return { ...row, snoozedUntil: until };
    const { snoozedUntil: _was, ...woken } = row;
    return woken;
  });
  return changed ? shown : rows;
}

/** Drops the marks a scope's rows from its host already agree with, so a later change on the host shows again. */
export function settleSnoozePending(scopeKey: string, rows: readonly SidebarRecent[]) {
  for (const row of rows) {
    const chatKey = `${scopeKey}#${row.id}`;
    const until = pending.get(chatKey);
    if (until !== undefined && until === (row.snoozedUntil ?? null)) set(chatKey, undefined);
  }
}

/** Whether a row sits in the Snoozed section: snoozed and not Done (Done wins; the host clears the snooze then). */
export const inSnoozed = (row: SidebarRecent) => Boolean(row.snoozedUntil) && !row.doneAt;
