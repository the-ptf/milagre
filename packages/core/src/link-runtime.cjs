const { scopeKey, validLinkId } = require("@milagre/shared/chat-scopes");
const { chatKey } = require("@milagre/shared/agent-runs");
const { chatTitle } = require("@milagre/shared/chats");
const { linkRunningText } = require("@milagre/shared/worktree-link");
const { pullRequestActionBody, pullRequestActionContext, pullRequestActionPrompt } = require("@milagre/shared/pr-action");
const { createSentFromNotes } = require("./sent-from.cjs");

async function linkPullRequestMessage(request, action, session, readPullRequestState) {
  const context = pullRequestActionContext(action);
  if (!context) throw new Error("That pull request action isn't valid.");
  const member = session?.worktrees.find((entry) => entry.projectId === action.projectId);
  if (!member) throw new Error("Choose the pull request's member Worktree.");
  const { known, pr } = await readPullRequestState(member.worktreePath);
  if (!known) throw new Error("Milagre couldn't verify the current pull request for this Worktree. Try again when GitHub is available.");
  if (pr?.state !== "OPEN" || pr.url !== context.url)
    throw new Error("This is no longer the open pull request for this Worktree's branch. Refresh the pull request before trying again.");
  return {
    ...request,
    body: pullRequestActionBody(context),
    prompt: `Run Git and GitHub commands in the member Worktree ${JSON.stringify(member.alias ?? member.worktreePath)}. ${pullRequestActionPrompt(context)}`,
    images: [],
    files: [],
    context,
    idleOnly: true,
  };
}

async function linkSendMessage(request, session, readPullRequestState, issues) {
  const { linearIssue, prAction, ...rest } = request;
  if (prAction !== undefined) return { message: await linkPullRequestMessage(rest, prAction, session, readPullRequestState), issue: null };
  if (linearIssue !== undefined && issues) return issues.message(rest, linearIssue);
  return { message: { ...rest, context: undefined }, issue: null };
}

function registerLinkRuntime({
  commands,
  registry,
  store,
  workspaces,
  chats,
  readPullRequestState,
  sentFromNotes = createSentFromNotes(),
  rememberTurnDefaults = () => {},
  broadcast,
  titles,
  retire = async () => {},
  released = async () => {},
  issues = null,
}) {
  const queues = new Map();
  const deleting = new Set();
  async function definition(id) {
    if (!validLinkId(id)) throw new Error("Invalid Link ID");
    const link = (await registry().listProjectGroups()).find((item) => item.id === id);
    if (!link) throw new Error("Link no longer exists");
    return link;
  }
  async function usable(id) {
    const link = await definition(id);
    if (deleting.has(id)) throw new Error("This Link is being deleted.");
    if ((store.cached(id) ?? (await store.get(id))).deletedAt) throw new Error("This Link was partly deleted. Delete it again to finish.");
    if ((store.cached(id) ?? (await store.get(id))).adoptionPending) throw new Error("Finish changing this Link's Chat mode from the canvas.");
    return link;
  }
  async function open(id) {
    const link = await usable(id),
      key = scopeKey({ kind: "link", linkId: id });
    try {
      await workspaces.recoverLinkPreparations(id);
    } catch {}
    await store.update(
      id,
      (latest) => {
        const sessions = { ...latest.sessions };
        let changed = false;
        for (const prep of link.canvasLinkId ? [] : Object.values(latest.preparations))
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
      if (state.deletedAt) continue;
      for (const session of Object.values(state.sessions)) {
        if (session.workspacePath === real) return session.worktrees.map((member) => member.worktreePath);
      }
    }
    throw new Error("Choose an open shared Chat workspace");
  });
  commands.handle("link:list", () => registry().listProjectGroups());
  commands.handle("link:create", (_event, request) => registry().createProjectGroup(request));
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
  commands.handle("link:delete", (_event, id) => {
    if (!validLinkId(id)) throw new Error("Invalid Link ID");
    const run = (queues.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const link = await definition(id);
        if (link.canvasLinkId) throw new Error("Manage this Link's Chat mode on the canvas. Its histories and existing Worktrees are kept.");
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
    rememberTurnDefaults(request ?? {});
    const run = (queues.get(request.linkId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const link = await definition(request.linkId);
        const operationId = request.operationId;
        if (!validLinkId(operationId)) throw new Error("Invalid send operation");
        if (!store.has(link.id)) throw new Error("Open the Link before sending");
        await usable(link.id);
        let state = await store.get(link.id);
        const earlier = store.findMessage
          ? await store.findMessage(link.id, "operationId", operationId)
          : state.messages.find((message) => message.operationId === operationId);
        if (earlier) return { sessionId: earlier.session_id };
        await workspaces.membersAvailable(link);
        const started = await linkSendMessage(request, state.sessions[request.sessionId ?? (link.canvasLinkId ? 1 : 0)], readPullRequestState, issues);
        let sessionId = request.sessionId;
        if (link.canvasLinkId) {
          if (state.releasedAt) throw new Error("This shared Chat is read-only. Continue in a new Chat in either Worktree.");
          sessionId ??= 1;
          if (!state.sessions[sessionId]) throw new Error("Open the existing shared Chat from the canvas.");
          started.message.permissionMode = state.sessions[sessionId].permissionMode ?? "ask";
        }
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
