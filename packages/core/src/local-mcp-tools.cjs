const { z } = require("zod");
const projectInput = { projectPath: z.string().min(1).max(8192) };
const requestId = z.string().min(1).max(128);
const permissionMode = z.enum(["ask", "auto", "full"]);
const callerOf = (connectionId) => (connectionId.startsWith("agent:") ? connectionId.slice(6) : undefined);
const inProjectScope = (scope, projectPath) => scope.projectPaths === "*" || scope.projectPaths.includes(projectPath);

function managementToolGroups({ host, operations, grantChatProject = () => {} }) {
  return ["projects", "worktrees", "chats"].map((id) => ({
    id,
    enabled: () => true,
    tools: ({ scope, currentScope = () => scope, assertActive, connectionId, connectionLabel }) => {
      const caller = callerOf(connectionId);
      const permit = async (projectPath) => {
        assertActive();
        if (inProjectScope(currentScope(), projectPath)) {
          await host.validateProject(projectPath);
          assertActive();
          return;
        }
        if (!caller || !host.requestProjectScope)
          throw Error("Project is outside this connection's scope. Grant access to it (or select All Projects) in Milagre Settings > Milagre.");
        await host.requestProjectScope(caller, projectPath, (granted) => grantChatProject(caller, granted));
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
      // A write with no retry journal: stopping, switching and answering are safe to repeat or meaningless to replay.
      const act = (name, description, capability, input, execute) => ({
        name,
        description,
        input,
        readOnly: false,
        capability,
        run: async (args) => {
          await permit(args.projectPath);
          const result = await execute(args);
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
          read(
            "project_accounts",
            "Show the saved provider Accounts and the effective next-turn Account for a Project. Accounts are shared by all its Chats; running turns keep their existing Account. Returns public identities and status, never credentials.",
            { ...projectInput, refresh: z.boolean().default(false) },
            (args) => host.projectAccounts(args),
          ),
          act(
            "project_set_account",
            "Choose a saved provider Account for all Chats in a Project, as its model picker does. accountId null follows the computer default; use an ID from project_accounts to pin an Account. Running turns and background tasks keep their existing Account. This does not restart or send a message to any Chat, or change a named Link's independent Accounts.",
            "create",
            { ...projectInput, provider: z.enum(["claude", "codex", "antigravity", "kiro"]), accountId: z.string().min(1).max(128).nullable() },
            (args) => host.setProjectAccount(args, assertActive),
          ),
          read(
            "project_list",
            "List Projects in Milagre (with inScope for this Chat, or only the Projects granted to an outside connection).",
            {},
            async () => {
              const activeScope = currentScope();
              // The host also lists the Chats home (with a `kind`), which its tools accept but no Project list shows.
              const all = (await host.projects()).filter((item) => !item.kind);
              if (caller && activeScope?.capabilities?.includes("create"))
                return all.map(({ id: projectId, path, name }) => ({ id: projectId, path, name, inScope: inProjectScope(activeScope, path) }));
              return all.filter((item) => inProjectScope(activeScope, item.path)).map(({ id: projectId, path, name }) => ({ id: projectId, path, name }));
            },
          ),
          {
            name: "project_add",
            description:
              "Register a local Git repository folder in Milagre and grant this Chat access to it. Unless this Chat runs in Full permission, the user approves first on a card in this Chat: wait for its result, don't end the turn or move on.",
            input: projectInput,
            readOnly: false,
            capability: "create",
            run: async (args) => {
              assertActive();
              const result = await host.addProject(
                args,
                caller,
                (projectPath) => inProjectScope(currentScope(), projectPath),
                (granted) => grantChatProject(caller, granted),
              );
              assertActive();
              return JSON.stringify(result);
            },
          },
        ];
      if (id === "worktrees")
        return [
          read(
            "worktree_list",
            "List registered Worktrees in a Project. From a Chat, targeting another Project asks the user on a card first: wait for its result, don't end the turn or move on.",
            projectInput,
            (args) => host.worktrees(args.projectPath),
          ),
          mutate(
            "worktree_create",
            "Create and register a Worktree using Milagre's normal file copy and setup. From a Chat, targeting another Project asks the user on a card first: wait for its result. Reuse requestId when retrying the same creation.",
            "create",
            { ...projectInput, baseBranch: z.string().min(1).max(1024), prompt: z.string().max(10000).default("") },
            (args, operationId, assertActive) => host.createWorktree(args, operationId, assertActive),
          ),
          act(
            "worktree_link",
            "Link a Worktree to another Project's Worktree (its main Worktree when targetWorktreeId is omitted), as drawing a Link on the canvas does, so this Chat can read it and delegate to it. From an agent in Ask mode the user approves first. The call can wait minutes for the user's answer on that card: wait for its result, don't end the turn or move on.",
            "create",
            {
              ...projectInput,
              worktreeId: z.number().int().positive(),
              targetProjectPath: z.string().min(1).max(8192),
              targetWorktreeId: z.number().int().positive().optional(),
            },
            (args) => host.linkWorktrees(args, caller, (projectPath) => inProjectScope(currentScope(), projectPath)),
          ),
          act(
            "worktree_remove",
            "Remove a Worktree Milagre created, with its Chats, once its work is safe: nothing uncommitted, no commits off its base or upstream, no Chat running, and its Chats with messages archived (chat_update). Its milagre/ branch goes too when merged. Never the Worktree this Chat runs in. From an agent in Ask mode the user approves first; the call waits for that answer.",
            "create",
            { ...projectInput, worktreeId: z.number().int().positive() },
            (args) => host.removeWorktree(args, callerOf(connectionId)),
          ),
          act(
            "worktree_unlink",
            "Remove the Worktree-to-Worktree Link between a Worktree and another Worktree (its absolute path, as linked_overview shows it). Project Links stay on the canvas.",
            "create",
            { ...projectInput, worktreeId: z.number().int().positive(), targetWorktreePath: z.string().min(1).max(8192) },
            (args) => host.unlinkWorktrees(args),
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
          "Read a Chat's recent messages, current progress, the approvals and questions it waits on (answer them with chat_respond), and the messages queued behind its running turn.",
          { ...chatInput, limit: z.number().int().min(1).max(100).default(30) },
          (args) => host.readChat(args),
        ),
        read(
          "chat_search",
          "Search the messages of a Project's Chats that aren't archived, best match first.",
          { ...projectInput, query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(100).default(20) },
          (args) => host.searchChats(args),
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
          "Send a task to an existing Chat through Milagre. Nothing comes back from it: an agent that wants the result uses delegate, which reports back. A Chat whose agent can't take a message mid-turn starts it after its running turn (the answer's note says so). provider, model and effort switch the Chat as its pickers do (a new provider hands off). permissionMode sets its mode; otherwise the prompt runs in the Chat's own mode, and a Chat with no running agent takes the calling Chat's. If that mode is more than yours, the user approves first: the call can wait minutes for that card, so wait for its result, don't end the turn or move on. files and images are absolute paths inside the Chat's Worktree. Reuse requestId on retry.",
          "start",
          {
            ...chatInput,
            prompt: z.string().trim().min(1).max(100000),
            provider: z.enum(["claude", "codex", "antigravity", "kiro"]).optional(),
            model: z.string().min(1).max(300).optional(),
            effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
            permissionMode: permissionMode.optional(),
            files: z.array(z.string().min(1).max(4096)).max(20).default([]),
            images: z.array(z.string().min(1).max(4096)).max(10).default([]),
          },
          (args, operationId, assertActive) => host.startChat(args, operationId, assertActive, callerOf(connectionId), connectionLabel),
        ),
        act("chat_stop", "Stop a Chat's running turn, as its Stop button does.", "start", chatInput, (args) => host.stopChat(args)),
        act(
          "chat_set_mode",
          "Switch a running Chat's permission mode. More than the caller's own needs the user's approval. The call can wait minutes for the user's answer on that card: wait for its result, don't end the turn or move on.",
          "start",
          { ...chatInput, permissionMode },
          (args) => host.setMode(args, callerOf(connectionId)),
        ),
        act(
          "chat_respond",
          "Answer an approval or question another Chat waits on (requestId from chat_read). Approvals take decision; questions take answers (labels or typed text per question id, or null to dismiss). Unless the caller runs in Full permission, the user approves first. The call can wait minutes for the user's answer on that card: wait for its result, don't end the turn or move on.",
          "start",
          {
            ...chatInput,
            requestId: z.string().min(1).max(200),
            decision: z.enum(["allow", "allow-for-chat", "deny"]).optional(),
            answers: z
              .record(z.string(), z.array(z.string().max(2000)).max(20))
              .nullable()
              .optional(),
          },
          (args) => host.respond(args, callerOf(connectionId)),
        ),
        act(
          "chat_update",
          "Rename a Chat or archive it (archived: false brings it back). Stop a running Chat before archiving it.",
          "start",
          { ...chatInput, title: z.string().max(200).optional(), archived: z.boolean().optional() },
          (args) => host.updateChat(args),
        ),
      ];
    },
  }));
}
module.exports = { managementToolGroups };
