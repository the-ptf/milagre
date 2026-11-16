const { chatKey } = require("@milagre/shared/agent-runs");
const { lastTurnProvider } = require("@milagre/shared/handoff");
const { cutTranscript, renderTranscript } = require("./handover.cjs");

async function forkChat(host, projectPath, sessionId, { messageId, operationId, assertActive } = {}) {
  let forkedId;
  if (messageId != null && (!Number.isSafeInteger(messageId) || messageId < 1)) throw new Error("Choose an existing message to fork from.");
  const { state } = await host.states.update(
    projectPath,
    (latest) => {
      assertActive?.();
      if (operationId) {
        const existing = Object.values(latest.sessions).find((session) => session.localMcpOperations?.includes(operationId));
        if (existing) {
          forkedId = existing.id;
          return latest;
        }
      }
      const session = latest.sessions[sessionId];
      if (!session) throw new Error("That chat is no longer in the project.");
      if (session.formerWorktree) throw new Error("This Chat's Worktree is unavailable.");
      if (session.archived) throw new Error("This Chat is archived.");
      const worktree = session.workspacePath ? { path: session.workspacePath } : latest.worktrees?.[session.worktree_id];
      if (!worktree) throw new Error("That worktree is no longer in the project.");
      if (session.readOnlyReason) throw new Error(session.readOnlyReason);
      host.assertWritable(projectPath, latest, session, worktree);
      if (worktree.sharedChat) throw new Error("This Worktree belongs to a shared Link Chat. Open its Link instead.");
      const all = latest.messages.filter((item) => item.session_id === sessionId);
      let picked = all;
      if (messageId != null) {
        const index = all.findIndex((item) => item.id === messageId);
        if (index === -1) throw new Error("That message is no longer in the chat.");
        picked = all.slice(0, index + 1);
      }
      const chatId = chatKey(projectPath, sessionId);
      const atHead = picked.length > 0 && picked.length === all.length && !host.runs[chatId] && !host.preparing.has(chatId) && !host.startingTurns.has(chatId);
      const newSessionId = latest.next_id;
      let nextId = newSessionId + 1;
      const clonedMessages = picked.map((item) => {
        const { clientMessageId: _clientId, operationId: _opId, ...rest } = structuredClone(item);
        return { ...rest, id: nextId++, session_id: newSessionId };
      });
      clonedMessages.push({
        id: nextId++,
        session_id: newSessionId,
        role: "assistant",
        body: "",
        context: { kind: "chat-fork", from: chatId, title: session.title || session.generatedTitle || "Chat", ...(messageId != null ? { messageId } : {}) },
      });
      const provider = lastTurnProvider(latest, sessionId) ?? session.provider;
      const forkedSession = {
        id: newSessionId,
        ...(operationId ? { localMcpOperations: [operationId] } : {}),
        ...(session.worktree_id !== undefined ? { worktree_id: session.worktree_id } : {}),
        ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
        ...(session.worktrees ? { worktrees: session.worktrees.map((member) => ({ ...member })) } : {}),
        agent_name: session.agent_name,
        status: "Created",
        ...(provider ? { provider } : {}),
        ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
        title: `${session.title || session.generatedTitle || "Chat"} (fork)`,
        ...(session.plan && atHead ? { plan: structuredClone(session.plan) } : {}),
        forkedFrom: { sessionId, ...(messageId != null ? { messageId } : {}) },
      };
      forkedId = newSessionId;
      return {
        ...latest,
        next_id: nextId,
        sessions: { ...latest.sessions, [newSessionId]: forkedSession },
        messages: [...latest.messages, ...clonedMessages],
      };
    },
    { chats: [sessionId] },
  );
  await host.states.flush(projectPath);
  host.broadcast(projectPath, state);
  return { sessionId: forkedId };
}

function freshChatBrief(state, session, { steering, handoff, firstMessage, brief }) {
  if (!session.forkedFrom || steering || handoff || firstMessage || session.native_session_id || brief !== undefined) return brief;
  const transcript = cutTranscript(renderTranscript(state, session.id));
  return transcript.trim() ? transcript : brief;
}

module.exports = { forkChat, freshChatBrief };
