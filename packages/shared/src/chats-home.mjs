export function isChatsHomeProject(project) {
  return project?.kind === "chats";
}

/** The sidebar and picker group for these Chats. Not a path, so it can't collide with a Project's folder. */
export const CHATS_GROUP_KEY = "milagre-chats";

export const NO_PROJECT_LABEL = "No Project";
export const CHATS_GROUP_LABEL = "Chats";
export const ALL_CHATS_LABEL = "All Chats";
export const CHATS_ACCOUNT_LABEL = "Chats without a Project";
export const CHATS_ACCOUNT_DETAIL = "Every quick Chat on this computer";

export const JUST_CHAT_HEADING = "Just chat";
export const CHATS_TRAY_LABEL = "Yapping around";
export const CHATS_PLACEHOLDER = "Ask anything";
export const NO_PROJECT_FOLDER = "Its own empty folder";
export const NO_PROJECT_LINE = `${NO_PROJECT_LABEL} · ${NO_PROJECT_FOLDER.toLowerCase()}`;
