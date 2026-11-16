import { searchMessages, type SearchableMessage } from "@milagre/shared/message-search";
import type { ChatSearchMatch } from "../electron.d.ts";
import type { Command } from "./commands";

const PER_CHAT = 3;
const TOTAL = 30;

export function messageCommands(
  messages: readonly SearchableMessage[],
  query: string,
  titles: ReadonlyMap<number, string>,
  open: (sessionId: number, term: string) => void,
): Command[] {
  return messageCommandsFrom(searchMessages(messages, query, 200), titles, open);
}

export function messageCommandsFrom(
  matches: readonly Pick<ChatSearchMatch, "message" | "snippet" | "highlight" | "term">[],
  titles: ReadonlyMap<number, string>,
  open: (sessionId: number, term: string) => void,
): Command[] {
  const perChat = new Map<number, number>();
  const commands: Command[] = [];
  for (const match of matches) {
    const sessionId = match.message.session_id;
    const title = titles.get(sessionId);
    const count = perChat.get(sessionId) ?? 0;
    if (title === undefined || count >= PER_CHAT) continue;
    perChat.set(sessionId, count + 1);
    commands.push({
      id: `message:${match.message.id}`,
      label: match.snippet,
      highlight: match.highlight,
      group: "Messages",
      icon: "message",
      detail: title,
      run: () => open(sessionId, match.term),
    });
    if (commands.length >= TOTAL) break;
  }
  return commands;
}
