import type { ComponentProps } from "react";
import { CommandPalette } from "../components/lazy-views";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import type { Command } from "../lib/commands";
import { messageCommands, messageCommandsFrom, messageSearchSource } from "../lib/message-commands";
import { bridgeForKey } from "../lib/computer-bridge";

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
  scope,
  initialMode,
  onStartChat,
  onClose,
  onError,
}: {
  commands: Command[];
  chats: SidebarRecent[];
  messages: Parameters<typeof messageCommands>[0] | null;
  searchChats: ((query: string) => Promise<Parameters<typeof messageCommandsFrom>[0]>) | null;
  /** Opens a message's Chat with the find bar on `term`, switching to its Project first when `projectPath` names another. */
  openMessage: (sessionId: number, term: string, projectPath?: string) => void;
  /** The open Project: message mode searches it, or every Project on its computer. */
  scope: string;
  initialMode: PaletteProps["initialMode"];
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
      messageSearch={messageSearchSource(bridgeForKey(scope), scope, openMessage)}
      initialMode={initialMode}
      onStartChat={onStartChat}
      onClose={onClose}
      onError={onError}
    />
  );
}
