// The Chats home is the one internal Git repository each computer keeps so Chats without a Project have a Worktree
// to run in. It is a Project like any other to the daemon, so screens tell it apart by `kind`, never by its path.

export type ChatsHome = { path: string; exists: boolean };

export type ProjectKind = "chats";

export function isChatsHomeProject(project: { kind?: string } | null | undefined): boolean {
  return project?.kind === "chats";
}

/** The sidebar and picker group for these Chats. Not a path, so it can't collide with a Project's folder. */
export const CHATS_GROUP_KEY = "milagre-chats";

export const NO_PROJECT_LABEL = "No project";
export const CHATS_GROUP_LABEL = "Chats";
export const ALL_CHATS_LABEL = "All chats";
export const CHATS_ACCOUNT_LABEL = "Chats without a Project";
