import { comparePins } from "@milagre/shared/chats";
import type { AgentSession } from "@milagre/shared/model";

/** `firstAt` (when the Chat's first message was sent) comes from newer hosts next to `lastAt`; neither is on older ones. */
type Timed = { firstAt?: number; lastAt?: number };
type Ordered = { rank: number; chat: Pick<AgentSession, "pinned" | "pin_order"> & { summary?: Timed } };

/** When a Chat began, else when it last moved; 0 for a host that keeps neither, which leaves its Project's own order. */
const startedAt = (chat: Ordered["chat"]) => chat.summary?.firstAt ?? chat.summary?.lastAt ?? 0;

/**
 * Which of two Chats from different Projects comes first: pinned ones, in their pin order, then the Chat that began later, as
 * the default Chat order has it (else the later activity). A Chat's own id and first message are numbers inside its Project, so they say nothing across two.
 */
export function compareAcross(a: Ordered, b: Ordered): number {
  return comparePins(a.chat, b.chat) || startedAt(b.chat) - startedAt(a.chat) || a.rank - b.rank;
}

/**
 * One list out of each Project's own sorted list. Within a Project the order is kept (newest first by when the Chat
 * began, so rows don't jump as agents reply); the lists are interleaved by comparing the next Chat of each. `rank` is
 * the Project's place in the sidebar, which settles a tie.
 */
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
