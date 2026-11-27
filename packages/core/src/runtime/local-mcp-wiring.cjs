const path = require("node:path");
const { isLinkScopeKey, scopeFromKey } = require("@milagre/shared/chat-scopes");
const { existsSync } = require("node:fs");
const { worktreeStatus } = require("../worktree-cleanup.cjs");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { activeWorktrees } = require("../project-identity.cjs");

function createLocalMcpWiring({
  options,
  dataDir,
  emit,
  commands,
  handlers,
  environmentReady,
  withoutHomes,
  projectRegistry,
  chatsHomeEntries,
  readProject,
  scopeStates,
  chats,
  agents,
  stopChat,
  setPermissionMode,
  respondPermission,
  answerQuestion,
  patchChat,
  addLink,
  removeLink,
  assignAccount,
  assertRegistrableProject,
  openProject,
  chatsHome,
  existingChat,
  artifacts,
  linkStore,
  states,
  linkMembers,
  subchatEscalation,
  limitSwitch,
  integrations,
}) {
  const designAdapter = path.join(__dirname, "..", "design-mcp-tools.cjs");
  const localMcpHost = require("../local-mcp-host.cjs").createLocalMcpHost({
    invoke: (channel, args) => handlers.get(channel)(null, ...args),
    projects: async () => [...withoutHomes(await projectRegistry().list()), ...(await chatsHomeEntries())],
    readProject,
    scopeStates,
    chats,
    permissionMode: (chatId, fallback) => agents.permissionMode(chatId, fallback),
    createWorktree: (context, request) => handlers.get("worktree:create")(context, request),
    stopChat,
    setPermissionMode: (chatId, mode) => setPermissionMode(chatId, mode),
    respondPermission: (chatId, requestId, decision) => respondPermission({ chatId, requestId, decision }),
    answerQuestion: (chatId, requestId, answers, summary, sender) => answerQuestion({ chatId, requestId, answers, summary }, sender),
    suggestAnswer: (chatId, details) => subchatEscalation().suggest(chatId, details),
    patchChat,
    searchChats: async (projectPath, query, limit, archived) => await handlers.get("chat:search")(null, projectPath, query, { limit, archived }),
    links: { list: async () => (await projectRegistry().snapshot()).links, add: addLink, remove: removeLink },
    activeWorktrees: async (projectPath) => (await activeWorktrees(projectPath)).map((worktree) => worktree.path),
    approve: (chatId, request) => agents.askApproval(chatId, request),
    models: (projectPath) => handlers.get("agent:models")(null, projectPath),
    getProjectAccounts: (projectPath, refresh) => handlers.get("accounts:scope")(null, projectPath, refresh),
    assignProjectAccount: async (projectPath, provider, id, canAssign) => limitSwitch().decorate(await assignAccount(projectPath, provider, id, { canAssign })),
    worktreeStatus,
    removeWorktree: (projectPath, worktreePath) => handlers.get("worktree:remove")(null, worktreePath, { projectPath }),
    assertRegistrableProject,
    registerProject: async (folder) => {
      assertRegistrableProject(folder);
      await openProject(folder, { takeNotice: false, focus: false });
      emit("local-mcp:changed", { projectAdded: true });
    },
    imports: {
      scan: () => handlers.get("import:scan")(null),
      run: (request) => handlers.get("import:run")(null, request),
    },
    validateDesignChat: async (chatId) => {
      const scope = projectOfKey(chatId);
      if (!isLinkScopeKey(scope)) {
        if (!chatsHome.isHome(scope) && !(await projectRegistry().list()).some((project) => project.path === scope))
          throw Error("Open this Project in Milagre first");
        await readProject(scope);
      }
      await existingChat("connecting Designs")(chatId);
    },
  });
  localMcpHost.pullRequests = (request) => handlers.get("pull-requests:list")(null, request);
  localMcpHost.reviewReport = (report, chatId) => handlers.get("pr-reviews:report")(null, report, chatId);
  Object.assign(
    localMcpHost,
    require("../orchestrator/mcp.cjs").orchestratorMcpMethods({
      send: (prompt) => handlers.get("orchestrator:send")(null, prompt),
      read: () => handlers.get("orchestrator:read")(null),
      saveSettings: (patch) => handlers.get("orchestrator:settings:save")(null, patch),
    }),
  );
  const localMcp = require("../local-mcp.cjs").createLocalMcp({
    dataDir,
    emit,
    environmentReady,
    clientOptions: options.localMcpClients,
    designGroup: existsSync(designAdapter) ? require(designAdapter).createDesignToolGroup({ artifacts }) : undefined,
    connectorGroup: integrations.connectorToolGroup,
    agentScope: (chatId) => {
      const projectPath = projectOfKey(chatId);
      const state = isLinkScopeKey(projectPath) ? linkStore.cached(scopeFromKey(projectPath).linkId) : states.states.get(projectPath);
      const session = state?.sessions[sessionIdFromKey(chatId)];
      if (!session || session.archived) throw Error("Chat is unavailable or archived");
      const designGrant = { designs: { chatId, designIds: "*", capabilities: ["read", "write"] } };
      const projectPaths = isLinkScopeKey(projectPath) ? (linkMembers.get(scopeFromKey(projectPath).linkId) ?? []) : [projectPath];
      if (!projectPaths.length) return designGrant;
      return {
        ...designGrant,
        projects: { projectPaths, capabilities: ["read", "create"] },
        worktrees: { projectPaths, capabilities: ["read", "create"] },
        chats: { projectPaths, capabilities: ["read", "create", "start"] },
      };
    },
    host: localMcpHost,
  });
  for (const method of ["status", "create", "update", "rotate", "revoke", "enableClient", "disableClient"])
    commands.handle(`local-mcp:${method}`, (_context, ...args) => localMcp[method](...args));
  void localMcp.resume().catch(() => console.warn("Local MCP could not resume its loopback listener. Open Settings > Milagre MCP to retry."));
  return { localMcp };
}

module.exports = { createLocalMcpWiring };
