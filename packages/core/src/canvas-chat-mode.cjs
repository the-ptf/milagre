const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { scopeKey } = require("@milagre/shared/chat-scopes");
const { processWork } = require("@milagre/shared/chat-activity");

const HISTORY = "This Chat is read-only. Choose a current Chat from the canvas.";
const SEPARATED = "This shared Chat is read-only. Continue in a new Chat in either Worktree.";

/**
 * Transfer editing ownership, never transcripts or Git data. A durable pending adoption claims both roots before
 * Project reconciliation; retrying the same mode finishes an interrupted transfer. Release is also idempotent.
 * The synchronous guard is called inside ChatHost's serialized send, closing the race with a concurrent client.
 */
function createCanvasChatModes({ registry, store, states, readProject, ownProject, chats, agents, broadcast, changed, git }) {
  let queue = Promise.resolve();
  const changing = new Set();
  function assertWritable(scope, state, session, worktree) {
    if (session?.readOnlyReason) throw new Error(session.readOnlyReason);
    if (state.adoptionPending || state.releasedAt) throw new Error("This Link is changing Chat mode or has returned to separate Chats.");
    if (!worktree?.path) return;
    if (changing.has(worktree.path)) throw new Error("This Worktree is changing Chat mode. Try again when it finishes.");
    for (const id of store.ids()) {
      const saved = store.cached(id);
      if (!saved || saved.deletedAt || saved.releasedAt || scope === scopeKey({ kind: "link", linkId: id })) continue;
      if (Object.values(saved.preparations).some((prep) => prep.members.some((member) => member.worktreePath === worktree.path)))
        throw new Error("This Worktree belongs to a shared Chat. Open it from the canvas.");
    }
  }
  function idle(scope, sessions) {
    const busy = chats.busyChats();
    for (const session of sessions) {
      const key = `${scope}#${session.id}`;
      if (busy.has(key) || agents.backgroundWork(key) || processWork(session).length || session.queued?.length || session.resumeTurn || session.limitResume)
        throw new Error(`${session.title || session.agent_name || "A Chat"} has work pending. Finish or stop it before changing Chat mode.`);
    }
  }
  async function groupFor(linkId) {
    for (const group of await registry.listProjectGroups()) {
      if (group.canvasLinkId !== linkId) continue;
      const saved = await store.get(group.id);
      if (!saved.releasedAt && !saved.deletedAt) return group;
    }
    return null;
  }
  async function separate(link, group) {
    if (!group) {
      await registry.setLinkChat(link.id, null);
      return;
    }
    const scope = scopeKey({ kind: "link", linkId: group.id });
    let saved = await store.get(group.id);
    idle(scope, Object.values(saved.sessions));
    await store.update(
      group.id,
      (state) => {
        idle(scope, Object.values(state.sessions));
        return { ...state, adoptionPending: true, separating: true };
      },
      { chats: [] },
    );
    await store.flush(group.id);
    for (const session of Object.values(saved.sessions)) await agents.closeChat(`${scope}#${session.id}`);
    await store.update(
      group.id,
      (state) => ({
        ...state,
        adoptionPending: false,
        releasedAt: new Date().toISOString(),
        sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, session]) => [id, { ...session, readOnlyReason: SEPARATED }])),
      }),
      { chats: [] },
    );
    await store.flush(group.id);
    saved = await store.get(group.id);
    broadcast(scope, saved);
    await registry.setLinkChat(link.id, null);
    for (const projectPath of new Set(Object.values(saved.sessions).flatMap((session) => session.worktrees.map((member) => member.projectPath))))
      await readProject(projectPath);
  }
  async function share(link, group, projects) {
    if (group && (await store.get(group.id)).separating) throw new Error("Finish switching to separate Chats before sharing again.");
    if (group && !(await store.get(group.id)).adoptionPending && (await store.get(group.id)).sessions[1]) {
      await registry.setLinkChat(link.id, { linkId: group.id, sessionId: 1 });
      return;
    }
    const owned = await store.ownedWorktrees();
    const members = [];
    for (const [index, end] of [link.a, link.b].entries()) {
      const project = projects.find((item) => item.id === end.project_id);
      if (!project) throw new Error("A linked Project is unavailable.");
      await ownProject(project.path);
      const real = await fs.realpath(end.worktree_path);
      if (real !== end.worktree_path) throw new Error("The linked Worktree path changed.");
      // Main checkouts are deliberately outside the shared agent's owned set.
      if (real === project.path) throw new Error("Create an isolated Worktree first. Main checkouts cannot be adopted by a shared Chat.");
      const owner = owned.get(real);
      if (owner && owner.linkId !== group?.id) throw new Error("A selected Worktree already belongs to another shared Chat.");
      const discovered = (await git.worktreeList(project.path)).find((item) => item.path === real);
      if (!discovered) throw new Error("A linked Worktree is no longer active.");
      // readProject normally resumes interrupted turns. Refuse them before that side effect during a transfer.
      const before = await states.get(project.path);
      const previous = Object.values(before.worktrees).find((item) => item.path === real);
      if (previous)
        idle(
          project.path,
          Object.values(before.sessions).filter((session) => session.worktree_id === previous.id),
        );
      const { state } = await readProject(project.path);
      const worktree = Object.values(state.worktrees).find((item) => item.path === real);
      if (!worktree) throw new Error("A linked Worktree is unavailable.");
      const sessions = Object.values(state.sessions).filter((session) => session.worktree_id === worktree.id);
      idle(project.path, sessions);
      members.push({
        projectId: project.id,
        projectPath: project.path,
        projectName: project.name,
        worktreePath: real,
        branch: discovered.name,
        base: worktree.base || "HEAD",
        alias: `worktree-${index + 1}`,
        adopted: true,
        setupDone: true,
      });
    }
    group ??= await registry.createWorktreeGroup(link.id);
    const scope = scopeKey({ kind: "link", linkId: group.id });
    const workspacePath = path.join(store.directory(group.id), "workspaces", "1");
    await fs.mkdir(workspacePath, { recursive: true });
    for (const member of members) {
      const alias = path.join(workspacePath, member.alias);
      try {
        await fs.symlink(member.worktreePath, alias, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (error.code !== "EEXIST" || (await fs.realpath(alias)) !== member.worktreePath) throw error;
      }
    }
    // Write the ownership journal before touching any Project's Chat records. No setup, branch creation or cleanup.
    await store.update(
      group.id,
      (state) => ({
        ...state,
        next_id: 2,
        adoptionPending: true,
        preparations: { adoption: { operationId: randomUUID(), chatId: 1, status: "ready", workspacePath, members } },
        sessions: { 1: { id: 1, agent_name: group.name, status: "Created", permissionMode: "ask", workspacePath, worktrees: members } },
      }),
      { chats: [] },
    );
    await store.flush(group.id);
    for (const member of members) {
      await states.update(
        member.projectPath,
        (state) => {
          const worktree = Object.values(state.worktrees).find((item) => item.path === member.worktreePath);
          const sessions = { ...state.sessions };
          for (const session of Object.values(sessions))
            if (session.worktree_id === worktree.id) sessions[session.id] = { ...session, readOnlyReason: HISTORY };
          return { ...state, sessions };
        },
        { chats: [] },
      );
      await states.flush(member.projectPath);
      const state = await states.get(member.projectPath);
      const worktree = Object.values(state.worktrees).find((item) => item.path === member.worktreePath);
      for (const session of Object.values(state.sessions).filter((item) => item.worktree_id === worktree.id))
        await agents.closeChat(`${member.projectPath}#${session.id}`);
      await readProject(member.projectPath);
    }
    await registry.setLinkChat(link.id, { linkId: group.id, sessionId: 1 });
    await store.update(group.id, (state) => ({ ...state, adoptionPending: false }), { chats: [] });
    await store.flush(group.id);
    broadcast(scope, await store.get(group.id));
  }
  async function change(id, mode) {
    if (mode !== "shared" && mode !== "separate") throw new Error("Choose separate Chats or a shared Chat.");
    const snapshot = await registry.snapshot();
    const link = snapshot.links.find((item) => item.id === id);
    if (!link?.a.worktree_path || !link.b.worktree_path) throw new Error("Choose a Link between two Worktrees. Project Links keep separate Chats.");
    if (mode === "shared" && link.a.project_id === link.b.project_id)
      throw new Error("A shared Chat supports one Worktree per Project. Choose Worktrees from different Projects.");
    const paths = [link.a.worktree_path, link.b.worktree_path];
    for (const folder of paths) changing.add(folder);
    try {
      const group = await groupFor(id);
      if (mode === "shared") await share(link, group, snapshot.projects);
      else {
        await separate(link, group);
        // Also finishes a release whose final Project refresh was interrupted.
        for (const id of new Set([link.a.project_id, link.b.project_id])) {
          const project = snapshot.projects.find((item) => item.id === id);
          if (project) await readProject(project.path);
        }
      }
      return await changed();
    } finally {
      for (const folder of paths) changing.delete(folder);
    }
  }
  return {
    assertWritable,
    remove(id, action) {
      const run = queue
        .catch(() => {})
        .then(async () => {
          if (await groupFor(id)) throw new Error("Switch this Link to separate Chats before removing it.");
          return action();
        });
      queue = run;
      return run;
    },
    change(id, mode) {
      const run = queue.catch(() => {}).then(() => change(id, mode));
      queue = run;
      return run;
    },
  };
}
module.exports = { createCanvasChatModes };
