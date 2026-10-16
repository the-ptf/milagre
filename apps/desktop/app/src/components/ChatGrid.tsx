import type { ReactNode } from "react";
import { useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { projectOfKey, sessionIdFromKey, type AgentRuns } from "@milagre/shared/agent-runs";
import type { ChatMessage, CoordinatorState, LinkState, ModelOption } from "../model";
import { chatMark, chatTitle, type ChatMark } from "../lib/chat-list";
import { useChatMessages } from "../lib/chat-messages";
import { isLean } from "../lib/state-events";
import { BridgeContext, ScopeContext, bridgeForKey, isRemoteKey } from "../lib/computer-bridge";
import { EditorLinks } from "./editor-links";
import { ScrollArea } from "./primitives/ScrollArea";
import Tooltip from "./primitives/Tooltip";
import { ChatMarkDot } from "./sidebar/ChatRow";
import { chatActivity } from "@milagre/shared/chat-activity";
import { ChatTranscript } from "./ChatComposer";

const NO_MESSAGES: ChatMessage[] = [];

type ChatGridProps = {
  /** The tiles' Chat keys, in order (see gridChats). */
  keys: readonly string[];
  focused: string | null;
  /** The focused Chat's full view, composer and cards included; shown alone while there are no tiles. */
  children: ReactNode;
  states: Record<string, CoordinatorState | LinkState>;
  runs: AgentRuns;
  delegated: ReadonlySet<string>;
  models: ModelOption[];
  onFocus: (key: string) => void;
  /** Marks an unread Chat read, which takes its tile away. */
  onDismiss: (key: string) => void;
};

/** Every active Chat side by side. Only the focused tile has a composer; clicking another focuses it. */
export function ChatGrid({ keys, focused, children, states, runs, delegated, models, onFocus, onDismiss }: ChatGridProps) {
  if (!keys.length) return children;
  return (
    <ScrollArea data-chat-grid className="h-full">
      <div className="grid h-full grid-cols-[repeat(auto-fit,minmax(440px,1fr))] auto-rows-[minmax(320px,1fr)] gap-3 pt-[var(--window-chrome-height)]">
        {keys.map((key) => (
          <ChatTile
            key={key}
            chatKey={key}
            focused={key === focused}
            state={states[projectOfKey(key)]}
            runs={runs}
            delegated={delegated.has(key)}
            models={models}
            onFocus={onFocus}
            onDismiss={onDismiss}
          >
            {key === focused ? children : null}
          </ChatTile>
        ))}
      </div>
    </ScrollArea>
  );
}

function ChatTile({
  chatKey,
  focused,
  state,
  runs,
  delegated,
  models,
  onFocus,
  onDismiss,
  children,
}: {
  chatKey: string;
  focused: boolean;
  state: CoordinatorState | LinkState | undefined;
  runs: AgentRuns;
  delegated: boolean;
  models: ModelOption[];
  onFocus: (key: string) => void;
  onDismiss: (key: string) => void;
  children: ReactNode;
}) {
  const scope = projectOfKey(chatKey);
  const id = sessionIdFromKey(chatKey);
  const session = state?.sessions[id];
  const lean = isLean(state);
  // The focused tile's composer reads the messages itself.
  const page = useChatMessages(!focused && lean ? scope : null, id);
  const messages = useMemo(
    () => (focused || !state ? NO_MESSAGES : lean ? page.messages : state.messages.filter((message) => message.session_id === id)),
    [focused, state, lean, page.messages, id],
  );
  const run = runs[chatKey];
  const activity = chatActivity(session, run);
  const mark: ChatMark = chatMark({
    asking: Boolean(run && !run.approvals.length && run.questions.length),
    waiting: Boolean(run && (run.approvals.length || run.questions.length)),
    delegated,
    running: Boolean(run),
    background: activity.activity === "background",
    unread: Boolean(session?.unread),
  });
  const needsYou = mark === "question" || mark === "waiting";
  const worktree = session && "worktree_id" in session && "worktrees" in state! ? state.worktrees[session.worktree_id] : undefined;
  const branch = worktree?.name;
  const remote = isRemoteKey(scope);
  const title = session ? chatTitle(session, messages) : "Chat";
  const earlier = useMemo(
    () =>
      lean && page.total > page.messages.length
        ? {
            count: page.total - page.messages.length,
            load: page.loadEarlier,
            loadAll: page.loadAll,
          }
        : undefined,
    [lean, page.total, page.messages.length, page.loadEarlier, page.loadAll],
  );
  return (
    <section
      data-chat-tile={chatKey}
      data-focused={focused || undefined}
      aria-label={title}
      onClick={focused ? undefined : () => onFocus(chatKey)}
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-surface ${
        focused ? "border-line-strong" : needsYou ? "cursor-pointer border-orange" : "cursor-pointer border-line hover:border-line-strong"
      }`}
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-3 text-[12.5px]">
        <ChatMarkDot mark={mark} background={activity.background} />
        <span className="min-w-0 truncate font-medium text-ink">{title}</span>
        <span className="min-w-0 flex-1 truncate text-ink-3">
          {scope.split("/").pop()}
          {branch ? ` · ${branch}` : ""}
        </span>
        {needsYou && !focused && <span className="shrink-0 font-medium text-orange">Needs you</span>}
        {mark === "unread" && !focused && (
          <Tooltip label="Mark read" side="bottom">
            <button
              type="button"
              aria-label="Mark read"
              data-tile-dismiss
              onClick={(event) => {
                event.stopPropagation();
                onDismiss(chatKey);
              }}
              className="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-hover hover:text-ink"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} color="currentColor" />
            </button>
          </Tooltip>
        )}
      </header>
      {focused ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        // A tile's images, attachments and file links belong to its own Project (and Computer), not the focused one's.
        <BridgeContext.Provider value={bridgeForKey(scope)}>
          <ScopeContext.Provider value={scope}>
            <EditorLinks root={remote ? "" : (worktree?.path ?? scope)} files={remote ? "" : (worktree?.path ?? scope)}>
              <ChatTranscript
                chatKey={chatKey}
                messages={messages}
                messageScope={scope}
                earlier={earlier}
                isSending={Boolean(run)}
                streamingText={run?.text}
                streamingSteps={run?.steps}
                asking={Boolean(run?.questions.length)}
                runStartedAt={run?.startedAt}
                models={models}
              />
            </EditorLinks>
          </ScopeContext.Provider>
        </BridgeContext.Provider>
      )}
    </section>
  );
}
