import type { ChatMessage, LinkedContext } from "./model.ts";

/** The message's Link context when another Chat or a Link wrote it rather than the user or the agent, else null. */
export function linkedContext(message: Pick<ChatMessage, "context"> | undefined): LinkedContext | null;
/** What the sender line says, and the Chat key it opens (null when there is none to open). */
export function linkedHeading(context: LinkedContext): { text: string; chat: string | null };
/**
 * The one line a message another Chat sent stands for in the transcript, its text opening on a tap; null for one that
 * keeps its full text (reports have their own line, Negotiation rounds stay whole).
 */
export function linkedLine(context: LinkedContext | null | undefined): { verb: string; name: string; label: string; chat: string | null } | null;
export type LinkedLine = NonNullable<ReturnType<typeof linkedLine>>;
/** A back-and-forth with one other Chat, folded into one line ("4 messages with Fix login"). */
export interface LinkedExchange {
  line: LinkedLine;
  /** How many messages the thread shows. */
  count: number;
  items: { from: "them" | "us"; message: ChatMessage }[];
}
/**
 * Folds a back-and-forth with one other Chat into one line: the run's first row carries `exchange`, the rest are hidden
 * except the last reply. Runs with fewer than two messages from that Chat stay as they are.
 */
export function foldLinkedExchanges<T extends { message: ChatMessage; hidden?: true }>(entries: T[]): Array<T & { exchange?: LinkedExchange }>;
/** The exchange as Markdown: each message under who wrote it, oldest first. */
export function exchangeText(exchange: LinkedExchange): string;
