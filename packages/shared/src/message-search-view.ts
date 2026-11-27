import { activityAgo } from "./chat-row.ts";
import type { ChatSearchHit, ChatSearchResult } from "./message-search.mjs";

export type MessageScope = "here" | "all";
export type MessageFilters = { scope: MessageScope; archived: boolean };

export const DEFAULT_MESSAGE_FILTERS: MessageFilters = { scope: "all", archived: false };

export const MESSAGE_SEARCH_COPY = {
  here: "This Project",
  hereLink: "This Link",
  all: "All Projects",
  archived: "Include archived",
  archivedBadge: "Archived",
  placeholder: "Search messages…",
  tooShort: "Type two or more letters to search messages.",
  none: (query: string) => `No messages match “${query}”`,
  enter: (query: string) => (query.trim() ? `Search messages for “${query.trim()}”` : "Search messages"),
} as const;

export const ARCHIVED_CHAT_NOTE = "This Chat is archived. Restore it to send a message.";

export function readMessageFilters(raw: unknown): MessageFilters {
  const value = raw && typeof raw === "object" ? (raw as Partial<MessageFilters>) : {};
  return {
    scope: value.scope === "here" || value.scope === "all" ? value.scope : DEFAULT_MESSAGE_FILTERS.scope,
    archived: value.archived === true,
  };
}

/** "Chat title · Project · 3d": the Project only when the search covered several, the age when the Chat has one. */
export function hitDetail(hit: ChatSearchHit, { now, withProject }: { now: number; withProject: boolean }): string {
  return [hit.chat.title, withProject ? hit.projectName : "", hit.chat.lastAt ? activityAgo(hit.chat.lastAt, now) : ""].filter(Boolean).join(" · ");
}

/** One line per Project the search couldn't read, prefixed with its computer when results span several. */
export function failedLines(result: Pick<ChatSearchResult, "failed">, computer?: string): string[] {
  return result.failed.map((item) => `Couldn't search ${computer ? `${computer} › ` : ""}${item.projectName}: ${item.error}`);
}
