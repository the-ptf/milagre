/** What a keyboard shortcut asks of the Chats list on screen; one opened for it picks the request up when it shows. */
export type NavigationCommand = { kind: "new" } | { kind: "search" } | { kind: "chat"; index: number };

// A request nothing picks up soon (no computer open, say) is dropped rather than acted on later by surprise.
const TTL_MS = 3000;
let pending: { command: NavigationCommand; at: number } | null = null;
const listeners = new Set<() => void>();

export function requestNavigation(command: NavigationCommand) {
  pending = { command, at: Date.now() };
  listeners.forEach((listener) => listener());
}

export function takeNavigation(now = Date.now()): NavigationCommand | null {
  const request = pending;
  pending = null;
  return request && now - request.at <= TTL_MS ? request.command : null;
}

export function subscribeNavigation(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
