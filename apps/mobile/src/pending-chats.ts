import type { MobilePendingChat } from "./session";

export function pendingOrigin(projectPath: string | undefined, id: string | undefined, worktreeId: string | undefined, draft: string) {
  return `${projectPath}#${id ?? `new:${worktreeId}@${draft}`}`;
}

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
