const { randomUUID } = require("node:crypto");
const { scopeKey, validLinkId } = require("@milagre/shared/chat-scopes");
// `issues` reads a Chat started from a Linear issue (see chat:send in runtime.cjs): its message and the issue itself.
function registerLinkRuntime({ commands, registry, store, workspaces, chats, broadcast, titles, issues }) {
  const queues = new Map();
  async function definition(id) {
    if (!validLinkId(id)) throw new Error("Invalid Link ID");
    const link = (await registry().listProjectGroups()).find((item) => item.id === id);
    if (!link) throw new Error("Link no longer exists");
    return link;
  }
  async function open(id) {
    const link = await definition(id),
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
        for (const prep of Object.values(latest.preparations)) {
          if (prep.status !== "ready") continue;
          // A preparation from before Worktrees were made on demand made every member, and has no project list.
          const worktrees = prep.projects ? prep.members.filter((member) => member.status === "ready") : prep.members;
          const session = sessions[prep.chatId];
          if (!session) {
            sessions[prep.chatId] = {
              id: prep.chatId,
              agent_name: link.name,
              status: "Created",
              workspacePath: prep.workspacePath,
              worktrees,
              ...(prep.projects ? { projects: prep.projects } : {}),
            };
            changed = true;
          } else if (worktrees.length > session.worktrees.length) {
            // A member made just before a restart, whose Chat hadn't been told yet.
            sessions[prep.chatId] = { ...session, worktrees };
            changed = true;
          }
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
    const projects = await registry().list();
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
    for (const id of store.ids())
      for (const session of Object.values((await store.get(id)).sessions)) {
        if (session.workspacePath === real) return session.worktrees.map((member) => member.worktreePath);
      }
    throw new Error("Choose an open shared Chat workspace");
  });
  commands.handle("link:list", () => registry().listProjectGroups());
  commands.handle("link:create", (_event, request) => registry().createProjectGroup(request));
  // Waits for a send in progress, so a new Chat prepares against one membership.
  commands.handle("link:update", (_event, request) => {
    const id = request?.id;
    if (!validLinkId(id)) throw new Error("Invalid Link ID");
    const run = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(() => registry().updateProjectGroup(request));
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
        const sent = await chats.send({ ...started.message, projectPath: key, sessionId, operationId });
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
  // The agent's link_worktree tool: the Chat's Worktree in one member Project, made the first time it is asked for.
  async function prepareMember(linkId, sessionId, project) {
    const result = await workspaces.prepareLinkMember({ linkId, chatId: sessionId, project });
    if (result.created) {
      const key = scopeKey({ kind: "link", linkId });
      await store.update(
        linkId,
        (latest) =>
          latest.sessions[sessionId]
            ? { ...latest, sessions: { ...latest.sessions, [sessionId]: { ...latest.sessions[sessionId], worktrees: result.worktrees } } }
            : latest,
        { chats: [] },
      );
      await store.flush(linkId);
      broadcast(key, await store.get(linkId));
    }
    return result;
  }
  return {
    definition,
    open,
    prepareMember,
    async workspace(root) {
      return (await this.workspaceSession(root)).worktrees;
    },
    /** The shared Chat whose folder `root` is. */
    async workspaceSession(root) {
      for (const id of store.ids()) for (const session of Object.values((await store.get(id)).sessions)) if (session.workspacePath === root) return session;
      throw new Error("Workspace unavailable");
    },
  };
}
module.exports = { registerLinkRuntime };
