const path = require("node:path");
const { MODEL_CATALOG } = require("@milagre/shared/model-options");
const { PROVIDERS } = require("@milagre/shared/providers");
const { projectOfKey, sessionIdFromKey, lastUserModel } = require("@milagre/shared/agent-runs");
const { renderTranscript, cutTranscript } = require("../agents/handover.cjs");
const { discoverSkills } = require("../skills.cjs");
const { createBtw } = require("../btw.cjs");
const { createAdvisorReads } = require("../advisor-reads.cjs");
const { createLinkedMcpServer } = require("../linked-mcp-server.cjs");

function createBtwWiring({ commands, existingChat, scopeStates, chats, agents, routing, linked, turnDefaults, emit }) {
  const transports = new Map();
  const server = createLinkedMcpServer({ toolsFor: (id) => transports.get(id) ?? [] });
  const btw = createBtw({
    emit,
    contextFor: async (chatId, request) => {
      await existingChat("asking a side question")(chatId);
      const scope = projectOfKey(chatId);
      const id = sessionIdFromKey(chatId);
      const state = await scopeStates.load(scope, [id]);
      const chat = state.sessions[id];
      if (chat.archived) throw new Error("This Chat is archived.");
      if (chat.formerWorktree) throw new Error("This Chat's Worktree is unavailable.");
      if (chat.readOnlyReason) throw new Error(chat.readOnlyReason);
      const execution = await scopeStates.executionContext(scope, id);
      if (!execution.cwd) throw new Error("This Chat's Worktree is unavailable.");
      const settings = chats.turnSettings(chatId) ?? {};
      const parentProvider = chat.provider ?? settings.provider ?? "claude";
      const provider = request.provider ?? parentProvider;
      if (!PROVIDERS.includes(provider)) throw new Error("Choose an available provider for the side question.");
      const model =
        request.model ||
        (provider === parentProvider ? chats.runs[chatId]?.model || lastUserModel(state, id) || settings.model : null) ||
        MODEL_CATALOG.find((item) => item.provider === provider && item.recommended)?.id ||
        MODEL_CATALOG.find((item) => item.provider === provider)?.id;
      if (!model) throw new Error("Choose a model before asking a side question.");
      const accountId = routing.selection(scope)[provider];
      const cli = await routing.forAccount(provider, accountId);
      if (cli.problem) throw new Error(cli.problem);
      const entry = agents.sessions.get(chatId);
      const parentNativeId =
        provider === parentProvider ? (entry?.provider === provider ? (entry.session.nativeId ?? chat.native_session_id) : chat.native_session_id) : null;
      const live = chats.runs[chatId];
      const transcript = cutTranscript(
        [renderTranscript(state, id), live?.text ? `## Assistant (reply in progress)\n${live.text}` : ""].filter(Boolean).join("\n\n"),
      );
      return {
        ...execution,
        roots: [...new Set([execution.cwd, ...(execution.workspaceRoots ?? []), ...(execution.readOnlyRoots ?? []), ...(execution.projectRoots ?? [])])],
        provider,
        model,
        effort: request.effort,
        parentNativeId,
        transcript,
        cli,
        accountId,
        tldrEnabled: settings.tldrEnabled ?? turnDefaults.read().tldrEnabled,
      };
    },
    launch: async ({ chatId, requestId, context, resumeId, forkSession, emit: send }) => {
      const { skills } = await discoverSkills(context.cwd);
      const referenceRoots = [...new Set(skills.map((skill) => path.dirname(skill.path)))];
      const canvasReads = linked
        .forChat(chatId)
        .tools.filter((tool) => ["linked_overview", "read_linked_chat", "linked_git", "read_linked_file", "search_linked_files"].includes(tool.name));
      const tools = [...createAdvisorReads({ roots: context.roots, referenceRoots }), ...canvasReads];
      transports.set(requestId, tools);
      try {
        const session = agents.createSession(context.provider, {
          ...context.cli,
          cwd: context.cwd,
          workspaceRoots: context.workspaceRoots,
          readOnlyRoots: context.readOnlyRoots,
          workspaceInstructions: context.workspaceInstructions,
          sharedLink: context.sharedLink,
          tldrEnabled: context.tldrEnabled,
          accountId: context.accountId,
          analysisOnly: true,
          sideChat: true,
          ephemeral: true,
          resumeId,
          forkSession,
          linked: { tools, url: () => server.url(requestId), toolsAvailable: () => {} },
          emit: send,
        });
        const close = session.close.bind(session);
        session.close = async () => {
          transports.delete(requestId);
          await close();
        };
        return session;
      } catch (error) {
        transports.delete(requestId);
        throw error;
      }
    },
  });
  commands.handle("chat:btw", (_event, request) => btw.ask(request));
  for (const method of ["stop", "read"])
    commands.handle(`chat:btw-${method}`, async (_event, chatId, options) => {
      await existingChat("using a side question")(chatId);
      return btw[method](chatId, options);
    });
  return {
    ...btw,
    close: async () => {
      await btw.close();
      await server.close();
    },
  };
}

module.exports = { createBtwWiring };
