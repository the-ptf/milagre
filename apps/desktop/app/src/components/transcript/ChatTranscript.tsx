import { ArtifactsProvider } from "../agents/ArtifactCard";
import { GenerativeUIProvider } from "../genui/GenerativeUI";
import { chatHistory } from "@milagre/shared/chat-history";
import type { Subagent } from "../../model";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { commitChatSwitch, transcriptShown } from "../../lib/chat-switch-timing";
import { showSlot, trimSlots, type TranscriptSlot } from "../../lib/transcript-slots";
import type { ChatStep } from "../../model";
import { ChatMentionsContext, EMPTY_CHAT_MENTIONS, type ChatMentionScope } from "../ChatMentions";
import { StepApprovalProvider, type StepApproval } from "../agents/step-approval";
import { ChatFiles } from "../editor-links";
import { ThinkingIndicator } from "../ThinkingIndicator";
import { MessageScroller, TRANSCRIPT_END_EVENT, TRANSCRIPT_SHOWN_EVENT } from "../agents/message-scroller";
import { StepDetailsScope } from "../agents/step-details";
import { MessageTranscript } from "./MessageTranscript";
import type { ChatComposerProps } from "../ChatComposer";

const NO_OP = () => {};

/** A Chat's transcript alone, following its stream: an unfocused tile of the Chat grid. Replying means focusing the tile. */
export function ChatTranscript({
  mentionContext,
  chatKey,
  messages,
  messageScope,
  earlier,
  trimHistory,
  isSending,
  streamingKey,
  streamingText,
  streamingSteps,
  asking,
  waitingStepIds,
  runStartedAt,
  models,
}: { chatKey: string; mentionContext?: ChatMentionScope } & Pick<
  ChatComposerProps,
  | "messages"
  | "messageScope"
  | "earlier"
  | "trimHistory"
  | "isSending"
  | "streamingKey"
  | "streamingText"
  | "streamingSteps"
  | "asking"
  | "waitingStepIds"
  | "runStartedAt"
  | "models"
>) {
  const history = chatHistory(messages);
  const steps = useMemo(() => (streamingSteps?.length ? [...history.steps, ...streamingSteps] : history.steps), [history.steps, streamingSteps]);
  const { userMessages } = history;
  return (
    <ReplyProviders chatId={chatKey} steps={steps} userMessages={userMessages} mentionContext={mentionContext}>
      <MessageScroller
        navigation="none"
        followOutput
        busy={isSending}
        className="min-h-0 flex-1"
        viewportClassName="pt-2 pb-3"
        contentClassName="min-h-full"
        autoScrollKey={`${messages.length}-${isSending}-${streamingSteps?.length ?? 0}`}
      >
        <div className="flex min-h-full w-full flex-col gap-3 px-3">
          <StepDetailsScope scope={messageScope}>
            <MessageTranscript
              earlier={earlier}
              trimHistory={trimHistory}
              messages={messages}
              isSending={isSending}
              streamingKey={streamingKey}
              streamingText={streamingText}
              streamingSteps={streamingSteps}
              asking={asking}
              waitingStepIds={waitingStepIds}
              onRecommendationSelect={NO_OP}
              cliStatus={null}
              models={models}
            />
          </StepDetailsScope>
          {isSending && <ThinkingIndicator startedAt={runStartedAt} label="Working" />}
        </div>
      </MessageScroller>
    </ReplyProviders>
  );
}

/** The contexts a Chat's replies read: its designs, the files its steps worked on and the send function a generative UI button posts through. */
export function ReplyProviders({
  mentionContext = EMPTY_CHAT_MENTIONS,
  chatId,
  steps,
  userMessages,
  onSend,
  agent,
  followAgent,
  subagents,
  children,
}: {
  mentionContext?: ChatMentionScope;
  chatId: string | null;
  steps: ChatStep[];
  userMessages: { id: number | string; body: string }[];
  onSend?: (text: string) => Promise<boolean>;
  agent?: string;
  /** The Chat this window shows, whose Designs open as the agent starts designing (not a grid tile). */
  followAgent?: boolean;
  subagents?: readonly Subagent[];
  children: ReactNode;
}) {
  return (
    <ArtifactsProvider chatId={chatId} steps={steps} userMessages={userMessages} onSend={onSend} agent={agent} followAgent={followAgent} subagents={subagents}>
      <GenerativeUIProvider onSend={onSend}>
        <ChatMentionsContext value={mentionContext}>
          <ChatFiles steps={steps}>{children}</ChatFiles>
        </ChatMentionsContext>
      </GenerativeUIProvider>
    </ArtifactsProvider>
  );
}

/**
 * The transcript on screen and the last few shown before it, kept mounted (lib/transcript-slots.ts, after MonoCode's
 * TranscriptPool). Each slot renders through a portal into a node of its own; the shown one's node sits in the host,
 * the parked ones' leave the document with their DOM intact, so DOM queries never meet them and coming back is one
 * insertion, not parsing and laying out every message again. A parked transcript keeps the
 * element it was last shown with, so React leaves its tree alone. Without a key (a Chat not saved yet) the element
 * renders in place and nothing is parked.
 */
/** The height styles.css gives a message content-visibility has never laid out (`contain-intrinsic-size: auto 160px`). */
const MESSAGE_PLACEHOLDER_HEIGHT = 160;

/** What the transcript's rows read from above: the Chats it can mention and the approval waiting on a tool row. */
export function TranscriptContexts({
  mentions,
  stepApproval,
  children,
}: {
  mentions: ChatMentionScope;
  stepApproval: StepApproval | null;
  children: ReactNode;
}) {
  return (
    <ChatMentionsContext value={mentions}>
      <StepApprovalProvider value={stepApproval}>{children}</StepApprovalProvider>
    </ChatMentionsContext>
  );
}

export function TranscriptSlots({
  activeKey,
  view,
  element,
  messageCount,
}: {
  activeKey: string | null;
  /** The conversation on screen (App's chat view): a key change within one view is a draft becoming its saved Chat. */
  view: number | string | undefined;
  element: ReactElement | null;
  messageCount: number;
}) {
  const [slots, setSlots] = useState<TranscriptSlot<ReactElement>[]>([]);
  const [nodes] = useState(() => new Map<number, HTMLDivElement>());
  // Slots that have left the window once: back in it, they go to their latest message.
  const [parked] = useState(() => new Set<number>());
  const [unmeasured] = useState(() => new Set<number>());
  const [last, setLast] = useState<{ view: typeof view; key: string | null }>({ view, key: activeKey });
  const alias = last.view !== undefined && last.view === view && last.key && last.key !== activeKey ? last.key : undefined;
  const next = activeKey && element ? showSlot(slots, activeKey, element, alias) : slots;
  if (next !== slots) setSlots(next);
  if (last.view !== view || last.key !== activeKey) setLast({ view, key: activeKey });
  const nodeFor = (id: number) => {
    let node = nodes.get(id);
    if (!node) {
      node = document.createElement("div");
      node.className = "contents";
      node.dataset.transcriptSlot = String(id);
      nodes.set(id, node);
    }
    return node;
  };
  const activeId = activeKey ? next.find((slot) => slot.key === activeKey)?.id : undefined;
  // The host takes the shown slot's node as a ref, in the layout phase before the portals' own layout effects: a
  // transcript that opens measures itself inside the document. The node it replaces is parked.
  const [hosts] = useState<{ current: HTMLDivElement | null }>(() => ({ current: null }));
  const host = useCallback(
    (hostNode: HTMLDivElement | null) => {
      const node = activeId === undefined ? null : nodeFor(activeId);
      // Whatever other slot the host holds is parked. The host leaving (a new Chat takes the window) parks its slot
      // the same way. Only slot nodes leave: React may reuse this div for the in-place transcript of a Chat without a
      // key, whose children it has already placed when the ref lets go.
      for (const child of Array.from((hostNode ?? hosts.current)?.querySelectorAll<HTMLElement>(":scope > [data-transcript-slot]") ?? [])) {
        if (hostNode && child === node) continue;
        if (child.querySelector('[aria-label="Conversation"]')) parked.add(Number(child.dataset.transcriptSlot));
        // Out of the document, content-visibility forgets the size of every skipped message. Each keeps its own, so
        // the transcript comes back at the same height and opens where it should without measuring again. A message
        // never laid out stands at the placeholder size (styles.css), which says nothing: the transcript measures again.
        const id = Number(child.dataset.transcriptSlot);
        const messages = Array.from(child.querySelectorAll<HTMLElement>('[data-slot="message"]'));
        // Every read before any write: one layout, not one per message.
        const heights = messages.map((message) => message.offsetHeight);
        messages.forEach((message, index) => {
          const height = heights[index]!;
          if (height > 0 && height !== MESSAGE_PLACEHOLDER_HEIGHT) message.style.containIntrinsicSize = `auto ${height}px`;
          else unmeasured.add(id);
        });
        child.remove();
      }
      hosts.current = hostNode;
      if (!hostNode || !node || activeId === undefined) return;
      if (node.parentElement !== hostNode) {
        hostNode.appendChild(node);
        // A Chat opens at its latest turn, parked or not, and follows it. The scroller takes it there itself
        // (TRANSCRIPT_END_EVENT): messages that measure now must not read as the reader scrolling away.
        const viewport = node.querySelector<HTMLElement>('[aria-label="Conversation"]');
        if (viewport && parked.has(activeId)) {
          if (unmeasured.delete(activeId)) viewport.dispatchEvent(new Event(TRANSCRIPT_SHOWN_EVENT));
          viewport.dispatchEvent(new Event(TRANSCRIPT_END_EVENT));
        }
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new callback per slot is what makes React run it again
    [activeId],
  );
  // Parked transcripts past the limit leave after the switch has painted, so a burst of switches pays for it once.
  useEffect(() => {
    if (trimSlots(next, activeKey) === next) return;
    const timer = window.setTimeout(() => setSlots((current) => trimSlots(current, activeKey)), 500);
    return () => window.clearTimeout(timer);
  }, [next, activeKey]);
  useEffect(() => {
    for (const id of Array.from(nodes.keys()))
      if (!next.some((slot) => slot.id === id)) {
        nodes.get(id)?.remove();
        nodes.delete(id);
        parked.delete(id);
        unmeasured.delete(id);
      }
  }, [next, nodes, parked, unmeasured]);
  // The switch is measured once the Chat's messages are on screen (lib/chat-switch-timing.ts).
  useLayoutEffect(() => {
    if (activeKey && messageCount > 0) commitChatSwitch(activeKey);
    else transcriptShown(null);
    return () => transcriptShown(null);
  }, [activeKey, messageCount]);
  if (!activeKey) {
    if (element) return element;
    if (!next.length) return null;
  }
  return (
    <>
      {element && <div ref={host} className="relative flex min-h-0 flex-1 flex-col" />}
      {next.map((slot) => createPortal(slot.element, nodeFor(slot.id), String(slot.id)))}
    </>
  );
}
