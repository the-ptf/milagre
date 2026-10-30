import { chatSummary } from "@milagre/shared/chat-summary";
import { chatActivity } from "@milagre/shared/chat-activity";
import { chatMarkPresentation } from "@milagre/shared/chats";
import type { AgentRun } from "@milagre/shared/agent-runs";
import type { AgentSession, ChatMessage, Subagent } from "@milagre/shared/model";
export function agentCounts(agents: Subagent[]) {
  const visible = agents.filter((agent) => !agent.archived);
  return {
    running: visible.filter((agent) => ["running", "initializing"].includes(agent.status)).length,
    waiting: visible.filter((agent) => agent.status === "waiting").length,
    failed: visible.filter((agent) => agent.status === "failed").length,
    total: visible.length,
  };
}
/**
 * Desktop's sidebar chat mark: one slot left of the title. Asks for you draw an icon; running spins; background work
 * (chat-activity.mjs: the turn ended, background agents still work) is a still ring with their count; unread is a dot.
 */
export type ChatMark = "question" | "waiting" | "interrupted" | "running" | "background" | "failed" | "unread" | "idle";
export function chatMark(chat: AgentSession | undefined, run?: AgentRun, messages: ChatMessage[] = []): ChatMark {
  if (run?.questions.length) return "question";
  if (run?.approvals.length) return "waiting";
  if (run) return "running";
  if (chat?.resumeTurn) return "interrupted";
  // How the last reply ended (the commit dialog's notes aren't replies), as desktop's sidebar reads it: a failure wins
  // over background work.
  const { activity } = chatActivity(chat, run, chatSummary(chat, messages).lastOutcome);
  if (activity === "background") return "background";
  if (chat?.unread) return "unread";
  if (activity === "failed") return "failed";
  return "idle";
}
/** The mark's words, the same as desktop's (chatMarkPresentation). */
export const MARK_LABEL = Object.fromEntries(
  (["question", "waiting", "interrupted", "running", "background", "failed", "unread", "idle"] as const).map((mark) => [
    mark,
    chatMarkPresentation(mark).label,
  ]),
) as Record<ChatMark, string>;
