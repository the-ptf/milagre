const { isLinkScopeKey, scopeFromKey } = require("@milagre/shared/chat-scopes");
const { PROVIDERS } = require("@milagre/shared/providers");
const { pullRequestActionBody, pullRequestActionContext, pullRequestActionPrompt } = require("@milagre/shared/pr-action");
const { compactionMessage } = require("@milagre/shared/compaction");
const { RELOAD_TEXT } = require("@milagre/shared/chat-reload");
const { backgroundBusyMessage, processWork } = require("@milagre/shared/chat-activity");
const { issueFirstMessage, linearIssueContext, linearIssuePrompt, linearIssueRequest } = require("@milagre/shared/linear-issue");
const { createProviderUpdates, releaseVersion } = require("../agents/provider-updates.cjs");
const { runCliUpdate } = require("../agents/cli-update.cjs");
const { worktreeStatus } = require("../worktree-cleanup.cjs");
const { subagentActive, chatKey, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { archiveFinishedSubagents, archiveSubagent, deleteSession, patchSession } = require("@milagre/shared/project-edits");
const { isRunChat, withRunChatsHidden } = require("../routines/runtime-adapter.cjs");
const { doneDue } = require("@milagre/shared/done");
const { isHiddenRunChat } = require("@milagre/shared/chats");
const { PERMISSION_MODES } = require("../agents/permissions.cjs");
const { githubIssueMessage } = require("./github-issue-start.cjs");

function registerChatControls({
  commands,
  agents,
  background,
  chats,
  editProject,
  existingChat,
  mobileUploads,
  scopeStates,
  setupReview,
  track,
  worktreeSetups,
  advisorDelivery,
  advisors,
  bugReports,
  canvasChatModes,
  chatSecrets,
  linked,
  subchatEscalation,
}) {
  commands.handle("agent:interrupt", async (_event, chatId) => {
    await existingChat("stopping advisors")(chatId);
    await stopChat(chatId);
  });

  commands.handle("subagent:stop", async (_event, chatId, id, stopSession = false) => {
    await existingChat("stopping a subagent")(chatId);
    if (typeof id !== "string" || !id || id.length > 200 || typeof stopSession !== "boolean") throw new Error("That subagent isn't valid.");
    const state = await scopeStates.get(projectOfKey(chatId));
    const agent = state.sessions[sessionIdFromKey(chatId)]?.subagents?.find((item) => item.id === id);
    if (!agent || !subagentActive(agent) || agent.source === "milagre-advisor") throw new Error("That subagent is no longer running.");
    if (agents.canStopSubagent(chatId, id)) {
      await agents.stopSubagent(chatId, id);
      return { stopped: true, requiresSessionStop: false };
    }
    // A provider that stops children one by one never offers to stop the whole Chat: its child is only not ready yet.
    if (agents.stopsSubagents(chatId)) throw new Error("That subagent isn't ready to stop yet. Try again in a moment.");
    if (!stopSession) return { stopped: false, requiresSessionStop: true };
    await stopChat(chatId);
    await agents.closeChat(chatId);
    return { stopped: true, requiresSessionStop: false };
  });

  commands.handle("chat:queue-send", async (_event, chatId, id) => {
    await existingChat("sending a queued message")(chatId);
    if (typeof id !== "string") throw new Error("That queued message isn't valid.");
    const { interrupt } = await chats.sendQueuedNow(chatId, id);
    if (interrupt) await stopChat(chatId);
  });
  commands.handle("chat:queue-remove", async (_event, chatId, id) => {
    await existingChat("removing a queued message")(chatId);
    if (typeof id !== "string") throw new Error("That queued message isn't valid.");
    return chats.removeQueued(chatId, id);
  });

  commands.handle("chat:reload", async (_event, chatId) => {
    await existingChat("reloading it")(chatId);
    const state = await scopeStates.get(projectOfKey(chatId));
    const sessionId = sessionIdFromKey(chatId);
    if (state.sessions[sessionId]?.readOnlyReason) throw new Error(state.sessions[sessionId].readOnlyReason);
    await chats.cancelLimitResume(projectOfKey(chatId), sessionId);
    const background = Math.max(agents.backgroundWork(chatId), processWork(state.sessions[sessionId]).length);
    if (background) throw new Error(backgroundBusyMessage("reload", background));
    if (chats.runs[chatId]) await stopChat(chatId);
    if ((state.sessions[sessionId]?.summary?.count ?? 0) > 0 || state.messages.some((message) => message.session_id === sessionId))
      await chats.addNote(chatId, { body: RELOAD_TEXT, context: { kind: "reload" } });
    await agents.closeChat(chatId);
    await editProject(
      projectOfKey(chatId),
      (latest) => {
        const current = latest.sessions[sessionId];
        if (!current || (current.suggestion === undefined && current.suggestionTurnId === undefined)) return latest;
        const { suggestion: _suggestion, suggestionTurnId: _turn, ...session } = current;
        return { ...latest, sessions: { ...latest.sessions, [sessionId]: session } };
      },
      { chats: [] },
    );
  });

  commands.handle("chat:task-output", async (_event, chatId, taskId) => {
    await existingChat("reading a background task")(chatId);
    if (typeof taskId !== "string" || !taskId || taskId.length > 200) throw new Error("That background task isn't valid.");
    return agents.taskOutput(chatId, taskId);
  });

  async function stopChat(chatId) {
    chatSecrets()?.cancel(chatId);
    bugReports()?.cancel(chatId);
    const cancellingResume = chats.cancelLimitResume(projectOfKey(chatId), sessionIdFromKey(chatId));
    void track(() => cancellingResume, background).catch((error) => console.warn("Milagre couldn't save a cancelled continuation:", error.message));
    await linked().stop({ chatKey: chatId });
    await advisorDelivery().stop(chatId);
    await advisors().stopChat(chatId);
    if (await chats.cancelHandoff(chatId)) return;
    await worktreeSetups.cancel(chatId);
    await agents.interrupt(chatId);
  }

  async function respondPermission({ chatId, requestId, decision }) {
    if (typeof requestId === "string" && requestId.startsWith("setup-review-")) return setupReview.respond(chatId, requestId, decision);
    return agents.respondToPermission(chatId, requestId, decision);
  }
  commands.handle("agent:respond-permission", async (_event, request) => {
    const accepted = await respondPermission(request);
    if (accepted) noteHumanActed(request.chatId);
    return accepted;
  });
  function noteHumanActed(chatId) {
    void subchatEscalation()
      .humanActed(chatId)
      .catch((error) => console.warn("Milagre couldn't follow a Subchat's family:", error.message));
  }

  commands.handle("agent:answer-question", (_event, request = {}) => answerQuestion(request));
  async function answerQuestion({ chatId, requestId, answers, summary, images, suggestionId }, sender = null) {
    if (require("../chat-secrets.cjs").isSecretRequest(requestId)) {
      const accepted = chatSecrets().answer(chatId, requestId, answers);
      if (accepted) noteHumanActed(chatId);
      return accepted;
    }
    if (require("../bug-reports.cjs").isBugReportRequest(requestId)) {
      if (sender) throw new Error("Only the user can approve a Milagre bug report.");
      const accepted = bugReports().answer(chatId, requestId, answers);
      if (accepted) noteHumanActed(chatId);
      return accepted;
    }
    const { answerImages, withAnswerImages } = require("../agents/questions.cjs");
    const attached = answers ? answerImages(images) : {};
    for (const [id, list] of Object.entries(attached))
      attached[id] = (await mobileUploads.resolveImages(projectOfKey(chatId), list)).map(({ id: imageId, name, dataUrl }) => ({ id: imageId, name, dataUrl }));
    const stored = Object.keys(attached).length ? await chats.storeAnswerImages(chatId, attached) : {};
    const { agent, shown } = withAnswerImages(answers, stored);
    const storedImages = Object.values(stored).flat();
    const recorded =
      answers && typeof summary === "string" && summary && typeof chatId === "string" && scopeStates.has(projectOfKey(chatId))
        ? chats.recordAnswers(chatId, summary, { requestId, answers: shown, images: storedImages }).catch((error) => {
            console.warn("Milagre couldn't show the answers:", error.message);
            return null;
          })
        : Promise.resolve(null);
    const answering = subchatEscalation().answering(chatId, requestId, {
      label: sender?.answerLabel ?? summary,
      suggestionId: typeof suggestionId === "string" ? suggestionId : undefined,
      sender,
    });
    let accepted;
    try {
      accepted = await agents.answerQuestion(chatId, requestId, answers && agent);
    } catch (error) {
      answering.failed();
      const messageId = await recorded;
      if (messageId !== null) await chats.takeBack(chatId, messageId);
      throw error;
    }
    const messageId = await recorded;
    if (!accepted && messageId !== null) await chats.takeBack(chatId, messageId);
    if (!accepted) answering.failed();
    else void answering.accepted().catch((error) => console.warn("Milagre couldn't follow an answer to a Subchat:", error.message));
    return accepted;
  }

  commands.handle("agent:dismiss-suggestion", async (_event, { chatId, id } = {}) => {
    if (typeof chatId !== "string" || typeof id !== "string") throw new Error("That suggestion isn't valid.");
    return subchatEscalation().suggestions.dismiss(chatId, id);
  });

  async function setPermissionMode(chatId, mode) {
    if (!PERMISSION_MODES.has(mode)) throw new Error(`Unknown permission mode: ${mode}`);
    const scope = projectOfKey(chatId);
    const state = await scopeStates.get(scope);
    const session = state.sessions[sessionIdFromKey(chatId)];
    canvasChatModes().assertWritable(scope, state, session, state.worktrees?.[session?.worktree_id]);
    if (mode !== "full") await advisors()?.stopExecution(chatId);
    const result = await chats.setPermissionMode(chatId, mode, (id, picked) => agents.setPermissionMode(id, picked));
    if (mode === "full") advisors()?.resumeExecution(chatId);
    return result;
  }
  commands.handle("agent:set-permission-mode", (_event, { chatId, mode }) => setPermissionMode(chatId, mode));
  return { stopChat, respondPermission, noteHumanActed, answerQuestion, setPermissionMode };
}

function registerChatSend({
  options,
  commands,
  background,
  chats,
  linear,
  linearIssues,
  readLinearIssue,
  scopeStates,
  sentFromNotes,
  track,
  turnDefaults,
  noteHumanActed,
  keepRunChat,
  reopenDoneChat,
  wakeSnoozedChat,
}) {
  commands.handle("chat:send", (_event, request) => {
    turnDefaults.remember(request ?? {});
    return sendAsUser(request);
  });
  async function sendAsUser(request) {
    if (isLinkScopeKey(request?.projectPath) || !scopeStates.has(request?.projectPath)) throw new Error("Open the project before sending to its chats.");
    const { prAction, linearIssue, githubIssue, compact, sentFrom, ...rest } = request;
    const action = prAction === undefined ? null : pullRequestActionContext(prAction);
    if (prAction !== undefined && !action) throw new Error("That pull request action isn't valid.");
    if (compact && rest.sessionId == null) throw new Error("Open a chat before compacting it.");
    const message = action
      ? { ...rest, body: pullRequestActionBody(action), prompt: pullRequestActionPrompt(action), images: [], files: [], context: action }
      : compact
        ? { ...rest, ...compactionMessage() }
        : linearIssue !== undefined
          ? (await linearIssueMessage(rest, linearIssue)).message
          : githubIssue !== undefined
            ? await githubIssueMessage(options, rest, githubIssue)
            : { ...rest, context: undefined };
    const { sessionId } = await chats.send(
      compact ? message : sentFromNotes.message({ ...message, sentFrom }, rest.sessionId == null ? null : chatKey(rest.projectPath, rest.sessionId)),
    );
    if (!compact) sentFromNotes.sent(chatKey(rest.projectPath, sessionId), sentFrom);
    noteHumanActed(chatKey(rest.projectPath, sessionId));
    if (rest.sessionId != null) {
      await keepRunChat(rest.projectPath, sessionId).catch((error) => console.warn("Milagre couldn't keep a Run Chat:", error.message));
      await reopenDoneChat(rest.projectPath, sessionId).catch((error) => console.warn("Milagre couldn't reopen a Done Chat:", error.message));
      await wakeSnoozedChat(rest.projectPath, sessionId, { byUser: true }).catch((error) =>
        console.warn("Milagre couldn't wake a snoozed Chat:", error.message),
      );
    }
    return { sessionId };
  }
  async function linearIssueMessage(rest, request) {
    const ask = linearIssueRequest(request);
    if (!ask) throw new Error("That Linear issue isn't valid.");
    const issue = await readLinearIssue(ask.key, ask.workspace).catch((error) => {
      console.warn(`Milagre couldn't read ${ask.key} for its card:`, error.message);
      return null;
    });
    if (!issue) return { message: { ...rest, context: undefined }, issue: null };
    const files = Array.isArray(rest.files) ? rest.files : [];
    return {
      message: {
        ...rest,
        body: issueFirstMessage(issue, ask.note),
        prompt: linearIssuePrompt(issue, ask.note) + (files.length ? `\n\nAttached files:\n${files.join("\n")}` : ""),
        context: linearIssueContext(issue, ask.note),
      },
      issue,
    };
  }
  function markIssueStarted(issue) {
    if (linear.moveToStarted() && linear.canWrite(issue.workspace))
      void track(() => linearIssues.markStarted(issue.key, issue.workspace), background).catch(() => {});
  }
  commands.handle("chat:resume", async (_event, projectPath, sessionId) => {
    if (!scopeStates.has(projectPath)) throw new Error("Open the project before continuing its chats.");
    return chats.resumeChat(projectPath, Number(sessionId));
  });
  return { sendAsUser, linearIssueMessage, markIssueStarted };
}

const RETIRE_MODES = new Set(["archive", "delete", "worktree-removal", "run-cleanup"]);

/**
 * The one ordered sequence that retires a Chat, shared by archive, delete, Worktree removal and Routine Run cleanup.
 * `retireChat(chatId, { mode, edit })` runs every step in `steps` order; `edit` is the mode's Project state change, which
 * notifies clients. Archive starts the steps, saves `edit` at once and finishes the steps in the background (#718, #734),
 * resolving with `{ stopped }`. Delete runs the steps, then `edit`, then removes the Chat's stored data. Worktree removal
 * frees the Worktree with `releaseChat` (the steps marked `frees`) before Git removes it, so a refused removal loses
 * nothing, and retires the Chat with its stored data once the Worktree is gone. Run cleanup saves `edit`, then runs the steps.
 */
function createChatRetirement({
  agents,
  background,
  chats,
  scopeStates,
  track,
  worktreeSetups,
  terminals,
  artifacts,
  computerUseScreen,
  pageComments,
  advisorDelivery,
  advisors,
  btw = () => null,
  bugReports,
  chatSecrets,
  linked,
  routines,
  stopChat,
}) {
  const steps = [
    { name: "end Heartbeats", run: (chatId) => routines().chatArchived(chatId) },
    {
      name: "cancel a pending continuation",
      run: (chatId) => scopeStates.has(projectOfKey(chatId)) && chats.cancelLimitResume(projectOfKey(chatId), sessionIdFromKey(chatId)),
    },
    { name: "stop the turn and queued sends", frees: true, run: (chatId) => chats.runs[chatId] && stopChat(chatId) },
    { name: "cancel Worktree setup", frees: true, run: (chatId) => worktreeSetups.cancel(chatId) },
    { name: "close side questions", frees: true, run: (chatId) => btw()?.closeChat(chatId) },
    { name: "close the agent session", frees: true, run: (chatId) => agents.closeChat(chatId) },
    { name: "stop background commands", frees: true, run: (chatId) => terminals.closeChat(chatId) },
    {
      name: "settle advisors",
      frees: true,
      run: async (chatId) => {
        await advisorDelivery().stop(chatId);
        await advisors().stopChat(chatId);
      },
    },
    { name: "settle delegations", run: (chatId) => linked().stop({ chatKey: chatId }) },
    {
      name: "clear pending questions",
      run: (chatId) => {
        chatSecrets()?.cancel(chatId);
        bugReports()?.cancel(chatId);
      },
    },
  ];
  async function runSteps(chatId, list = steps) {
    for (const step of list) await step.run(chatId);
  }
  const releaseChat = (chatId) =>
    runSteps(
      chatId,
      steps.filter((step) => step.frees),
    );
  async function removeChatData(chatId) {
    chats.forget(chatId);
    computerUseScreen.forget(chatId);
    await artifacts.removeChat(chatId).catch(() => {});
    await pageComments.removeChat(chatId).catch(() => {});
  }
  async function retireChat(chatId, { mode, edit = async () => {} }) {
    if (!RETIRE_MODES.has(mode)) throw new Error(`Unknown way to retire a Chat: ${mode}`);
    if (mode === "archive") {
      const stopped = runSteps(chatId);
      stopped.catch(() => {});
      await edit();
      void track(() => stopped, background).catch((error) => console.warn("Milagre couldn't stop an archived Chat's work:", error.message));
      return { stopped };
    }
    if (mode === "run-cleanup") await edit();
    await runSteps(chatId);
    if (mode === "run-cleanup") return {};
    await edit();
    await removeChatData(chatId);
    return {};
  }
  return { steps: steps.map((step) => step.name), retireChat, releaseChat, removeChatData };
}

function registerChatRetire({
  commands,
  handlers,
  chats,
  editProject,
  environmentReady,
  existingChat,
  heldState,
  linkStore,
  needsUserAt,
  scopeStates,
  states,
  linkRuntime,
  needsUserCount,
  routines,
  retirement,
}) {
  const { retireChat } = retirement;
  async function archiveChat(projectPath, sessionId, patch = { archived: true }) {
    if (!scopeStates.has(projectPath)) return { stopped: Promise.resolve() };
    await chats.cancelLimitResume(projectPath, sessionId);
    return retireChat(`${projectPath}#${sessionId}`, {
      mode: "archive",
      edit: () => editProject(projectPath, (state) => patchSession(state, sessionId, patch), { chats: [] }),
    });
  }
  async function moveRunChats(projectPath, sessionIds, { worktreeId, formerWorktree, archive = [], restore }) {
    const before = {};
    await editProject(
      projectPath,
      (state) => {
        const sessions = { ...state.sessions };
        for (const id of restore ? [] : archive) {
          const session = sessions[id];
          if (!session) continue;
          before[id] = { worktree_id: session.worktree_id, archived: session.archived };
          sessions[id] = { ...session, archived: true };
        }
        for (const id of sessionIds) {
          const session = sessions[id];
          if (!session) continue;
          if (restore) {
            const previous = restore[id];
            if (!previous) continue;
            const { formerWorktree: _former, ...rest } = session;
            sessions[id] = { ...rest, worktree_id: previous.worktree_id, archived: previous.archived };
            continue;
          }
          before[id] = { worktree_id: session.worktree_id, archived: session.archived };
          sessions[id] = { ...session, worktree_id: worktreeId, archived: true, formerWorktree };
        }
        return { ...state, sessions };
      },
      { chats: [] },
    );
    return before;
  }
  async function archiveRunChat(projectPath, sessionId, runId) {
    const left = (session) => isHiddenRunChat(session) && !session.archived && session.routine.runId === runId;
    if (!scopeStates.has(projectPath) || !left((await scopeStates.get(projectPath)).sessions[sessionId])) return;
    let archived = false;
    await editProject(
      projectPath,
      (state) => {
        if (!left(state.sessions[sessionId])) return state;
        archived = true;
        return patchSession(state, sessionId, { archived: true });
      },
      { chats: [] },
    );
    if (archived) await retireChat(`${projectPath}#${sessionId}`, { mode: "run-cleanup" });
  }
  async function keepRunChat(projectPath, sessionId) {
    if (!scopeStates.has(projectPath)) return;
    const keepable = (session) => isRunChat(session) && session.routine.hidden !== false;
    if (!keepable(heldState(projectPath)?.sessions[sessionId])) return;
    if (!keepable((await scopeStates.get(projectPath)).sessions[sessionId])) return;
    await editProject(projectPath, (state) => withRunChatsHidden(state, { [sessionId]: false }, (routine) => routine.hidden !== false), { chats: [] });
  }
  function sessionPatch(patch) {
    if (!patch || typeof patch !== "object") return {};
    const { done, done_at: _clientClock, ...rest } = patch;
    if (done === true) return { ...rest, done_at: Date.now(), snoozed_until: undefined };
    if (done === false || rest.archived === false) return { ...rest, done_at: undefined, snoozed_until: undefined };
    if (rest.archived) return { ...rest, snoozed_until: undefined };
    return rest;
  }
  async function patchChat(projectPath, sessionId, raw) {
    if (!scopeStates.has(projectPath)) return;
    const receivedAt = needsUserCount();
    const patch = sessionPatch(raw);
    if (patch.archived) return archiveChat(projectPath, sessionId, patch);
    if (patch.done_at) routines().chatDone(`${projectPath}#${sessionId}`);
    await editProject(projectPath, (state) => patchSession(state, sessionId, patch), { chats: [] });
    if (patch.snoozed_until && (needsUserAt.get(`${projectPath}#${sessionId}`) ?? 0) > receivedAt) await wakeSnoozedChat(projectPath, sessionId);
  }
  async function reopenDoneChat(projectPath, sessionId) {
    if (!scopeStates.has(projectPath) || !heldState(projectPath)?.sessions[sessionId]?.done_at) return;
    await editProject(projectPath, (state) => patchSession(state, sessionId, { done_at: undefined }), { chats: [] });
  }
  async function wakeSnoozedChat(projectPath, sessionId, { due = false, byUser = false } = {}) {
    if (!scopeStates.has(projectPath) || !heldState(projectPath)?.sessions[sessionId]?.snoozed_until) return false;
    let woke = false;
    await editProject(
      projectPath,
      (state) => {
        const session = state.sessions[sessionId];
        if (!session?.snoozed_until || (due && session.snoozed_until > Date.now())) return state;
        woke = true;
        return patchSession(state, sessionId, byUser ? { snoozed_until: undefined } : { snoozed_until: undefined, unread: true });
      },
      { chats: [] },
    );
    return woke;
  }
  async function archiveDoneChat(scope, sessionId, retentionHours) {
    if (!scopeStates.has(scope)) return false;
    const session = (await scopeStates.get(scope)).sessions[sessionId];
    if (!doneDue(session, retentionHours)) return false;
    await archiveChat(scope, sessionId, { archived: true, unread: false });
    if (isLinkScopeKey(scope) || !states.has(scope)) return true;
    const state = await states.get(scope);
    const worktree = state.worktrees[session.worktree_id];
    if (!worktree?.base || worktree.path === scope) return true;
    if (Object.values(state.sessions).some((other) => other.worktree_id === worktree.id && !other.archived && other.id !== session.id)) return true;
    await environmentReady;
    const status = await worktreeStatus(worktree.path, worktree.base).catch(() => null);
    if (!status?.removable) return true;
    await handlers
      .get("worktree:remove")({}, worktree.path, { projectPath: scope, chatId: `${scope}#${sessionId}`, seen: status })
      .catch((error) => console.warn("Milagre kept a Done Chat's worktree:", error.message));
    return true;
  }
  commands.handle("chat:patch", async (_event, projectPath, sessionId, patch) => {
    await patchChat(projectPath, sessionId, patch);
    if (patch?.kept === true || patch?.pinned === true || patch?.archived === false || (typeof patch?.title === "string" && patch.title.trim() !== ""))
      await keepRunChat(projectPath, sessionId);
  });
  commands.handle("chat:fork", async (_event, projectPath, sessionId, options) => {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Choose an existing Chat to fork.");
    await existingChat("forking it")(`${projectPath}#${sessionId}`);
    return chats.forkChat(projectPath, sessionId, options ?? {});
  });
  commands.handle("chat:delete", async (_event, projectPath, sessionId) => {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Choose an existing Chat to delete.");
    const chatId = `${projectPath}#${sessionId}`;
    await existingChat("deleting it")(chatId);
    if (isLinkScopeKey(projectPath)) {
      const { linkId } = scopeFromKey(projectPath);
      const link = await linkRuntime().definition(linkId);
      if (link.canvasLinkId && !(await linkStore.get(linkId)).releasedAt)
        throw new Error("Switch this Link to separate Chats before deleting its shared conversation.");
    }
    await retireChat(chatId, {
      mode: "delete",
      edit: () => editProject(projectPath, (state) => deleteSession(state, sessionId), { chats: [sessionId] }),
    });
  });
  commands.handle("chat:archive-subagent", (_event, projectPath, sessionId, id, archived) =>
    scopeStates.has(projectPath)
      ? editProject(projectPath, (state) => archiveSubagent(state, sessionId, String(id), archived === true), { chats: [] }).then(() => {})
      : undefined,
  );
  commands.handle("chat:archive-finished-subagents", (_event, projectPath, sessionId) =>
    scopeStates.has(projectPath) ? editProject(projectPath, (state) => archiveFinishedSubagents(state, sessionId), { chats: [] }).then(() => {}) : undefined,
  );
  commands.handle("chat:git-note", (_event, chatId, body) => {
    if (typeof chatId !== "string" || typeof body !== "string" || !scopeStates.has(projectOfKey(chatId))) return undefined;
    return chats.addNote(chatId, { body, context: { kind: "git-action" } });
  });
  return { archiveChat, moveRunChats, archiveRunChat, keepRunChat, patchChat, reopenDoneChat, wakeSnoozedChat, archiveDoneChat };
}

function registerChatStatus({
  options,
  emit,
  commands,
  agentCli,
  antigravity,
  background,
  chats,
  environmentReady,
  projectName,
  routing,
  scopeStates,
  track,
  updateProject,
  advisors,
  linkRuntime,
  validateAccountScope,
}) {
  async function readOpenChat(chatId = chats.openChat) {
    if (chatId && scopeStates.has(projectOfKey(chatId))) {
      await updateProject(projectOfKey(chatId), (state) => patchSession(state, sessionIdFromKey(chatId), { unread: false }), { chats: [] });
      void track(async () => {
        await advisors().reconcile(chatId);
        await chats.recoverSubagents(chatId);
      }, background).catch((error) => console.warn("Milagre couldn't refresh subagent outcomes:", error.message));
    }
  }
  commands.handle("chat:set-open", (_event, chatId) => {
    chats.setOpenChat(chatId);
    return readOpenChat();
  });
  commands.handle("chat:runs", () => chats.snapshot());
  commands.handle("chat:inbox", async () => {
    const scopes = await Promise.all(
      scopeStates.projects().map(async (key) => ({
        path: key,
        name: isLinkScopeKey(key) ? (await linkRuntime().definition(scopeFromKey(key).linkId)).name : projectName(key),
        state: await scopeStates.inboxState(key),
      })),
    );
    return require("@milagre/shared/attention").inboxSnapshot(scopes, chats.snapshot().runs);
  });

  const agentCliStatus = (scope) => (options.agentCliStatus ? options.agentCliStatus() : routing.services(scope).status());
  agentCliStatus.invalidate = (provider) => {
    routing.invalidate(provider);
    options.agentCliStatus?.invalidate?.(provider);
  };
  const providerUpdates = options.providerUpdates ?? createProviderUpdates({ ready: () => environmentReady, antigravity });
  const cliProgress = new Map();
  let progressSignal = null;
  const signalProgress = () => {
    progressSignal ??= setTimeout(() => {
      progressSignal = null;
      emit("provider-updates:changed", {});
    }, 250);
  };
  commands.handle("agent:provider-updates", async () =>
    (await providerUpdates()).map((update) => (cliProgress.has(update.provider) ? { ...update, progress: cliProgress.get(update.provider) } : update)),
  );
  const cliUpdates = new Map();
  commands.handle("agent:cli-status", async (_event, scope) => agentCliStatus(await validateAccountScope(scope, true)));
  commands.handle("agent:update-cli", async (_event, provider, targetVersion) => {
    if (!PROVIDERS.includes(provider)) throw new Error("Unknown provider.");
    targetVersion ??= undefined;
    if (targetVersion !== undefined && !releaseVersion(targetVersion)) throw new Error("Invalid provider version.");
    if (cliUpdates.has(provider)) return cliUpdates.get(provider);
    const pending = (async () => {
      const result = await (options.runCliUpdate ?? runCliUpdate)(provider, {
        targetVersion,
        antigravity,
        onProgress: (progress) => {
          cliProgress.set(provider, progress);
          signalProgress();
          emit("agent:cli-progress", { provider, ...progress });
        },
      }).finally(() => {
        cliProgress.delete(provider);
        signalProgress();
      });
      agentCli.invalidate(provider);
      agentCliStatus.invalidate(provider);
      const status = await agentCliStatus();
      return { ...result, status: status[provider] };
    })();
    cliUpdates.set(provider, pending);
    try {
      return await pending;
    } finally {
      cliUpdates.delete(provider);
    }
  });

  commands.handle("agent:models", async (_event, scope) => {
    scope = await validateAccountScope(scope, true);
    return options.agentModels ? options.agentModels() : routing.services(scope).models();
  });
  return { readOpenChat, agentCliStatus };
}

function registerChatLifecycle({
  options,
  emit,
  commands,
  handlers,
  agentCli,
  agents,
  antigravity,
  background,
  chats,
  editProject,
  environmentReady,
  existingChat,
  heldState,
  linear,
  linearIssues,
  linkStore,
  mobileUploads,
  needsUserAt,
  projectName,
  readLinearIssue,
  routing,
  scopeStates,
  sentFromNotes,
  setupReview,
  states,
  track,
  turnDefaults,
  updateProject,
  worktreeSetups,
  terminals,
  artifacts,
  computerUseScreen,
  pageComments,
  advisorDelivery,
  advisors,
  btw,
  bugReports,
  canvasChatModes,
  chatSecrets,
  linkRuntime,
  linked,
  needsUserCount,
  routines,
  subchatEscalation,
  validateAccountScope,
}) {
  const { stopChat, respondPermission, noteHumanActed, answerQuestion, setPermissionMode } = registerChatControls({
    commands,
    agents,
    background,
    chats,
    editProject,
    existingChat,
    mobileUploads,
    scopeStates,
    setupReview,
    track,
    worktreeSetups,
    advisorDelivery,
    advisors,
    bugReports,
    canvasChatModes,
    chatSecrets,
    linked,
    subchatEscalation,
  });
  const { sendAsUser, linearIssueMessage, markIssueStarted } = registerChatSend({
    options,
    commands,
    background,
    chats,
    linear,
    linearIssues,
    readLinearIssue,
    scopeStates,
    sentFromNotes,
    track,
    turnDefaults,
    noteHumanActed,
    keepRunChat: (...args) => keepRunChat(...args),
    reopenDoneChat: (...args) => reopenDoneChat(...args),
    wakeSnoozedChat: (...args) => wakeSnoozedChat(...args),
  });
  const retirement = createChatRetirement({
    agents,
    background,
    chats,
    scopeStates,
    track,
    worktreeSetups,
    terminals,
    artifacts,
    computerUseScreen,
    pageComments,
    advisorDelivery,
    advisors,
    btw,
    bugReports,
    chatSecrets,
    linked,
    routines,
    stopChat,
  });
  const { archiveChat, moveRunChats, archiveRunChat, keepRunChat, patchChat, reopenDoneChat, wakeSnoozedChat, archiveDoneChat } = registerChatRetire({
    commands,
    handlers,
    chats,
    editProject,
    environmentReady,
    existingChat,
    heldState,
    linkStore,
    needsUserAt,
    scopeStates,
    states,
    linkRuntime,
    needsUserCount,
    routines,
    retirement,
  });
  const { readOpenChat, agentCliStatus } = registerChatStatus({
    options,
    emit,
    commands,
    agentCli,
    antigravity,
    background,
    chats,
    environmentReady,
    projectName,
    routing,
    scopeStates,
    track,
    updateProject,
    advisors,
    linkRuntime,
    validateAccountScope,
  });
  return {
    stopChat,
    respondPermission,
    answerQuestion,
    setPermissionMode,
    sendAsUser,
    linearIssueMessage,
    markIssueStarted,
    archiveChat,
    moveRunChats,
    retireChat: retirement.retireChat,
    releaseChat: retirement.releaseChat,
    archiveRunChat,
    keepRunChat,
    patchChat,
    wakeSnoozedChat,
    archiveDoneChat,
    readOpenChat,
    agentCliStatus,
  };
}

module.exports = { registerChatLifecycle, createChatRetirement };
