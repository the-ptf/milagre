import { isChatsHomeProject } from "@milagre/shared/chats-home";

/**
 * The Worktree a Chat's side panels (Changes, its PR) show. A Chat without a Project has no Git to show, as on desktop,
 * so it offers none: the right-edge swipe then has no panel to open.
 */
export function panelWorktree(project: { kind?: string } | null | undefined, worktreeId: number | undefined): number | undefined {
  return isChatsHomeProject(project) ? undefined : worktreeId;
}
