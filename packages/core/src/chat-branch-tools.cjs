const { queueStatus } = require("@milagre/shared/queued-messages");
const { z } = require("zod");

function createChatBranchTools({ host, chatInput, read, act, mutate }) {
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
        provider: z.enum(["claude", "codex", "antigravity", "kiro"]).optional(),
        model: z.string().min(1).max(300).optional(),
      },
      (args) => host.sideQuestion(args, "ask"),
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

function createChatBranchHost({ chat, invoke }) {
  return {
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
