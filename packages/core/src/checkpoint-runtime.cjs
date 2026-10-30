const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { createCheckpoints } = require("./checkpoints.cjs");
const { checkpointRestoreText } = require("@milagre/shared/checkpoint-restore");

/** What the agent is told with its next turn after a restore wrote files: the line in the Chat is only for the user. */
function agentRestoreNote(context) {
  const files = `${context.restored} ${context.restored === 1 ? "file" : "files"}`;
  const what = context.redo
    ? `redid this Chat's changes to ${files} with Redo (putting back what Undo changes had undone)`
    : `undid this Chat's changes to ${files} with Undo changes`;
  return `<milagre_note>The user ${what}. Re-read files before editing.</milagre_note>`;
}

/**
 * `note` writes a line in the Chat after a restore wrote files, so its Redo stays in the transcript across restarts.
 * `tell(chatId, text)` queues the same news for the Chat's agent, which the line alone never reaches.
 */
function registerCheckpoints(commands, { directory, states, busy, ready, note = async () => {}, tell = () => {} }) {
  const preparing = new Set();
  async function rootsFor(chatId) {
    const scope = projectOfKey(chatId),
      id = sessionIdFromKey(chatId);
    if (typeof chatId !== "string" || !scope || !Number.isSafeInteger(id) || !states.has(scope)) throw new Error("Open an existing Chat to use checkpoints");
    const context = await states.executionContext(scope, id);
    if (!context.cwd) throw new Error("The Chat has no Worktree");
    return context.workspaceRoots ?? [context.cwd];
  }
  const store = createCheckpoints({
    directory,
    validateRoots: async (chatId, roots) => {
      const current = await rootsFor(chatId);
      if (JSON.stringify(current.toSorted()) !== JSON.stringify(roots.toSorted())) throw new Error("The checkpoint belongs to a different Worktree");
    },
    assertIdle: async (roots) => {
      for (const scope of states.projects()) {
        const state = await states.get(scope);
        for (const session of Object.values(state.sessions)) {
          if (!busy(`${scope}#${session.id}`) && !preparing.has(`${scope}#${session.id}`)) continue;
          const worktrees = session.worktrees?.map((member) => member.worktreePath) ?? [state.worktrees[session.worktree_id]?.path];
          if (worktrees.some((root) => roots.includes(root))) throw new Error("Wait for running Chats in this Worktree to finish");
        }
      }
    },
  });
  for (const method of ["list", "preview", "restore"])
    commands.handle(`checkpoint:${method}`, async (_context, request = {}) => {
      await ready();
      await rootsFor(request.chatId);
      if (method === "list") return store.list(request.chatId);
      if (method === "preview") return store.preview(request.chatId, request.id);
      const result = await store.restore(request.chatId, request);
      if (result.restored > 0 && result.recoveryId) {
        const context = {
          kind: "checkpoint-restore",
          checkpointId: result.checkpointId,
          recoveryId: result.recoveryId,
          restored: result.restored,
          kept: result.kept,
          redo: result.redo,
        };
        await note(request.chatId, { body: checkpointRestoreText(context), context }).catch((error) => console.warn("Checkpoint note failed:", error.message));
        tell(request.chatId, agentRestoreNote(context));
      }
      return result;
    });
  return {
    begin: async (request) => {
      preparing.add(request.chatId);
      try {
        await ready();
        return await store.begin({
          chatId: request.chatId,
          roots: await rootsFor(request.chatId),
          permissionMode: request.permissionMode,
          messageId: request.messageId,
          prompt: request.body,
        });
      } finally {
        preparing.delete(request.chatId);
      }
    },
    finish: (chatId) => store.finish(chatId),
    discard: (chatId, messageId) => store.discard(chatId, messageId),
  };
}
module.exports = { agentRestoreNote, registerCheckpoints };
