import type { PermissionMode } from "./model.js";

export type Checkpoint = {
  id: string;
  createdAt: number;
  completedAt?: number;
  kind: "task" | "recovery";
  permissionMode: PermissionMode;
  excluded: number;
  /** The user message that started the task; a recovery checkpoint keeps the one of the task it undid. */
  messageId?: number;
  /** That message's text, cut to 300 characters. */
  prompt?: string;
  /** How many files the task changed, once it ended. */
  changed?: number;
};
export type CheckpointFile = {
  key: string;
  path: string;
  worktree: string;
  action: "create" | "replace" | "delete";
  conflict: boolean;
};
export type CheckpointPreview = Checkpoint & { token: string; files: CheckpointFile[] };
export type CheckpointDecision = "keep" | "restore";
export type CheckpointRestore = { chatId: string; token: string; decisions: Record<string, CheckpointDecision>; approved: boolean };
export type CheckpointRestoreResult = { restored: number; recoveryId: string | null; kept: number; checkpointId: string; redo: boolean };
export type CheckpointApi = {
  list(request: { chatId: string }): Promise<Checkpoint[]>;
  preview(request: { chatId: string; id: string }): Promise<CheckpointPreview>;
  restore(request: CheckpointRestore): Promise<CheckpointRestoreResult>;
};

/** The tasks Undo changes offers, newest first: ones that changed files, or that ended without a final capture. */
export const undoableTasks = (items: Checkpoint[]) => items.filter((item) => item.kind === "task" && (item.changed === undefined || item.changed > 0));

const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

/** "8:00 AM" today, "Yesterday", else the date. */
export function checkpointTime(at: number, now = Date.now()) {
  const date = new Date(at),
    today = new Date(now);
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86400000);
  if (days === 0) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The task as one line: the first line of what the user wrote. */
export const checkpointTask = (item: Checkpoint) =>
  item.prompt
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim() || "Task";

/** "3 files · 8:00 AM"; a task that never got its final capture says so. */
export function checkpointMeta(item: Checkpoint, now = Date.now()) {
  const files = item.changed === undefined ? "Interrupted" : `${item.changed} ${item.changed === 1 ? "file" : "files"}`;
  return `${files} · ${checkpointTime(item.createdAt, now)}`;
}

/** What undoing does to a file: the task edited it, created it, or deleted it. */
export const checkpointEffect = (file: CheckpointFile) => (file.action === "replace" ? "Revert" : file.action === "delete" ? "Delete" : "Restore");

/** "login.ts" and "src/auth". */
export function splitCheckpointPath(path: string) {
  const at = path.lastIndexOf("/");
  return { name: path.slice(at + 1), dir: at < 0 ? "" : path.slice(0, at) };
}
