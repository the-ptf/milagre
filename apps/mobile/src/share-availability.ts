const listeners = new Map<string, Set<(available: boolean | null) => void>>();
const keyOf = (hostId: string, chatId: string) => `${hostId}|${chatId}`;

/** What a Share sheet learned about the sharing service, for the Artifact's Share entries of the same Chat. */
export function shareAvailabilityChanged(hostId: string, chatId: string, available: boolean | null) {
  for (const listener of listeners.get(keyOf(hostId, chatId)) ?? []) listener(available);
}

export function onShareAvailability(hostId: string, chatId: string, listener: (available: boolean | null) => void) {
  const key = keyOf(hostId, chatId);
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (!set.size && listeners.get(key) === set) listeners.delete(key);
  };
}
