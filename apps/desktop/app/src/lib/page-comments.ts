import { useSyncExternalStore } from "react";
import type { PageElement, SavedPageComment } from "@milagre/shared/page-comments";
import { pageKey } from "@milagre/shared/page-comments";
import type { PagePin } from "@milagre/shared/page-picker";

export type PendingPageComment = { id: string; url: string; title: string; element: PageElement; text: string; shot: string | null };

type ChatComments = {
  showResolved?: boolean;
  commenting: boolean;
  pending: PendingPageComment[];
  sent: SavedPageComment[];
  open: string | null;
};
const EMPTY: ChatComments = { commenting: false, pending: [], sent: [], open: null };

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

export const setShowResolved = (chatKey: string, showResolved: boolean) => update(chatKey, (chat) => ({ ...chat, showResolved }));

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

export const setSentComments = (chatKey: string, sent: SavedPageComment[]) =>
  update(chatKey, (chat) => (JSON.stringify(chat.sent) === JSON.stringify(sent) ? chat : { ...chat, sent }));

export function useSentComment(id: string): SavedPageComment | undefined {
  return useSyncExternalStore(subscribe, () => {
    for (const chat of chats.values()) {
      const found = chat.sent.find((comment) => comment.id === id);
      if (found) return found;
    }
    return undefined;
  });
}

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
