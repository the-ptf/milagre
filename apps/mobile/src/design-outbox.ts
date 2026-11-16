// in order: the docked designs on an iPad take another batch while the first still waits for a busy Chat.
export type DesignMessage = { text: string; onSent: () => void; kind?: "designs" | "artifacts" };
const waiting = new Map<string, DesignMessage[]>();

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

export function peekDesignMessage(chatKey: string): DesignMessage | null {
  return waiting.get(chatKey)?.[0] ?? null;
}

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
