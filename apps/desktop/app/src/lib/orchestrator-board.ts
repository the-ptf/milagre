import { chatKey } from "@milagre/shared/agent-runs";
import { qualifyKey } from "@milagre/shared/chat-scopes";
import type { AgentRun, AgentRuns } from "@milagre/shared/agent-runs";
import { chatPullRequests, ownsWorktree } from "@milagre/shared/chats";
import { chatActivity } from "@milagre/shared/chat-activity";
import { DONE_DEFAULTS, doneCountdown } from "@milagre/shared/done";
import {
  autopilotPending,
  boardColumn,
  placedColumn,
  pullRequestState,
  taskBlockedText,
  taskLimitText,
  taskOutcomeDetail,
  type BoardColumn,
  type BoardPullRequest,
  type OrchestratorTask,
} from "@milagre/shared/orchestrator";
import { boardPullRequestMark, type BoardPullRequestMark } from "@milagre/shared/pr-blockers";
import { pendingAsk, subchatState, type PendingAsk, type SubchatKind } from "@milagre/shared/subchat-states";
import type { AgentSession, PullRequestSnapshot, QuestionRequest } from "../model";

type TaskCardKind = "deciding" | "pick-project" | "failed" | "chat";

/** What a waiting task Chat asks the user, answerable outside its transcript. */
export type TaskAsk = PendingAsk<QuestionRequest>;

export type TaskCard = {
  task: OrchestratorTask;
  key: string | null;
  column: BoardColumn;
  kind: TaskCardKind;
  session: AgentSession | undefined;
  run: AgentRun | undefined;
  state: SubchatKind | null;
  pullRequest: BoardPullRequest;
  pullRequestMark: BoardPullRequestMark | null;
  detail: string;
  ask: TaskAsk | null;
  inSidebar: boolean;
  countdown: string | null;
};

type SessionStates = Record<string, { sessions?: Record<string, unknown>; worktrees?: Record<string, { path: string }> } | undefined>;
type Snapshots = Record<string, PullRequestSnapshot | undefined>;

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
  return {
    task,
    key: null,
    column,
    kind,
    session: undefined,
    run: undefined,
    state: null,
    pullRequest: null,
    pullRequestMark: null,
    detail,
    ask: null,
    inSidebar: false,
    countdown: null,
  };
}

/** The state of a task Chat's pull requests, from its Project's snapshot; an unread one counts as open but has no mark yet. */
function taskPullRequest(
  task: OrchestratorTask,
  session: AgentSession | undefined,
  states: SessionStates,
  snapshots: Snapshots,
): { pullRequest: BoardPullRequest; pullRequestMark: BoardPullRequestMark | null } {
  const refs = session?.summary?.pullRequests ?? [];
  const scope = taskScope(task);
  const path = session && scope ? states[scope]?.worktrees?.[String(session.worktree_id)]?.path : undefined;
  const snapshot = scope ? snapshots[scope] : undefined;
  const owned = session ? ownsWorktree(scope ? states[scope] : undefined, session.id, task.projectPath) : false;
  const prs = path && snapshot ? chatPullRequests(refs, snapshot.chats[path] ?? {}, owned ? (snapshot.worktrees[path] ?? undefined) : undefined) : [];
  return {
    pullRequest: prs.length ? pullRequestState(prs.map((pr) => pr.state)) : refs.length ? "open" : null,
    pullRequestMark: boardPullRequestMark(prs),
  };
}

const askUnless = (run: AgentRun | undefined, autopilot: unknown): TaskAsk | null => (autopilot ? null : pendingAsk(run));

function doneCardCountdown(column: BoardColumn, session: AgentSession | undefined, retentionHours: number, now: number): string | null {
  return column === "done" && session ? doneCountdown(session, retentionHours, now) : null;
}

function taskCard(task: OrchestratorTask, states: SessionStates, runs: AgentRuns, now: number, snapshots: Snapshots, retentionHours: number): TaskCard {
  if (task.state === "routing") return pending(task, "deciding", "running", "Picking the Project, model and account…");
  if (task.state === "needs-project") return pending(task, "pick-project", "needs", "Which Project is this for?");
  if (task.state === "failed") return pending(task, "failed", "needs", task.error ?? "Couldn't start this task");
  const key = taskChatKey(task);
  const session = taskSession(task, states);
  const run = key ? runs[key] : undefined;
  const state = subchatState({ key: key ?? task.id, title: task.title, session: session ?? {}, run }, now);
  const autopilot = state.kind === "needs-you" ? autopilotPending(task, run, now) : null;
  const limit = run ? null : taskLimitText(task, new Date(now));
  const blocked = taskBlockedText(session, Boolean(run));
  const needsYou = (state.kind === "needs-you" && !autopilot) || state.kind === "failed" || state.kind === "stopped" || Boolean(limit) || Boolean(blocked);
  const active = Boolean(run) || chatActivity(session, undefined).activity === "background";
  const { pullRequest, pullRequestMark } = taskPullRequest(task, session, states, snapshots);
  const column = boardColumn({
    outcome: task.outcome,
    active,
    done: Boolean(session?.done_at || session?.archived),
    needsYou,
    pullRequest,
    placed: placedColumn(session),
    finished: !run && (state.kind === "stopped" || (state.kind === "done" && (Boolean(session?.summary?.lastOutcome) || (session?.summary?.count ?? 0) > 1))),
  });
  return {
    task,
    key,
    column,
    kind: "chat",
    session,
    run,
    state: autopilot ? "working" : blocked ? "needs-you" : state.kind,
    pullRequest,
    pullRequestMark,
    detail: autopilot
      ? `Answering for you in ${Math.max(1, Math.ceil(((autopilot.until ?? now) - now) / 1000))} s unless you answer first: ${autopilot.summary}`
      : (blocked ?? limit ?? (!needsYou && (column === "needs" || column === "review") ? taskOutcomeDetail(task.outcome, pullRequest) : null) ?? state.detail),
    ask: askUnless(run, autopilot),
    inSidebar: session ? !session.orchestrator?.hidden : false,
    countdown: doneCardCountdown(column, session, retentionHours, now),
  };
}

/** `retentionHours`: how long the host keeps a Done Chat before archiving it, for the countdown on Done cards. */
export function boardCards(
  tasks: readonly OrchestratorTask[],
  states: SessionStates,
  runs: AgentRuns,
  now: number,
  snapshots: Snapshots = {},
  retentionHours: number = DONE_DEFAULTS.retentionHours,
): TaskCard[] {
  return tasks.toSorted((a, b) => b.createdAt - a.createdAt).map((task) => taskCard(task, states, runs, now, snapshots, retentionHours));
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

function accountReason(why: string | null, account?: string): string | null {
  if (!account) return why;
  if (!why) return `Uses ${account}`;
  return `Uses ${account}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
}

export function routeReason(task: Pick<OrchestratorTask, "reason" | "computer">, here: string, account?: string): string {
  const parts = [
    task.reason.project,
    task.reason.role,
    accountReason(task.reason.account, account),
    task.reason.computer ?? (task.computer ? `Runs on ${task.computer}` : `Runs on ${here}`),
  ];
  return `${parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/\.$/, ""))
    .join(". ")}.`;
}
