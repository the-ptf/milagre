import type { ComponentProps } from "react";
import { CommandPalette } from "../components/lazy-views";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import type { Command } from "../lib/commands";
import { messageCommands, messageCommandsFrom } from "../lib/message-commands";

type PaletteProps = ComponentProps<typeof CommandPalette>;

/**
 * The command palette over a Project. A lean host searches the Chats' messages itself (`searchChats`); an older host's
 * state carries every message, searched here.
 */
export function ProjectPalette({
  commands,
  chats,
  messages,
  searchChats,
  openMessage,
  onStartChat,
  onClose,
  onError,
}: {
  commands: Command[];
  chats: SidebarRecent[];
  messages: Parameters<typeof messageCommands>[0] | null;
  searchChats: ((query: string) => Promise<Parameters<typeof messageCommandsFrom>[0]>) | null;
  openMessage: (sessionId: number, term: string) => void;
  onStartChat: PaletteProps["onStartChat"];
  onClose: () => void;
  onError: PaletteProps["onError"];
}) {
  return (
    <CommandPalette
      commands={commands}
      searchMessages={
        messages ? (query) => messageCommands(messages, query, new Map(chats.map((chat) => [Number(chat.id), chat.label])), openMessage) : undefined
      }
      searchMessagesAsync={
        searchChats
          ? async (query) => messageCommandsFrom(await searchChats(query), new Map(chats.map((chat) => [Number(chat.id), chat.label])), openMessage)
          : undefined
      }
      onStartChat={onStartChat}
      onClose={onClose}
      onError={onError}
    />
  );
}
