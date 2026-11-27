import type { ChatMessage, MessageEditContext } from "./model.ts";

export function canEditMessage(message: ChatMessage | null | undefined): boolean;
export function messagesAfter(messages: readonly ChatMessage[], id: number): number;
export function editingText(removed: number): string;
export function messageEditText(context: MessageEditContext): string;
export function isMessageEdit(message: ChatMessage | null | undefined): message is ChatMessage & { context: MessageEditContext };
