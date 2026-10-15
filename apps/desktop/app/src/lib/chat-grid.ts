import type { AgentRuns } from "@milagre/shared/agent-runs";
import type { CoordinatorState, LinkState, LinkedWork } from "../model";

/** How the Chat view shows Chats: the open one alone, or every active one side by side. */
export type ChatLayout = "single" | "grid";

const LAYOUT_KEY = "milagre.chatLayout";

export function readChatLayout(storage: Pick<Storage, "getItem">): ChatLayout {
  return storage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "single";
}

export function saveChatLayout(storage: Pick<Storage, "setItem">, layout: ChatLayout) {
  storage.setItem(LAYOUT_KEY, layout);
}

/**
 * Keys (`<project>#<id>`) of the Chats the grid shows besides the focused one: a turn running, waiting on the user or
 * asking, a Delegation working there, or a finished turn not read yet. Named Links' Chats stay out.
 */
export function activeChatKeys(runs: AgentRuns, work: LinkedWork, states: Record<string, CoordinatorState | LinkState>): string[] {
  const keys = new Set([...Object.keys(runs), ...work.delegations.flatMap((item) => (item.to_chat ? [item.to_chat] : []))]);
  for (const [path, state] of Object.entries(states))
    for (const session of Object.values(state.sessions ?? {})) if (session.unread && !session.archived) keys.add(`${path}#${session.id}`);
  return [...keys].filter((key) => !key.startsWith("milagre-link:"));
}

/**
 * The grid's tiles in order. A Chat keeps its slot while it stays active or focused, so a status change never moves
 * a tile; new ones join at the end. Returns `previous` itself when nothing changed.
 */
export function gridChats(previous: readonly string[], active: readonly string[], focused: string | null): readonly string[] {
  const wanted = new Set(active);
  if (focused) wanted.add(focused);
  const kept = previous.filter((key) => wanted.has(key));
  const next = [...kept, ...[...wanted].filter((key) => !kept.includes(key))];
  return next.length === previous.length && next.every((key, index) => key === previous[index]) ? previous : next;
}
