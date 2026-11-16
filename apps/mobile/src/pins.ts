import type { AgentSession } from "@milagre/shared/model";
import { comparePins, pinOrderAt } from "@milagre/shared/chats";

export function pinPatch(action: string, chat: AgentSession, sessions: AgentSession[]) {
  if (action === "unpin") return { pinned: false };
  const others = sessions.filter((session) => session.pinned && !session.archived && session.id !== chat.id).sort(comparePins);
  const orders = others.map((session) => session.pin_order ?? 0);
  if (action === "pin") return { pinned: true, pin_order: pinOrderAt(orders, orders.length) };
  const place = sessions
    .filter((session) => session.pinned && !session.archived)
    .sort(comparePins)
    .findIndex((session) => session.id === chat.id);
  const index = action === "pin-up" ? place - 1 : place + 1;
  if (place < 0 || index < 0 || index > others.length) return null;
  return { pinned: true, pin_order: pinOrderAt(orders, index) };
}
