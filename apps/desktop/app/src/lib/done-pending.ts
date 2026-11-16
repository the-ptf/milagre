import { useSyncExternalStore } from "react";
import type { SessionPatch } from "@milagre/shared/project-edits";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import { bridgeForKey } from "./computer-bridge.ts";
import { dropSnoozePending } from "./snooze-pending.ts";

let pending: ReadonlyMap<string, number | null> = new Map();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const PENDING_MS = 60_000;

function set(chatKey: string, doneAt: number | null | undefined) {
  const next = new Map(pending);
  clearTimeout(timers.get(chatKey));
  timers.delete(chatKey);
  if (doneAt === undefined) next.delete(chatKey);
  else {
    next.set(chatKey, doneAt);
    timers.set(
      chatKey,
      setTimeout(() => set(chatKey, undefined), PENDING_MS),
    );
  }
  pending = next;
  for (const listener of listeners) listener();
}

export function patchChatShowingDone(scopeKey: string, sessionId: number, patch: SessionPatch): Promise<void> {
  const { done } = patch;
  if (typeof done !== "boolean") return bridgeForKey(scopeKey).patchChat(scopeKey, sessionId, patch);
  const chatKey = `${scopeKey}#${sessionId}`;
  const doneAt = done ? Date.now() : null;
  set(chatKey, doneAt);
  dropSnoozePending(scopeKey, sessionId);
  return bridgeForKey(scopeKey)
    .patchChat(scopeKey, sessionId, patch)
    .catch((error: unknown) => {
      if (pending.get(chatKey) === doneAt) set(chatKey, undefined);
      throw error;
    });
}

export const pendingDoneMarks = (): ReadonlyMap<string, number | null> => pending;

export function useDonePending(): ReadonlyMap<string, number | null> {
  return useSyncExternalStore(subscribe, pendingDoneMarks);
}

export function withDonePending(scopeKey: string, rows: SidebarRecent[], marks: ReadonlyMap<string, number | null>): SidebarRecent[] {
  if (marks.size === 0) return rows;
  let changed = false;
  const shown = rows.map((row) => {
    const doneAt = marks.get(`${scopeKey}#${row.id}`);
    if (doneAt === undefined || Boolean(doneAt) === Boolean(row.doneAt)) return row;
    changed = true;
    if (doneAt) return { ...row, doneAt, unread: false };
    const { doneAt: _was, ...reopened } = row;
    return reopened;
  });
  return changed ? shown : rows;
}

export function settleDonePending(scopeKey: string, rows: readonly SidebarRecent[]) {
  for (const row of rows) {
    const chatKey = `${scopeKey}#${row.id}`;
    const doneAt = pending.get(chatKey);
    if (doneAt !== undefined && Boolean(doneAt) === Boolean(row.doneAt)) set(chatKey, undefined);
  }
}
