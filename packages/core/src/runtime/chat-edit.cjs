const { chatKey, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { backgroundBusyMessage, processWork } = require("@milagre/shared/chat-activity");
const { canEditMessage, messagesAfter, messageEditText } = require("@milagre/shared/message-edit");
const { rewindChat, rewindPlan, nativeTurn } = require("../agents/message-edit.cjs");
const { queuedImages } = require("../agents/chat-host.cjs");

const STOP_TIMEOUT_MS = 30_000;
const LEFT_FILES_NOTE =
  "<milagre_note>The user edited an earlier message, so the turns after it were removed from this conversation. Files those turns changed were not all undone: re-read files before editing them.</milagre_note>";

/**
 * `chat:edit`: replace an earlier typed message and run the Chat again from it. A running turn stops first, the files the
 * removed turns changed go back when asked, the messages from the edited one on are replaced by an Edited divider, and the
 * provider's session rewinds to just before the message (Claude forks at the entry before its prompt, Codex reverts the
 * thread before its turn). Other providers, older messages and a refused rewind continue in a new session that is handed
 * the conversation up to the edit.
 */
function registerChatEdit({ commands, chats, agents, checkpoints, stopChat, sendAsUser, agentNotes, wait = waitFor }) {
  const states = chats.states;
  const pending = new Map();

  async function editAsUser(request, fallback = null) {
    const { projectPath, sessionId, messageId } = request ?? {};
    if (!states.has(projectPath)) throw new Error("Open the project before editing its chats.");
    if (!Number.isSafeInteger(sessionId) || !Number.isSafeInteger(messageId)) throw new Error("Choose a message of an existing Chat to edit.");
    const chatId = chatKey(projectPath, sessionId);
    const session = (await states.get(projectPath)).sessions[sessionId];
    if (!session) throw new Error("That chat is no longer in the project.");
    if (session.readOnlyReason) throw new Error(session.readOnlyReason);
    if (session.archived) throw new Error("Unarchive this Chat before editing its messages.");
    if (!canEditMessage((await chatMessages(projectPath, sessionId)).find((message) => message.id === messageId)))
      throw new Error("That message can't be edited. Only your own typed messages can.");
    const background = Math.max(agents.backgroundWork(chatId), processWork(session).length);
    if (background) throw new Error(backgroundBusyMessage("edit", background));
    if (busy(chatId)) {
      await stopChat(chatId);
      await wait(() => !busy(chatId), STOP_TIMEOUT_MS, "The running turn didn't stop. Try again once it has.");
    }
    const files = fallback ? null : await undoFiles(chatId, messageId, request.undoFiles);
    const current = (await states.get(projectPath)).sessions[sessionId];
    const messages = await chatMessages(projectPath, sessionId);
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) throw new Error("That message is no longer in the chat.");
    const original = messages[index];
    const plan = fallback || request.provider !== current.provider ? { fresh: true } : rewindPlan(current, messages, messageId);
    const context = fallback?.context ?? {
      kind: "message-edit",
      edited: messageId,
      removed: messagesAfter(messages, messageId),
      ...(files?.restored ? { restored: files.restored, kept: files.kept, recoveryId: files.recoveryId } : {}),
      ...(plan.fresh && index > 0 && current.provider === request.provider ? { newSession: true } : {}),
    };
    if (files?.left) agentNotes.set(chatId, [...(agentNotes.get(chatId) ?? []), LEFT_FILES_NOTE]);
    const attachments = request.keepAttachments ? { images: await queuedImages(original.images ?? []), files: original.files ?? [] } : {};
    const undo = await rewind(chatId, { messageId, fresh: Boolean(plan.fresh), replaces: fallback?.replaces, context });
    const {
      messageId: _id,
      undoFiles: _undo,
      keepAttachments: _keep,
      prAction: _pr,
      linearIssue: _linear,
      githubIssue: _github,
      compact: _c,
      ...send
    } = request;
    if (plan.fresh) pending.delete(chatId);
    else pending.set(chatId, { request, context });
    try {
      return await sendAsUser({ ...send, delivery: undefined, ...attachments, rewind: plan });
    } catch (error) {
      pending.delete(chatId);
      await undo().catch((failure) => console.warn("Milagre couldn't put back the messages of an edit that failed to send:", failure.message));
      throw error;
    }
  }

  // The Chat without the edited message and everything after it, ending in the Edited divider the new message follows.
  async function rewind(chatId, edit) {
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    let before;
    let dropped = [];
    let note;
    const { state } = await states.update(
      projectPath,
      (latest) => {
        if (chats.runs[chatId] || chats.preparing.has(chatId) || chats.startingTurns.has(chatId))
          throw Object.assign(new Error("The chat is busy."), { chatBusy: true });
        before = latest.sessions[sessionId];
        const rewound = rewindChat(latest, before, edit);
        dropped = rewound.dropped;
        note = { id: latest.next_id, session_id: sessionId, body: messageEditText(edit.context), role: "assistant", context: edit.context };
        return { ...rewound.state, next_id: note.id + 1, messages: [...rewound.state.messages, note] };
      },
      { chats: [sessionId] },
    );
    chats.broadcast(projectPath, state);
    return async () => {
      const restored = await states.update(
        projectPath,
        (latest) => {
          const kept = latest.messages.filter((message) => message.id !== note.id);
          const back = dropped.filter((message) => !kept.some((item) => item.id === message.id));
          return { ...latest, sessions: { ...latest.sessions, [sessionId]: before }, messages: [...kept, ...back] };
        },
        { chats: [sessionId] },
      );
      chats.broadcast(projectPath, restored.state);
    };
  }

  async function chatMessages(projectPath, sessionId) {
    return (await states.chatMessages(projectPath, [sessionId])).filter((message) => message.session_id === sessionId);
  }

  function busy(chatId) {
    return chats.isBusy(chatId) || agents.isTurnActive(chatId) || checkpoints.capturing(chatId);
  }

  async function undoFiles(chatId, messageId, choice) {
    const preview = await checkpoints.rewind(chatId, messageId).catch((error) => {
      console.warn("Milagre couldn't read the files an edit would undo:", error.message);
      return null;
    });
    if (!preview?.files.length) return null;
    if (!choice) return { left: true };
    const decisions = Object.fromEntries(preview.files.map((file) => [file.key, choice.decisions?.[file.key] ?? (file.conflict ? "keep" : "restore")]));
    const result = await checkpoints.restore(chatId, { token: preview.token, decisions, approved: true });
    return { restored: result.restored, kept: result.kept, recoveryId: result.recoveryId ?? undefined, left: result.kept > 0 };
  }

  // Each typed message keeps its place in the provider's session (Claude's prompt uuid, Codex's turn id) for a later edit.
  async function started(request, result) {
    const native = request.messageId != null && nativeTurn(request.provider, result);
    if (!native) return result;
    const projectPath = projectOfKey(request.chatId);
    await states
      .update(
        projectPath,
        (latest) => {
          const index = latest.messages.findIndex((message) => message.id === request.messageId);
          if (index === -1) return latest;
          const messages = latest.messages.slice();
          messages[index] = { ...messages[index], native };
          return { ...latest, messages };
        },
        { chats: [sessionIdFromKey(request.chatId)] },
      )
      .catch((error) => console.warn("Milagre couldn't keep a message's place in the agent's session:", error.message));
    return result;
  }

  // A provider that refused to rewind ran nothing: the edit runs again in a new session, replacing its divider and failed reply.
  function observe(chatId, event) {
    if (!["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type)) return;
    const record = pending.get(chatId);
    pending.delete(chatId);
    if (!record || event.type !== "turn-failed" || !event.rewindFailed) return;
    void retry(chatId, record).catch((error) => console.warn("Milagre couldn't continue an edited message in a new session:", error.message));
  }

  async function retry(chatId, record) {
    const projectPath = projectOfKey(chatId);
    await wait(() => !busy(chatId), STOP_TIMEOUT_MS, "The failed turn didn't end.");
    const messages = await chatMessages(projectPath, sessionIdFromKey(chatId));
    const divider = messages.findLast((message) => message.context?.kind === "message-edit");
    const message = divider && messages.find((item) => item.id > divider.id && item.role === "user");
    if (!message) return;
    const { images: _images, files: _files, clientMessageId: _client, ...request } = record.request;
    await editAsUser({ ...request, messageId: message.id, keepAttachments: true }, { replaces: divider.id, context: { ...divider.context, newSession: true } });
  }

  commands.handle("chat:edit", (_event, request) => editAsUser(request));
  return { editAsUser, observe, started };
}

async function waitFor(condition, timeoutMs, message) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

module.exports = { registerChatEdit };
