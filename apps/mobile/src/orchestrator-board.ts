import { autopilotPending, boardColumn, taskLimitText, type BoardColumn, type OrchestratorTask } from "@milagre/shared/orchestrator";
import type { AgentRun } from "@milagre/shared/agent-runs";
import type { AgentModels, AgentSession, ChatMessage, ModelProvider } from "@milagre/shared/model";
import { MODEL_CATALOG } from "@milagre/shared/model-options";
import { effortCopy } from "@milagre/shared/model-copy";
import { subchatState } from "@milagre/shared/subchat-states";
import { chatMark, type ChatMark } from "./indicators.ts";

export const BOARD_TABS: { id: BoardColumn; label: string }[] = [
  { id: "running", label: "Running" },
  { id: "needs", label: "Needs you" },
  { id: "review", label: "In review" },
  { id: "done", label: "Done" },
];

export type TaskChat = { chat: AgentSession; run?: AgentRun; messages?: ChatMessage[] };
export type PullRequestState = "open" | "merged" | "closed" | null;
export type BoardKind = "deciding" | "needs-project" | "failed" | "chat" | "loading" | "remote";

export type BoardItem = {
  task: OrchestratorTask;
  column: BoardColumn;
  kind: BoardKind;
  mark: ChatMark | null;
  detail: string;
  pullRequest: PullRequestState;
  inSidebar: boolean;
};

const NEEDS_YOU = new Set<ChatMark>(["question", "waiting", "interrupted", "failed"]);

export function boardItem(task: OrchestratorTask, chat: TaskChat | undefined, pullRequest: PullRequestState, now: number): BoardItem {
  const base = { task, pullRequest, inSidebar: false };
  if (task.state === "routing") return { ...base, column: "running", kind: "deciding", mark: null, detail: "Deciding where this goes…" };
  if (task.state === "needs-project")
    return { ...base, column: "needs", kind: "needs-project", mark: null, detail: task.reason.project ?? "No Project fits. Pick one to start." };
  if (task.state === "failed") return { ...base, column: "needs", kind: "failed", mark: "failed", detail: task.error ?? "Couldn't start this task." };
  if (!chat && task.remoteComputerId)
    return { ...base, column: "running", kind: "remote", mark: null, detail: `Running on ${task.computer ?? "another computer"}` };
  if (!chat) return { ...base, column: "running", kind: "loading", mark: null, detail: "Starting…" };
  const mark = chatMark(chat.chat, chat.run, chat.messages ?? []);
  const state = subchatState({ key: `${task.projectPath}#${task.sessionId}`, title: task.title, session: chat.chat, run: chat.run ?? null }, now);
  const done = !!chat.chat.done_at || !!chat.chat.archived;
  const autopilot = NEEDS_YOU.has(mark) ? autopilotPending(task, chat.run, now) : null;
  const limit = chat.run ? null : taskLimitText(task, new Date(now));
  return {
    ...base,
    inSidebar: chat.chat.orchestrator?.hidden === false,
    column: boardColumn({
      done,
      needsYou: (NEEDS_YOU.has(mark) && !autopilot) || Boolean(limit),
      pullRequest,
      finished: state.kind === "done" || state.kind === "stopped",
    }),
    kind: "chat",
    mark: autopilot ? null : mark,
    detail: autopilot ? `Answering for you in a moment: ${autopilot.summary}` : (limit ?? state.detail),
  };
}

export function boardCounts(items: readonly BoardItem[]): Record<BoardColumn, number> {
  const counts: Record<BoardColumn, number> = { running: 0, needs: 0, review: 0, done: 0 };
  for (const item of items) counts[item.column]++;
  return counts;
}

/** Newest first, so a task sent a moment ago lands on top of its column. */
export function columnItems(items: readonly BoardItem[], column: BoardColumn): BoardItem[] {
  return items.filter((item) => item.column === column).sort((a, b) => b.task.createdAt - a.task.createdAt);
}

export function pullRequestState(states: readonly ("OPEN" | "MERGED" | "CLOSED")[]): PullRequestState {
  if (states.includes("OPEN")) return "open";
  if (states.includes("MERGED")) return "merged";
  if (states.includes("CLOSED")) return "closed";
  return null;
}

export function modelName(provider: ModelProvider | null, model: string | null, reported?: AgentModels | null): string {
  if (!model) return "No model";
  const found = (provider ? reported?.[provider]?.find((entry) => entry.id === model) : undefined) ?? MODEL_CATALOG.find((entry) => entry.id === model);
  return found?.name ?? model;
}

export function modelAndEffort(provider: ModelProvider | null, model: string | null, effort: string | null, reported?: AgentModels | null): string {
  const name = modelName(provider, model, reported);
  return effort ? `${name} · ${effortCopy(effort).name}` : name;
}

export function projectName(path: string | null, projects: readonly { path: string; name?: string }[]): string {
  if (!path) return "No Project";
  return projects.find((project) => project.path === path)?.name || path.split("/").findLast(Boolean) || path;
}

/** A slot reel's strip: the other options cycling past, then the one that was picked, last. */
export function relativeAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
