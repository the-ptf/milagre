import type { AgentRun } from "@milagre/shared/agent-runs";
import type { AgentSession } from "@milagre/shared/model";
import { isHiddenRunChat, isListedChat } from "@milagre/shared/chats";

/** Whether a turn waits on the user: an approval or a question. */
const waitsOnYou = (run: AgentRun | undefined) => !!(run?.approvals.length || run?.questions.length);

/**
 * Whether the phone's Chat list and its Link picker show a Chat. A hidden Run Chat stays out, even while its turn runs,
 * unless that turn waits on an approval or a question. Any other Chat shows while a turn runs (a new Chat appears as its
 * first turn starts), else once `isListedChat` lists it.
 */
export function shownChat(chat: AgentSession, run: AgentRun | undefined, messageCount: number): boolean {
  const waiting = waitsOnYou(run);
  if (isHiddenRunChat(chat, waiting)) return false;
  return !!run || isListedChat(chat, messageCount, waiting);
}
