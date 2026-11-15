const { chatMentionsContext } = require("./chat-mentions.cjs");
const { computerMentionsContext } = require("./computer-mentions.cjs");
const { createLinkStore } = require("./link-store.cjs");
const { createLinkWorkspaces } = require("./link-workspaces.cjs");
const { createChatScopes } = require("./chat-scopes.cjs");
const { registerLinkRuntime } = require("./link-runtime.cjs");
const { isLinkScopeKey, scopeFromKey, scopeKey } = require("@milagre/shared/chat-scopes");
const { PROVIDERS } = require("@milagre/shared/providers");
const { defaultFallback } = require("./routines/fallback.cjs");
const { pullRequestActionBody, pullRequestActionContext, pullRequestActionPrompt } = require("@milagre/shared/pr-action");
const { compactionMessage } = require("@milagre/shared/compaction");
const { RELOAD_TEXT } = require("@milagre/shared/chat-reload");
const { originId } = require("@milagre/shared/project-origin");
const { backgroundBusyMessage, processWork } = require("@milagre/shared/chat-activity");
const { issueFirstMessage, linearIssueContext, linearIssuePrompt, linearIssueRequest } = require("@milagre/shared/linear-issue");
const { ChatTitles, createChatTitleModels, generateChatTitle, generateRunTitle } = require("./chat-title.cjs");
const { createGit } = require("./git/client.cjs");
const { syncMainBranch } = require("./main-sync.cjs");
const fs = require("node:fs/promises");
const { acquireOwnership } = require("./ownership.cjs");
const { mkdirSync, realpathSync, existsSync } = require("node:fs");
const path = require("node:path");
const { migrateImages, withDetails } = require("./project-content.cjs");
const { ensureProjectIgnore } = require("./project-ignore.cjs");
const { chatPage, chatSearch } = require("./chat-pages.cjs");
const { dbFile: chatDbFile, readChatRows } = require("./chat-db.cjs");
const { decodeImages } = require("./image-input.cjs");
const { KeepAwake } = require("./keep-awake.cjs");
const { ClaudeSession } = require("./agents/claude-provider.cjs");
const { CodexSession, recoverCodexSubagents } = require("./agents/codex-provider.cjs");
const { AcpSession } = require("./agents/acp-session.cjs");
const { antigravityAcp } = require("./agents/antigravity-acp.cjs");
const { kiroAcp } = require("./agents/kiro-acp.cjs");
const { createProviderUpdates, releaseVersion } = require("./agents/provider-updates.cjs");
const { runCliUpdate } = require("./agents/cli-update.cjs");
const { recoverAntigravitySubagents } = require("./agents/antigravity-subagents.cjs");
const { loadLoginEnvironment } = require("./agents/environment.cjs");
const { failedWith, hostNetworkInstructions, loginMessage } = require("./agents/events.cjs");
const { SessionManager } = require("./agents/session-manager.cjs");
const { PortWatcher } = require("./agents/ports.cjs");
const { ChatHost } = require("./agents/chat-host.cjs");
const { SubchatEscalation } = require("./agents/subchat-escalation.cjs");
const { writeTranscript, generateBrief, createHandoverModels } = require("./agents/handover.cjs");
const { discoverSkills, expandSkillPrompt } = require("./skills.cjs");
const { DEFAULT_WORKTREE_ROOT, branchPushed, createWorktree, moveWorktreeBranch, newSuffix, renameWorktreeBranch } = require("./worktrees.cjs");
const { resolveBranchPolicy, availablePolicyBranch, branchPolicyNote } = require("./branch-policy.cjs");
const { branchSlug, branchTicket } = require("@milagre/shared/branch-policy");
const { suggestWorktreeName } = require("./worktree-name.cjs");
const { removeWorktree, worktreeStatus } = require("./worktree-cleanup.cjs");
const { previewFilesToCopy } = require("./worktree-files.cjs");
const { createProjectSettings } = require("./project-settings.cjs");
const { WorktreeSetups, resolveSetupCommand } = require("./worktree-setup.cjs");
const { SetupReview } = require("./setup-review.cjs");
const { readDiffStat } = require("./diffstat.cjs");
const { registerCheckpoints } = require("./checkpoint-runtime.cjs");
const { createSentFromNotes } = require("./sent-from.cjs");
const { registerGitHandlers } = require("./git-ipc.cjs");
const { readPullRequestState } = require("./pull-request.cjs");
const { registerPullRequests } = require("./runtime/pull-requests.cjs");
const { registerSettingsCommands } = require("./runtime/settings-commands.cjs");
const { createToolServices } = require("./runtime/tool-services.cjs");
const { createFiles } = require("./runtime/files.cjs");
const { createAccountsWiring, registerAccountScopes } = require("./runtime/accounts-wiring.cjs");
const { createUsage, registerTokenUsage } = require("./runtime/usage.cjs");
const { retireRunWorktree } = require("./routines/run-worktree.cjs");
const { background: inBackgroundLane } = require("./process-lanes.cjs");
const { emptyState, reconcileState, markDisconnectedSubagents, withWorktreeBases } = require("./project-state.cjs");
const { migrateWorktreeChats } = require("./worktree-chats.cjs");
const { linearToolDefinitions } = require("./linear/tools.cjs");
const { isIssueKey } = require("./linear/links.cjs");
const { ProjectStates } = require("./project-states.cjs");
const { DiffRefresher } = require("./diff-refresh.cjs");
const { chatKey, isTurnEnd, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { archiveFinishedSubagents, archiveSubagent, deleteSession, patchSession, renameWorktree } = require("@milagre/shared/project-edits");
const { attentionContext, attentionNotice } = require("@milagre/shared/attention");
const { createProjectFinder } = require("./project-finder.cjs");
const { scanFolder } = require("./folder-scan.cjs");
const { saveProjectState, readProjectState, compactProjectState, stateFile } = require("./project-store.cjs");
const { createRecentProjects, launchProject, plainFolder, rememberProject, switchTarget } = require("./recent-projects.cjs");
const { agentFolders } = require("./agent-folders.cjs");
const { createOnboardingProjects } = require("./onboarding-projects.cjs");
const { activeWorktrees, inspectProject, mainCheckoutWorktrees, outsideGit, resolveProject } = require("./project-identity.cjs");
const { createProjectRegistry } = require("./project-registry.cjs");
const { createLinkedWorktrees } = require("./linked-worktrees.cjs");
const { createRoutines, isRunChat, withRunChatsHidden } = require("./routines/runtime-adapter.cjs");
const { createHookStore } = require("./routines/hook-store.cjs");
const { idleWorktrees, assertIdleWorktree } = require("./storage-worktrees.cjs");
const { createDoneSweep } = require("./done-sweep.cjs");
const { createSnoozeSweep } = require("./snooze-sweep.cjs");
const { wakesSnoozed } = require("@milagre/shared/snooze");
const { doneDue } = require("@milagre/shared/done");
const { createBabysitWatch } = require("./babysit-watch.cjs");
const HOOK_RELAY_URL = "wss://relay.milagre.cloud";
const { chatTitle, isHiddenRunChat } = require("@milagre/shared/chats");
const ROUTINE_TARGET_CHATS = 50;

const { createFileSearch } = require("./project-files.cjs");
const { PERMISSION_MODES, askForUnknownModes } = require("./agents/permissions.cjs");
const { createChatsHome } = require("./chats-home.cjs");
const { isFolderChatsHome, createFolderChat } = require("./chats-home-folders.cjs");
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
  let closed;
  let advisors;
  let advisorDelivery;
  const chatsHome = createChatsHome({ root: options.chatsHome ?? path.join(require("node:os").homedir(), ".milagre", "chats") });
  const withKind = (project) => (chatsHome.isHome(project.path) ? { ...project, kind: "chats" } : project);
  const chatsHomeEntries = async () => ((await chatsHome.exists()) ? [{ path: chatsHome.path, name: projectName(chatsHome.path), kind: "chats" }] : []);
  function track(work, set = active) {
    const task = Promise.resolve().then(work);
    set.add(task);
    task.then(
      () => set.delete(task),
      () => set.delete(task),
    );
    return task;
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
  } = createToolServices({
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
    sendAsUser,
  });
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
    const result = await scopeStates.update(projectPath, change, options);
    if (result.changed) broadcastProjectState(projectPath, result.state);
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
    projectSettings,
    chats: () => chats,
    linkRuntime: () => linkRuntime,
    linkWorkspaces: () => linkWorkspaces,
    agentCli: (...args) => agentCli(...args),
    accountScopeForFolder: (...args) => accountScopeForFolder(...args),
    recentProjects: (...args) => recentProjects(...args),
  });
  commands.handle("app:version", () => version);
  commands.handle("triage:prepare", (_event, client) => require("./triage.cjs").prepareTriage({ dataDir, version, client }));
  function worktreeRoot() {
    return options.worktreeRoot || DEFAULT_WORKTREE_ROOT;
  }

  let projectSettingsStore = null;
  function projectSettings() {
    projectSettingsStore ??= createProjectSettings(path.join(dataDir, "project-settings.json"));
    return projectSettingsStore;
  }

  commands.handle("worktree:roots", async () => {
    const root = worktreeRoot();
    return [...new Set([root, await fs.realpath(root).catch(() => root)])];
  });
  commands.handle("worktree:status", async (_event, worktreePath, base) => {
    await knownFolder(worktreePath);
    await environmentReady;
    return worktreeStatus(worktreePath, base);
  });
  const removals = new Map();
  commands.handle("worktree:remove", async (_event, worktreePath, options) => {
    if ((await linkStore.ownedWorktrees()).has(worktreePath)) throw new Error("This Worktree belongs to a shared Link Chat. Archive the Chat to hide it.");
    const { force, projectPath, chatId, seen } = options && typeof options === "object" ? options : {};
    if (typeof projectPath !== "string" || !states.has(projectPath)) throw new Error("Open this project in Milagre first.");
    if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) throw new Error("An absolute worktree path is required.");
    await ownProject(projectPath);
    const key = `${projectPath}\0${worktreePath}`;
    const earlier = removals.get(key);
    const removal = (async () => {
      const before = earlier ? await earlier.catch(() => null) : null;
      if (before?.removed && !worktreeAt(await states.get(projectPath), worktreePath))
        return { removed: false, alreadyRemoved: true, branch: before.branch, branchDeleted: false };
      return removeOwnWorktree({ worktreePath, projectPath, chatId, seen, force: Boolean(force) });
    })();
    removals.set(key, removal);
    try {
      return await removal;
    } finally {
      if (removals.get(key) === removal) removals.delete(key);
    }
  });
  const worktreeAt = (state, worktreePath) => Object.values(state.worktrees ?? {}).find((worktree) => worktree.path === worktreePath);
  async function openAsProject(folder) {
    const real = await fs.realpath(folder).catch(() => folder);
    for (const projectPath of states.projects()) {
      if (projectPath === folder || (await fs.realpath(projectPath).catch(() => projectPath)) === real) return true;
    }
    return false;
  }
  async function removeOwnWorktree({ worktreePath, projectPath, chatId, seen, force }) {
    const worktree = worktreeAt(await states.get(projectPath), worktreePath);
    if (!worktree) throw new Error(`${worktreePath} isn't a worktree of this project, so it is kept.`);
    if (!worktree.base) throw new Error(`Milagre didn't create ${worktreePath}, so it is kept.`);
    if (await openAsProject(worktreePath)) throw new Error(`${worktreePath} is open as a project, so it is kept.`);
    const inUse = (state) => {
      if (chatId !== undefined) {
        const own = typeof chatId === "string" && projectOfKey(chatId) === projectPath ? state.sessions[sessionIdFromKey(chatId)] : undefined;
        if (!own || own.worktree_id !== worktree.id) throw new Error("That chat isn't on this worktree, so the worktree is kept.");
      }
      const others = Object.values(state.sessions).filter(
        (session) => session.worktree_id === worktree.id && !session.archived && `${projectPath}#${session.id}` !== chatId,
      );
      if (others.length) throw new Error("Another chat uses this worktree now, so it is kept.");
    };
    inUse(await states.get(projectPath));
    const goneChats = Object.values((await states.get(projectPath)).sessions)
      .filter((session) => session.worktree_id === worktree.id)
      .map((session) => `${projectPath}#${session.id}`);
    await environmentReady;
    const result = await removeWorktree({
      path: worktreePath,
      root: worktreeRoot(),
      projectPath,
      base: worktree.base,
      seen,
      force,
      closeSession: async () => {
        for (const gone of goneChats) {
          terminals.closeChat(gone);
          await advisorDelivery.stop(gone);
          await advisors.stopChat(gone);
        }
        if (typeof chatId === "string") {
          await worktreeSetups.cancel(chatId);
          await worktreeSetups.forget(worktreePath);
          await agents.closeChat(chatId);
        }
        inUse(await states.get(projectPath));
      },
    });
    if (states.has(projectPath)) await readProject(projectPath);
    if (result.removed) {
      for (const id of goneChats) computerUseScreen.forget(id);
      await Promise.all(goneChats.map((id) => artifacts.removeChat(id).catch(() => {})));
      await Promise.all(goneChats.map((id) => pageComments.removeChat(id).catch(() => {})));
      for (const id of goneChats) chats.forget(id);
      await pruneLinks();
    }
    return result;
  }
  commands.handle("files-to-copy:read", async (_event, projectPath) => {
    await knownFolder(projectPath);
    await environmentReady;
    const { filesToCopy } = await projectSettings().get(projectPath);
    return { filesToCopy, ...(await previewFilesToCopy(projectPath, filesToCopy)) };
  });
  commands.handle("files-to-copy:preview", async (_event, projectPath, patterns) => {
    await knownFolder(projectPath);
    await environmentReady;
    return previewFilesToCopy(projectPath, patterns);
  });
  commands.handle("files-to-copy:save", async (_event, projectPath, patterns) => {
    await knownFolder(projectPath);
    await environmentReady;
    const { filesToCopy } = await projectSettings().setFilesToCopy(projectPath, patterns);
    return { filesToCopy, ...(await previewFilesToCopy(projectPath, filesToCopy)) };
  });
  async function readProjectGit(projectPath) {
    return resolveBranchPolicy(projectPath, await projectSettings().getGit(projectPath));
  }
  async function defaultProjectBase(projectPath) {
    return (await readProjectGit(projectPath)).effective.baseBranch || (await git.resolveBase(projectPath).catch(() => ({ name: "main" }))).name;
  }
  commands.handle("project-git:read", async (_event, projectPath) => {
    await knownFolder(projectPath);
    return readProjectGit(projectPath);
  });
  commands.handle("project-git:save", async (_event, projectPath, value) => {
    await knownFolder(projectPath);
    const resolved = await resolveBranchPolicy(projectPath, value);
    await projectSettings().setGit(projectPath, resolved.local);
    return resolved;
  });
  async function readSetupCommand(projectPath) {
    const { setupCommand } = await projectSettings().get(projectPath);
    return { setupCommand, ...(await resolveSetupCommand(projectPath, setupCommand)) };
  }
  commands.handle("worktree-setup:read", async (_event, projectPath) => {
    await knownFolder(projectPath);
    return readSetupCommand(projectPath);
  });
  commands.handle("worktree-setup:save", async (_event, projectPath, command) => {
    await knownFolder(projectPath);
    await projectSettings().setSetupCommand(projectPath, typeof command === "string" ? command : "");
    return readSetupCommand(projectPath);
  });
  async function readMainSync(projectPath) {
    const [settings, base] = await Promise.all([projectSettings().getMainSync(projectPath), git.resolveBase(projectPath).catch(() => ({ name: "main" }))]);
    return { branch: base.name, ...settings };
  }
  const mainSyncs = new Map();
  const mainSyncTails = new Map();
  function syncMain(projectPath, branch) {
    const key = JSON.stringify([projectPath, branch]);
    let running = mainSyncs.get(key);
    if (!running) {
      running = (mainSyncTails.get(projectPath) ?? Promise.resolve())
        .catch(() => {})
        .then(() => syncMainBranch(projectPath, { branch }))
        .then(async (last) => {
          await projectSettings()
            .recordMainSync(projectPath, last)
            .catch((error) => console.warn("Milagre main sync:", error.message));
          emit("main-sync:status", { projectPath, last });
          return last;
        })
        .finally(() => {
          mainSyncs.delete(key);
          if (mainSyncTails.get(projectPath) === running) mainSyncTails.delete(projectPath);
        });
      mainSyncs.set(key, running);
      mainSyncTails.set(projectPath, running);
    }
    return running;
  }
  commands.handle("main-sync:read", async (_event, projectPath) => {
    await knownFolder(projectPath);
    await environmentReady;
    return readMainSync(projectPath);
  });
  commands.handle("main-sync:save", async (_event, projectPath, override) => {
    await knownFolder(projectPath);
    await projectSettings().setMainSyncOverride(projectPath, typeof override === "boolean" ? override : null);
    await environmentReady;
    return readMainSync(projectPath);
  });
  commands.handle("main-sync:default:read", () => projectSettings().getMainSyncDefault());
  commands.handle("main-sync:default:save", (_event, value) => projectSettings().setMainSyncDefault(value === true));

  async function readLinearIssue(key, workspace) {
    if (!linear.enabled()) throw new Error("Linear is off in Settings › Connections › Linear.");
    if (!linear.workspaces().length) throw new Error("Linear isn't connected.");
    const issue = await linearIssues.readIssue(key, workspace);
    if (!issue) throw new Error(`${key} no longer exists in Linear.`);
    return issue;
  }

  async function nameWorktree(projectPath, created, prompt, policy, suffix, ticket) {
    const cli = await agentCli("claude", projectPath);
    const slug = await suggestWorktreeName(prompt, {
      command: cli.problem ? null : cli.command,
      env: cli.env,
      timeoutMs: 15_000,
      instructions: policy.instructions,
    });
    if (closing) return;
    const name = await renameWorktreeBranch({ worktreePath: created.path, branch: created.branch, slug, policy, suffix, ticket });
    if (!name) return;
    await updateProject(projectPath, (state) => renameWorktree(state, { path: created.path, from: created.branch, name }), { chats: [] });
    emit("worktree:renamed", { projectPath, path: created.path, from: created.branch, name });
  }

  commands.handle("worktree:create", async (event, { projectPath, baseBranch, useProjectBase, prompt, issueKey, issueWorkspace }) => {
    await ownProject(projectPath);
    await environmentReady;
    if (chatsHome.isHome(projectPath) && (await isFolderChatsHome(projectPath))) {
      if (issueKey) throw new Error("A Chat without a Project cannot be linked to a Linear issue.");
      event?.localMcp?.assertActive();
      const folder = await createFolderChat(projectPath);
      const project = await readProject(projectPath);
      const worktree = Object.values(project.state.worktrees).find((item) => item.path === folder);
      return { project, worktreeId: worktree.id };
    }
    const issue = typeof issueKey === "string" ? await readLinearIssue(issueKey, issueWorkspace) : null;
    const policy = (await readProjectGit(projectPath)).effective;
    baseBranch = (useProjectBase && policy.baseBranch) || baseBranch || policy.baseBranch || (await git.resolveBase(projectPath)).name;
    const request = { projectPath, baseBranch, prompt };
    const suffix = newSuffix();
    const ticket = issue?.key || branchTicket(prompt);
    const branch = await availablePolicyBranch(
      projectPath,
      policy,
      { slug: issue?.title || prompt || "chat", ticket, suffix },
      { issueBranch: issue ? issue.branchName || "" : undefined },
    );
    const settings = await projectSettings().get(projectPath);
    const synced = (await projectSettings().getMainSync(projectPath)).enabled ? await syncMain(projectPath, baseBranch) : null;
    const created = await createWorktree({
      ...request,
      branch,
      folderSlug: branchSlug(issue ? branch.split("/").pop() : prompt || "chat"),
      trackBase: policy.trackBase,
      suffix,
      root: worktreeRoot(),
      copyPatterns: settings.filesToCopy,
      fetched: synced?.branch === baseBranch,
      beforeCreate: event?.localMcp?.assertActive,
    });
    if (created.copy?.notes.length) console.warn("Milagre worktree file copy:", created.copy.notes.join(" "));
    const resolved = await resolveSetupCommand(projectPath, settings.setupCommand);
    await worktreeSetups.prepare({ worktreePath: created.path, projectPath, resolved });
    const project = await readProject(request.projectPath);
    const listed = Object.values(project.state.worktrees).find((item) => item.name === created.branch);
    if (!listed) throw new Error(`Created ${created.branch}, but git did not list it as a worktree.`);
    const state = await updateProject(
      request.projectPath,
      (latest) => {
        const worktree = latest.worktrees[listed.id];
        return worktree
          ? {
              ...latest,
              worktrees: {
                ...latest.worktrees,
                [worktree.id]: {
                  ...worktree,
                  base: created.base,
                  generatedBranch: created.branch,
                  branchSuffix: suffix,
                  ...(event?.localMcp ? { localMcpOperation: event.localMcp.operationId } : {}),
                  ...(issue ? { linearIssue: issue.key, linearWorkspace: issue.workspace } : {}),
                },
              },
            }
          : latest;
      },
      { chats: [] },
    );
    if (issue) markIssueStarted(issue);
    if (!issue) void track(() => nameWorktree(request.projectPath, created, request.prompt ?? "", policy, suffix, ticket), background).catch(() => {});
    return { project: { ...project, state }, worktreeId: listed.id, ...(resolved.note ? { setupNote: resolved.note } : {}) };
  });
  commands.handle("worktree:link-issue", async (_event, { projectPath, worktreeId, key, workspace } = {}) => {
    await ownProject(projectPath);
    await environmentReady;
    if (!isIssueKey(key)) throw new Error(`${JSON.stringify(String(key))} isn't a Linear issue key.`);
    const issue = await readLinearIssue(key, workspace);
    const project = await readProject(projectPath);
    const worktree = project.state.worktrees[worktreeId];
    if (!worktree) throw new Error("That worktree is no longer in this project.");
    if (worktree.path === projectPath) throw new Error("The main checkout can't be linked to a Linear issue.");
    const sharing = Object.values(project.state.sessions).filter((session) => session.worktree_id === worktreeId && !session.archived);
    if (sharing.length > 1) throw new Error("Another chat uses this worktree, so it can't be linked to a Linear issue.");
    let renamable = false;
    if ((worktree.generatedBranch === worktree.name || worktree.name.startsWith("milagre/")) && !(await branchPushed(worktree.path, worktree.name))) {
      const lookup = await readPullRequestStateOf(worktree.path).catch(() => ({ known: false, pr: null }));
      renamable = lookup.known && lookup.pr === null;
    }
    if (renamable) {
      const suffix = worktree.branchSuffix ?? worktree.name.match(/-([a-z0-9]{4})$/)?.[1] ?? newSuffix();
      const policy = (await readProjectGit(projectPath)).effective;
      const branch = await availablePolicyBranch(projectPath, policy, { slug: issue.title, ticket: issue.key, suffix }, { issueBranch: issue.branchName });
      if (branch !== worktree.name) await moveWorktreeBranch({ worktreePath: worktree.path, from: worktree.name, to: branch });
      const state = await updateProject(
        projectPath,
        (latest) => {
          const renamed = renameWorktree(latest, { path: worktree.path, from: worktree.name, name: branch });
          const item = renamed.worktrees[worktreeId];
          return item
            ? { ...renamed, worktrees: { ...renamed.worktrees, [worktreeId]: { ...item, linearIssue: issue.key, linearWorkspace: issue.workspace } } }
            : renamed;
        },
        { chats: [] },
      );
      emit("worktree:renamed", { projectPath, path: worktree.path, from: worktree.name, name: branch });
      return { project: { ...project, state }, mode: "renamed", branch };
    }
    const state = await updateProject(
      projectPath,
      (latest) => {
        const item = latest.worktrees[worktreeId];
        return item
          ? { ...latest, worktrees: { ...latest.worktrees, [worktreeId]: { ...item, linearIssue: issue.key, linearWorkspace: issue.workspace } } }
          : latest;
      },
      { chats: [] },
    );
    return { project: { ...project, state }, mode: "stored", branch: worktree.name };
  });
  commands.handle("worktree:unlink-issue", async (_event, { projectPath, worktreeId } = {}) => {
    await ownProject(projectPath);
    await environmentReady;
    const project = await readProject(projectPath);
    if (!project.state.worktrees[worktreeId]) throw new Error("That worktree is no longer in this project.");
    const state = await updateProject(
      projectPath,
      (latest) => {
        const item = latest.worktrees[worktreeId];
        if (!item) return latest;
        const { linearWorkspace: _workspace, ...rest } = item;
        return { ...latest, worktrees: { ...latest.worktrees, [worktreeId]: { ...rest, linearIssue: null } } };
      },
      { chats: [] },
    );
    return { project: { ...project, state } };
  });
  commands.handle("worktree:refresh-diffs", (_event, projectPath, worktreeIds) => {
    if (!states.has(projectPath) || !Array.isArray(worktreeIds)) return undefined;
    return diffs.refresh(
      projectPath,
      worktreeIds.filter((id) => Number.isInteger(id)),
    );
  });
  const readPullRequestStateOf = options.readPullRequestState ?? readPullRequestState;
  const pullRequests = registerPullRequests({ commands, options, states, emit, environmentReady });
  const keepAwake = options.keepAwake ?? new KeepAwake({ powerSaveBlocker: { start: () => 0, isStarted: () => true, stop() {} }, enabled: false });
  commands.handle("app:set-keep-awake", (_event, enabled) => keepAwake.setEnabled(enabled === true));

  let limitSwitch = null;
  let limitResume = null;
  let routines = null;
  let babysitWatch = null;
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
    routines?.observe(chatId, event);
    babysitWatch?.observe(chatId, event);
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
    send: (chatId, event) => void chats.receive(chatId, event),
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
  const deviceNotes = require("./design-settings.cjs").createDesignSettings(path.join(dataDir, "device-notes.json"), { name: "Device notes", missing: false });
  const sentFromNotes = createSentFromNotes({ enabled: () => deviceNotes.enabled() });
  const turnDefaults = require("./turn-defaults.cjs").createTurnDefaults({ file: path.join(dataDir, "turn-defaults.json") });
  commands.handle("device-notes:read", () => ({ enabled: deviceNotes.enabled() }));
  commands.handle("device-notes:save", (_event, value) => {
    const result = deviceNotes.save(value);
    emit("device-notes:changed", result);
    return result;
  });
  async function startAgentTurn(request) {
    const cancelled = () =>
      closing ||
      (request.canStart && !request.canStart()) ||
      (request.expectedAccountId !== undefined && accounts.selected(request.provider, projectOfKey(request.chatId)) !== request.expectedAccountId);
    if (cancelled()) return { turnId: null, steered: false, cancelled: true };
    const permissionMode = request.permissionMode ?? agents.permissionMode(request.chatId, "ask");
    if (permissionMode !== "full") await advisors?.stopExecution(request.chatId);
    else advisors?.resumeExecution(request.chatId);
    const linkedContext = agents.isTurnActive(request.chatId) ? Promise.resolve("") : linked.context(request.chatId);
    const images = decodeImages(request.images);
    const prompt =
      options.expandSkills === false ? request.prompt : await expandSkillPrompt(await folderSkillRoots(request.cwd).catch(() => request.cwd), request.prompt);
    const cli = agents.activeAccount(request.chatId, request.provider) ?? (await agentCli(request.provider, projectOfKey(request.chatId)));
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
              closeChat: async (chatKey) => {
                terminals.closeChat(chatKey);
                await advisorDelivery.stop(chatKey);
                await advisors.stopChat(chatKey);
                await worktreeSetups.cancel(chatKey);
                await agents.closeChat(chatKey);
              },
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
            for (const key of keys) {
              terminals.closeChat(key);
              await agents.closeChat(key);
            }
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
      for (const key of keys) {
        chats.forget(key);
        computerUseScreen.forget(key);
        await stopChatWork(key);
        await artifacts.removeChat(key).catch(() => {});
        await pageComments.removeChat(key).catch(() => {});
      }
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
            .filter((session) => !session.archived && !isHiddenRunChat(session) && (session.summary?.count ?? 0) > 0)
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

  commands.handle("chat:send", (_event, request) => {
    turnDefaults.remember(request ?? {});
    return sendAsUser(request);
  });
  async function sendAsUser(request) {
    if (isLinkScopeKey(request?.projectPath) || !scopeStates.has(request?.projectPath)) throw new Error("Open the project before sending to its chats.");
    const { prAction, linearIssue, compact, sentFrom, ...rest } = request;
    const action = prAction === undefined ? null : pullRequestActionContext(prAction);
    if (prAction !== undefined && !action) throw new Error("That pull request action isn't valid.");
    if (compact && rest.sessionId == null) throw new Error("Open a chat before compacting it.");
    const message = action
      ? { ...rest, body: pullRequestActionBody(action), prompt: pullRequestActionPrompt(action), images: [], files: [], context: action }
      : compact
        ? { ...rest, ...compactionMessage() }
        : linearIssue !== undefined
          ? (await linearIssueMessage(rest, linearIssue)).message
          : { ...rest, context: undefined };
    const { sessionId } = await chats.send(
      compact ? message : sentFromNotes.message({ ...message, sentFrom }, rest.sessionId == null ? null : chatKey(rest.projectPath, rest.sessionId)),
    );
    if (!compact) sentFromNotes.sent(chatKey(rest.projectPath, sessionId), sentFrom);
    noteHumanActed(chatKey(rest.projectPath, sessionId));
    if (rest.sessionId != null) {
      await keepRunChat(rest.projectPath, sessionId).catch((error) => console.warn("Milagre couldn't keep a Run Chat:", error.message));
      await reopenDoneChat(rest.projectPath, sessionId).catch((error) => console.warn("Milagre couldn't reopen a Done Chat:", error.message));
      await wakeSnoozedChat(rest.projectPath, sessionId, { byUser: true }).catch((error) =>
        console.warn("Milagre couldn't wake a snoozed Chat:", error.message),
      );
    }
    return { sessionId };
  }
  async function linearIssueMessage(rest, request) {
    const ask = linearIssueRequest(request);
    if (!ask) throw new Error("That Linear issue isn't valid.");
    const issue = await readLinearIssue(ask.key, ask.workspace).catch((error) => {
      console.warn(`Milagre couldn't read ${ask.key} for its card:`, error.message);
      return null;
    });
    if (!issue) return { message: { ...rest, context: undefined }, issue: null };
    const files = Array.isArray(rest.files) ? rest.files : [];
    return {
      message: {
        ...rest,
        body: issueFirstMessage(issue, ask.note),
        prompt: linearIssuePrompt(issue, ask.note) + (files.length ? `\n\nAttached files:\n${files.join("\n")}` : ""),
        context: linearIssueContext(issue, ask.note),
      },
      issue,
    };
  }
  function markIssueStarted(issue) {
    if (linear.moveToStarted() && linear.canWrite(issue.workspace))
      void track(() => linearIssues.markStarted(issue.key, issue.workspace), background).catch(() => {});
  }
  commands.handle("chat:resume", async (_event, projectPath, sessionId) => {
    if (!scopeStates.has(projectPath)) throw new Error("Open the project before continuing its chats.");
    return chats.resumeChat(projectPath, Number(sessionId));
  });
  async function archiveChat(projectPath, sessionId, patch = { archived: true }) {
    if (!scopeStates.has(projectPath)) return;
    await chats.cancelLimitResume(projectPath, sessionId);
    const chatId = `${projectPath}#${sessionId}`;
    const stopping = stopChatWork(chatId);
    stopping.catch(() => {});
    await editProject(projectPath, (state) => patchSession(state, sessionId, patch), { chats: [] });
    void track(() => stopping, background).catch((error) => console.warn("Milagre couldn't stop an archived Chat's work:", error.message));
  }
  async function moveRunChats(projectPath, sessionIds, { worktreeId, formerWorktree, archive = [], restore }) {
    const before = {};
    await editProject(
      projectPath,
      (state) => {
        const sessions = { ...state.sessions };
        for (const id of restore ? [] : archive) {
          const session = sessions[id];
          if (!session) continue;
          before[id] = { worktree_id: session.worktree_id, archived: session.archived };
          sessions[id] = { ...session, archived: true };
        }
        for (const id of sessionIds) {
          const session = sessions[id];
          if (!session) continue;
          if (restore) {
            const previous = restore[id];
            if (!previous) continue;
            const { formerWorktree: _former, ...rest } = session;
            sessions[id] = { ...rest, worktree_id: previous.worktree_id, archived: previous.archived };
            continue;
          }
          before[id] = { worktree_id: session.worktree_id, archived: session.archived };
          sessions[id] = { ...session, worktree_id: worktreeId, archived: true, formerWorktree };
        }
        return { ...state, sessions };
      },
      { chats: [] },
    );
    return before;
  }
  async function stopChatWork(chatId) {
    terminals.closeChat(chatId);
    routines.chatArchived(chatId);
    if (chats.runs[chatId]) return stopChat(chatId);
    await advisorDelivery.stop(chatId);
    await advisors.stopChat(chatId);
  }
  async function archiveRunChat(projectPath, sessionId, runId) {
    const left = (session) => isHiddenRunChat(session) && !session.archived && session.routine.runId === runId;
    if (!scopeStates.has(projectPath) || !left((await scopeStates.get(projectPath)).sessions[sessionId])) return;
    let archived = false;
    await editProject(
      projectPath,
      (state) => {
        if (!left(state.sessions[sessionId])) return state;
        archived = true;
        return patchSession(state, sessionId, { archived: true });
      },
      { chats: [] },
    );
    if (archived) await stopChatWork(`${projectPath}#${sessionId}`);
  }
  async function keepRunChat(projectPath, sessionId) {
    if (!scopeStates.has(projectPath)) return;
    const keepable = (session) => isRunChat(session) && session.routine.hidden !== false;
    if (!keepable(heldState(projectPath)?.sessions[sessionId])) return;
    if (!keepable((await scopeStates.get(projectPath)).sessions[sessionId])) return;
    await editProject(projectPath, (state) => withRunChatsHidden(state, { [sessionId]: false }, (routine) => routine.hidden !== false), { chats: [] });
  }
  function sessionPatch(patch) {
    if (!patch || typeof patch !== "object") return {};
    const { done, done_at: _clientClock, ...rest } = patch;
    if (done === true) return { ...rest, done_at: Date.now(), snoozed_until: undefined };
    if (done === false || rest.archived === false) return { ...rest, done_at: undefined, snoozed_until: undefined };
    if (rest.archived) return { ...rest, snoozed_until: undefined };
    return rest;
  }
  async function patchChat(projectPath, sessionId, raw) {
    if (!scopeStates.has(projectPath)) return;
    const receivedAt = needsUserCount;
    const patch = sessionPatch(raw);
    if (patch.archived) return archiveChat(projectPath, sessionId, patch);
    if (patch.done_at) routines.chatDone(`${projectPath}#${sessionId}`);
    await editProject(projectPath, (state) => patchSession(state, sessionId, patch), { chats: [] });
    if (patch.snoozed_until && (needsUserAt.get(`${projectPath}#${sessionId}`) ?? 0) > receivedAt) await wakeSnoozedChat(projectPath, sessionId);
  }
  async function reopenDoneChat(projectPath, sessionId) {
    if (!scopeStates.has(projectPath) || !heldState(projectPath)?.sessions[sessionId]?.done_at) return;
    await editProject(projectPath, (state) => patchSession(state, sessionId, { done_at: undefined }), { chats: [] });
  }
  async function wakeSnoozedChat(projectPath, sessionId, { due = false, byUser = false } = {}) {
    if (!scopeStates.has(projectPath) || !heldState(projectPath)?.sessions[sessionId]?.snoozed_until) return false;
    let woke = false;
    await editProject(
      projectPath,
      (state) => {
        const session = state.sessions[sessionId];
        if (!session?.snoozed_until || (due && session.snoozed_until > Date.now())) return state;
        woke = true;
        return patchSession(state, sessionId, byUser ? { snoozed_until: undefined } : { snoozed_until: undefined, unread: true });
      },
      { chats: [] },
    );
    return woke;
  }
  async function archiveDoneChat(scope, sessionId, retentionHours) {
    if (!scopeStates.has(scope)) return false;
    const session = (await scopeStates.get(scope)).sessions[sessionId];
    if (!doneDue(session, retentionHours)) return false;
    await archiveChat(scope, sessionId, { archived: true, unread: false });
    if (isLinkScopeKey(scope) || !states.has(scope)) return true;
    const state = await states.get(scope);
    const worktree = state.worktrees[session.worktree_id];
    if (!worktree?.base || worktree.path === scope) return true;
    if (Object.values(state.sessions).some((other) => other.worktree_id === worktree.id && !other.archived && other.id !== session.id)) return true;
    await environmentReady;
    const status = await worktreeStatus(worktree.path, worktree.base).catch(() => null);
    if (!status?.removable) return true;
    await handlers
      .get("worktree:remove")({}, worktree.path, { projectPath: scope, chatId: `${scope}#${sessionId}`, seen: status })
      .catch((error) => console.warn("Milagre kept a Done Chat's worktree:", error.message));
    return true;
  }
  commands.handle("chat:patch", async (_event, projectPath, sessionId, patch) => {
    await patchChat(projectPath, sessionId, patch);
    if (patch?.kept === true || patch?.pinned === true || patch?.archived === false || (typeof patch?.title === "string" && patch.title.trim() !== ""))
      await keepRunChat(projectPath, sessionId);
  });
  commands.handle("chat:delete", async (_event, projectPath, sessionId) => {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Choose an existing Chat to delete.");
    const chatId = `${projectPath}#${sessionId}`;
    await existingChat("deleting it")(chatId);
    if (isLinkScopeKey(projectPath)) {
      const { linkId } = scopeFromKey(projectPath);
      const link = await linkRuntime.definition(linkId);
      if (link.canvasLinkId && !(await linkStore.get(linkId)).releasedAt)
        throw new Error("Switch this Link to separate Chats before deleting its shared conversation.");
    }
    await stopChatWork(chatId);
    await worktreeSetups.cancel(chatId);
    await agents.closeChat(chatId);
    await editProject(projectPath, (state) => deleteSession(state, sessionId), { chats: [sessionId] });
    computerUseScreen.forget(chatId);
    await artifacts.removeChat(chatId).catch(() => {});
  });
  commands.handle("chat:archive-subagent", (_event, projectPath, sessionId, id, archived) =>
    scopeStates.has(projectPath)
      ? editProject(projectPath, (state) => archiveSubagent(state, sessionId, String(id), archived === true), { chats: [] }).then(() => {})
      : undefined,
  );
  commands.handle("chat:archive-finished-subagents", (_event, projectPath, sessionId) =>
    scopeStates.has(projectPath) ? editProject(projectPath, (state) => archiveFinishedSubagents(state, sessionId), { chats: [] }).then(() => {}) : undefined,
  );
  commands.handle("chat:git-note", (_event, chatId, body) => {
    if (typeof chatId !== "string" || typeof body !== "string" || !scopeStates.has(projectOfKey(chatId))) return undefined;
    return chats.addNote(chatId, { body, context: { kind: "git-action" } });
  });
  async function readOpenChat(chatId = chats.openChat) {
    if (chatId && scopeStates.has(projectOfKey(chatId))) {
      await updateProject(projectOfKey(chatId), (state) => patchSession(state, sessionIdFromKey(chatId), { unread: false }), { chats: [] });
      void track(async () => {
        await advisors.reconcile(chatId);
        await chats.recoverSubagents(chatId);
      }, background).catch((error) => console.warn("Milagre couldn't refresh subagent outcomes:", error.message));
    }
  }
  commands.handle("chat:set-open", (_event, chatId) => {
    chats.setOpenChat(chatId);
    return readOpenChat();
  });
  commands.handle("chat:runs", () => chats.snapshot());
  commands.handle("chat:inbox", async () => {
    const scopes = await Promise.all(
      scopeStates.projects().map(async (key) => ({
        path: key,
        name: isLinkScopeKey(key) ? (await linkRuntime.definition(scopeFromKey(key).linkId)).name : projectName(key),
        state: await scopeStates.inboxState(key),
      })),
    );
    return require("@milagre/shared/attention").inboxSnapshot(scopes, chats.snapshot().runs);
  });

  const agentCliStatus = (scope) => (options.agentCliStatus ? options.agentCliStatus() : routing.services(scope).status());
  agentCliStatus.invalidate = (provider) => {
    routing.invalidate(provider);
    options.agentCliStatus?.invalidate?.(provider);
  };
  const providerUpdates = options.providerUpdates ?? createProviderUpdates({ ready: () => environmentReady, antigravity });
  commands.handle("agent:provider-updates", () => providerUpdates());
  const cliUpdates = new Map();
  commands.handle("agent:cli-status", async (_event, scope) => agentCliStatus(await validateAccountScope(scope, true)));
  commands.handle("agent:update-cli", async (_event, provider, targetVersion) => {
    if (!PROVIDERS.includes(provider)) throw new Error("Unknown provider.");
    targetVersion ??= undefined;
    if (targetVersion !== undefined && !releaseVersion(targetVersion)) throw new Error("Invalid provider version.");
    if (cliUpdates.has(provider)) return cliUpdates.get(provider);
    const pending = (async () => {
      const result = await (options.runCliUpdate ?? runCliUpdate)(provider, {
        targetVersion,
        antigravity,
        onProgress: (progress) => emit("agent:cli-progress", { provider, ...progress }),
      });
      agentCli.invalidate(provider);
      agentCliStatus.invalidate(provider);
      const status = await agentCliStatus();
      return { ...result, status: status[provider] };
    })();
    cliUpdates.set(provider, pending);
    try {
      return await pending;
    } finally {
      cliUpdates.delete(provider);
    }
  });

  commands.handle("agent:models", async (_event, scope) => {
    scope = await validateAccountScope(scope, true);
    return options.agentModels ? options.agentModels() : routing.services(scope).models();
  });

  commands.handle("agent:interrupt", async (_event, chatId) => {
    await existingChat("stopping advisors")(chatId);
    await stopChat(chatId);
  });

  commands.handle("chat:queue-send", async (_event, chatId, id) => {
    await existingChat("sending a queued message")(chatId);
    if (typeof id !== "string") throw new Error("That queued message isn't valid.");
    const { interrupt } = await chats.sendQueuedNow(chatId, id);
    if (interrupt) await stopChat(chatId);
  });
  commands.handle("chat:queue-remove", async (_event, chatId, id) => {
    await existingChat("removing a queued message")(chatId);
    if (typeof id !== "string") throw new Error("That queued message isn't valid.");
    return chats.removeQueued(chatId, id);
  });

  commands.handle("chat:reload", async (_event, chatId) => {
    await existingChat("reloading it")(chatId);
    const state = await scopeStates.get(projectOfKey(chatId));
    const sessionId = sessionIdFromKey(chatId);
    if (state.sessions[sessionId]?.readOnlyReason) throw new Error(state.sessions[sessionId].readOnlyReason);
    await chats.cancelLimitResume(projectOfKey(chatId), sessionId);
    const background = Math.max(agents.backgroundWork(chatId), processWork(state.sessions[sessionId]).length);
    if (background) throw new Error(backgroundBusyMessage("reload", background));
    if (chats.runs[chatId]) await stopChat(chatId);
    if ((state.sessions[sessionId]?.summary?.count ?? 0) > 0 || state.messages.some((message) => message.session_id === sessionId))
      await chats.addNote(chatId, { body: RELOAD_TEXT, context: { kind: "reload" } });
    await agents.closeChat(chatId);
    await editProject(
      projectOfKey(chatId),
      (latest) => {
        const current = latest.sessions[sessionId];
        if (!current || (current.suggestion === undefined && current.suggestionTurnId === undefined)) return latest;
        const { suggestion: _suggestion, suggestionTurnId: _turn, ...session } = current;
        return { ...latest, sessions: { ...latest.sessions, [sessionId]: session } };
      },
      { chats: [] },
    );
  });

  commands.handle("chat:task-output", async (_event, chatId, taskId) => {
    await existingChat("reading a background task")(chatId);
    if (typeof taskId !== "string" || !taskId || taskId.length > 200) throw new Error("That background task isn't valid.");
    return agents.taskOutput(chatId, taskId);
  });

  async function stopChat(chatId) {
    chatSecrets?.cancel(chatId);
    bugReports?.cancel(chatId);
    const cancellingResume = chats.cancelLimitResume(projectOfKey(chatId), sessionIdFromKey(chatId));
    void track(() => cancellingResume, background).catch((error) => console.warn("Milagre couldn't save a cancelled continuation:", error.message));
    await linked.stop({ chatKey: chatId });
    await advisorDelivery.stop(chatId);
    await advisors.stopChat(chatId);
    if (await chats.cancelHandoff(chatId)) return;
    await worktreeSetups.cancel(chatId);
    await agents.interrupt(chatId);
  }

  async function respondPermission({ chatId, requestId, decision }) {
    if (typeof requestId === "string" && requestId.startsWith("setup-review-")) return setupReview.respond(chatId, requestId, decision);
    return agents.respondToPermission(chatId, requestId, decision);
  }
  commands.handle("agent:respond-permission", async (_event, request) => {
    const accepted = await respondPermission(request);
    if (accepted) noteHumanActed(request.chatId);
    return accepted;
  });
  function noteHumanActed(chatId) {
    void subchatEscalation.humanActed(chatId).catch((error) => console.warn("Milagre couldn't follow a Subchat's family:", error.message));
  }

  commands.handle("agent:answer-question", (_event, request = {}) => answerQuestion(request));
  async function answerQuestion({ chatId, requestId, answers, summary, images, suggestionId }, sender = null) {
    if (require("./chat-secrets.cjs").isSecretRequest(requestId)) {
      const accepted = chatSecrets.answer(chatId, requestId, answers);
      if (accepted) noteHumanActed(chatId);
      return accepted;
    }
    if (require("./bug-reports.cjs").isBugReportRequest(requestId)) {
      if (sender) throw new Error("Only the user can approve a Milagre bug report.");
      const accepted = bugReports.answer(chatId, requestId, answers);
      if (accepted) noteHumanActed(chatId);
      return accepted;
    }
    const { answerImages, withAnswerImages } = require("./agents/questions.cjs");
    const attached = answers ? answerImages(images) : {};
    for (const [id, list] of Object.entries(attached))
      attached[id] = (await mobileUploads.resolveImages(projectOfKey(chatId), list)).map(({ id: imageId, name, dataUrl }) => ({ id: imageId, name, dataUrl }));
    const stored = Object.keys(attached).length ? await chats.storeAnswerImages(chatId, attached) : {};
    const { agent, shown } = withAnswerImages(answers, stored);
    const storedImages = Object.values(stored).flat();
    const recorded =
      answers && typeof summary === "string" && summary && typeof chatId === "string" && scopeStates.has(projectOfKey(chatId))
        ? chats.recordAnswers(chatId, summary, { requestId, answers: shown, images: storedImages }).catch((error) => {
            console.warn("Milagre couldn't show the answers:", error.message);
            return null;
          })
        : Promise.resolve(null);
    const answering = subchatEscalation.answering(chatId, requestId, {
      label: sender?.answerLabel ?? summary,
      suggestionId: typeof suggestionId === "string" ? suggestionId : undefined,
      sender,
    });
    let accepted;
    try {
      accepted = await agents.answerQuestion(chatId, requestId, answers && agent);
    } catch (error) {
      answering.failed();
      const messageId = await recorded;
      if (messageId !== null) await chats.takeBack(chatId, messageId);
      throw error;
    }
    const messageId = await recorded;
    if (!accepted && messageId !== null) await chats.takeBack(chatId, messageId);
    if (!accepted) answering.failed();
    else void answering.accepted().catch((error) => console.warn("Milagre couldn't follow an answer to a Subchat:", error.message));
    return accepted;
  }

  commands.handle("agent:dismiss-suggestion", async (_event, { chatId, id } = {}) => {
    if (typeof chatId !== "string" || typeof id !== "string") throw new Error("That suggestion isn't valid.");
    return subchatEscalation.suggestions.dismiss(chatId, id);
  });

  async function setPermissionMode(chatId, mode) {
    if (!PERMISSION_MODES.has(mode)) throw new Error(`Unknown permission mode: ${mode}`);
    const scope = projectOfKey(chatId);
    const state = await scopeStates.get(scope);
    const session = state.sessions[sessionIdFromKey(chatId)];
    canvasChatModes.assertWritable(scope, state, session, state.worktrees?.[session?.worktree_id]);
    if (mode !== "full") await advisors?.stopExecution(chatId);
    const result = await chats.setPermissionMode(chatId, mode, (id, picked) => agents.setPermissionMode(id, picked));
    if (mode === "full") advisors?.resumeExecution(chatId);
    return result;
  }
  commands.handle("agent:set-permission-mode", (_event, { chatId, mode }) => setPermissionMode(chatId, mode));

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
  const advisorStore = require("./advisor-store.cjs").createAdvisorStore({ dataDir });
  const advisorTransports = new Map();
  const advisorMcp = require("./linked-mcp-server.cjs").createLinkedMcpServer({ toolsFor: (id) => advisorTransports.get(id) ?? [] });
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
  advisorDelivery = require("./advisor-delivery.cjs").createAdvisorDelivery({
    store: advisorStore,
    contextFor: advisorContext,
    isBlocked: (chatId) => closing || chats.preparing.has(chatId) || Boolean(chats.runs[chatId]?.approvals.length || chats.runs[chatId]?.questions.length),
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
  advisors = require("./advisors.cjs").createAdvisors({
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
      const existing = require("./chat-images.cjs").imagePaths({ body: output }, cwd);
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
      const tools = [...require("./advisor-reads.cjs").createAdvisorReads({ roots: context.roots, referenceRoots }), ...canvasReads];
      const executionAdvisor = record.mode === "execution";
      if (executionAdvisor)
        tools.push(...require("./chat-browsers.cjs").browserToolDefinitions(record.chatId, browsers), ...simulatorToolDefinitions(record.chatId, simulators));
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
        env: provider.env,
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
      const chatId = chatKey(scope, sessionId);
      await archiveChat(scope, sessionId);
      await worktreeSetups.cancel(chatId);
      await agents.closeChat(chatId);
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
  commands.handle("project:registry", async () => withoutHomes(await projectRegistry().list()));
  commands.handle("project:position", (_event, id, position) => projectRegistry().setPosition(id, position));
  commands.handle("canvas:snapshot", async () => {
    await projectRegistry().list();
    await pruneLinks(await canvasActiveWorktrees());
    const registry = await projectRegistry().snapshot();
    const recent = await withHidden(await recentProjects().list());
    const sidebarPaths = new Set(recent.filter((p) => !p.hidden).map((p) => p.path));
    const linkedIds = new Set();
    for (const link of registry.links) {
      if (link.a?.project_id) linkedIds.add(link.a.project_id);
      if (link.b?.project_id) linkedIds.add(link.b.project_id);
    }
    for (const group of registry.projectGroups || []) {
      for (const id of group.projectIds) linkedIds.add(id);
    }
    registry.projects = registry.projects.filter((project) => sidebarPaths.has(project.path) || linkedIds.has(project.id));
    const statesByPath = await Promise.all(registry.projects.map(async (project) => ({ path: project.path, state: (await readProject(project.path)).state })));
    return { ...registry, links: await canvasChatModes.describe(registry.links), states: statesByPath };
  });
  async function addLink(a, b) {
    const active = await canvasActiveWorktrees();
    const before = new Set((await projectRegistry().snapshot()).links.map((link) => link.id));
    await projectRegistry().addLink(a, b, active);
    const links = await linksChanged();
    const added = links.find((link) => !before.has(link.id));
    if (added) void linked.linkAdded(added, active).catch((error) => console.warn("Milagre couldn't mark the linked Chats:", error.message));
    return links;
  }
  async function removeLink(id) {
    return canvasChatModes.remove(id, async () => {
      await projectRegistry().removeLink(id);
      await linked.linkRemoved(id);
      return linksChanged();
    });
  }
  commands.handle("canvas:link-add", (_event, a, b) => addLink(a, b));
  commands.handle("canvas:link-remove", (_event, id) => removeLink(id));
  const canvasChatModes = require("./canvas-chat-mode.cjs").createCanvasChatModes({
    registry: projectRegistry(),
    store: linkStore,
    scheduled: () => routines.list().routines,
    states,
    readProject,
    ownProject,
    chats,
    agents,
    broadcast: broadcastProjectState,
    changed: linksChanged,
    git,
  });
  commands.handle("canvas:chat-mode", (_event, id, mode) => canvasChatModes.change(id, mode));
  commands.handle("canvas:link-restore", async (_event, link) => {
    await projectRegistry().restoreLink(link, await canvasActiveWorktrees());
    return linksChanged();
  });
  const LINKS_PRUNE_MS = 5000;
  let linksPrune = { at: -Infinity, running: null };
  commands.handle("canvas:links", async () => {
    if (!linksPrune.running && Date.now() - linksPrune.at >= LINKS_PRUNE_MS) {
      const running = pruneLinks().finally(() => {
        linksPrune = { at: Date.now(), running: null };
      });
      linksPrune = { ...linksPrune, running };
    }
    await linksPrune.running;
    return canvasChatModes.describe((await projectRegistry().snapshot()).links);
  });
  commands.handle("linked:grant", (_event, chatId, linkId) => linked.grant(chatId, linkId));
  commands.handle("canvas:worktree-position", (_event, id, worktreePath, position) => projectRegistry().setWorktreePosition(id, worktreePath, position));
  commands.handle("canvas:open-project", async (_event, requested) => {
    if (chatsHome.isHome(requested) && (await chatsHome.exists())) return openProject(chatsHome.path, { remember: false, register: false });
    if (!(await projectRegistry().list()).some((project) => project.path === requested)) throw new Error("Project is not in the registry.");
    return openProject(requested);
  });
  const withoutHomes = (list) => list.filter((project) => !chatsHome.isHome(project.path));
  async function withHidden(list) {
    const hidden = await projectSettings().hiddenPaths();
    return list.map((project) => (hidden.has(project.path) ? { ...project, hidden: true } : project));
  }
  const origins = new Map();
  function projectOrigin(projectPath) {
    let origin = origins.get(projectPath);
    if (!origin) {
      origin = git.checked(projectPath, ["remote", "get-url", "origin"]).then(
        ({ stdout }) => originId(stdout),
        () => null,
      );
      origins.set(projectPath, origin);
    }
    return origin;
  }
  const withOrigins = (list) =>
    Promise.all(
      list.map(async (project) => {
        const origin = await projectOrigin(project.path);
        return origin ? { ...project, origin } : project;
      }),
    );
  commands.handle("project:recent", async () => withOrigins(withoutHomes(await withHidden(await recentProjects().list()))));
  commands.handle("project:known", async () => {
    const known = withoutHomes(await projectRegistry().list())
      .map((project) => ({ path: project.path, name: project.name || path.basename(project.path), openedAt: project.openedAt ?? "" }))
      .toSorted((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
    return withOrigins(known);
  });
  commands.handle("onboarding:agent-folders", async () => withoutHomes(await (options.agentFolders ?? agentFolders)()));
  const onboardingProjects = options.onboardingProjects ?? createOnboardingProjects();
  commands.handle("onboarding:create", async (_event, name) => openProject((await onboardingProjects.create(name)).path));
  commands.handle("onboarding:clone", async (_event, url, parent) => openProject((await onboardingProjects.clone(url, parent)).path));
  commands.handle("onboarding:init-git", async (_event, folder) => openProject((await onboardingProjects.initGit(folder)).path));
  commands.handle("project:set-hidden", async (_event, projectPath, hidden) => {
    await knownFolder(projectPath);
    await projectSettings().setHidden(projectPath, hidden === true);
    return withHidden(await recentProjects().list());
  });
  commands.handle("project:read", async (_event, projectPath, read) => {
    const known = chatsHome.isHome(projectPath) ? await chatsHome.exists() : (await recentProjects().list()).some((item) => item.path === projectPath);
    if (!known) throw new Error("Open this project in Milagre first.");
    const project = withKind(await readProject(projectPath));
    if (read?.state !== false) return project;
    const { state: _state, ...rest } = project;
    return rest;
  });
  commands.handle("scope:retry-save", async (_event, scope) => {
    if (typeof scope !== "string" || !scopeStates.has(scope)) throw new Error("Open the Project or Link before retrying its save.");
    await scopeStates.retry(scope);
  });
  commands.handle("project:snapshot", async (_event, projectPath) => {
    if (!states.has(projectPath)) throw new Error("Open the project before reading its snapshot.");
    return withKind({ path: projectPath, name: projectName(projectPath), git: projectsWithGit.get(projectPath) ?? true, state: await states.get(projectPath) });
  });
  commands.handle("chat:message", async (_event, scope, id) => {
    if (typeof scope !== "string" || (!isLinkScopeKey(scope) && !states.has(scope))) throw new Error("Open the Project before reading its messages.");
    const message = await scopeStates.findMessage(scope, "id", id);
    if (!message) throw new Error("That message is no longer in this Project.");
    return withDetails(scopeStates.storageDirectory(scope), message);
  });
  const checkReadable = (scope) => {
    if (typeof scope !== "string" || (!isLinkScopeKey(scope) && !states.has(scope))) throw new Error("Open the Project before reading its messages.");
  };
  const readScope = async (scope) => {
    checkReadable(scope);
    return scopeStates.get(scope);
  };
  commands.handle("chat:all-messages", async (_event, scope, options) => {
    checkReadable(scope);
    const read = { withState: options?.withState === true };
    return options?.marks === true ? scopeStates.messageMarks(scope, read) : scopeStates.allMessages(scope, read);
  });
  commands.handle("chat:messages", async (_event, scope, chatId, options) => {
    if (typeof scope === "string" && !isLinkScopeKey(scope) && !states.has(scope) && Number.isSafeInteger(chatId) && existsSync(chatDbFile(scope))) {
      const known = chatsHome.isHome(scope) ? await chatsHome.exists() : (await recentProjects().list()).some((item) => item.path === scope);
      if (known && !states.has(scope))
        return chatPage(
          readChatRows(scope, [chatId]).map((row) => row.message),
          chatId,
          options ?? {},
        );
    }
    checkReadable(scope);
    return chatPage((await scopeStates.load(scope, [chatId])).messages, chatId, options ?? {});
  });
  commands.handle("chat:search", async (_event, scope, query, options) => {
    const state = await readScope(scope);
    const open = Object.values(state.sessions ?? {})
      .filter((session) => !session.archived)
      .map((session) => session.id);
    return chatSearch(state, query, options ?? {}, await scopeStates.searchableMessages(scope, open));
  });
  commands.handle("chat:subagent", async (_event, scope, chatId, agentId) => {
    const agent = (await readScope(scope)).sessions?.[chatId]?.subagents?.find((item) => item.id === agentId);
    if (!agent) throw new Error("That subagent is no longer in this Chat.");
    return agent;
  });
  commands.handle("project:chat-image", (_event, projectPath, requested) => chats.images.resolve(projectPath, requested));
  commands.handle("project:worktree-paths", async (_event, projectPath) => {
    if (!states.has(projectPath)) throw new Error("Open the project before reading its worktrees.");
    return Object.values((await states.get(projectPath)).worktrees ?? {}).map((worktree) => worktree.path);
  });
  commands.handle("project:switch", async (_event, requested) => {
    if (chatsHome.isHome(requested) && (await chatsHome.exists())) return openProject(chatsHome.path, { remember: false, register: false });
    return openProject(await switchTarget(recentProjects(), requested));
  });
  commands.handle("chats:home", async () => ({ path: chatsHome.path, exists: await chatsHome.exists() }));
  commands.handle("chats:ensure", async () => openProject(await chatsHome.ensure(), { takeNotice: false, focus: false, remember: false, register: false }));
  const realDataDir = realpathSync(dataDir);
  const assertRegistrableProject = (folder) => {
    const relative = path.relative(realDataDir, folder);
    const insideDataDir = !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (chatsHome.isHome(folder) || insideDataDir) throw Error("That folder belongs to Milagre's internal state and cannot be registered as a Project.");
  };
  commands.handle("project:forget", async (_event, projectPath) => {
    localMcp.forgetProjectGrants(projectPath);
    return withHidden(await recentProjects().forget(projectPath));
  });
  const projectFinder = createProjectFinder(options.projectSearchRoot || require("node:os").homedir());
  commands.handle("project:find", (_event, query) => projectFinder.search(typeof query === "string" ? query.slice(0, 200) : ""));
  commands.handle("project:scan-children", async (_event, folder) => ({
    ...(await scanFolder(folder)),
    detect: (await projectSettings().getDetectRepositories()).detectRepositories,
  }));
  commands.handle("folder-repos:detect:read", () => projectSettings().getDetectRepositories());
  commands.handle("folder-repos:detect:save", (_event, value) => projectSettings().setDetectRepositories(value !== false));

  const designAdapter = path.join(__dirname, "design-mcp-tools.cjs");
  const localMcpHost = require("./local-mcp-host.cjs").createLocalMcpHost({
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
    suggestAnswer: (chatId, details) => subchatEscalation.suggest(chatId, details),
    patchChat,
    searchChats: async (projectPath, query, limit) => await handlers.get("chat:search")(null, projectPath, query, { limit }),
    links: { list: async () => (await projectRegistry().snapshot()).links, add: addLink, remove: removeLink },
    activeWorktrees: async (projectPath) => (await activeWorktrees(projectPath)).map((worktree) => worktree.path),
    approve: (chatId, request) => agents.askApproval(chatId, request),
    models: (projectPath) => handlers.get("agent:models")(null, projectPath),
    getProjectAccounts: (projectPath, refresh) => handlers.get("accounts:scope")(null, projectPath, refresh),
    assignProjectAccount: async (projectPath, provider, id, canAssign) => limitSwitch.decorate(await assignAccount(projectPath, provider, id, { canAssign })),
    worktreeStatus,
    removeWorktree: (projectPath, worktreePath) => handlers.get("worktree:remove")(null, worktreePath, { projectPath }),
    assertRegistrableProject,
    registerProject: async (folder) => {
      assertRegistrableProject(folder);
      await openProject(folder, { takeNotice: false, focus: false });
      emit("local-mcp:changed", { projectAdded: true });
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
  const localMcp = require("./local-mcp.cjs").createLocalMcp({
    dataDir,
    emit,
    environmentReady,
    clientOptions: options.localMcpClients,
    designGroup: existsSync(designAdapter) ? require(designAdapter).createDesignToolGroup({ artifacts }) : undefined,
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

  function close() {
    clearInterval(uploadSweepTimer);
    chatSecrets?.close();
    bugReports?.close();
    void doneSweep.stop();
    void snoozeSweep.stop();
    closing = true;
    pullRequests.close();
    for (const chatId of chats.limitResumeFlights.keys()) chats.invalidateLimitResume(projectOfKey(chatId), sessionIdFromKey(chatId), "shutdown");
    subchatEscalation.close();
    const routinesStopped = routines.stop();
    const limitResumeStopped = limitResume.stop();
    linked.suspend();
    closed ??= (async () => {
      await routinesStopped;
      await limitResumeStopped;
      await localMcp.close();
      await advisorDelivery.close();
      await advisors.close();
      await advisorMcp.close();
      await advisorStore.close();
      await Promise.all([
        simulators.close(),
        browsers.close(),
        panelForwarders.closeAll(),
        artifacts.close(),
        designKits.close(),
        pageComments.close(),
        terminals.dispose(),
      ]);
      await linear.dispose();
      await Promise.allSettled(active);
      await attachmentTransfers.close();
      accounts.close();
      keybindings.close();
      keepAwake.quit();
      computerResources.close();
      ports.close();
      diffs.close();
      if (!states.closed) {
        await chats.suspendRunning();
        await scopeStates.flush().catch(() => {});
        await Promise.allSettled([worktreeSetups.cancelAll(), agents.closeAll()]);
        await Promise.allSettled(starting);
        await agents.closeAll();
        await Promise.allSettled([...background, ...chatTitles.pending.values()]);
      }
      while (background.size) await Promise.allSettled(background);
      await states.close();
      await linkStore.close();
      await linked.close();
      await usage.idle();
      for (const { owner } of projectOwners.values()) owner.release();
      for (const owner of repositoryOwners.values()) owner.release();
      dataOwner.release();
    })().catch((error) => {
      closed = undefined;
      throw error;
    });
    return closed;
  }

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
