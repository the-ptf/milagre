const { queueStatus } = require("@milagre/shared/queued-messages");
const { lastUserModel } = require("@milagre/shared/agent-runs");
const { canEditMessage, messagesAfter } = require("@milagre/shared/message-edit");
const { z } = require("zod");

function createChatBranchTools({ host, chatInput, read, act, mutate, caller }) {
  return [
    mutate(
      "chat_fork",
      "Copy a Chat through messageId (or its latest saved message) into an independent Chat in the same Worktree. Files stay as they are. Reuse requestId on retry.",
      "create",
      { ...chatInput, messageId: z.number().int().positive().optional() },
      (args, operationId, assertActive) => host.forkChat(args, operationId, assertActive),
    ),
    act(
      "chat_btw",
      "Ask an ephemeral read-only side question using this Chat's context, without steering it or adding messages to its transcript. Read the answer with chat_btw_read.",
      "start",
      {
        ...chatInput,
        prompt: z.string().trim().min(1).max(100000),
        provider: z.enum(["claude", "codex", "antigravity", "kiro", "grok", "pi"]).optional(),
        model: z.string().min(1).max(300).optional(),
      },
      (args) => host.sideQuestion(args, "ask"),
    ),
    act(
      "chat_edit",
      "Edit one of the user's own typed messages in another Chat (messageId from chat_read) and run that Chat again from it, as Edit message does: a running turn stops, every message after it is removed, the agent's session rewinds to just before it, and undoFiles (default true) puts back the files the removed turns changed, keeping ones edited since. Its images and files stay. Unless this Chat runs in Full permission, the user approves first: wait for the result, don't end the turn or move on.",
      "start",
      { ...chatInput, messageId: z.number().int().positive(), prompt: z.string().trim().min(1).max(100000), undoFiles: z.boolean().default(true) },
      (args) => host.editMessage(args, caller),
    ),
    read("chat_btw_read", "Read the latest ephemeral side question's answer and status.", chatInput, (args) => host.sideQuestion(args, "read")),
    act(
      "chat_btw_stop",
      "Stop the side question without stopping the main Chat. clear also forgets the answer.",
      "start",
      { ...chatInput, clear: z.boolean().optional() },
      (args) => host.sideQuestion(args, "stop"),
    ),
  ];
}

function createChatBranchHost({ chat, invoke, assertNotWaiting, callerMode, confirm, chats, scopeStates }) {
  return {
    async editMessage({ projectPath, chatId, messageId, prompt, undoFiles = true }, caller) {
      const { state, session } = await chat(projectPath, chatId);
      if (caller === chatId) throw Error("A Chat can't edit its own messages.");
      assertNotWaiting(state, caller, chatId, "edit");
      const messages = (await scopeStates.chatMessages(projectPath, [session.id])).filter((message) => message.session_id === session.id);
      const message = messages.find((item) => item.id === messageId);
      if (!canEditMessage(message)) throw Error("Only the user's own typed messages can be edited. chat_read lists their ids.");
      const removed = messagesAfter(messages, messageId);
      if (caller && (await callerMode(caller)) !== "full")
        await confirm(caller, {
          title: `Edit a message in "${session.title || session.generatedTitle || "Chat"}"?`,
          description: `${removed ? `The ${removed} ${removed === 1 ? "message" : "messages"} after it are removed${undoFiles ? " and the files they changed go back" : ""}, then` : "Then"} the Chat runs again from the edited message.`,
          detail: prompt,
        });
      const latest = chats.turnSettings(chatId) ?? {};
      const model = latest.model || message.model || lastUserModel({ ...state, messages }, session.id);
      if (!model) throw Error("Choose a model for this Chat before editing it");
      const result = await invoke("chat:edit", [
        {
          ...latest,
          projectPath,
          sessionId: session.id,
          worktreeId: session.worktree_id,
          messageId,
          body: prompt,
          prompt,
          images: [],
          files: [],
          keepAttachments: true,
          provider: session.provider ?? latest.provider ?? "claude",
          model,
          permissionMode: latest.permissionMode ?? session.permissionMode ?? "ask",
          undoFiles: undoFiles ? {} : null,
        },
      ]);
      return { chatId: `${projectPath}#${result.sessionId}`, removed };
    },
    async forkChat({ projectPath, chatId, messageId }, operationId, assertActive) {
      const { session } = await chat(projectPath, chatId);
      assertActive();
      const result = await invoke("chat:fork", [projectPath, session.id, { messageId, operationId, assertActive }]);
      return { chatId: `${projectPath}#${result.sessionId}` };
    },
    async sideQuestion({ projectPath, chatId, prompt, provider, model, clear }, method) {
      await chat(projectPath, chatId);
      return method === "ask" ? invoke("chat:btw", [{ chatId, prompt, provider, model }]) : invoke(`chat:btw-${method}`, [chatId, { clear }]);
    },
  };
}

const queue = (chatId, session, running) =>
  session.queued?.length
    ? {
        queue: {
          status: queueStatus({ count: session.queued.length, held: Boolean(session.queueHeld), running: running }),
          messages: session.queued.map(({ id, body, provider, model, queuedAt }) => ({ id, body, provider, model, queuedAt })),
        },
      }
    : {};

module.exports = { createChatBranchTools, createChatBranchHost, queue };
