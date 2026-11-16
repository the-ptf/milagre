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
import type { ChatComposerProps } from "../composer/chat-composer-props";

const NO_OP = () => {};

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
}: { chatKey: string; mentionContext?: ChatMentionScope; streamingSteps?: ChatStep[] } & Pick<
  ChatComposerProps,
  | "messages"
  | "messageScope"
  | "earlier"
  | "trimHistory"
  | "isSending"
  | "streamingKey"
  | "streamingText"
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

const MESSAGE_PLACEHOLDER_HEIGHT = 160;

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
  view: number | string | undefined;
  element: ReactElement | null;
  messageCount: number;
}) {
  const [slots, setSlots] = useState<TranscriptSlot<ReactElement>[]>([]);
  const [nodes] = useState(() => new Map<number, HTMLDivElement>());
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
  const [hosts] = useState<{ current: HTMLDivElement | null }>(() => ({ current: null }));
  const host = useCallback(
    (hostNode: HTMLDivElement | null) => {
      const node = activeId === undefined ? null : nodeFor(activeId);
      for (const child of Array.from((hostNode ?? hosts.current)?.querySelectorAll<HTMLElement>(":scope > [data-transcript-slot]") ?? [])) {
        if (hostNode && child === node) continue;
        if (child.querySelector('[aria-label="Conversation"]')) parked.add(Number(child.dataset.transcriptSlot));
        const id = Number(child.dataset.transcriptSlot);
        const messages = Array.from(child.querySelectorAll<HTMLElement>('[data-slot="message"]'));
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
