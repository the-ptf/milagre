const files = (count) => `${count} ${count === 1 ? "file" : "files"}`;

export function checkpointRestoreText(context) {
  return `${context.redo ? "Redid" : "Undid"} ${files(context.restored)}`;
}

export function checkpointRestoreAction(context) {
  return context.redo ? "Undo" : "Redo";
}

export function isCheckpointRestore(message) {
  return message?.context?.kind === "checkpoint-restore";
}
