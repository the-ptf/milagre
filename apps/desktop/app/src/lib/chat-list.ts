import { chatSummary } from "@milagre/shared/chat-summary";
import type { AgentSession, ChatMessage, LinkChatSession } from "../model";
import { comparePins, isListedChat } from "@milagre/shared/chats";
export { chatTitle, pinOrderAt } from "@milagre/shared/chats";

/**
 * Whether the sidebar lists a Chat: it has a message to show, and it isn't a hidden Run Chat, unless that one waits on
 * an approval or a question (`waiting`), which it shows until it is answered.
 */
export function isChatListed(session: AgentSession | LinkChatSession, sessionMessages: readonly ChatMessage[], waiting: boolean): boolean {
  return isListedChat(session, chatSummary(session, sessionMessages).count, waiting);
}

/** What the mark at the left of a chat row shows; the first that applies wins. */
export type ChatMark = "question" | "waiting" | "delegated" | "running" | "background" | "unread" | "idle";

/**
 * `delegated`: a Delegation from another Chat is queued or running here. `background`: the Chat's activity is
 * background (chat-activity.mjs): its turn ended, but background agents still work and will wake it.
 */
export function chatMark({
  asking = false,
  waiting,
  delegated = false,
  running,
  background = false,
  unread,
}: {
  asking?: boolean;
  waiting: boolean;
  delegated?: boolean;
  running: boolean;
  background?: boolean;
  unread: boolean;
}): ChatMark {
  if (asking) return "question";
  if (waiting) return "waiting";
  if (delegated) return "delegated";
  if (running) return "running";
  if (background) return "background";
  if (unread) return "unread";
  return "idle";
}

/** How the sidebar orders chats: by when they started, or by their latest message. Newest first either way. */
export type ChatOrder = "created" | "recent";

/**
 * Pinned chats first, in their manual order, so a finishing turn never moves them; then the rest newest first.
 * Message ids only grow, so a chat's first message dates its start and its last one its latest activity.
 */
export function orderChats<T extends { session: Pick<AgentSession, "pinned" | "pin_order" | "summary">; sessionMessages: readonly ChatMessage[] }>(
  chats: T[],
  order: ChatOrder,
): T[] {
  const key = (chat: T) => {
    const summary = chatSummary(chat.session, chat.sessionMessages);
    return (order === "recent" ? summary.lastId : summary.firstId) ?? 0;
  };
  return [...chats].sort((a, b) => comparePins(a.session, b.session) || key(b) - key(a));
}

/** Where a dragged chat lands on a row: on the line above or below it, or on the row itself. */
export type DropZone = "before" | "after" | "on";
/** What dropping does. `link` links the two chats' Worktrees; `none` leaves everything as it is. */
export type DropIntent = "reorder" | "pin" | "unpin" | "link" | "none" | { invalid: "same-worktree" | "linked" };

/**
 * What dropping `source` at `zone` of `target` does. A null target is the empty Pinned section.
 * `linked`: a Link already joins the two chats' Worktrees.
 */
export function dropIntent(
  source: { pinned?: boolean; worktree?: string },
  target: { pinned?: boolean; worktree?: string } | null,
  zone: DropZone,
  linked = false,
): DropIntent {
  if (!target) return source.pinned ? "none" : "pin";
  if (zone === "on") {
    if (source.worktree && source.worktree === target.worktree) return { invalid: "same-worktree" };
    return linked ? { invalid: "linked" } : "link";
  }
  if (target.pinned) return source.pinned ? "reorder" : "pin";
  return source.pinned ? "unpin" : "none";
}

/** A line count in a few characters: 980, 2.1k, 14k, 2.1m. */
export function formatLineCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trimDecimal(count / 1000)}k`;
  return `${trimDecimal(count / 1_000_000)}m`;
}

function trimDecimal(value: number) {
  return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}

/** The folder name at the end of a path. */
export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}
