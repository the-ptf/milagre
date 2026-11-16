import { isChatsHomeProject } from "@milagre/shared/chats-home";

export function panelWorktree(project: { kind?: string } | null | undefined, worktreeId: number | undefined): number | undefined {
  return isChatsHomeProject(project) ? undefined : worktreeId;
}
