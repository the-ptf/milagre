const { chatKey, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { backgroundBusyMessage, processWork } = require("@milagre/shared/chat-activity");
const { canEditMessage, messagesAfter } = require("@milagre/shared/message-edit");
const { rewindPlan } = require("../agents/message-edit.cjs");
const { queuedImages } = require("../agents/chat-host.cjs");

const STOP_TIMEOUT_MS = 30_000;
const LEFT_FILES_NOTE =
  "<milagre_note>The user edited an earlier message, so the turns after it were removed from this conversation. Files those turns changed were not all undone: re-read files before editing them.</milagre_note>";

/**
 * `chat:edit`: replace an earlier typed message and run the Chat again from it. A running turn stops first, the files the
 * removed turns changed go back when asked, and the provider's session rewinds to just before the message (Claude forks at
 * the entry before its prompt, Codex reverts the thread before its turn). Other providers, older messages and a refused
 * rewind continue in a new session that is handed the conversation up to the edit.
 */
function registerChatEdit({ commands, chats, agents, scopeStates, checkpoints, stopChat, sendAsUser, tell, wait = waitFor }) {
  const pending = new Map();

  async function editAsUser(request, fallback = null) {
    const { projectPath, sessionId, messageId } = request ?? {};
    if (!scopeStates.has(projectPath)) throw new Error("Open the project before editing its chats.");
    if (!Number.isSafeInteger(sessionId) || !Number.isSafeInteger(messageId)) throw new Error("Choose a message of an existing Chat to edit.");
    const chatId = chatKey(projectPath, sessionId);
    const state = await scopeStates.get(projectPath);
    const session = state.sessions[sessionId];
    if (!session) throw new Error("That chat is no longer in the project.");
    if (session.readOnlyReason) throw new Error(session.readOnlyReason);
    if (session.archived) throw new Error("Unarchive this Chat before editing its messages.");
    const edited = (await scopeStates.chatMessages(projectPath, [sessionId])).find((message) => message.id === messageId);
    if (!canEditMessage(edited)) throw new Error("That message can't be edited. Only your own typed messages can.");
    const background = Math.max(agents.backgroundWork(chatId), processWork(session).length);
    if (background) throw new Error(backgroundBusyMessage("edit", background));
    if (busy(chatId)) {
      await stopChat(chatId);
      await wait(() => !busy(chatId), STOP_TIMEOUT_MS, "The running turn didn't stop. Try again once it has.");
    }
    const files = fallback ? null : await undoFiles(chatId, messageId, request.undoFiles);
    const latest = await scopeStates.get(projectPath);
    const current = latest.sessions[sessionId];
    const messages = (await scopeStates.chatMessages(projectPath, [sessionId])).filter((message) => message.session_id === sessionId);
    if (!messages.some((message) => message.id === messageId)) throw new Error("That message is no longer in the chat.");
    const plan = fallback || request.provider !== current.provider ? { fresh: true } : rewindPlan(current, messages, messageId);
    const before = messages.findIndex((message) => message.id === messageId) > 0;
    const context = fallback?.context ?? {
      kind: "message-edit",
      edited: messageId,
      removed: messagesAfter(messages, messageId),
      ...(files?.restored ? { restored: files.restored, kept: files.kept, recoveryId: files.recoveryId } : {}),
      ...(plan.fresh && before && current.provider === request.provider ? { newSession: true } : {}),
    };
    if (files?.left) tell(chatId, LEFT_FILES_NOTE);
    const original = messages.find((message) => message.id === messageId);
    const {
      messageId: _messageId,
      undoFiles: _undo,
      keepAttachments,
      prAction: _pr,
      linearIssue: _linear,
      githubIssue: _github,
      compact: _compact,
      delivery: _delivery,
      ...send
    } = request;
    const attachments = keepAttachments ? { images: await queuedImages(original.images ?? []), files: original.files ?? [] } : {};
    if (plan.fresh) pending.delete(chatId);
    else pending.set(chatId, { request, context });
    try {
      return await sendAsUser({
        ...send,
        ...attachments,
        edit: { messageId, rewind: plan, fresh: Boolean(plan.fresh), context, ...(fallback ? { replaces: fallback.replaces } : {}) },
      });
    } catch (error) {
      pending.delete(chatId);
      throw error;
    }
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
    const sessionId = sessionIdFromKey(chatId);
    await wait(() => !busy(chatId), STOP_TIMEOUT_MS, "The failed turn didn't end.");
    const messages = (await scopeStates.chatMessages(projectPath, [sessionId])).filter((message) => message.session_id === sessionId);
    const divider = messages.findLast((message) => message.context?.kind === "message-edit");
    const message = divider && messages.find((item) => item.id > divider.id && item.role === "user");
    if (!message) return;
    const { images: _images, files: _files, ...request } = record.request;
    await editAsUser(
      { ...request, messageId: message.id, keepAttachments: true, clientMessageId: undefined },
      { replaces: divider.id, context: { ...divider.context, newSession: true } },
    );
  }

  commands.handle("chat:edit", (_event, request) => editAsUser(request));
  return { editAsUser, observe };
}

async function waitFor(condition, timeoutMs, message) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

module.exports = { registerChatEdit };
