const path = require("node:path");
const { withBrowserOwner } = require("../browser-owner.cjs");
const { PROVIDERS } = require("@milagre/shared/providers");
const fs = require("node:fs/promises");
const { ClaudeSession } = require("../agents/claude-provider.cjs");
const { CodexSession } = require("../agents/codex-provider.cjs");
const { discoverSkills } = require("../skills.cjs");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");

function createAdvisorsWiring({
  options,
  dataDir,
  version,
  commands,
  existingChat,
  agents,
  chats,
  linked,
  mcp,
  ports,
  routing,
  scopeStates,
  turnDefaults,
  browsers,
  simulators,
  simulatorToolDefinitions,
  isClosing,
}) {
  const advisorStore = require("../advisor-store.cjs").createAdvisorStore({ dataDir });
  const advisorTransports = new Map();
  const advisorMcp = require("../linked-mcp-server.cjs").createLinkedMcpServer({ toolsFor: (id) => advisorTransports.get(id) ?? [] });
  async function advisorContext(chatId) {
    await existingChat("using advisors")(chatId);
    const scope = projectOfKey(chatId);
    const id = sessionIdFromKey(chatId);
    const state = await scopeStates.load(scope, [id]);
    const session = state.sessions[id];
    if (session.archived) throw new Error("This Chat is archived.");
    const execution = await scopeStates.executionContext(scope, id);
    if (!execution.cwd) throw new Error("This Chat's Worktree is unavailable.");
    const roots = [...new Set([execution.cwd, ...(execution.workspaceRoots ?? []), ...(execution.readOnlyRoots ?? []), ...(execution.projectRoots ?? [])])];
    const identities = await Promise.all(
      roots.map(async (root) => {
        const real = await fs.realpath(root);
        if (real !== root) throw new Error("The advisor Worktree identity changed.");
        const stat = await fs.stat(real);
        return [real, stat.dev, stat.ino];
      }),
    );
    const settings = chats.turnSettings(chatId) ?? {};
    const provider = session.provider ?? settings.provider ?? "claude";
    return {
      ...execution,
      roots,
      scopeIdentity: JSON.stringify([scope, id, session.worktree_id, identities]),
      parentProvider: provider,
      provider,
      model: chats.runs[chatId]?.model || require("@milagre/shared/agent-runs").lastUserModel(state, id) || settings.model,
      settings: { ...settings, provider },
      permissionMode: agents.permissionMode(chatId, settings.permissionMode ?? session.permissionMode ?? "ask"),
      scope,
      sessionId: id,
    };
  }
  async function advisorProviders(chatId, pinned) {
    const scope = projectOfKey(chatId);
    const ids = routing.selection(scope);
    if (pinned) ids[pinned.provider] = pinned.accountId;
    const services = routing.services(scope, ids);
    const [status, models, claude, codex] = await Promise.all([
      options.agentCliStatus ? options.agentCliStatus() : services.status(),
      options.agentModels ? options.agentModels() : services.models(),
      routing.forAccount("claude", ids.claude),
      routing.forAccount("codex", ids.codex),
    ]);
    return Object.fromEntries(
      PROVIDERS.map((provider) => {
        const cli = provider === "claude" ? claude : codex;
        return [
          provider,
          {
            ...cli,
            available: !cli.problem && Boolean(cli.command) && status[provider]?.state === "ready" && Boolean(models[provider]?.length),
            models: models[provider] ?? [],
            problem: cli.problem ?? status[provider]?.message,
          },
        ];
      }),
    );
  }
  const advisorDelivery = require("../advisor-delivery.cjs").createAdvisorDelivery({
    store: advisorStore,
    contextFor: advisorContext,
    isBlocked: (chatId) => isClosing() || chats.preparing.has(chatId) || Boolean(chats.runs[chatId]?.approvals.length || chats.runs[chatId]?.questions.length),
    send: async (chatId, message, ctx) => {
      const sent = await chats.send({
        ...ctx.settings,
        projectPath: ctx.scope,
        sessionId: ctx.sessionId,
        provider: ctx.provider,
        model: ctx.model,
        permissionMode: ctx.settings.permissionMode ?? "auto",
        ...message,
      });
      return sent.queued ? { queued: true } : sent.started;
    },
  });
  const advisors = require("../advisors.cjs").createAdvisors({
    store: advisorStore,
    contextFor: advisorContext,
    providersFor: advisorProviders,
    publish: async (chatId, agent) => {
      if (["initializing", "running", "waiting"].includes(agent.status)) ports.wake();
      await chats.receive(chatId, { type: "subagent-update", agent });
    },
    completed: (chatId, result) => advisorDelivery.enqueue(chatId, result),
    captureOutput: async (record, output, files) => {
      if (record.mode !== "execution") return output;
      const scope = projectOfKey(record.chatId);
      const sessionId = sessionIdFromKey(record.chatId);
      const state = await scopeStates.load(scope, [sessionId]);
      const cwd = chats.images.cwd(state, { session_id: sessionId }, scope);
      const existing = require("../chat-images.cjs").imagePaths({ body: output }, cwd);
      const body = [output, ...files.filter((file) => !existing.has(path.resolve(cwd, file))).map((file) => `![Screenshot](<${file}>)`)].join("\n\n");
      const captured = await chats.images.capture(scope, state, { role: "assistant", session_id: sessionId, body });
      return { output: body, images: captured.images ?? [] };
    },
    launch: async ({ record, context, provider, emit: send }) => {
      const { skills } = await discoverSkills(context.cwd);
      const referenceRoots = [...new Set(skills.map((skill) => path.dirname(skill.path)))];
      const canvasReads = linked
        .forChat(record.chatId)
        .tools.filter((tool) => ["linked_overview", "read_linked_chat", "linked_git", "read_linked_file", "search_linked_files"].includes(tool.name));
      const tools = [...require("../advisor-reads.cjs").createAdvisorReads({ roots: context.roots, referenceRoots }), ...canvasReads];
      const executionAdvisor = record.mode === "execution";
      if (executionAdvisor)
        tools.push(...require("../chat-browsers.cjs").browserToolDefinitions(record.chatId, browsers), ...simulatorToolDefinitions(record.chatId, simulators));
      advisorTransports.set(record.id, tools);
      const sessionOptions = {
        cwd: context.cwd,
        workspaceRoots: context.workspaceRoots,
        readOnlyRoots: context.readOnlyRoots,
        workspaceInstructions: context.workspaceInstructions,
        sharedLink: context.sharedLink,
        tldrEnabled: context.settings?.tldrEnabled ?? turnDefaults.read().tldrEnabled,
        analysisOnly: !executionAdvisor,
        executionAdvisor,
        ...(executionAdvisor ? { mcpExtras: () => mcp.forSession(record.provider, record.launchIdentity.accountId ?? "default") } : {}),
        resumeId: record.nativeId,
        command: provider.command,
        env: withBrowserOwner(record.chatId, provider.env ?? process.env),
        linked: { tools, url: () => advisorMcp.url(record.id), toolsAvailable: () => {} },
        emit: send,
      };
      const session = options.createSession
        ? options.createSession(record.provider, sessionOptions)
        : record.provider === "codex"
          ? new CodexSession({ ...sessionOptions, clientVersion: version })
          : new ClaudeSession(sessionOptions);
      const close = session.close.bind(session);
      session.close = async () => {
        advisorTransports.delete(record.id);
        await close();
      };
      return session;
    },
  });
  for (const method of ["stop", "retry"])
    commands.handle(`advisor:${method}`, async (_event, chatId, advisorId) => {
      await existingChat("controlling advisors")(chatId);
      return advisors[method](chatId, String(advisorId));
    });
  async function close() {
    await advisorDelivery.close();
    await advisors.close();
    await advisorMcp.close();
    await advisorStore.close();
  }
  return { advisorStore, advisorDelivery, advisors, close };
}

module.exports = { createAdvisorsWiring };
