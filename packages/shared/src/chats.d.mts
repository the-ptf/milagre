import type { AgentSession, LinkChatSession, ChatContext, ChatMessage, CoordinatorState, ImageAttachment, ModelProvider } from "./model.ts";
export { pullRequestRefs, pullRequestRefsCache, chatPullRequests, type PullRequestRef } from "./chat-pull-requests.mjs";

export function chatMarkTone(
  mark: "question" | "waiting" | "delegated" | "interrupted" | "running" | "background" | "failed" | "unread" | "idle",
): "accent" | "orange" | "red" | "ink3";

export function chatTitle(session: AgentSession | LinkChatSession, messages?: readonly ChatMessage[]): string;
export function isHandoverChat(session: AgentSession | LinkChatSession | undefined): boolean;
export function isListedChat(session: AgentSession | LinkChatSession | undefined, messageCount: number): boolean;

export function comparePins(a: Pick<AgentSession, "pinned" | "pin_order">, b: Pick<AgentSession, "pinned" | "pin_order">): number;
export function pinOrderAt(orders: number[], index: number): number;

export type PendingChat = {
  session: AgentSession;
  message: ChatMessage;
  startedAt: number;
  sortId: number;
  targetSessionId: number | null;
  acceptedSessionId?: number;
};
export function createPendingChat(input: {
  state: CoordinatorState;
  worktreeId: number;
  sessionId?: number | null;
  body: string;
  images?: ImageAttachment[];
  files?: string[];
  model: string;
  provider: ModelProvider;
  /** What the message is when no person typed it, such as a PR-blocker pill's action. */
  context?: ChatContext;
}): PendingChat;
export function pendingChatSessionId(state: CoordinatorState, pending: PendingChat | null | undefined): number | null;
export function withPendingChat(state: CoordinatorState, pending: PendingChat | null | undefined): CoordinatorState;
