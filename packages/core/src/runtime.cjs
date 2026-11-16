const { hold } = require("./runtime/tracked-work.cjs");
const { chatMentionsContext } = require("./chat-mentions.cjs");
const { computerMentionsContext } = require("./computer-mentions.cjs");
const { createLinkStore } = require("./link-store.cjs");
const { createLinkWorkspaces } = require("./link-workspaces.cjs");
const { createChatScopes } = require("./chat-scopes.cjs");
const { registerLinkRuntime } = require("./link-runtime.cjs");
const { isLinkScopeKey, scopeFromKey, scopeKey } = require("@milagre/shared/chat-scopes");
const { PROVIDERS } = require("@milagre/shared/providers");
const { defaultFallback } = require("./routines/fallback.cjs");
const { ChatTitles, createChatTitleModels, generateChatTitle, generateRunTitle } = require("./chat-title.cjs");
const { createGit } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const { acquireOwnership } = require("./ownership.cjs");
const { mkdirSync, realpathSync, existsSync } = require("node:fs");
const path = require("node:path");
const { migrateImages } = require("./project-content.cjs");
const { ensureProjectIgnore } = require("./project-ignore.cjs");
const { decodeImages } = require("./image-input.cjs");
const { KeepAwake } = require("./keep-awake.cjs");
const { ClaudeSession } = require("./agents/claude-provider.cjs");
const { CodexSession, recoverCodexSubagents } = require("./agents/codex-provider.cjs");
const { AcpSession } = require("./agents/acp-session.cjs");
const { antigravityAcp } = require("./agents/antigravity-acp.cjs");
const { kiroAcp } = require("./agents/kiro-acp.cjs");
const { recoverAntigravitySubagents } = require("./agents/antigravity-subagents.cjs");
const { loadLoginEnvironment } = require("./agents/environment.cjs");
const { failedWith, hostNetworkInstructions, loginMessage } = require("./agents/events.cjs");
const { SessionManager } = require("./agents/session-manager.cjs");
const { PortWatcher } = require("./agents/ports.cjs");
const { ChatHost } = require("./agents/chat-host.cjs");
const { SubchatEscalation } = require("./agents/subchat-escalation.cjs");
const { writeTranscript, generateBrief, createHandoverModels } = require("./agents/handover.cjs");
const { expandSkillPrompt } = require("./skills.cjs");
const { DEFAULT_WORKTREE_ROOT } = require("./worktrees.cjs");
const { branchPolicyNote } = require("./branch-policy.cjs");
const { removeWorktree, worktreeStatus } = require("./worktree-cleanup.cjs");
const { WorktreeSetups } = require("./worktree-setup.cjs");
const { SetupReview } = require("./setup-review.cjs");
const { readDiffStat } = require("./diffstat.cjs");
const { registerCheckpoints } = require("./checkpoint-runtime.cjs");
const { createSentFromNotes } = require("./sent-from.cjs");
const { registerGitHandlers } = require("./git-ipc.cjs");
const { readPullRequestState } = require("./pull-request.cjs");
const { registerPullRequests } = require("./runtime/pull-requests.cjs");
const { registerSettingsCommands } = require("./runtime/settings-commands.cjs");
const { createToolServices } = require("./runtime/tool-services.cjs");
const { createLocalMcpWiring } = require("./runtime/local-mcp-wiring.cjs");
const { createShutdown } = require("./runtime/shutdown.cjs");
const { registerChatLifecycle } = require("./runtime/chat-lifecycle.cjs");
const { registerProjects } = require("./runtime/projects.cjs");
const { createWorktrees } = require("./runtime/worktrees.cjs");
const { createAdvisorsWiring } = require("./runtime/advisors-wiring.cjs");
const { createFiles } = require("./runtime/files.cjs");
const { createAccountsWiring, registerAccountScopes } = require("./runtime/accounts-wiring.cjs");
const { createUsage, registerTokenUsage } = require("./runtime/usage.cjs");
const { registerOrchestrator } = require("./runtime/orchestrator-wiring.cjs");
const { retireRunWorktree } = require("./routines/run-worktree.cjs");
const { background: inBackgroundLane } = require("./process-lanes.cjs");
const { emptyState, reconcileState, markDisconnectedSubagents, withWorktreeBases } = require("./project-state.cjs");
const { migrateWorktreeChats } = require("./worktree-chats.cjs");
const { linearToolDefinitions } = require("./linear/tools.cjs");
const { ProjectStates } = require("./project-states.cjs");
const { DiffRefresher } = require("./diff-refresh.cjs");
const { chatKey, isTurnEnd, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { attentionContext, attentionNotice } = require("@milagre/shared/attention");
const { saveProjectState, readProjectState, compactProjectState, stateFile } = require("./project-store.cjs");
const { createRecentProjects, launchProject, plainFolder, rememberProject } = require("./recent-projects.cjs");
const { activeWorktrees, inspectProject, mainCheckoutWorktrees, outsideGit, resolveProject } = require("./project-identity.cjs");
const { createProjectRegistry } = require("./project-registry.cjs");
const { createLinkedWorktrees } = require("./linked-worktrees.cjs");
const { createRoutines, withRunChatsHidden } = require("./routines/runtime-adapter.cjs");
const { createHookStore } = require("./routines/hook-store.cjs");
const { idleWorktrees, assertIdleWorktree } = require("./storage-worktrees.cjs");
const { createDoneSweep } = require("./done-sweep.cjs");
const { createSnoozeSweep } = require("./snooze-sweep.cjs");
const { wakesSnoozed } = require("@milagre/shared/snooze");
const { createBabysitWatch } = require("./babysit-watch.cjs");
const HOOK_RELAY_URL = "wss://relay.milagre.cloud";
const { chatTitle, isHiddenRunChat, isHiddenTaskChat } = require("@milagre/shared/chats");
const ROUTINE_TARGET_CHATS = 50;

const { createFileSearch } = require("./project-files.cjs");
const { askForUnknownModes } = require("./agents/permissions.cjs");
const { createChatsHome } = require("./chats-home.cjs");
const { isFolderChatsHome } = require("./chats-home-folders.cjs");
const git = createGit().read;

async function registeredWorktrees(project) {
  return (project.git !== false && (await mainCheckoutWorktrees(project.path))) || activeWorktrees(project.path);
}

function createRuntime(options) {
  const { dataDir, version, cwd = process.cwd(), emit = () => {}, isFocused = () => false } = options;
  let { lazyMessages } = options;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new Error("An absolute data directory is required");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dataOwner = acquireOwnership(path.join(realpathSync(dataDir), "runtime.lock"));
  const projectOwners = new Map();
  const repositoryOwners = new Map();
  const active = new Set();
  const starting = new Set();
  const background = new Set();
  const needsUserAt = new Map();
  let needsUserCount = 0;
  const NEEDS_USER_CHATS = 500;
  let closing = false;
  let btw;
  let advisors;
  let advisorDelivery;
  const chatsHome = createChatsHome({ root: options.chatsHome ?? path.join(require("node:os").homedir(), ".milagre", "chats") });
  const withKind = (project) => (chatsHome.isHome(project.path) ? { ...project, kind: "chats" } : project);
  const chatsHomeEntries = async () => ((await chatsHome.exists()) ? [{ path: chatsHome.path, name: projectName(chatsHome.path), kind: "chats" }] : []);
  function track(work, set = active) {
    return hold(Promise.resolve().then(work), set);
  }
  function accept(work) {
    if (closing) return Promise.reject(new Error("Milagre runtime is closing"));
    return track(work);
  }
  async function ownProject(projectPath) {
    if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) throw new Error("An absolute Project path is required");
    const real = realpathSync(projectPath);
    const checkAlias = (existing) => {
      if (existing.openedAs !== projectPath) throw new Error(`Project is already open as ${existing.openedAs}`);
    };
    if (projectOwners.has(real)) {
      checkAlias(projectOwners.get(real));
      return;
    }
    let common;
    try {
      common = await git.commonDir(real);
    } catch (error) {
      if (!(error.code === 128 && /not a git repository/i.test(error.stderr ?? "")) && !(error.missing && (await outsideGit(real)))) throw error;
    }
    if (projectOwners.has(real)) {
      checkAlias(projectOwners.get(real));
      return;
    }
    let repositoryOwner;
    if (common && !repositoryOwners.has(common)) repositoryOwner = acquireOwnership(path.join(common, "milagre-runtime.lock"));
    let owner;
    try {
      owner = acquireOwnership(path.join(real, ".milagre", "runtime.lock"));
      if (common) ensureProjectIgnore(real);
      projectOwners.set(real, { openedAs: projectPath, owner });
      if (repositoryOwner) repositoryOwners.set(common, repositoryOwner);
    } catch (error) {
      try {
        owner?.release();
      } finally {
        repositoryOwner?.release();
      }
      throw error;
    }
  }
  const commands = require("./command-dispatcher.cjs").createRuntimeCommands();
  const handlers = commands;
  const { simulatorToolDefinitions } = require("./chat-simulators.cjs");
  const { artifactToolDefinitions, htmlArtifactToolDefinitions, artifactCommentToolDefinitions } = require("./chat-artifacts.cjs");
  const { designKitToolDefinitions } = require("./design-kits.cjs");
  const { pageCommentToolDefinitions } = require("./chat-page-comments.cjs");
  const existingChat = (action) => async (chatId) => {
    const scope = projectOfKey(chatId),
      id = sessionIdFromKey(chatId);
    if (!scope || !Number.isSafeInteger(id) || id < 1 || !scopeStates.has(scope) || !(await scopeStates.get(scope)).sessions[id])
      throw new Error(`Open an existing Chat before ${action}.`);
  };
  const toolServices = createToolServices({
    options,
    dataDir,
    emit,
    commands,
    existingChat,
    agents: () => agents,
    scopeStates: () => scopeStates,
    chats: () => chats,
    ports: () => ports,
    advisors: () => advisors,
    sendAsUser: (...args) => sendAsUser(...args),
  });
  const {
    computerUseSettings,
    computerUseScreen,
    computerUse,
    simlockSettings,
    simlock,
    simulators,
    leaseSimlock,
    releaseSimlock,
    designKits,
    artifacts,
    pageComments,
    agentProcesses,
    browsers,
    panelForwarders,
    chatWorktrees,
    terminals,
  } = toolServices;
  const searchFiles = createFileSearch();
  const environmentReady =
    options.environmentReady ??
    loadLoginEnvironment().then(
      ({ source }) => {
        if (source === "fallback") console.warn("Milagre couldn't read your login shell's environment; looking for agents in common install folders.");
      },
      (error) => console.warn("Milagre couldn't read your login shell's environment:", error.message),
    );
  async function discoverWorktrees(projectPath) {
    return (projectsWithGit.get(projectPath) && (await mainCheckoutWorktrees(projectPath))) || activeWorktrees(projectPath);
  }

  async function readStoredState(projectPath) {
    await ownProject(projectPath);
    try {
      return await readProjectState(projectPath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function readRawState(projectPath) {
    try {
      return JSON.parse(await fs.readFile(stateFile(projectPath), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  const projectName = (projectPath) => (chatsHome.isHome(projectPath) ? "No project" : path.basename(projectPath) || "Untitled project");

  const restoredChats = new Map();

  async function withWorktreeChats(projectPath, stored, discovered) {
    try {
      if (discovered.length < 2 || (await fs.realpath(discovered[0].path).catch(() => null)) !== projectPath) return stored;
      const { state, restored } = await migrateWorktreeChats({
        projectPath,
        state: stored ?? emptyState(projectName(projectPath)),
        linkedWorktrees: discovered.slice(1),
        listed: new Set(discovered.map((worktree) => worktree.path)),
        save: saveProjectState,
      });
      if (!restored.length) return stored;
      restoredChats.set(projectPath, [...(restoredChats.get(projectPath) ?? []), ...restored]);
      return state;
    } catch (error) {
      console.warn(`Milagre couldn't bring back chats saved in ${projectPath}'s linked worktrees:`, error.message);
      return stored;
    }
  }

  let busyChat = () => true;
  const lazy = process.env.MILAGRE_LAZY_MESSAGES !== "0" && lazyMessages !== false;
  const idleOverride = Number(process.env.MILAGRE_LAZY_MESSAGES_IDLE_MS);
  if (lazy && process.env.MILAGRE_LAZY_MESSAGES_IDLE_MS && Number.isFinite(idleOverride) && idleOverride >= 0)
    lazyMessages = { ...lazyMessages, idleMs: idleOverride, sweepMs: Math.min(60_000, Math.max(250, idleOverride)) };
  const linkStore = createLinkStore({
    dataDir,
    persistenceChanged: (linkId, state) => broadcastProjectState(scopeKey({ kind: "link", linkId }), state),
    active: (linkId, chat) => busyChat(chatKey(scopeKey({ kind: "link", linkId }), chat)),
    lazyMessages: lazy
      ? { ...lazyMessages, unloaded: (linkId, state) => broadcastProjectState(scopeKey({ kind: "link", linkId }), state) }
      : { idleMs: Infinity, sweepMs: 0 },
  });
  const states = new ProjectStates({
    read: async (projectPath) => {
      const stored = await readStoredState(projectPath);
      const discovered = await discoverWorktrees(projectPath);
      return reconcileState(await withWorktreeChats(projectPath, stored, discovered), projectName(projectPath), discovered, await linkStore.ownedWorktrees());
    },
    save: saveProjectState,
    persistenceChanged: broadcastProjectState,
    compact: compactProjectState,
    messages: lazy
      ? {
          directory: (projectPath) => projectPath,
          active: (projectPath, chat) => busyChat(chatKey(projectPath, chat)),
          unloaded: (projectPath, state) => broadcastProjectState(projectPath, state),
          ...lazyMessages,
        }
      : null,
  });

  const linkMembers = new Map();
  const scopeStates = createChatScopes({
    projects: states,
    links: linkStore,
    validateLink: async (id) => {
      const members = await linkWorkspaces.membersAvailable(await linkRuntime.usable(id));
      for (const member of members) await ownProject(member.path);
      linkMembers.set(
        id,
        members.map((member) => member.path),
      );
      return members;
    },
  });
  function broadcastProjectState(projectPath, state) {
    limitResume?.trackState(projectPath, state);
    state = scopeStates.withPersistence(projectPath, state);
    if (isLinkScopeKey(projectPath)) {
      emit("link:state", { linkId: scopeFromKey(projectPath).linkId, state });
      return;
    }
    emit("project:state", { path: projectPath, state });
  }

  async function updateProject(projectPath, change, options) {
    const result = await scopeStates.update(projectPath, change, options);
    if (result.changed) broadcastProjectState(projectPath, result.state);
    return result.state;
  }

  async function editProject(projectPath, change, options) {
    await updateProject(projectPath, change, options);
    await scopeStates.flush(projectPath);
  }

  const diffs = new DiffRefresher({ states, readDiffStat: (...args) => inBackgroundLane(() => readDiffStat(...args)), update: updateProject });

  const projectsWithGit = new Map();
  const readOnce = new Set();
  const resumes = new Map();
  async function readProject(projectPath, { discovered: listed } = {}) {
    await ownProject(projectPath);
    const discovered = listed ?? (await discoverWorktrees(projectPath));
    const live = (sessionId) => {
      const entry = agents.sessions.get(`${projectPath}#${sessionId}`);
      return Boolean(entry && !entry.session.closed);
    };
    const git = !discovered.some((worktree) => worktree.plain);
    projectsWithGit.set(projectPath, git);
    const owned = await linkStore.ownedWorktrees();
    let state = await updateProject(
      projectPath,
      async (current) => {
        if (
          !git &&
          !(chatsHome.isHome(projectPath) && (await isFolderChatsHome(projectPath))) &&
          Object.values(current?.worktrees ?? {}).some((worktree) => worktree.path !== projectPath)
        )
          throw new Error(`${projectName(projectPath)} is no longer a Git repository, so its Worktree Chats can't open. Restore its .git folder.`);
        const next = reconcileState(current, projectName(projectPath), discovered, owned);
        return migrateImages(projectPath, askForUnknownModes(markDisconnectedSubagents(next, new Set(Object.keys(next.sessions).map(Number).filter(live)))));
      },
      { chats: [] },
    );
    if (!resumes.has(projectPath))
      resumes.set(
        projectPath,
        chats.resumeInterrupted(projectPath, state).catch((error) => console.warn("Milagre couldn't resume a chat:", error.message)),
      );
    await resumes.get(projectPath);
    state = await states.get(projectPath);
    if (!readOnce.has(projectPath)) {
      readOnce.add(projectPath);
      chatTitles.resume(projectPath, state);
      void track(() => routines.sweepRunChats(projectPath, state), background);
      void chats.recoverHandoffs(projectPath, state).catch((error) => console.warn("Milagre couldn't recover a handoff:", error.message));
      void subchatEscalation.suggestions
        .closeStale(projectPath, state.sessions)
        .catch((error) => console.warn("Milagre couldn't close a suggestion:", error.message));
      void diffs.refresh(projectPath).catch(() => {});
    }
    return { path: projectPath, name: projectName(projectPath), git, state };
  }

  const { mobileUploads, attachmentTransfers, knownFolder, folderSkillRoots } = createFiles({
    options,
    dataDir,
    version,
    commands,
    environmentReady,
    searchFiles,
    states,
    scopeStates,
    projectSettings: (...args) => projectSettings(...args),
    chats: () => chats,
    linkRuntime: () => linkRuntime,
    linkWorkspaces: () => linkWorkspaces,
    agentCli: (...args) => agentCli(...args),
    accountScopeForFolder: (...args) => accountScopeForFolder(...args),
    recentProjects: (...args) => recentProjects(...args),
  });
  commands.handle("app:version", () => version);
  commands.handle("triage:prepare", (_event, client) => require("./triage.cjs").prepareTriage({ dataDir, version, client }));
  const { worktreeRoot, projectSettings, worktreeAt, openAsProject, readProjectGit, defaultProjectBase, readSetupCommand, readLinearIssue } = createWorktrees({
    options,
    dataDir,
    emit,
    commands,
    background,
    chatsHome,
    diffs,
    environmentReady,
    knownFolder,
    linkStore,
    ownProject,
    readProject,
    states,
    track,
    updateProject,
    git,
    closing: () => closing,
    releaseChat: (chatId) => releaseChat(chatId),
    retireChat: (chatId, how) => retireChat(chatId, how),
    linear: () => linear,
    linearIssues: () => linearIssues,
    worktreeSetups: () => worktreeSetups,
    readPullRequestStateOf: () => readPullRequestStateOf,
    agentCli: (...args) => agentCli(...args),
    markIssueStarted: (...args) => markIssueStarted(...args),
    pruneLinks: (...args) => pruneLinks(...args),
  });
  const readPullRequestStateOf = options.readPullRequestState ?? readPullRequestState;
  const pullRequests = registerPullRequests({ commands, options, states, emit, environmentReady });
  const keepAwake = options.keepAwake ?? new KeepAwake({ powerSaveBlocker: { start: () => 0, isStarted: () => true, stop() {} }, enabled: false });
  commands.handle("app:set-keep-awake", (_event, enabled) => keepAwake.setEnabled(enabled === true));

  let limitSwitch = null;
  let limitResume = null;
  let routines = null;
  let babysitWatch = null;
  let autopilot = null;
  let chatSecrets = null;
  let bugReports = null;
  let subchatEscalation = null;
  function publishAgentEvent(chatId, event, state, seq) {
    if (state) limitResume?.trackState(projectOfKey(chatId), state);
    if (event.limitResumeAborted) {
      void track(() => checkpoints.discard(chatId, event.messageId), background).catch((error) =>
        console.warn("Milagre couldn't discard a cancelled continuation's checkpoint:", error.message),
      );
      emit("agent:event", { chatId, event, ...(state ? { state: scopeStates.withPersistence(projectOfKey(chatId), state) } : {}), ...(seq ? { seq } : {}) });
      return;
    }
    for (const watcher of [routines, babysitWatch, autopilot]) watcher?.observe(chatId, event);
    if (["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type))
      void track(() => checkpoints.finish(chatId), background).catch((error) => console.warn("Checkpoint end capture failed:", error.message));
    if (["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type)) {
      chatSecrets?.cancel(chatId);
      bugReports?.cancel(chatId);
    }
    options.observeAgentEvent?.(chatId, event);
    subchatEscalation?.observe(chatId, event);
    if (event.type === "turn-failed" && event.limit && limitSwitch) {
      const token = chats.limitResumeToken(projectOfKey(chatId), sessionIdFromKey(chatId));
      token.sourceMessageId = state?.sessions[sessionIdFromKey(chatId)]?.limitTurn?.sourceMessageId;
      void Promise.resolve()
        .then(() => limitSwitch.observe(chatId, event, token))
        .then((switched) => !switched && limitResume?.observe(chatId, event, token))
        .catch((error) => console.warn("Milagre couldn't continue after a usage limit:", error.message));
    }
    if (wakesSnoozed(event)) {
      needsUserAt.delete(chatId);
      needsUserAt.set(chatId, ++needsUserCount);
      if (needsUserAt.size > NEEDS_USER_CHATS) needsUserAt.delete(needsUserAt.keys().next().value);
      void track(() => wakeSnoozedChat(projectOfKey(chatId), sessionIdFromKey(chatId)), background).catch((error) =>
        console.warn("Milagre couldn't wake a snoozed Chat:", error.message),
      );
    }
    void notifyIfWaiting(chatId, event).catch(() => {});
    if (!isLinkScopeKey(projectOfKey(chatId))) diffs.observe(chatId, event);
    if (pullRequests.watching && isTurnEnd(event) && !isLinkScopeKey(projectOfKey(chatId))) {
      const folder = states.chatWorktreePath(projectOfKey(chatId), sessionIdFromKey(chatId));
      if (folder) pullRequests.poke(folder);
    }
    if (!isLinkScopeKey(projectOfKey(chatId)))
      void track(() => linked.observe(chatId, event), background).catch((error) => console.warn("Milagre couldn't follow a Delegation:", error.message));
    if (event.type === "turn-failed" && event.login) {
      for (const name of PROVIDERS) if (event.message === loginMessage(name)) agentCliStatus.invalidate(name);
    }
    if (["turn-completed", "turn-failed", "turn-cancelled", "permission-resolved", "question-resolved"].includes(event.type))
      void advisorDelivery?.drain(chatId).catch((error) => console.warn("Advisor delivery failed:", error.message));
    emit("agent:event", { chatId, event, ...(state ? { state: scopeStates.withPersistence(projectOfKey(chatId), state) } : {}), ...(seq ? { seq } : {}) });
  }

  const agents = new SessionManager({
    createSession:
      options.createSession ??
      ((provider, options) => {
        const withMcp = { ...options, mcpExtras: () => mcp.forSession(provider, options.accountId ?? "default") };
        return provider === "codex"
          ? new CodexSession({ ...withMcp, clientVersion: version })
          : provider === "antigravity"
            ? new AcpSession({ ...withMcp, clientVersion: version, config: antigravityAcp })
            : provider === "kiro"
              ? new AcpSession({ ...withMcp, clientVersion: version, config: kiroAcp })
              : new ClaudeSession({ ...withMcp, defaultConfigDir: accounts.directory("claude", "default") });
      }),
    linkedFor: (chatId) => linked.forChat(chatId),
    onTurnStarted: () => ports.wake(),
    hostInstructions: () => {
      try {
        return hostNetworkInstructions(options.hostNetwork?.() ?? {});
      } catch {
        return "";
      }
    },
    send: (chatId, event) => void hold(chats.receive(chatId, event), background),
  });

  const ports = new PortWatcher({
    isRunning: () => terminals.size > 0 || [...agents.sessions.values()].some((entry) => entry.session.turnActive) || Boolean(advisors?.processes().size),
    roots: () => {
      const roots = agentProcesses();
      for (const [chatId, shells] of terminals.shells()) roots.set(chatId, { ...roots.get(chatId), shells });
      return roots;
    },
    publish: (next) => {
      emit("agent:ports", next);
    },
  });
  commands.handle("agent:ports", () => ports.snapshot());
  commands.handle("chat:ports", (_event, chatId) => {
    if (typeof chatId !== "string" || !chatId) throw new Error("A Chat is required to list ports.");
    const snapshot = ports.snapshot();
    return { chatId, ports: Object.hasOwn(snapshot, chatId) ? snapshot[chatId] : [] };
  });
  commands.handle("agent:stop-port", (_event, chatId, pid) => (typeof chatId === "string" && Number.isInteger(pid) ? ports.stopPort(chatId, pid) : false));

  const agentNotes = new Map();
  const deviceNotes = require("./runtime/device-notes.cjs").registerDeviceNotes({ commands, dataDir, emit });
  const sentFromNotes = createSentFromNotes({ enabled: () => deviceNotes.enabled() });
  const turnDefaults = require("./turn-defaults.cjs").createTurnDefaults({ file: path.join(dataDir, "turn-defaults.json") });
  async function startAgentTurn(request) {
    const cancelled = () =>
      closing ||
      (request.canStart && !request.canStart()) ||
      (request.expectedAccountId !== undefined && taskAccounts.selected(request.chatId, request.provider) !== request.expectedAccountId);
    if (cancelled()) return { turnId: null, steered: false, cancelled: true };
    const permissionMode = request.permissionMode ?? agents.permissionMode(request.chatId, "ask");
    if (permissionMode !== "full") await advisors?.stopExecution(request.chatId);
    else advisors?.resumeExecution(request.chatId);
    const linkedContext = agents.isTurnActive(request.chatId) ? Promise.resolve("") : linked.context(request.chatId);
    const images = decodeImages(request.images);
    const prompt =
      options.expandSkills === false ? request.prompt : await expandSkillPrompt(await folderSkillRoots(request.cwd).catch(() => request.cwd), request.prompt);
    const cli = agents.activeAccount(request.chatId, request.provider) ?? (await taskAccounts.cli(request.chatId, request.provider));
    if (cancelled() || (request.expectedAccountId !== undefined && cli.accountId !== request.expectedAccountId))
      return { turnId: null, steered: false, cancelled: true };
    if (cli.problem) {
      await chats.receive(request.chatId, failedWith(cli.problem));
      return { turnId: null, steered: false };
    }
    if (cancelled()) return { turnId: null, steered: false, cancelled: true };
    const setupNotes = [];
    for (const cwd of request.workspaceRoots ?? [request.cwd]) {
      const setup = await worktreeSetups.beforeTurn(request.chatId, cwd);
      if (cancelled() || setup.cancelled) {
        if (request.canStart) return { turnId: null, steered: false, cancelled: true };
        await chats.receive(request.chatId, { type: "turn-cancelled" });
        return { turnId: null, steered: false, cancelled: true };
      }
      if (setup.failed) {
        await chats.receive(request.chatId, failedWith(setup.note || "Worktree setup did not finish."));
        return { turnId: null, steered: false };
      }
      if (setup.note) setupNotes.push(setup.note);
    }
    const context = agents.isTurnActive(request.chatId) ? "" : await linkedContext;
    const reports = agents.isTurnActive(request.chatId) ? null : await linked.reportsForTurn(request.chatId);
    const milagreNotes = agentNotes.get(request.chatId) ?? [];
    agentNotes.delete(request.chatId);
    const mentions = await chatMentionsContext(request, (key) => scopeStates.get(key)).catch(() => "");
    const computerMentions = await computerMentionsContext(request, {
      remote,
      thisMac: options.hostNetwork?.().name ?? remoteComputers?.thisMac(),
    }).catch(() => "");
    const branchNotes = await Promise.all(
      (request.projectRoots ?? [projectOfKey(request.chatId)]).map(async (projectPath) => {
        try {
          return branchPolicyNote(projectPath, (await readProjectGit(projectPath)).effective);
        } catch (error) {
          return `Project Git rules for ${projectPath} could not be read: ${error.message}. Fix the configuration before creating or renaming a branch.`;
        }
      }),
    );
    const text = [prompt, ...branchNotes, ...setupNotes, ...milagreNotes, context, mentions, computerMentions, reports?.text].filter(Boolean).join("\n\n");
    try {
      if (cancelled()) {
        if (request.canStart) return { turnId: null, steered: false, cancelled: true };
        await chats.receive(request.chatId, { type: "turn-cancelled" });
        return { turnId: null, steered: false, cancelled: true };
      }
      const started = await agents.startTurn({
        ...request,
        prompt: text,
        images,
        command: cli.command,
        env: cli.env,
        harness: cli.harness,
        args: cli.args,
        accountId: cli.accountId,
        ...(request.expectedAccountId !== undefined ? { canStart: () => !cancelled() } : {}),
      });
      if (started?.turnId) await reports?.delivered();
      else if (milagreNotes.length) agentNotes.set(request.chatId, [...milagreNotes, ...(agentNotes.get(request.chatId) ?? [])]);
      return started;
    } catch (error) {
      if (milagreNotes.length) agentNotes.set(request.chatId, [...milagreNotes, ...(agentNotes.get(request.chatId) ?? [])]);
      throw error;
    } finally {
      reports?.release();
    }
  }

  const chats = new ChatHost({
    assertWritable: (...args) => canvasChatModes.assertWritable(...args),
    interrupt: (chatId) => stopChat(chatId),
    ...(options.limitResume?.now ? { now: options.limitResume.now } : {}),
    contextSettings: () => contextSettings.read(),
    beforeTask: (request) => checkpoints.begin(request).catch((error) => console.warn("Checkpoint start capture failed:", error.message)),
    beforeSend: async (request) => {
      Object.assign(request, turnDefaults.resolve(request));
      request.images = await mobileUploads.resolveImages(request.projectPath, request.images);
      await mobileUploads.claim(request);
      if (request.sessionId != null && request.context?.kind !== "compaction" && (!request.canStart || request.canStart())) {
        const chatId = chatKey(request.projectPath, request.sessionId);
        const accountId = accounts.selected(request.provider, request.projectPath);
        await agents.releaseLimited(chatId, request.provider, accountId, async () => {
          const session = (await scopeStates.get(request.projectPath)).sessions[request.sessionId];
          await chats.receive(chatId, { type: "background-tasks", tasks: [] });
          for (const agent of session?.subagents ?? []) {
            if (agent.source !== "milagre-advisor" && ["running", "initializing", "waiting"].includes(agent.status))
              await chats.receive(chatId, { type: "subagent-update", agent: { ...agent, status: "cancelled", endedAt: Date.now(), updatedAt: Date.now() } });
          }
          agentNotes.set(chatId, [
            ...(agentNotes.get(chatId) ?? []),
            "The previous account hit its usage limit. Its background tasks were stopped to switch accounts or providers. Check their saved progress and restart unfinished work as needed.",
          ]);
        });
      }
      if (request.context?.kind !== "advisor-result" && request.sessionId != null) await advisorDelivery?.resume(`${request.projectPath}#${request.sessionId}`);
    },
    onUnblocked: (chatId) => {
      void advisorDelivery?.drain(chatId).catch((error) => console.warn("Advisor delivery failed:", error.message));
    },
    onQueuedStart: (chatId, entry, started) => {
      if (!["delegation", "delegation-report"].includes(entry.context?.kind) || isLinkScopeKey(projectOfKey(chatId))) return;
      void linked.queuedStarted(chatId, entry.context, started).catch((error) => console.warn("Milagre couldn't follow a Delegation:", error.message));
    },
    onQueuedRemoved: (chatId, entry) => {
      if (!["delegation", "delegation-report"].includes(entry?.context?.kind) || isLinkScopeKey(projectOfKey(chatId))) return;
      void linked.queuedRemoved(chatId, entry.context).catch((error) => console.warn("Milagre couldn't follow a Delegation:", error.message));
    },
    states: scopeStates,
    startTurn: (request) => track(() => startAgentTurn(request), starting),
    readSubagents: async ({ cwd, agents, projectPath, provider = "codex", nativeSessionId }) => {
      if (provider === "antigravity") {
        const cli = await agentCli("antigravity", projectPath).catch(() => null);
        return recoverAntigravitySubagents({ home: cli?.env?.GEMINI_HOME, parentId: nativeSessionId, agents });
      }
      const cli = await agentCli("codex", projectPath);
      return cli.problem ? [] : recoverCodexSubagents({ cwd, agents, command: cli.command, env: cli.env, clientVersion: version });
    },
    nameChat: (projectPath, sessionId) => chatTitles.name(projectPath, sessionId),
    publish: publishAgentEvent,
    broadcast: broadcastProjectState,
    isFocused: () => isFocused(),
    isChatFocused: options.isChatFocused,
    handoverTools: {
      writeTranscript: (input) => track(() => writeTranscript({ ...input, dir: path.join(dataDir, "handovers") }), background),
      brief: ({ cwd, worktrees, projectPath, ...input }) =>
        generateBrief(
          {
            ...input,
            changedFiles: async () =>
              worktrees
                ? (
                    await Promise.all(
                      worktrees.map(async (member) =>
                        (await git.text(member.worktreePath, ["status", "--porcelain"]))
                          .split("\n")
                          .filter(Boolean)
                          .map((line) => `${member.alias}/${line.slice(3)}`),
                      ),
                    )
                  ).flat()
                : (await git.text(cwd, ["status", "--porcelain"]))
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => line.slice(3)),
          },
          { models: createHandoverModels({ cli: (provider) => agentCli(provider, projectPath), clientVersion: version }) },
        ),
    },
  });

  async function wakeTurn(chatId) {
    const latest = chats.turnSettings(chatId);
    if (latest) return latest;
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    const state = await scopeStates.load(projectPath, [sessionId]);
    const model = require("@milagre/shared/agent-runs").lastUserModel(state, sessionId);
    if (!model) throw new Error("That Chat has no model to wake on.");
    return { provider: state.sessions[sessionId].provider ?? "claude", model, permissionMode: state.sessions[sessionId].permissionMode ?? "ask" };
  }
  subchatEscalation = new SubchatEscalation({
    ...options.subchatEscalation,
    ports: {
      read: (projectPath, sessionIds) => (sessionIds.length ? scopeStates.load(projectPath, sessionIds) : scopeStates.get(projectPath)),
      run: (chatId) => chats.runs[chatId],
      busy: (chatId) =>
        !chats.limitTurnIdle(projectOfKey(chatId), sessionIdFromKey(chatId)) || agents.isTurnActive(chatId) || agents.backgroundWork(chatId) > 0,
      isSeen: (chatId) => (options.isChatSeen ?? options.isChatFocused)?.(chatId) ?? (chats.openChat === chatId && isFocused()),
      isWakeTurn: (chatId) => chats.wakeTurns.has(chatId),
      post: (chatId, note, change) => chats.postNow(chatId, note, change),
      remind: async (chatId, { requestId, title, body }) => {
        if (!(await projectSettings().hiddenPaths()).has(projectOfKey(chatId)))
          options.notifyWaiting?.({ chatId, requestId: `reminder:${requestId}`, title, body });
      },
      wake: async (chatId, message) => {
        const { started } = await chats.send({
          ...(await wakeTurn(chatId)),
          ...message,
          projectPath: projectOfKey(chatId),
          sessionId: sessionIdFromKey(chatId),
          images: [],
          files: [],
          idleOnly: true,
        });
        void started.catch((error) => console.warn("Milagre couldn't start a wake's turn:", error.message));
      },
      mode: (chatId, session) => chats.turnSettings(chatId)?.permissionMode ?? session.permissionMode ?? "ask",
    },
  });

  let routineHooks = null;
  const projectStateReadOnly = (projectPath) => (states.has(projectPath) ? states.get(projectPath) : readRawState(projectPath));
  const titleModels = (projectPath) =>
    options.titleModels ?? createChatTitleModels({ cli: (provider) => agentCli(provider, projectPath), clientVersion: version });
  const heldState = (scope) =>
    isLinkScopeKey(scope) ? (linkStore.has(scopeFromKey(scope).linkId) ? linkStore.cached(scopeFromKey(scope).linkId) : undefined) : states.states.get(scope);
  routines = createRoutines({
    file: path.join(dataDir, "routines.json"),
    chats,
    emit,
    cachedState: heldState,
    openState: async (scope, sessionId) => {
      await linkedState(scope);
      return scopeStates.load(scope, [sessionId]);
    },
    isClosing: () => closing,
    worktrees: {
      create: async (request) => ({ worktreeId: (await handlers.get("worktree:create")({}, request)).worktreeId }),
      remove: (projectPath, worktreeId, chatId) =>
        track(async () => {
          const worktree = (await states.get(projectPath)).worktrees[worktreeId];
          if (worktree) await handlers.get("worktree:remove")({}, worktree.path, { projectPath, ...(chatId ? { chatId } : {}) });
        }, background),
      async removable(projectPath, worktreeId) {
        if (!states.has(projectPath)) return false;
        const worktree = (await states.get(projectPath)).worktrees[worktreeId];
        if (!worktree?.base || worktree.path === projectPath) return false;
        await environmentReady;
        return (await worktreeStatus(worktree.path, worktree.base).catch(() => null))?.removable === true;
      },
      retire: (projectPath, worktreeId, chatIds) =>
        track(
          () =>
            retireRunWorktree({
              projectPath,
              worktreeId,
              chatIds,
              state: async (scope) => (states.has(scope) ? states.get(scope) : null),
              busy: (chatKey) => Boolean(chats.runs?.[chatKey] || chats.startingTurns?.has(chatKey) || chats.isBusy?.(chatKey)),
              status: async (worktree) => {
                await environmentReady;
                return worktreeStatus(worktree.path, worktree.base).catch(() => null);
              },
              hasRemote: async (worktree) => Boolean((await git.text(worktree.path, ["remote"])).trim()),
              openPullRequest: async (worktree) => {
                const lookup = await readPullRequestStateOf(worktree.path).catch(() => ({ known: false, pr: null }));
                return { known: lookup.known, open: lookup.pr?.state === "OPEN" };
              },
              closeChat: (chatKey) => releaseChat(chatKey),
              retireChat: (chatKey) => retireChat(chatKey, { mode: "run-cleanup" }),
              moveChats: (scope, sessionIds, change) => moveRunChats(scope, sessionIds, change),
              remove: async (worktree) => {
                const result = await handlers.get("worktree:remove")({}, worktree.path, { projectPath });
                if (!result?.removed && !result?.alreadyRemoved) throw new Error("The Worktree wasn't removed.");
              },
            }),
          background,
        ),
      base: defaultProjectBase,
      projectWorktree: async (projectPath) => Object.values((await linkedState(projectPath)).worktrees).find((worktree) => worktree.path === projectPath)?.id,
    },
    archiveChat: (chatId) => track(() => archiveChat(projectOfKey(chatId), sessionIdFromKey(chatId)), background),
    keepChat: (chatId) => keepRunChat(projectOfKey(chatId), sessionIdFromKey(chatId)),
    chatMessages: (projectPath, sessionIds) => scopeStates.chatMessages(projectPath, sessionIds),
    markRunChats: async (projectPath, decided) => {
      if (!scopeStates.has(projectPath)) return;
      await updateProject(projectPath, (state) => withRunChatsHidden(state, decided, (routine) => routine.hidden === undefined), { chats: [] });
    },
    archiveRunChat: (chatId, runId) => track(() => archiveRunChat(projectOfKey(chatId), sessionIdFromKey(chatId), runId), background),
    fallbackFor: async ({ provider, projectPath }) => {
      const services = routing.services(projectPath, routing.selection(projectPath));
      const [status, models] = await Promise.all([
        options.agentCliStatus ? options.agentCliStatus() : services.status(),
        options.agentModels ? options.agentModels() : services.models(),
      ]);
      return defaultFallback(provider, status, models);
    },
    linear: () => linear,
    hooks: () =>
      (routineHooks ??= { store: createHookStore({ file: path.join(dataDir, "routine-hooks.json") }), relayUrl: options.hookRelayUrl ?? HOOK_RELAY_URL }),
    projects: async () => [...(await projectRegistry().list()), ...(await chatsHomeEntries())],
    projectState: (projectPath) => projectStateReadOnly(projectPath),
    generateRunTitle: (request) => generateRunTitle(request, { models: titleModels(request.projectPath), isClosing: () => closing }),
    linearIssues: () => linearIssues,
    linearTools: () => linearTools,
    stopChat: (chatId) => stopChat(chatId),
    notifyWaiting: (notice) => options.notifyWaiting?.(notice),
    timers: options.routines,
  });
  routines.start();
  commands.handle("routines:enabled:read", () => ({ enabled: true }));
  commands.handle("routines:enabled:save", () => ({ enabled: true }));
  const { keybindings, computerResources, contextSettings, babysitSettings, doneSettings } = registerSettingsCommands({
    commands,
    dataDir,
    emit,
    worktreeRoot,
    chatsHome,
    projectRegistry: () => projectRegistry(),
    chats,
    scopeStates,
    heldState,
    routines: () => routines,
  });
  commands.handle("storage:worktrees", async () => {
    await environmentReady;
    const projects = [...(await projectRegistry().list()), ...(await chatsHomeEntries())];
    const worktrees = await idleWorktrees({
      projects: projects
        .filter((project, index) => projects.findIndex((other) => other.path === project.path) === index)
        .map((project) => ({ path: project.path, name: project.name || projectName(project.path) })),
      readState: projectStateReadOnly,
      roots: await handlers.get("worktree:roots")({}),
      linkOwned: await linkStore.ownedWorktrees(),
      busy: (chatId) => Boolean(chats.runs[chatId]) || chats.startingTurns.has(chatId) || chats.isBusy(chatId),
      titleOf: (session) => chatTitle(session),
      openAsProject,
      status: worktreeStatus,
      bytesOf: (folder) => computerResources.worktreeBytes(folder),
    });
    return { worktrees, measuredAt: computerResources.measuredAt() };
  });
  commands.handle("storage:remove-worktree", async (_event, request) => {
    const { projectPath, path: worktreePath, seen, force, activity, idleBefore, lastAt } = request && typeof request === "object" ? request : {};
    if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) throw new Error("An absolute Project path is required.");
    if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) throw new Error("An absolute worktree path is required.");
    if (!states.has(projectPath)) await openProject(projectPath, { takeNotice: false, focus: false, remember: false, register: false });
    await environmentReady;
    await ownProject(projectPath);
    let result = { removed: false, alreadyRemoved: true, branch: null, branchDeleted: false };
    let keys = [];
    await editProject(
      projectPath,
      async (state) => {
        const worktree = worktreeAt(state, worktreePath);
        if (!worktree) return state;
        if (!worktree.base) throw new Error(`Milagre didn't create ${worktreePath}, so it is kept.`);
        const owned = await linkStore.ownedWorktrees();
        if (owned.has(worktreePath)) throw new Error("This Worktree belongs to a shared Link Chat. Archive the Chat to hide it.");
        if (await openAsProject(worktreePath)) throw new Error(`${worktreePath} is open as a project, so it is kept.`);
        const busy = (id) => {
          const key = `${projectPath}#${id}`;
          return Boolean(chats.runs[key]) || chats.startingTurns.has(key) || chats.isBusy(key) || worktreeSetups.running.has(key);
        };
        const check = () => assertIdleWorktree({ state, worktree, activity, idleBefore, lastAt, busy });
        await check();
        keys = Object.values(state.sessions)
          .filter((session) => session.worktree_id === worktree.id)
          .map((session) => `${projectPath}#${session.id}`);
        result = await removeWorktree({
          path: worktreePath,
          root: worktreeRoot(),
          projectPath,
          base: worktree.base,
          seen,
          force: force === true,
          closeSession: async () => {
            await check();
            for (const key of keys) await releaseChat(key);
          },
        });
        return reconcileState(
          state,
          projectName(projectPath),
          Object.values(state.worktrees).filter((item) => item.id !== worktree.id),
          owned,
        );
      },
      { chats: [] },
    );
    if (result.removed) {
      for (const key of keys) await retireChat(key, { mode: "worktree-removal" });
      await worktreeSetups.forget(worktreePath);
      await pruneLinks();
    }
    return result;
  });
  babysitWatch = createBabysitWatch({ settings: babysitSettings, routines });
  commands.handle("routines:list", () => routines.list());
  commands.handle("routines:update", (_event, id, patch) => routines.update(id, patch));
  commands.handle("routines:delete", (_event, id) => routines.remove(id));
  commands.handle("routines:run-now", (_event, id) => routines.runNow(id));
  commands.handle("routines:flow-act", (_event, _routineId, runId, action, options) => routines.flowAct(runId, action, options));
  commands.handle("routines:flow-test", (_event, id) => routines.flowTest(id));
  commands.handle("routines:create", async (_event, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A Routine needs its settings.");
    const routine = await routines.create(input);
    return routine.trigger.kind === "webhook" ? { routine, hookUrl: routines.hook(routine.id).url } : { routine };
  });
  commands.handle("routines:hook", (_event, id) => routines.hook(id));
  commands.handle("routines:rotate-hook", (_event, id) => routines.rotateHook(id));
  commands.handle("routines:targets", async (_event, filter) => {
    const within = typeof filter?.within === "string" && path.isAbsolute(filter.within) ? filter.within : null;
    const projects = (await projectRegistry().list()).filter((project) => !within || project.path === within || project.path.startsWith(within + path.sep));
    return {
      projects: await Promise.all(
        projects.map(async (project) => {
          const state = await Promise.resolve(projectStateReadOnly(project.path)).catch(() => null);
          const chats = Object.values(state?.sessions ?? {})
            .filter((session) => !session.archived && !isHiddenRunChat(session) && !isHiddenTaskChat(session) && (session.summary?.count ?? 0) > 0)
            .toSorted((a, b) => (b.summary?.lastAt ?? 0) - (a.summary?.lastAt ?? 0) || b.id - a.id)
            .slice(0, ROUTINE_TARGET_CHATS)
            .map((session) => ({ chatId: chatKey(project.path, session.id), title: chatTitle(session), lastAt: session.summary?.lastAt ?? 0 }));
          return { path: project.path, name: project.name || projectName(project.path), chats };
        }),
      ),
    };
  });

  busyChat = (chatId) => chats.isBusy(chatId) || Boolean(options.isChatFocused?.(chatId));

  const setupReview = new SetupReview({ read: readSetupCommand, settings: projectSettings, send: (chatId, event) => chats.receive(chatId, event) });
  const worktreeSetups = new WorktreeSetups({
    send: (chatId, event) => void chats.receive(chatId, event),
    file: path.join(dataDir, "worktree-setups.json"),
    review: (request) => setupReview.review(request),
  });

  const { antigravity, baseCli, accounts, routing, agentCli, mcp, linear, linearIssues, linearTools, queueAccountMutation } = createAccountsWiring({
    options,
    dataDir,
    emit,
    commands,
    version,
    environmentReady,
    readProject,
  });

  const chatTitles = new ChatTitles({
    states: scopeStates,
    update: updateProject,
    generate: (request) => generateChatTitle(request, { models: titleModels(request.projectPath) }),
  });

  const usage = createUsage({
    options,
    dataDir,
    emit,
    commands,
    environmentReady,
    accounts,
    baseCli,
    validateAccountScope: (...args) => validateAccountScope(...args),
  });
  registerTokenUsage({
    options,
    dataDir,
    emit,
    commands,
    accounts,
    projectRegistry: () => projectRegistry(),
    chatsHome,
    projectStateReadOnly,
    linkStore,
    readRawState,
    worktreeRoot,
  });

  registerGitHandlers(commands, {
    cli: async (name, cwd) => agentCli(name, await accountScopeForFolder(cwd)),
    ready: () => environmentReady,
    clientVersion: version,
    knownFolders: () => scopeStates.worktreePaths(),
    pullRequestChanged: (folder) => pullRequests.poke(folder),
  });

  const checkpoints = registerCheckpoints(commands, {
    directory: path.join(dataDir, "checkpoints"),
    assertWritable: async (chatId) => {
      const scope = projectOfKey(chatId);
      const state = await scopeStates.get(scope);
      const session = state.sessions[sessionIdFromKey(chatId)];
      canvasChatModes.assertWritable(scope, state, session, state.worktrees?.[session?.worktree_id]);
    },
    states: scopeStates,
    ready: () => environmentReady,
    busy: (chatId) => chats.isBusy(chatId) || agents.isTurnActive(chatId) || Boolean(agents.sessions.get(chatId)?.activeChildren?.size),
    note: (chatId, message) => chats.addNote(chatId, message),
    tell: (chatId, text) => agentNotes.set(chatId, [...(agentNotes.get(chatId) ?? []), text]),
  });

  const {
    stopChat,
    respondPermission,
    answerQuestion,
    setPermissionMode,
    sendAsUser,
    linearIssueMessage,
    markIssueStarted,
    archiveChat,
    moveRunChats,
    retireChat,
    releaseChat,
    archiveRunChat,
    keepRunChat,
    patchChat,
    wakeSnoozedChat,
    archiveDoneChat,
    readOpenChat,
    agentCliStatus,
  } = registerChatLifecycle({
    options,
    emit,
    commands,
    handlers,
    agentCli,
    agents,
    antigravity,
    background,
    chats,
    editProject,
    environmentReady,
    existingChat,
    heldState,
    linear,
    linearIssues,
    linkStore,
    mobileUploads,
    needsUserAt,
    projectName,
    readLinearIssue,
    routing,
    scopeStates,
    sentFromNotes,
    setupReview,
    states,
    track,
    turnDefaults,
    updateProject,
    worktreeSetups,
    terminals,
    artifacts,
    computerUseScreen,
    pageComments,
    advisorDelivery: () => advisorDelivery,
    advisors: () => advisors,
    btw: () => btw,
    bugReports: () => bugReports,
    canvasChatModes: () => canvasChatModes,
    chatSecrets: () => chatSecrets,
    linkRuntime: () => linkRuntime,
    linked: () => linked,
    needsUserCount: () => needsUserCount,
    routines: () => routines,
    subchatEscalation: () => subchatEscalation,
    validateAccountScope: (...args) => validateAccountScope(...args),
  });
  async function notifyIfWaiting(chatId, event) {
    const projectPath = projectOfKey(chatId);
    if (!options.notifyWaiting || !scopeStates.has(projectPath) || !("requestId" in event)) return;
    if ((await projectSettings().hiddenPaths()).has(projectPath)) return;
    const notice = attentionNotice(
      event,
      attentionContext(
        await scopeStates.get(projectPath),
        isLinkScopeKey(projectPath) ? (await linkRuntime.definition(scopeFromKey(projectPath).linkId)).name : projectName(projectPath),
        sessionIdFromKey(chatId),
      ),
    );
    if (notice) options.notifyWaiting({ chatId, requestId: event.requestId, ...notice });
  }

  let shownProjectPath = null;
  let recentStore = null;
  const recentProjects = () => (recentStore ??= createRecentProjects(path.join(dataDir, "recent-projects.json")));
  let registryStore = null;
  const projectRegistry = () =>
    (registryStore ??= createProjectRegistry(path.join(dataDir, "project-registry.json"), options.registryRoots ? { roots: options.registryRoots } : {}));
  async function canvasActiveWorktrees() {
    const projects = await projectRegistry().list();
    return Object.fromEntries(
      await Promise.all(projects.map(async (project) => [project.id, (await registeredWorktrees(project)).map((worktree) => worktree.path)])),
    );
  }
  async function pruneLinks(active) {
    const removed = await projectRegistry().pruneLinks(active ?? (await canvasActiveWorktrees()));
    for (const link of removed) await linked.linkRemoved(link.id);
    if (removed.length) await linksChanged();
  }
  async function linksChanged() {
    const links = await canvasChatModes.describe((await projectRegistry().snapshot()).links);
    emit("canvas:links-changed", { links });
    return links;
  }
  async function linkedState(projectPath) {
    if (isLinkScopeKey(projectPath)) return linkStore.get(projectPath.slice("milagre-link:".length));
    if (states.has(projectPath)) {
      const cached = await states.get(projectPath);
      const known = new Set(Object.values(cached.worktrees).map((worktree) => worktree.path));
      const missingReference = linkStore
        .ids()
        .some((id) =>
          Object.values(linkStore.cached(id)?.sessions ?? {}).some((session) =>
            session.worktrees.some((member) => member.projectPath === projectPath && !known.has(member.worktreePath)),
          ),
        );
      if (!missingReference) return cached;
    }
    return (await readProject(projectPath)).state;
  }
  const linkedMessages = async (projectPath, chatIds) => {
    await linkedState(projectPath);
    return chatIds ? scopeStates.chatMessages(projectPath, chatIds) : scopeStates.allMessages(projectPath);
  };
  const planTools = require("./chat-plan-tools.cjs").createChatPlanTools({
    read: (chatId) => chats.plan(chatId),
    update: (chatId, change) => chats.updatePlan(chatId, change),
  });
  chatSecrets = require("./chat-secrets.cjs").createChatSecrets({
    directory: path.join(dataDir, "chat-secrets"),
    send: (chatId, event) => chats.receive(chatId, event),
    active: (chatId) => Boolean(chats.runs[chatId]) && !closing,
  });
  bugReports = createBugReportsForRuntime();
  function createBugReportsForRuntime() {
    const os = require("node:os");
    const reports = require("./bug-reports.cjs");
    const override = process.env.MILAGRE_BUG_REPORT_REPO;
    const { providerName } = require("@milagre/shared/providers");
    let osLine;
    return reports.createBugReports({
      send: (chatId, event) => chats.receive(chatId, event),
      active: (chatId) => Boolean(chats.runs[chatId]) && !closing,
      ...(override && /^[\w.-]+\/[\w.-]+$/.test(override) ? { repo: override } : {}),
      ...(options.postBugReport ? { post: options.postBugReport } : {}),
      readLog: () => reports.readHostLog(path.join(dataDir, "daemon.log")),
      async facts(chatId) {
        const turn = chats.turns.get(chatId);
        osLine ??= reports.osDescription();
        return {
          version,
          os: await osLine,
          ...(turn?.provider ? { provider: providerName(turn.provider) } : {}),
          ...(typeof turn?.model === "string" ? { model: turn.model } : {}),
          ...(turn?.effort ? { effort: turn.effort } : {}),
          ...(turn?.permissionMode ? { permissionMode: turn.permissionMode } : {}),
          ...(turn?.guard?.level ? { babysit: turn.guard.level } : {}),
        };
      },
      async known(chatId) {
        const projectPath = projectOfKey(chatId);
        const quiet = (promise, fallback, ms = 3000) =>
          Promise.race([Promise.resolve(promise).catch(() => fallback), new Promise((resolve) => setTimeout(resolve, ms, fallback).unref?.())]);
        const [registered, recent, state] = await Promise.all([
          quiet(
            projectRegistry()
              .snapshot()
              .then((snapshot) => snapshot.projects),
            [],
          ),
          quiet(recentProjects().list(), []),
          quiet(scopeStates.has(projectPath) ? scopeStates.get(projectPath) : null, null),
        ]);
        const projects = [...registered, ...recent, { path: projectPath }]
          .filter((project) => typeof project?.path === "string" && path.isAbsolute(project.path))
          .slice(0, 200);
        const withOrigin = await Promise.all(projects.map(async (project) => ({ ...project, origin: await quiet(projectOrigin(project.path), null) })));
        const identity = path.isAbsolute(projectPath) ? await quiet(reports.gitIdentity(projectPath), {}) : {};
        return reports.knownValues({
          projects: withOrigin,
          state,
          computers: [options.hostNetwork?.().name, ...quietList(() => remoteComputers?.list() ?? []).map((computer) => computer?.name)],
          hostname: os.hostname(),
          home: os.homedir(),
          username: quietList(() => [os.userInfo().username])[0],
          gitName: identity.name,
          gitEmail: identity.email,
        });
      },
    });
  }
  function quietList(read) {
    try {
      return read();
    } catch {
      return [];
    }
  }
  const remoteDelegation = require("./design-settings.cjs").createDesignSettings(path.join(dataDir, "remote-delegation.json"), {
    name: "Delegating to other computers",
    missing: false,
  });
  const remoteComputers = options.remoteComputers ?? null;
  const remote = remoteComputers && {
    enabled: () => remoteDelegation.enabled(),
    list: () => remoteComputers.list(),
    computer: (name) => {
      const wanted = String(name ?? "").trim();
      const computers = remoteComputers.list();
      return computers.find((item) => item.id === wanted) ?? computers.find((item) => item.name.toLowerCase() === wanted.toLowerCase()) ?? null;
    },
    invoke: (id, method, args) => remoteComputers.invoke(id, method, args),
    thisMac: () => remoteComputers.thisMac(),
  };
  const linked = createLinkedWorktrees({
    dataDir,
    remote,
    createWorktree: async (projectPath, prompt) => {
      const baseBranch = await defaultProjectBase(projectPath);
      const { project, worktreeId } = await handlers.get("worktree:create")({}, { projectPath, baseBranch, prompt });
      const worktree = project.state.worktrees[worktreeId];
      return { path: worktree.path, branch: worktree.name };
    },
    registry: projectRegistry,
    grantedProjects: (chatId) => localMcp.grantedProjects(chatId),
    linkProjects: async (linkId) => {
      const link = await linkRuntime.definition(linkId);
      const projects = await projectRegistry().list();
      return link.projectIds.map((id) => projects.find((project) => project.id === id)).filter(Boolean);
    },
    project: linkedState,
    messages: linkedMessages,
    bodies: async (projectPath, chatIds) => {
      await linkedState(projectPath);
      return scopeStates.searchableMessages(projectPath, chatIds);
    },
    chats,
    agents,
    emit,
    chatTools: (chatId, tools) =>
      tools.map((tool) => ({
        ...tool,
        run: async (input) => {
          const reason = agents.escalationDenial(chatId, { name: tool.name, input, readOnly: tool.readOnly === true });
          if (reason) throw new Error(reason);
          return tool.run(input);
        },
      })),
    pendingAdvisorResults: async (chatId) =>
      (await advisorStore.read(chatId)).some((record) => record.completions?.some((result) => ["pending", "sending"].includes(result.delivery))),
    extraTools: (chatId) => [
      ...planTools.definitions(chatId),
      ...chatSecrets.definitions(chatId),
      ...bugReports.definitions(chatId),
      ...simulatorToolDefinitions(chatId, simulators),
      ...(simlockSettings.read().enabled
        ? require("./chat-simulators.cjs").simlockToolDefinitions(chatId, {
            models: () => simlock.models(),
            lease: (request) => leaseSimlock({ ...request, chatId }),
            release: (request) => releaseSimlock(request),
            get: (deviceId) => simlock.get(deviceId),
          })
        : []),
      ...(computerUseSettings.read().enabled ? computerUse.definitions(chatId) : []),
      ...require("./chat-browsers.cjs").browserToolDefinitions(chatId, browsers),
      ...pageCommentToolDefinitions(chatId, pageComments),
      ...require("./chat-browser-tools.cjs").browserPageToolDefinitions(
        chatId,
        browsers,
        {
          openInPanel: (target, url) => emit("browser-panel:open", { chatId: target, url }),
          closePage: async (target, id) => emit("browser-panel:close-page", { chatId: target, pageId: id }),
          closeAll: async (target) => emit("browser-panel:close-chat-pages", { chatId: target }),
        },
        {
          roots: () =>
            chatWorktrees(chatId).then(
              (worktrees) => [...worktrees.map((worktree) => worktree.path), path.join(require("node:os").homedir(), "Downloads")],
              () => [path.join(require("node:os").homedir(), "Downloads")],
            ),
        },
      ),
      ...(existsSync(path.join(__dirname, "design-mcp-tools.cjs"))
        ? []
        : artifactToolDefinitions(chatId, artifacts).filter((tool) => !["artifact_comments", "artifact_resolve_comment"].includes(tool.name))),
      ...designKitToolDefinitions(chatId, designKits),
      ...localMcp.agentTools(chatId).filter((tool) => !["artifact_comments", "artifact_resolve_comment"].includes(tool.name)),
      ...htmlArtifactToolDefinitions(chatId, artifacts, undefined, {
        roots: () =>
          chatWorktrees(chatId).then(
            (worktrees) => worktrees.map((worktree) => worktree.path),
            () => [],
          ),
      }),
      ...require("./html-render.cjs").htmlRenderToolDefinitions(chatId, artifacts),
      ...artifactCommentToolDefinitions(chatId, artifacts),
      ...require("./advisor-tools.cjs").advisorToolDefinitions(chatId, advisors),
      ...require("./link-worktree-tools.cjs").linkWorktreeToolDefinitions(chatId, createLinkWorktree),
      ...(linear.enabled() ? linearToolDefinitions(linearTools) : []),
      ...routines.definitions(chatId),
    ],
    createMcpServer: ({ toolsFor }) => ({ url: (chatId) => localMcp.chatUrl(chatId, toolsFor), close: async () => {} }),
  });
  const chatCommands = require("./command-dispatcher.cjs").createCommandDispatcher({
    definitions: (chatId) => linked.forChat(chatId).tools,
  });
  for (const action of ["list", "describe", "run"])
    commands.handle(`command:${action}`, async (_context, { chatId, name, input } = {}) => {
      await existingChat("using commands")(chatId);
      if (action === "list") return chatCommands.list(chatId);
      if (typeof name !== "string" || !name) throw new Error("A command name is required");
      if (action === "describe") return chatCommands.describe(chatId, name);
      return chatCommands.run(chatId, name, input);
    });
  async function createLinkWorktree({ chatId, linkId, sessionId, project }) {
    const made = await linkWorkspaces.addLinkWorktree({ link: await linkRuntime.usable(linkId), chatId: sessionId, project });
    if (!made.created) return made;
    const scope = projectOfKey(chatId);
    agents.updateWorkspace(chatId, await scopeStates.executionContext(scope, sessionId));
    broadcastProjectState(scope, await linkStore.get(linkId));
    if (states.has(made.member.projectPath)) await readProject(made.member.projectPath).catch(() => {});
    const setup = await worktreeSetups.beforeTurn(chatId, made.member.worktreePath);
    if (setup.cancelled) throw new Error("The user stopped this Worktree's setup. Ask before working in it.");
    if (setup.failed) throw new Error(setup.note || "Worktree setup did not finish.");
    return { ...made, setupNote: setup.note };
  }
  const advisorServices = createAdvisorsWiring({
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
    isClosing: () => closing,
  });
  btw = require("./runtime/btw-wiring.cjs").createBtwWiring({ commands, existingChat, scopeStates, chats, agents, routing, linked, turnDefaults, emit });
  const { advisorStore } = advisorServices;
  ({ advisorDelivery, advisors } = advisorServices);
  const linkWorkspaces = createLinkWorkspaces({
    store: linkStore,
    registry: projectRegistry(),
    ownProject,
    root: options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT,
    getSettings: async (projectPath) => ({ ...(await projectSettings().get(projectPath)), git: (await readProjectGit(projectPath)).effective }),
    deferSetup: (request) => worktreeSetups.prepare(request),
  });
  const linkRuntime = registerLinkRuntime({
    commands,
    registry: projectRegistry,
    store: linkStore,
    workspaces: linkWorkspaces,
    chats,
    sentFromNotes,
    rememberTurnDefaults: (request) => turnDefaults.remember(request),
    broadcast: broadcastProjectState,
    titles: chatTitles,
    issues: { message: linearIssueMessage, started: markIssueStarted },
    retire: async (scope, sessionId) => {
      const { stopped } = await archiveChat(scope, sessionId);
      await stopped;
    },
    released: async ({ removed, kept }) => {
      for (const member of removed) await worktreeSetups.forget(member.worktreePath);
      for (const projectPath of new Set([...removed, ...kept].map((member) => member.projectPath))) {
        const bases = new Map(
          kept.filter((member) => member.projectPath === projectPath && member.checkedBase).map((member) => [member.worktreePath, member.checkedBase]),
        );
        if (!bases.size && !states.has(projectPath)) continue;
        try {
          await readProject(projectPath);
          if (bases.size) await updateProject(projectPath, (state) => withWorktreeBases(state, bases), { chats: [] });
        } catch (error) {
          console.warn(`Milagre couldn't read ${projectName(projectPath)} again after deleting a Link:`, error.message);
        }
      }
      await pruneLinks().catch((error) => console.warn("Milagre couldn't drop the canvas Links of a deleted Link's Worktrees:", error.message));
    },
  });
  commands.handle("linked:snapshot", () => linked.snapshot());
  commands.handle("linked:remote-enabled:read", () => ({ enabled: remoteDelegation.enabled() }));
  commands.handle("linked:remote-enabled:save", (_event, value) => {
    const result = remoteDelegation.save(value);
    emit("linked:remote-enabled-changed", result);
    return result;
  });
  commands.handle("delegation:targets", () => linked.hosted.targets());
  commands.handle("delegation:prepare", (_event, request) => linked.hosted.prepare(request));
  commands.handle("delegation:receive", (_event, request) => linked.hosted.receive(request));
  commands.handle("delegation:reports", (_event, request) => linked.hosted.reports(request));
  commands.handle("delegation:collected", (_event, request) => linked.hosted.collected(request));
  remoteComputers?.onEvent?.((computerId, channel, payload) => {
    if (channel === "delegation:report")
      void linked.remoteFinished(computerId, payload).catch((error) => console.warn("Milagre couldn't take a Delegation report:", error.message));
  });
  remoteComputers?.onOnline?.((computerId) => {
    void linked.catchUp(computerId).catch((error) => console.warn("Milagre couldn't collect Delegation reports:", error.message));
  });
  remoteComputers?.onRemoved?.((computerId) => {
    void linked.computerRemoved(computerId).catch((error) => console.warn("Milagre couldn't settle a removed computer's Delegations:", error.message));
  });
  commands.handle("chat:detach", (_event, projectPath, sessionId) => {
    if (typeof projectPath !== "string" || !Number.isSafeInteger(sessionId)) throw new Error("Choose a Chat to detach.");
    return linked.detach(`${projectPath}#${sessionId}`);
  });
  commands.handle("linked:stop-negotiation", (_event, id) => (typeof id === "string" ? linked.stop({ negotiationId: id }) : undefined));
  const openedIdentities = new Map();
  async function openProject(projectPath, { takeNotice = true, focus = true, remember = true, register = true } = {}) {
    const known = openedIdentities.get(projectPath);
    const listed = known?.git ? await mainCheckoutWorktrees(projectPath) : null;
    const { identity, worktrees } = listed ? { identity: known, worktrees: listed } : await inspectProject(projectPath);
    openedIdentities.set(identity.path, identity);
    const project = withKind(await readProject(identity.path, { discovered: worktrees }));
    const home = project.kind === "chats";
    if (register && !home) await projectRegistry().add(identity);
    if (remember && !home) await rememberProject(recentProjects(), identity.path, { plain: async () => !identity.git, topLevel: async () => identity.path });
    if (focus) shownProjectPath = identity.path;
    const restored = takeNotice ? restoredChats.get(identity.path) : undefined;
    if (restored) restoredChats.delete(identity.path);
    return restored ? { ...project, restoredChats: restored } : project;
  }

  commands.handle("project:plain-root", async (_event, root) => {
    const known =
      (await projectRegistry().snapshot()).projects.some((entry) => entry.path === root) ||
      (await recentProjects().list()).some((entry) => entry.path === root);
    if (!known || !(await plainFolder(root))) throw new Error("That folder isn't a project");
    return [root];
  });

  commands.handle("project:current", async () => {
    const target = await launchProject(recentProjects(), cwd);
    if (target) return openProject(target);
    return (await chatsHome.exists()) ? openProject(chatsHome.path, { remember: false, register: false }) : null;
  });

  async function resumeRecentProjects() {
    const resolved = new Set();
    const homes = (await chatsHome.exists()) ? [chatsHome.path] : [];
    for (const recentPath of [...(await recentProjects().list()).map((entry) => entry.path), ...homes]) {
      let projectPath = recentPath;
      try {
        projectPath = (await resolveProject(recentPath)).path;
        if (resolved.has(projectPath)) continue;
        resolved.add(projectPath);
        const stored = states.has(projectPath) ? null : await readRawState(projectPath);
        if (!Object.values(stored?.sessions ?? {}).some((session) => session.resumeTurn || (session.queued?.length && !session.queueHeld))) continue;
        await readProject(projectPath);
      } catch (error) {
        console.warn(`Milagre couldn't resume the chats of ${projectPath}:`, error.message);
      }
    }
  }
  const { validateAccountScope, accountScopeForFolder, assignAccount, ...limits } = registerAccountScopes({
    options,
    dataDir,
    commands,
    environmentReady,
    accounts,
    queueAccountMutation,
    chats,
    scopeStates,
    projectRegistry,
    projectName,
    chatsHome,
    chatsHomeEntries,
    projectStateReadOnly,
    ownProject,
  });
  ({ limitSwitch, limitResume } = limits);
  const withoutHomes = (list) => list.filter((project) => !chatsHome.isHome(project.path));
  require("./runtime/ade-import.cjs").registerAdeImport({ commands, emit, openProject, editProject, projectRegistry, projectStateReadOnly, options });
  const { projectOrigin, addLink, removeLink, canvasChatModes, assertRegistrableProject } = registerProjects({
    options,
    dataDir,
    commands,
    withoutHomes,
    agents,
    chats,
    broadcastProjectState,
    canvasActiveWorktrees,
    chatsHome,
    knownFolder,
    linkStore,
    linked,
    linksChanged,
    openProject,
    ownProject,
    projectName,
    projectRegistry,
    projectSettings,
    projectsWithGit,
    pruneLinks,
    readProject,
    recentProjects,
    scopeStates,
    states,
    withKind,
    git,
    routines: () => routines,
    localMcp: () => localMcp,
  });
  const { localMcp } = createLocalMcpWiring({
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
    subchatEscalation: () => subchatEscalation,
    limitSwitch: () => limitSwitch,
  });

  limitResume.start();

  const sweepUploads = () =>
    track(async () => {
      await attachmentTransfers.sweep();
      await mobileUploads.sweep();
    }, background).catch((error) => console.warn("Attachment cleanup skipped:", error.message));
  const uploadSweepTimer = setInterval(sweepUploads, 24 * 60 * 60 * 1000);
  uploadSweepTimer.unref();
  void sweepUploads();
  const doneSweep = createDoneSweep({
    settings: doneSettings,
    scopes: () => scopeStates.projects(),
    heldState,
    archive: (scope, sessionId, retentionHours) => track(() => archiveDoneChat(scope, sessionId, retentionHours), background),
    isClosing: () => closing,
  });
  doneSweep.start();
  const snoozeSweep = createSnoozeSweep({
    scopes: () => scopeStates.projects(),
    heldState,
    wake: (scope, sessionId) => track(() => wakeSnoozedChat(scope, sessionId, { due: true }), background),
    isClosing: () => closing,
  });
  snoozeSweep.start();

  const shutdown = createShutdown();
  let routinesStopped;
  let limitResumeStopped;
  shutdown.stop(() => clearInterval(uploadSweepTimer));
  shutdown.stop(() => chatSecrets?.close());
  shutdown.stop(() => bugReports?.close());
  shutdown.stop(() => void doneSweep.stop());
  shutdown.stop(() => void snoozeSweep.stop());
  shutdown.stop(() => {
    closing = true;
  });
  // Before the command drain: a poll that lands after it writes to a closed store (#1021).
  shutdown.stop(() => pullRequests.close());
  shutdown.stop(() => {
    for (const chatId of chats.limitResumeFlights.keys()) chats.invalidateLimitResume(projectOfKey(chatId), sessionIdFromKey(chatId), "shutdown");
  });
  shutdown.stop(() => subchatEscalation.close());
  shutdown.stop(() => {
    routinesStopped = routines.stop();
  });
  shutdown.stop(() => {
    limitResumeStopped = limitResume.stop();
  });
  shutdown.stop(() => linked.suspend());
  shutdown.close(() => routinesStopped);
  shutdown.close(() => limitResumeStopped);
  shutdown.close(() => localMcp.close());
  shutdown.close(() => btw.close());
  shutdown.close(() => advisorServices.close());
  shutdown.close(() => toolServices.close());
  shutdown.close(() => linear.dispose());
  shutdown.close(() => Promise.allSettled(active));
  shutdown.close(() => attachmentTransfers.close());
  shutdown.close(() => {
    accounts.close();
    keybindings.close();
    keepAwake.quit();
    computerResources.close();
    ports.close();
    diffs.close();
  });
  shutdown.close(async () => {
    if (states.closed) return;
    await chats.suspendRunning();
    await scopeStates.flush().catch(() => {});
    await Promise.allSettled([worktreeSetups.cancelAll(), agents.closeAll()]);
    await Promise.allSettled(starting);
    await agents.closeAll();
    await Promise.allSettled([...background, ...chatTitles.pending.values()]);
  });
  shutdown.close(async () => {
    while (background.size) await Promise.allSettled(background);
  });
  shutdown.close(() => states.close());
  shutdown.close(() => linkStore.close());
  shutdown.close(() => linked.close());
  shutdown.close(() => usage.idle());
  shutdown.close(() => {
    for (const { owner } of projectOwners.values()) owner.release();
    for (const owner of repositoryOwners.values()) owner.release();
    dataOwner.release();
  });
  const { taskAccounts, autopilot: orchestratorAutopilot } = registerOrchestrator(
    { commands, dataDir, emit, chats, states, accounts, routing, agentCli, version },
    { projectRegistry, projectName, updateProject, defaultProjectBase, stopChat, archiveChat, respondPermission, answerQuestion, remote, git },
  );
  autopilot = orchestratorAutopilot;
  const close = () => shutdown.run();

  return {
    methods: commands.methods(),
    commandDefinitions: commands.list,
    invoke(method, args = [], context = null) {
      return accept(() => {
        return commands.invoke(method, args, context);
      });
    },
    disconnect: (clientId) =>
      Promise.all([simulators.disconnect(clientId), browsers.disconnect(clientId), panelForwarders.close(clientId)]).then(() => undefined),
    sweepDone: () => doneSweep.sweep(),
    sweepSnoozed: () => snoozeSweep.sweep(),
    openProject: (projectPath, options) => accept(() => openProject(projectPath, options)),
    resumeRecentProjects: () => accept(resumeRecentProjects),
    environmentReady,
    isClosing: () => closing,
    routines: {
      hookIds: () => routines.hookIds(),
      receiveHook: (delivery) => routines.receiveHook(delivery),
      receiveHooks: (deliveries) => routines.receiveHooks(deliveries),
      hooksRefused: (ids) => routines.hooksRefused(ids),
      hookOwners: (ids) => routines.hookOwners(ids),
      tick: () => routines.tick(),
      idle: () => routines.idle(),
      sweepRunChats: (projectPath, state) => routines.sweepRunChats(projectPath, state),
    },
    snapshot: () => {
      const home = chatsHome.path;
      return {
        links: linkStore
          .ids()
          .map((linkId) => ({ linkId, state: linkStore.has(linkId) ? linkStore.cached(linkId) : undefined }))
          .filter((link) => !link.state?.deletedAt),
        projects: states.projects().map((projectPath) => {
          const project = { path: projectPath, name: projectName(projectPath), state: states.states.get(projectPath) };
          if (projectPath === home) project.kind = "chats";
          return project;
        }),
        runs: chats.snapshot(),
        ports: ports.snapshot(),
      };
    },
    stateOf: (scope) => (isLinkScopeKey(scope) ? linkStore.cached(scopeFromKey(scope).linkId) : states.states.get(scope)),
    focused: (view) =>
      accept(() => {
        diffs.focused(view ? view.projectPath : shownProjectPath);
        return readOpenChat(view ? view.chatId : chats.openChat);
      }),
    chatOpened: (chatId) =>
      accept(() => {
        diffs.focusedChat(chatId);
        return readOpenChat(chatId);
      }),
    unloadIdle: () => Promise.all([states.unloadIdle(), linkStore.unloadIdle()]).then(() => undefined),
    flush: async () => {
      await linear.dispose();
      await Promise.allSettled(active);
      await attachmentTransfers.close();
      await scopeStates.flush();
      await usage.usageStore.idle();
    },
    close,
  };
}

module.exports = { createRuntime };
