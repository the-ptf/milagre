export const DRAFT_CHAT = "milagre:draft-chat";

/** Asks the window to leave Settings and open a new Chat without a Project, with `text` ready in its composer. */
export function requestDraftChat(text: string) {
  window.dispatchEvent(new CustomEvent<string>(DRAFT_CHAT, { detail: text }));
}

export function onDraftChatRequest(start: (text: string) => unknown) {
  const handle = (event: Event) => start((event as CustomEvent<string>).detail);
  window.addEventListener(DRAFT_CHAT, handle);
  return () => window.removeEventListener(DRAFT_CHAT, handle);
}
