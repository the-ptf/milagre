import { useMemo, useRef, type RefObject } from "react";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { keepsOnPin } from "@milagre/shared/chat-pins";
import { LINK_PR_HINT } from "@milagre/shared/linear";
import type { SessionPatch } from "@milagre/shared/project-edits";
import type { ChatRowActions } from "../components/sidebar/ChatRow";
import { chatKey } from "../lib/agent-runs";
import { isMilagreWorktree, undoDelete, worktreeShared, type ArchiveMode, type ArchivePlan } from "../lib/archive";
import { reportChatAction } from "../lib/chat-action";
import { pinChat } from "../lib/chat-pins";
import { bridgeForKey, isRemoteKey } from "../lib/computer-bridge";
import { patchChatShowingDone } from "../lib/done-pending";
import { openInEditor } from "../lib/editors";
import { showNotice } from "../lib/notice";
import { chatRevealPath } from "../lib/reveal";
import { cachedProjectCopy, cachedScopeState } from "../lib/sidebar-scopes";
import { snoozeChat } from "../lib/snooze-pending";
import { busyTerminals } from "../lib/terminal-actions";
import type { CoordinatorState, LinkState } from "../model";

type Path = string | undefined;

type ChatRowHandlers = {
  openGitDialog: (sessionId: number, path: Path) => Promise<void>;
  archiveChat: (sessionId: number, mode: ArchiveMode, plan: ArchivePlan | null, projectPath: Path) => Promise<void>;
  markChatDone: (sessionId: number, path: Path) => void;
  reportMilagreBug: (sessionId: number) => void;
};

export type ChatRowContext = {
  projectRef: RefObject<{ path: string } | null>;
  /** The open Project as of this render: its path is the archive steps' default, as before paths were explicit. */
  project: { path: string } | null;
  state: CoordinatorState | null;
  statesRef: RefObject<Record<string, CoordinatorState>>;
  showGit: boolean;
  setNotice: (notice: string) => void;
  receiveState: (projectPath: string, next: CoordinatorState | LinkState) => void;
  refreshLinearIssues: () => void;
  handlers: ChatRowHandlers;
};

function rowActions(ctx: ChatRowContext) {
  const { setNotice } = ctx;
  function archiveState(projectPath: string) {
    const scoped = isLinkScopeKey(projectPath) ? undefined : (cachedScopeState(projectPath) as CoordinatorState | undefined);
    return ctx.statesRef.current[projectPath] ?? scoped ?? cachedProjectCopy(projectPath)?.state;
  }
  function patchChat(sessionId: number, patch: SessionPatch, path: Path) {
    if (path) void reportChatAction(patchChatShowingDone(path, sessionId, patch), "Could not update Chat", setNotice);
  }
  function snoozeChatHere(sessionId: number, until: number | null, path: Path) {
    if (path) void reportChatAction(snoozeChat(path, sessionId, until), until ? "Could not snooze Chat" : "Could not wake Chat", setNotice);
  }
  function pinChatHere(sessionId: number, order: number | null, path: Path) {
    if (!path) return;
    pinChat(path, Object.values(ctx.state?.sessions ?? {}), sessionId, order);
    if (order !== null && keepsOnPin(ctx.state?.sessions[sessionId]))
      void bridgeForKey(path)
        .patchChat(path, sessionId, { kept: true })
        .catch(() => {});
  }
  async function checkArchive(sessionId: number, projectPath: Path): Promise<ArchivePlan> {
    if (!projectPath) return { milagreOwned: false, shared: false, status: null };
    const bridge = bridgeForKey(projectPath);
    const latest = archiveState(projectPath);
    const worktree = latest ? latest.worktrees[latest.sessions[sessionId]?.worktree_id ?? -1] : undefined;
    const shared = latest ? worktreeShared(latest, sessionId) : false;
    const status = worktree?.base && !shared ? bridge.getWorktreeStatus(worktree.path, worktree.base) : Promise.resolve(null);
    status.catch(() => {});
    const [terminals, roots] = await Promise.all([busyTerminals(chatKey(projectPath, sessionId)), bridge.getWorktreeRoots()]);
    if (!latest || !isMilagreWorktree(worktree, roots)) return { milagreOwned: false, shared: false, status: null, terminals };
    if (shared) return { milagreOwned: true, shared: true, status: null, terminals };
    return { milagreOwned: true, shared: false, status: await status, terminals };
  }
  function revealChat(sessionId: number, path: Path) {
    if (!path || isRemoteKey(path)) return;
    void window.milagre.revealInFolder(chatRevealPath(archiveState(path) ?? null, sessionId, path)).catch(() => {});
  }
  function openChatInEditor(sessionId: number, path: Path) {
    const latest = path ? archiveState(path) : undefined;
    const worktree = latest?.worktrees[latest.sessions[sessionId]?.worktree_id ?? -1];
    if (worktree) void openInEditor(worktree.path);
  }
  async function linkChatIssue(sessionId: number, key: string, workspace: string | undefined, path: Path) {
    const worktreeId = path ? archiveState(path)?.sessions[sessionId]?.worktree_id : undefined;
    if (!path || worktreeId === undefined) return;
    const linked = async () => {
      const result = await bridgeForKey(path).linkWorktreeIssue({ projectPath: path, worktreeId, key, ...(workspace ? { workspace } : {}) });
      ctx.receiveState(path, result.project.state);
      ctx.refreshLinearIssues();
      showNotice(result.mode === "renamed" ? `Branch renamed to ${result.branch}.` : `Issue linked. ${LINK_PR_HINT(key)}`);
    };
    await reportChatAction(linked(), "Could not link issue", setNotice);
  }
  async function unlinkChatIssue(sessionId: number, path: Path) {
    const worktreeId = path ? archiveState(path)?.sessions[sessionId]?.worktree_id : undefined;
    if (!path || worktreeId === undefined) return;
    const unlinked = async () => {
      const result = await bridgeForKey(path).unlinkWorktreeIssue({ projectPath: path, worktreeId });
      ctx.receiveState(path, result.project.state);
      ctx.refreshLinearIssues();
    };
    await reportChatAction(unlinked(), "Could not unlink issue", setNotice);
  }
  async function reloadChat(sessionId: number, path: Path) {
    if (!path) return;
    const reloaded = async () => {
      await bridgeForKey(path).reloadChat(chatKey(path, sessionId));
      showNotice("Chat reloaded. Your next message starts a fresh agent.");
    };
    await reportChatAction(reloaded(), "Could not reload chat", setNotice);
  }
  async function detachChat(sessionId: number, path: Path) {
    if (!path) return;
    const detached = async () => showNotice(await bridgeForKey(path).detachChat(path, sessionId));
    await reportChatAction(detached(), "Could not detach chat", setNotice);
  }
  return {
    ...ctx.handlers,
    openPath: ctx.project?.path,
    archiveState,
    patchChat,
    snoozeChatHere,
    pinChatHere,
    checkArchive,
    revealChat,
    openChatInEditor,
    linkChatIssue,
    unlinkChatIssue,
    reloadChat,
    detachChat,
  };
}

type RowActions = ReturnType<typeof rowActions>;

function scopeRowActions(latest: RefObject<RowActions>, path: string, gitless: boolean): ChatRowActions {
  return {
    onRename: (id, title) => latest.current.patchChat(Number(id), { title }, path),
    onMarkUnread: (id, unread) => latest.current.patchChat(Number(id), { unread }, path),
    onReload: (id) => void latest.current.reloadChat(Number(id), path),
    onSnooze: (id, until) => latest.current.snoozeChatHere(Number(id), until, path),
    onWake: (id) => latest.current.snoozeChatHere(Number(id), null, path),
    onArchiveCheck: (id) => latest.current.checkArchive(Number(id), path),
    onArchive: (id, mode, plan) => latest.current.archiveChat(Number(id), mode, plan, path),
    onUndoArchive: (id) => undoDelete(chatKey(path, Number(id))),
    ...(isRemoteKey(path)
      ? { remote: true }
      : {
          onReveal: (id) => latest.current.revealChat(Number(id), path),
          onOpenInEditor: (id) => latest.current.openChatInEditor(Number(id), path),
        }),
    ...(gitless ? { gitless: true } : { onCommit: (id) => void latest.current.openGitDialog(Number(id), path) }),
    onLinkIssue: (id, key, workspace) => void latest.current.linkChatIssue(Number(id), key, workspace, path),
    onUnlinkIssue: (id) => void latest.current.unlinkChatIssue(Number(id), path),
    onDetach: (id) => void latest.current.detachChat(Number(id), path),
  };
}

function openRowActions(latest: RefObject<RowActions>, here: () => Path, remoteProject: boolean, showGit: boolean): ChatRowActions {
  return {
    onRename: (id, title) => latest.current.patchChat(Number(id), { title }, here()),
    onMarkUnread: (id, unread) => latest.current.patchChat(Number(id), { unread }, here()),
    onReload: (id) => void latest.current.reloadChat(Number(id), here()),
    onReportBug: (id) => latest.current.reportMilagreBug(Number(id)),
    onPin: (id, order) => latest.current.pinChatHere(Number(id), order ?? null, here()),
    onDone: (id) => latest.current.markChatDone(Number(id), here()),
    onReopen: (id) => latest.current.patchChat(Number(id), { done: false }, here()),
    onSnooze: (id, until) => latest.current.snoozeChatHere(Number(id), until, here()),
    onWake: (id) => latest.current.snoozeChatHere(Number(id), null, here()),
    ...(remoteProject
      ? { remote: true }
      : {
          onReveal: (id: string) => latest.current.revealChat(Number(id), here()),
          onOpenInEditor: (id: string) => latest.current.openChatInEditor(Number(id), here()),
        }),
    ...(showGit ? { onCommit: (id: string) => latest.current.openGitDialog(Number(id), here()) } : { gitless: true }),
    onArchiveCheck: (id) => latest.current.checkArchive(Number(id), latest.current.openPath),
    onArchive: (id, mode, plan) => latest.current.archiveChat(Number(id), mode, plan, latest.current.openPath),
    onUndoArchive: (id) => {
      const path = here();
      return !!path && undoDelete(chatKey(path, Number(id)));
    },
    onLinkIssue: (id, key, workspace) => void latest.current.linkChatIssue(Number(id), key, workspace, here()),
    onUnlinkIssue: (id) => void latest.current.unlinkChatIssue(Number(id), here()),
    onDetach: (id) => void latest.current.detachChat(Number(id), here()),
  };
}

/**
 * The sidebar rows' actions, every one told the Project it acts in. The open Project's rows act where the window is
 * when the action runs; another Project's rows (the all-Projects sidebar) act in theirs. Both lists keep one identity
 * across renders and run the latest closures, so the memo()'d sidebar doesn't re-render on a streamed batch. The host
 * applies each action to its latest state, so a turn that finished since the last render isn't lost.
 */
export function useChatRowActions(ctx: ChatRowContext) {
  const actions = rowActions(ctx);
  const latest = useRef(actions);
  latest.current = actions;
  const { projectRef, showGit } = ctx;
  const remoteProject = isRemoteKey(ctx.project?.path);
  const chatActions = useMemo(
    () => openRowActions(latest, () => projectRef.current?.path, remoteProject, showGit),
    [latest, projectRef, remoteProject, showGit],
  );
  const scopeChatActions = useMemo(() => (path: string, gitless: boolean) => scopeRowActions(latest, path, gitless), [latest]);
  return { ...actions, chatActions, scopeChatActions };
}
