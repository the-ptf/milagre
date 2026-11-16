import type { CheckpointApi } from "@milagre/shared/checkpoints";
import type { Dispatch, SetStateAction } from "react";
import { router } from "expo-router";
import type { AgentSession } from "@milagre/shared/model";
import { STORAGE_COMMAND, STORAGE_COMMAND_HINT } from "@milagre/shared/storage";
import type { SideQuestionTurn } from "./chat-branch-actions";

export const NO_CHECKPOINTS: CheckpointApi = {
  list: async () => [],
  preview: () => Promise.reject(new Error("Connect to the computer to undo changes")),
  restore: () => Promise.reject(new Error("Connect to the computer to undo changes")),
};

export const STORAGE_COMMANDS = [{ name: STORAGE_COMMAND, description: STORAGE_COMMAND_HINT }];
export const CHAT_COMMANDS = [
  { name: "btw", description: "Ask a side question without adding to the Chat" },
  { name: "undo", description: "Undo a task's file changes" },
  ...STORAGE_COMMANDS,
];

export function runComposerCommand({
  text,
  enabled,
  chat,
  offline,
  clear,
  undo,
  hosts,
  targetHost,
  ask,
  turn,
}: {
  text: string;
  enabled: boolean;
  chat: AgentSession | null | undefined;
  offline: boolean;
  clear: () => void;
  undo: () => void;
  hosts: readonly { id: string; address: string }[];
  targetHost: string;
  ask: (request: SideQuestionTurn & { prompt: string }) => Promise<void>;
  turn: SideQuestionTurn;
}) {
  if (/^\/btw(?:\s|$)/i.test(text.trim())) {
    if (chat && !chat.readOnlyReason && !offline) {
      clear();
      void ask({
        ...turn,
        prompt: text
          .trim()
          .replace(/^\/btw\s*/i, "")
          .trim(),
      });
    }
    return true;
  }
  if (!enabled) return false;
  if (chat && !chat.readOnlyReason && text.trim() === "/undo") {
    clear();
    undo();
    return true;
  }
  if (text.trim() === `/${STORAGE_COMMAND}`) {
    const host = hosts.find((item) => item.id === targetHost || item.address === targetHost);
    if (!host) return false;
    clear();
    router.push({ pathname: "/computer-cleanup", params: { id: host.id } });
    return true;
  }
  return false;
}

export function composerCommandHandler({
  chatId,
  setDrafts,
  setUndoIntent,
  undo,
  ...request
}: Omit<Parameters<typeof runComposerCommand>[0], "text" | "enabled" | "turn" | "clear" | "undo"> & {
  chatId: string;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setUndoIntent: (intent: "Undo") => void;
  undo: { open: () => Promise<unknown> };
}) {
  return (text: string, enabled: boolean, turn: SideQuestionTurn) =>
    runComposerCommand({
      ...request,
      text,
      enabled,
      turn,
      clear: () => setDrafts((current) => ({ ...current, [chatId]: "" })),
      undo: () => {
        setUndoIntent("Undo");
        void undo.open();
      },
    });
}

export function readComposerDraft<Q, A>(
  held: { drafts: Record<string, string>; quotes: Record<string, Q[]>; attachments: Record<string, A[]> },
  chatId: string,
  emptyQuotes: Q[],
) {
  return { draft: held.drafts[chatId] || "", quotes: held.quotes[chatId] || emptyQuotes, attachments: held.attachments[chatId] || [] };
}
