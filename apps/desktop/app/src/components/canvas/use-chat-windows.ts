import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { useRuns } from "@/lib/agent-runs-store";
import { closeChat, forgetGone, keepOnCanvas, openChat as withChatOpen, type Box } from "@/lib/canvas-open";
import { DURATION } from "@/lib/ease";
import { isModalOpen } from "@/lib/modal";
import { useScopeStates } from "@/lib/sidebar-scopes";
import type { CoordinatorState } from "@/model";
import type { CanvasChatActions, CanvasChatContextValue } from "./CanvasChat";
import { patchRecord, readWindowRecords, saveWindowRecords } from "./ChatWindows";
import { windowNodeId, type Built, type CanvasNode } from "./graph";

const DOUBLE_CLICK_MS = 450;
const FOCUS_MS = DURATION.base * 1000;
const DIALOGS = 'dialog, [role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper]';

let openThisSession: string[] = [];

/** The Chats open as windows on the canvas, what this computer keeps of them, and what their windows read. */
export function useChatWindows({
  chatActions,
  states,
  onOpenChat,
  flow,
  surface,
  nodes,
  dragged,
  paused,
  now,
  onError,
}: {
  chatActions: CanvasChatActions | undefined;
  states: Record<string, CoordinatorState>;
  onOpenChat: (projectPath: string, id: number) => void;
  flow: ReactFlowInstance<CanvasNode> | null;
  surface: RefObject<HTMLDivElement | null>;
  nodes: readonly CanvasNode[];
  dragged: RefObject<Map<string, { x: number; y: number }>>;
  paused: boolean;
  now: number;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState<string[]>(() => openThisSession);
  useEffect(() => {
    openThisSession = open;
  }, [open]);
  const liveRuns = useRuns(Boolean(chatActions));
  const lastOpened = useRef<{ key: string; at: number } | null>(null);
  const focusPending = useRef<string | null>(null);
  const openWindow = useCallback(
    (key: string) => {
      const last = lastOpened.current;
      if (last?.key === key && Date.now() - last.at < DOUBLE_CLICK_MS) {
        lastOpened.current = null;
        onOpenChat(projectOfKey(key), sessionIdFromKey(key));
        return;
      }
      lastOpened.current = { key, at: Date.now() };
      focusPending.current = key;
      setOpen((current) => withChatOpen(current, key));
    },
    [onOpenChat],
  );
  const close = useCallback((key: string) => {
    if (lastOpened.current?.key === key) lastOpened.current = null;
    setOpen((current) => closeChat(current, key));
  }, []);
  useEffect(() => {
    if (!chatActions) setOpen((current) => (current.length ? [] : current));
  }, [chatActions]);
  const [records, setRecords] = useState(readWindowRecords);
  const bendLine = useCallback((key: string, offset: { x: number; y: number } | null) => {
    setRecords((current) => patchRecord(current, key, { bend: offset ?? undefined }));
  }, []);
  const resizeWindow = useCallback(
    (key: string, box: Box) => {
      dragged.current.set(windowNodeId(key), { x: box.x, y: box.y });
      setRecords((current) => patchRecord(current, key, box));
    },
    [dragged],
  );
  const moveWindow = useCallback((key: string, at: { x: number; y: number }) => {
    setRecords((current) => patchRecord(current, key, at));
  }, []);
  const prune = useCallback((built: Built) => {
    setOpen((current) => keepOnCanvas(current, built.onCanvas, built.considered, projectOfKey));
    setRecords((current) => {
      const next = forgetGone(current, built.onCanvas, built.drawn, projectOfKey);
      return next === current ? current : saveWindowRecords(next);
    });
  }, []);
  const openScopes = useMemo(() => [...new Set(open.map(projectOfKey))].filter((path) => !states[path]), [open, states]);
  const { states: readStates } = useScopeStates(open.length > 0, openScopes);
  const chatStates = useMemo(() => ({ ...readStates, ...states }), [readStates, states]);

  useEffect(() => {
    const key = focusPending.current;
    if (!flow || !key) return;
    const node = nodes.find((item) => item.type === "chatwindow" && item.data.chatKey === key);
    const size = node?.measured;
    if (!node || !size?.width || !size.height) return;
    const frame = requestAnimationFrame(() => {
      focusPending.current = null;
      const { x, y, zoom } = flow.getViewport();
      const pane = surface.current?.getBoundingClientRect();
      const left = node.position.x * zoom + x;
      const top = node.position.y * zoom + y;
      const inSight = pane && left >= 0 && top >= 0 && left + size.width! * zoom <= pane.width && top + size.height! * zoom <= pane.height;
      if (!inSight) void flow.fitView({ nodes: [{ id: node.id }], padding: 0.08, maxZoom: zoom, duration: FOCUS_MS });
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, nodes, surface]);

  useEffect(() => {
    if (!open.length || paused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(DIALOGS) || isModalOpen()) return;
      const inside = target?.closest<HTMLElement>("[data-canvas-open-chat]")?.dataset.canvasOpenChat;
      const key = inside && open.includes(inside) ? inside : open.at(-1);
      if (!key) return;
      event.preventDefault();
      close(key);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, paused, close]);

  const chatContext = useMemo<CanvasChatContextValue>(
    () => ({ states: chatStates, runs: liveRuns, actions: chatActions, onOpenFull: onOpenChat, onClose: close, onError, now }),
    [chatStates, liveRuns, chatActions, onOpenChat, close, onError, now],
  );
  return { open, closeAll: () => setOpen([]), liveRuns, openWindow, records, bendLine, resizeWindow, moveWindow, prune, chatContext };
}
