const { isDeepStrictEqual } = require("node:util");
const path = require("node:path");
const fs = require("node:fs");
// Coordination state persisted in <project>/.milagre/coordination.json, reconciled with the
// worktrees git reports each time a project is read.

function emptyState(projectName) {
  return {
    next_id: 1,
    projects: { 1: { id: 1, name: projectName } },
    worktrees: {},
    sessions: {},
    messages: [],
    tasks: {},
  };
}

/** The state matched with the worktrees git lists now; a state that already matches is returned as is. */
function reconcileState(rawState, projectName, discoveredWorktrees, options = {}) {
  const ownedWorktrees = options instanceof Map ? options : (options.ownedWorktrees ?? new Map());
  const { platform = process.platform, realpathSync = fs.realpathSync.native } = options;
  const state = rawState ?? emptyState(projectName);
  const existingWorktrees = Object.values(state.worktrees ?? {});
  const existingSessions = Object.values(state.sessions ?? {});
  let nextId = Math.max(state.next_id ?? 1, ...[...existingWorktrees.map((item) => item.id), ...existingSessions.map((item) => item.id)]) || 1;
  const allocateId = () => nextId++;
  // Resolve older Windows spellings using filesystem identity. Case-sensitive
  // directories stay distinct; a removed worktree still has its lexical path.
  const paths = new Map();
  const nativePath = (folder) => {
    if (platform !== "win32" || typeof folder !== "string") return folder;
    if (!paths.has(folder)) {
      let canonical = folder;
      try {
        canonical = realpathSync(folder);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      }
      paths.set(folder, path.win32.normalize(canonical));
    }
    return paths.get(folder);
  };
  const existingByPath = new Map(existingWorktrees.map((worktree) => [nativePath(worktree.path), worktree]));
  const worktrees = {};
  const sessions = {};

  for (const discovered of discoveredWorktrees) {
    const folder = nativePath(discovered.path);
    const previous = existingByPath.get(folder);
    const worktree = previous ?? { id: allocateId(), project_id: 1, path: folder, name: discovered.name };
    worktrees[worktree.id] = { ...worktree, project_id: 1, path: folder, name: discovered.name };
    const sharedChat = ownedWorktrees.get(discovered.path) ?? ownedWorktrees.get(folder);
    if (sharedChat) {
      worktrees[worktree.id].sharedChat = sharedChat;
      continue;
    }
    // A worktree can hold several chats; keep them all and make sure it has at least one.
    const worktreeSessions = existingSessions.filter((session) => session.worktree_id === worktree.id);
    if (worktreeSessions.length === 0) worktreeSessions.push({ id: allocateId(), worktree_id: worktree.id, agent_name: discovered.name, status: "Created" });
    for (const session of worktreeSessions) {
      sessions[session.id] = { ...session, worktree_id: worktree.id, agent_name: session.agent_name || discovered.name };
    }
  }

  const validWorktreeIds = new Set(Object.values(worktrees).map((worktree) => worktree.id));
  const validSessionIds = new Set(Object.values(sessions).map((session) => session.id));
  const events = (state.events ?? []).filter((event) => validWorktreeIds.has(event.worktree_id));
  const tasks = Object.fromEntries(Object.entries(state.tasks ?? {}).filter(([, task]) => validWorktreeIds.has(task.worktree_id)));
  const artifacts = Object.fromEntries(Object.entries(state.artifacts ?? {}).filter(([, artifact]) => validWorktreeIds.has(artifact.worktree_id)));

  const next = {
    ...state,
    next_id: nextId,
    projects: { 1: { id: 1, name: projectName } },
    worktrees,
    sessions,
    ...(state.connections
      ? {
          connections: Object.fromEntries(
            Object.entries(state.connections ?? {}).filter(
              ([, connection]) => validWorktreeIds.has(connection.left_worktree_id) && validWorktreeIds.has(connection.right_worktree_id),
            ),
          ),
        }
      : {}),
    ...(state.events ? { events } : {}),
    messages: (state.messages ?? []).filter((message) => validSessionIds.has(message.session_id)),
    tasks,
    ...(state.artifacts ? { artifacts } : {}),
  };
  return rawState && isDeepStrictEqual(next, rawState) ? rawState : next;
}

// A saved running flag is not proof of a live provider after an app restart, and a background task lives only as long as
// its agent process (chat-activity.mjs). A state with nothing to mark is returned as is.
function markDisconnectedSubagents(state, liveSessionIds) {
  const running = (agent) => agent.source !== "milagre-advisor" && ["running", "initializing", "waiting"].includes(agent.status);
  const stale = Object.entries(state.sessions).filter(
    ([id, session]) => !liveSessionIds.has(Number(id)) && (session.subagents?.some(running) || session.backgroundTasks?.length),
  );
  if (!stale.length) return state;
  const sessions = { ...state.sessions };
  for (const [id, { backgroundTasks: _gone, ...session }] of stale) {
    sessions[id] = {
      ...session,
      ...(session.subagents
        ? {
            subagents: session.subagents.map((agent) =>
              running(agent)
                ? { ...agent, status: "unknown", endedAt: agent.updatedAt, latestActivity: "Session disconnected. Last received activity is shown below." }
                : agent,
            ),
          }
        : {}),
    };
  }
  return { ...state, sessions };
}

module.exports = { emptyState, reconcileState, markDisconnectedSubagents };
