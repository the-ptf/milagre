import { scopeKey } from "@milagre/shared/chat-scopes";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ReactFlow,
  BaseEdge,
  ConnectionMode,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  applyNodeChanges,
  getSmoothStepPath,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  BubbleChatIcon,
  Folder01Icon,
  GitBranchIcon,
  Link04Icon,
  MinusSignIcon,
  PlusSignIcon,
  ShieldAlertIcon,
  FitToScreenIcon,
} from "@hugeicons/core-free-icons";
import {
  canvasAttention,
  canvasFilterCounts,
  canvasStatus,
  canvasWorktrees,
  matchesCanvasFilter,
  type CanvasChat,
  type CanvasFilter,
  type CanvasMark,
  type CanvasTone,
  type CanvasWorktree,
} from "@milagre/shared/canvas";
import type { AgentRuns } from "@/lib/agent-runs";
import type { CanvasSnapshot, LinkEndpoint } from "@/electron";
import type { CoordinatorState, LinkedWork, NamedProjectLink } from "@/model";
import { chatMark } from "@/lib/chat-list";
import { chatKey, chatsAskingUser, chatsRunning, chatsWaitingForUser } from "@/lib/agent-runs";
import { delegatedChats } from "@/lib/linked-work";
import { useProjectImages } from "@/lib/project-images";
import { NEGOTIATION_ROUNDS } from "@milagre/shared/limits";
import { DiffBar } from "./changes/ChangesChrome";
import { ProviderLogo } from "./ProviderLogo";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { SpinnerRing } from "./primitives/SpinnerRing";
import Tooltip from "./primitives/Tooltip";

/* ─────────────────────────────────────────────────────────
 * LAYOUT
 * A Project is a tinted section; its Worktrees are cards inside it, one per Worktree, listing the chats the
 * sidebar shows. Card heights follow from their rows, so sections can be sized before React Flow measures.
 * ───────────────────────────────────────────────────────── */
const CARD_WIDTH = 276;
const SECTION_PADDING = 16;
const SECTION_HEADER = 52;
const CARD_GAP = 12;
const SECTION_GAP = 96;
const ROW_WIDTH = 1400;
// A card: 1px border, 12px padding, then 38px per chat; two or more chats add 21px dividers and a 26px footer.
const CHAT_ROW = 38;
const DIVIDER = 21;
const FOOTER = 26;
const cardHeight = (rows: number) => 26 + rows * CHAT_ROW + (rows > 1 ? (rows - 1) * DIVIDER + FOOTER : 0);

type CardRow = CanvasChat & { shared?: { linkId: string } };
type SectionData = {
  kind: "project";
  endpoint: LinkEndpoint;
  name: string;
  projectPath: string;
  image: string | null;
  tone: string;
  chatCount: number;
  worktreeCount: number;
  onNewChat?: (projectPath: string) => void;
  [key: string]: unknown;
};
type CardData = {
  kind: "worktree";
  endpoint: LinkEndpoint;
  projectPath: string;
  worktree: CanvasWorktree;
  rows: CardRow[];
  dimmed: boolean;
  now: number;
  receiveOnly: ReadonlySet<number>;
  onOpenChat?: (projectPath: string, id: number) => void;
  [key: string]: unknown;
};
type SectionNode = Node<SectionData, "project">;
type CardNode = Node<CardData, "worktree">;
type CanvasNode = SectionNode | CardNode;
const nodeTypes = { project: SectionNode, worktree: WorktreeCard };
const edgeTypes = { link: LinkEdge, membership: MembershipEdge };

// Sections take one of the theme's quiet hues by Project, so neighbours read apart; orange stays for "waiting for you".
const SECTION_TONES = ["var(--accent)", "var(--green)", "var(--purple, var(--accent))"];
function sectionTone(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return SECTION_TONES[Math.abs(hash) % SECTION_TONES.length];
}

/* ─────────────────────────────────────────────────────────
 * EDGES
 * ───────────────────────────────────────────────────────── */
function MembershipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}: EdgeProps<Edge<{ name: string; linkId: string }>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} />
      <EdgeLabelRenderer>
        <span
          data-named-link={data?.linkId}
          className="pointer-events-none absolute rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {data?.name}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

/** What travels along a Link now: running Delegations, or a Negotiation the user can stop. */
type LinkActivity = { label: string; negotiationId?: string };
type LinkEdgeData = { activity?: LinkActivity; projects: boolean; onStop: (negotiationId: string) => void };

function linkActivity(work: LinkedWork, linkId: string): LinkActivity | undefined {
  const negotiation = work.negotiations.find((item) => item.link_id === linkId);
  if (negotiation) return { label: `Negotiation · round ${negotiation.round} of ${NEGOTIATION_ROUNDS}`, negotiationId: negotiation.id };
  const open = work.delegations.filter((item) => item.link_id === linkId);
  if (!open.length) return undefined;
  return { label: open.length === 1 ? `Delegation ${open[0].status}` : `${open.length} Delegations` };
}

function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data }: EdgeProps<Edge<LinkEdgeData>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 });
  const activity = data?.activity;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} className={activity ? "milagre-link-active" : undefined} />
      {(activity || data?.projects) && (
        <EdgeLabelRenderer>
          <div
            data-link-activity={activity ? id : undefined}
            data-project-link={!activity ? id : undefined}
            className={`nodrag nopan absolute flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium shadow-card ${
              activity ? "pointer-events-auto text-accent" : "pointer-events-none text-ink-2"
            }`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, zIndex: 1001 }}
          >
            {activity ? (
              <span className="size-1.5 rounded-full bg-accent" />
            ) : (
              <HugeiconsIcon icon={Folder01Icon} size={11} strokeWidth={1.8} color="currentColor" />
            )}
            <span>{activity?.label ?? "Projects"}</span>
            {activity?.negotiationId && (
              <button
                type="button"
                className="ml-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-ink-2 hover:bg-hover-2 hover:text-ink"
                onClick={() => data?.onStop(activity.negotiationId!)}
              >
                Stop
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** One dot per side; with a loose connection mode, either end of a new Link can start at either dot. */
function LinkHandles({ top }: { top?: number }) {
  const style = top === undefined ? undefined : { top };
  return (
    <>
      <Handle type="source" position={Position.Left} id="left" className="milagre-canvas-handle" style={style} />
      <Handle type="source" position={Position.Right} id="right" className="milagre-canvas-handle" style={style} />
    </>
  );
}

/* ─────────────────────────────────────────────────────────
 * NODES
 * ───────────────────────────────────────────────────────── */
function SectionNode({ data }: NodeProps<SectionNode>) {
  return (
    <div
      data-canvas-project={data.projectPath}
      className="milagre-canvas-section h-full w-full rounded-[16px]"
      style={{ "--section": data.tone } as CSSProperties}
    >
      <LinkHandles top={SECTION_HEADER / 2} />
      <div className="canvas-drag-handle flex h-[52px] cursor-grab items-center gap-2 px-4 active:cursor-grabbing">
        <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-ink text-[10px] font-semibold text-surface">
          <WorkspaceIcon src={data.image} fallback={data.name.slice(0, 1).toUpperCase()} />
        </span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{data.name}</span>
        <span className="shrink-0 text-[12px] text-ink-2">
          {data.chatCount === 1 ? "1 chat" : `${data.chatCount} chats`}
          {data.worktreeCount > 1 && ` · ${data.worktreeCount} worktrees`}
        </span>
        <span className="flex-1" />
        {data.onNewChat && (
          <Tooltip label={`New chat in ${data.name}`} align="end">
            <button
              type="button"
              aria-label={`New chat in ${data.name}`}
              data-canvas-new-chat={data.projectPath}
              className="nodrag flex size-7 items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink"
              onClick={() => data.onNewChat?.(data.projectPath)}
            >
              <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={1.8} color="currentColor" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

const toneClass: Record<CanvasTone, string> = { accent: "text-accent", orange: "text-orange", red: "text-red", ink3: "text-ink-2" };
const MARK_ICON = { question: BubbleChatIcon, waiting: ShieldAlertIcon, delegated: Link04Icon } as const;

/** The sidebar's mark: an icon when the chat asks for you, a spinner while it runs, a dot otherwise. */
function Mark({ mark, failed }: { mark: CanvasMark; failed: boolean }) {
  return (
    <span data-canvas-mark={mark} className="flex size-3.5 shrink-0 items-center justify-center">
      {mark === "running" ? (
        <SpinnerRing size={12} color="var(--accent)" />
      ) : mark in MARK_ICON ? (
        <span className={`flex ${mark === "waiting" ? "text-orange" : "text-accent"}`}>
          <HugeiconsIcon icon={MARK_ICON[mark as keyof typeof MARK_ICON]} size={13} strokeWidth={2} color="currentColor" />
        </span>
      ) : (
        <span className={`rounded-full ${mark === "unread" ? "size-2 bg-accent" : failed ? "size-1.5 bg-red" : "size-1.5 bg-ink-3 opacity-40"}`} />
      )}
    </span>
  );
}

function Diff({ diff }: { diff?: CanvasWorktree["diff"] }) {
  if (!diff || (!diff.added && !diff.removed)) return null;
  return (
    <span className="shrink-0 text-[11px] font-medium tabular-nums">
      <span className="text-green">+{diff.added}</span> <span className="text-red">−{diff.removed}</span>
    </span>
  );
}

function ChatRow({ row, data, single }: { row: CardRow; data: CardData; single: boolean }) {
  const status = row.shared ? { label: "The Link's shared conversation", tone: "ink3" as const } : canvasStatus(row, data.now);
  return (
    <button
      type="button"
      data-canvas-chat={row.id}
      className="group/chat flex h-[38px] w-full min-w-0 flex-col justify-between text-left"
      onClick={() => data.onOpenChat?.(row.shared ? scopeKey({ kind: "link", linkId: row.shared.linkId }) : data.projectPath, row.id)}
    >
      <span className="flex h-[18px] w-full min-w-0 items-center gap-2">
        <Mark mark={row.mark} failed={row.failed} />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-semibold text-ink group-hover/chat:underline">{row.title}</span>
        {single && <Diff diff={data.worktree.diff} />}
      </span>
      <span className="flex h-4 w-full min-w-0 items-center gap-1.5 pl-[22px] text-[12px] leading-4">
        <span className={`shrink-0 font-medium ${toneClass[status.tone]}`}>{status.label}</span>
        {single && <span className="min-w-0 truncate text-ink-3">· {data.worktree.branch}</span>}
        {data.receiveOnly.has(row.id) && (
          <span
            className="shrink-0 rounded border border-line px-1 text-[10px] text-ink-3"
            title="This Codex Chat can't use the linked tools: it gets the summary and receives Delegations only."
          >
            receive-only
          </span>
        )}
        <span className="flex-1" />
        {row.provider && <ProviderLogo provider={row.provider} size={12} />}
      </span>
    </button>
  );
}

function WorktreeCard({ data }: NodeProps<CardNode>) {
  const attention = canvasAttention(data.rows);
  const single = data.rows.length === 1;
  return (
    <div
      data-canvas-worktree={data.worktree.path}
      data-attention={attention}
      className={`milagre-canvas-card flex h-full w-full flex-col rounded-card border bg-surface p-3 shadow-card transition-opacity ${
        attention === "waiting" ? "border-orange ring-1 ring-orange" : attention === "question" ? "border-accent ring-1 ring-accent" : "border-line"
      } ${data.dimmed ? "opacity-35" : ""}`}
    >
      <LinkHandles />
      {data.rows.map((row, index) => (
        <div key={`${row.shared ? "shared" : "chat"}:${row.id}`}>
          {index > 0 && <div className="my-2.5 h-px bg-line" />}
          <ChatRow row={row} data={data} single={single} />
        </div>
      ))}
      {!single && (
        <div className="mt-2.5 flex h-4 items-center gap-1.5 pl-[22px] text-[11px] text-ink-2">
          <HugeiconsIcon icon={GitBranchIcon} size={12} strokeWidth={1.8} color="var(--ink-3)" />
          <span className="min-w-0 flex-1 truncate">{data.worktree.branch}</span>
          <Diff diff={data.worktree.diff} />
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * BUILDING THE GRAPH
 * ───────────────────────────────────────────────────────── */
const projectNodeId = (id: string) => `project:${encodeURIComponent(id)}`;
const worktreeNodeId = (id: string, path: string) => `worktree:${encodeURIComponent(id)}:${encodeURIComponent(path)}`;

type Built = { nodes: CanvasNode[]; worktrees: CanvasWorktree[] };

/** A card's rows: its chats, then the named Link's shared conversation when the Worktree takes part in one. */
const rowsOf = (worktree: CanvasWorktree): CardRow[] =>
  worktree.sharedChat
    ? [
        ...worktree.chats,
        { id: worktree.sharedChat.sessionId, title: "Shared Link Chat", mark: "idle", failed: false, shared: { linkId: worktree.sharedChat.linkId } },
      ]
    : worktree.chats;

/** Two columns once a Project has two or more Worktrees, each card under the shorter column. */
function defaultCardPositions(heights: number[]) {
  const columns = heights.length > 1 ? [SECTION_HEADER, SECTION_HEADER] : [SECTION_HEADER];
  return heights.map((height) => {
    const column = columns.indexOf(Math.min(...columns));
    const position = { x: SECTION_PADDING + column * (CARD_WIDTH + SECTION_PADDING), y: columns[column] };
    columns[column] += height + CARD_GAP;
    return position;
  });
}

/** A section's size: around its cards, wherever they were dragged. */
function sectionSize(cards: Array<{ position: { x: number; y: number }; height: number }>) {
  let width = CARD_WIDTH + 2 * SECTION_PADDING,
    height = SECTION_HEADER + SECTION_PADDING;
  for (const card of cards) {
    width = Math.max(width, card.position.x + CARD_WIDTH + SECTION_PADDING);
    height = Math.max(height, card.position.y + card.height + SECTION_PADDING);
  }
  return { width, height };
}

function buildNodes(
  snapshot: CanvasSnapshot,
  states: Record<string, CoordinatorState>,
  runs: AgentRuns,
  work: LinkedWork,
  filter: CanvasFilter,
  now: number,
  imageOf: (path: string) => string | null,
  keep: ReadonlySet<string>,
  handlers: { onOpenChat: (path: string, id: number) => void; onNewChat?: (path: string) => void },
): Built {
  const nodes: CanvasNode[] = [];
  const shown: CanvasWorktree[] = [];
  const cursor = { x: 0, y: 0, rowHeight: 0 };
  for (const project of snapshot.projects) {
    const state = states[project.path] ?? snapshot.states.find((entry) => entry.path === project.path)?.state;
    const asking = chatsAskingUser(runs, project.path);
    const waiting = chatsWaitingForUser(runs, project.path);
    const running = chatsRunning(runs, project.path, state?.sessions);
    const delegated = delegatedChats(work, project.path);
    const worktrees = canvasWorktrees(state, (id, unread) =>
      chatMark({ asking: asking.has(id), waiting: waiting.has(id), delegated: delegated.has(id), running: running.has(id), unread }),
    );
    // A Project with nothing active stays off the canvas, unless a Link or a named group needs it there.
    if (!worktrees.length && !keep.has(project.id)) continue;
    shown.push(...worktrees);
    const receiveOnly = new Set(
      worktrees.flatMap((worktree) => worktree.chats.filter((chat) => work.receiveOnly.includes(chatKey(project.path, chat.id))).map((chat) => chat.id)),
    );
    const heights = worktrees.map((worktree) => cardHeight(rowsOf(worktree).length));
    const defaults = defaultCardPositions(heights);
    const cards = worktrees.map((worktree, index) => ({
      worktree,
      height: heights[index],
      position: snapshot.worktreePositions[project.id]?.[worktree.path] ?? defaults[index],
    }));
    const size = sectionSize(cards);
    let position = project.position;
    if (!position) {
      if (cursor.x > 0 && cursor.x + size.width > ROW_WIDTH) Object.assign(cursor, { x: 0, y: cursor.y + cursor.rowHeight + SECTION_GAP, rowHeight: 0 });
      position = { x: cursor.x, y: cursor.y };
      cursor.x += size.width + SECTION_GAP;
      cursor.rowHeight = Math.max(cursor.rowHeight, size.height);
    }
    nodes.push({
      id: projectNodeId(project.id),
      type: "project",
      position,
      data: {
        kind: "project",
        endpoint: { project_id: project.id },
        name: project.name,
        projectPath: project.path,
        image: imageOf(project.path),
        tone: sectionTone(project.id),
        chatCount: worktrees.reduce((count, worktree) => count + rowsOf(worktree).length, 0),
        worktreeCount: worktrees.length,
        onNewChat: handlers.onNewChat,
      },
      style: size,
      dragHandle: ".canvas-drag-handle",
    });
    for (const card of cards)
      nodes.push({
        id: worktreeNodeId(project.id, card.worktree.path),
        type: "worktree",
        parentId: projectNodeId(project.id),
        extent: "parent",
        expandParent: true,
        position: card.position,
        data: {
          kind: "worktree",
          endpoint: { project_id: project.id, worktree_path: card.worktree.path },
          projectPath: project.path,
          worktree: card.worktree,
          rows: rowsOf(card.worktree),
          dimmed: filter !== "all" && !card.worktree.chats.some((chat) => matchesCanvasFilter(chat.mark, filter)),
          now,
          receiveOnly,
          onOpenChat: handlers.onOpenChat,
        },
        style: { width: CARD_WIDTH, height: card.height },
      });
  }
  return { nodes, worktrees: shown };
}

/** Sections follow their cards: dragging one toward an edge grows its section, dragging it back shrinks it. */
function fitSections(nodes: CanvasNode[]): CanvasNode[] {
  const cards = new Map<string, Array<{ position: { x: number; y: number }; height: number }>>();
  for (const node of nodes)
    if (node.parentId) {
      const list = cards.get(node.parentId) ?? [];
      list.push({ position: node.position, height: Number(node.style?.height ?? 0) });
      cards.set(node.parentId, list);
    }
  return nodes.map((node) => {
    if (node.type !== "project") return node;
    const size = sectionSize(cards.get(node.id) ?? []);
    if (node.width === size.width && node.height === size.height) return node;
    return { ...node, ...size, style: { ...node.style, ...size } };
  });
}

/* ─────────────────────────────────────────────────────────
 * CHROME
 * ───────────────────────────────────────────────────────── */
const FILTERS: Array<{ id: CanvasFilter; label: string; dot?: string }> = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you", dot: "bg-orange" },
  { id: "running", label: "Running", dot: "bg-accent" },
];

function FilterBar({ filter, counts, onChange }: { filter: CanvasFilter; counts: Record<CanvasFilter, number>; onChange: (filter: CanvasFilter) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Show chats"
      className="flex h-8 items-center gap-0.5 rounded-control bg-surface p-0.5 shadow-card [-webkit-app-region:no-drag]"
    >
      {FILTERS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={filter === item.id}
          data-canvas-filter={item.id}
          onClick={() => onChange(item.id)}
          className={`flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12.5px] font-medium transition-colors ${
            filter === item.id ? "bg-hover-2 text-ink" : "text-ink-2 hover:text-ink"
          }`}
        >
          {item.dot && <span className={`size-1.5 rounded-full ${item.dot}`} />}
          {item.label}
          <span className="tabular-nums">{counts[item.id]}</span>
        </button>
      ))}
    </div>
  );
}

function ZoomControls() {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const button = "flex size-8 items-center justify-center text-ink-2 transition-colors hover:text-ink";
  return (
    <div data-canvas-zoom className="flex h-8 items-center rounded-control bg-surface shadow-card">
      <button type="button" aria-label="Zoom out" className={button} onClick={() => void flow.zoomOut({ duration: 160 })}>
        <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={1.8} color="currentColor" />
      </button>
      <button
        type="button"
        aria-label="Zoom to 100%"
        className="w-11 text-center text-[12px] font-medium text-ink tabular-nums"
        onClick={() => void flow.zoomTo(1, { duration: 160 })}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label="Zoom in" className={button} onClick={() => void flow.zoomIn({ duration: 160 })}>
        <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.8} color="currentColor" />
      </button>
      <span className="h-4 w-px bg-line" />
      <button
        type="button"
        aria-label="Fit everything"
        className="flex h-8 items-center gap-1.5 px-2.5 text-[12px] font-medium text-ink transition-colors hover:text-ink-2"
        onClick={() => void flow.fitView({ padding: 0.15, duration: 200 })}
      >
        <HugeiconsIcon icon={FitToScreenIcon} size={13} strokeWidth={1.8} color="currentColor" />
        Fit
      </button>
    </div>
  );
}

export function CanvasView({
  states,
  runs,
  linkedWork,
  onOpenChat,
  onNewChat,
  onBack,
  focusLink,
}: {
  states: Record<string, CoordinatorState>;
  runs: AgentRuns;
  linkedWork: LinkedWork;
  onOpenChat: (projectPath: string, id: number) => void;
  /** Starts a chat in a Project; the section's + button is there only with it. */
  onNewChat?: (projectPath: string) => void;
  onBack: () => void;
  focusLink?: NamedProjectLink;
}) {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CanvasFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState<CanvasWorktree[]>([]);
  const [connecting, setConnecting] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await window.milagre.getCanvas());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  // "Idle · 25m ago" stays true without a state change.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const openChatRef = useRef(onOpenChat);
  openChatRef.current = onOpenChat;
  const openChat = useCallback((path: string, id: number) => openChatRef.current(path, id), []);
  const newChatRef = useRef(onNewChat);
  newChatRef.current = onNewChat;
  const newChat = useCallback((path: string) => newChatRef.current?.(path), []);
  const visible = useMemo(
    () => (snapshot && focusLink ? { ...snapshot, projects: snapshot.projects.filter((project) => focusLink.projectIds.includes(project.id)) } : snapshot),
    [snapshot, focusLink],
  );
  const imageOf = useProjectImages(useMemo(() => visible?.projects.map((project) => project.path) ?? [], [visible]));
  // Projects a Link or a named group reaches stay on the canvas even with no active chat, so the line has two ends.
  const keep = useMemo(() => {
    const ids = new Set<string>();
    for (const link of visible?.links ?? []) for (const end of [link.a, link.b]) if (!end.worktree_path) ids.add(end.project_id);
    for (const group of focusLink ? [focusLink] : (visible?.projectGroups ?? [])) for (const id of group.projectIds) ids.add(id);
    return ids;
  }, [visible, focusLink]);
  const imageKey = visible?.projects.map((project) => imageOf(project.path) ?? "").join("\n");
  useEffect(() => {
    if (!visible) return;
    const built = buildNodes(visible, states, runs, linkedWork, filter, now, imageOf, keep, {
      onOpenChat: openChat,
      onNewChat: onNewChat ? newChat : undefined,
    });
    setShown(built.worktrees);
    setNodes((previous) =>
      fitSections(
        built.nodes.map((node) => {
          const old = previous.find((item) => item.id === node.id);
          return old ? ({ ...node, position: old.position } as CanvasNode) : node;
        }),
      ),
    );
    // imageOf changes identity every render; imageKey says when an image actually arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, states, runs, linkedWork, filter, now, imageKey, keep, openChat, newChat, Boolean(onNewChat)]);
  const counts = useMemo(() => canvasFilterCounts(shown), [shown]);
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => setNodes((current) => fitSections(applyNodeChanges(changes, current))), []);
  const stopNegotiation = useCallback((id: string) => {
    window.milagre.stopNegotiation(id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edges = useMemo(() => {
    // A Link leaves the side facing the other end, so its line and its label run between the two.
    const centerX = (id: string) => {
      const node = nodeById.get(id);
      const parent = node?.parentId ? nodeById.get(node.parentId) : undefined;
      const width = Number(node?.style?.width ?? 0);
      return (node?.position.x ?? 0) + (parent?.position.x ?? 0) + width / 2;
    };
    const sides = (source: string, target: string) =>
      centerX(source) <= centerX(target) ? { sourceHandle: "right", targetHandle: "left" } : { sourceHandle: "left", targetHandle: "right" };
    const canvasEdges = (visible?.links ?? []).flatMap((link) => {
      const source = link.a.worktree_path ? worktreeNodeId(link.a.project_id, link.a.worktree_path) : projectNodeId(link.a.project_id);
      const target = link.b.worktree_path ? worktreeNodeId(link.b.project_id, link.b.worktree_path) : projectNodeId(link.b.project_id);
      if (!nodeById.has(source) || !nodeById.has(target)) return [];
      const selected = link.id === selectedLink;
      return [
        {
          id: link.id,
          source,
          target,
          ...sides(source, target),
          type: "link" as const,
          selected,
          zIndex: 1,
          data: { activity: linkActivity(linkedWork, link.id), projects: !link.a.worktree_path && !link.b.worktree_path, onStop: stopNegotiation },
          style: { stroke: selected ? "var(--color-accent)" : "var(--color-ink-3)", strokeWidth: selected ? 2 : 1.5 },
        },
      ];
    });
    const groups = focusLink ? [focusLink] : (visible?.projectGroups ?? []);
    const memberships = groups.flatMap((group) => {
      const members = group.projectIds.map(projectNodeId).filter((id) => nodeById.has(id));
      return members.slice(1).map((target) => ({
        id: `membership:${group.id}:${target}`,
        source: members[0],
        target,
        type: "membership",
        ...sides(members[0], target),
        selectable: false,
        deletable: false,
        data: { name: group.name, linkId: group.id },
        style: { stroke: "var(--color-accent)", strokeWidth: 1.5, strokeDasharray: "5 4" },
      }));
    });
    return [...canvasEdges, ...memberships];
  }, [visible?.links, visible?.projectGroups, focusLink, selectedLink, linkedWork, stopNegotiation, nodeById]);
  const connect = useCallback(
    async (connection: Connection) => {
      const a = nodeById.get(connection.source)?.data.endpoint;
      const b = nodeById.get(connection.target)?.data.endpoint;
      if (!a || !b) return;
      try {
        const links = await window.milagre.addLink(a, b);
        setSnapshot((current) => current && { ...current, links });
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [nodeById],
  );
  const remove = async () => {
    if (!selectedLink) return;
    try {
      const links = await window.milagre.removeLink(selectedLink);
      setSnapshot((current) => current && { ...current, links });
      setSelectedLink(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const savePosition = async (_event: unknown, node: CanvasNode) => {
    try {
      if (node.data.kind === "project") await window.milagre.setProjectPosition(node.data.endpoint.project_id, node.position);
      else if (node.data.endpoint.worktree_path)
        await window.milagre.setWorktreePosition(node.data.endpoint.project_id, node.data.endpoint.worktree_path, node.position);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <section data-canvas className="milagre-canvas relative flex min-h-0 flex-1 flex-col">
      <DiffBar
        open
        onBack={onBack}
        trailing={
          <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
            {selectedLink && (
              <button
                type="button"
                data-canvas-remove-link
                className="h-8 rounded-control bg-surface px-3 text-[12.5px] font-medium text-red shadow-card transition-colors hover:bg-hover"
                onClick={() => void remove()}
              >
                Remove Link
              </button>
            )}
            <FilterBar filter={filter} counts={counts} onChange={setFilter} />
          </div>
        }
      />
      {error && (
        <div
          role="alert"
          className="absolute inset-x-5 top-14 z-30 rounded-control border border-line bg-surface px-3 py-2 text-[13px] text-red shadow-overlay"
        >
          {error}
        </div>
      )}
      <div className="milagre-canvas-surface min-h-0 flex-1">
        {snapshot ? (
          <ReactFlow
            className="milagre-canvas-flow"
            data-connecting={connecting || undefined}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onConnect={(connection) => void connect(connection)}
            onConnectStart={() => setConnecting(true)}
            onConnectEnd={() => setConnecting(false)}
            isValidConnection={(connection) => connection.source !== connection.target}
            connectionMode={ConnectionMode.Loose}
            onNodeDragStop={(event, node) => void savePosition(event, node)}
            onEdgeClick={(_event, edge) => {
              if (edge.type === "link") setSelectedLink(edge.id);
            }}
            onPaneClick={() => setSelectedLink(null)}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            nodesConnectable
            edgesReconnectable={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Panel position="bottom-left" style={{ margin: "0 0 20px 24px" }}>
              <ZoomControls />
            </Panel>
            {!nodes.length && (
              <Panel position="top-center" className="!top-1/3 text-[13px] text-ink-3">
                No active chats. Chats the sidebar shows appear here.
              </Panel>
            )}
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-3">Loading Projects…</div>
        )}
      </div>
    </section>
  );
}
