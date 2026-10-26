import { createContext, useContext } from "react";
import type { MentionChat } from "@milagre/shared/prompt-mentions";

export type ChatMentionScope = { chats: readonly MentionChat[]; project: string; currentId?: number; onOpen?: (key: string) => void };
export const EMPTY_CHAT_MENTIONS: ChatMentionScope = { chats: [], project: "" };
export const ChatMentionsContext = createContext<ChatMentionScope>(EMPTY_CHAT_MENTIONS);
export const useChatMentions = () => useContext(ChatMentionsContext);
