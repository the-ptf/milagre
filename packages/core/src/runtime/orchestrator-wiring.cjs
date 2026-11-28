const os = require("node:os");
const path = require("node:path");
const { chatKey, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { createOrchestratorStore } = require("../orchestrator/store.cjs");
const { createOrchestrator } = require("../orchestrator/service.cjs");
const { createAutopilot } = require("../orchestrator/autopilot.cjs");
const { createMemorySync } = require("../orchestrator/memory-sync.cjs");
const { createTaskImages } = require("../orchestrator/images.cjs");
const { createTaskSweep } = require("../orchestrator/task-sweep.cjs");
const { createTaskTools } = require("../orchestrator/task-tools.cjs");
const { SWEEP_MS } = require("../done-sweep.cjs");
const { ROUTE_SCHEMA } = require("../orchestrator/router.cjs");
const { claudeModel, codexModel } = require("../git-text.cjs");

const QUESTION_SCHEMA = {
  type: "object",
  properties: { answers: { type: "object" }, confidence: { type: "number" }, summary: { type: "string" } },
  required: ["answers", "confidence", "summary"],
};

const FLOW_SCHEMA = {
  type: "object",
  properties: { design: { type: "boolean" }, approve: { type: "boolean" }, confidence: { type: "number" }, summary: { type: "string" } },
  required: ["design", "approve", "confidence", "summary"],
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

/** An undefined field is removed: a state patch can't carry undefined, so the Chat's viewers would keep the old value. */
function withTaskChat(state, sessionId, orchestrator) {
  const session = state.sessions[sessionId];
  if (!session) return state;
  const merged = Object.fromEntries(Object.entries({ ...session.orchestrator, ...orchestrator }).filter(([, value]) => value !== undefined));
  return { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, orchestrator: merged } } };
}

function markTaskChat(updateProject, projectPath, sessionId, orchestrator) {
  return updateProject(projectPath, (state) => withTaskChat(state, sessionId, orchestrator), { chats: [] });
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
  { commands, dataDir, emit, chats, states, accounts, routing, agentCli, version, doneSettings, shutdown },
  { projectRegistry, projectName, updateProject, defaultProjectBase, stopChat, archiveChat, respondPermission, answerQuestion, remote, git, routines },
) {
  let memorySync = null;
  const store = createOrchestratorStore({
    file: path.join(dataDir, "orchestrator.json"),
    emit: (channel, value) => {
      emit(channel, value);
      memorySync?.changed();
    },
  });
  memorySync = createMemorySync({ store, remote, schedule: (run, ms) => setTimeout(run, ms).unref() });
  setTimeout(() => void memorySync.pushNow().catch(() => {}), 15_000).unref();
  const routerCall = routerModels({ agentCli, clientVersion: version });
  const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref?.())]);
  const images = createTaskImages({ dir: path.join(dataDir, "orchestrator-images") });
  const orchestrator = createOrchestrator({
    store,
    ports: {
      images,
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
      deleteChat: (projectPath, sessionId) => commands.get("chat:delete")({}, projectPath, sessionId),
      placeChat: async (projectPath, sessionId, column) => {
        await commands.get("chat:patch")({}, projectPath, sessionId, { done: column === "done" });
        await markTaskChat(updateProject, projectPath, sessionId, { column: column === "done" ? undefined : column });
      },
      routerCall: (router) => routerCall(router),
      memoryCall: (router) => routerCall(router, MEMORY_SCHEMA),
      remote,
      originOf: async (projectPath) => (await git.text(projectPath, ["remote", "get-url", "origin"])).trim().replace(/\.git$/, "") || null,
      capacity: async () => {
        const load = os.loadavg()[0] / Math.max(1, os.cpus().length);
        const memory = (
          await commands
            .get("computer:resources:read")({}, {})
            .catch(() => null)
        )?.memory;
        return {
          cpu: Math.min(1, load),
          memoryFree: memory?.total ? memory.available / memory.total : os.freemem() / os.totalmem(),
          agents: chats.busyChats?.().size ?? 0,
        };
      },
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
      withTimeout,
    },
  });
  commands.handle("orchestrator:read", () => orchestrator.snapshot());
  commands.handle("orchestrator:projects", () => orchestrator.projects());
  commands.handle("orchestrator:computers", () => orchestrator.computers());
  commands.handle("orchestrator:settings:save", (_event, patch) => orchestrator.saveSettings(patch));
  commands.handle("orchestrator:send", (_event, prompt, options) => orchestrator.send(prompt, options ?? {}));
  commands.handle("orchestrator:task:project", (_event, taskId, projectPath) => orchestrator.pickProject(String(taskId), String(projectPath)));
  commands.handle("orchestrator:task:sidebar", (_event, taskId, shown) => orchestrator.showInSidebar(String(taskId), shown === true));
  commands.handle("orchestrator:task:undo", (_event, taskId) => orchestrator.undo(String(taskId)));
  commands.handle("orchestrator:task:move", (_event, taskId, column) => orchestrator.move(String(taskId), String(column)));
  commands.handle("orchestrator:task:delete", (_event, taskId) => orchestrator.remove(String(taskId)));
  commands.handle("orchestrator:task:reroute", (_event, taskId, change) => orchestrator.reroute(String(taskId), change ?? {}));
  commands.handle("orchestrator:task:dismiss", (_event, taskId) => orchestrator.dismiss(String(taskId)));
  commands.handle("orchestrator:memory:import", () => orchestrator.importMemory());
  commands.handle("orchestrator:capacity", () => orchestrator.capacity());
  commands.handle("orchestrator:start-here", (_event, request) => orchestrator.startHere(request ?? {}));
  commands.handle("orchestrator:memory:save", (_event, notes) => orchestrator.saveMemoryNotes(notes));
  commands.handle("orchestrator:memory:forget", () => orchestrator.forgetMemory());
  commands.handle("orchestrator:memory:merge", (_event, memory) => memorySync.merge(memory));
  const taskSweep = createTaskSweep({
    store,
    ports: {
      doneSettings: () => doneSettings.read(),
      busy: () => chats.busyChats?.() ?? new Set(),
      heldState: (projectPath) => states.states.get(projectPath),
      chatKey,
      archive: (projectPath, sessionId) => archiveChat(projectPath, sessionId),
      images,
      remote,
      withTimeout,
    },
  });
  taskSweep.start(SWEEP_MS);
  shutdown?.stop(() => taskSweep.stop());
  const autopilot = createAutopilot({
    store,
    ports: {
      sessionOf: (chatId) => states.states.get(projectOfKey(chatId))?.sessions?.[sessionIdFromKey(chatId)],
      respondPermission,
      answerQuestion,
      note: (chatId, summary) =>
        void chats.addNote(chatId, { body: `The Orchestrator answered for you: ${summary}.`, context: { kind: "orchestrator-answer", summary } }),
      questionCall: (router) => routerCall(router, QUESTION_SCHEMA),
      flowCall: (router) => routerCall(router, FLOW_SCHEMA),
      runPrompt: (routine) => routines?.runPrompt(routine),
      flowApproval: (runId, stepId) => routines?.flowApproval(runId, stepId) ?? null,
      approveFlow: (runId, summary) => routines?.autopilotApprove(runId, summary),
      planFlow: (runId, stepId, plan) => routines?.autopilotPlan(runId, stepId, plan),
    },
  });
  routines?.onApprovalWaiting((waiting) => autopilot.considerFlow(waiting));
  const taskTools = createTaskTools({
    taskOf: (chatId) => states.states.get(projectOfKey(chatId))?.sessions?.[sessionIdFromKey(chatId)]?.orchestrator ?? null,
    mark: (chatId, patch) => markTaskChat(updateProject, projectOfKey(chatId), sessionIdFromKey(chatId), patch),
  });
  const watcher = {
    observe(chatId, event) {
      autopilot.observe(chatId, event);
      orchestrator.observe(chatId, event);
      taskTools.observe(chatId, event);
    },
    tools: (chatId) => taskTools.definitions(chatId),
    close: () => autopilot.close(),
  };
  return { taskAccounts: taskAccountsFor({ states, accounts, routing, agentCli }), autopilot: watcher };
}

module.exports = { registerOrchestrator, withTaskChat };
