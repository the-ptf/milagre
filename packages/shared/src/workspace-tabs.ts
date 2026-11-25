export type WorkspaceTab =
  | { kind: "chat"; chatId: number }
  | { kind: "browser"; chatId: number; pageId: string }
  | { kind: "designs"; chatId: number; page: string }
  | { kind: "terminal"; chatId: number; terminalId: string }
  | { kind: "diff" }
  | { kind: "pr"; number: number };

export type OpenTab = WorkspaceTab & { unread?: boolean; beside?: boolean };

/** The Workspace tabs one Worktree has open on this device, in the user's order, and the one in front. */
export interface TabSet {
  tabs: OpenTab[];
  active: string | null;
}

export const EMPTY_TABS: TabSet = { tabs: [], active: null };

export const WORKSPACE_TABS_LABEL = "Workspace tabs";
export const WORKSPACE_TABS_DESCRIPTION =
  "Open a Worktree's Chats and Subchats as tabs: in the top bar on a computer and an iPad, in the right panel on a phone.";
export const MAIN_CHAT_CLOSE_TITLE = "Close the main Chat?";
export const mainChatCloseMessage = (title: string) =>
  `“${title}” started this Worktree. Closing its tab keeps the Chat in the sidebar, where you can open it again.`;

export function tabId(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case "chat":
      return `chat:${tab.chatId}`;
    case "browser":
      return `browser:${tab.chatId}:${tab.pageId}`;
    case "designs":
      return `designs:${tab.chatId}:${tab.page}`;
    case "terminal":
      return `terminal:${tab.chatId}:${tab.terminalId}`;
    case "diff":
      return "diff";
    case "pr":
      return `pr:${tab.number}`;
  }
}

/**
 * The tab set a Chat belongs to: its Worktree's, shared by every Chat in it, or the Chat's own when it has no
 * Worktree (a Chat in the Project folder or with no Project).
 */
export function workspaceKey(projectPath: string, worktreeId: number | string | null | undefined, chatId: number): string {
  return worktreeId === null || worktreeId === undefined || worktreeId === "" ? `${projectPath}#chat:${chatId}` : `${projectPath}#wt:${worktreeId}`;
}

/** The Worktree's main Chat: its oldest Chat that is no one's Subchat, the one closing a tab of asks first. */
export function mainChatId(sessions: Iterable<{ id: number; parent?: number; archived?: boolean }>): number | undefined {
  let main: number | undefined;
  for (const session of sessions) if (!session.archived && session.parent === undefined && (main === undefined || session.id < main)) main = session.id;
  return main;
}

export function chatOf(tab: WorkspaceTab): number | undefined {
  return "chatId" in tab ? tab.chatId : undefined;
}

/**
 * Opens `tab`, or brings it forward when it is already open. A tab opened without focus (an agent opening a page)
 * lands unread; `after` places a new tab right after another one, such as a Subchat after its parent.
 */
export function openTab(set: TabSet, tab: WorkspaceTab, options: { focus?: boolean; after?: string; unread?: boolean } = {}): TabSet {
  const focus = options.focus ?? true;
  const id = tabId(tab);
  if (set.tabs.some((open) => tabId(open) === id)) return focus ? selectTab(set, id) : set;
  const opened: OpenTab = focus || options.unread === false ? { ...tab } : { ...tab, unread: true };
  const anchor = options.after === undefined ? -1 : set.tabs.findIndex((open) => tabId(open) === options.after);
  const tabs = anchor < 0 ? [...set.tabs, opened] : [...set.tabs.slice(0, anchor + 1), opened, ...set.tabs.slice(anchor + 1)];
  return { tabs, active: focus || set.active === null ? id : set.active };
}

export function selectTab(set: TabSet, id: string): TabSet {
  const at = set.tabs.findIndex((tab) => tabId(tab) === id);
  if (at < 0) return set;
  const tab = set.tabs[at]!;
  if (set.active === id && !tab.unread) return set;
  const tabs = tab.unread ? set.tabs.map((open, index) => (index === at ? withoutUnread(open) : open)) : set.tabs;
  return { tabs, active: id };
}

/** Closes a tab. Closing the one in front brings forward its left neighbour, or the new first tab. */
export function closeTab(set: TabSet, id: string): TabSet {
  const at = set.tabs.findIndex((tab) => tabId(tab) === id);
  if (at < 0) return set;
  const tabs = set.tabs.filter((_, index) => index !== at);
  if (set.active !== id) return { tabs, active: set.active };
  const next = tabs[Math.max(0, at - 1)];
  return next ? selectTab({ tabs, active: null }, tabId(next)) : { tabs, active: null };
}

/** Shows a page tab beside its Chat, or on its own again: a choice the tab keeps until it changes. */
export function setBeside(set: TabSet, id: string, beside: boolean): TabSet {
  const at = set.tabs.findIndex((tab) => tabId(tab) === id);
  if (at < 0 || Boolean(set.tabs[at]!.beside) === beside) return set;
  return { ...set, tabs: set.tabs.map((tab, index) => (index === at ? (beside ? { ...tab, beside: true } : withoutBeside(tab)) : tab)) };
}

export function closeOtherTabs(set: TabSet, id: string): TabSet {
  const keep = set.tabs.find((tab) => tabId(tab) === id);
  return keep ? { tabs: [withoutUnread(keep)], active: id } : set;
}

/** Moves a tab to `index` among the others (0 first), as a drag in the strip or the list drops it. */
export function moveTab(set: TabSet, id: string, index: number): TabSet {
  const moved = set.tabs.find((tab) => tabId(tab) === id);
  if (!moved) return set;
  const rest = set.tabs.filter((tab) => tab !== moved);
  const at = Math.max(0, Math.min(rest.length, Math.round(index)));
  const tabs = [...rest.slice(0, at), moved, ...rest.slice(at)];
  return tabs.every((tab, position) => tab === set.tabs[position]) ? set : { tabs, active: set.active };
}

/**
 * Where a new Subchat's tab goes: after its parent's tab and the parent's Subchat tabs that already follow it, so a
 * family opens together. Undefined when the parent has no tab, and the Subchat goes last.
 */
export function subchatAnchor(set: TabSet, parentChatId: number, parentOf: (chatId: number) => number | undefined): string | undefined {
  const start = set.tabs.findIndex((tab) => tab.kind === "chat" && tab.chatId === parentChatId);
  if (start < 0) return undefined;
  let end = start;
  while (end + 1 < set.tabs.length && descends(set.tabs[end + 1]!, parentChatId, parentOf)) end += 1;
  return tabId(set.tabs[end]!);
}

/** Drops the tabs of Chats that are gone (archived, deleted or moved to another Worktree), with whatever they own. */
export function keepListedChats(set: TabSet, listed: (chatId: number) => boolean): TabSet {
  const tabs = set.tabs.filter((tab) => {
    const chat = chatOf(tab);
    return chat === undefined || listed(chat);
  });
  if (tabs.length === set.tabs.length) return set;
  const active = set.active !== null && tabs.some((tab) => tabId(tab) === set.active) ? set.active : null;
  if (active !== null || tabs.length === 0) return { tabs, active };
  const before = set.tabs.findIndex((tab) => tabId(tab) === set.active);
  const fallback = set.tabs.slice(0, Math.max(0, before)).findLast((tab) => tabs.includes(tab)) ?? tabs[0]!;
  return { tabs, active: tabId(fallback) };
}

/** The shortcut digit for a tab: ⌘1 to ⌘8 for the first eight, ⌘9 for the last, as in a browser. */
export function tabShortcutDigit(set: TabSet, id: string): number | undefined {
  const at = set.tabs.findIndex((tab) => tabId(tab) === id);
  if (at < 0) return undefined;
  if (at === set.tabs.length - 1) return at < 8 ? at + 1 : 9;
  return at < 8 ? at + 1 : undefined;
}

export function tabForDigit(set: TabSet, digit: number): OpenTab | undefined {
  if (digit === 9) return set.tabs[set.tabs.length - 1];
  return digit >= 1 && digit <= 8 ? set.tabs[digit - 1] : undefined;
}

export type StoredTabSets = Record<string, TabSet & { at: number }>;

/** The tab sets a device keeps, most recently used first, at most `limit` of them. */
export function pruneTabSets(sets: StoredTabSets, limit: number): StoredTabSets {
  const kept = Object.entries(sets)
    .filter(([, set]) => set.tabs.length > 0)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, limit);
  return Object.fromEntries(kept);
}

/** Reads stored tab sets, dropping anything malformed so a damaged entry can't break the strip. */
export function parseTabSets(raw: string | null | undefined): StoredTabSets {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sets: StoredTabSets = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { tabs, active, at } = entry as { tabs?: unknown; active?: unknown; at?: unknown };
    if (!Array.isArray(tabs)) continue;
    const valid = tabs.filter(isTab);
    const ids = new Set(valid.map(tabId));
    sets[key] = {
      tabs: valid,
      active: typeof active === "string" && ids.has(active) ? active : valid[0] ? tabId(valid[0]) : null,
      at: typeof at === "number" && Number.isFinite(at) ? at : 0,
    };
  }
  return sets;
}

function descends(tab: OpenTab, ancestor: number, parentOf: (chatId: number) => number | undefined): boolean {
  if (tab.kind !== "chat") return false;
  const seen = new Set<number>([tab.chatId]);
  for (let at = parentOf(tab.chatId); at !== undefined && !seen.has(at); at = parentOf(at)) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

function withoutBeside(tab: OpenTab): OpenTab {
  const { beside: _beside, ...rest } = tab;
  return rest as OpenTab;
}

function withoutUnread(tab: OpenTab): OpenTab {
  if (!tab.unread) return tab;
  const { unread: _unread, ...rest } = tab;
  return rest as OpenTab;
}

function isTab(value: unknown): value is OpenTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  const chat = typeof tab.chatId === "number" && Number.isInteger(tab.chatId);
  switch (tab.kind) {
    case "chat":
      return chat;
    case "browser":
      return chat && typeof tab.pageId === "string";
    case "designs":
      return chat && typeof tab.page === "string";
    case "terminal":
      return chat && typeof tab.terminalId === "string";
    case "diff":
      return true;
    case "pr":
      return typeof tab.number === "number" && Number.isInteger(tab.number);
    default:
      return false;
  }
}
