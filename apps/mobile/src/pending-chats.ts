import type { MobilePendingChat } from "./session";

/**
 * Who a pending send belongs to: the open Chat, or one New Chat screen. Every New Chat in a Worktree shares its
 * `new:<worktree>` composer, so the screen's draft id tells them apart: a New Chat opened while another is still
 * sending starts empty instead of showing (and then adopting) that one.
 */
export function pendingOrigin(projectPath: string | undefined, id: string | undefined, worktreeId: string | undefined, draft: string) {
  return `${projectPath}#${id ?? `new:${worktreeId}@${draft}`}`;
}

/** The pending send a Chat screen shows: the one it sent, or one bound for the Chat it shows. */
export function pendingOnScreen(
  pendingChats: Record<string, MobilePendingChat>,
  screen: { hostId?: string; projectPath?: string; origin: string; id?: string },
) {
  return Object.values(pendingChats).find(
    (item) =>
      item.hostId === screen.hostId &&
      item.projectPath === screen.projectPath &&
      (item.originChatId === screen.origin || (!!screen.id && item.preview.targetSessionId === Number(screen.id))),
  );
}
