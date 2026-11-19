import { useEvent } from "../../lib/stable";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useCheckpoints } from "@milagre/shared/use-checkpoints";
import { undoableTasks, type Checkpoint, type CheckpointApi } from "@milagre/shared/checkpoints";
import { type UndoIntent } from "../checkpoints/UndoPanel";
import { bridgeForKey } from "../../lib/computer-bridge";
import { useChatsGroup, useProjectGroups } from "../../lib/project-copies";
import { isModalOpen } from "../../lib/modal";
import type { ChatComposerProps } from "./chat-composer-props";
import { useSendLaunch } from "./use-send-launch";

const NO_CHECKPOINTS: CheckpointApi = {
  list: async () => [],
  preview: () => Promise.reject(new Error("Open a saved Chat to undo its changes")),
  restore: () => Promise.reject(new Error("Open a saved Chat to undo its changes")),
};
const lastCheckpoints = new Map<string, Checkpoint[]>();
const KEPT_CHECKPOINT_LISTS = 32;
function keptCheckpoints(api: CheckpointApi): CheckpointApi {
  return {
    list: (request) =>
      api.list(request).then((items) => {
        lastCheckpoints.delete(request.chatId);
        lastCheckpoints.set(request.chatId, items);
        for (const oldest of lastCheckpoints.keys()) {
          if (lastCheckpoints.size <= KEPT_CHECKPOINT_LISTS) break;
          lastCheckpoints.delete(oldest);
        }
        return items;
      }),
    preview: (request) => api.preview(request),
    restore: (request) => api.restore(request),
  };
}

export function useComposerLayout(isNewChat: boolean, root: RefObject<HTMLDivElement | null>) {
  // The band's grain tile is aligned by offset, not with a fixed background: Chromium would composite the band and
  // everything over it.
  const topBandRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const band = topBandRef.current;
    const parent = band?.parentElement;
    if (isNewChat || !band || !parent) return;
    const update = () => {
      const { left, top } = band.getBoundingClientRect();
      band.style.setProperty("--chat-top-x", `${left}px`);
      band.style.setProperty("--chat-top-y", `${top}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [isNewChat]);
  const dockRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const host = root.current;
    if (isNewChat || !dock || !host) return;
    const update = () => host.style.setProperty("--composer-dock", `${Math.ceil(dock.getBoundingClientRect().height)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(dock);
    return () => {
      observer.disconnect();
      host.style.removeProperty("--composer-dock");
    };
  }, [isNewChat]);
  return { topBandRef, dockRef, captureLaunch: useSendLaunch(root, isNewChat) };
}

type NewChatSetupProps = Pick<ChatComposerProps, "scopeKind" | "offlineName" | "linearActive" | "onStartFromIssue" | "newChatProject" | "projectPath"> & {
  isNewChat: boolean;
};

export function useNewChatSetup({ isNewChat, scopeKind, offlineName, linearActive, onStartFromIssue, newChatProject, projectPath }: NewChatSetupProps) {
  const [headingOpen, setHeadingOpen] = useState(false);
  const projectNewChat = isNewChat && (scopeKind ?? "project") === "project" && !offlineName;
  const linkNewChat = isNewChat && scopeKind === "link" && !offlineName && linearActive && !!onStartFromIssue;
  const newChatProjectKey = newChatProject?.key ?? projectPath;
  const newChatProjectName = newChatProject?.name ?? projectPath.split("/").findLast(Boolean) ?? projectPath;
  const projectGroups = useProjectGroups(projectNewChat && !!newChatProject?.onChange, newChatProjectKey, newChatProjectName, newChatProject?.kind);
  const chatsDraft = newChatProject?.kind === "chats";
  const noProjectGroup = useChatsGroup(projectNewChat && !!newChatProject?.onChange);
  const projectCopies = chatsDraft
    ? (noProjectGroup?.copies ?? [])
    : (projectGroups.find((group) => group.copies.some((copy) => copy.key === newChatProjectKey))?.copies ?? []);
  const newChatChange = newChatProject?.onChange;
  const changeComputer = useMemo(
    () =>
      newChatChange && chatsDraft
        ? (key: string) => newChatChange(key, { exists: noProjectGroup?.copies.find((copy) => copy.key === key)?.exists ?? false })
        : newChatChange,
    [newChatChange, chatsDraft, noProjectGroup],
  );
  return {
    headingOpen,
    setHeadingOpen,
    projectNewChat,
    linkNewChat,
    newChatProjectKey,
    newChatProjectName,
    projectGroups,
    chatsDraft,
    noProjectGroup,
    projectCopies,
    newChatChange,
    changeComputer,
  };
}

type UndoFlowProps = Pick<ChatComposerProps, "isSending" | "offlineName" | "store"> & {
  runtimeChat: string | null;
  readOnlyHistory: boolean;
  root: RefObject<HTMLDivElement | null>;
};

export function useUndoFlow({ runtimeChat, isSending, readOnlyHistory, offlineName, store, root }: UndoFlowProps) {
  const checkpointApi = useMemo<CheckpointApi>(
    () => (runtimeChat ? keptCheckpoints(bridgeForKey(runtimeChat).checkpoints ?? NO_CHECKPOINTS) : NO_CHECKPOINTS),
    [runtimeChat],
  );
  const review = useCheckpoints(checkpointApi, runtimeChat ?? "");
  const checkpointItems = review.items.length || !runtimeChat ? review.items : (lastCheckpoints.get(runtimeChat) ?? review.items);
  const [undoIntent, setUndoIntent] = useState<UndoIntent>("Undo");
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const reloadCheckpoints = review.reload;
  useEffect(() => {
    if (runtimeChat && !isSending) void reloadCheckpoints();
  }, [runtimeChat, isSending, reloadCheckpoints]);
  const undoable = useMemo(
    () =>
      new Map(
        undoableTasks(checkpointItems)
          .filter((task) => task.messageId !== undefined)
          .map((task, index) => [task.messageId!, { id: task.id, latest: index === 0 }]),
      ),
    [checkpointItems],
  );
  const openUndo = useEvent(() => {
    if (readOnlyHistory) return;
    setUndoIntent("Undo");
    void review.open();
  });
  const undoTask = useEvent((id: string) => {
    if (readOnlyHistory) return;
    setUndoIntent("Undo");
    void review.inspect(id);
  });
  const previewRecovery = useEvent((id: string, action: UndoIntent) => {
    if (readOnlyHistory) return;
    setUndoIntent(action);
    void review.inspect(id);
  });
  useEffect(() => {
    if (highlightId !== null) root.current?.querySelector(`#message-${highlightId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlightId]);
  const lastEscape = useRef(0);
  const onEscape = useEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (review.view !== "closed" && target?.closest("[data-promptbar]")) {
      event.preventDefault();
      review.close();
      return;
    }
    const typing =
      !!target?.closest("input, select, [contenteditable='true']:not([data-prompt-editor]), .xterm") ||
      (target?.tagName === "TEXTAREA" && !target.closest("[data-promptbar]"));
    const hidden = !root.current?.offsetParent;
    if (
      isSending ||
      review.view !== "closed" ||
      store.text().trim() ||
      store.quotes().length ||
      typing ||
      hidden ||
      isModalOpen() ||
      document.documentElement.hasAttribute("data-popover-open")
    ) {
      lastEscape.current = 0;
      return;
    }
    if (lastEscape.current && event.timeStamp - lastEscape.current < 450) {
      lastEscape.current = 0;
      event.preventDefault();
      openUndo();
    } else lastEscape.current = event.timeStamp;
  });
  useEffect(() => {
    if (!runtimeChat || offlineName) return;
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [runtimeChat, offlineName, onEscape]);
  return { review, undoIntent, setUndoIntent, highlightId, setHighlightId, undoable, openUndo, undoTask, previewRecovery };
}
