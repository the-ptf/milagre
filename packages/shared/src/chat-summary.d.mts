import type { AgentSession, ChatMessage, ChatSummary } from "./model.ts";

export function isGitNote(message: ChatMessage | undefined): boolean;
export function isNote(message: ChatMessage | undefined): boolean;
export function summarizeChat(messages: readonly ChatMessage[]): ChatSummary;
/** Whether two summaries say the same, so an unchanged Chat keeps its object. */
export function sameSummary(a: ChatSummary | undefined, b: ChatSummary | undefined): boolean;
/** The Chat's summary: the one the host keeps, else one made from its messages (an older host keeps none). */
export function chatSummary(session: Pick<AgentSession, "summary"> | undefined, messages?: readonly ChatMessage[]): ChatSummary;
