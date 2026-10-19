const { z } = require("zod");
const { isLinkScopeKey, scopeFromKey } = require("@milagre/shared/chat-scopes");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");

/**
 * The tool a shared Link Chat's agent calls before its first change in a Project: the Chat's Worktree there, made on
 * demand so a Chat that changes one Project creates no branch or folder in the others. `create({ chatId, linkId,
 * sessionId, project })` resolves to `{ member, created }` once the Worktree and its setup are ready.
 */
function linkWorktreeToolDefinitions(chatId, create) {
  if (!isLinkScopeKey(projectOfKey(chatId))) return [];
  return [
    {
      name: "link_worktree_create",
      description:
        "Create this shared Chat's Worktree and branch in one Project of its Link, before the first change there. Returns the path to edit. Only call it for a Project you are going to change; one that already has a Worktree returns it.",
      input: { project: z.string().trim().min(1).max(4096).describe("The Project's name, as the Chat's instructions list it.") },
      readOnly: false,
      strict: true,
      run: async ({ project }) => {
        const { member, created, setupNote } = await create({
          chatId,
          linkId: scopeFromKey(projectOfKey(chatId)).linkId,
          sessionId: sessionIdFromKey(chatId),
          project,
        });
        return JSON.stringify({
          project: member.projectName,
          worktreePath: member.worktreePath,
          branch: member.branch,
          base: member.base,
          alias: member.alias,
          created,
          ...(setupNote ? { setup: setupNote } : {}),
          note: "Make every change in this Project under worktreePath, and run its Git commands there.",
        });
      },
    },
  ];
}

module.exports = { linkWorktreeToolDefinitions };
