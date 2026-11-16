import { activityAgo } from "@milagre/shared/chat-row";
import type { AgentSession } from "@milagre/shared/model";
import { mergeChatLists } from "./chat-list-order.ts";

type Listed = { chat: Pick<AgentSession, "pinned" | "pin_order"> & { summary?: { firstAt?: number; lastAt?: number } } };

export function chatsGroupChats<T extends Listed>(homes: readonly { hostId: string; chats: readonly T[] }[]): { hostId: string; entry: T }[] {
  return mergeChatLists(homes.map(({ hostId, chats }, rank) => chats.map((entry) => ({ rank, chat: entry.chat, hostId, entry })))).map(({ hostId, entry }) => ({
    hostId,
    entry,
  }));
}

export function chatsRowDetail(hostName: string, lastAt: number | undefined, now: number): string {
  return lastAt === undefined ? hostName : `${hostName} · ${activityAgo(lastAt, now)}`;
}

export function chatsGroupNeedsAttention(
  homes: readonly { hostId: string; path: string }[],
  currentHostId: string | undefined,
  attentionPaths: readonly string[],
): boolean {
  return homes.some((home) => home.hostId === currentHostId && attentionPaths.includes(home.path));
}

export type ChatsGroupHeader = {
  kind: "chatsGroup";
  expanded: boolean;
  count: number;
  offline: boolean;
  homes: { hostId: string; path: string }[];
};

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
