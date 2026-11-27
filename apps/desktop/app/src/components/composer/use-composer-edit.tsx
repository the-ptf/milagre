import { useEffect, useMemo, useRef, useState } from "react";
import { useMessageEdit } from "@milagre/shared/use-message-edit";
import { effortFor } from "@milagre/shared/model-options";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";
import { bridgeForKey } from "../../lib/computer-bridge";
import { prepareImageUploads, prepareLocalFileUploads } from "../../lib/attachment-uploads";
import { attachmentPrompt } from "../../lib/media";
import { getSettings } from "../../lib/settings";
import { isModalOpen } from "../../lib/modal";
import { useEvent } from "../../lib/stable";
import type { ChatComposerProps } from "./chat-composer-props";
import { MessageEditCard } from "./MessageEditCard";

const NO_CHECKPOINTS = {};

type Options = Pick<
  ChatComposerProps,
  "session" | "messages" | "projectPath" | "store" | "imageDraft" | "selectedModel" | "capability" | "effort" | "permissionMode" | "ultracode" | "fastMode"
> & {
  runtimeChat: string | null;
  worktreeId?: number;
  running: boolean;
  readOnly?: boolean;
  offlineName?: string | null;
  focus: (atEnd?: boolean) => void;
  onOpenFile?: (path: string, worktree: string) => void;
};

/**
 * Edit message on desktop: the pencil loads a sent message into the composer (the draft waits and comes back on Cancel or
 * Esc), the card above the composer says what goes with it, and Send replaces it through `chat:edit`.
 */
export function useComposerEdit(options: Options) {
  const { messages, projectPath, store, imageDraft, runtimeChat, running } = options;
  const blocked = Boolean(options.readOnly || options.session?.archived || options.offlineName);
  const api = runtimeChat ? (bridgeForKey(runtimeChat).checkpoints ?? NO_CHECKPOINTS) : NO_CHECKPOINTS;
  const flow = useMessageEdit(api, runtimeChat ?? "", !running);
  const aside = useRef<{ text: string; quotes: readonly ComposerQuote[] } | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const editingId = flow.edit?.messageId ?? null;

  const start = useEvent((messageId: number) => {
    const message = messages.find((item) => item.id === messageId);
    if (!message || blocked) return;
    if (!aside.current) aside.current = { text: store.text(), quotes: store.quotes() };
    store.set(message.body);
    flow.start(message, messages);
    setError("");
    options.focus(true);
  });
  const cancel = useEvent(() => {
    const kept = aside.current;
    aside.current = null;
    flow.cancel();
    setError("");
    store.setText(kept?.text ?? "");
    store.setQuotes(kept?.quotes ?? []);
  });
  const send = useEvent(async () => {
    const edit = flow.request();
    const body = store.get().trim();
    const { images, files } = imageDraft;
    if (blocked || !edit || !runtimeChat || sending || flow.unresolved || imageDraft.loading || (!body && !images.length && !files.length)) return;
    setSending(true);
    setError("");
    try {
      const uploadedFiles = await prepareLocalFileUploads(projectPath, files, images, imageDraft.localFiles);
      const uploadedImages = await prepareImageUploads(projectPath, images);
      const model = options.selectedModel;
      await bridgeForKey(projectPath).editMessage({
        projectPath,
        sessionId: Number(runtimeChat.slice(runtimeChat.lastIndexOf("#") + 1)),
        worktreeId: options.worktreeId ?? 0,
        clientMessageId: crypto.randomUUID(),
        ...edit,
        body,
        images: uploadedImages,
        files: uploadedFiles,
        prompt: attachmentPrompt(body, uploadedFiles),
        keepAttachments: true,
        provider: model.provider,
        model: model.id,
        permissionMode: options.permissionMode,
        effort: options.effort ? effortFor(options.capability, options.effort) : undefined,
        ultracode: options.capability.ultracode && options.ultracode,
        fastMode: options.capability.fastMode && options.fastMode,
        replies: getSettings().claudeReplies,
        tldrEnabled: getSettings().tldrEnabled,
      });
      aside.current = null;
      flow.cancel();
      store.setText("");
      store.setQuotes([]);
      imageDraft.clear();
    } catch (failure) {
      void flow.refresh();
      setError(`Could not edit the message: ${ipcErrorMessage(failure)}`);
    } finally {
      setSending(false);
    }
  });

  useEffect(() => {
    if (editingId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isModalOpen() || document.querySelector("[data-popover-open]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editingId, cancel]);
  useEffect(() => {
    // Another device edited or removed the message: there is nothing left to replace.
    if (editingId !== null && !messages.some((message) => message.id === editingId)) cancel();
  }, [editingId, messages, cancel]);

  const onEdit = runtimeChat && !blocked ? start : undefined;
  const transcript = useMemo(() => ({ onEdit, editingId }), [onEdit, editingId]);
  return {
    editing: editingId !== null,
    composer: (blocked: boolean) =>
      editingId === null ? { running, sendBlocked: blocked } : { running: false, sendBlocked: Boolean(blocked || sending || flow.unresolved) },
    send,
    transcript,
    card: editingId !== null && (
      <MessageEditCard flow={flow} running={running} sending={sending} error={error} onCancel={cancel} onOpenFile={options.onOpenFile} />
    ),
  };
}
