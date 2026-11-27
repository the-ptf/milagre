import { onDraftChatRequest } from "./draft-chat-request";
import { unqualifyKey } from "@milagre/shared/chat-scopes";

const OPEN = "milagre:design-library";

/** The Project whose Design library page is open: its key (qualified for a paired computer's) and its name. */
export type DesignLibraryTarget = { projectKey: string; name: string };

const nameOf = (projectKey: string) => unqualifyKey(projectKey).split(/[\\/]/).findLast(Boolean) ?? projectKey;

/** Opens the Design library page of the Project `projectKey` names, from wherever the window is. */
export function openDesignLibrary(projectKey: string, name?: string) {
  window.dispatchEvent(new CustomEvent<DesignLibraryTarget>(OPEN, { detail: { projectKey, name: name || nameOf(projectKey) } }));
}

export function onDesignLibraryOpen(listener: (target: DesignLibraryTarget) => void): () => void {
  const opened = (event: Event) => listener((event as CustomEvent<DesignLibraryTarget>).detail);
  window.addEventListener(OPEN, opened);
  return () => window.removeEventListener(OPEN, opened);
}

const REQUEST = "milagre:designs-request";
type DesignsRequest = { chatId: string } | { linkId: string };

/** The Designs page asks the window to open a Chat, or a Named Link's settings. */
export function requestFromDesigns(request: DesignsRequest) {
  window.dispatchEvent(new CustomEvent<DesignsRequest>(REQUEST, { detail: request }));
}

/** Opens Chats asked for by the system (`native`) or by the Designs page, and Link settings asked for by the page. */
export function onOpenRequests(
  native: (listener: (chatId: string) => void) => () => void,
  openChat: (chatId: string) => void,
  editLink: (linkId: string) => void,
  startDraft?: (text: string) => unknown,
) {
  const requested = (event: Event) => {
    const detail = (event as CustomEvent<DesignsRequest>).detail;
    if ("chatId" in detail) openChat(detail.chatId);
    else editLink(detail.linkId);
  };
  const stop = native(openChat);
  const stopDrafts = startDraft ? onDraftChatRequest(startDraft) : () => {};
  window.addEventListener(REQUEST, requested);
  return () => {
    stop();
    stopDrafts();
    window.removeEventListener(REQUEST, requested);
  };
}

/** A Project or Link key's folder name, for a title. */
export const designProjectName = nameOf;
