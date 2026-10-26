import type { AgentRuns } from "@milagre/shared/agent-runs";
import { isHiddenRunChat } from "@milagre/shared/chats";
import type { CoordinatorState, LinkState, LinkedWork } from "../model";

/**
 * How the Chat view shows Chats: the open one alone, every active one side by side (`grid`), or only the ones dragged
 * beside it from the sidebar (`split`).
 */
export type ChatLayout = "single" | "grid" | "split";

const LAYOUT_KEY = "milagre.chatLayout";

export function readChatLayout(storage: Pick<Storage, "getItem">): ChatLayout {
  const value = storage.getItem(LAYOUT_KEY);
  return value === "grid" || value === "split" ? value : "single";
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

/**
 * The split's Chats after focus moves from `previous` to `focused`: a Chat opened from outside the split takes the slot
 * of the one focused before it, as in a browser's split view, so the split keeps its size. Returns `split` itself when
 * nothing changes.
 */
export function splitChats(split: readonly string[], previous: string | null, focused: string | null): readonly string[] {
  if (!focused || !previous || split.includes(focused)) return split;
  const at = split.indexOf(previous);
  return at < 0 ? split : split.map((key, index) => (index === at ? focused : key));
}
