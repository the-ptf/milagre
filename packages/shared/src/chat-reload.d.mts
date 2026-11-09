import type { ChatMessage, ChatReloadContext } from "./model.ts";

export const RELOAD_HINT: string;
export const RELOAD_TEXT: string;
export function isChatReload(message: ChatMessage | null | undefined): message is ChatMessage & { context: ChatReloadContext };
