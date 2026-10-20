// What the Projects canvas shows, shared by the desktop canvas and the phone's: the chats the sidebar lists, grouped by
// Worktree, each with its live state. A Worktree whose chats are all archived (or never started) stays off the canvas.

import { chatSummary } from "./chat-summary.mjs";
import { chatTitle, isListedChat } from "./chats.mjs";
import { activityAgo } from "./chat-row.ts";
import type { ChatMessage, CoordinatorState, DiffStat, ModelProvider } from "./model.ts";

/** A chat's live state, the same marks the sidebar draws; the first that applies wins. */
export type CanvasMark = "question" | "waiting" | "delegated" | "running" | "background" | "unread" | "idle";

export type CanvasChat = {
  id: number;
  title: string;
  mark: CanvasMark;
  provider?: ModelProvider;
  /** When the chat last got a message or a reply ended (ms since epoch). */
  lastAt?: number;
  /** Its last reply failed. */
  failed: boolean;
};

export type CanvasWorktree = {
  id: number;
  path: string;
  /** The checked-out branch, or the folder name when HEAD is detached. */
  branch: string;
  diff?: DiffStat;
  /** Oldest first, so a card's rows don't move as chats run. */
  chats: CanvasChat[];
  /** The named Link's conversation this Worktree takes part in. */
  sharedChat?: { linkId: string; sessionId: number };
};

/**
 * The Worktrees of a Project the canvas shows, in the order they were made: each one with a chat the sidebar lists
 * (not archived, with a message) or a part in a named Link's shared conversation. `markOf` gives a chat's live state from the platform's own runs.
 */
export function canvasWorktrees(state: CoordinatorState | undefined, markOf: (sessionId: number, unread: boolean) => CanvasMark): CanvasWorktree[] {
  if (!state) return [];
  // Chats carry a summary of their messages; only an older host's state, without one, is read message by message.
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
    // A hidden Run Chat shows only while it waits on someone.
    if (!isListedChat(session, summary.count, mark === "waiting" || mark === "question")) continue;
    const chat: CanvasChat = {
      id: session.id,
      title: chatTitle(session, messages),
      mark,
      provider: session.provider,
      lastAt: summary.lastAt,
      failed: summary.lastOutcome === "failed",
    };
    const list = chatsByWorktree.get(session.worktree_id);
    if (list) list.push(chat);
    else chatsByWorktree.set(session.worktree_id, [chat]);
  }
  return Object.values(state.worktrees)
    .sort((a, b) => a.id - b.id)
    .flatMap((worktree) => {
      // A Worktree in a named Link's conversation stays too: that Chat lives in the Link, not in this Project.
      const chats = chatsByWorktree.get(worktree.id);
      if (!chats && !worktree.sharedChat) return [];
      return [{ id: worktree.id, path: worktree.path, branch: worktree.name, diff: worktree.diff, chats: chats ?? [], sharedChat: worktree.sharedChat }];
    });
}

/** The tone a status draws in: the sidebar's palette (`chatMarkTone`), with a failed idle chat in red. */
export type CanvasTone = "accent" | "orange" | "red" | "ink3";

/** The words under a chat's title: what it's doing now, or how long it has been quiet. */
export function canvasStatus(chat: Pick<CanvasChat, "mark" | "lastAt" | "failed">, now: number): { label: string; tone: CanvasTone } {
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

/** The canvas's status filter. */
export type CanvasFilter = "all" | "needs-you" | "running";

export function matchesCanvasFilter(mark: CanvasMark, filter: CanvasFilter): boolean {
  if (filter === "needs-you") return mark === "question" || mark === "waiting";
  if (filter === "running") return mark === "running" || mark === "delegated" || mark === "background";
  return true;
}

/** How many chats each filter keeps, for the counts beside its labels. */
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
