// Clean up worktrees, from What Milagre uses on the desktop's Settings › Devices and the phone's computer page, and the
// /storage command that opens it. The host lists its idle worktrees (core storage-worktrees.cjs); this groups, words and
// removes them the same way on both platforms.
import { lossReason, type WorktreeStatus } from "./archive.mjs";
import { formatDisk } from "./computer-resources.ts";
import { ipcErrorMessage } from "./result.mjs";

/** One worktree Milagre made that no Chat has used for 30 days or more, as `storage:worktrees` lists it. */
export type IdleWorktree = {
  projectPath: string;
  /** "milagre-ade", or "No project" for the Chats home. */
  projectName: string;
  path: string;
  branch: string | null;
  /** Its newest Chat's name, else its branch. */
  title: string;
  /** How many Chats are on it; they go with it. */
  chats: number;
  /** Its newest Chat's last message, or the folder's last change. */
  lastAt: number;
  /** Its size at the host's last measure; null before one. */
  bytes: number | null;
  /** What removing it loses, as the host saw it: the removal is checked against it. */
  status: WorktreeStatus;
};

export type IdleWorktrees = { worktrees: IdleWorktree[]; measuredAt: number | null };

export const CLEANUP_TITLE = "Clean up worktrees";
export const CLEANUP_BUTTON = "Clean up worktrees…";
/** What the dialog says it does, under its title. */
export const CLEANUP_INTRO = "Worktrees Milagre made that no Chat has used for a while. Their Chats are deleted with them.";
export const SAVED_GROUP = "No unsaved work";
export const UNSAVED_GROUP = "Unsaved work";
/** The composer command that opens What Milagre uses for the Chat's computer. */
export const STORAGE_COMMAND = "storage";
export const STORAGE_COMMAND_HINT = "See disk use on this computer and clean up old worktrees";

/** How long a worktree must have sat unused, in days: the dialog's choice. */
export const IDLE_DAYS = [30, 60, 90] as const;
export type IdleDays = (typeof IDLE_DAYS)[number];
const DAY = 24 * 60 * 60_000;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The worktrees unused for at least `days`, oldest first. */
export function idleFor(list: readonly IdleWorktree[], days: IdleDays, now: number): IdleWorktree[] {
  const cutoff = now - days * DAY;
  const kept = list.filter((item) => item.lastAt <= cutoff);
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a copy; toSorted crashes on the phone (Hermes)
  return [...kept].sort((a, b) => a.lastAt - b.lastAt);
}

/** Whether removing it keeps everything: git sees nothing uncommitted or unpushed, and it is on a branch. */
export const savedWork = (item: IdleWorktree) => item.status.removable;

/** The two groups the dialog shows: removed safely, and removed only with what they hold. */
export function cleanupGroups(list: readonly IdleWorktree[]): { saved: IdleWorktree[]; unsaved: IdleWorktree[] } {
  return { saved: list.filter(savedWork), unsaved: list.filter((item) => !savedWork(item)) };
}

const sizeOf = (list: readonly IdleWorktree[]) => list.reduce((total, item) => total + (item.bytes ?? 0), 0);
const measured = (list: readonly IdleWorktree[]) => list.length > 0 && list.every((item) => item.bytes !== null);

/** "3 worktrees · 2.1 GB", the size left out while any isn't measured yet. */
export function groupLine(list: readonly IdleWorktree[]): string {
  if (!list.length) return "None";
  return measured(list) ? `${plural(list.length, "worktree")} · ${formatDisk(sizeOf(list))}` : plural(list.length, "worktree");
}

/** The line above the buttons: what is selected and what goes with it. */
export function selectionLine(selected: readonly IdleWorktree[]): string {
  if (!selected.length) return "Choose the worktrees to remove.";
  const size = measured(selected) ? ` · ${formatDisk(sizeOf(selected))}` : "";
  const chats = selected.reduce((total, item) => total + item.chats, 0);
  const unsaved = selected.filter((item) => !savedWork(item)).length;
  const loses = unsaved ? ` Unsaved work in ${plural(unsaved, "worktree")} is lost.` : "";
  const them = selected.length === 1 ? "it" : "them";
  const goes = chats ? `${plural(chats, "Chat")} on ${them} ${chats === 1 ? "is" : "are"} deleted too.` : `No Chat is on ${them}.`;
  return `${plural(selected.length, "worktree")} selected${size}. ${goes}${loses}`;
}

export const removeLabel = (count: number) => (count ? `Remove ${plural(count, "worktree")}` : "Remove");

/** The row's size, or a dash before the host measured it. */
export const rowSize = (item: IdleWorktree) => (item.bytes === null ? "—" : formatDisk(item.bytes));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** When it was last used: "Sep 18", with the year when it isn't this one ("Sep 18, 2025"). No Intl: Hermes lacks parts of it. */
export function rowDate(lastAt: number, now: number): string {
  const date = new Date(lastAt);
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

/** The row's second line: its Project, and what removing it loses when that isn't nothing. */
export function rowDetail(item: IdleWorktree): string {
  return savedWork(item) ? item.projectName : `${item.projectName} · ${lossReason(item.status)}`;
}

/** The row's spoken name, for screen readers on both platforms. */
export const rowLabel = (item: IdleWorktree, now: number) => `${item.title}, ${rowDetail(item)}, last used ${rowDate(item.lastAt, now)}, ${rowSize(item)}`;

/** The progress line while removing: "1 of 3 removed…". */
export const progressLine = (done: number, total: number) => `${done} of ${total} removed…`;

/** The toast once it ends. */
export function cleanupToast({ removed, failed, stopped }: { removed: number; failed: string[]; stopped: boolean }): string {
  const head = removed ? `Removed ${plural(removed, "worktree")}.` : "No worktree was removed.";
  const stop = stopped ? " Stopped before the rest." : "";
  if (!failed.length) return `${head}${stop}`;
  return `${head}${stop} ${failed.length === 1 ? `One was kept: ${failed[0]}` : `${failed.length} were kept. ${failed[0]}`}`;
}

export type RemoveWorktree = (request: { projectPath: string; path: string; seen: WorktreeStatus; force: boolean }) => Promise<unknown>;

/**
 * Removes the chosen worktrees one at a time, so the dialog shows progress and Stop takes effect before the next one.
 * A worktree with unsaved work goes only forced against the status the user saw; one that changed since is kept. Resolves
 * with how many went and why each kept one stayed.
 */
export async function removeIdleWorktrees(
  selected: readonly IdleWorktree[],
  remove: RemoveWorktree,
  { onProgress, stopped }: { onProgress?: (done: number) => void; stopped?: () => boolean } = {},
): Promise<{ removed: number; failed: string[]; stopped: boolean }> {
  let removed = 0;
  const failed: string[] = [];
  let done = 0;
  for (const item of selected) {
    if (stopped?.()) return { removed, failed, stopped: true };
    try {
      await remove({ projectPath: item.projectPath, path: item.path, seen: item.status, force: !savedWork(item) });
      removed += 1;
    } catch (error) {
      failed.push(`${item.title}: ${ipcErrorMessage(error)}`);
    }
    done += 1;
    onProgress?.(done);
  }
  return { removed, failed, stopped: false };
}
