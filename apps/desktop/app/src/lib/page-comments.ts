import { useSyncExternalStore } from "react";
import type { PageElement, SavedPageComment } from "@milagre/shared/page-comments";
import { pageKey } from "@milagre/shared/page-comments";
import type { PagePin } from "@milagre/shared/page-picker";

/** A comment left on a page but not sent yet, with the screenshot of its element. */
export type PendingPageComment = { id: string; url: string; title: string; element: PageElement; text: string; shot: string | null };

/** A comment being written: the element picked on a tab's page, and what is typed so far. */
export type PageCommentDraft = { url: string; element: PageElement; shot: string | null; text: string };

type ChatComments = { commenting: boolean; pending: PendingPageComment[]; sent: SavedPageComment[]; drafts: Readonly<Record<string, PageCommentDraft>> };
const EMPTY: ChatComments = { commenting: false, pending: [], sent: [], drafts: {} };

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

// Leaving comment mode drops what wasn't added; switching tab or Chat keeps it for when the page shows again.
export const setCommenting = (chatKey: string, commenting: boolean) =>
  update(chatKey, (chat) => (chat.commenting === commenting ? chat : { ...chat, commenting, ...(commenting ? {} : { drafts: {} }) }));

/** Sets (or, with null, drops) the comment being written on a tab's page. */
export const setPageDraft = (chatKey: string, tabId: string, draft: PageCommentDraft | null) =>
  update(chatKey, (chat) => {
    if (!draft && !chat.drafts[tabId]) return chat;
    const drafts = { ...chat.drafts };
    if (draft) drafts[tabId] = draft;
    else delete drafts[tabId];
    return { ...chat, drafts };
  });

export const addPendingComment = (chatKey: string, comment: PendingPageComment) =>
  update(chatKey, (chat) => ({ ...chat, pending: [...chat.pending, comment] }));

export const removePendingComments = (chatKey: string, ids: ReadonlySet<string>) =>
  update(chatKey, (chat) =>
    chat.pending.some((comment) => ids.has(comment.id)) ? { ...chat, pending: chat.pending.filter((comment) => !ids.has(comment.id)) } : chat,
  );

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
 * their number; resolved ones a check and the agent's note.
 */
export function pagePins({ pending, sent }: ChatComments, url: string): PagePin[] {
  const key = pageKey(url);
  const onPage = [
    ...sent
      .filter((comment) => pageKey(comment.url) === key)
      .map((comment) => ({ ...comment, state: comment.resolved ? ("resolved" as const) : ("open" as const) })),
    ...pending
      .filter((comment) => pageKey(comment.url) === key)
      .map((comment) => ({ ...comment, selector: comment.element.selector, point: comment.element.point, state: "pending" as const, resolved: undefined })),
  ];
  // Only the comments still to send are numbered, 1 to n like the Send button and the card they become; a sent one
  // shows as waiting on the agent, or resolved.
  let next = 0;
  return onPage.map((comment) => ({
    n: comment.state === "pending" ? ++next : 0,
    selector: comment.selector,
    ...(comment.point ? { point: comment.point } : {}),
    text: comment.text,
    state: comment.state,
    ...(comment.resolved ? { note: comment.resolved.note } : {}),
  }));
}
