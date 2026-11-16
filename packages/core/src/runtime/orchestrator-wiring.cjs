const path = require("node:path");
const { chatKey, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { patchSession } = require("@milagre/shared/project-edits");
const { createOrchestratorStore } = require("../orchestrator/store.cjs");
const { createOrchestrator } = require("../orchestrator/service.cjs");
const { createAutopilot } = require("../orchestrator/autopilot.cjs");
const { ROUTE_SCHEMA } = require("../orchestrator/router.cjs");

const QUESTION_SCHEMA = {
  type: "object",
  properties: { answers: { type: "object" }, confidence: { type: "number" }, summary: { type: "string" } },
  required: ["answers", "confidence", "summary"],
};

const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, group: { type: "string" }, source: { type: "string" } },
        required: ["text", "group", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
};
const { claudeModel, codexModel } = require("../git-text.cjs");

function routerModels({ agentCli, clientVersion }) {
  const getCommand = (provider) => async () => {
    const status = await agentCli(provider);
    return status?.problem ? null : status;
  };
  return (router, outputSchema = ROUTE_SCHEMA) => {
    if (router.provider === "claude") return claudeModel({ getCommand: getCommand("claude"), model: router.model });
    if (router.provider === "codex") return codexModel({ getCommand: getCommand("codex"), clientVersion, outputSchema, model: router.model });
    return null;
  };
}

function markTaskChat(updateProject, projectPath, sessionId, orchestrator) {
  return updateProject(
    projectPath,
    (state) => {
      const session = state.sessions[sessionId];
      return session ? patchSession(state, sessionId, { orchestrator: { ...session.orchestrator, ...orchestrator } }) : state;
    },
    { chats: [] },
  );
}

function taskAccountsFor({ states, accounts, routing, agentCli }) {
  const pinned = (chatId, provider) => states.states.get(projectOfKey(chatId))?.sessions?.[sessionIdFromKey(chatId)]?.orchestrator?.accounts?.[provider];
  return {
    selected: (chatId, provider) => pinned(chatId, provider) ?? accounts.selected(provider, projectOfKey(chatId)),
    cli: (chatId, provider) => {
      const accountId = pinned(chatId, provider);
      return accountId ? routing.forAccount(provider, accountId) : agentCli(provider, projectOfKey(chatId));
    },
  };
}

function registerOrchestrator(
  { commands, dataDir, emit, chats, states, accounts, routing, agentCli, version },
  { projectRegistry, projectName, updateProject, defaultProjectBase, stopChat, archiveChat, respondPermission, answerQuestion },
) {
  const store = createOrchestratorStore({ file: path.join(dataDir, "orchestrator.json"), emit });
  const routerCall = routerModels({ agentCli, clientVersion: version });
  const orchestrator = createOrchestrator({
    store,
    ports: {
      projects: async () => (await projectRegistry().list()).map((project) => ({ path: project.path, name: project.name || projectName(project.path) })),
      selectedAccount: (provider, projectPath) => accounts.selected(provider, projectPath) ?? null,
      accountUsage: async () => {
        const snapshot = await commands.get("usage:accounts:cached")({});
        return (snapshot?.providers ?? []).map((entry) => ({
          provider: entry.provider,
          accountId: entry.account?.id,
          usedPercent: Math.max(0, ...(entry.windows ?? []).map((window) => Number(window.usedPercent) || 0)),
        }));
      },
      createWorktree: async (projectPath, title) =>
        (await commands.get("worktree:create")({}, { projectPath, baseBranch: await defaultProjectBase(projectPath), prompt: title })).worktreeId,
      projectWorktree: async (projectPath) => Object.values((await states.get(projectPath)).worktrees).find((worktree) => worktree.path === projectPath)?.id,
      emptyChat: async (projectPath, worktreeId, { title, orchestrator }) => {
        const sessionId = await chats.emptyChat(projectPath, worktreeId, { title });
        await markTaskChat(updateProject, projectPath, sessionId, orchestrator);
        return sessionId;
      },
      send: async (request) => {
        const { started } = await chats.send(request);
        void started?.catch?.((error) => console.warn("[orchestrator] a task's first turn failed to start:", error.message));
      },
      setHidden: (projectPath, sessionId, hidden) => markTaskChat(updateProject, projectPath, sessionId, { hidden }),
      chatKey,
      stop: (key) => stopChat(key),
      archive: (projectPath, sessionId) => archiveChat(projectPath, sessionId),
      routerCall: (router) => routerCall(router),
      memoryCall: (router) => routerCall(router, MEMORY_SCHEMA),
    },
  });
  commands.handle("orchestrator:read", () => orchestrator.snapshot());
  commands.handle("orchestrator:settings:save", (_event, patch) => orchestrator.saveSettings(patch));
  commands.handle("orchestrator:send", (_event, prompt) => orchestrator.send(prompt));
  commands.handle("orchestrator:task:project", (_event, taskId, projectPath) => orchestrator.pickProject(String(taskId), String(projectPath)));
  commands.handle("orchestrator:task:sidebar", (_event, taskId, shown) => orchestrator.showInSidebar(String(taskId), shown === true));
  commands.handle("orchestrator:task:undo", (_event, taskId) => orchestrator.undo(String(taskId)));
  commands.handle("orchestrator:task:reroute", (_event, taskId, change) => orchestrator.reroute(String(taskId), change ?? {}));
  commands.handle("orchestrator:task:dismiss", (_event, taskId) => orchestrator.dismiss(String(taskId)));
  commands.handle("orchestrator:memory:import", () => orchestrator.importMemory());
  commands.handle("orchestrator:memory:save", (_event, notes) => orchestrator.saveMemoryNotes(notes));
  commands.handle("orchestrator:memory:forget", () => orchestrator.forgetMemory());
  const autopilot = createAutopilot({
    store,
    ports: {
      sessionOf: (chatId) => states.states.get(projectOfKey(chatId))?.sessions?.[sessionIdFromKey(chatId)],
      respondPermission,
      answerQuestion,
      note: (chatId, body) => void chats.addNote(chatId, { body }),
      questionCall: (router) => routerCall(router, QUESTION_SCHEMA),
    },
  });
  return { taskAccounts: taskAccountsFor({ states, accounts, routing, agentCli }), autopilot };
}

module.exports = { registerOrchestrator };
