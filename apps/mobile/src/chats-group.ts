import { activityAgo } from "@milagre/shared/chat-row";
import type { AgentSession } from "@milagre/shared/model";
import { mergeChatLists } from "./chat-list-order.ts";

type Listed = { chat: Pick<AgentSession, "pinned" | "pin_order"> & { summary?: { firstAt?: number; lastAt?: number } } };

/**
 * The drawer's Chats group: every computer's Chats without a Project in one list, not one group per computer. Each
 * computer's list is already newest first; they interleave by when each Chat began, pinned Chats leading.
 */
export function chatsGroupChats<T extends Listed>(homes: readonly { hostId: string; chats: readonly T[] }[]): { hostId: string; entry: T }[] {
  return mergeChatLists(homes.map(({ hostId, chats }, rank) => chats.map((entry) => ({ rank, chat: entry.chat, hostId, entry })))).map(({ hostId, entry }) => ({
    hostId,
    entry,
  }));
}

/** A Chats group row's second line: the computer it runs on and how long ago it last moved. A home has no branch to name. */
export function chatsRowDetail(hostName: string, lastAt: number | undefined, now: number): string {
  return lastAt === undefined ? hostName : `${hostName} · ${activityAgo(lastAt, now)}`;
}

/**
 * Whether the Chats group's header shows the attention dot, as a Project group's does: a Chat without a Project on the
 * open computer waits on an approval or a question (`attentionPaths`: the Projects of its attention keys), folded or not.
 */
export function chatsGroupNeedsAttention(
  homes: readonly { hostId: string; path: string }[],
  currentHostId: string | undefined,
  attentionPaths: readonly string[],
): boolean {
  return homes.some((home) => home.hostId === currentHostId && attentionPaths.includes(home.path));
}

/** The drawer's Chats group header, as project-navigation lists it. */
export type ChatsGroupHeader = {
  kind: "chatsGroup";
  expanded: boolean;
  count: number;
  offline: boolean;
  homes: { hostId: string; path: string }[];
};

/**
 * The Chats group's header and rows. It shows only while some computer has a Chat without a Project; with none, the
 * New Chat picker's No project row starts one. Its rows go only while it is folded. `null` with no such Chat or no
 * computer listed.
 */
export function chatsGroupList<T extends { reach?: string }>({
  computers,
  rows,
  folded,
  homes,
}: {
  computers: number;
  rows: readonly T[];
  folded: boolean;
  homes: { hostId: string; path: string }[];
}): { header: ChatsGroupHeader; rows: readonly T[] } | null {
  if (computers === 0 || rows.length === 0) return null;
  return {
    header: { kind: "chatsGroup", expanded: !folded, count: rows.length, offline: rows.length > 0 && rows.every((row) => row.reach === "offline"), homes },
    rows: folded ? [] : rows,
  };
}
