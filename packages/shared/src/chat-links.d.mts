/** One end of a canvas Link: a whole Project, or one of its Worktrees. */
export type LinkEnd = { project_id: string; worktree_path?: string };
export type CanvasLink = {
  id: string;
  a: LinkEnd;
  b: LinkEnd;
  created_at: string;
  sharedChat?: { linkId: string; sessionId: number };
  chatModeTransition?: "shared" | "separate";
};
export const CHAT_MODE_COPY: { shared: string; separate: string; shareDetail: string; separateDetail: string };
/** A Chat's Worktree as a Link sees it. */
export type LinkWorktree = { project_id: string; worktree_path: string };
/** "Só estas worktrees" (Worktree↔Worktree) or "Os projetos inteiros" (Project↔Project). */
export type LinkScope = "worktrees" | "projects";

export function endpointCovers(endpoint: LinkEnd | undefined, worktree: LinkWorktree | undefined): boolean;
export function linkBetween<L extends CanvasLink>(links: readonly L[], a: LinkWorktree, b: LinkWorktree): L | undefined;
export function linkedEnds<L extends CanvasLink>(links: readonly L[], worktree: LinkWorktree): Array<{ link: L; other: LinkEnd }>;
export function canLinkProjects(a: { project_id: string } | undefined, b: { project_id: string } | undefined): boolean;
export function linkEndpoints(a: LinkWorktree, b: LinkWorktree, scope?: LinkScope): [LinkEnd, LinkEnd];
export function findLink<L extends CanvasLink>(links: readonly L[], a: LinkEnd, b: LinkEnd): L | undefined;
export type LinkProblem = "same-worktree" | "linked";
export function linkProblem(links: readonly CanvasLink[], source: LinkWorktree, target: LinkWorktree): LinkProblem | null;
export const LINK_PROBLEM_LABEL: Readonly<Record<LinkProblem, string>>;
export function linkedEndLabel(end: LinkEnd, names?: { project?: string; branch?: string }): string;
export function linkAskMessage(
  text: string,
  target: { label: string; chatRef: string; worktreePath: string; projectName?: string; branch?: string },
): { body: string; prompt: string };

export function sharedChatEligibility(link: CanvasLink | undefined, projects: readonly { id: string; path: string }[]): string | null;
export function chatModeLabel(link: CanvasLink): string;
export function chatModeActions(link: CanvasLink, projects: readonly { id: string; path: string }[]): { mode: "shared" | "separate"; label: string }[];
export function chatModeEndLabel(end: LinkEnd, projects: readonly { id: string; name: string }[], branch?: string): string;
