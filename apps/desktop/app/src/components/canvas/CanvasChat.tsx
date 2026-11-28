import { Component, createContext, useContext, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowExpand01Icon, ArrowUp01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { canvasLive, canvasStatus, type CanvasChat as CanvasChatRow } from "@milagre/shared/canvas";
import { projectOfKey, sessionIdFromKey, type AgentRuns } from "@milagre/shared/agent-runs";
import { followUpDelivery, type MessageDelivery } from "@milagre/shared/queued-messages";
import { providerCapabilities } from "@milagre/shared/provider-capabilities";
import { ipcErrorMessage } from "@milagre/shared/result";
import type {
  ChatMessage,
  CoordinatorState,
  LinkState,
  ModelOption,
  ModelProvider,
  PermissionDecision,
  PermissionMode,
  QuestionAnswers,
  QuestionImages,
} from "../../model";
import { useChatMessages } from "../../lib/chat-messages";
import { isLean } from "../../lib/state-events";
import { BridgeContext, ScopeContext, bridgeForKey, isRemoteKey } from "../../lib/computer-bridge";
import { useContextSettings } from "../../lib/context-settings";
import { EditorLinks } from "../editor-links";
import { ChatTranscript } from "../transcript/ChatTranscript";
import { PermissionCard } from "../agents/PermissionCard";
import { QuestionCard } from "../agents/QuestionCard";
import { Button, IconButton } from "../primitives/Button";
import { InlineError } from "../primitives/InlineError";
import { ScrollArea } from "../primitives/ScrollArea";
import { ChatMarkDotInline } from "../sidebar/ChatMarks";

/** What a message sent from a card needs to know about its Chat, beyond its key. */
export type CanvasSend = {
  key: string;
  body: string;
  delivery?: MessageDelivery;
  worktreeId: number;
  provider?: ModelProvider;
  permissionMode?: PermissionMode;
  lastModel?: string;
};

/** The window's own actions on a Chat (useAgentRuns), and what the Chats open on the canvas read. */
export type CanvasChatActions = {
  models: ModelOption[];
  send: (request: CanvasSend) => Promise<unknown>;
  respond: (key: string, requestId: string, decision: PermissionDecision) => Promise<unknown>;
  answerQuestion: (key: string, requestId: string, answers: QuestionAnswers | null, images?: QuestionImages) => Promise<unknown>;
  interrupt: (key: string) => Promise<unknown>;
};

export type CanvasChatContextValue = {
  states: Record<string, CoordinatorState | LinkState | undefined>;
  runs: AgentRuns;
  actions?: CanvasChatActions;
  onOpenFull: (projectPath: string, id: number) => void;
  onClose: (key: string) => void;
  onError?: (message: string) => void;
  now: number;
};

export const CanvasChatContext = createContext<CanvasChatContextValue | null>(null);

const NO_MESSAGES: ChatMessage[] = [];
const drafts = new Map<string, string>();

class CanvasChatBoundary extends Component<{ onOpen: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error("A Chat open on the canvas failed to render", error);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-12 text-ink-3">
        <span>This Chat can't be shown on the canvas.</span>
        <Button variant="ghost" size={28} onClick={this.props.onOpen}>
          Open the full Chat
        </Button>
      </div>
    );
  }
}

/**
 * A Chat open as a window on the canvas: its header (which drags the window; a double click opens the full Chat), what it
 * is doing, its transcript, the approval or question it waits on and a composer. Esc is the canvas's (CanvasView).
 */
export function CanvasChat({ chatKey, row, branch }: { chatKey: string; row: CanvasChatRow; branch: string }) {
  const context = useContext(CanvasChatContext);
  if (!context) return null;
  const scope = projectOfKey(chatKey);
  const id = sessionIdFromKey(chatKey);
  const openFull = () => context.onOpenFull(scope, id);
  return (
    <section data-canvas-open-chat={chatKey} aria-label={row.title} className="flex min-h-0 flex-1 flex-col">
      <header
        className="canvas-window-drag flex h-10 shrink-0 cursor-grab items-center gap-2 px-3 active:cursor-grabbing"
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button")) return;
          openFull();
        }}
      >
        <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
          {row.mark === "idle" && !row.failed ? <span className="size-1.5 rounded-full bg-ink-4" /> : <ChatMarkDotInline mark={row.mark} failed={row.failed} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-13 font-semibold text-ink">{row.title}</span>
        <IconButton label="Open the full Chat" icon={ArrowExpand01Icon} size={24} data-canvas-open-full className="nodrag" onClick={openFull} />
        <IconButton label="Close" icon={Cancel01Icon} size={24} data-canvas-close className="nodrag" onClick={() => context.onClose(chatKey)} />
      </header>
      <CanvasChatBoundary onOpen={openFull}>
        <CanvasChatBody chatKey={chatKey} row={row} branch={branch} context={context} />
      </CanvasChatBoundary>
    </section>
  );
}

function CanvasChatBody({ chatKey, row, branch, context }: { chatKey: string; row: CanvasChatRow; branch: string; context: CanvasChatContextValue }) {
  const scope = projectOfKey(chatKey);
  const id = sessionIdFromKey(chatKey);
  const state = context.states[scope];
  const lean = isLean(state);
  const page = useChatMessages(lean ? scope : null, id);
  const messages = useMemo(
    () => (!state ? NO_MESSAGES : lean ? page.messages : state.messages.filter((message) => message.session_id === id)),
    [state, lean, page.messages, id],
  );
  const earlier = useMemo(
    () => (lean && page.total > page.messages.length ? { count: page.total - page.messages.length, load: page.loadEarlier, loadAll: page.loadAll } : undefined),
    [lean, page.total, page.messages.length, page.loadEarlier, page.loadAll],
  );
  const run = context.runs[chatKey];
  const live = canvasLive(run);
  const session = state?.sessions[id];
  const worktree = session && "worktree_id" in session && state && "worktrees" in state ? state.worktrees[session.worktree_id] : undefined;
  const remote = isRemoteKey(scope);
  const bridge = useMemo(() => bridgeForKey(scope), [scope]);
  const status = canvasStatus(row, context.now);
  const actions = context.actions;
  const [stopError, setStopError] = useState<string | null>(null);
  return (
    <BridgeContext.Provider value={bridge}>
      <ScopeContext.Provider value={scope}>
        <div className="flex h-6 shrink-0 items-center gap-2 border-b border-line px-3 pb-2 text-12">
          <span
            className={`shrink-0 font-medium ${run ? "text-accent-ink" : status.tone === "orange" ? "text-orange-ink" : status.tone === "red" ? "text-red-ink" : "text-ink-3"}`}
          >
            {run && live?.step ? `${status.label} · ${live.step}` : status.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink-3">{branch}</span>
          {run && actions && (
            <Button
              variant="danger-ghost"
              size={24}
              className="-my-1"
              data-canvas-stop
              onClick={() => {
                setStopError(null);
                actions.interrupt(chatKey).catch((error: unknown) => setStopError(ipcErrorMessage(error)));
              }}
            >
              Stop
            </Button>
          )}
        </div>
        <InlineError size={12} className="mx-3 mt-2">
          {stopError}
        </InlineError>
        <div className="nowheel nodrag nopan flex min-h-0 flex-1 flex-col cursor-auto select-text">
          <EditorLinks root={remote ? "" : (worktree?.path ?? scope)} files={remote ? "" : (worktree?.path ?? scope)}>
            <ChatTranscript
              chatKey={chatKey}
              messages={messages}
              messageScope={scope}
              earlier={earlier}
              trimHistory={lean ? page.trim : undefined}
              isSending={Boolean(run)}
              streamingKey={run ? chatKey : undefined}
              streamingSteps={run?.steps}
              asking={Boolean(run?.questions.length)}
              runStartedAt={run?.startedAt}
              models={actions?.models ?? []}
            />
          </EditorLinks>
        </div>
        {live?.pending && actions && (
          <ScrollArea className="nowheel nodrag nopan max-h-[60%] shrink-0 border-t border-line px-3 py-2">
            {live.pending.kind === "approval" ? (
              <PermissionCard
                variant="inline"
                request={live.pending.request}
                waiting={live.pending.more}
                answering={null}
                onAnswer={(decision) => void actions.respond(chatKey, live.pending!.request.requestId, decision).catch(() => {})}
              />
            ) : (
              <QuestionCard
                request={live.pending.request}
                waiting={live.pending.more}
                answering={null}
                startedAt={run?.startedAt}
                onAnswer={(answers, images) => void actions.answerQuestion(chatKey, live.pending!.request.requestId, answers, images).catch(() => {})}
              />
            )}
          </ScrollArea>
        )}
        {actions && session && "worktree_id" in session && (
          <CanvasComposer
            chatKey={chatKey}
            running={Boolean(run)}
            provider={session.provider}
            onSend={(body, delivery) =>
              actions.send({
                key: chatKey,
                body,
                delivery,
                worktreeId: session.worktree_id,
                provider: session.provider,
                permissionMode: session.permissionMode,
                lastModel: session.summary?.lastModel,
              })
            }
          />
        )}
      </ScopeContext.Provider>
    </BridgeContext.Provider>
  );
}

function CanvasComposer({
  chatKey,
  running,
  provider,
  onSend,
}: {
  chatKey: string;
  running: boolean;
  provider?: ModelProvider;
  onSend: (body: string, delivery?: MessageDelivery) => Promise<unknown>;
}) {
  const { settings } = useContextSettings();
  const delivery = followUpDelivery(settings.followUps);
  const queues = delivery === "queue" || !providerCapabilities(provider).steer;
  const [draft, setDraft] = useState(() => drafts.get(chatKey) ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const update = (text: string) => {
    setDraft(text);
    if (text) drafts.set(chatKey, text);
    else drafts.delete(chatKey);
  };
  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body, delivery);
      update("");
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    } finally {
      setSending(false);
      field.current?.focus();
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };
  const label = running ? (queues ? "Queue message" : "Send now") : "Send";
  return (
    <div className="nowheel nodrag nopan shrink-0 px-3 pt-2 pb-3">
      <div className="flex items-end gap-2 rounded-card border border-line-strong bg-surface px-3 py-2 focus-within:border-accent">
        <textarea
          ref={field}
          data-canvas-composer
          rows={1}
          value={draft}
          disabled={sending}
          onChange={(event) => update(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={running ? (queues ? "Queue a message for the next turn…" : "Steer the agent…") : "Reply to this Chat…"}
          aria-label="Message"
          className="max-h-32 min-h-5 flex-1 resize-none bg-transparent text-13 leading-5 text-ink outline-none placeholder:text-ink-3 [field-sizing:content]"
        />
        <IconButton label={label} icon={ArrowUp01Icon} size={24} variant="primary" disabled={!draft.trim() || sending} onClick={() => void send()} />
      </div>
      <InlineError size={12} className="mt-1">
        {error}
      </InlineError>
    </div>
  );
}
