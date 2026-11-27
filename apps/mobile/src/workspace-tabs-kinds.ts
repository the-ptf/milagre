import { isSnoozed } from "@milagre/shared/snooze";
import { chatOf, foldTabbedChats, strongestMark, tabId, tabWorktree, workspaceKey, type TabSet } from "@milagre/shared/workspace-tabs";

/** On a phone a Chat's Browser and Terminal tabs stand for all its pages and Terminals: their sheets list them. */
export const PHONE_PAGES = "pages";
export const PHONE_TERMINALS = "terminals";

/** A Link's Chats share one tab set: phone snapshots give each Link Chat a Worktree of its own, so tabs key the Link instead. */
export const LINK_TABS = "link";
/** A Chat in the Project folder keeps a tab set of its own, as it keeps a row of its own in the Chat list. */
type ChatTabs = `chat:${number}`;
export type TabScope = number | typeof LINK_TABS | ChatTabs;
const chatTabs = (chatId: number): ChatTabs => `chat:${chatId}`;
const ownerOf = (scope: TabScope) => (typeof scope === "string" && scope !== LINK_TABS ? Number(scope.slice("chat:".length)) : undefined);

export const inScope = (session: { id: number; worktree_id?: number }, scope: TabScope) =>
  scope === LINK_TABS || (typeof scope === "number" ? session.worktree_id === scope : session.id === ownerOf(scope));

/** The stored tab set's key, without the host. */
export function scopeKey(projectPath: string, scope: TabScope): string {
  const owner = ownerOf(scope);
  return owner === undefined ? workspaceKey(projectPath, scope, 0) : workspaceKey(projectPath, null, owner);
}

/** The Worktree a New Chat started from a tab set goes to. */
export function scopeWorktree(scope: TabScope, sessions: Record<string, { worktree_id?: number }> | undefined): number | undefined {
  if (scope === LINK_TABS) return undefined;
  const owner = ownerOf(scope);
  return owner === undefined ? (scope as number) : sessions?.[owner]?.worktree_id;
}

type ScopedProject = {
  path: string;
  link?: unknown;
  state: { sessions: Record<string, { worktree_id?: number }>; worktrees?: Record<string, { id: number; path: string }> };
};

/**
 * The tab set a Chat screen shows: its Link's, its Worktree's (from the open Chat, or the New Chat screen's Worktree), or
 * the Chat's own in the Project folder. A New Chat in the Project folder has none until it is sent.
 */
export function tabScope(project: ScopedProject | undefined, chatId: number | undefined, worktreeParam: string | undefined): TabScope | undefined {
  if (!project) return undefined;
  if (project.link) return LINK_TABS;
  const worktree = chatId === undefined ? Number(worktreeParam || NaN) : project.state.sessions[chatId]?.worktree_id;
  if (worktree === undefined || !Number.isFinite(worktree)) return undefined;
  const known = project.state.worktrees?.[worktree];
  if (!known || tabWorktree(project.path, known) !== null) return worktree;
  return chatId === undefined ? undefined : chatTabs(chatId);
}

/** Where a Chat screen's tabs live on this host, or null when it has no tab set (no Project, or a New Chat in the Project folder). */
export function tabsAt(hostId: string, project: ScopedProject | undefined, chatId: number | undefined, worktreeParam: string | undefined) {
  const scope = tabScope(project, chatId, worktreeParam);
  return project && scope !== undefined ? { hostId, projectPath: project.path, worktreeId: scope } : null;
}

/** The Chat a Worktree's row opens: the one whose tab (or page tab) was in front, when it is still one of `members`. */
export function frontChat(set: TabSet, members: readonly number[]): number | undefined {
  const front = set.tabs.find((tab) => tabId(tab) === set.active);
  const chat = front && chatOf(front);
  return chat !== undefined && members.includes(chat) ? chat : undefined;
}

/** The Chat a Worktree's row opens on this device: the one in front of its tabs (`read` gives a stored tab set), else its main Chat. */
export function rowChat(read: (key: string) => TabSet, hostId: string, projectPath: string, main: number, folded: FoldedTabs | undefined): number {
  if (!folded) return main;
  return frontChat(read(`${hostId}|${scopeKey(projectPath, folded.scope)}`), [main, ...folded.chats]) ?? main;
}

/** The Chats a Worktree's or a Link's row stands for besides its main Chat, and the tab set they live in. */
export type FoldedTabs = { scope: TabScope; chats: number[] };

type Foldable = {
  chat: { id: number; parent?: number; worktree_id: number; done_at?: number; snoozed_until?: number; archived?: boolean };
  mark: string;
  background: number;
  pending?: unknown;
  folded?: FoldedTabs;
};

type Place = { path: string; link: boolean; worktrees: Record<string, { id: number; path: string }> };

/**
 * With Workspace tabs on, a Worktree Milagre made or a Link is one row in the Chat list: its main Chat, carrying the most
 * pressing mark of all its Chats. Chats in the Project folder, Done or Snoozed Chats and Chats still being sent keep rows
 * of their own.
 */
export function foldTabRows<T extends Foldable>(items: readonly T[], place: Place, now = Date.now()): T[] {
  const scopeOf = (item: T): TabScope | null => {
    if (item.pending || item.chat.done_at || isSnoozed(item.chat, now)) return null;
    return place.link ? LINK_TABS : tabWorktree(place.path, place.worktrees[item.chat.worktree_id]);
  };
  return foldTabbedChats(
    items,
    (item) => {
      const scope = scopeOf(item);
      return scope === null ? null : { id: item.chat.id, parent: item.chat.parent, group: String(scope) };
    },
    (main, tabs) => ({
      ...main,
      mark: strongestMark<T["mark"]>([main.mark, ...tabs.map((tab) => tab.mark)]) ?? main.mark,
      background: tabs.reduce((sum, tab) => sum + tab.background, main.background),
      folded: { scope: scopeOf(main)!, chats: tabs.map((tab) => tab.chat.id) },
    }),
  );
}
