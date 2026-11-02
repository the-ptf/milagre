import type { ChatMessage, WorktreeLinkedContext } from "./model.ts";

export function isWorktreeLinked(message: ChatMessage | undefined): message is ChatMessage & { context: WorktreeLinkedContext };
/** `lead` and `project` are null when absent; `detail` is a branch, or a Worktree count for a whole-Project Link. */
export function worktreeLinkLabel(context: WorktreeLinkedContext): { lead: string | null; project: string | null; detail: string | null };
export function worktreeLinkText(context: WorktreeLinkedContext): string;
/** The linked summary as the line opens it: without the tags that wrap it for the agent. */
export function linkedSummaryText(summary: string): string;
/** "No Worktree yet", "1 Worktree" or "N Worktrees": a shared Link Chat gives a Project its Worktree only when it changes it. */
export function linkChatWorktreesLabel(count: number): string;
export const LINK_CHAT_WORKTREES_TEXT: string;
export const LINK_UPDATE_WORKTREES_TEXT: string;
export const LINK_PENDING_WORKTREE_TEXT: string;
/** "A is running. Stop it before deleting the Link.", or "A and B are running…": the daemon refuses a delete with it. */
export function linkRunningText(titles: string[]): string;
/** The confirmation before a Named Link is deleted, on desktop and phone. `chats` counts its Chats not archived yet. */
export function deleteLinkText(name: string, chats: number): { title: string; message: string; action: string };
/** After a delete: the Worktrees it kept (paths), now Chats in their Projects. Null when it kept none. */
export function deletedLinkText(name: string, kept: string[]): string | null;
