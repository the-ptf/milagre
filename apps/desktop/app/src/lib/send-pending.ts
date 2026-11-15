import { pendingChatSessionId, withPendingChat, type PendingChat } from "@milagre/shared/chats";
import type { CoordinatorState, ModelProvider } from "../model";

/**
 * A message on its way, shown as a preview until the host's state holds it. `sent`: the host saved it, and the preview
 * stays until the saved message reaches the window's state. `creatingWorktree`: the send waits for its new Worktree.
 * `provider`: the one the picker sent it to.
 */
export type PendingSend = PendingChat & {
  view: number;
  projectPath: string;
  originSessionId: number | null;
  originWorktreeId: number;
  sent?: boolean;
  creatingWorktree?: boolean;
  provider?: ModelProvider;
};

/** The Chat and Worktree a send set up, kept so a send that failed after setup retries there. */
export type PreparedSendTarget = { view: number; projectPath: string; sessionId: number | null; worktreeId: number };

/** A send that failed after the user left its Chat: its draft and error come back when the Chat opens again. */
export type FailedSend = PendingSend & { draft: string; error: string; target: PreparedSendTarget | null };

/** The Worktree id of a preview whose new Worktree doesn't exist yet. */
export const NO_WORKTREE = -1;

export type PendingSendAction =
  | { type: "add"; send: PendingSend }
  | { type: "target"; clientMessageId: string | undefined; sessionId: number | null; worktreeId: number }
  | { type: "sent"; clientMessageId: string | undefined; sessionId: number; worktreeId: number }
  | { type: "drop"; clientMessageId: string | undefined }
  | { type: "prune"; states: Record<string, CoordinatorState | undefined> };

/**
 * The pending sends after `action`. `prune` keeps a sent preview until its Project's state holds the saved message (a
 * large Project's state can reach the window after the send's reply) and drops it then, or once the window holds no
 * state for its Project. It returns the same list when nothing went.
 */
export function sendPendingReducer(list: PendingSend[], action: PendingSendAction): PendingSend[] {
  switch (action.type) {
    case "add":
      return [...list, action.send];
    case "target":
      return list.map((pending) =>
        pending.message.clientMessageId === action.clientMessageId
          ? { ...pending, creatingWorktree: false, targetSessionId: action.sessionId, session: { ...pending.session, worktree_id: action.worktreeId } }
          : pending,
      );
    case "sent":
      return list.map((pending) =>
        pending.message.clientMessageId === action.clientMessageId
          ? { ...pending, sent: true, originSessionId: action.sessionId, originWorktreeId: action.worktreeId }
          : pending,
      );
    case "drop":
      return list.filter((pending) => pending.message.clientMessageId !== action.clientMessageId);
    case "prune": {
      const next = list.filter((send) => {
        const latest = action.states[send.projectPath];
        return !send.sent || (latest && pendingChatSessionId(latest, send) === null);
      });
      return next.length === list.length ? list : next;
    }
  }
}

/** The send the open Chat shows: the latest one from this view, from the open Chat, or that became the open Chat. */
export function shownPendingSend(
  list: PendingSend[],
  { project, view, session, state }: { project: { path: string } | null; view: number; session: { id: number } | undefined; state: CoordinatorState | null },
): PendingSend | undefined {
  const projectPath = project?.path;
  const sessionId = session?.id;
  return list.findLast(
    (send) =>
      send.projectPath === projectPath &&
      (send.view === view || (sessionId !== undefined && (send.originSessionId === sessionId || (state && pendingChatSessionId(state, send) === sessionId)))),
  );
}

/** The open Project's state with its failed and pending sends' previews in it, as the sidebar lists them. */
export function withSendPreviews(state: CoordinatorState, projectPath: string | undefined, pending: PendingSend[], failed: FailedSend[]): CoordinatorState {
  const recovered = failed.filter((send) => send.projectPath === projectPath).reduce((current, send) => withPendingChat(current, send), state);
  return pending.filter((send) => send.projectPath === projectPath).reduce((current, send) => withPendingChat(current, send), recovered);
}
