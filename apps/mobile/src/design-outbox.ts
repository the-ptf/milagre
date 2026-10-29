// A comment or a choice made on the design sheet, waiting for its Chat's screen to send it as the user's message: the
// Chat screen owns sending (its draft, pending and error states), so the sheet hands the text over and goes back. It
// waits until the message went: then `onSent` records the comments it carries.
export type DesignMessage = { text: string; onSent: () => void; kind?: "designs" | "artifacts" };
const waiting = new Map<string, DesignMessage>();

/** Turning Designs off cancels unsent review requests for that computer. Saved designs stay untouched. */
export function clearDesignMessages(hostId: string) {
  for (const [key, message] of waiting) if (key.startsWith(`${hostId}|`) && message.kind !== "artifacts") waiting.delete(key);
}

export function postDesignMessage(chatKey: string, message: DesignMessage) {
  waiting.set(chatKey, message);
}

/** The message waiting for this Chat, left waiting until it is sent. */
export function peekDesignMessage(chatKey: string): DesignMessage | null {
  return waiting.get(chatKey) ?? null;
}

/** It went: it waits no more, and records what it carries. A newer message posted meanwhile keeps waiting. */
export function designMessageSent(chatKey: string, message: DesignMessage) {
  if (waiting.get(chatKey) !== message) return;
  waiting.delete(chatKey);
  message.onSent();
}

const sendNowListeners = new Set<(chatKey: string) => void>();

/** Written in the panel docked beside its Chat (an iPad), the message goes now: the Chat never left the screen to come back. */
export function sendDesignMessageNow(chatKey: string) {
  for (const listener of sendNowListeners) listener(chatKey);
}

export function onSendDesignMessageNow(listener: (chatKey: string) => void) {
  sendNowListeners.add(listener);
  return () => {
    sendNowListeners.delete(listener);
  };
}
