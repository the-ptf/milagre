import type { CSSProperties, MouseEvent, ReactNode, RefObject } from "react";
import { Component, Fragment, memo, useEffect, useMemo, useRef } from "react";
import { Cancel01Icon, PinIcon, PinOffIcon } from "@hugeicons/core-free-icons";
import { createPortal } from "react-dom";
import { projectOfKey, sessionIdFromKey, type AgentRun } from "@milagre/shared/agent-runs";
import { useRuns } from "../lib/agent-runs-store";
import type { ChatMessage, CoordinatorState, LinkState, ModelOption } from "../model";
import { chatMark, chatTitle, type ChatMark } from "../lib/chat-list";
import { useChatMessages } from "../lib/chat-messages";
import { isLean } from "../lib/state-events";
import { BridgeContext, ScopeContext, bridgeForKey, isRemoteKey } from "../lib/computer-bridge";
import { EditorLinks } from "./editor-links";
import { ScrollArea } from "./primitives/ScrollArea";
import { Button, IconButton } from "./primitives/Button";
import { ChatMarkDot } from "./sidebar/ChatMarks";
import { chatActivity } from "@milagre/shared/chat-activity";
import { chatMentionChoices } from "@milagre/shared/prompt-mentions";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { ChatTranscript } from "./transcript/ChatTranscript";
import { MessageSelection } from "./MessageSelection";
import { sendQuote } from "../lib/quote-inbox";
import { RoutineChip } from "./routines/RoutineChip";
import { isDraftTileKey } from "../lib/chat-grid";
import { useGridDropTarget, type GridDropTarget } from "../lib/grid-drop";
import { splitColumns } from "../lib/split-columns";
import { subchatsNeedingYou } from "../lib/subchat-track";
import type { TileMenuControls } from "./agents/TileFamilyMenu";
import { SplitDivider, SplitHeader, SplitReply } from "./agents/SplitTileParts";
import { placeColumns, shareColumns, shareRows, useSplitSizes } from "../lib/split-sizes";

const NO_MESSAGES: ChatMessage[] = [];
const NO_STACKED: readonly string[] = [];

type ChatGridProps = {
  /** The tiles' Chat keys, in order (see gridChats). */
  keys: readonly string[];
  /** A split's Chats stacked under the one before them (see splitColumns). */
  stacked?: readonly string[];
  focused: string | null;
  /** The focused Chat's full view, composer and cards included; shown alone while there are no tiles. */
  children: ReactNode;
  states: Record<string, CoordinatorState | LinkState>;
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
  /** The split's tile menus (title: Open alone, swap for a family Chat); the grid's tiles have none. */
  menu?: TileMenuControls;
  /** The split's panel menu, in the focused pane's header while the split's headers take the title bar. */
  panelMenu?: ReactNode;
  /** Stops a split pane's running agent from its reply box. */
  onStop?: (key: string) => void;
};

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
  stacked = NO_STACKED,
  focused,
  children,
  states,
  delegated,
  models,
  onFocus,
  onOpenRoutine,
  onDismiss,
  pinned,
  onTogglePin,
  onClose,
  menu,
  panelMenu,
  onStop,
}: ChatGridProps) {
  const grid = useRef<HTMLElement>(null);
  const shown = keys.length > 0;
  const runs = useRuns(shown);
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
  if (onClose) {
    const tile = (key: string, column: number, row: number, box: CSSProperties) => (
      <ChatTile
        key={key === focused ? "focused" : key}
        chatKey={key}
        focused={key === focused}
        split={{ first: column === 0, top: row === 0, box, panelMenu: key === focused ? panelMenu : undefined, onStop }}
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
        menu={menu}
        tiles={keys}
        waitingBelow={
          key === focused || isLinkScopeKey(projectOfKey(key))
            ? 0
            : subchatsNeedingYou((states[projectOfKey(key)] as CoordinatorState | undefined)?.sessions, runs, key)
        }
      >
        {key === focused ? children : null}
      </ChatTile>
    );
    return (
      <div ref={grid as RefObject<HTMLDivElement>} className="h-full min-h-0">
        <SplitColumns columns={splitColumns(keys, stacked)} tile={tile} />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col pt-[var(--window-chrome-height)]">
      <ScrollArea ref={grid} data-chat-grid className="min-h-0 flex-1">
        <div className="grid h-full grid-cols-[repeat(auto-fit,minmax(440px,1fr))] auto-rows-[minmax(320px,1fr)] gap-3">
          {keys.map((key) => (
            <ChatTile
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
              menu={menu}
              tiles={keys}
              waitingBelow={
                key === focused || isLinkScopeKey(projectOfKey(key))
                  ? 0
                  : subchatsNeedingYou((states[projectOfKey(key)] as CoordinatorState | undefined)?.sessions, runs, key)
              }
            >
              {key === focused ? children : null}
            </ChatTile>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

const COLUMN_MIN = 280;
const ROW_MIN = 160;

type Box = { left: number; top: number; width: number; height: number };
const percent = (box: Box) => ({ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` });

/**
 * A split's columns, each one Chat or two stacked, laid out as sibling tiles so focus moving between them keeps the one
 * composer mounted; the hairlines on the seams drag the sizes.
 */
function SplitColumns({ columns, tile }: { columns: string[][]; tile: (key: string, column: number, row: number, box: CSSProperties) => ReactNode }) {
  const { sizes, change } = useSplitSizes();
  const area = useRef<HTMLDivElement>(null);
  const { weights, total, placed } = placeColumns(columns, sizes);
  const extent = () => area.current?.getBoundingClientRect() ?? null;
  return (
    <div ref={area} data-chat-split className="relative h-full min-h-0">
      {columns.flatMap((column, index) => {
        const { left: x, width, share } = placed[index]!;
        return column.map((key, row) =>
          tile(key, index, row, percent({ left: x, width, top: row === 0 ? 0 : share * 100, height: (row === 0 ? share : 1 - share) * 100 })),
        );
      })}
      {columns.map((column, index) => {
        const { left: x, width, share } = placed[index]!;
        const previous = columns[index - 1]?.[0];
        const below = column[1];
        return (
          <Fragment key={`seams-${column[0]}`}>
            {previous && (
              <SplitDivider
                axis="x"
                label="Resize columns"
                min={COLUMN_MIN}
                style={{ left: `${x}%`, top: 0, bottom: 0 }}
                measure={() => {
                  const box = extent();
                  return box && { first: (box.width * weights[index - 1]!) / total, total: (box.width * (weights[index - 1]! + weights[index]!)) / total };
                }}
                onShare={(next, commit) => change(shareColumns(sizes, previous, column[0]!, next), commit)}
              />
            )}
            {below && (
              <SplitDivider
                axis="y"
                label="Resize rows"
                min={ROW_MIN}
                fade={index === 0}
                style={{ left: `${x}%`, width: `${width}%`, top: `${share * 100}%` }}
                measure={() => {
                  const box = extent();
                  return box && { first: box.height * share, total: box.height };
                }}
                onShare={(next, commit) => change(shareRows(sizes, below, next), commit)}
              />
            )}
          </Fragment>
        );
      })}
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
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-12 text-ink-3">
        <span>This Chat can't be shown in the grid.</span>
        <Button variant="ghost" size={28} onClick={this.props.onOpen}>
          Open it
        </Button>
      </div>
    );
  }
}

function tileClass(split: boolean, focused: boolean, needsYou: boolean) {
  const pointer = focused ? "" : "cursor-pointer";
  if (split) return `group/tile absolute flex min-h-0 min-w-0 flex-col ${pointer}`;
  const border = focused ? "border-line-strong" : needsYou ? "border-orange" : "border-line transition-colors duration-fast hover:border-line-strong";
  return `flex min-h-0 min-w-0 flex-col overflow-hidden rounded-window border bg-surface ${pointer} ${border}`;
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
  menu,
  tiles,
  waitingBelow,
  split,
  children,
}: {
  chatKey: string;
  focused: boolean;
  /** A split pane: no card, its header in the title bar, and a reply box when unfocused. */
  split?: { first: boolean; top: boolean; box: CSSProperties; panelMenu?: ReactNode; onStop?: (key: string) => void };
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
  menu?: TileMenuControls;
  tiles: readonly string[];
  /** Subchats waiting on the user: an unfocused tile has no composer, so its header says it instead of the pill. */
  waitingBelow: number;
  children: ReactNode;
}) {
  const scope = projectOfKey(chatKey);
  const id = sessionIdFromKey(chatKey);
  const session = state?.sessions[id];
  const lean = isLean(state);
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
  const tile = useRef<HTMLElement>(null);
  return (
    <section
      ref={tile}
      data-chat-tile={chatKey}
      data-focused={focused || undefined}
      aria-label={title}
      onClick={focused ? undefined : (event) => clickFocusesTile(event) && onFocus(chatKey)}
      className={tileClass(Boolean(split), focused, needsYou)}
      style={split?.box}
    >
      {split ? (
        <SplitHeader
          chatKey={chatKey}
          title={title}
          focused={focused}
          first={split.first}
          top={split.top}
          tiles={tiles}
          menu={menu}
          panelMenu={split.panelMenu}
          needsYou={needsYou}
          waitingBelow={waitingBelow}
          onFocus={onFocus}
          routine={session?.routine}
          onOpenRoutine={onOpenRoutine}
          onClose={onClose}
        />
      ) : (
        <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-3 text-13">
          <ChatMarkDot mark={mark} background={activity.background} />
          <span className="min-w-0 truncate font-medium text-ink">{title}</span>
          <span className="min-w-0 flex-1 truncate text-ink-3">
            {scope.split("/").pop()}
            {branch ? ` · ${branch}` : ""}
          </span>
          {onOpenRoutine && session && <RoutineChip chatKey={chatKey} run={session.routine} place="tile" onOpen={onOpenRoutine} />}
          {needsYou && !focused && <span className="shrink-0 font-medium text-orange-ink">Needs you</span>}
          {waitingBelow > 0 && !focused && (
            <span data-tile-waiting className="shrink-0 font-medium text-orange-ink">
              {waitingBelow} {waitingBelow === 1 ? "needs" : "need"} you
            </span>
          )}
          {!isDraftTileKey(chatKey) && (
            <IconButton
              label={pinned ? "Remove from grid" : "Keep in grid"}
              icon={pinned ? PinOffIcon : PinIcon}
              size={24}
              side="bottom"
              aria-pressed={pinned}
              data-tile-pin
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(chatKey);
              }}
            />
          )}
          {mark === "unread" && !focused && (
            <IconButton
              label="Mark read"
              icon={Cancel01Icon}
              size={24}
              side="bottom"
              data-tile-dismiss
              onClick={(event) => {
                event.stopPropagation();
                onDismiss(chatKey);
              }}
            />
          )}
        </header>
      )}
      {focused ? (
        <div
          className={`flex min-h-0 flex-1 flex-col [container-type:size] ${split ? "[--window-chrome-height:0px] [&_.chat-column]:pt-4 [&_.chat-top-blur]:hidden" : ""}`}
        >
          {children}
        </div>
      ) : (
        <TileBoundary onOpen={() => onFocus(chatKey)}>
          <MessageSelection
            container={tile}
            provider={session && "provider" in session ? session.provider : undefined}
            onQuote={(quote) => {
              sendQuote(chatKey, quote);
              onFocus(chatKey);
            }}
          />
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
                  streamingKey={run ? chatKey : undefined}
                  streamingSteps={run?.steps}
                  asking={Boolean(run?.questions.length)}
                  runStartedAt={run?.startedAt}
                  models={models}
                />
              </EditorLinks>
            </ScopeContext.Provider>
          </BridgeContext.Provider>
          {split && <SplitReply title={title} running={Boolean(run)} onReply={() => onFocus(chatKey)} onStop={() => split.onStop?.(chatKey)} />}
        </TileBoundary>
      )}
    </section>
  );
});

function dropLabel({ tile, axis, side }: GridDropTarget) {
  if (axis === "y") return tile === null ? (side === "before" ? "Open above" : "Open below") : side === "before" ? "Add above" : "Add below";
  return tile === null ? "Open beside" : side === "before" ? "Add before" : "Add after";
}

/** Where a Chat dragged out of the sidebar would land: the half it takes, the edge it goes in at and what the drop does. */
export function GridDropOverlay() {
  const target = useGridDropTarget();
  if (!target) return null;
  const { area, bar } = target;
  const label = dropLabel(target);
  return createPortal(
    <div aria-hidden data-grid-drop={target.tile ?? "pane"} className="pointer-events-none fixed inset-0 z-50">
      <div className="absolute rounded-window bg-accent-tint" style={area} />
      <div className="absolute rounded-full bg-accent" style={bar} />
      <div
        className="absolute rounded-full bg-accent-ink px-2.5 py-1 text-12 font-medium whitespace-nowrap text-on-accent"
        style={{ left: area.left + 12, top: area.top + area.height - 40 }}
      >
        {label}
      </div>
    </div>,
    document.body,
  );
}
