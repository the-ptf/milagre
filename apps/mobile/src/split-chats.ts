import { useSyncExternalStore } from "react";

/**
 * A second Chat open beside the routed one on a wide iPad, as desktop's grid keeps two Chats in view. Both come from
 * the open Project on the open computer: the phone holds one live Project at a time (session.tsx).
 */
export type BesideChat = { hostId: string; projectPath: string; chatId: number };

/** Where the routed Chat is: its computer and Project, and its id (none for a New Chat). */
type Open = { hostId?: string; projectPath?: string; chatId?: number };

/** Whether a sidebar row offers "Open beside": a wide window, a Chat open, and the row another Chat of its Project. */
export function canOpenBeside(
  row: { hostId: string; projectPath: string; chatId: number; archived?: boolean },
  open: Open & { wide: boolean },
  beside: BesideChat | null,
) {
  return (
    open.wide &&
    open.chatId !== undefined &&
    !row.archived &&
    row.hostId === open.hostId &&
    row.projectPath === open.projectPath &&
    row.chatId !== open.chatId &&
    !sameChat(beside, row)
  );
}

/**
 * What becomes of the Chat beside: `shown`, `hidden` while it can't show (a narrow window, its Project still loading),
 * or `ended` once the pair is over (the routed Chat became it, or moved to another Project, or it is gone). A window
 * that narrows keeps it, so it comes back when the window widens again.
 */
export function besideState(
  beside: BesideChat | null,
  at: Open & { wide: boolean; loadedPath?: string; exists: (chatId: number) => boolean },
): "shown" | "hidden" | "ended" {
  if (!beside || !at.hostId) return "hidden";
  if (at.hostId !== beside.hostId || at.projectPath !== beside.projectPath || at.chatId === beside.chatId) return "ended";
  if (at.loadedPath !== beside.projectPath) return "hidden";
  if (!at.exists(beside.chatId)) return "ended";
  return at.wide ? "shown" : "hidden";
}

function sameChat(beside: BesideChat | null, row: { hostId: string; projectPath: string; chatId: number }) {
  return !!beside && beside.hostId === row.hostId && beside.projectPath === row.projectPath && beside.chatId === row.chatId;
}

// Outside the Chat screen, so it survives the sidebar replacing that screen with another Chat.
let current: BesideChat | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function openBeside(chat: BesideChat) {
  current = chat;
  notify();
}

export function closeBeside() {
  if (!current) return;
  current = null;
  notify();
}

export function besideChat() {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBesideChat() {
  return useSyncExternalStore(subscribe, besideChat);
}
