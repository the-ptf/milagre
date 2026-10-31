import type { MouseEvent, ReactNode } from "react";
import { Component, memo, useEffect, useMemo, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, PinIcon, PinOffIcon } from "@hugeicons/core-free-icons";
import { createPortal } from "react-dom";
import { projectOfKey, sessionIdFromKey, type AgentRun, type AgentRuns } from "@milagre/shared/agent-runs";
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
import { chatMentionChoices } from "@milagre/shared/prompt-mentions";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { ChatTranscript } from "./ChatComposer";
import { RoutineChip } from "./routines/RoutineChip";
import { isDraftTileKey } from "../lib/chat-grid";
import { useGridDropTarget } from "../lib/grid-drop";

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
  /** Opens a Routine's page, from the chip on a Run Chat's or a Heartbeat Chat's tile. */
  onOpenRoutine?: (routineId: string) => void;
  /** Marks an unread Chat read, which takes its tile away. */
  onDismiss: (key: string) => void;
  /** The Chats kept in the grid while idle. */
  pinned: ReadonlySet<string>;
  onTogglePin: (key: string) => void;
  /** The split view's close button on every tile, in place of pinning and Mark read. */
  onClose?: (key: string) => void;
};

// What a press in an unfocused tile is meant for instead of focusing it: a control, a link or media in its transcript.
const TILE_CONTROLS = "a, button, input, textarea, select, summary, label, img, video, [role=button], [role=link], [role=checkbox], [contenteditable]";

/**
 * Whether a click on an unfocused tile focuses it. Only a click on the tile itself does: one on a control, link or image
 * in it does what that one does, a drag that selected text keeps its selection, and a click inside something the tile
 * opened through a portal (an image lightbox, a file viewer) never reaches the tile in the DOM, only through React.
 */
function clickFocusesTile(event: MouseEvent<HTMLElement>) {
  const tile = event.currentTarget;
  const target = event.target;
  if (!(target instanceof Element) || !tile.contains(target)) return false;
  const control = target.closest(TILE_CONTROLS);
  if (control && tile.contains(control)) return false;
  const selection = window.getSelection();
  return !selection || selection.isCollapsed || !tile.contains(selection.anchorNode);
}

/** Every active Chat side by side, or a split's Chats. Only the focused tile has a composer; clicking another focuses it. */
export function ChatGrid({
  keys,
  focused,
  children,
  states,
  runs,
  delegated,
  models,
  onFocus,
  onOpenRoutine,
  onDismiss,
  pinned,
  onTogglePin,
  onClose,
}: ChatGridProps) {
  const grid = useRef<HTMLElement>(null);
  const shown = keys.length > 0;
  // A tile focused from the keyboard, the sidebar or a click comes into view, and the prompt takes the keyboard unless
  // something outside the grid (the sidebar's search, a dialog) has it.
  useEffect(() => {
    if (!shown || !focused) return;
    const frame = requestAnimationFrame(() => {
      const tile = grid.current?.querySelector<HTMLElement>(`[data-chat-tile="${CSS.escape(focused)}"]`);
      if (!tile) return;
      tile.scrollIntoView({ block: "nearest" });
      const active = document.activeElement;
      if (!active || active === document.body || (grid.current?.contains(active) && !tile.contains(active)))
        tile.querySelector<HTMLElement>("[data-prompt-editor]")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focused, shown]);
  if (!shown) return children;
  return (
    // The tiles scroll below the window's title bar, never under its transparent strip.
    <div className="flex h-full flex-col pt-[var(--window-chrome-height)]">
      <ScrollArea ref={grid} data-chat-grid className="min-h-0 flex-1">
        <div className="grid h-full grid-cols-[repeat(auto-fit,minmax(440px,1fr))] auto-rows-[minmax(320px,1fr)] gap-3">
          {keys.map((key) => (
            <ChatTile
              // The focused tile keeps one key wherever focus goes, so React moves its composer instead of building a new one.
              key={key === focused ? "focused" : key}
              chatKey={key}
              focused={key === focused}
              state={states[projectOfKey(key)]}
              run={runs[key]}
              delegated={delegated.has(key)}
              models={models}
              onFocus={onFocus}
              onOpenRoutine={onOpenRoutine}
              onDismiss={onDismiss}
              pinned={pinned.has(key)}
              onTogglePin={onTogglePin}
              onClose={onClose}
            >
              {key === focused ? children : null}
            </ChatTile>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/** An unfocused tile whose transcript throws shows a note instead, so one Chat can't blank the window. */
class TileBoundary extends Component<{ onOpen: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error("A Chat grid tile failed to render", error);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-[12.5px] text-ink-3">
        <span>This Chat can't be shown in the grid.</span>
        <button type="button" onClick={this.props.onOpen} className="rounded-control px-2 py-1 font-medium text-ink hover:bg-hover">
          Open it
        </button>
      </div>
    );
  }
}

const ChatTile = memo(function ChatTile({
  chatKey,
  focused,
  state,
  run,
  delegated,
  models,
  onFocus,
  onOpenRoutine,
  onDismiss,
  pinned,
  onTogglePin,
  onClose,
  children,
}: {
  chatKey: string;
  focused: boolean;
  state: CoordinatorState | LinkState | undefined;
  run: AgentRun | undefined;
  delegated: boolean;
  models: ModelOption[];
  onFocus: (key: string) => void;
  onOpenRoutine?: (routineId: string) => void;
  onDismiss: (key: string) => void;
  pinned: boolean;
  onTogglePin: (key: string) => void;
  onClose?: (key: string) => void;
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
  const mentionKey = JSON.stringify(state && !isLinkScopeKey(scope) ? chatMentionChoices(state as CoordinatorState) : []);
  const mentionChats = useMemo(() => JSON.parse(mentionKey) as ReturnType<typeof chatMentionChoices>, [mentionKey]);
  const mentionContext = useMemo(() => ({ chats: mentionChats, project: scope, currentId: id, onOpen: onFocus }), [mentionChats, scope, id, onFocus]);
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
  const bridge = bridgeForKey(scope);
  const title = session ? chatTitle(session, messages) : isDraftTileKey(chatKey) ? "New Chat" : "Chat";
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
      onClick={focused ? undefined : (event) => clickFocusesTile(event) && onFocus(chatKey)}
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
        {onOpenRoutine && session && <RoutineChip chatKey={chatKey} run={session.routine} place="tile" onOpen={onOpenRoutine} />}
        {needsYou && !focused && <span className="shrink-0 font-medium text-orange-ink">Needs you</span>}
        {onClose && (
          <Tooltip label="Close" side="bottom">
            <button
              type="button"
              aria-label="Close"
              data-tile-close
              onClick={(event) => {
                event.stopPropagation();
                onClose(chatKey);
              }}
              className="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-hover hover:text-ink"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} color="currentColor" />
            </button>
          </Tooltip>
        )}
        {!onClose && !isDraftTileKey(chatKey) && (
          <Tooltip label={pinned ? "Remove from grid" : "Keep in grid"} side="bottom">
            <button
              type="button"
              aria-label={pinned ? "Remove from grid" : "Keep in grid"}
              aria-pressed={pinned}
              data-tile-pin
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(chatKey);
              }}
              className={`flex size-6 shrink-0 items-center justify-center rounded-control hover:bg-hover hover:text-ink ${pinned ? "text-ink" : "text-ink-3"}`}
            >
              <HugeiconsIcon icon={pinned ? PinOffIcon : PinIcon} size={13} strokeWidth={2} color="currentColor" />
            </button>
          </Tooltip>
        )}
        {!onClose && mark === "unread" && !focused && (
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
        // A size container: the composer caps its approval and question cards to the tile's height (cqh), not the window's.
        <div className="flex min-h-0 flex-1 flex-col [container-type:size]">{children}</div>
      ) : (
        // A tile's images, attachments and file links belong to its own Project (and Computer), not the focused one's.
        <TileBoundary onOpen={() => onFocus(chatKey)}>
          <BridgeContext.Provider value={bridge}>
            <ScopeContext.Provider value={scope}>
              <EditorLinks root={remote ? "" : (worktree?.path ?? scope)} files={remote ? "" : (worktree?.path ?? scope)}>
                <ChatTranscript
                  chatKey={chatKey}
                  mentionContext={mentionContext}
                  messages={messages}
                  messageScope={scope}
                  earlier={earlier}
                  trimHistory={lean && !focused ? page.trim : undefined}
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
        </TileBoundary>
      )}
    </section>
  );
});

/** Where a Chat dragged out of the sidebar would land: the half it takes, the edge it goes in at and what the drop does. */
export function GridDropOverlay() {
  const target = useGridDropTarget();
  if (!target) return null;
  const { area, bar } = target;
  const label = target.tile === null ? "Open beside" : target.side === "before" ? "Add before" : "Add after";
  return createPortal(
    <div aria-hidden data-grid-drop={target.tile ?? "pane"} className="pointer-events-none fixed inset-0 z-50">
      <div className="absolute rounded-xl bg-accent/10" style={area} />
      <div className="absolute w-1 rounded-full bg-accent" style={bar} />
      <div
        className="absolute rounded-full bg-accent px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-white"
        style={{ left: area.left + 12, top: area.top + area.height - 40 }}
      >
        {label}
      </div>
    </div>,
    document.body,
  );
}
