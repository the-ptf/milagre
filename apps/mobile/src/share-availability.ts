import type { ArtifactPageKind } from "@milagre/shared/artifact";

// The Share sheet, a route of its own, tells the page it opened over (the Designs canvas or the Artifact page) whether
// sharing works, by host, Chat and kind.
const listeners = new Map<string, (available: boolean | null) => void>();
const keyOf = (hostId: string, chatId: string, kind: ArtifactPageKind) => `${hostId}|${chatId}|${kind}`;

export function shareAvailabilityChanged(hostId: string, chatId: string, available: boolean | null, kind: ArtifactPageKind = "designs") {
  listeners.get(keyOf(hostId, chatId, kind))?.(available);
}

/** Hears the Share sheet over this page; returns what stops listening. */
export function onShareAvailability(hostId: string, chatId: string, kind: ArtifactPageKind, listener: (available: boolean | null) => void) {
  const key = keyOf(hostId, chatId, kind);
  listeners.set(key, listener);
  return () => {
    if (listeners.get(key) === listener) listeners.delete(key);
  };
}
