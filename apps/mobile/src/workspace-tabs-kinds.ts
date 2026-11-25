/** On a phone a Chat's Browser and Terminal tabs stand for all its pages and Terminals: their sheets list them. */
export const PHONE_PAGES = "pages";
export const PHONE_TERMINALS = "terminals";

/** A Link's Chats share one tab set: phone snapshots give each Link Chat a Worktree of its own, so tabs key the Link instead. */
export const LINK_TABS = "link";
export type TabScope = number | typeof LINK_TABS;
export const inScope = (session: { worktree_id?: number }, scope: TabScope) => scope === LINK_TABS || session.worktree_id === scope;

/** The tab set a Chat screen shows: its Link's, or its Worktree's (from the open Chat, or the New Chat screen's Worktree). */
type ScopedProject = { path: string; link?: unknown; state: { sessions: Record<string, { worktree_id?: number }> } };

export function tabScope(project: ScopedProject | undefined, chatId: number | undefined, worktreeParam: string | undefined): TabScope | undefined {
  if (!project) return undefined;
  if (project.link) return LINK_TABS;
  const worktree = chatId === undefined ? Number(worktreeParam) : project.state.sessions[chatId]?.worktree_id;
  return Number.isFinite(worktree) ? Number(worktree) : undefined;
}

/** Where a Chat screen's tabs live on this host, or null when it has no tab set (no Project, or a Chat outside a Worktree). */
export function tabsAt(hostId: string, project: ScopedProject | undefined, chatId: number | undefined, worktreeParam: string | undefined) {
  const scope = tabScope(project, chatId, worktreeParam);
  return project && scope !== undefined ? { hostId, projectPath: project.path, worktreeId: scope } : null;
}
