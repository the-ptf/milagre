import type { ChatMessage, CheckpointRestoreContext } from "./model.ts";

export function checkpointRestoreText(context: CheckpointRestoreContext): string;
export function checkpointRestoreAction(context: CheckpointRestoreContext): string;
export function isCheckpointRestore(message: ChatMessage | null | undefined): message is ChatMessage & { context: CheckpointRestoreContext };
