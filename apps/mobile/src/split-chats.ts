import { useSyncExternalStore } from "react";

/**
 * A second Chat open beside the routed one on a wide iPad, as desktop's grid keeps two Chats in view. It can be of any
 * Project on any connected computer: a Chat of another Project syncs that Project on its own (beside-session.tsx).
 */
export type BesideChat = { hostId: string; projectPath: string; chatId: number };

/** Where the routed Chat is: its computer and Project, and its id (none for a New Chat). */
type Open = { hostId?: string; projectPath?: string; chatId?: number };

/** Whether a sidebar row offers "Open beside": a wide window, a Chat open, and the row another Chat on a computer that answers. */
export function canOpenBeside(
  row: { hostId: string; projectPath: string; chatId: number; archived?: boolean; offline?: boolean },
  open: Open & { wide: boolean },
  beside: BesideChat | null,
) {
  return (
    open.wide &&
    open.chatId !== undefined &&
    !row.archived &&
    !row.offline &&
    !(row.hostId === open.hostId && row.projectPath === open.projectPath && row.chatId === open.chatId) &&
    !sameChat(beside, row)
  );
}

/**
 * What becomes of the Chat beside: `shown`, `hidden` while it can't show (a narrow window, no computer open, the open
 * Project it shares still loading), or `ended` once the pair is over (the routed Chat became it, or it is gone from the
 * open Project). A Chat of another Project is checked by its own pane, which closes it once it is gone. A window that
 * narrows keeps it, so it comes back when the window widens again.
 */
export function besideState(
  beside: BesideChat | null,
  at: Open & { wide: boolean; loadedPath?: string; exists: (chatId: number) => boolean },
): "shown" | "hidden" | "ended" {
  if (!beside || !at.hostId) return "hidden";
  const sameProject = at.hostId === beside.hostId && at.projectPath === beside.projectPath;
  if (sameProject && at.chatId === beside.chatId) return "ended";
  if (sameProject && at.loadedPath !== beside.projectPath) return "hidden";
  if (sameProject && !at.exists(beside.chatId)) return "ended";
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
