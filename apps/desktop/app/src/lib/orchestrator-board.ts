import { chatKey } from "@milagre/shared/agent-runs";
import { qualifyKey } from "@milagre/shared/chat-scopes";
import type { AgentRun, AgentRuns } from "@milagre/shared/agent-runs";
import { autopilotPending, boardColumn, type BoardColumn, type OrchestratorTask } from "@milagre/shared/orchestrator";
import { subchatState, type SubchatKind } from "@milagre/shared/subchat-states";
import type { AgentSession } from "../model";

type TaskCardKind = "deciding" | "pick-project" | "failed" | "chat";

export type TaskCard = {
  task: OrchestratorTask;
  key: string | null;
  column: BoardColumn;
  kind: TaskCardKind;
  session: AgentSession | undefined;
  run: AgentRun | undefined;
  state: SubchatKind | null;
  detail: string;
  inSidebar: boolean;
};

type SessionStates = Record<string, { sessions?: Record<string, unknown> } | undefined>;

type Placed = Pick<OrchestratorTask, "projectPath" | "sessionId"> & { remoteComputerId?: string | null };

export function taskScope(task: Placed): string | null {
  return task.projectPath ? qualifyKey(task.remoteComputerId ?? null, task.projectPath) : null;
}

export function taskChatKey(task: Placed): string | null {
  return task.projectPath && task.sessionId !== null ? chatKey(task.projectPath, task.sessionId, task.remoteComputerId ?? undefined) : null;
}

export function taskSession(task: OrchestratorTask, states: SessionStates): AgentSession | undefined {
  const scope = taskScope(task);
  if (!scope || task.sessionId === null) return undefined;
  return states[scope]?.sessions?.[String(task.sessionId)] as AgentSession | undefined;
}

function pending(task: OrchestratorTask, kind: TaskCardKind, column: BoardColumn, detail: string): TaskCard {
  return { task, key: null, column, kind, session: undefined, run: undefined, state: null, detail, inSidebar: false };
}

function taskCard(task: OrchestratorTask, states: SessionStates, runs: AgentRuns, now: number): TaskCard {
  if (task.state === "routing") return pending(task, "deciding", "running", "Picking the Project, model and account…");
  if (task.state === "needs-project") return pending(task, "pick-project", "needs", "Which Project is this for?");
  if (task.state === "failed") return pending(task, "failed", "needs", task.error ?? "Couldn't start this task");
  const key = taskChatKey(task);
  const session = taskSession(task, states);
  const run = key ? runs[key] : undefined;
  const state = subchatState({ key: key ?? task.id, title: task.title, session: session ?? {}, run }, now);
  const autopilot = state.kind === "needs-you" ? autopilotPending(task, run, now) : null;
  const column = boardColumn({
    done: Boolean(session?.done_at || session?.archived),
    needsYou: state.kind === "needs-you" && !autopilot,
    pullRequest: session?.summary?.pullRequests?.length ? "open" : null,
    finished: !run && Boolean(session?.summary?.lastOutcome) && session?.summary?.lastOutcome !== "failed",
  });
  return {
    task,
    key,
    column,
    kind: "chat",
    session,
    run,
    state: autopilot ? "working" : state.kind,
    detail: autopilot ? `Answering for you in a moment: ${autopilot.summary}` : state.detail,
    inSidebar: session ? !session.orchestrator?.hidden : false,
  };
}

export function boardCards(tasks: readonly OrchestratorTask[], states: SessionStates, runs: AgentRuns, now: number): TaskCard[] {
  return tasks.toSorted((a, b) => b.createdAt - a.createdAt).map((task) => taskCard(task, states, runs, now));
}

export function cardsIn(cards: readonly TaskCard[], column: BoardColumn, projectPath: string | null = null): TaskCard[] {
  return cards.filter((card) => card.column === column && (projectPath === null || card.task.projectPath === projectPath));
}

export function boardCounts(cards: readonly TaskCard[]): { running: number; needs: number } {
  const live = cardsIn(cards, "running").filter((card) => card.kind === "deciding" || card.run);
  return { running: live.length, needs: cardsIn(cards, "needs").length };
}

export function taskProjectPaths(tasks: readonly OrchestratorTask[]): string[] {
  return [...new Set(tasks.flatMap((task) => taskScope(task) ?? []))].sort();
}

export function taskForChat(tasks: readonly OrchestratorTask[], key: string | null): OrchestratorTask | null {
  return key ? (tasks.find((task) => taskChatKey(task) === key) ?? null) : null;
}

export function sinceLabel(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export type ScreenPoint = { x: number; y: number };
export type CaretField = { left: number; top: number; width: number; padLeft: number; padTop: number; lineHeight: number };

/** Where the caret sits on screen, from the text before it; soft wraps are ignored and the column stays inside the field. */
export function caretPoint(before: string, charWidth: number, field: CaretField): ScreenPoint {
  const lines = before.split("\n");
  const column = lines.at(-1)?.length ?? 0;
  return {
    x: field.left + field.padLeft + Math.min(field.width, column * charWidth),
    y: field.top + field.padTop + (lines.length - 0.5) * field.lineHeight,
  };
}

/** A full-strength look from the middle of `from` toward a point on screen. */
export function gazeToward(from: { left: number; top: number; width: number; height: number }, point: ScreenPoint): { x: number; y: number } {
  const dx = point.x - (from.left + from.width / 2);
  const dy = point.y - (from.top + from.height / 2);
  const reach = Math.hypot(dx, dy);
  return reach < 1 ? { x: 0, y: 0 } : { x: dx / reach, y: dy / reach };
}

export function routeReason(task: Pick<OrchestratorTask, "reason" | "computer">, here: string): string {
  const parts = [
    task.reason.project,
    task.reason.role,
    task.reason.account,
    task.reason.computer ?? (task.computer ? `Runs on ${task.computer}` : `Runs on ${here}`),
  ];
  return `${parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/\.$/, ""))
    .join(". ")}.`;
}
