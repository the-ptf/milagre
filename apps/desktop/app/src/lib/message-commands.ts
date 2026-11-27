import { searchMessages, type ChatSearchHit, type ChatSearchResult, type SearchableMessage } from "@milagre/shared/message-search";
import { failedLines, hitDetail, MESSAGE_SEARCH_COPY, type MessageFilters } from "@milagre/shared/message-search-view";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import type { ChatSearchMatch, MilagreBridge } from "../electron.d.ts";
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

/** Rows for the palette's message mode: each names its Chat (and Project across several) and marks an archived Chat. */
export function hitCommands(
  result: ChatSearchResult,
  { withProject, now, open }: { withProject: boolean; now: number; open: (hit: ChatSearchHit) => void },
): { commands: Command[]; failed: string[] } {
  return {
    commands: result.matches.map((hit) => ({
      id: `hit:${hit.projectPath}#${hit.message.id}`,
      label: hit.snippet,
      highlight: hit.highlight,
      group: "Messages",
      icon: "message" as const,
      detail: hitDetail(hit, { now, withProject }),
      ...(hit.chat.archived ? { badge: MESSAGE_SEARCH_COPY.archivedBadge } : {}),
      run: () => open(hit),
    })),
    failed: failedLines(result),
  };
}

export type MessageSearchSource = {
  /** "This Project" or "This Link": what the narrow scope covers. */
  hereLabel: string;
  search: (query: string, filters: MessageFilters) => Promise<{ commands: Command[]; failed: string[] }>;
};

/**
 * The palette's message search over `scope` or every Project on its computer. A hit in `scope` opens with `open`; one
 * elsewhere with `elsewhere`, or `open` given its Project.
 */
export function messageSearchSource(
  bridge: Pick<MilagreBridge, "searchAllChats">,
  scope: string,
  open: (sessionId: number, term: string, projectPath?: string) => void,
  elsewhere: (hit: ChatSearchHit) => void = (hit) => open(hit.chat.id, hit.term, hit.projectPath),
): MessageSearchSource {
  return {
    hereLabel: isLinkScopeKey(scope) ? MESSAGE_SEARCH_COPY.hereLink : MESSAGE_SEARCH_COPY.here,
    search: async (query, filters) =>
      hitCommands(await bridge.searchAllChats(query, { scope: filters.scope === "here" ? scope : undefined, archived: filters.archived, limit: 100 }), {
        withProject: filters.scope === "all",
        now: Date.now(),
        open: (hit) => (hit.projectPath === scope ? open(hit.chat.id, hit.term) : elsewhere(hit)),
      }),
  };
}
