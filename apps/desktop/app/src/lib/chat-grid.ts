import type { AgentRuns } from "@milagre/shared/agent-runs";
import { isHiddenRunChat } from "@milagre/shared/chats";
import type { CoordinatorState, LinkState, LinkedWork } from "../model";

export type ChatLayout = "single" | "grid" | "split";

const LAYOUT_KEY = "milagre.chatLayout";

export function readChatLayout(storage: Pick<Storage, "getItem">): ChatLayout {
  const value = storage.getItem(LAYOUT_KEY);
  return value === "grid" || value === "split" ? value : "single";
}

export function saveChatLayout(storage: Pick<Storage, "setItem">, layout: ChatLayout) {
  storage.setItem(LAYOUT_KEY, layout);
}

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

export const draftTileKey = (projectPath: string) => `${projectPath}#0`;
export const isDraftTileKey = (key: string) => key.endsWith("#0");

export function gridChats(previous: readonly string[], active: readonly string[], focused: string | null): readonly string[] {
  const wanted = new Set(active);
  if (focused) wanted.add(focused);
  const draft = previous.findIndex((key) => isDraftTileKey(key) && !wanted.has(key));
  const kept = previous.flatMap((key, index) => (wanted.has(key) ? [key] : index === draft && focused && !previous.includes(focused) ? [focused] : []));
  const next = [...kept, ...[...wanted].filter((key) => !kept.includes(key))];
  return next.length === previous.length && next.every((key, index) => key === previous[index]) ? previous : next;
}
