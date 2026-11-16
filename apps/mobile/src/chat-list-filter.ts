import type { AgentRun } from "@milagre/shared/agent-runs";
import type { AgentSession } from "@milagre/shared/model";
import { isHiddenRunChat, isHiddenTaskChat, isListedChat } from "@milagre/shared/chats";

const waitsOnYou = (run: AgentRun | undefined) => !!(run?.approvals.length || run?.questions.length);

export function shownChat(chat: AgentSession, run: AgentRun | undefined, messageCount: number, { archived = false } = {}): boolean {
  const shownAnyway = waitsOnYou(run) || archived;
  if (isHiddenRunChat(chat, shownAnyway) || isHiddenTaskChat(chat)) return false;
  return !!run || isListedChat(chat, messageCount, shownAnyway);
}
