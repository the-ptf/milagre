import type { ChatMessage } from "./model.ts";

/**
 * Undo changes wrote files: `restored` of them went back to how they were before the task (`checkpointId`), `kept` stayed
 * as they were. `recoveryId` is the checkpoint saved just before, which the line's Redo previews. `redo` marks restoring
 * such a recovery checkpoint, which puts the files back again.
 */
export type CheckpointRestoreContext = {
  kind: "checkpoint-restore";
  checkpointId: string;
  recoveryId: string;
  restored: number;
  kept: number;
  redo: boolean;
};

export function checkpointRestoreText(context: CheckpointRestoreContext): string;
export function checkpointRestoreAction(context: CheckpointRestoreContext): string;
export function isCheckpointRestore(message: ChatMessage | null | undefined): message is ChatMessage & { context: CheckpointRestoreContext };
