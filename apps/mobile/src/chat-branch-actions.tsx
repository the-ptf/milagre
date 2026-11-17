import type { Dispatch, SetStateAction } from "react";
import { composerQuote, type ComposerQuote } from "@milagre/shared/prompt-parts";
import type { AgentSession, BtwRequest } from "@milagre/shared/model";
import type { Client } from "./client";
import type { useBtw } from "./use-btw";
import { BtwOverlay } from "./btw-overlay";

export function messageForkAction({
  client,
  projectPath,
  chat,
  offline,
  action,
  refresh,
  open,
}: {
  client: Client;
  projectPath: string;
  chat: AgentSession | null | undefined;
  offline: boolean;
  action: (work: () => Promise<unknown>) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  open: (key: string) => void;
}) {
  if (!chat || chat.readOnlyReason || chat.archived || offline) return undefined;
  return (messageId: number) =>
    void action(async () => {
      const result = await client.call<{ sessionId: number }>("chat:fork", [projectPath, chat.id, { messageId }]);
      await refresh();
      open(`${projectPath}#${result.sessionId}`);
    });
}

export function BtwDock({
  btw,
  chatId,
  setQuotes,
  focus,
}: {
  btw: ReturnType<typeof useBtw>;
  chatId: string;
  setQuotes: Dispatch<SetStateAction<Record<string, ComposerQuote[]>>>;
  focus: () => void;
}) {
  return btw.state ? (
    <BtwOverlay
      btw={btw.state}
      onDismiss={btw.dismiss}
      onStop={btw.stop}
      onBringBack={(text) => {
        const quote = composerQuote(text, "Side question");
        if (quote) setQuotes((held) => ({ ...held, [chatId]: [...(held[chatId] || []), quote] }));
        focus();
      }}
    />
  ) : null;
}

export type SideQuestionTurn = Omit<BtwRequest, "chatId" | "prompt">;
