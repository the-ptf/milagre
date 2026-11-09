import type { AgentRun, AgentRuns } from "./agent-runs.mjs";
import type { AgentEvent, CoordinatorState, ModelProvider } from "./model.ts";
import type { TranscriptState, PermissionRequest, QuestionRequest } from "./model.ts";

/** What a system notification says about a chat that waits on the user. */
export interface AttentionNotice {
  title: string;
  body: string;
}

export interface AttentionContext {
  projectName: string;
  worktreeName?: string;
  chatTitle?: string;
  /** The nearest Chat above a Subchat that is still listed. */
  parentTitle?: string;
  provider?: ModelProvider;
}

/** A compact plain-text preview for desktop and phone notifications. */
export function notificationText(value: string | undefined, options?: { markdown?: boolean }): string;
/** Keep the beginning of the latest reply; ordinary paragraph breaks stay in the preview. */
export function notificationPreview(previous: string | undefined, text: string, startsMessage?: boolean): string;
/** The same chat-only title and result preview on desktop and phones. */
export function completionNotice(title: string | undefined, result: { failed: boolean; body?: string }): AttentionNotice;
/** The title of a notice about a Chat that waits: "Write pill tests · in Redesign the PR panel" for a Subchat. */
export function attentionTitle(context: Pick<AttentionContext, "chatTitle" | "parentTitle">): string;
/** The notification for an approval or question a turn waits on, or null for any other event. */
export function attentionNotice(event: AgentEvent, context: AttentionContext): AttentionNotice | null;
export function attentionContext(state: CoordinatorState, projectName: string, sessionId: number): AttentionContext;
/** Whether a Chat or scope key is left out of this Mac's sidebar: its scope in `scopes`, or its computer in `computers`. */
export function hiddenHere(key: string, scopes?: ReadonlySet<string>, computers?: ReadonlySet<string>): boolean;
/** Chat keys other than `currentChat` whose turn waits on an approval or question. Link Chats, `hidden` Projects and
 * Projects on `hiddenComputers` are left out. */
export function chatsNeedingAttention(
  runs: AgentRuns | undefined,
  currentChat?: string,
  hidden?: ReadonlySet<string>,
  hiddenComputers?: ReadonlySet<string>,
): string[];
/** Name the waiting Chat, or count Chats when the button opens a menu. */
export function attentionLabel(titles: string[]): string;
/** The attention chip's own short label: "1 waiting", "2 waiting". */
export function attentionCount(count: number): string;
/** What a waiting run asks for, in one line: the approval's command or title, or its first question. */
export function waitingFor(run: AgentRun | undefined): string | undefined;

export type InboxStatus = "working" | "question" | "approval" | "completed" | "failed";
export interface InboxItem {
  key: string;
  projectPath: string;
  project: string;
  title: string;
  provider?: ModelProvider;
  computer?: string;
  status: InboxStatus;
  at: number;
  permission?: PermissionRequest;
  question?: QuestionRequest;
  preview?: string;
}
export interface InboxSnapshot {
  agents: InboxItem[];
  items: InboxItem[];
}
export function inboxSnapshot(scopes: Array<{ path: string; name: string; state: TranscriptState }>, runs?: AgentRuns): InboxSnapshot;
export function visibleInbox(snapshot: InboxSnapshot, activity?: boolean): InboxSnapshot;
