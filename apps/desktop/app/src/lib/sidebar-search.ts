import type { ChatOrder } from "./chat-list.ts";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import { mergeScopeChats, type FlatChat } from "./sidebar-scopes";

type SearchScope = { key: string; name: string; rows: readonly SidebarRecent[]; offline?: boolean };

export function sidebarNeedle(query: string) {
  return query.trim().toLowerCase();
}

/** Every Chat whose title, branch or Project name holds the needle, pinned ones first, Subchats flattened so a folded family can't hide a match. */
export function searchSidebarChats(needle: string, scopes: readonly SearchScope[], order: ChatOrder): (FlatChat & { offline?: boolean })[] {
  const has = (text: string | undefined) => !!text && text.toLowerCase().includes(needle);
  const offline = new Set(scopes.filter((scope) => scope.offline).map((scope) => scope.key));
  const matched = scopes.map(({ key, name, rows }) => ({
    key,
    rows: (has(name) ? rows : rows.filter((row) => has(row.label) || has(row.details?.branch))).map((row) =>
      row.parent === undefined ? row : { ...row, parent: undefined },
    ),
  }));
  return mergeScopeChats(matched, order).map((chat) => (offline.has(chat.scopeKey) ? { ...chat, offline: true } : chat));
}
