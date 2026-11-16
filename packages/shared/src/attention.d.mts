import type { AgentRun, AgentRuns } from "./agent-runs.mjs";
import type { AgentEvent, CoordinatorState, ModelProvider } from "./model.ts";
import type { TranscriptState, PermissionRequest, QuestionRequest } from "./model.ts";

export interface AttentionNotice {
  title: string;
  body: string;
}

export interface AttentionContext {
  projectName: string;
  worktreeName?: string;
  chatTitle?: string;
  parentTitle?: string;
  provider?: ModelProvider;
  /** When a snoozed Chat wakes, in ms; its completions send no notice until then. */
  snoozedUntil?: number;
}

export function notificationText(value: string | undefined, options?: { markdown?: boolean }): string;
export function notificationPreview(previous: string | undefined, text: string, startsMessage?: boolean): string;
export function completionNotice(title: string | undefined, result: { failed: boolean; body?: string }): AttentionNotice;
export function attentionTitle(context: Pick<AttentionContext, "chatTitle" | "parentTitle">): string;
/** The notification for an approval or question a turn waits on, or null for any other event. */
export function attentionNotice(event: AgentEvent, context: AttentionContext): AttentionNotice | null;
export function attentionContext(state: CoordinatorState, projectName: string, sessionId: number): AttentionContext;
export function hiddenHere(key: string, scopes?: ReadonlySet<string>, computers?: ReadonlySet<string>): boolean;
/** Chat keys other than `currentChat` whose turn waits on an approval or question. Link Chats, `hidden` Projects and
 * Projects on `hiddenComputers` are left out. */
export function chatsNeedingAttention(
  runs: Readonly<Record<string, Pick<AgentRun, "approvals" | "questions">>> | undefined,
  currentChat?: string,
  hidden?: ReadonlySet<string>,
  hiddenComputers?: ReadonlySet<string>,
): string[];
export function attentionLabel(titles: string[]): string;
export function attentionCount(count: number): string;
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
