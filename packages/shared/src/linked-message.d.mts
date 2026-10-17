import type { ChatMessage, LinkedContext } from "./model.ts";

/** The message's Link context when another Chat or a Link wrote it rather than the user or the agent, else null. */
export function linkedContext(message: Pick<ChatMessage, "context"> | undefined): LinkedContext | null;
/** What the sender line says, and the Chat key it opens (null when there is none to open). */
export function linkedHeading(context: LinkedContext): { text: string; chat: string | null };
