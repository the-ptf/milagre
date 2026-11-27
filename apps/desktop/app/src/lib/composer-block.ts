import type { AgentSession } from "@milagre/shared/model";
import { RUN_WORKTREE_REMOVED_NOTE } from "@milagre/shared/routines";
import { ARCHIVED_CHAT_NOTE } from "@milagre/shared/message-search-view";

export const RUN_CHAT_REPLY_NOTE = "Replying keeps this Chat: it joins your sidebar and stays in this Routine's Runs.";

type Block = { note?: string; blocked: boolean; restore?: () => void };

/** What the composer says under a Chat that can't take messages, and the way back for an archived one. */
export function composerBlock(
  session: Pick<AgentSession, "id" | "readOnlyReason" | "archived" | "formerWorktree" | "routine"> | undefined,
  { runPane, restore }: { runPane: boolean; restore: (sessionId: number) => void },
): Block {
  if (!session) return { blocked: false };
  if (session.readOnlyReason) return { note: session.readOnlyReason, blocked: true };
  if (session.archived) return { note: ARCHIVED_CHAT_NOTE, blocked: true, restore: () => restore(session.id) };
  if (session.formerWorktree) return { note: RUN_WORKTREE_REMOVED_NOTE, blocked: true };
  return { note: runPane && session.routine?.hidden ? RUN_CHAT_REPLY_NOTE : undefined, blocked: false };
}
