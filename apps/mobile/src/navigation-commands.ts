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

/** The Chat a screen shows, by its computer, Project and id. */
export type OpenChat = { hostId?: string; projectPath?: string; chatId?: number };

/** Whether `href` goes to the Chat already open, so following it would only remount that Chat. */
export function isOpenChat(href: unknown, open: OpenChat) {
  if (!href || typeof href !== "object" || open.chatId === undefined) return false;
  const { pathname, params } = href as { pathname?: string; params?: Record<string, unknown> };
  if (pathname !== "/chat" || !params) return false;
  return params.id === String(open.chatId) && params.projectPath === open.projectPath && params.hostId === open.hostId;
}
