import type { AgentSession, LinkChatSession, ChatContext, ChatMessage, CoordinatorState, ImageAttachment, ModelProvider } from "./model.ts";
export {
  pullRequestRefs,
  pullRequestRefsCache,
  chatPullRequests,
  createdPullRequestUrl,
  associatedPullRequest,
  type PullRequestRef,
} from "./chat-pull-requests.mjs";

export type ChatMarkKind = "question" | "waiting" | "delegated" | "interrupted" | "running" | "background" | "failed" | "unread" | "idle";
/** The mark's tone as text (status words); idle reads ink3. */
export function chatMarkTone(mark: ChatMarkKind): "accent" | "orange" | "red" | "ink3";
/**
 * A Chat mark as both apps draw it. `icon`: bubble (BubbleChatIcon), shield-alert (ShieldAlertIcon), link (Link04Icon),
 * alert (Alert02Icon), spinner (SpinnerRing), ring (the background count ring), dot (8px; idle 6px). `tone`: the
 * glyph's palette key, idle a solid ink4 dot. `label`: tooltip and accessibility words, empty for idle.
 */
export function chatMarkPresentation(mark: ChatMarkKind): {
  icon: "bubble" | "shield-alert" | "link" | "alert" | "spinner" | "ring" | "dot";
  tone: "accent" | "orange" | "red" | "ink4";
  label: string;
};

/** A one-line title of at most 60 characters: a longer line keeps its first 57 and an ellipsis. */
export function shortTitle(line: string): string;
export function chatTitle(session: AgentSession | LinkChatSession, messages?: readonly ChatMessage[]): string;
export function isHandoverChat(session: AgentSession | LinkChatSession | undefined): boolean;
/** Whether a Routine's Run created the Chat and keeps it out of the lists (`routine.hidden`) unless `waiting` says it waits on someone. */
export function isHiddenRunChat(session: AgentSession | LinkChatSession | undefined, waiting?: boolean): boolean;
/** Whether the chat lists show the Chat: it has a message or a handover; a hidden Run Chat only while `waiting` says it waits on someone. */
export function isListedChat(session: AgentSession | LinkChatSession | undefined, messageCount: number, waiting?: boolean): boolean;

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
  /** Reuses the id of a send that failed before the host answered, so the host can recognise a resend. */
  clientMessageId?: string;
}): PendingChat;
export type ResendMemory = {
  remember(key: string, clientMessageId: string, body: string, attachments?: readonly string[]): void;
  reuse(key: string, body: string, attachments?: readonly string[]): string | undefined;
  forget(key: string): void;
};
export function createResendMemory(): ResendMemory;
export function pendingChatSessionId(state: CoordinatorState, pending: PendingChat | null | undefined): number | null;
export function withPreview(messages: readonly ChatMessage[], pending: Pick<PendingChat, "message">): ChatMessage[];
export function withPendingChat(state: CoordinatorState, pending: PendingChat | null | undefined): CoordinatorState;
