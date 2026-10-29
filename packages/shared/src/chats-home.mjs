// The Chats home is the one internal Git repository each computer keeps so Chats without a Project have a Worktree
// to run in. It is a Project like any other to the daemon, so screens tell it apart by `kind`, never by its path.
// Plain JavaScript so the daemon (runtime.cjs) loads it without TypeScript type stripping.

export function isChatsHomeProject(project) {
  return project?.kind === "chats";
}

/** The sidebar and picker group for these Chats. Not a path, so it can't collide with a Project's folder. */
export const CHATS_GROUP_KEY = "milagre-chats";

export const NO_PROJECT_LABEL = "No project";
export const CHATS_GROUP_LABEL = "Chats";
export const ALL_CHATS_LABEL = "All chats";
export const CHATS_ACCOUNT_LABEL = "Chats without a Project";
/** Under the Chats home's name in Project Accounts, where a Project says "Project". */
export const CHATS_ACCOUNT_DETAIL = "Every quick chat on this computer";

// A new Chat without a Project, on desktop and phone: its heading, the tray above the composer and the empty composer.
export const JUST_CHAT_HEADING = "Just chat";
export const CHATS_TRAY_LABEL = "Yapping around";
export const CHATS_PLACEHOLDER = "Ask anything";
/** What No project gives a Chat, under its name in the pickers. */
export const NO_PROJECT_FOLDER = "Its own empty folder";
/** The phone's line under "Just chat on <Computer>", which goes back to the Projects. */
export const NO_PROJECT_LINE = `${NO_PROJECT_LABEL} · ${NO_PROJECT_FOLDER.toLowerCase()}`;
