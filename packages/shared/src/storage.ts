import { lossReason, type WorktreeStatus } from "./archive.mjs";
import { formatDisk } from "./computer-resources.ts";
import { ipcErrorMessage } from "./result.mjs";

export type IdleWorktree = {
  projectPath: string;
  /** "milagre-ade", or "No project" for the Chats home. */
  projectName: string;
  path: string;
  branch: string | null;
  title: string;
  chats: number;
  lastAt: number;
  idleBefore: number;
  activity: { worktreeId: number; chats: { id: number; lastAt: number | null; lastId: number | null; count: number }[] };
  /** Its size at the host's last measure; null before one. */
  bytes: number | null;
  status: WorktreeStatus;
};

export type IdleWorktrees = { worktrees: IdleWorktree[]; measuredAt: number | null };

export const CLEANUP_TITLE = "Clean up worktrees";
export const CLEANUP_BUTTON = "Clean up worktrees…";
export const CLEANUP_INTRO = "Worktrees Milagre made that no Chat has used for a while. Their Chats are deleted with them.";
export const SAVED_GROUP = "No unsaved work";
export const UNSAVED_GROUP = "Unsaved work";
export const STORAGE_COMMAND = "storage";
export const STORAGE_COMMAND_HINT = "Clean up old worktrees on this computer";

/** How long a worktree must have sat unused, in days: the dialog's choice. */
export const IDLE_DAYS = [30, 60, 90] as const;
export type IdleDays = (typeof IDLE_DAYS)[number];
const DAY = 24 * 60 * 60_000;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The worktrees unused for at least `days`, oldest first. */
export function idleFor(list: readonly IdleWorktree[], days: IdleDays, now: number): IdleWorktree[] {
  const cutoff = now - days * DAY;
  const kept = list.filter((item) => item.lastAt <= cutoff).map((item) => ({ ...item, idleBefore: Math.min(item.idleBefore, cutoff) }));
  // Hermes has no toSorted.
  return [...kept].sort((a, b) => a.lastAt - b.lastAt);
}

export const savedWork = (item: IdleWorktree) => item.status.removable;

export function cleanupGroups(list: readonly IdleWorktree[]): { saved: IdleWorktree[]; unsaved: IdleWorktree[] } {
  return { saved: list.filter(savedWork), unsaved: list.filter((item) => !savedWork(item)) };
}

const sizeOf = (list: readonly IdleWorktree[]) => list.reduce((total, item) => total + (item.bytes ?? 0), 0);
const measured = (list: readonly IdleWorktree[]) => list.length > 0 && list.every((item) => item.bytes !== null);

export function groupLine(list: readonly IdleWorktree[]): string {
  if (!list.length) return "None";
  return measured(list) ? `${plural(list.length, "worktree")} · ${formatDisk(sizeOf(list))}` : plural(list.length, "worktree");
}

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

export const rowSize = (item: IdleWorktree) => (item.bytes === null ? "—" : formatDisk(item.bytes));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 18", with the year when it isn't this one. No Intl: Hermes lacks parts of it. */
export function rowDate(lastAt: number, now: number): string {
  const date = new Date(lastAt);
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

export function rowDetail(item: IdleWorktree): string {
  return savedWork(item) ? item.projectName : `${item.projectName} · ${lossReason(item.status)}`;
}

export const rowLabel = (item: IdleWorktree, now: number) => `${item.title}, ${rowDetail(item)}, last used ${rowDate(item.lastAt, now)}, ${rowSize(item)}`;

export const progressLine = (done: number, total: number) => `${done} of ${total} removed…`;

export function cleanupToast({ removed, failed, stopped }: { removed: number; failed: string[]; stopped: boolean }): string {
  const head = removed ? `Removed ${plural(removed, "worktree")}.` : "No worktree was removed.";
  const stop = stopped ? " Stopped before the rest." : "";
  if (!failed.length) return `${head}${stop}`;
  return `${head}${stop} ${failed.length === 1 ? `One was kept: ${failed[0]}` : `${failed.length} were kept. ${failed[0]}`}`;
}

export type RemoveWorktree = (request: {
  projectPath: string;
  path: string;
  seen: WorktreeStatus;
  force: boolean;
  activity: IdleWorktree["activity"];
  idleBefore: number;
  lastAt: number;
}) => Promise<unknown>;

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
      await remove({
        projectPath: item.projectPath,
        path: item.path,
        seen: item.status,
        force: !savedWork(item),
        activity: item.activity,
        idleBefore: item.idleBefore,
        lastAt: item.lastAt,
      });
      removed += 1;
    } catch (error) {
      failed.push(`${item.title}: ${ipcErrorMessage(error)}`);
    }
    done += 1;
    onProgress?.(done);
  }
  return { removed, failed, stopped: false };
}
