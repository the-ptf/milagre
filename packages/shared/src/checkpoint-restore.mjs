// The line a Chat shows after Undo changes wrote files (context kind "checkpoint-restore"). Types: checkpoint-restore.d.mts.

const files = (count) => `${count} ${count === 1 ? "file" : "files"}`;

/** "Undid 2 files", or "Redid 2 files" when the restore put back what an earlier undo replaced. */
export function checkpointRestoreText(context) {
  return `${context.redo ? "Redid" : "Undid"} ${files(context.restored)}`;
}

/** The divider's button: it previews the recovery checkpoint saved before those writes. */
export function checkpointRestoreAction(context) {
  return context.redo ? "Undo" : "Redo";
}

export function isCheckpointRestore(message) {
  return message?.context?.kind === "checkpoint-restore";
}
