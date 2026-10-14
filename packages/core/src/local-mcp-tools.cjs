const { z } = require("zod");
const projectInput = { projectPath: z.string().min(1).max(8192) };
const requestId = z.string().min(1).max(128);

function managementToolGroups({ host, operations }) {
  return ["projects", "worktrees", "chats"].map((id) => ({
    id,
    enabled: () => true,
    tools: ({ scope, assertActive, connectionId }) => {
      const permit = async (projectPath) => {
        assertActive();
        if (!scope.projectPaths.includes(projectPath)) throw Error("Project is outside this connection's scope");
        await host.validateProject(projectPath);
        assertActive();
      };
      const read = (name, description, input, run) => ({
        name,
        description,
        input,
        readOnly: true,
        capability: "read",
        run: async (args) => {
          if (args.projectPath) await permit(args.projectPath);
          const result = await run(args);
          assertActive();
          return JSON.stringify(result);
        },
      });
      const mutate = (name, description, capability, input, execute) => ({
        name,
        description,
        input: { ...input, requestId },
        readOnly: false,
        capability,
        run: async ({ requestId: requested, ...args }) => {
          await permit(args.projectPath);
          const result = await operations.run(
            connectionId,
            requested,
            name,
            args,
            async (operationId) => {
              assertActive();
              return execute(args, operationId, assertActive);
            },
            async (operationId) => {
              assertActive();
              return host.reconcile(name, args, operationId);
            },
          );
          assertActive();
          return JSON.stringify(result);
        },
      });
      if (id === "projects")
        return [
          read("project_list", "List only the Projects granted to this connection.", {}, async () =>
            (await host.projects()).filter((item) => scope.projectPaths.includes(item.path)).map(({ id, path, name }) => ({ id, path, name })),
          ),
        ];
      if (id === "worktrees")
        return [
          read("worktree_list", "List registered Worktrees in an allowed Project.", projectInput, (args) => host.worktrees(args.projectPath)),
          mutate(
            "worktree_create",
            "Create and register a Worktree using Milagre's normal file copy and setup. Reuse requestId when retrying the same creation.",
            "create",
            { ...projectInput, baseBranch: z.string().min(1).max(1024), prompt: z.string().max(10000).default("") },
            (args, operationId, assertActive) => host.createWorktree(args, operationId, assertActive),
          ),
        ];
      const chatInput = { ...projectInput, chatId: z.string().min(1).max(8192) };
      return [
        read(
          "chat_list",
          "List Chats and current progress in an allowed Project.",
          { ...projectInput, worktreeId: z.number().int().positive().optional() },
          (args) => host.chats(args),
        ),
        read(
          "chat_read",
          "Read a Chat's recent messages and current progress. Does not answer approvals or change permissions.",
          { ...chatInput, limit: z.number().int().min(1).max(100).default(30) },
          (args) => host.readChat(args),
        ),
        mutate(
          "chat_create",
          "Open a Chat in a registered Worktree, reusing its empty Chat as the Milagre UI does. Reuse requestId on retry.",
          "create",
          { ...projectInput, worktreeId: z.number().int().positive() },
          (args, operationId, assertActive) => host.createChat(args, operationId, assertActive),
        ),
        mutate(
          "chat_start",
          "Send a task to an existing Chat through Milagre. Keeps its permission mode; a Chat with no running agent takes the calling Chat's mode. Reuse requestId on retry.",
          "start",
          {
            ...chatInput,
            prompt: z.string().trim().min(1).max(100000),
            provider: z.enum(["claude", "codex", "antigravity"]).optional(),
            model: z.string().min(1).max(300).optional(),
          },
          (args, operationId, assertActive) =>
            host.startChat(args, operationId, assertActive, connectionId.startsWith("agent:") ? connectionId.slice(6) : undefined),
        ),
      ];
    },
  }));
}
module.exports = { managementToolGroups };
