const { z } = require("zod");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { isLinkScopeKey, scopeFromKey } = require("@milagre/shared/chat-scopes");

/**
 * A shared Chat's `link_worktree` tool: its Worktree in one member Project, made the first time the agent is about to
 * change that Project. `prepare(linkId, sessionId, project)` makes it (link-runtime.cjs); `extend(chatId, path)` lets the
 * running turn edit there at once.
 */
function linkWorktreeToolDefinitions(chatId, { prepare, extend }) {
  const owner = projectOfKey(chatId);
  if (!isLinkScopeKey(owner)) return [];
  return [
    {
      name: "link_worktree",
      description:
        "Make this shared Chat's Worktree in one of its Link's Projects, or get the one it already has. Call it before you change any file in that Project, and make every change in the path it returns, never in the Project's main checkout. Projects you only read need none.",
      input: { project: z.string().describe("The Project's name, as your instructions list it.") },
      run: async ({ project }) => {
        const { member, created } = await prepare(scopeFromKey(owner).linkId, sessionIdFromKey(chatId), project);
        extend(chatId, member.worktreePath);
        return [
          `${created ? "Made" : "Already had"} this Chat's Worktree for ${member.projectName}: ${member.worktreePath}`,
          `Branch: ${member.branch}. It is also ${member.alias} in the workspace folder.`,
          `Make every change to ${member.projectName} there and run its Git commands there. Don't edit its main checkout (${member.projectPath}).`,
        ].join("\n");
      },
    },
  ];
}

module.exports = { linkWorktreeToolDefinitions };
