// What happens to the Worktree a Routine's Run made once the Run ends: it goes when it leaves nothing behind, and the Run's
// Chat stays, archived, readable from the Run's history.

const hasMessages = (state, session) => (session.summary?.count ?? 0) > 0 || (state.messages ?? []).some((message) => message.session_id === session.id);

/**
 * Removes the Worktree `worktreeId` of the Project at `projectPath` that a Run made, when nothing in it is worth keeping:
 * no uncommitted changes, no commits on neither its base nor its upstream (worktree-cleanup.cjs `removable`), and no open
 * pull request from its branch. Repositories with a remote are checked even without a tracking upstream. A lookup that
 * fails keeps the Worktree.
 *
 * It is kept too when it isn't a Worktree Milagre made for the Run (no base, the Project folder, a Link's), when a Chat
 * there is running (`busy`), when the Run's Chat was kept by the user (its `routine.hidden` is false), or when another
 * Chat with messages that isn't archived uses it.
 *
 * Otherwise every Chat with messages there (the Run's, a retry's) is closed (`closeChat`), archived and moved to the
 * Project folder's Worktree with `formerWorktree` naming where it ran (`moveChats`), since a Chat leaves the Project with
 * its Worktree; then `remove(worktreePath)` removes the Worktree the way worktree_remove does. A removal that fails moves
 * the Chats back as they were. Resolves with `{ removed: true }` or `{ removed: false, reason }`; never throws.
 */
async function retireRunWorktree({
  projectPath,
  worktreeId,
  chatIds,
  state: readState,
  busy,
  status,
  hasRemote,
  openPullRequest,
  closeChat,
  moveChats,
  remove,
}) {
  const keep = (reason) => ({ removed: false, reason });
  try {
    const state = await readState(projectPath);
    const worktree = state?.worktrees?.[worktreeId];
    if (!worktree) return keep("the Worktree is gone");
    if (!worktree.base || worktree.path === projectPath || worktree.sharedChat) return keep("Milagre didn't make this Worktree for the Run");
    const home = Object.values(state.worktrees).find((item) => item.path === projectPath);
    if (!home) return keep("the Project folder isn't in the Project");
    const runChats = new Set(chatIds.map(String));
    const sessions = Object.values(state.sessions ?? {}).filter((session) => session.worktree_id === worktree.id);
    const keyOf = (session) => `${projectPath}#${session.id}`;
    for (const session of sessions) {
      if (busy(keyOf(session))) return keep("a Chat there is running");
      if (runChats.has(keyOf(session))) {
        if (session.routine?.hidden === false) return keep("the Run's Chat was kept");
      } else if (!session.archived && hasMessages(state, session)) {
        return keep("another Chat uses the Worktree");
      }
    }
    const checked = await status(worktree);
    if (!checked?.removable) return keep(checked?.uncommitted ? "it has uncommitted changes" : "it has commits on neither its base nor its upstream");
    if (await hasRemote(worktree)) {
      const pr = await openPullRequest(worktree);
      if (!pr.known) return keep("its pull requests couldn't be checked");
      if (pr.open) return keep("its branch has an open pull request");
    }
    const moved = sessions.filter((session) => hasMessages(state, session));
    for (const session of moved) await closeChat(keyOf(session));
    const formerWorktree = { path: worktree.path, name: worktree.name, ...(checked.branch ? { branch: checked.branch } : {}) };
    // An empty Chat there (one a Worktree keeps for its next send) goes with the Worktree; archived, it no longer holds it.
    const empty = sessions.filter((session) => !session.archived && !hasMessages(state, session)).map((session) => session.id);
    const before = await moveChats(
      projectPath,
      moved.map((session) => session.id),
      { worktreeId: home.id, formerWorktree, archive: empty },
    );
    try {
      await remove(worktree);
    } catch (error) {
      await moveChats(projectPath, Object.keys(before).map(Number), { restore: before }).catch(() => {});
      return keep(error?.message ?? String(error));
    }
    return { removed: true };
  } catch (error) {
    return keep(error?.message ?? String(error));
  }
}

module.exports = { retireRunWorktree };
