import { scopeKey } from "@milagre/shared/chat-scopes";
import type { ChatScope, LinkState } from "@milagre/shared/model";
export function createScopeDrafts() {
  const saved = new Map<string, { text: string; sessionId: number | null }>();
  const operations = new Map<string, string>();
  const identities = new Map<string, string>();
  const identity = (scope: ChatScope) => {
    const owner = scopeKey(scope);
    const value = identities.get(owner) ?? crypto.randomUUID();
    identities.set(owner, value);
    return value;
  };
  type Acknowledgement = { identity: string; previousSessionId: number | null; sessionId: number; body: string };
  const listeners = new Map<string, Set<(ack: Acknowledgement) => void>>();
  return {
    identity,
    newSelection: (scope: ChatScope) => identities.set(scopeKey(scope), crypto.randomUUID()),
    has: (scope: ChatScope) => saved.has(scopeKey(scope)),
    beginSend: (scope: ChatScope, sessionId: number | null, body: string) => {
      const key = JSON.stringify([scopeKey(scope), sessionId, body, identity(scope)]);
      const operation = operations.get(key) ?? crypto.randomUUID();
      operations.set(key, operation);
      return operation;
    },
    acknowledgeSend: (operation: string, sessionId?: number) => {
      for (const [key, value] of operations)
        if (value === operation) {
          operations.delete(key);
          if (sessionId === undefined) continue;
          const [owner, previousSessionId, fingerprint, sentIdentity] = JSON.parse(key);
          let body = fingerprint;
          try {
            body = JSON.parse(fingerprint).body ?? fingerprint;
          } catch {
            /* Plain text is also a valid fingerprint. */
          }
          const draft = saved.get(owner);
          if (identities.get(owner) === sentIdentity && draft && draft.sessionId === previousSessionId && draft.text.trim() === body)
            saved.set(owner, { text: "", sessionId });
          for (const listener of listeners.get(owner) ?? []) listener({ identity: sentIdentity, previousSessionId, sessionId, body });
        }
    },
    subscribe: (scope: ChatScope, listener: (ack: Acknowledgement) => void) => {
      const owner = scopeKey(scope),
        set = listeners.get(owner) ?? new Set();
      set.add(listener);
      listeners.set(owner, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(owner);
      };
    },
    save: (scope: ChatScope, draft: { text: string; sessionId: number | null }) => saved.set(scopeKey(scope), draft),
    read: (scope: ChatScope) => saved.get(scopeKey(scope)) ?? { text: "", sessionId: null },
  };
}
export function memberWorktreeForAction(state: LinkState, sessionId: number, projectId: string) {
  const member = state.sessions[sessionId]?.worktrees.find((binding) => binding.projectId === projectId);
  if (!member) throw new Error("Choose a member Project of this shared Chat");
  return member;
}
