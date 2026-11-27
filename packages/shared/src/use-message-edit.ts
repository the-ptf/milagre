import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckpointApi, CheckpointDecision, CheckpointFile, CheckpointRewind } from "./checkpoints";
import type { ChatMessage } from "./model";
import { messagesAfter } from "./message-edit.mjs";

export type MessageEdit = {
  messageId: number;
  /** How many messages after the edited one go. */
  removed: number;
  /** Also undo the files the removed turns changed (on by default). */
  undo: boolean;
  /** Those files, once the host could read them; null while a turn runs or before the first read. */
  preview: CheckpointRewind | null;
  decisions: Record<string, CheckpointDecision>;
  loading: boolean;
};

/**
 * Editing a sent message, shared by desktop and phone: which message, what goes with it, and the files its removed turns
 * changed. A file edited after those turns waits for Keep current or Undo before Send. Mount with a key for the Chat.
 */
export function useMessageEdit(api: Pick<CheckpointApi, "rewind">, chatId: string, idle: boolean) {
  const [edit, setEdit] = useState<MessageEdit | null>(null);
  const generation = useRef(0);
  const load = useCallback(
    async (messageId: number) => {
      const current = ++generation.current;
      if (!api.rewind) return void setEdit((value) => value && { ...value, loading: false });
      try {
        const preview = await api.rewind({ chatId, messageId });
        if (generation.current !== current) return;
        setEdit((value) =>
          value?.messageId === messageId
            ? {
                ...value,
                preview: preview && preview.files.length ? preview : null,
                decisions: Object.fromEntries((preview?.files ?? []).filter((file) => !file.conflict).map((file) => [file.key, "restore"])),
                loading: false,
              }
            : value,
        );
      } catch {
        if (generation.current === current) setEdit((value) => value && { ...value, loading: false });
      }
    },
    [api, chatId],
  );
  useEffect(
    () => () => {
      generation.current++;
    },
    [api, chatId],
  );
  useEffect(
    () => {
      // oxlint-disable-next-line react/set-state-in-effect -- the edit belongs to the Chat that just changed.
      setEdit(null);
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reset when the connection or Chat changes.
    [api, chatId],
  );
  const editing = edit?.messageId;
  useEffect(() => {
    // A running turn may still change files: read them again once it ends.
    if (idle && editing !== undefined) void load(editing);
  }, [idle, editing, load]);

  const start = useCallback((message: ChatMessage, messages: readonly ChatMessage[]) => {
    setEdit({ messageId: message.id, removed: messagesAfter(messages, message.id), undo: true, preview: null, decisions: {}, loading: true });
  }, []);
  const cancel = useCallback(() => {
    generation.current++;
    setEdit(null);
  }, []);
  const setUndo = useCallback((undo: boolean) => setEdit((value) => value && { ...value, undo }), []);
  const choose = useCallback(
    (key: string, decision: CheckpointDecision) => setEdit((value) => value && { ...value, decisions: { ...value.decisions, [key]: decision } }),
    [],
  );
  const files: CheckpointFile[] = edit?.preview?.files ?? [];
  const unresolved = Boolean(edit?.undo) && ((idle && edit?.loading) || files.some((file) => file.conflict && !edit?.decisions[file.key]));
  const request = useCallback(
    () => (edit ? { messageId: edit.messageId, undoFiles: edit.undo ? { revision: edit.preview?.revision, decisions: edit.decisions } : null } : null),
    [edit],
  );
  return { edit, files, refresh: () => editing !== undefined && load(editing), unresolved, start, cancel, setUndo, choose, request };
}

export type MessageEditFlow = ReturnType<typeof useMessageEdit>;
