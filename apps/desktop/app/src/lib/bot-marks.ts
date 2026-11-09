import { createContext, useContext } from "react";
import type { BotSummary, BotsSnapshot } from "@milagre/shared/bots";

/** What a Chat row shows about the bot that opened it: "from <Bot name>" beside its mascot. */
export type BotMark = Pick<BotSummary, "id" | "name" | "color" | "body">;

const NONE: ReadonlyMap<string, BotMark> = new Map();

/** Chat key → the bot that opened the Chat and still runs it. A Chat the user took over is his own again. */
export function botMarks(snapshot: BotsSnapshot | null): ReadonlyMap<string, BotMark> {
  if (!snapshot?.chats.length) return NONE;
  const bots = new Map(snapshot.bots.map((bot) => [bot.id, { id: bot.id, name: bot.name, color: bot.color, body: bot.body }]));
  const marks = new Map<string, BotMark>();
  for (const chat of snapshot.chats) {
    const bot = chat.status === "taken-over" ? undefined : bots.get(chat.botId);
    if (bot) marks.set(chat.chatKey, bot);
  }
  return marks;
}

export const BotMarksContext = createContext<ReadonlyMap<string, BotMark>>(NONE);
export const useBotMarks = () => useContext(BotMarksContext);
