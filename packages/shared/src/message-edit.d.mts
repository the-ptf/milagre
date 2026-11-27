import type { ChatMessage, ChatSendRequest } from "./model.ts";

export function canEditMessage(message: ChatMessage | null | undefined): boolean;
export function messagesAfter(messages: readonly ChatMessage[], id: number): number;
export function editingText(removed: number): string;
export function messageEditText(context: MessageEditContext): string;
export function isMessageEdit(message: ChatMessage | null | undefined): message is ChatMessage & { context: MessageEditContext };

/**
 * The user edited an earlier message: the `removed` messages after it went, and the Chat ran again from the new text,
 * which follows this divider. `restored` files went back to before the edited message (`recoveryId` is the checkpoint
 * saved first, which the line's Redo previews). `newSession` marks a provider that couldn't rewind its session, so the
 * agent continued in a new one that was given the conversation up to the edit.
 */
export type MessageEditContext = {
  kind: "message-edit";
  edited: number;
  removed: number;
  restored?: number;
  kept?: number;
  recoveryId?: string;
  newSession?: boolean;
};

/**
 * Edit an earlier typed message of the Chat (`sessionId`) and run the Chat again from there: everything after it is
 * removed, the provider's session is rewound to just before it, and a turn starts with the new text. A running turn is
 * stopped first.
 */
export interface ChatEditRequest extends Omit<ChatSendRequest, "sessionId" | "delivery" | "prAction" | "linearIssue" | "githubIssue" | "compact"> {
  sessionId: number;
  messageId: number;
  /** Also put back the files the removed turns changed. Files without a decision are undone, except ones edited after those turns, which are kept. */
  undoFiles?: { revision?: string; decisions?: Record<string, "keep" | "restore"> } | null;
  /** Include the edited message's own images and files alongside new attachments. */
  keepAttachments?: boolean;
}
