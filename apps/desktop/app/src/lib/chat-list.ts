import { chatSummary } from "@milagre/shared/chat-summary";
import type { AgentSession, ChatMessage, LinkChatSession } from "../model";
import { comparePins, isListedChat } from "@milagre/shared/chats";
export { chatTitle, fullChatTitle, pinOrderAt } from "@milagre/shared/chats";

export function isChatListed(session: AgentSession | LinkChatSession, sessionMessages: readonly ChatMessage[], waiting: boolean): boolean {
  return isListedChat(session, chatSummary(session, sessionMessages).count, waiting);
}

export type ChatMark = "question" | "waiting" | "delegated" | "running" | "interrupted" | "background" | "unread" | "idle";

export function chatMark({
  asking = false,
  waiting,
  delegated = false,
  running,
  interrupted = false,
  background = false,
  unread,
}: {
  asking?: boolean;
  waiting: boolean;
  delegated?: boolean;
  running: boolean;
  interrupted?: boolean;
  background?: boolean;
  unread: boolean;
}): ChatMark {
  if (asking) return "question";
  if (waiting) return "waiting";
  if (delegated) return "delegated";
  if (running) return "running";
  if (interrupted) return "interrupted";
  if (background) return "background";
  if (unread) return "unread";
  return "idle";
}

export type ChatOrder = "created" | "recent";

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

export type DropZone = "before" | "after" | "on";
export type DropIntent = "reorder" | "pin" | "unpin" | "link" | "none" | { invalid: "same-worktree" | "linked" };

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

export function formatLineCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trimDecimal(count / 1000)}k`;
  return `${trimDecimal(count / 1_000_000)}m`;
}

function trimDecimal(value: number) {
  return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}

export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}
