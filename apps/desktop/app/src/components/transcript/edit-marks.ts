import { isMessageEdit } from "@milagre/shared/message-edit";
import type { ChatMessage } from "../../model";

/** Editing a sent message from the transcript: the pencil's action, and the message being edited. */
export type TranscriptEdit = { onEdit?: (messageId: number) => void; editingId: number | null };

/** What each message shows while one is edited: the edited bubble outlined, every message after it dimmed. */
export function editMarks(edit: TranscriptEdit | undefined, transcript: readonly { message: ChatMessage }[], offline: boolean) {
  const editingId = edit?.editingId ?? null;
  const editingIndex = editingId === null ? -1 : transcript.findIndex((entry) => entry.message.id === editingId);
  const after = new Set(editingIndex === -1 ? [] : transcript.slice(editingIndex + 1).map((entry) => entry.message));
  const marks = (message: ChatMessage) => ({
    onEdit: offline ? undefined : edit?.onEdit,
    editing: editingId !== null && message.id === editingId,
    dimmed: after.has(message),
  });
  return Object.assign(marks, { divider: isMessageEdit });
}
