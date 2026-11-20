const { z } = require("zod");
const { TASK_BLOCKED_MAX, TASK_BLOCKED_TOOL, taskBlockedReason } = require("@milagre/shared/orchestrator");

/** The milagre tools only an Orchestrator task Chat's agent gets, and the block they leave until its next turn starts. */
function createTaskTools({ taskOf, setBlocked, now = Date.now }) {
  return {
    definitions(chatId) {
      if (!taskOf(chatId)) return [];
      return [
        {
          name: TASK_BLOCKED_TOOL,
          description:
            "This Chat is an Orchestrator task. Call this before you end your turn when the work can't go on without the owner: an MCP server that needs sign-in, a missing credential or permission, an error only they can fix, or a decision only they can make. The task then shows in Needs you on the board with this reason instead of finished. It clears when the next turn starts.",
          input: {
            reason: z
              .string()
              .min(1)
              .max(TASK_BLOCKED_MAX)
              .describe("What the owner must do, in one line, e.g. 'Sign in to the resend MCP server with /mcp, then reply continue.'"),
          },
          readOnly: false,
          run: async ({ reason }) => {
            const line = taskBlockedReason(reason);
            if (!line) throw new Error("Say what the owner must do.");
            await setBlocked(chatId, { reason: line, at: now() });
            return "The task waits in Needs you with this reason. End your turn now and tell the owner the same in your reply.";
          },
        },
      ];
    },
    observe(chatId, event) {
      if (event.type !== "turn-started" || !taskOf(chatId)?.blocked) return;
      void Promise.resolve(setBlocked(chatId, null)).catch((error) => console.warn("[orchestrator] couldn't clear a task's block:", error.message));
    },
  };
}

module.exports = { createTaskTools };
