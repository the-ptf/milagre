import { useSyncExternalStore } from "react";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import { bridgeForKey } from "./computer-bridge.ts";

/*
 * SNOOZE, AT ONCE
 * Snoozing a Chat (or waking it) moves its row before its host has saved it, as Done does (done-pending.ts). The row keeps
 * the asked-for place until the host's rows agree, the patch fails, or a minute passes without an answer.
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

function set(chatKey: string, until: number | null | undefined) {
  const next = new Map(pending);
  clearTimeout(timers.get(chatKey));
  timers.delete(chatKey);
  if (until === undefined) next.delete(chatKey);
  else {
    next.set(chatKey, until);
    timers.set(
      chatKey,
      setTimeout(() => set(chatKey, undefined), PENDING_MS),
    );
  }
  pending = next;
  for (const listener of listeners) listener();
}

/** Snoozes a Chat on its computer until `until` (ms), or wakes it (null); the row moves at once. */
export function snoozeChat(scopeKey: string, sessionId: number, until: number | null): Promise<void> {
  const chatKey = `${scopeKey}#${sessionId}`;
  set(chatKey, until);
  return bridgeForKey(scopeKey)
    .patchChat(scopeKey, sessionId, { snoozed_until: until ?? false })
    .catch((error: unknown) => {
      // Unless a later Snooze or Wake of it took the row since.
      if (pending.get(chatKey) === until) set(chatKey, undefined);
      throw error;
    });
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
