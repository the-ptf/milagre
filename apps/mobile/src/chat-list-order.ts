import { comparePins } from "@milagre/shared/chats";
import type { AgentSession } from "@milagre/shared/model";

type Timed = { firstAt?: number; lastAt?: number };
type Ordered = { rank: number; chat: Pick<AgentSession, "pinned" | "pin_order"> & { summary?: Timed } };

const startedAt = (chat: Ordered["chat"]) => chat.summary?.firstAt ?? chat.summary?.lastAt ?? 0;

export function compareAcross(a: Ordered, b: Ordered): number {
  return comparePins(a.chat, b.chat) || startedAt(b.chat) - startedAt(a.chat) || a.rank - b.rank;
}

export function mergeChatLists<T extends Ordered>(lists: T[][]): T[] {
  const heads = lists.map(() => 0);
  const merged: T[] = [];
  for (;;) {
    let best = -1;
    for (let index = 0; index < lists.length; index++) {
      const candidate = lists[index]![heads[index]!];
      if (!candidate) continue;
      if (best < 0 || compareAcross(candidate, lists[best]![heads[best]!]!) < 0) best = index;
    }
    if (best < 0) return merged;
    merged.push(lists[best]![heads[best]!++]!);
  }
}
