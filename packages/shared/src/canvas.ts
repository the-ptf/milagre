import { chatSummary } from "./chat-summary.mjs";
import { chatTitle, isListedChat } from "./chats.mjs";
import { activityAgo } from "./chat-row.ts";
import { currentActivityStep, runStatusLabel, stepDisplayTitle } from "./tool-activity.mjs";
import type { AgentRun } from "./agent-runs.mjs";
import type { ChatMessage, CoordinatorState, DiffStat, ModelProvider, PermissionRequest, QuestionRequest } from "./model.ts";

/** A chat's live state, the same marks the sidebar draws; the first that applies wins. */
export type CanvasMark = "question" | "waiting" | "delegated" | "running" | "background" | "unread" | "idle";

export type CanvasChat = {
  id: number;
  title: string;
  mark: CanvasMark;
  provider?: ModelProvider;
  /** When the chat last got a message or a reply ended (ms since epoch). */
  lastAt?: number;
  failed: boolean;
  readOnly?: boolean;
};

export type CanvasWorktree = {
  id: number;
  path: string;
  /** The checked-out branch, or the folder name when HEAD is detached. */
  branch: string;
  diff?: DiffStat;
  /** Oldest first, so a card's rows don't move as chats run. */
  chats: CanvasChat[];
  sharedChat?: { linkId: string; sessionId: number };
};

/**
 * The Worktrees of a Project the canvas shows, in the order they were made: each one with a chat the sidebar lists
 * (not archived, with a message) or a part in a named Link's shared conversation. `markOf` gives a chat's live state from the platform's own runs.
 */
export function canvasWorktrees(state: CoordinatorState | undefined, markOf: (sessionId: number, unread: boolean) => CanvasMark): CanvasWorktree[] {
  if (!state) return [];
  const bySession = new Map<number, ChatMessage[]>();
  if (Object.values(state.sessions).some((session) => !session.summary))
    for (const message of state.messages) {
      const list = bySession.get(message.session_id);
      if (list) list.push(message);
      else bySession.set(message.session_id, [message]);
    }
  const chatsByWorktree = new Map<number, CanvasChat[]>();
  for (const session of Object.values(state.sessions).sort((a, b) => a.id - b.id)) {
    if (session.archived) continue;
    const messages = bySession.get(session.id) ?? [];
    const summary = chatSummary(session, messages);
    const mark = markOf(session.id, Boolean(session.unread));
    if (!isListedChat(session, summary.count, mark === "waiting" || mark === "question")) continue;
    const chat: CanvasChat = {
      id: session.id,
      title: chatTitle(session, messages),
      mark,
      provider: session.provider,
      lastAt: summary.lastAt,
      failed: summary.lastOutcome === "failed",
      ...(session.readOnlyReason ? { readOnly: true } : {}),
    };
    const list = chatsByWorktree.get(session.worktree_id);
    if (list) list.push(chat);
    else chatsByWorktree.set(session.worktree_id, [chat]);
  }
  return Object.values(state.worktrees)
    .sort((a, b) => a.id - b.id)
    .flatMap((worktree) => {
      const chats = chatsByWorktree.get(worktree.id);
      if (!chats && !worktree.sharedChat) return [];
      return [{ id: worktree.id, path: worktree.path, branch: worktree.name, diff: worktree.diff, chats: chats ?? [], sharedChat: worktree.sharedChat }];
    });
}

export type CanvasTone = "accent" | "orange" | "red" | "ink3";

export function canvasStatus(chat: Pick<CanvasChat, "mark" | "lastAt" | "failed" | "readOnly">, now: number): { label: string; tone: CanvasTone } {
  if (chat.readOnly) return { label: "Read-only history", tone: "ink3" };
  const ago = chat.lastAt === undefined ? undefined : activityAgo(chat.lastAt, now);
  const since = ago === undefined ? "" : ago === "now" ? " · just now" : ` · ${ago} ago`;
  switch (chat.mark) {
    case "question":
      return { label: "Asking you", tone: "accent" };
    case "waiting":
      return { label: "Waiting for you", tone: "orange" };
    case "delegated":
      return { label: "Working on a Delegation", tone: "accent" };
    case "running":
      return { label: "Running", tone: "accent" };
    case "background":
      return { label: "Working in the background", tone: "accent" };
    case "unread":
      return chat.failed ? { label: `Failed${since}`, tone: "red" } : { label: `Finished${since}`, tone: "accent" };
    case "idle":
      return chat.failed ? { label: `Failed${since}`, tone: "red" } : { label: `Idle${since}`, tone: "ink3" };
  }
}

/** What a card's outline says: a chat waiting for an approval wins over one asking a question. */
export function canvasAttention(chats: readonly Pick<CanvasChat, "mark">[]): "waiting" | "question" | undefined {
  if (chats.some((chat) => chat.mark === "waiting")) return "waiting";
  if (chats.some((chat) => chat.mark === "question")) return "question";
  return undefined;
}

/** The request a card answers in place: an approval, or a question. `more` wait behind it. */
export type CanvasPending = { kind: "approval"; request: PermissionRequest; more: number } | { kind: "question"; request: QuestionRequest; more: number };

/** What a card shows of a turn while it runs. */
export type CanvasLive = {
  step?: string;
  pending?: CanvasPending;
};

/**
 * A running turn as its card shows it, or undefined with no turn. An approval or question already answered stays in
 * the run until the agent takes it; the card stops offering it as soon as it is answered.
 */
export function canvasLive(run: Pick<AgentRun, "steps" | "approvals" | "questions" | "answered"> | undefined): CanvasLive | undefined {
  if (!run) return undefined;
  const approvals = run.approvals.filter((request) => !(request.requestId in run.answered));
  const questions = run.questions.filter((request) => !(request.requestId in run.answered));
  const more = approvals.length + questions.length - 1;
  const pending: CanvasPending | undefined = approvals[0]
    ? { kind: "approval", request: approvals[0], more }
    : questions[0]
      ? { kind: "question", request: questions[0], more }
      : undefined;
  const running = run.steps.filter((item) => item.status === "running");
  const current = currentActivityStep(run.steps);
  const step = runStatusLabel(run.steps) ?? (running.length > 1 ? `Running ${running.length} calls` : current ? stepDisplayTitle(current, true) : undefined);
  return { ...(step ? { step } : {}), ...(pending ? { pending } : {}) };
}

/** Settings › Church: the switch that turns Chats on the canvas on. Desktop only; the phone's canvas keeps opening the full Chat. */
export const CANVAS_CHATS_LABEL = "Chats on the canvas";
export const CANVAS_CHATS_HINT =
  "A click on a Chat on the canvas opens it in a window beside its card, joined by a line, with its transcript, Stop and a reply field. Open as many as you like; each stays until you close it. A closed card shows the step it is on and answers its approval or question in place. Off: a click opens the full Chat.";

export type CanvasFilter = "all" | "needs-you" | "running";

export function matchesCanvasFilter(mark: CanvasMark, filter: CanvasFilter): boolean {
  if (filter === "needs-you") return mark === "question" || mark === "waiting";
  if (filter === "running") return mark === "running" || mark === "delegated" || mark === "background";
  return true;
}

export function canvasFilterCounts(worktrees: readonly Pick<CanvasWorktree, "chats">[]): Record<CanvasFilter, number> {
  const counts = { all: 0, "needs-you": 0, running: 0 };
  for (const { chats } of worktrees)
    for (const { mark } of chats) {
      counts.all++;
      if (matchesCanvasFilter(mark, "needs-you")) counts["needs-you"]++;
      if (matchesCanvasFilter(mark, "running")) counts.running++;
    }
  return counts;
}
