import type { AgentRuns } from "@milagre/shared/agent-runs";
import { isHiddenRunChat } from "@milagre/shared/chats";
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
 * asking, a Delegation working there, or a finished turn not read yet. Named Links' Chats stay out, and so do hidden Run
 * Chats (an hourly Routine would fill the grid), except while their run waits on an approval or a question.
 */
export function activeChatKeys(runs: AgentRuns, work: LinkedWork, states: Record<string, CoordinatorState | LinkState>): string[] {
  const keys = new Set([...Object.keys(runs), ...work.delegations.flatMap((item) => (item.to_chat ? [item.to_chat] : []))]);
  const sessions = new Map<string, CoordinatorState["sessions"][string] | LinkState["sessions"][string]>();
  for (const [path, state] of Object.entries(states))
    for (const session of Object.values(state.sessions ?? {})) {
      const key = `${path}#${session.id}`;
      sessions.set(key, session);
      if (session.unread && !session.archived) keys.add(key);
    }
  const waiting = (key: string) => Boolean(runs[key]?.approvals.length || runs[key]?.questions.length);
  return [...keys].filter((key) => !key.startsWith("milagre-link:") && !isHiddenRunChat(sessions.get(key), waiting(key)));
}

/** The focused tile's key while the window shows a new Chat not saved yet: Chat ids start at 1. */
export const draftTileKey = (projectPath: string) => `${projectPath}#0`;
export const isDraftTileKey = (key: string) => key.endsWith("#0");

/**
 * The grid's tiles in order. A Chat keeps its slot while it stays active or focused, so a status change never moves
 * a tile; new ones join at the end, except a new Chat's first save, which takes its draft tile's slot. Returns
 * `previous` itself when nothing changed.
 */
export function gridChats(previous: readonly string[], active: readonly string[], focused: string | null): readonly string[] {
  const wanted = new Set(active);
  if (focused) wanted.add(focused);
  const draft = previous.findIndex((key) => isDraftTileKey(key) && !wanted.has(key));
  const kept = previous.flatMap((key, index) => (wanted.has(key) ? [key] : index === draft && focused && !previous.includes(focused) ? [focused] : []));
  const next = [...kept, ...[...wanted].filter((key) => !kept.includes(key))];
  return next.length === previous.length && next.every((key, index) => key === previous[index]) ? previous : next;
}
