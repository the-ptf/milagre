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
  type ArchiveDeps,
  type ArchivePlan,
  type WorktreeStatus,
} from "@milagre/shared/archive";

export type ArchiveClient = {
  call<T>(method: string, args?: unknown[]): Promise<T>;
  snapshot(projectPath: string): Promise<{ project: { state: CoordinatorState }; runs: { runs: Record<string, unknown> } }>;
};
const HIDE_ONLY: ArchivePlan = { milagreOwned: false, shared: false, status: null };
const OLD_DAEMON = /not available from mobile/i;
const TAB_KEPT = "another Chat in it could not be deleted";
const fromOldDaemon = (error: unknown) => OLD_DAEMON.test((error as Error)?.message ?? "");

export async function checkArchive(
  client: ArchiveClient,
  state: CoordinatorState,
  sessionId: number,
  chatId?: string,
  together: readonly number[] = [],
): Promise<ArchivePlan | null> {
  return readWithTimeout(async () => {
    const plan = await worktreePlan(client, state, sessionId, together);
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

async function worktreePlan(client: ArchiveClient, state: CoordinatorState, sessionId: number, together: readonly number[]): Promise<ArchivePlan | null> {
  const worktree = state.worktrees[state.sessions[sessionId]?.worktree_id ?? -1];
  let roots: unknown;
  try {
    roots = await client.call<string[]>("worktree:roots");
  } catch (error) {
    return fromOldDaemon(error) ? null : HIDE_ONLY;
  }
  if (!isMilagreWorktree(worktree, Array.isArray(roots) ? roots : [])) return HIDE_ONLY;
  if (worktreeShared(state, sessionId, together)) return { milagreOwned: true, shared: true, status: null };
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
  /** The Chats deleted with this one (a Worktree row's tab Chats): each is only hidden, and none keeps the Worktree. */
  together?: AgentSession[];
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
function openUndo(owners: string[], ms?: number) {
  const owner = owners[0]!;
  const many = owners.length > 1;
  setActivity({ hidden: new Set([...activity.hidden, ...owners]), deleted: owner });
  const step: UndoAction = {
    text: many ? "Chats deleted" : "Chat deleted",
    kind: "deleted",
    undoneText: many ? "Chats restored" : "Chat restored",
    place: "list",
    undo: () => owners.map((each) => undoDelete(each)).some(Boolean),
    undoWindowMs: ms ?? DELETE_UNDO_MS,
  };
  undoHistory.record(step);
  const windows = owners.map((each) => deleteUndoWindow(each, ms));
  void windows[0]!.then((undone) => undone || undoHistory.drop(step));
  void windows[0]!.finally(() => {
    if (activity.deleted === owner) setActivity({ deleted: "" });
  });
  const show = () => {
    undoHistory.drop(step);
    const hidden = new Set(activity.hidden);
    for (const each of owners) {
      undoDelete(each);
      hidden.delete(each);
    }
    setActivity({ hidden, deleted: activity.deleted === owner ? "" : activity.deleted });
  };
  return { windows, show };
}

/**
 * Deletes a Chat from the phone, with an Undo. A Worktree row's tab Chats (`together`) go with it under the same Undo:
 * each is hidden, and the Worktree is removed only after all of them are gone.
 */
export async function archiveFromPhone(request: ArchiveRequest): Promise<"busy" | "hidden" | "removed" | "kept" | "undone"> {
  const { client, projectPath, chat } = request;
  const tabs = request.together ?? [];
  const keyOf = (id: number) => `${projectPath}#${id}`;
  const chatId = keyOf(chat.id);
  const owners = [chat, ...tabs].map((each) => deletionKey(request.hostId, keyOf(each.id)));
  if (owners.some((owner) => archiving.has(owner))) return "busy";
  for (const owner of owners) archiving.add(owner);
  const { windows, show } = openUndo(owners, request.undoMs);
  let undone = false;
  const undo = windows[0]!.then((value) => (undone = value));
  const done = [chat, ...tabs].map((each) => startArchiving(keyOf(each.id)));
  try {
    request.onConfirm?.();
    const together = tabs.map((tab) => tab.id);
    const plan = await checkArchive(client, request.state, chat.id, chatId, together);
    const mode = archiveChoices({ plan: plan ?? HIDE_ONLY, running: request.running, chatsHome: request.chatsHome }).choices[0]!.mode;
    const now = await client.snapshot(projectPath).catch(() => null);
    const latest = now?.project.state ?? request.state;
    const running = (id: number) => (now ? Boolean(now.runs.runs[keyOf(id)]) : id !== chat.id || request.running);
    if (undone) return "undone";
    const deps = (each: AgentSession, window: Promise<boolean>): ArchiveDeps => ({
      projectPath,
      chatId: keyOf(each.id),
      getState: () => latest,
      currentProjectPath: () => projectPath,
      undoWindow: () => window,
      stop: () => (running(each.id) ? client.call("agent:interrupt", [keyOf(each.id)]).catch(() => {}) : undefined),
      hide: () => client.call("chat:patch", [projectPath, each.id, { archived: true, unread: false }]),
      destroy: () => client.call("chat:delete", [projectPath, each.id]),
      restore: () => client.call("chat:patch", [projectPath, each.id, { archived: false }]),
      remove: (worktree, options) => removeOrFindGone(client, projectPath, worktree.path, options),
      applyRemoval: () => {},
      refreshBranches: () => {},
      notify: request.notify,
    });
    const gone = Promise.allSettled(tabs.map((tab, index) => archiveChat(deps(tab, windows[index + 1]!), tab.id, "hide", HIDE_ONLY)));
    try {
      return await archiveChat(
        {
          ...deps(chat, undo),
          together,
          remove: async (worktree, options) => {
            if ((await gone).some((tab) => tab.status === "rejected" || tab.value !== "hidden")) throw new Error(TAB_KEPT);
            return removeOrFindGone(client, projectPath, worktree.path, options);
          },
        },
        chat.id,
        mode,
        plan,
      );
    } finally {
      await gone;
      await request.refresh().catch(() => {});
    }
  } finally {
    for (const owner of owners) archiving.delete(owner);
    for (const finish of done) finish();
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
