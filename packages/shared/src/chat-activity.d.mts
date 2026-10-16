import type { AgentRun } from "./agent-runs.mjs";
import type { AgentEvent, ChatSummary, ModelProvider, Subagent } from "./model.ts";

/** What a Chat is doing: see CHAT_ACTIVITIES in chat-activity.mjs for which wins. */
export type ChatActivityState = "waiting" | "working" | "failed" | "background" | "idle";
export const CHAT_ACTIVITIES: readonly ChatActivityState[];

/** What the activity reads from a Chat's saved session. */
export type ActivitySession = {
  provider?: ModelProvider;
  subagents?: Subagent[];
  native_session_id?: string;
  summary?: Pick<ChatSummary, "lastOutcome">;
};

export interface ChatActivity {
  activity: ChatActivityState;
  /** Background subagents still at work, whatever the activity (a failed Chat can still have some). */
  background: number;
  /** When the oldest of them started, while any works. */
  since?: number;
}

export function activityOf(input?: { running?: boolean; waiting?: boolean; failed?: boolean; background?: number }): ChatActivityState;
export function activityBusy(activity: ChatActivityState): boolean;
export function backgroundSubagents(session: ActivitySession | undefined): Subagent[];
export function outlivesTurn(agent: Pick<Subagent, "background" | "source"> | undefined): boolean;
export function backgroundWork(session: ActivitySession | undefined): Subagent[];
export function chatActivity(
  session: ActivitySession | undefined,
  run: Pick<AgentRun, "approvals" | "questions"> | undefined,
  lastOutcome?: ChatSummary["lastOutcome"],
): ChatActivity;
export function backgroundLabel(count: number): string;
export function backgroundBusyMessage(action: "switch" | "reload" | "move", count: number, to?: string): string;
export function notificationPreview(previous: string | undefined, text: string, startsMessage?: boolean): string;

/** A Chat's work that just ended, to announce: how its last turn ended. */
export interface ActivityCompletion {
  failed: boolean;
  body: string;
  event: AgentEvent;
}
export interface ActivityChange {
  previous: ChatActivityState;
  next: ChatActivityState;
  completion: ActivityCompletion | null;
}
export interface ActivityTracker {
  observe(chatId: string, event: AgentEvent): ActivityChange;
  activity(chatId: string): ChatActivityState;
  background(chatId: string): number;
  forget(drop?: (chatId: string) => boolean): void;
}
export function createActivityTracker(options?: { maxChats?: number }): ActivityTracker;
