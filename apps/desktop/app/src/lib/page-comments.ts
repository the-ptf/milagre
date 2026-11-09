import { useSyncExternalStore } from "react";
import type { PageElement, SavedPageComment } from "@milagre/shared/page-comments";
import { pageKey } from "@milagre/shared/page-comments";
import type { PagePin } from "@milagre/shared/page-picker";

/** A comment left on a page but not sent yet, with the screenshot of its element. */
export type PendingPageComment = { id: string; url: string; title: string; element: PageElement; text: string; shot: string | null };

type ChatComments = {
  showResolved?: boolean;
  commenting: boolean;
  pending: PendingPageComment[];
  sent: SavedPageComment[];
  open: string | null;
};
const EMPTY: ChatComments = { commenting: false, pending: [], sent: [], open: null };

// Each Chat's page comments: whether its Browser panel is in comment mode, what it hasn't sent yet, and what the host
// keeps of what it sent (with the agent's resolutions). Pending comments last until sent, or until the app quits.
let chats = new Map<string, ChatComments>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function update(chatKey: string, change: (chat: ChatComments) => ChatComments) {
  const before = chats.get(chatKey) ?? EMPTY;
  const after = change(before);
  if (after === before) return;
  chats = new Map(chats).set(chatKey, after);
  for (const listener of listeners) listener();
}

export function usePageComments(chatKey: string | null): ChatComments {
  return useSyncExternalStore(subscribe, () => (chatKey ? (chats.get(chatKey) ?? EMPTY) : EMPTY));
}

export const pageComments = (chatKey: string): ChatComments => chats.get(chatKey) ?? EMPTY;

// Visibility belongs to the Chat and does not change its saved comments.
export const setShowResolved = (chatKey: string, showResolved: boolean) => update(chatKey, (chat) => ({ ...chat, showResolved }));

/** Closing a bubble keeps its text; empty pins are removed. */
export const openPageComment = (chatKey: string, open: string | null) =>
  update(chatKey, (chat) => ({ ...chat, open, pending: chat.pending.filter((pin) => pin.id === open || pin.text.trim()) }));

export const setCommenting = (chatKey: string, commenting: boolean) => {
  if (!commenting) openPageComment(chatKey, null);
  update(chatKey, (chat) => ({ ...chat, commenting }));
};

export const editPageComment = (chatKey: string, id: string, text: string) =>
  update(chatKey, (chat) => ({ ...chat, pending: chat.pending.map((pin) => (pin.id === id ? { ...pin, text } : pin)) }));

export const addPendingComment = (chatKey: string, comment: PendingPageComment) =>
  update(chatKey, (chat) => ({ ...chat, pending: [...chat.pending, comment] }));

export const removePendingComments = (chatKey: string, ids: ReadonlySet<string>) =>
  update(chatKey, (chat) =>
    chat.pending.some((comment) => ids.has(comment.id)) ? { ...chat, pending: chat.pending.filter((comment) => !ids.has(comment.id)) } : chat,
  );

/** Retire only the text that was delivered. Later edits become a distinct comment for the next Send. */
export const completePendingComments = (chatKey: string, batch: readonly PendingPageComment[]) => {
  const sent = new Map(batch.map((pin) => [pin.id, pin.text]));
  update(chatKey, (chat) => ({
    ...chat,
    pending: chat.pending.flatMap((pin) => {
      if (!sent.has(pin.id)) return [pin];
      if (sent.get(pin.id) === pin.text) return [];
      return [{ ...pin, id: crypto.randomUUID().replace(/-/g, "").slice(0, 8) }];
    }),
  }));
};

/** What the host keeps of the Chat's sent comments, newest list wins. */
export const setSentComments = (chatKey: string, sent: SavedPageComment[]) =>
  update(chatKey, (chat) => (JSON.stringify(chat.sent) === JSON.stringify(sent) ? chat : { ...chat, sent }));

/** A sent comment by its id, in any Chat, for the transcript card's status. */
export function useSentComment(id: string): SavedPageComment | undefined {
  return useSyncExternalStore(subscribe, () => {
    for (const chat of chats.values()) {
      const found = chat.sent.find((comment) => comment.id === id);
      if (found) return found;
    }
    return undefined;
  });
}

/**
 * The pins a page shows: the Chat's comments on it, sent ones first, in the order they were left. Open comments carry
 * their number; resolved ones keep it alongside the agent's note.
 */
export function pagePins({ pending, sent, showResolved }: ChatComments, url: string): PagePin[] {
  const key = pageKey(url);
  const onPage = [
    ...sent
      .filter((comment) => pageKey(comment.url) === key && (showResolved || !comment.resolved))
      .map((comment) => ({ ...comment, state: comment.resolved ? ("resolved" as const) : ("open" as const) })),
    ...pending
      .filter((comment) => pageKey(comment.url) === key)
      .map((comment) => ({ ...comment, selector: comment.element.selector, point: comment.element.point, state: "pending" as const, resolved: undefined })),
  ];
  // Drafts are numbered in Send order; sent comments keep their place in the saved list.
  let next = 0;
  return onPage.map((comment) => ({
    id: comment.id,
    n: comment.state === "pending" ? ++next : sent.findIndex((pin) => pin.id === comment.id) + 1,
    selector: comment.selector,
    ...(comment.point ? { point: comment.point } : {}),
    text: comment.text,
    state: comment.state,
    ...(comment.resolved ? { note: comment.resolved.note } : {}),
  }));
}
