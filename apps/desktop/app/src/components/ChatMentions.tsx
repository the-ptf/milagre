import { createContext, useContext, useMemo } from "react";
import type { MentionChat, MentionComputer } from "@milagre/shared/prompt-mentions";
import { useComputers } from "../lib/computers";

export type ChatMentionScope = { chats: readonly MentionChat[]; project: string; currentId?: number; onOpen?: (key: string) => void };
export const EMPTY_CHAT_MENTIONS: ChatMentionScope = { chats: [], project: "" };
export const ChatMentionsContext = createContext<ChatMentionScope>(EMPTY_CHAT_MENTIONS);
export const useChatMentions = () => useContext(ChatMentionsContext);

/** The computers an `@` can name: this Mac, then its paired computers (none while Other computers is off). */
export function useMentionComputers(): readonly MentionComputer[] {
  const { thisMac, computers } = useComputers();
  return useMemo(
    () => [
      ...(thisMac ? [{ id: "local", name: thisMac, online: true, self: true }] : []),
      ...computers.map((computer) => ({ id: computer.id, name: computer.name, online: computer.state === "online" })),
    ],
    [thisMac, computers],
  );
}
