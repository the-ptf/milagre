// Edits to a project's saved state that the renderer asks for and the main process applies, the
// only writer of each project's state (see project-states.cjs). Types: project-edits.d.mts.

/** The state with one session changed; a field patched to undefined, false or "" is removed. Unchanged state is returned as is. */
export function patchSession(state, sessionId, patch) {
  const session = state.sessions[sessionId];
  if (!session) return state;
  const next = { ...session };
  for (const [field, value] of Object.entries(patch)) {
    if (!SESSION_FIELDS.has(field)) continue;
    // The chat lists sort by it, so only a real number gets in.
    if ((field === "pin_order" || field === "done_at") && value !== undefined && value !== false && !Number.isFinite(value)) continue;
    if (value === undefined || value === false || value === "") delete next[field];
    else next[field] = value;
  }
  if (JSON.stringify(next) === JSON.stringify(session)) return state;
  return { ...state, sessions: { ...state.sessions, [sessionId]: next } };
}

/** The session fields a patch may change; the renderer is untrusted input. */
const SESSION_FIELDS = new Set(["title", "unread", "archived", "pinned", "pin_order", "done_at"]);

/** Permanently removes one conversation, while keeping its Worktree and every other Chat. */
export function deleteSession(state, sessionId) {
  if (!state.sessions[sessionId]) return state;
  const sessions = { ...state.sessions };
  delete sessions[sessionId];
  return { ...state, sessions, messages: state.messages.filter((message) => message.session_id !== sessionId) };
}

/** The state with fresh diff stats for some worktrees (by id); unchanged state is returned as is. */
export function withDiffStats(state, stats) {
  let worktrees = state.worktrees;
  for (const [id, stat] of Object.entries(stats)) {
    const worktree = worktrees[id];
    if (!worktree || !stat) continue;
    if (worktree.diff?.added === stat.added && worktree.diff?.removed === stat.removed) continue;
    if (worktrees === state.worktrees) worktrees = { ...state.worktrees };
    worktrees[id] = { ...worktree, diff: { added: stat.added, removed: stat.removed } };
  }
  return worktrees === state.worktrees ? state : { ...state, worktrees };
}

/** The state with the worktree at `path` renamed, along with its chats still named after the old branch. */
export function renameWorktree(state, { path, from, name }) {
  const worktree = Object.values(state.worktrees).find((item) => item.path === path && item.name === from);
  if (!worktree) return state;
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).map(([id, session]) => [
      id,
      session.worktree_id === worktree.id && session.agent_name === from ? { ...session, agent_name: name } : session,
    ]),
  );
  return { ...state, worktrees: { ...state.worktrees, [worktree.id]: { ...worktree, name } }, sessions };
}

/** Whether a subagent has ended, so "Archive finished" may hide it. */
export const subagentFinished = (agent) => ["completed", "failed", "cancelled"].includes(agent.status);

/** The state with one of a chat's subagents archived or brought back; archiving only hides it, the provider carries on. */
export function archiveSubagent(state, sessionId, id, archived) {
  const session = state.sessions[sessionId];
  if (!session?.subagents?.some((agent) => agent.id === id)) return state;
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: { ...session, subagents: session.subagents.map((agent) => (agent.id === id ? { ...agent, archived } : agent)) },
    },
  };
}

/** The state with a chat's finished subagents archived; unchanged state is returned as is. */
export function archiveFinishedSubagents(state, sessionId, { keepAdvisors = false } = {}) {
  const session = state.sessions[sessionId];
  if (!session?.subagents?.some((agent) => !agent.archived && subagentFinished(agent) && !(keepAdvisors && agent.source === "milagre-advisor"))) return state;
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...session,
        subagents: session.subagents.map((agent) =>
          !agent.archived && subagentFinished(agent) && !(keepAdvisors && agent.source === "milagre-advisor") ? { ...agent, archived: true } : agent,
        ),
      },
    },
  };
}
