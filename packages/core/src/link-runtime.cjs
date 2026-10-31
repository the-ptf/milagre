const { scopeKey, validLinkId } = require("@milagre/shared/chat-scopes");
const { chatKey } = require("@milagre/shared/agent-runs");
const { createSentFromNotes } = require("./sent-from.cjs");
function registerLinkRuntime({ commands, registry, store, workspaces, chats, sentFromNotes = createSentFromNotes(), broadcast, titles }) {
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
        let sessionId = request.sessionId;
        if (sessionId == null) {
          sessionId = Object.values(state.preparations).find((prep) => prep.operationId === operationId)?.chatId ?? state.next_id;
          const prepared = await workspaces.prepareLinkChat({ link, chatId: sessionId, prompt: request.body || "", operationId });
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
          sentFromNotes.message(
            { ...request, projectPath: key, sessionId, operationId, context: undefined },
            request.sessionId == null ? null : chatKey(key, sessionId),
          ),
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
    open,
    async workspace(root) {
      for (const id of store.ids())
        for (const session of Object.values((await store.get(id)).sessions)) if (session.workspacePath === root) return session.worktrees;
      throw new Error("Workspace unavailable");
    },
  };
}
module.exports = { registerLinkRuntime };
