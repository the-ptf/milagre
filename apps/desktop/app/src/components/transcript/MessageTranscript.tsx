import { SubchatMessage } from "../agents/SubchatMessages";
import { hiddenSubchatNotes, subchatNote } from "../../lib/subchat-transcript";
import { suggestionOutcomes } from "@milagre/shared/subchat-escalation";
import { useEvent } from "../../lib/stable";
import { useRunText } from "../../lib/agent-runs-store";
import { type ContextType, Fragment, memo, startTransition, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage as AppChatMessage, ChatStep } from "../../model";
import { Button } from "../primitives/Button";
import { InlineError } from "../primitives/InlineError";
import { groupQuietRuns, isRoutineRun, routineRunOf } from "@milagre/shared/routines";
import { RoutineRunDivider } from "../RoutineRunDivider";
import { isCheckpointRestore } from "@milagre/shared/checkpoint-restore";
import { type UndoIntent } from "../checkpoints/UndoPanel";
import { foldLinkedExchanges } from "@milagre/shared/linked-message";
import { MessageFollowContext, TRANSCRIPT_END_EVENT, TRANSCRIPT_SHOWN_EVENT } from "../agents/message-scroller";
import { MessageSection } from "./MessageSection";
import type { ChatComposerProps } from "../composer/chat-composer-props";

const TAIL_FIRST = 6;

const PAGE = 40;

function useTailFirst(chatId: number | string, length: number, following: ContextType<typeof MessageFollowContext>) {
  const [fullChat, setFullChat] = useState<number | string | null>(null);
  const cut = fullChat !== chatId && length > TAIL_FIRST;
  useEffect(() => {
    if (fullChat !== chatId) startTransition(() => setFullChat(chatId));
  }, [fullChat, chatId]);
  const tailMarker = useRef<HTMLSpanElement>(null);
  const expanding = useRef<{ viewport: HTMLElement; anchor: Element | null; top: number; short: boolean } | null>(null);
  useLayoutEffect(() => {
    if (cut) {
      const viewport = tailMarker.current?.closest<HTMLElement>('[aria-label="Conversation"]');
      if (!viewport) {
        setFullChat(chatId);
        return;
      }
      const anchor = tailMarker.current?.nextElementSibling ?? null;
      const top = anchor ? anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop : 0;
      const short = viewport.scrollHeight <= viewport.clientHeight;
      expanding.current = { viewport, anchor, top, short };
      if (short) setFullChat(chatId);
      return;
    }
    const pending = expanding.current;
    expanding.current = null;
    if (!pending) return;
    const { viewport, anchor, top, short } = pending;
    viewport.dispatchEvent(new Event(TRANSCRIPT_SHOWN_EVENT));
    if (short || following?.current !== false) viewport.dispatchEvent(new Event(TRANSCRIPT_END_EVENT));
    else if (anchor?.isConnected) {
      viewport.scrollTop += anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - top;
    }
  }, [cut, chatId, following]);
  return { cut, tailMarker };
}

export const MessageTranscript = memo(function MessageTranscript({
  messages,
  pendingMessageId,
  isSending,
  streamingKey,
  streamingText: heldText,
  streamingSteps,
  asking,
  waitingStepIds,
  onRecommendationSelect,
  onUpdateCli,
  updatingCli,
  cliStatus,
  onOpenLinkedChat,
  onOpenAccounts,
  limitPending,
  limitSourceMessageId,
  limitResumeBlocked,
  offlineName,
  findOpen,
  models,
  earlier,
  trimHistory,
  undoable,
  undoBlocked = false,
  onUndo,
  highlightId = null,
  onCheckpointPreview,
}: {
  undoable?: Map<number, { id: string; latest: boolean }>;
  undoBlocked?: boolean;
  onUndo?: (checkpointId: string) => void;
  highlightId?: number | null;
  onCheckpointPreview?: (recoveryId: string, action: UndoIntent) => void;
  streamingSteps?: ChatStep[];
} & Pick<
  ChatComposerProps,
  | "earlier"
  | "trimHistory"
  | "messages"
  | "pendingMessageId"
  | "isSending"
  | "streamingKey"
  | "streamingText"
  | "asking"
  | "waitingStepIds"
  | "onRecommendationSelect"
  | "onUpdateCli"
  | "updatingCli"
  | "cliStatus"
  | "onOpenLinkedChat"
  | "onOpenAccounts"
  | "limitPending"
  | "limitSourceMessageId"
  | "limitResumeBlocked"
  | "offlineName"
  | "reconnectingName"
  | "findOpen"
  | "models"
>) {
  const chatId = messages[0]?.session_id ?? "new";
  const openingMessages = useRef<{ chat: number | string; ids: Set<number> } | null>(null);
  if (!openingMessages.current) openingMessages.current = { chat: chatId, ids: new Set(messages.map((message) => message.id)) };
  if (openingMessages.current.chat !== chatId) {
    openingMessages.current = { chat: chatId, ids: openingMessages.current.chat === "new" ? new Set() : new Set(messages.map((message) => message.id)) };
  }
  const [page, setPage] = useState(() => ({ chat: chatId, firstId: messages[Math.max(0, messages.length - PAGE)]?.id }));
  let firstId = page.chat === chatId ? page.firstId : messages[Math.max(0, messages.length - PAGE)]?.id;
  if (findOpen) firstId = messages[0]?.id;
  if (page.chat !== chatId || page.firstId !== firstId) setPage({ chat: chatId, firstId });
  const start = Math.max(
    0,
    messages.findIndex((message) => message.id === firstId),
  );
  const earlierButton = useRef<HTMLButtonElement>(null);
  const historyRead = useRef(false);
  const historyChat = useRef(chatId);
  const anchor = useRef<{ element: HTMLElement; top: number; viewport: HTMLElement } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    historyChat.current = chatId;
    historyRead.current = false;
    setHistoryError(null);
    setHistoryLoading(false);
    anchor.current = null;
  }, [chatId]);
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!saved) return;
    anchor.current = null;
    let frame = 0;
    let remaining = 3;
    const restore = () => {
      if (!saved.element.isConnected) return;
      saved.viewport.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
      if (remaining-- > 0) frame = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(frame);
  }, [page]);
  const remote = earlier?.count ?? 0;
  const loadAll = earlier?.loadAll;
  useEffect(() => {
    if (!findOpen || !loadAll) return;
    const controller = new AbortController();
    void loadAll(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [findOpen, loadAll]);
  async function showEarlier() {
    if (historyRead.current || start + remote <= 0) return;
    historyRead.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    const column = earlierButton.current?.parentElement;
    const element = column?.querySelector<HTMLElement>('[data-slot="message"]');
    const viewport = column?.closest<HTMLElement>('[aria-label="Conversation"]');
    if (element && viewport) anchor.current = { element, viewport, top: element.getBoundingClientRect().top };
    try {
      if (start > 0 || !earlier) {
        setPage({ chat: chatId, firstId: messages[Math.max(0, start - PAGE)]?.id });
        return;
      }
      await earlier.load();
      if (historyChat.current === chatId) setPage({ chat: chatId, firstId: Number.NEGATIVE_INFINITY });
    } catch (error) {
      anchor.current = null;
      if (historyChat.current === chatId) setHistoryError((error as Error).message);
    } finally {
      if (historyChat.current === chatId) {
        historyRead.current = false;
        setHistoryLoading(false);
      }
    }
  }
  const loadOnScroll = useEvent(() => {
    if (!historyError) void showEarlier();
  });
  const following = useContext(MessageFollowContext);
  const canTrim = useEvent(() => !findOpen && following?.current === true && !historyRead.current && !anchor.current);
  const seen = useRef({ chat: chatId, count: messages.length });
  useEffect(() => {
    const grew = seen.current.chat === chatId && messages.length > seen.current.count;
    seen.current = { chat: chatId, count: messages.length };
    if (!grew || !canTrim()) return;
    if (messages.length - start > PAGE * 2) setPage({ chat: chatId, firstId: messages[messages.length - PAGE]?.id });
    trimHistory?.(canTrim);
  }, [messages, chatId, start, canTrim, trimHistory]);
  useEffect(() => {
    const viewport = earlierButton.current?.closest<HTMLElement>('[aria-label="Conversation"]');
    if (!viewport || start + remote <= 0 || findOpen) return;
    let previous = viewport.scrollTop;
    const onScroll = () => {
      const y = viewport.scrollTop;
      if (y < previous && y <= 160) loadOnScroll();
      previous = y;
    };
    viewport.addEventListener("scroll", onScroll);
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [chatId, start, remote, findOpen, loadOnScroll]);
  const liveText = useRunText(isSending ? streamingKey : undefined);
  const streamingText = streamingKey ? liveText : heldText;
  const streamingMessage: AppChatMessage | undefined =
    isSending && (streamingText || streamingSteps?.length)
      ? { id: -1, session_id: messages.at(-1)?.session_id ?? -1, body: streamingText ?? "", context: null, role: "assistant", steps: streamingSteps }
      : undefined;
  const grouped = useMemo(() => foldLinkedExchanges(groupQuietRuns(messages)), [messages]);
  const hiddenNotes = useMemo(() => hiddenSubchatNotes(messages), [messages]);
  const suggestionResults = useMemo(() => suggestionOutcomes(messages), [messages]);
  const transcript = grouped.slice(start).filter((entry) => !entry.hidden);
  if (streamingMessage) {
    const pendingIndex = transcript.findIndex((entry) => entry.message.id === pendingMessageId);
    transcript.splice(pendingIndex < 0 ? transcript.length : pendingIndex, 0, { message: streamingMessage });
  }

  const { cut, tailMarker } = useTailFirst(chatId, transcript.length, following);
  const shown = cut ? transcript.slice(-TAIL_FIRST) : transcript;

  const openingIds = openingMessages.current.ids;
  const limitMessageId = isSending || offlineName ? undefined : (limitSourceMessageId ?? messages.at(-1)?.id);
  return (
    <>
      {historyError && <InlineError size={12}>Could not load earlier messages: {historyError}. Use Show earlier messages to retry.</InlineError>}
      {start + remote > 0 && (
        <Button ref={earlierButton} variant="secondary" size={28} className="self-center" onClick={() => void showEarlier()} disabled={historyLoading}>
          {historyLoading ? "Loading earlier messages…" : `Show earlier messages (${start + remote})`}
        </Button>
      )}
      {cut && <span ref={tailMarker} hidden />}
      {shown.map(({ message, merged, exchange }) => {
        const issueRun = isRoutineRun(message) ? null : routineRunOf(message);
        if (hiddenNotes.has(message.id)) return null;
        if (subchatNote(message))
          return (
            <article
              key={message.id}
              id={`message-${message.id}`}
              data-slot="message"
              data-linked="subchat"
              className="flex min-w-0 w-full flex-col empty:hidden"
            >
              <SubchatMessage message={message} outcomes={suggestionResults} onOpenChat={onOpenLinkedChat} />
            </article>
          );
        return (
          <Fragment key={message.clientMessageId ?? message.id}>
            {issueRun ? <RoutineRunDivider context={issueRun} merged={merged} /> : null}
            <MessageSection
              message={message}
              merged={merged}
              exchange={exchange}
              isUser={message.role === "user"}
              onRecommendationSelect={onRecommendationSelect}
              onUpdateCli={onUpdateCli}
              updatingCli={updatingCli}
              cliStatus={cliStatus}
              streaming={message === streamingMessage}
              asking={message === streamingMessage && asking}
              waitingStepIds={message === streamingMessage ? waitingStepIds : undefined}
              animate={!message.clientMessageId && !openingIds.has(message.id)}
              onOpenChat={onOpenLinkedChat}
              limitInteractive={message.id === limitMessageId}
              limitPending={message.id === limitSourceMessageId ? limitPending : undefined}
              limitSourceMessageId={message.id === limitSourceMessageId ? limitSourceMessageId : undefined}
              limitResumeBlocked={message.id === limitSourceMessageId ? limitResumeBlocked : undefined}
              onOpenAccounts={onOpenAccounts}
              models={models}
              undoId={message.role === "user" ? undoable?.get(message.id)?.id : undefined}
              undoLatest={message.role === "user" && undoable?.get(message.id)?.latest}
              undoDisabled={message.role === "user" && undoable?.has(message.id) && undoBlocked}
              onUndo={message.role === "user" && undoable?.has(message.id) ? onUndo : undefined}
              highlighted={message.id === highlightId}
              onCheckpointPreview={isCheckpointRestore(message) && !undoBlocked ? onCheckpointPreview : undefined}
            />
          </Fragment>
        );
      })}
    </>
  );
});
