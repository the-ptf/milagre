import type { ChatMessage, WorktreeLinkedContext } from "./model.ts";

export function isWorktreeLinked(message: ChatMessage | undefined): message is ChatMessage & { context: WorktreeLinkedContext };
/** `lead` and `project` are null when absent; `detail` is a branch, or a Worktree count for a whole-Project Link. */
export function worktreeLinkLabel(context: WorktreeLinkedContext): { lead: string | null; project: string | null; detail: string | null };
export function worktreeLinkText(context: WorktreeLinkedContext): string;
export function linkedSummaryText(summary: string): string;
export function linkChatWorktreesLabel(count: number): string;
export const LINK_CHAT_WORKTREES_TEXT: string;
export const LINK_UPDATE_WORKTREES_TEXT: string;
export const LINK_PENDING_WORKTREE_TEXT: string;
export function linkRunningText(titles: string[]): string;
/** The confirmation before a Named Link is deleted, on desktop and phone. `chats` counts its Chats not archived yet. */
export function deleteLinkText(name: string, chats: number): { title: string; message: string; action: string };
/** After a delete: the Worktrees it kept (paths), now Chats in their Projects. Null when it kept none. */
export function deletedLinkText(name: string, kept: string[]): string | null;
/**
 * A failed Link delete as desktop and phone say it: a computer too old to delete Links is asked to update. `computer`
 * names it on desktop ("this Mac", or a paired computer's name); without it, the phone's words for its Mac.
 */
export function linkDeleteFailure(message: string, options?: { computer?: string }): string;
export function isLinkGone(message: string): boolean;
export function isDeletedLinkState(state: object | null | undefined): boolean;
export function linkDeletedElsewhereText(name: string): string;
