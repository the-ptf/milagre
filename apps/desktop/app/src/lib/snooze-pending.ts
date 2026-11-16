import { useSyncExternalStore } from "react";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import { bridgeForKey } from "./computer-bridge.ts";

let pending: ReadonlyMap<string, number | null> = new Map();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const PENDING_MS = 60_000;
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

const latest = new Map<string, number>();
let asked = 0;

export async function snoozeChat(scopeKey: string, sessionId: number, until: number | null): Promise<void> {
  const chatKey = `${scopeKey}#${sessionId}`;
  const ask = ++asked;
  latest.set(chatKey, ask);
  set(chatKey, until);
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

export function dropSnoozePending(scopeKey: string, sessionId: number | string) {
  if (pending.has(`${scopeKey}#${sessionId}`)) set(`${scopeKey}#${sessionId}`, undefined);
}

export const pendingSnoozeMarks = (): ReadonlyMap<string, number | null> => pending;

export function useSnoozePending(): ReadonlyMap<string, number | null> {
  return useSyncExternalStore(subscribe, pendingSnoozeMarks);
}

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

export function settleSnoozePending(scopeKey: string, rows: readonly SidebarRecent[]) {
  for (const row of rows) {
    const chatKey = `${scopeKey}#${row.id}`;
    const until = pending.get(chatKey);
    if (until !== undefined && until === (row.snoozedUntil ?? null)) set(chatKey, undefined);
  }
}

export const inSnoozed = (row: SidebarRecent) => Boolean(row.snoozedUntil) && !row.doneAt;
