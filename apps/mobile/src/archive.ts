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

/** What archiving needs from the connection to the Mac. */
export type ArchiveClient = {
  call<T>(method: string, args?: unknown[]): Promise<T>;
  snapshot(projectPath: string): Promise<{ project: { state: CoordinatorState }; runs: { runs: Record<string, unknown> } }>;
};
// A worktree that can't be checked only hides the Chat, as on desktop.
const HIDE_ONLY: ArchivePlan = { milagreOwned: false, shared: false, status: null };
// What the bridge answers for a method its daemon doesn't list: a Mac older than this check.
const OLD_DAEMON = /not available from mobile/i;
const fromOldDaemon = (error: unknown) => OLD_DAEMON.test((error as Error)?.message ?? "");

/**
 * The cleanup plan for one Chat, as desktop works it out: whether Milagre made its worktree, whether
 * another Chat uses it, what removing it would lose, and what its Terminals run that archiving would end. `null` when the
 * Mac's daemon has no such check yet, so the phone archives as it did before: hide only.
 */
export async function checkArchive(client: ArchiveClient, state: CoordinatorState, sessionId: number, chatId?: string): Promise<ArchivePlan | null> {
  return readWithTimeout(async () => {
    const plan = await worktreePlan(client, state, sessionId);
    if (!plan || !chatId) return plan;
    const terminals = await busyTerminals(client, chatId);
    return terminals.length ? { ...plan, terminals } : plan;
  }, 5_000).catch(() => HIDE_ONLY);
}

/** What the Chat's Terminals run, when it isn't the shell's prompt; none from a Mac without Terminals. */
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
  /** Whether a turn was running when Archive was tapped, checked again before archiving. */
  running: boolean;
  /** The Chat has no Project (its Project is a Chats home). */
  chatsHome?: boolean;
  /** Called as soon as deletion begins (the Chat screen leaves or marks itself busy). */
  onConfirm?: () => void;
  notify: (message: string) => void;
  refresh: () => Promise<unknown>;
  /** How long the toast's Undo can call the deletion off; DELETE_UNDO_MS unless a test says otherwise. */
  undoMs?: number;
  /** The Computer the Chat is on (its client URL): two Computers can hold the same `projectPath#id`. */
  hostId?: string;
};

/** A deletion's owner, as the list's rows and the toast's Undo name it: the Computer and the Chat. */
export const deletionKey = (hostId: string | undefined, chatId: string) => (hostId ? `${hostId}|${chatId}` : chatId);

// Chats with an archive under way, by deletionKey, from the tap to the end: another tap on one asks nothing and does nothing.
const archiving = new Set<string>();

/**
 * Chats whose deletion is still running, by `projectPath#id`, and the last notice an archive left. An
 * archive outlives the screen it started on, so the Chat list reads both here: the Chat's row shows the progress
 * wherever it is listed, and the notice shows once the phone has moved on.
 */
/**
 * `hidden`: Chats deleted from the phone, by deletionKey, out of the list until the deletion ends (back if it is undone
 * or fails). `deleted`: the last one still in its Undo time, whose "Chat deleted" toast offers the Undo.
 */
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
/** Marks a Chat as deleting; the returned function marks it done. A new archive clears an old notice. */
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
/**
 * Takes the Chat out of the list and opens its Undo: the toast shows until the time is up or Undo is tapped. The returned
 * function puts the Chat back in the list, once the deletion has ended.
 */
function openUndo(owner: string, ms?: number) {
  setActivity({ hidden: new Set(activity.hidden).add(owner), deleted: owner });
  // The list's toast offers the Undo through the undo history, wherever the deletion started (one from the Chat screen
  // shows on the list, since that screen has gone). No redo: Redo never deletes a Worktree.
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
  // Once the time is up there is nothing left to undo, and the toast goes; an Undo keeps its "Chat restored".
  void window.then((undone) => undone || undoHistory.drop(step));
  void window.finally(() => {
    if (activity.deleted === owner) setActivity({ deleted: "" });
  });
  const show = () => {
    // A deletion that failed before its time was up has nothing left to undo: its toast goes too.
    undoHistory.drop(step);
    undoDelete(owner);
    const hidden = new Set(activity.hidden);
    hidden.delete(owner);
    setActivity({ hidden, deleted: activity.deleted === owner ? "" : activity.deleted });
  };
  return { window, show };
}

/**
 * Delete from the phone immediately, using desktop's checked cleanup steps:
 * stop the turn if one runs now, hide the Chat, wait out the toast's Undo (an Undo brings the Chat back), remove the worktree when the choice asks (the daemon closes the agent
 * and checks again), bring the Chat back with a notice when it stays, and read the Project again. A removed worktree's
 * Chats leave the Project's state on the Mac, so the refresh drops them here too.
 */
export async function archiveFromPhone(request: ArchiveRequest): Promise<"busy" | "hidden" | "removed" | "kept" | "undone"> {
  const { client, projectPath, chat } = request;
  const chatId = `${projectPath}#${chat.id}`;
  const owner = deletionKey(request.hostId, chatId);
  if (archiving.has(owner)) return "busy";
  archiving.add(owner);
  // The Undo opens with the tap: the checks below can take seconds on a busy Mac.
  const { window, show } = openUndo(owner, request.undoMs);
  let undone = false;
  const undo = window.then((value) => (undone = value));
  let done = () => {};
  try {
    done = startArchiving(chatId);
    request.onConfirm?.();
    const plan = await checkArchive(client, request.state, chat.id, chatId);
    const mode = archiveChoices({ plan: plan ?? HIDE_ONLY, running: request.running, chatsHome: request.chatsHome }).choices[0]!.mode;
    // The Project as it is now: whether a turn runs in the Chat, read when the archive runs as desktop does, and
    // whether another Chat took up the worktree since the check.
    const now = await client.snapshot(projectPath).catch(() => null);
    const latest = now?.project.state ?? request.state;
    const running = now ? Boolean(now.runs.runs[chatId]) : request.running;
    // Undone before anything was touched: nothing to stop, hide or bring back.
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
          // The refresh below brings the Project as the Mac has it now, without the removed worktree and its Chats.
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

/**
 * Asks the Mac to remove the worktree. A failed answer may only mean the connection dropped (the relay, a locked phone,
 * the deadline) while the Mac went on removing it, so the Project is read again first: a worktree that is gone was
 * removed, and nothing says otherwise. One still there, or a Project that can't be read, keeps the error.
 */
async function removeOrFindGone(client: ArchiveClient, projectPath: string, worktreePath: string, options: unknown) {
  try {
    return await client.call("worktree:remove", [worktreePath, options]);
  } catch (error) {
    const now = await client.snapshot(projectPath).catch(() => null);
    if (now && !Object.values(now.project.state.worktrees).some((worktree) => worktree.path === worktreePath)) return { removed: true };
    throw error;
  }
}
