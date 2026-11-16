import type { RestoredChats } from "../model";

export function restoredChatsNotice(restored: RestoredChats[] | undefined): string | null {
  if (!restored?.length) return null;
  const count = restored.reduce((sum, item) => sum + item.count, 0);
  const names = restored.map((item) => item.worktree);
  const where = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Brought back ${count} ${count === 1 ? "chat" : "chats"} saved in ${where}.`;
}
