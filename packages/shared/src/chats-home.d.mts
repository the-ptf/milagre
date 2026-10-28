export type ChatsHome = { path: string; exists: boolean };

export type ProjectKind = "chats";

export function isChatsHomeProject(project: { kind?: string } | null | undefined): boolean;

export const CHATS_GROUP_KEY: string;
export const NO_PROJECT_LABEL: string;
export const CHATS_GROUP_LABEL: string;
export const ALL_CHATS_LABEL: string;
export const CHATS_ACCOUNT_LABEL: string;
