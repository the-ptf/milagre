import { readWithTimeout } from "@milagre/shared/read-timeout";
import type { AgentSession, CoordinatorState } from "@milagre/shared/model";
import type { TerminalList } from "@milagre/shared/terminal";
import { archiveChat, archiveMode, archivedNotice, isMilagreWorktree, worktreeShared, type ArchivePlan, type WorktreeStatus } from "@milagre/shared/archive";

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
 * The removal plan for one Chat, as desktop works it out: whether Milagre made its worktree, whether
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
  /** Called when archiving begins, before anything changes (the Chat screen marks itself busy). */
  onConfirm?: () => void;
  notify: (message: string) => void;
  refresh: () => Promise<unknown>;
};

// Chats with an archive under way, from the tap to the end: another tap on one asks nothing and does nothing.
const archiving = new Set<string>();

/**
 * Chats whose archive is still running, by `projectPath#id`, and the last notice an archive left. An
 * archive outlives the screen it started on, so the Chat list reads both here: the Chat's row shows the progress
 * wherever it is listed, and the notice shows once the phone has moved on.
 */
/** `done`: a short confirmation that the archive went ("Chat archived" for a Chat without a Project), gone after a while. */
export type ArchiveActivity = { chats: ReadonlySet<string>; notice: string; done: string };
let activity: ArchiveActivity = { chats: new Set(), notice: "", done: "" };
let doneTimer: ReturnType<typeof setTimeout> | null = null;
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
/** Marks a Chat as archiving; the returned function marks it done. A new archive clears an old notice. */
export function startArchiving(chatId: string) {
  setActivity({ chats: new Set(activity.chats).add(chatId), notice: "", done: "" });
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
/** Says the archive went, as the Chat screen's toast does, for a few seconds. */
function showArchiveDone(done: string, ms = 3000) {
  if (doneTimer) clearTimeout(doneTimer);
  setActivity({ done });
  doneTimer = setTimeout(() => {
    doneTimer = null;
    setActivity({ done: "" });
  }, ms);
  // Node (the tests) needn't stay up for it; React Native's timers have no unref.
  (doneTimer as { unref?: () => void }).unref?.();
}

/**
 * Archive from the phone: check the worktree, then desktop's archive steps with the phone's means:
 * stop the turn if one runs now, hide the Chat, remove the worktree when the choice asks (the daemon closes the agent
 * and checks again), bring the Chat back with a notice when it stays, and read the Project again. A removed worktree's
 * Chats leave the Project's state on the Mac, so the refresh drops them here too.
 */
export async function archiveFromPhone(request: ArchiveRequest): Promise<"busy" | "hidden" | "removed" | "kept"> {
  const { client, projectPath, chat } = request;
  const chatId = `${projectPath}#${chat.id}`;
  if (archiving.has(chatId)) return "busy";
  archiving.add(chatId);
  let done = () => {};
  try {
    done = startArchiving(chatId);
    request.onConfirm?.();
    const plan = await checkArchive(client, request.state, chat.id, chatId);
    const mode = archiveMode(plan);
    // The Project as it is now: whether a turn runs in the Chat, read when the archive runs as desktop does, and
    // whether another Chat took up the worktree since the check.
    const now = await client.snapshot(projectPath).catch(() => null);
    const latest = now?.project.state ?? request.state;
    const running = now ? Boolean(now.runs.runs[chatId]) : request.running;
    try {
      const outcome = await archiveChat(
        {
          projectPath,
          chatId,
          getState: () => latest,
          currentProjectPath: () => projectPath,
          stop: () => (running ? client.call("agent:interrupt", [chatId]).catch(() => {}) : undefined),
          hide: () => client.call("chat:patch", [projectPath, chat.id, { archived: true, unread: false }]),
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
      // A Chat without a Project leaves no list behind it (its folder went too): the phone says it is gone.
      const archived = archivedNotice(outcome, { chatsHome: request.chatsHome });
      if (archived) showArchiveDone(archived);
      return outcome;
    } finally {
      await request.refresh().catch(() => {});
    }
  } finally {
    archiving.delete(chatId);
    done();
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
