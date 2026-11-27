import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard } from "react-native";
import { composerQuote, quotedMessage, splitQuotes, type ComposerQuote } from "@milagre/shared/prompt-parts";
import type { ChatMessage } from "@milagre/shared/model";
import type { CheckpointRewind } from "@milagre/shared/checkpoints";
import { useMessageEdit } from "@milagre/shared/use-message-edit";
import { attachmentPrompt, prepareAttachments } from "./attachments";
import type { Client } from "./client";
import { useComposer } from "./composer";
import { MessageEditCard } from "./message-edit-card";
import { DISABLED_OPACITY } from "./primitives/press-style";
import { SENT_FROM } from "./sent-from";
import { sendOptions, type MobileModel, type TurnPreferences } from "./turn-options";

const DIMMED = { opacity: DISABLED_OPACITY.control };

type Target = { projectPath: string; worktreeId: number; model: MobileModel; preferences: TurnPreferences };

/**
 * Edit message on the phone: the pill under a selected bubble, its toolbar pencil or its VoiceOver action load the message
 * into the composer while the draft waits, the card above the composer says what goes with it, and Send replaces it
 * through `chat:edit`. Desktop's flow is the same (use-composer-edit.tsx). Called before the screen can return early, so
 * what a send needs comes with the send.
 */
export function useChatEdit(
  session: { client: Client | null; snapshot?: { project: { path: string } } | null },
  id: string | undefined,
  messages: readonly ChatMessage[],
  ...busy: unknown[]
) {
  const composer = useComposer();
  const client = session.client;
  const chatId = session.snapshot && id ? `${session.snapshot.project.path}#${id}` : "";
  const running = busy.some(Boolean);
  const api = useMemo(
    () => (client ? { rewind: (request: { chatId: string; messageId: number }) => client.call<CheckpointRewind | null>("checkpoint:rewind", [request]) } : {}),
    [client],
  );
  const flow = useMessageEdit(api, chatId, !running);
  const aside = useRef<{ draft: string; quotes: ComposerQuote[] } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const editingId = flow.edit?.messageId ?? null;
  const after = useMemo(() => {
    const index = editingId === null ? -1 : messages.findIndex((message) => message.id === editingId);
    return new Set(index === -1 ? [] : messages.slice(index + 1).map((message) => message.id));
  }, [messages, editingId]);

  const setDraft = (draft: string, quotes: ComposerQuote[]) => {
    composer.setDrafts((current) => ({ ...current, [chatId]: draft }));
    composer.setQuotes((current) => ({ ...current, [chatId]: quotes }));
  };
  const start = (messageId: number) => {
    const message = messages.find((item) => item.id === messageId);
    if (!message) return;
    const held = composer.readDrafts();
    aside.current ??= { draft: held.drafts[chatId] ?? "", quotes: held.quotes[chatId] ?? [] };
    const { quotes, text } = splitQuotes(message.body);
    setDraft(
      text,
      quotes.flatMap((quote) => composerQuote(quote) ?? []),
    );
    flow.start(message, messages);
    setError("");
  };
  const cancel = () => {
    const kept = aside.current;
    aside.current = null;
    flow.cancel();
    setError("");
    setDraft(kept?.draft ?? "", kept?.quotes ?? []);
  };
  const send = async ({ projectPath, worktreeId, model, preferences }: Target) => {
    const edit = flow.request();
    const held = composer.readDrafts();
    const body = quotedMessage(held.quotes[chatId] ?? [], held.drafts[chatId] ?? "").trim();
    const attachments = held.attachments[chatId] ?? [];
    if (!client || !edit || sending || flow.unresolved || (!body && !attachments.length)) return false;
    setSending(true);
    setError("");
    Keyboard.dismiss();
    try {
      const media = await prepareAttachments(client, projectPath, attachments);
      await client.call("chat:edit", [
        {
          projectPath,
          sessionId: Number(chatId.slice(chatId.lastIndexOf("#") + 1)),
          worktreeId,
          clientMessageId: `edit-${Date.now()}`,
          ...edit,
          body,
          ...media,
          prompt: attachmentPrompt(body, media.files),
          keepAttachments: true,
          ...sendOptions(model, preferences),
          sentFrom: SENT_FROM,
        },
      ]);
      aside.current = null;
      flow.cancel();
      setDraft("", []);
      composer.setAttachments((current) => ({ ...current, [chatId]: [] }));
      return true;
    } catch (failure) {
      void flow.refresh();
      setError(`Could not edit the message: ${failure instanceof Error ? failure.message : String(failure)}`);
      return false;
    } finally {
      setSending(false);
    }
  };
  // Another device edited or removed the message: there is nothing left to replace.
  useEffect(() => {
    if (editingId !== null && !messages.some((message) => message.id === editingId)) flow.cancel();
  }, [editingId, messages, flow]);

  return {
    editing: editingId !== null,
    composer: (blocked: boolean) =>
      editingId === null
        ? { sendBlocked: blocked }
        : { running: false, sendBlocked: Boolean(blocked || sending || flow.unresolved), sendLabel: "Send edited message" },
    send,
    cancel,
    row: (message: ChatMessage, highlighted: boolean, chat: { readOnlyReason?: string } | null | undefined, offline: boolean) => ({
      onEdit: chat?.readOnlyReason || offline ? undefined : start,
      highlighted: highlighted || message.id === editingId,
    }),
    dimmed: (message: ChatMessage) => (after.has(message.id) ? DIMMED : undefined),
    card: editingId !== null && <MessageEditCard flow={flow} running={running} sending={sending} error={error} onCancel={cancel} />,
  };
}
