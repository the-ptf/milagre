const { scopeKey, validLinkId } = require("@milagre/shared/chat-scopes");
const { chatKey } = require("@milagre/shared/agent-runs");
const { chatTitle } = require("@milagre/shared/chats");
const { linkRunningText } = require("@milagre/shared/worktree-link");
const { createSentFromNotes } = require("./sent-from.cjs");
/**
 * `retire(scope, sessionId)` archives one Chat of a Link being deleted and closes what runs for it. `released({ removed,
 * kept })` then hears which of the Link's Worktrees went and which stayed, as member records (link-workspaces.cjs).
 */
function registerLinkRuntime({
  commands,
  registry,
  store,
  workspaces,
  chats,
  sentFromNotes = createSentFromNotes(),
  broadcast,
  titles,
  retire = async () => {},
  released = async () => {},
  // A Chat started from a Linear issue (see chat:send in runtime.cjs): its message, and the issue itself.
  issues = null,
}) {
  const queues = new Map();
  // Links a delete is working on: none of them takes new work until it ends (see usable).
  const deleting = new Set();
  async function definition(id) {
    if (!validLinkId(id)) throw new Error("Invalid Link ID");
    const link = (await registry().listProjectGroups()).find((item) => item.id === id);
    if (!link) throw new Error("Link no longer exists");
    return link;
  }
  /**
   * The Link, when it may take work: an open (which resumes interrupted Chats), a send, a turn, a new Worktree, an edit.
   * Not while a delete runs, and not once one marked it: a delete that stopped before the registry entry went has handed
   * its Worktrees back to their Projects, so the Link only waits to be deleted again. Reads stay open (definition).
   */
  async function usable(id) {
    const link = await definition(id);
    if (deleting.has(id)) throw new Error("This Link is being deleted.");
    if ((store.cached(id) ?? (await store.get(id))).deletedAt) throw new Error("This Link was partly deleted. Delete it again to finish.");
    return link;
  }
  async function open(id) {
    const link = await usable(id),
      key = scopeKey({ kind: "link", linkId: id });
    try {
      await workspaces.recoverLinkPreparations(id);
    } catch {
      /* The saved failure remains readable below. */
    }
    await store.update(
      id,
      (latest) => {
        const sessions = { ...latest.sessions };
        let changed = false;
        for (const prep of Object.values(latest.preparations))
          if (prep.status === "ready" && !sessions[prep.chatId]) {
            sessions[prep.chatId] = {
              id: prep.chatId,
              agent_name: link.name,
              status: "Created",
              workspacePath: prep.workspacePath,
              worktrees: prep.members.filter((member) => member.setupDone),
            };
            changed = true;
          }
        return changed ? { ...latest, sessions } : latest;
      },
      { chats: [] },
    );
    let state = await store.get(id);
    await chats.resumeInterrupted(key, state).catch(() => {});
    state = await store.get(id);
    titles.resume(key, state);
    void chats.recoverHandoffs(key, state).catch(() => {});
    // The registry as saved: names and paths, without checking every registered Project with git again.
    const { projects } = await registry().snapshot();
    return {
      link,
      state,
      projects: link.projectIds.map(
        (projectId) =>
          projects.find((project) => project.id === projectId) ?? {
            id: projectId,
            name: require("node:path").basename(require("node:path").dirname(projectId)),
            path: "",
          },
      ),
    };
  }
  commands.handle("link:workspace-roots", async (_event, requested) => {
    const fs = require("node:fs/promises");
    const real = await fs.realpath(requested).catch(() => null);
    for (const id of store.ids()) {
      const state = await store.get(id);
      // A deleted Link's workspace is no Chat's any more; its kept Worktrees are their Projects'.
      if (state.deletedAt) continue;
      for (const session of Object.values(state.sessions)) {
        if (session.workspacePath === real) return session.worktrees.map((member) => member.worktreePath);
      }
    }
    throw new Error("Choose an open shared Chat workspace");
  });
  commands.handle("link:list", () => registry().listProjectGroups());
  commands.handle("link:create", (_event, request) => registry().createProjectGroup(request));
  // Waits for a send in progress, so a new Chat prepares against one membership.
  commands.handle("link:update", (_event, request) => {
    const id = request?.id;
    if (!validLinkId(id)) throw new Error("Invalid Link ID");
    const run = (queues.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await usable(id);
        return registry().updateProjectGroup(request);
      });
    queues.set(id, run);
    run
      .finally(() => {
        if (queues.get(id) === run) queues.delete(id);
      })
      .catch(() => {});
    return run;
  });
  // What deleting a Link would close: its Chats not archived yet, and the titles of those with a turn running or on its
  // way (what a restart would cut short). The confirmation on desktop and phone shows both.
  async function deletion(link) {
    const key = scopeKey({ kind: "link", linkId: link.id });
    const sessions = Object.values((await store.get(link.id)).sessions);
    const busy = chats.busyChats();
    return {
      sessions,
      chats: sessions.filter((session) => !session.archived).length,
      running: sessions.filter((session) => busy.has(chatKey(key, session.id))).map((session) => chatTitle(session)),
    };
  }
  commands.handle("link:delete-check", async (_event, id) => {
    const { chats: count, running } = await deletion(await definition(id));
    return { chats: count, running };
  });
  // Deleting a Link never deletes work (#200): refused while one of its Chats runs; its Chats are archived and their
  // transcripts stay in its folder; a Worktree with changes or unpushed commits stays and goes back to its Project.
  // From the first step nothing new starts in the Link (usable), so the running check holds until the end. The state is
  // marked first and the registry entry goes last, so a failure on the way leaves a Link to delete again. Each step
  // broadcasts the state with `deletedAt`, the last after the registry entry is gone, so every device leaves the Link.
  commands.handle("link:delete", (_event, id) => {
    if (!validLinkId(id)) throw new Error("Invalid Link ID");
    const run = (queues.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const link = await definition(id);
        deleting.add(id);
        try {
          const { sessions, running } = await deletion(link);
          if (running.length) throw new Error(linkRunningText(running));
          const key = scopeKey({ kind: "link", linkId: link.id });
          for (const session of sessions) await retire(key, session.id);
          const result = await workspaces.releaseLinkWorktrees(link.id);
          await store.update(link.id, (latest) => ({ ...latest, deletedAt: latest.deletedAt ?? new Date().toISOString() }), { chats: [] });
          await store.flush(link.id);
          await registry().deleteProjectGroup(link.id);
          // The Link is gone; what follows only tidies, and never turns the delete into a failure.
          await released(result).catch((error) => console.warn("Milagre deleted a Link but couldn't tidy after it:", error.message));
          broadcast(key, await store.get(link.id));
          return { removed: result.removed.map((member) => member.worktreePath), kept: result.kept.map((member) => member.worktreePath) };
        } finally {
          deleting.delete(id);
        }
      });
    queues.set(id, run);
    run
      .finally(() => {
        if (queues.get(id) === run) queues.delete(id);
      })
      .catch(() => {});
    return run;
  });
  commands.handle("link:open", (_event, id) => open(id));
  commands.handle("link:snapshot", async (_event, id) => ({ link: await definition(id), state: await store.get(id) }));
  commands.handle("link:send", (_event, request) => {
    const run = (queues.get(request.linkId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const link = await definition(request.linkId);
        const operationId = request.operationId;
        if (!validLinkId(operationId)) throw new Error("Invalid send operation");
        if (!store.has(link.id)) throw new Error("Open the Link before sending");
        await usable(link.id);
        let state = await store.get(link.id);
        // A send already made with this operation, in a Chat that may be unloaded (see message-store.cjs).
        const earlier = store.findMessage
          ? await store.findMessage(link.id, "operationId", operationId)
          : state.messages.find((message) => message.operationId === operationId);
        if (earlier) return { sessionId: earlier.session_id };
        await workspaces.membersAvailable(link);
        // Only Milagre writes a message's context: a Linear issue's card is read from Linear here, never the renderer's.
        const { linearIssue, ...rest } = request;
        const started =
          linearIssue !== undefined && issues ? await issues.message(rest, linearIssue) : { message: { ...rest, context: undefined }, issue: null };
        let sessionId = request.sessionId;
        if (sessionId == null) {
          sessionId = Object.values(state.preparations).find((prep) => prep.operationId === operationId)?.chatId ?? state.next_id;
          const prepared = await workspaces.prepareLinkChat({
            link,
            chatId: sessionId,
            prompt: request.body || "",
            operationId,
            ...(started.issue ? { issue: started.issue } : {}),
          });
          if (started.issue) issues.started(started.issue);
          await store.update(
            link.id,
            (latest) =>
              latest.sessions[sessionId]
                ? latest
                : { ...latest, sessions: { ...latest.sessions, [sessionId]: { id: sessionId, agent_name: link.name, status: "Created", ...prepared } } },
            { chats: [] },
          );
          await store.flush(link.id);
        }
        const key = scopeKey({ kind: "link", linkId: link.id });
        const sent = await chats.send(
          sentFromNotes.message({ ...started.message, projectPath: key, sessionId, operationId }, request.sessionId == null ? null : chatKey(key, sessionId)),
        );
        sentFromNotes.sent(chatKey(key, sent.sessionId), request.sentFrom);
        broadcast(key, await store.get(link.id));
        return { sessionId: sent.sessionId };
      });
    queues.set(request.linkId, run);
    run
      .finally(() => {
        if (queues.get(request.linkId) === run) queues.delete(request.linkId);
      })
      .catch(() => {});
    return run;
  });
  return {
    definition,
    usable,
    open,
    /** A shared Chat folder's skill roots: its Worktree in each Project it changed, else that Project's main checkout. */
    async workspaceSkillRoots(root) {
      for (const id of store.ids()) {
        const state = await store.get(id);
        if (state.deletedAt) continue;
        for (const session of Object.values(state.sessions)) {
          if (session.workspacePath !== root) continue;
          const projects = await workspaces.membersAvailable(await definition(id)).catch(() => []);
          const made = session.worktrees.map((member) => member.worktreePath);
          return [
            ...made,
            ...projects.filter((project) => !session.worktrees.some((member) => member.projectId === project.id)).map((project) => project.path),
          ];
        }
      }
      throw new Error("Workspace unavailable");
    },
    async workspace(root) {
      for (const id of store.ids()) {
        const state = await store.get(id);
        if (state.deletedAt) continue;
        for (const session of Object.values(state.sessions)) if (session.workspacePath === root) return session.worktrees;
      }
      throw new Error("Workspace unavailable");
    },
  };
}
module.exports = { registerLinkRuntime };
