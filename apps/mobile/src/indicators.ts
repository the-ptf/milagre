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
export type ChatMark = "question" | "waiting" | "interrupted" | "running" | "background" | "failed" | "unread" | "idle";
export function chatMark(chat: AgentSession | undefined, run?: AgentRun, messages: ChatMessage[] = []): ChatMark {
  if (run?.questions.length) return "question";
  if (run?.approvals.length) return "waiting";
  if (run) return "running";
  if (chat?.resumeTurn) return "interrupted";
  const { activity } = chatActivity(chat, run, chatSummary(chat, messages).lastOutcome);
  if (activity === "background") return "background";
  if (chat?.unread) return "unread";
  if (activity === "failed") return "failed";
  return "idle";
}
export const MARK_LABEL = Object.fromEntries(
  (["question", "waiting", "interrupted", "running", "background", "failed", "unread", "idle"] as const).map((mark) => [
    mark,
    chatMarkPresentation(mark).label,
  ]),
) as Record<ChatMark, string>;
