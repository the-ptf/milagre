import { useEffect, useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { CanvasFilter, CanvasWorktree } from "@milagre/shared/canvas";
import type { RunStatuses } from "@/lib/agent-runs";
import type { CanvasSnapshot } from "@/electron";
import { useProjectImages } from "@/lib/project-images";
import type { CoordinatorState, LinkedWork, NamedProjectLink } from "@/model";
import { buildNodes, fitSections, nodeLook, type CanvasNode } from "./graph";
import type { useChatWindows } from "./use-chat-windows";

/** Rebuilds the canvas's nodes from the Projects, runs and open windows, keeping each node that didn't change. */
export function useCanvasGraph({
  visible,
  focusLink,
  states,
  runs,
  linkedWork,
  filter,
  now,
  onOpenChat,
  onNewChat,
  windows,
  windowsOn,
  dragged,
  setNodes,
  setShown,
}: {
  visible: CanvasSnapshot | null;
  focusLink: NamedProjectLink | undefined;
  states: Record<string, CoordinatorState>;
  runs: RunStatuses;
  linkedWork: LinkedWork;
  filter: CanvasFilter;
  now: number;
  onOpenChat: (path: string, id: number) => void;
  onNewChat: ((path: string) => void) | undefined;
  windows: ReturnType<typeof useChatWindows>;
  windowsOn: boolean;
  dragged: RefObject<Map<string, { x: number; y: number }>>;
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>;
  setShown: Dispatch<SetStateAction<CanvasWorktree[]>>;
}) {
  const imageOf = useProjectImages(useMemo(() => visible?.projects.map((project) => project.path) ?? [], [visible]));
  const imageKey = visible?.projects.map((project) => imageOf(project.path) ?? "").join("\n");
  const keep = useMemo(() => {
    const ids = new Set<string>();
    for (const link of visible?.links ?? []) for (const end of [link.a, link.b]) if (!end.worktree_path) ids.add(end.project_id);
    for (const group of focusLink ? [focusLink] : (visible?.projectGroups ?? [])) for (const id of group.projectIds) ids.add(id);
    return ids;
  }, [visible, focusLink]);
  const { liveRuns, open, openWindow, resizeWindow, records, prune } = windows;
  useEffect(() => {
    if (!visible) return;
    const built = buildNodes(
      visible,
      states,
      runs,
      liveRuns,
      linkedWork,
      filter,
      now,
      imageOf,
      keep,
      { onOpenChat, onNewChat, onOpenWindow: windowsOn ? openWindow : undefined, onResize: resizeWindow },
      open,
      dragged.current,
      records,
    );
    setShown(built.worktrees);
    setNodes((previous) => {
      const before = new Map(previous.map((node) => [node.id, node]));
      return fitSections(
        built.nodes.map((node) => {
          const old = before.get(node.id);
          if (old?.dragging || old?.resizing)
            return { ...node, position: old.position, width: old.width, height: old.height, dragging: old.dragging, resizing: old.resizing } as CanvasNode;
          return old && nodeLook(old) === nodeLook(node) ? old : node;
        }),
      );
    });
    prune(built);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- imageOf changes identity every render; imageKey says when an image arrived
  }, [
    visible,
    states,
    runs,
    liveRuns,
    linkedWork,
    filter,
    now,
    imageKey,
    keep,
    onOpenChat,
    onNewChat,
    windowsOn,
    open,
    openWindow,
    resizeWindow,
    records,
    prune,
  ]);
}
