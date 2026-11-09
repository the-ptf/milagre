// A comment or a choice made on the design sheet, waiting for its Chat's screen to send it as the user's message: the
// Chat screen owns sending (its draft, pending and error states), so the sheet hands the text over and goes back. It
// waits until the message went: then `onSent` records the comments it carries. A Chat keeps every batch handed over,
// in order: the docked designs on an iPad take another batch while the first still waits for a busy Chat.
export type DesignMessage = { text: string; onSent: () => void; kind?: "designs" | "artifacts" };
const waiting = new Map<string, DesignMessage[]>();

/** Turning Designs off cancels unsent review requests for that computer. Saved designs stay untouched. */
export function clearDesignMessages(hostId: string) {
  for (const [key, messages] of waiting) {
    if (!key.startsWith(`${hostId}|`)) continue;
    const kept = messages.filter((message) => message.kind === "artifacts");
    if (kept.length) waiting.set(key, kept);
    else waiting.delete(key);
  }
}

export function postDesignMessage(chatKey: string, message: DesignMessage) {
  waiting.set(chatKey, [...(waiting.get(chatKey) ?? []), message]);
}

/** The oldest message waiting for this Chat, left waiting until it is sent. */
export function peekDesignMessage(chatKey: string): DesignMessage | null {
  return waiting.get(chatKey)?.[0] ?? null;
}

/** It went: it waits no more, and records what it carries. The batches posted after it keep waiting. */
export function designMessageSent(chatKey: string, message: DesignMessage) {
  const messages = waiting.get(chatKey);
  if (!messages?.includes(message)) return;
  const rest = messages.filter((other) => other !== message);
  if (rest.length) waiting.set(chatKey, rest);
  else waiting.delete(chatKey);
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
