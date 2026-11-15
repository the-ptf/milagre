import type { AgentRun } from "./agent-runs.mjs";
import type { AgentEvent, AgentPort, BackgroundTask, ChatSummary, ModelProvider, Subagent } from "./model.ts";

export type ChatActivityState = "waiting" | "working" | "failed" | "background" | "idle";

export type ActivitySession = {
  provider?: ModelProvider;
  subagents?: Subagent[];
  backgroundTasks?: BackgroundTask[];
  native_session_id?: string;
  summary?: Pick<ChatSummary, "lastOutcome">;
};

export interface ChatActivity {
  activity: ChatActivityState;
  /** Background work still going on (subagents, tasks, advisors), whatever the activity: a failed Chat can still have some. */
  background: number;
  since?: number;
}

export function activityOf(input?: { running?: boolean; waiting?: boolean; failed?: boolean; background?: number }): ChatActivityState;
export function activityBusy(activity: ChatActivityState): boolean;
export function backgroundSubagents(session: ActivitySession | undefined): Subagent[];
export function backgroundTasks(session: ActivitySession | undefined): BackgroundTask[];
export function processWork(session: ActivitySession | undefined): Array<Subagent | BackgroundTask>;
export function outlivesTurn(agent: Pick<Subagent, "background" | "source"> | undefined): boolean;
export function backgroundWork(session: ActivitySession | undefined): Array<Subagent | BackgroundTask>;

export type BackgroundItemType = "subagent" | "advisor" | "command" | "workflow" | "task";
export const BACKGROUND_ITEM_LABELS: Readonly<Record<BackgroundItemType, string>>;
export interface BackgroundItem {
  type: BackgroundItemType;
  id: string;
  title: string;
  startedAt: number;
  /** The subagent or advisor itself; absent for a task. */
  agent?: Subagent;
}
export function backgroundItems(session: ActivitySession | undefined, ports?: readonly Pick<AgentPort, "taskId">[]): BackgroundItem[];
export function chatActivity(
  session: ActivitySession | undefined,
  run: Pick<AgentRun, "approvals" | "questions"> | undefined,
  lastOutcome?: ChatSummary["lastOutcome"],
): ChatActivity;
export function backgroundLabel(count: number): string;
export function plainTaskOutput(text: string | undefined): string;
export function backgroundBusyMessage(action: "switch" | "reload" | "move", count: number, to?: string): string;
export function notificationPreview(previous: string | undefined, text: string, startsMessage?: boolean): string;
export function holdsAnnouncement(task: Pick<BackgroundTask, "kind"> | undefined): boolean;

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
export function createActivityTracker(options?: { maxChats?: number; holdsTask?: (task: BackgroundTask) => boolean }): ActivityTracker;
