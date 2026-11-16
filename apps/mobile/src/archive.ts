import { readWithTimeout } from "@milagre/shared/read-timeout";
import type { AgentSession, CoordinatorState } from "@milagre/shared/model";
import type { TerminalList } from "@milagre/shared/terminal";
import { undoHistory, type UndoAction } from "@milagre/shared/undo-history";
import {
  archiveChat,
  archiveChoices,
  DELETE_UNDO_MS,
  deleteUndoWindow,
  isMilagreWorktree,
  undoDelete,
  worktreeShared,
  type ArchivePlan,
  type WorktreeStatus,
} from "@milagre/shared/archive";

export type ArchiveClient = {
  call<T>(method: string, args?: unknown[]): Promise<T>;
  snapshot(projectPath: string): Promise<{ project: { state: CoordinatorState }; runs: { runs: Record<string, unknown> } }>;
};
const HIDE_ONLY: ArchivePlan = { milagreOwned: false, shared: false, status: null };
const OLD_DAEMON = /not available from mobile/i;
const fromOldDaemon = (error: unknown) => OLD_DAEMON.test((error as Error)?.message ?? "");

export async function checkArchive(client: ArchiveClient, state: CoordinatorState, sessionId: number, chatId?: string): Promise<ArchivePlan | null> {
  return readWithTimeout(async () => {
    const plan = await worktreePlan(client, state, sessionId);
    if (!plan || !chatId) return plan;
    const terminals = await busyTerminals(client, chatId);
    return terminals.length ? { ...plan, terminals } : plan;
  }, 5_000).catch(() => HIDE_ONLY);
}

async function busyTerminals(client: ArchiveClient, chatId: string): Promise<string[]> {
  try {
    const { terminals } = await client.call<TerminalList>("terminal:list", [{ chatId }]);
    return terminals.filter((terminal) => terminal.busy).map((terminal) => terminal.title);
  } catch {
    return [];
  }
}

async function worktreePlan(client: ArchiveClient, state: CoordinatorState, sessionId: number): Promise<ArchivePlan | null> {
  const worktree = state.worktrees[state.sessions[sessionId]?.worktree_id ?? -1];
  let roots: unknown;
  try {
    roots = await client.call<string[]>("worktree:roots");
  } catch (error) {
    return fromOldDaemon(error) ? null : HIDE_ONLY;
  }
  if (!isMilagreWorktree(worktree, Array.isArray(roots) ? roots : [])) return HIDE_ONLY;
  if (worktreeShared(state, sessionId)) return { milagreOwned: true, shared: true, status: null };
  try {
    return { milagreOwned: true, shared: false, status: await client.call<WorktreeStatus>("worktree:status", [worktree.path, worktree.base]) };
  } catch (error) {
    return fromOldDaemon(error) ? null : HIDE_ONLY;
  }
}

export type ArchiveRequest = {
  client: ArchiveClient;
  projectPath: string;
  state: CoordinatorState;
  chat: AgentSession;
  running: boolean;
  chatsHome?: boolean;
  onConfirm?: () => void;
  notify: (message: string) => void;
  refresh: () => Promise<unknown>;
  undoMs?: number;
  hostId?: string;
};

export const deletionKey = (hostId: string | undefined, chatId: string) => (hostId ? `${hostId}|${chatId}` : chatId);

const archiving = new Set<string>();

export type ArchiveActivity = { chats: ReadonlySet<string>; notice: string; hidden: ReadonlySet<string>; deleted: string };
let activity: ArchiveActivity = { chats: new Set(), notice: "", hidden: new Set(), deleted: "" };
const listeners = new Set<() => void>();
function setActivity(next: Partial<ArchiveActivity>) {
  activity = { ...activity, ...next };
  for (const listener of listeners) listener();
}
export function archiveActivity() {
  return activity;
}
export function subscribeArchiveActivity(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function startArchiving(chatId: string) {
  setActivity({ chats: new Set(activity.chats).add(chatId), notice: "" });
  return () => {
    const chats = new Set(activity.chats);
    chats.delete(chatId);
    setActivity({ chats });
  };
}
export function showArchiveNotice(notice: string) {
  setActivity({ notice });
}
export function clearArchiveNotice() {
  if (activity.notice) setActivity({ notice: "" });
}
function openUndo(owner: string, ms?: number) {
  setActivity({ hidden: new Set(activity.hidden).add(owner), deleted: owner });
  const step: UndoAction = {
    text: "Chat deleted",
    kind: "deleted",
    undoneText: "Chat restored",
    place: "list",
    undo: () => undoDelete(owner),
    undoWindowMs: ms ?? DELETE_UNDO_MS,
  };
  undoHistory.record(step);
  const window = deleteUndoWindow(owner, ms);
  void window.then((undone) => undone || undoHistory.drop(step));
  void window.finally(() => {
    if (activity.deleted === owner) setActivity({ deleted: "" });
  });
  const show = () => {
    undoHistory.drop(step);
    undoDelete(owner);
    const hidden = new Set(activity.hidden);
    hidden.delete(owner);
    setActivity({ hidden, deleted: activity.deleted === owner ? "" : activity.deleted });
  };
  return { window, show };
}

export async function archiveFromPhone(request: ArchiveRequest): Promise<"busy" | "hidden" | "removed" | "kept" | "undone"> {
  const { client, projectPath, chat } = request;
  const chatId = `${projectPath}#${chat.id}`;
  const owner = deletionKey(request.hostId, chatId);
  if (archiving.has(owner)) return "busy";
  archiving.add(owner);
  const { window, show } = openUndo(owner, request.undoMs);
  let undone = false;
  const undo = window.then((value) => (undone = value));
  let done = () => {};
  try {
    done = startArchiving(chatId);
    request.onConfirm?.();
    const plan = await checkArchive(client, request.state, chat.id, chatId);
    const mode = archiveChoices({ plan: plan ?? HIDE_ONLY, running: request.running, chatsHome: request.chatsHome }).choices[0]!.mode;
    const now = await client.snapshot(projectPath).catch(() => null);
    const latest = now?.project.state ?? request.state;
    const running = now ? Boolean(now.runs.runs[chatId]) : request.running;
    if (undone) return "undone";
    try {
      const outcome = await archiveChat(
        {
          projectPath,
          chatId,
          getState: () => latest,
          currentProjectPath: () => projectPath,
          undoWindow: () => undo,
          stop: () => (running ? client.call("agent:interrupt", [chatId]).catch(() => {}) : undefined),
          hide: () => client.call("chat:patch", [projectPath, chat.id, { archived: true, unread: false }]),
          destroy: () => client.call("chat:delete", [projectPath, chat.id]),
          restore: () => client.call("chat:patch", [projectPath, chat.id, { archived: false }]),
          remove: (worktree, options) => removeOrFindGone(client, projectPath, worktree.path, options),
          applyRemoval: () => {},
          refreshBranches: () => {},
          notify: request.notify,
        },
        chat.id,
        mode,
        plan,
      );
      return outcome;
    } finally {
      await request.refresh().catch(() => {});
    }
  } finally {
    archiving.delete(owner);
    done();
    show();
  }
}

async function removeOrFindGone(client: ArchiveClient, projectPath: string, worktreePath: string, options: unknown) {
  try {
    return await client.call("worktree:remove", [worktreePath, options]);
  } catch (error) {
    const now = await client.snapshot(projectPath).catch(() => null);
    if (now && !Object.values(now.project.state.worktrees).some((worktree) => worktree.path === worktreePath)) return { removed: true };
    throw error;
  }
}
