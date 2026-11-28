import { unqualifyKey } from "./chat-scopes.mjs";

export type WorkspaceTab =
  | { kind: "new"; id: string }
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
  "Open a Worktree's or a Link's Chats and Subchats as tabs: in the top bar on a computer and an iPad, in the right panel on a phone. The sidebar keeps one row per Worktree or Link.";
export const NEW_TAB_LABEL = "New tab";
export const MAIN_CHAT_CLOSE_TITLE = "Close the main Chat?";
/** Where a tab set lives: a Worktree's Chats, or a Link's, whose Chats span several Projects. */
export type TabPlace = "worktree" | "link";
export const newChatTabLabel = (place: TabPlace) => (place === "link" ? "New Chat in this Link" : "New Chat in this Worktree");
export const mainChatCloseMessage = (title: string, place: TabPlace = "worktree") =>
  `“${title}” ${place === "link" ? "is this Link's first Chat" : "started this Worktree"}. Closing its tab keeps the Chat in the sidebar, where you can open it again.`;
export const RUNNING_CHAT_CLOSE_TITLE = "Close a running Chat?";
export const runningChatCloseMessage = (title: string) =>
  `“${title}” is still working. Closing its tab stops it and moves it to Done, where Reopen brings it back.`;
export const TAB_DONE_TEXT = "Moved to Done";

let newTabs = 0;
/** A blank New tab, the launcher the strip's + opens: each one its own tab until something takes its place. */
export const newTab = (): WorkspaceTab => ({ kind: "new", id: `${Date.now().toString(36)}-${(newTabs += 1)}` });

export function tabId(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case "new":
      return `new:${tab.id}`;
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

/**
 * The Worktree whose tab set a Chat joins, or null for a Chat in the Project folder: the folder is the Project's, not one
 * task's, so each Chat there keeps a tab set and a sidebar row of its own.
 */
export function tabWorktree(projectPath: string, worktree: { id: number; path: string } | undefined): number | null {
  return worktree && worktree.path !== unqualifyKey(projectPath) ? worktree.id : null;
}

type MainCandidate = { id: number; parent?: number; archived?: boolean; done_at?: number };

/**
 * The main Chat of a tab set: its oldest live Chat that is not a Subchat of another Chat in it. It stands for the Worktree
 * or Link in the sidebar, and closing its tab asks first.
 */
export function mainChatId(sessions: Iterable<MainCandidate>): number | undefined {
  const live = [...sessions].filter((session) => !session.archived && !session.done_at);
  const ids = new Set(live.map((session) => session.id));
  let main: number | undefined;
  for (const session of live) if ((session.parent === undefined || !ids.has(session.parent)) && (main === undefined || session.id < main)) main = session.id;
  return main;
}

/**
 * What closing a Chat's tab does. The main Chat's asks first and keeps the Chat, which still has its sidebar row. A
 * Subchat's only closes the tab: its parent's Subchats list still reaches it. Any other Chat lives only as a tab, so its
 * tab closes into Done (asking first while it works), where Reopen brings it back.
 */
export function chatCloseAction(chatId: number, sessions: Iterable<MainCandidate>, running: boolean): "confirm-main" | "close" | "done" | "confirm-done" {
  const list = [...sessions];
  if (chatId === mainChatId(list)) return "confirm-main";
  const parent = list.find((session) => session.id === chatId)?.parent;
  if (parent !== undefined && list.some((session) => session.id === parent && !session.archived)) return "close";
  return running ? "confirm-done" : "done";
}

/**
 * Gives a tab to each live Chat that has no other way in: neither the main Chat (its row in the Chat list) nor a Subchat
 * of a Chat in the set (its parent's Subchats list). Closing such a tab moves the Chat to Done, so one reopened from Done
 * comes back here. `members` are the set's Chats; `listed` leaves out Chats no list shows (hidden Run Chats).
 */
export function withLoneChatTabs(set: TabSet, members: readonly MainCandidate[], listed: (chatId: number) => boolean = () => true): TabSet {
  const live = members.filter((member) => !member.archived && !member.done_at);
  const ids = new Set(live.map((member) => member.id));
  const main = mainChatId(live);
  let next = set;
  for (const member of live)
    if (member.id !== main && listed(member.id) && (member.parent === undefined || !ids.has(member.parent)))
      next = openTab(next, { kind: "chat", chatId: member.id }, { focus: false, unread: false });
  return next;
}

const MARK_ORDER = ["question", "waiting", "delegated", "running", "interrupted", "background", "failed", "unread", "idle"];

/** The most pressing of several Chat marks, as a Worktree's row shows for all its Chats. */
export function strongestMark<M extends string>(marks: Iterable<M | undefined>): M | undefined {
  let best: M | undefined;
  for (const mark of marks) {
    if (mark === undefined) continue;
    const rank = MARK_ORDER.indexOf(mark);
    if (best === undefined || (rank >= 0 && (MARK_ORDER.indexOf(best) < 0 || rank < MARK_ORDER.indexOf(best)))) best = mark;
  }
  return best;
}

/** How the fold reads a sidebar item: its Chat, its parent, and the tab set it lives in (none: it keeps its own row). */
export type TabbedItem = { id: number; parent?: number; group: string | undefined };

/**
 * With Workspace tabs on, a Worktree or a Link is one sidebar row: its main Chat (mainChatId's rule) stands for it and
 * `merge` gives it the status of the Chats that live only as its tabs. Items `read` returns null for (Chats set aside in
 * Done or Snoozed, or with a tab set of their own) pass through, so each keeps its row.
 */
export function foldTabbedChats<T>(items: readonly T[], read: (item: T) => TabbedItem | null, merge: (main: T, tabs: T[]) => T): T[] {
  const groups = new Map<string, { item: T; at: TabbedItem }[]>();
  for (const item of items) {
    const at = read(item);
    if (!at?.group) continue;
    const members = groups.get(at.group);
    if (members) members.push({ item, at });
    else groups.set(at.group, [{ item, at }]);
  }
  const folded = new Map<T, T | null>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const main = mainChatId(members.map(({ at }) => at)) ?? Math.min(...members.map(({ at }) => at.id));
    const head = members.find(({ at }) => at.id === main)!;
    const tabs = members.filter((member) => member !== head).map(({ item }) => item);
    folded.set(head.item, merge(head.item, tabs));
    for (const tab of tabs) folded.set(tab, null);
  }
  if (!folded.size) return items as T[];
  const rows: T[] = [];
  for (const item of items) {
    const shown = folded.has(item) ? folded.get(item) : item;
    if (shown) rows.push(shown);
  }
  return rows;
}

/** A new Chat drafted where no tab is open has nothing to switch to, so the top bar shows no tabs for it. */
export function tabStripShown(set: TabSet, drafting: boolean): boolean {
  return !drafting || set.tabs.length > 0;
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

/** Closes every tab but `id`, and those `stays` keeps (Chats that live only as tabs, whose close would set them aside). */
export function closeOtherTabs(set: TabSet, id: string, stays: (tab: OpenTab) => boolean = () => false): TabSet {
  const keep = set.tabs.find((tab) => tabId(tab) === id);
  if (!keep) return set;
  return { tabs: set.tabs.filter((tab) => tab === keep || stays(tab)).map((tab) => (tab === keep ? withoutUnread(tab) : tab)), active: id };
}

/** Puts `tab` where tab `id` was and brings it forward, as a New tab turns into what was picked on it. */
export function replaceTab(set: TabSet, id: string, tab: WorkspaceTab): TabSet {
  const at = set.tabs.findIndex((open) => tabId(open) === id);
  if (at < 0) return openTab(set, tab);
  const without = { tabs: set.tabs.filter((_, index) => index !== at), active: set.active === id ? null : set.active };
  if (without.tabs.some((open) => tabId(open) === tabId(tab))) return selectTab({ ...without, active: null }, tabId(tab));
  return { tabs: [...without.tabs.slice(0, at), { ...tab }, ...without.tabs.slice(at)], active: tabId(tab) };
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
    case "new":
      return typeof tab.id === "string";
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
