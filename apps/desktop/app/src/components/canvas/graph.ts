import type { Node } from "@xyflow/react";
import {
  canvasLive,
  canvasWorktrees,
  matchesCanvasFilter,
  type CanvasChat,
  type CanvasFilter,
  type CanvasLive,
  type CanvasWorktree,
} from "@milagre/shared/canvas";
import type { AgentRuns, RunStatuses } from "@/lib/agent-runs";
import { chatKey, chatsAskingUser, chatsInBackground, chatsRunning, chatsWaitingForUser } from "@/lib/agent-runs";
import type { CanvasSnapshot, LinkEndpoint } from "@/electron";
import type { CoordinatorState, LinkedWork } from "@/model";
import { chatMark } from "@/lib/chat-list";
import { delegatedChats } from "@/lib/linked-work";
import { WINDOW, liveHeight, placeWindows, type Box, type WindowRecord } from "@/lib/canvas-open";

const CARD_WIDTH = 276;
const SECTION_PADDING = 16;
export const SECTION_HEADER = 52;
const CARD_GAP = 12;
const SECTION_GAP = 96;
const ROW_WIDTH = 1400;

const CHAT_ROW = 38;
const DIVIDER = 21;
const FOOTER = 26;
const cardHeight = (rows: readonly CardRow[]) =>
  26 + rows.length * CHAT_ROW + (rows.length > 1 ? (rows.length - 1) * DIVIDER + FOOTER : 0) + rows.reduce((sum, row) => sum + liveHeight(row.live), 0);

export type CardRow = CanvasChat & { shared?: { linkId: string }; live?: CanvasLive };
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
export type CardData = {
  kind: "worktree";
  endpoint: LinkEndpoint;
  projectPath: string;
  worktree: CanvasWorktree;
  rows: CardRow[];
  dimmed: boolean;
  now: number;
  receiveOnly: ReadonlySet<number>;
  onOpenChat?: (projectPath: string, id: number) => void;
  onOpenWindow?: (key: string) => void;
  opened?: readonly string[];
  [key: string]: unknown;
};
type WindowData = {
  kind: "window";
  chatKey: string;
  cardId: string;
  row: CardRow;
  branch: string;
  onResize: (key: string, box: Box) => void;
  [key: string]: unknown;
};
export type SectionNode = Node<SectionData, "project">;
export type CardNode = Node<CardData, "worktree">;
export type WindowNode = Node<WindowData, "chatwindow">;
export type CanvasNode = SectionNode | CardNode | WindowNode;

export const endpointOf = (node: CanvasNode | undefined) => (node && node.data.kind !== "window" ? node.data.endpoint : undefined);

const SECTION_TONES: [string, ...string[]] = ["var(--accent)", "var(--green)", "var(--purple, var(--accent))"];
function sectionTone(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return SECTION_TONES[Math.abs(hash) % SECTION_TONES.length] ?? SECTION_TONES[0];
}

export const projectNodeId = (id: string) => `project:${encodeURIComponent(id)}`;
export const worktreeNodeId = (id: string, path: string) => `worktree:${encodeURIComponent(id)}:${encodeURIComponent(path)}`;
export const windowNodeId = (key: string) => `chatwindow:${encodeURIComponent(key)}`;
export const WINDOW_Z = 1100;

export type Built = {
  nodes: CanvasNode[];
  worktrees: CanvasWorktree[];
  onCanvas: Set<string>;
  drawn: Set<string>;
  considered: Set<string>;
};

const rowsOf = (worktree: CanvasWorktree, liveOf?: (id: number) => CanvasLive | undefined): CardRow[] => {
  const chats = liveOf
    ? worktree.chats.map((chat) => {
        const live = liveOf(chat.id);
        return live ? { ...chat, live } : chat;
      })
    : worktree.chats;
  return worktree.sharedChat
    ? [...chats, { id: worktree.sharedChat.sessionId, title: "Shared Link Chat", mark: "idle", failed: false, shared: { linkId: worktree.sharedChat.linkId } }]
    : chats;
};

function defaultCardPositions(worktrees: CanvasWorktree[], liveOf?: (id: number) => CanvasLive | undefined) {
  const columns: [number, number] = [SECTION_HEADER, SECTION_HEADER];
  return worktrees.map((worktree) => {
    const rows = rowsOf(worktree, liveOf);
    const height = cardHeight(rows);
    const column = columns[0] <= columns[1] ? 0 : 1;
    const position = { x: SECTION_PADDING + column * (CARD_WIDTH + SECTION_PADDING), y: columns[column] };
    columns[column] += height + CARD_GAP;
    return { worktree, rows, height, position };
  });
}

function sectionSize(cards: Array<{ position: { x: number; y: number }; height: number }>) {
  let width = CARD_WIDTH + 2 * SECTION_PADDING,
    height = SECTION_HEADER + SECTION_PADDING;
  for (const card of cards) {
    width = Math.max(width, card.position.x + CARD_WIDTH + SECTION_PADDING);
    height = Math.max(height, card.position.y + card.height + SECTION_PADDING);
  }
  return { width, height };
}

export function buildNodes(
  snapshot: CanvasSnapshot,
  states: Record<string, CoordinatorState>,
  runs: RunStatuses,
  live: AgentRuns,
  work: LinkedWork,
  filter: CanvasFilter,
  now: number,
  imageOf: (path: string) => string | null,
  keep: ReadonlySet<string>,
  handlers: {
    onOpenChat: (path: string, id: number) => void;
    onNewChat?: (path: string) => void;
    onOpenWindow?: (key: string) => void;
    onResize: (key: string, box: Box) => void;
  },
  open: readonly string[] = [],
  dragged: ReadonlyMap<string, { x: number; y: number }> = new Map(),
  records: Readonly<Record<string, WindowRecord>> = {},
): Built {
  const nodes: CanvasNode[] = [];
  const shown: CanvasWorktree[] = [];
  const onCanvas = new Set<string>();
  const drawn = new Set<string>();
  const considered = new Set<string>();
  const sections: Box[] = [];
  const projectWindows: Array<{ section: Box; windows: Array<{ key: string; cardId: string; top: number; row: CardRow; branch: string }> }> = [];
  const cursor = { x: 0, y: 0, rowHeight: 0 };
  for (const project of snapshot.projects) {
    considered.add(project.path);
    const state = states[project.path] ?? snapshot.states.find((entry) => entry.path === project.path)?.state;
    const asking = chatsAskingUser(runs, project.path);
    const waiting = chatsWaitingForUser(runs, project.path);
    const running = chatsRunning(runs, project.path);
    const background = chatsInBackground(runs, project.path, state?.sessions);
    const delegated = delegatedChats(work, project.path);
    const worktrees = canvasWorktrees(state, (id, unread) => {
      const mark = chatMark({
        asking: asking.has(id),
        waiting: waiting.has(id),
        delegated: delegated.has(id),
        running: running.has(id),
        background: background.has(id),
        unread,
      });
      return mark === "interrupted" ? "idle" : mark;
    });
    if (!worktrees.length && !keep.has(project.id)) continue;
    drawn.add(project.path);
    shown.push(...worktrees);
    const receiveOnly = new Set(
      worktrees.flatMap((worktree) => worktree.chats.filter((chat) => work.receiveOnly.includes(chatKey(project.path, chat.id))).map((chat) => chat.id)),
    );
    const liveOf = handlers.onOpenWindow ? (id: number) => canvasLive(live[chatKey(project.path, id)]) : undefined;
    const cards = defaultCardPositions(worktrees, liveOf).map((card) => {
      const id = worktreeNodeId(project.id, card.worktree.path);
      return { ...card, id, position: dragged.get(id) ?? snapshot.worktreePositions[project.id]?.[card.worktree.path] ?? card.position };
    });
    const size = sectionSize(cards);
    const sectionId = projectNodeId(project.id);
    let position = dragged.get(sectionId) ?? project.position;
    if (!position) {
      if (cursor.x > 0 && cursor.x + size.width > ROW_WIDTH) Object.assign(cursor, { x: 0, y: cursor.y + cursor.rowHeight + SECTION_GAP, rowHeight: 0 });
      position = { x: cursor.x, y: cursor.y };
      cursor.x += size.width + SECTION_GAP;
      cursor.rowHeight = Math.max(cursor.rowHeight, size.height);
    }
    nodes.push({
      id: sectionId,
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
    const section = { x: position.x, y: position.y, ...size };
    sections.push(section);
    const windows: (typeof projectWindows)[number]["windows"] = [];
    for (const card of cards) {
      const keys = card.rows.filter((row) => !row.shared).map((row) => chatKey(project.path, row.id));
      for (const key of keys) onCanvas.add(key);
      nodes.push({
        id: card.id,
        type: "worktree",
        parentId: sectionId,
        extent: "parent",
        expandParent: true,
        position: card.position,
        data: {
          kind: "worktree",
          endpoint: { project_id: project.id, worktree_path: card.worktree.path },
          projectPath: project.path,
          worktree: card.worktree,
          rows: card.rows,
          dimmed: filter !== "all" && !card.worktree.chats.some((chat) => matchesCanvasFilter(chat.mark, filter)),
          now,
          receiveOnly,
          onOpenChat: handlers.onOpenChat,
          ...(handlers.onOpenWindow ? { onOpenWindow: handlers.onOpenWindow, opened: open.filter((key) => keys.includes(key)) } : {}),
        },
        style: { width: CARD_WIDTH, height: card.height },
      });
      if (!handlers.onOpenWindow) continue;
      for (const row of card.rows) {
        const key = chatKey(project.path, row.id);
        if (!row.shared && open.includes(key)) windows.push({ key, cardId: card.id, top: position.y + card.position.y, row, branch: card.worktree.branch });
      }
    }
    windows.sort((a, b) => open.indexOf(a.key) - open.indexOf(b.key));
    projectWindows.push({ section, windows });
  }
  const sizeOf = (key: string) => ({ width: records[key]?.width ?? WINDOW.width, height: records[key]?.height ?? WINDOW.height });
  const placedAt = (key: string) => {
    const saved = records[key];
    return dragged.get(windowNodeId(key)) ?? (saved?.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : undefined);
  };
  const taken: Box[] = [...sections];
  for (const { windows } of projectWindows)
    for (const { key } of windows) {
      const at = placedAt(key);
      if (at) taken.push({ ...at, ...sizeOf(key) });
    }
  for (const { section, windows } of projectWindows) {
    const fresh = windows.filter(({ key }) => !placedAt(key));
    const places = placeWindows(
      section,
      taken,
      fresh.map(({ key, top }) => ({ top, ...sizeOf(key) })),
    );
    fresh.forEach(({ key }, index) => taken.push({ ...places[index]!, ...sizeOf(key) }));
    for (const { key, cardId, row, branch } of windows) {
      const at = placedAt(key) ?? places[fresh.findIndex((item) => item.key === key)]!;
      nodes.push({
        id: windowNodeId(key),
        type: "chatwindow",
        position: at,
        ...sizeOf(key),
        zIndex: WINDOW_Z + open.indexOf(key),
        dragHandle: ".canvas-window-drag",
        data: { kind: "window", chatKey: key, cardId, row, branch, onResize: handlers.onResize },
      });
    }
  }
  return { nodes, worktrees: shown, onCanvas, drawn, considered };
}

export function fitSections(nodes: CanvasNode[]): CanvasNode[] {
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

export const nodeLook = (node: CanvasNode) =>
  JSON.stringify([node.type, node.position, node.width, node.height, node.style, node.zIndex, node.data], (_key, value: unknown) =>
    value instanceof Set ? [...value] : value,
  );
