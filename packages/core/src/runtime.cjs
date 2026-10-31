const { chatMentionsContext } = require("./chat-mentions.cjs");
const { createAccountRouting } = require("./account-routing.cjs");
const { createLimitSwitch } = require("./limit-switch.cjs");
const { createMcp } = require("./mcp/index.cjs");
const { createMcpStore } = require("./mcp/store.cjs");
const { openInBrowser } = require("./antigravity-account.cjs");
const { createAccounts } = require("./accounts.cjs");
const { createLinkStore } = require("./link-store.cjs");
const { createLinkWorkspaces } = require("./link-workspaces.cjs");
const { createChatScopes } = require("./chat-scopes.cjs");
const { registerLinkRuntime } = require("./link-runtime.cjs");
const { isLinkScopeKey, scopeFromKey, scopeKey } = require("@milagre/shared/chat-scopes");
const { PROVIDERS } = require("@milagre/shared/providers");
const { CHATS_ACCOUNT_LABEL } = require("@milagre/shared/chats-home");
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
const { antigravityAcp, sweepTempDirs } = require("./agents/antigravity-acp.cjs");
const { kiroAcp } = require("./agents/kiro-acp.cjs");
const { createKiroUsage } = require("./kiro-usage.cjs");
const { createCliCache } = require("./agents/cli.cjs");
const { createProviderUpdates, releaseVersion } = require("./agents/provider-updates.cjs");
const { runCliUpdate } = require("./agents/cli-update.cjs");
const { createAntigravity } = require("./agents/antigravity-install.cjs");
const { recoverAntigravitySubagents } = require("./agents/antigravity-subagents.cjs");
const { loadLoginEnvironment, refreshInstallPath } = require("./agents/environment.cjs");
const { failedWith, hostNetworkInstructions, loginMessage } = require("./agents/events.cjs");
const { SessionManager } = require("./agents/session-manager.cjs");
const { PortWatcher } = require("./agents/ports.cjs");
const { ChatHost } = require("./agents/chat-host.cjs");
const { writeTranscript, generateBrief, createHandoverModels } = require("./agents/handover.cjs");
const { discoverSkills, expandSkillPrompt, readDiscoveredSkill } = require("./skills.cjs");
const {
  DEFAULT_WORKTREE_ROOT,
  branchPushed,
  createWorktree,
  issueBranch,
  listBranches,
  moveWorktreeBranch,
  newSuffix,
  renameWorktreeBranch,
} = require("./worktrees.cjs");
const { suggestWorktreeName } = require("./worktree-name.cjs");
const { removeWorktree, worktreeStatus } = require("./worktree-cleanup.cjs");
const { previewFilesToCopy } = require("./worktree-files.cjs");
const { createProjectSettings } = require("./project-settings.cjs");
const { WorktreeSetups, resolveSetupCommand } = require("./worktree-setup.cjs");
const { SetupReview } = require("./setup-review.cjs");
const { readDiffStat } = require("./diffstat.cjs");
const { registerCheckpoints } = require("./checkpoint-runtime.cjs");
const { registerGitHandlers } = require("./git-ipc.cjs");
const { createPullRequestReader, readPullRequestState, readPullRequests } = require("./pull-request.cjs");
const { background: inBackgroundLane } = require("./process-lanes.cjs");
const { createPullRequestWatch } = require("./pull-request-watch.cjs");
const { emptyState, reconcileState, markDisconnectedSubagents } = require("./project-state.cjs");
const { migrateWorktreeChats } = require("./worktree-chats.cjs");
const { createLinear } = require("./linear/index.cjs");
const { createLinearIssues } = require("./linear/issues.cjs");
const { createLinearTools, linearToolDefinitions } = require("./linear/tools.cjs");
const { isIssueKey } = require("./linear/links.cjs");
const { ProjectStates } = require("./project-states.cjs");
const { DiffRefresher } = require("./diff-refresh.cjs");
const { chatKey, isTurnEnd, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { archiveFinishedSubagents, archiveSubagent, deleteSession, patchSession, renameWorktree } = require("@milagre/shared/project-edits");
const { attentionContext, attentionNotice } = require("@milagre/shared/attention");
const { resolveProjectImage } = require("./project-image.cjs");
const { createProjectFinder } = require("./project-finder.cjs");
const { saveProjectState, readProjectState, compactProjectState, stateFile } = require("./project-store.cjs");
const { createRecentProjects, launchProject, plainFolder, rememberProject, switchTarget } = require("./recent-projects.cjs");
const { agentFolders } = require("./agent-folders.cjs");
const { createOnboardingProjects } = require("./onboarding-projects.cjs");
const { activeWorktrees, inspectProject, mainCheckoutWorktrees, outsideGit, resolveProject } = require("./project-identity.cjs");
const { createProjectRegistry } = require("./project-registry.cjs");
const { createLinkedWorktrees } = require("./linked-worktrees.cjs");
const { createUsageReader, readClaudeUsage, readClaudeProfileUsage, readCodexUsage, readAntigravityUsage } = require("./usage.cjs");
const { createUsageStore, cachedSnapshot } = require("./usage-cache.cjs");
const { createTokenUsage } = require("./token-usage.cjs");
const { createTokenUsageScan } = require("./token-usage-scan.cjs");
const { createTokenPricing } = require("./token-usage-pricing.cjs");
const { createRoutines, isRunChat, withRunChatsHidden } = require("./routines/runtime-adapter.cjs");
const { createHookStore } = require("./routines/hook-store.cjs");
const { createAutoUpdate, hostActivity } = require("./app-auto-update.cjs");
const { createComputerResources } = require("./computer-resources.cjs");
const { createKeybindings } = require("./keybindings.cjs");
const { createBabysitSettings } = require("./babysit-settings.cjs");
const { createDoneSettings } = require("./done-settings.cjs");
const { createDoneSweep } = require("./done-sweep.cjs");
const { doneDue } = require("@milagre/shared/done");
const { createBabysitWatch } = require("./babysit-watch.cjs");
// Where webhook URLs point unless the daemon says otherwise (its phone's relay).
const HOOK_RELAY_URL = "wss://relay.milagre.cloud";
const { chatTitle, isHiddenRunChat } = require("@milagre/shared/chats");
// The Chats routines:targets lists per Project, newest first.
const ROUTINE_TARGET_CHATS = 50;

const { createFileSearch } = require("./project-files.cjs");
const { dictationContext, polishDictation, createDictationModels } = require("./dictation.cjs");
const { createBots, unavailableBots } = require("./bots/index.cjs");
const { PERMISSION_MODES, isBotRulesTool } = require("./agents/permissions.cjs");
const { createBotStore } = require("./bots/store.cjs");
const { createChatsHome } = require("./chats-home.cjs");
const { isFolderChatsHome, createFolderChat } = require("./chats-home-folders.cjs");
const { isQuietChat } = require("@milagre/shared/bots");
const git = createGit().read;

/** A registered Project's Worktrees; a Git Project's main checkout needs only its Worktree list (one git call). */
async function registeredWorktrees(project) {
  return (project.git !== false && (await mainCheckoutWorktrees(project.path))) || activeWorktrees(project.path);
}

// The composition root shared by Electron and the local daemon. Storage paths and
// OS/UI actions belong to the host; command names and payloads match the preload.
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
  let closing = false;
  let closed;
  let advisors;
  let advisorDelivery;
  // Set up at the end with what it needs; hidden homes are filtered out of every Project list (ADR-0010).
  let bots;
  // Chats without a Project run in Worktrees of the Chats home. No Project list shows it (clients ask chats:home), and
  // it is never registered or remembered, so the gates that need the registry or the recent list accept it by path.
  const chatsHome = createChatsHome({ root: options.chatsHome ?? path.join(require("node:os").homedir(), ".milagre", "chats") });
  // A Project result for the home says so: clients key on `kind`, since each computer's home is at its own path.
  const withKind = (project) => (chatsHome.isHome(project.path) ? { ...project, kind: "chats" } : project);
  // The home as the Milagre MCP host and Routines see it: a project-less Chat's own tools and Heartbeats reach it.
  const chatsHomeEntries = async () => ((await chatsHome.exists()) ? [{ path: chatsHome.path, name: projectName(chatsHome.path), kind: "chats" }] : []);
  // The bot that runs a Chat (its thread, or a Chat it opened the user hasn't taken over), by name, else null.
  const botRunning = (chatId) => (typeof chatId === "string" ? (bots?.botForChat(chatId)?.bot.name ?? null) : null);
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
    // Another open of this path may have finished while git was running.
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
  const { createChatSimulators, simulatorToolDefinitions } = require("./chat-simulators.cjs");
  const existingChat = (action) => async (chatId) => {
    const scope = projectOfKey(chatId),
      id = sessionIdFromKey(chatId);
    if (!scope || !Number.isSafeInteger(id) || id < 1 || !scopeStates.has(scope) || !(await scopeStates.get(scope)).sessions[id])
      throw new Error(`Open an existing Chat before ${action}.`);
  };
  // Experimental: agents operate desktop apps through agent-desktop, asking once per app per Chat.
  const { createComputerUseSettings, createComputerUse, agentDesktopBinary, runCli } = require("./computer-use.cjs");
  const computerUseSettings = createComputerUseSettings({ file: path.join(dataDir, "computer-use.json"), emit });
  // The Chat's live screen: the window its agent last used, captured while it works.
  let desktopCli;
  const computerUseScreen = require("./computer-use-screen.cjs").createScreenFeed({
    exec: (args, runOptions) => runCli({ ...(desktopCli ??= agentDesktopBinary()), home: path.join(dataDir, "agent-desktop") }, args, runOptions),
    dir: path.join(dataDir, "computer-use", "frames"),
  });
  const computerUse =
    options.computerUse ??
    createComputerUse({
      dataDir,
      settings: computerUseSettings,
      approve: (chatId, request) => agents.askApproval(chatId, request),
      onAction: ({ chatId, app, data }) => computerUseScreen.touch({ chatId, app, windowId: data?.window?.id, title: data?.window?.title }),
    });
  // Experimental: devices leased from a Simlock worker or gateway sit beside this Mac's own simulators.
  const { createSimlockSettings, createSimlockHost } = require("./simlock.cjs");
  const simlockSettings = createSimlockSettings({ file: path.join(dataDir, "simlock.json"), emit });
  const simlock =
    options.simlock ??
    createSimlockHost({
      settings: simlockSettings,
      directory: path.join(dataDir, "simlock"),
      log: (message, fields) => console.warn(`Simlock: ${message}`, fields),
    });
  const simulators = createChatSimulators({
    simulators:
      options.simulators ??
      require("./simulators.cjs").createSimulators({
        adapter: require("./simlock-channel.cjs").withSimlock(require("./simulators-helper.cjs").createSimulatorAdapter(), simlock),
      }),
    file: path.join(dataDir, "simulator-attachments.json"),
    validateChat: existingChat("attaching a simulator"),
    ended: (device) => simlock.isDevice(device.id),
  });
  const { createChatArtifacts, artifactToolDefinitions, htmlArtifactToolDefinitions, artifactCommentToolDefinitions } = require("./chat-artifacts.cjs");
  const artifacts = createChatArtifacts({
    directory: path.join(dataDir, "artifacts"),
    validateChat: existingChat("showing a design"),
  });
  const designPageSharing = require("./design-page-sharing.cjs").createDesignPageSharing({
    directory: path.join(dataDir, "design-page-shares"),
    artifacts,
    validateChat: existingChat("sharing Designs"),
    chatTitle: async (chatId) => {
      const session = (await scopeStates.get(projectOfKey(chatId)))?.sessions[sessionIdFromKey(chatId)];
      return session?.title || session?.generatedTitle || null;
    },
    ...options.designSharing,
  });
  commands.handle("artifact:page-shares", (_context, request) => designPageSharing.list(request));
  commands.handle("artifact:sharing-status", (_context, request) => designPageSharing.status(request));
  commands.handle("artifact:all-page-shares", () => designPageSharing.listAll());
  commands.handle("artifact:revoke-saved-page-share", (_context, request) => designPageSharing.revokeSaved(request));
  commands.handle("artifact:share-page", (_context, request) => designPageSharing.publish(request));
  commands.handle("artifact:revoke-page-share", (_context, request) => designPageSharing.revoke(request));
  // Designs are always on. Older apps and paired computers still read the switch, and saving it changes nothing.
  commands.handle("designs:enabled:read", () => ({ enabled: true }));
  commands.handle("designs:enabled:save", () => ({ enabled: true }));
  commands.handle("artifact:get", (_context, request) => artifacts.get(request));
  commands.handle("artifact:asset", (_context, request) => artifacts.asset(request));
  commands.handle("artifact:list", (_context, request) => artifacts.list(request));
  commands.handle("artifact:apply", (_context, request) => artifacts.apply(request));
  commands.handle("artifact:delete", (_context, request) => artifacts.deleteDesign(request));
  commands.handle("artifact:add-comments", (_context, request) => artifacts.addComments(request));
  commands.handle("artifact:comments", (_context, request) => artifacts.comments(request));
  // Comments the user left on Browser panel pages (spec docs/superpowers/specs/2026-10-28-internal-browser-design.md).
  const { commentAtPoint, createChatPageComments, pageCommentToolDefinitions } = require("./chat-page-comments.cjs");
  const pageComments = createChatPageComments({
    directory: path.join(dataDir, "page-comments"),
    validateChat: existingChat("commenting on a page"),
  });
  commands.handle("browser-comments:add", (_context, request) => pageComments.add(request));
  commands.handle("browser-comments:list", (_context, request) => pageComments.list(request));
  // A comment from the phone's view of a Browser panel page: the element at the tapped point (as fractions of the page),
  // its screenshot, and the message, sent as the user's in the Chat's own provider, model and mode, then recorded.
  commands.handle("browser-comments:send-from-page", async (_context, request) => {
    const chatId = typeof request?.chatId === "string" ? request.chatId : "";
    const text = typeof request?.text === "string" ? request.text.trim().slice(0, 4000) : "";
    const point = [request?.x, request?.y];
    if (!chatId || !text) throw new Error("Write the comment first.");
    if (!point.every((value) => typeof value === "number" && value >= 0 && value <= 1)) throw new Error("Tap the page to place a comment pin.");
    const scope = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    const session = scope && Number.isSafeInteger(sessionId) ? (await scopeStates.get(scope))?.sessions?.[sessionId] : null;
    if (!session) throw new Error("Open an existing Chat before commenting on a page.");
    const { target, session: page } = await browsers.devtools({ chatId, page: typeof request.targetId === "string" ? request.targetId : undefined });
    const { pageCommentId, pageCommentsMessage } = await import("@milagre/shared/page-comments");
    const { element, shot } = await commentAtPoint(page, point[0], point[1]);
    const id = pageCommentId();
    const comment = { id, url: target.url, title: target.title, element, text };
    // Recorded first: a comment the store refuses is never sent, and the agent can resolve every one it reads.
    await pageComments.add({ chatId, comments: [comment] });
    const settings = chats.turnSettings(chatId) ?? {};
    // The phone user's own message, so a bot's Chat or a Run Chat treats it like one typed in the composer.
    try {
      await sendAsUser({
        ...settings,
        provider: session.provider ?? settings.provider ?? "claude",
        model: chats.runs[chatId]?.model || require("@milagre/shared/agent-runs").lastUserModel(await scopeStates.get(scope), sessionId) || settings.model,
        permissionMode: agents.permissionMode(chatId, settings.permissionMode ?? session.permissionMode ?? "ask"),
        projectPath: scope,
        sessionId,
        body: pageCommentsMessage([comment], { screenshots: !!shot }),
        images: shot ? [{ id: `page-comment-${id}`, name: `page-comment-${id}.png`, dataUrl: `data:image/png;base64,${shot}` }] : [],
        files: [],
      });
    } catch (error) {
      await pageComments.forget({ chatId, ids: [id] }).catch(() => {});
      throw error;
    }
    return { id };
  });
  for (const method of ["list", "attach", "detach"])
    commands.handle(`simulator:${method}`, async (context, request) => {
      if (!context?.clientId) throw new Error("Simulator access requires an authenticated connection");
      // Detaching a Chat's own Simlock lease returns it, so a phone or older desktop doesn't keep it until its maximum age.
      const lease = method === "detach" ? simlock.get(request?.deviceId) : null;
      if (lease && lease.chatId === request?.chatId) await simlock.release(lease.deviceId).catch(() => {});
      return simulators[method](request);
    });
  for (const method of ["open", "offer", "frame", "status", "control", "input", "repair", "close"]) {
    commands.handle(`simulator:${method}`, (context, request) => {
      if (!context?.clientId) throw new Error("Simulator access requires an authenticated connection");
      return simulators[method === "close" ? "closeViewer" : method](request, context.clientId);
    });
  }
  /** Leases a Simlock device for a Chat and attaches it there; installs are accepted from the Chat's folder. */
  async function leaseSimlock(request) {
    const chatId = request?.chatId;
    await existingChat("leasing a Simlock device")(chatId);
    // Installs come from the Chat's own Worktree (a shared Chat's workspace), the folder its agent works in.
    const roots = await chatWorktrees(chatId);
    const session = (await scopeStates.get(projectOfKey(chatId))).sessions[sessionIdFromKey(chatId)];
    const installDirectory = isLinkScopeKey(projectOfKey(chatId)) ? (session?.workspacePath ?? roots[0]?.path) : roots[0]?.path;
    if (!installDirectory) throw new Error("This Chat has no Worktree yet. Send it a message first, then lease a device.");
    const leased = await simlock.lease({ platform: request?.platform, model: request?.model || undefined, chatId, installDirectory });
    try {
      await simulators.attach({ chatId, deviceId: leased.deviceId });
    } catch (error) {
      await simlock.release(leased.deviceId).catch(() => {});
      throw error;
    }
    return leased;
  }
  async function releaseSimlock(request) {
    const lease = simlock.get(request?.deviceId);
    const released = await simlock.release(request?.deviceId);
    if (lease?.chatId) await simulators.detach({ chatId: lease.chatId, deviceId: lease.deviceId }).catch(() => {});
    return released;
  }
  commands.handle("computer-use:settings:read", () => computerUseSettings.read());
  commands.handle("computer-use:settings:save", (_context, patch) => computerUseSettings.save(patch));
  commands.handle("computer-use:status", () => computerUse.status());
  commands.handle("computer-use:guide", () => computerUse.guide());
  commands.handle("computer-use:frame", (_context, request) => computerUseScreen.next({ chatId: request?.chatId, after: Number(request?.after) || 0 }));
  commands.handle("simlock:settings:read", () => simlockSettings.read());
  commands.handle("simlock:settings:save", (_context, patch) => simlockSettings.save(patch));
  commands.handle("simlock:identity", (_context, request) => simlock.identity(request ?? {}));
  commands.handle("simlock:models", async () => ({ models: await simlock.models(), leases: simlock.leases() }));
  commands.handle("simlock:lease", (context, request) => {
    if (!context?.clientId) throw new Error("Simlock access requires an authenticated connection");
    return leaseSimlock(request);
  });
  commands.handle("simlock:release", (context, request) => {
    if (!context?.clientId) throw new Error("Simlock access requires an authenticated connection");
    return releaseSimlock(request);
  });
  // `agents` is created below; ownership roots are read only once the service polls.
  function agentProcesses() {
    const roots = agents.processes();
    for (const [chatId, children] of advisors?.processes() ?? []) {
      roots.set(chatId, { cwd: children[0].cwd, ...roots.get(chatId), agents: children.map((child) => child.pid) });
    }
    return roots;
  }
  const browsers = options.browsers ?? require("./browsers.cjs").createBrowsers({ roots: agentProcesses });
  commands.handle("browser:list", (_context, request) => browsers.list(request));
  commands.handle("browser:attach", (_context, request) => browsers.attach(request));
  commands.handle("browser:detach", (_context, request) => browsers.detach(request));
  commands.handle("browser:open-page", (context, request) => {
    if (!context?.clientId) throw new Error("Browser access requires an authenticated connection");
    return require("./browser-open-page.cjs").openBrowserPage(browsers, (chatId, url) => emit("browser-panel:open", { chatId, url }), request);
  });
  // The desktop's Browser panel pages: the desktop's main process registers them with its DevTools endpoint. A paired
  // desktop's pages for this host's Chats (#832) come `via: "peer"`: the endpoint is on that desktop's loopback, reached
  // through a forwarder here that carries each connection back over its channel.
  const panelForwarders = require("./panel-forwarders.cjs").createPanelForwarders();
  commands.handle("browser:panel-pages", async (context, request) => {
    if (!context?.clientId) throw new Error("Browser panel pages need an authenticated desktop connection");
    if (request?.via !== "peer") return browsers.setPanelPages(request, context.clientId);
    if (typeof context.openStream !== "function") throw new Error("Only a paired desktop's channel carries its Browser pages.");
    if (!Array.isArray(request.pages) || !request.pages.length) {
      await panelForwarders.close(context.clientId);
      return browsers.setPanelPages({ pages: [] }, context.clientId);
    }
    const port = await panelForwarders.forward(context.clientId, context.openStream, request.port);
    return browsers.setPanelPages({ port, prefix: request.prefix, pages: request.pages }, context.clientId);
  });
  for (const method of ["open", "frame", "status", "control", "input", "close"]) {
    commands.handle(`browser:${method}`, (context, request) => {
      if (!context?.clientId) throw new Error("Browser access requires an authenticated connection");
      return browsers[method === "close" ? "closeViewer" : method](request, context.clientId);
    });
  }
  // A Chat's Terminals start in its Worktree, or in one of a shared Chat's Worktrees. The host resolves them from the
  // saved Chat: a client never names a folder it could not otherwise reach.
  async function chatWorktrees(chatId) {
    const scope = projectOfKey(chatId),
      id = sessionIdFromKey(chatId);
    if (!scope || !Number.isSafeInteger(id) || id < 1 || !scopeStates.has(scope)) throw new Error("Open this Chat before opening a Terminal.");
    const state = await scopeStates.get(scope);
    const session = state.sessions[id];
    if (!session) throw new Error("Open an existing Chat before opening a Terminal.");
    if (session.archived) throw new Error("This Chat is archived.");
    if (isLinkScopeKey(scope)) {
      const worktrees = (session.worktrees ?? []).map((member) => ({ path: member.worktreePath, label: member.alias }));
      // Shared Chats create Worktrees on demand. Before the first one exists, the user can still open a shell
      // in the Chat's own workspace, just as its agent does, without creating branches in every linked Project.
      return worktrees.length ? worktrees : session.workspacePath ? [{ path: session.workspacePath, label: "Workspace" }] : [];
    }
    const worktree = state.worktrees?.[session.worktree_id];
    return worktree?.path ? [{ path: worktree.path, label: path.basename(worktree.path) }] : [];
  }
  const terminals =
    options.terminals ??
    require("./terminals.cjs").createTerminals({
      resolveChat: chatWorktrees,
      settingsFile: path.join(dataDir, "terminal-settings.json"),
      onChange: (chatId) => emit("terminal:changed", { chatId }),
      onPreferencesChanged: () => emit("terminal:preferences-changed", {}),
      onShellsChanged: () => ports.wake(),
    });
  commands.handle("terminal:list", (_context, request) => terminals.list(request));
  for (const method of ["profiles", "setShell", "open", "read", "input", "resize", "close"]) {
    commands.handle(`terminal:${method}`, (context, request) => {
      if (!context?.clientId) throw new Error("Terminal access requires an authenticated connection");
      return terminals[method](request);
    });
  }
  const searchFiles = createFileSearch();
  const environmentReady =
    options.environmentReady ??
    loadLoginEnvironment().then(
      ({ source }) => {
        if (source === "fallback") console.warn("Milagre couldn't read your login shell's environment; looking for agents in common install folders.");
      },
      (error) => console.warn("Milagre couldn't read your login shell's environment:", error.message),
    );
  const usageStore = createUsageStore({ file: path.join(dataDir, "usage-cache.json") });
  // Kiro's month of credits, read from kiro-cli at most every few minutes and shared by every Account selection.
  const kiroUsage = createKiroUsage({ cli: () => baseCli("kiro") });
  // A host may bring its own usage, models and CLI status (the review demo, which runs no real agent).
  const accountUsage = new Map();
  // Tests replace single readers. Claude's and Codex's are called with no arguments; Antigravity's gets the Account's environment.
  const readers = options.usageReaders ?? {};
  function usageForAccounts(scope) {
    const claude = accounts.selected("claude", scope),
      codex = accounts.selected("codex", scope),
      antigravity = accounts.selected("antigravity", scope);
    // The default Antigravity Account adds nothing to the key, so existing cache files keep their names.
    const key = `${claude}-${codex}${antigravity === "default" ? "" : `-${antigravity}`}`;
    if (!accountUsage.has(key)) {
      const store =
        claude === "default" && codex === "default" && antigravity === "default"
          ? usageStore
          : createUsageStore({ file: path.join(dataDir, `usage-${key}.json`) });
      accountUsage.set(key, {
        key,
        // Kiro has only the account kiro-cli is signed in to, so it never splits the cache.
        accountIds: { claude, codex, antigravity, kiro: "default" },
        store,
        read: createUsageReader({
          ready: () => environmentReady,
          store,
          readClaude:
            readers.claude ??
            (async () => {
              const env = accounts.environment("claude", claude);
              return env.CLAUDE_CONFIG_DIR ? readClaudeProfileUsage({ command: (await baseCli("claude")).command, env }) : readClaudeUsage();
            }),
          readCodex: readers.codex ?? (() => readCodexUsage({ env: accounts.environment("codex", codex) })),
          readAntigravity: () => (readers.antigravity ?? readAntigravityUsage)({ env: accounts.environment("antigravity", antigravity) }),
          readKiro: readers.kiro ?? kiroUsage,
        }),
      });
    }
    return accountUsage.get(key);
  }

  async function usageWithAccounts(usage, snapshot) {
    const identities = await accounts.list();
    return {
      ...snapshot,
      accountKey: usage.key,
      providers: snapshot.providers.map((provider) => {
        // Use the IDs captured for this read, even if a selection changed while it was pending.
        const id = usage.accountIds[provider.provider];
        const account = identities.providers.find((group) => group.provider === provider.provider)?.accounts.find((entry) => entry.id === id);
        return {
          ...provider,
          account: { id, label: account?.label || "Removed account", ...(account?.email ? { email: account.email } : {}) },
        };
      }),
    };
  }

  async function discoverWorktrees(projectPath) {
    // A failed read is not evidence that every Worktree was removed.
    // A Project read before as a Git checkout needs only its Worktree list (one git call), while it is still that checkout.
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

  /** The saved state as written, without hydrating subagent transcripts or taking ownership; null when there is none. */
  async function readRawState(projectPath) {
    try {
      return JSON.parse(await fs.readFile(stateFile(projectPath), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  // The Chats home's folder is "chats"; every name a client shows (inbox, notices, a phone on an older app) says "No project".
  const projectName = (projectPath) => (chatsHome.isHome(projectPath) ? "No project" : path.basename(projectPath) || "Untitled project");

  // Chats brought back from linked worktrees' old files, per project, until a window opening it shows the notice.
  const restoredChats = new Map();

  // Before #117 a linked worktree opened as a project kept its chats in its own file. They join the main checkout's
  // state on the first read, before anything uses it. This runs inside ProjectStates' read for the project, after
  // ownProject took the repository's owner lock, so neither another window nor another runtime merges at the same time.
  // Bringing chats back never stops a repository from opening: any failure leaves the files and keeps the stored state.
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

  // Every project's state goes through here: this runtime is its only writer (see ADR-0001 and ADR-0003).
  // A Chat nobody touched for a while leaves memory, unless its turn is busy (see ProjectStates and message-store.cjs).
  // MILAGRE_LAZY_MESSAGES=0 keeps every message in memory, as before #321. MILAGRE_LAZY_MESSAGES_IDLE_MS sets how long a
  // Chat stays idle before it leaves (the sweep runs as often, between 250 ms and a minute): for trying it out and checks.
  let busyChat = () => true;
  const lazy = process.env.MILAGRE_LAZY_MESSAGES !== "0" && lazyMessages !== false;
  const idleOverride = Number(process.env.MILAGRE_LAZY_MESSAGES_IDLE_MS);
  if (lazy && process.env.MILAGRE_LAZY_MESSAGES_IDLE_MS && Number.isFinite(idleOverride) && idleOverride >= 0)
    lazyMessages = { ...lazyMessages, idleMs: idleOverride, sweepMs: Math.min(60_000, Math.max(250, idleOverride)) };
  // A sweep's new state goes out like any other, so the daemon lets go of the state it last sent, unloaded messages too.
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

  // Each named Link's member Project paths, as its last turn found them: a shared Chat's agent manages Worktrees and
  // Chats in those Projects through Milagre's MCP, whose grants are read synchronously (agentScope below). Every turn
  // resolves them before its agent starts (executionContext), so a session's tools always see a current list.
  const linkMembers = new Map();
  const scopeStates = createChatScopes({
    projects: states,
    links: linkStore,
    validateLink: async (id) => {
      const members = await linkWorkspaces.membersAvailable(await linkRuntime.definition(id));
      for (const member of members) await ownProject(member.path);
      linkMembers.set(
        id,
        members.map((member) => member.path),
      );
      return members;
    },
  });
  function broadcastProjectState(projectPath, state) {
    state = scopeStates.withPersistence(projectPath, state);
    if (isLinkScopeKey(projectPath)) {
      emit("link:state", { linkId: scopeFromKey(projectPath).linkId, state });
      return;
    }
    emit("project:state", { path: projectPath, state });
  }

  /**
   * Applies a change to a project's state and tells the windows when it changed. `options.chats` lists the Chats whose
   * messages the change reads or writes ([] for none); without it every Chat is loaded first (see ProjectStates.update).
   */
  async function updateProject(projectPath, change, options) {
    const result = await scopeStates.update(projectPath, change, options);
    if (result.changed) broadcastProjectState(projectPath, result.state);
    return result.state;
  }

  // Explicit user edits keep their existing error contract. The flush waits outside
  // the mutation queue, so other Chats continue receiving streaming events.
  async function editProject(projectPath, change, options) {
    const result = await scopeStates.update(projectPath, change, options);
    if (result.changed) broadcastProjectState(projectPath, result.state);
    await scopeStates.flush(projectPath);
  }

  // Hover-card stats nobody is waiting on: their git reads give way to interactive ones (process-lanes.cjs).
  const diffs = new DiffRefresher({ states, readDiffStat: (...args) => inBackgroundLane(() => readDiffStat(...args)), update: updateProject });

  // Reading a project matches its worktrees with the ones git lists now. A project read before keeps the
  // state this run has built, so a chat's turn that's still running isn't lost.
  // A subagent saved as running without a live agent session behind it (after a restart) is marked disconnected.
  // Whether each Project read this run is a Git repository, for snapshots that don't read it again.
  const projectsWithGit = new Map();
  // Projects read once this run, and per Project the resume of the Chats a quit stopped (see readProject). A bot's home
  // closed when its bot is deleted leaves both, so a home made again reads as new.
  const readOnce = new Set();
  const resumes = new Map();
  // `discovered`: the Worktrees git lists now, when the caller just read them (an open, see openProject).
  async function readProject(projectPath, { discovered: listed } = {}) {
    await ownProject(projectPath);
    const discovered = listed ?? (await discoverWorktrees(projectPath));
    const live = (sessionId) => {
      const entry = agents.sessions.get(`${projectPath}#${sessionId}`);
      return Boolean(entry && !entry.session.closed);
    };
    // Reads no Chat's messages: a Chat that leaves with its Worktree takes its saved rows with it (see project-store.cjs).
    // A folder outside Git has one Worktree, itself. A Project that had other Worktrees and lost its .git keeps them
    // on disk instead of reconciling them away.
    const git = !discovered.some((worktree) => worktree.plain);
    projectsWithGit.set(projectPath, git);
    // Read before the change, outside this Project's queue: a Link busy with its own changes never holds it up.
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
        return migrateImages(projectPath, markDisconnectedSubagents(next, new Set(Object.keys(next.sessions).map(Number).filter(live))));
      },
      { chats: [] },
    );
    // A chat a quit stopped continues now; its message is saved before the project is returned, so the window shows it.
    // It runs once per Project per run, and every read until it is done waits for it.
    // A bot's thread continues only while its bot takes turns (Bots on, not paused); until then its resume waits.
    if (bots?.takesTurns(projectPath) ?? true) {
      if (!resumes.has(projectPath))
        resumes.set(
          projectPath,
          chats.resumeInterrupted(projectPath, state).catch((error) => console.warn("Milagre couldn't resume a chat:", error.message)),
        );
      await resumes.get(projectPath);
    }
    state = await states.get(projectPath);
    // The rest of a first read happens once per run: a later one (each switch back to the Project) only matches its
    // Worktrees with git's. Its diff stats then follow agent steps, window focus and the Chat on screen (DiffRefresher).
    if (!readOnce.has(projectPath)) {
      readOnce.add(projectPath);
      chatTitles.resume(projectPath, state);
      // Run Chats saved before they could be hidden are decided, and hidden ones whose Run left the store are archived.
      void track(() => routines.sweepRunChats(projectPath, state), background);
      void chats.recoverHandoffs(projectPath, state).catch((error) => console.warn("Milagre couldn't recover a handoff:", error.message));
      void diffs.refresh(projectPath).catch(() => {});
    }
    return { path: projectPath, name: projectName(projectPath), git, state };
  }

  const mobileUploads = require("./mobile-uploads.cjs").createMobileUploads({ dataDir: realpathSync(dataDir) });
  const attachmentTransfers = require("./attachment-transfers.cjs").createAttachmentTransfers({
    dataDir: realpathSync(dataDir),
    upload: (request) => mobileUploads.upload(request),
  });
  commands.handle("attachment:upload", async (_event, request) => {
    if (!scopeStates.has(request?.projectPath)) throw new Error("Open the Project or Link before uploading files.");
    try {
      return { file: await attachmentTransfers.receive(request) };
    } catch (error) {
      if (error.status) return { error: { status: error.status, message: error.message } };
      throw error;
    }
  });
  commands.handle("chat:send-status", async (_event, owner, clientMessageId) => {
    if (!scopeStates.has(owner) || typeof clientMessageId !== "string" || !clientMessageId) throw new Error("Choose an open Chat and message identity.");
    return chats.sendStatus(owner, clientMessageId);
  });
  async function attachmentAccess(file) {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Choose an attached file or a file in an open Worktree.");
    // A file in an open Worktree needs no link to it. The search below reads every open Project's saved messages
    // synchronously: from a cold disk it held a busy host for 28 s, nearly the 30 s a paired computer waits for an answer.
    const roots = scopeStates.worktreePaths();
    if (await require("./attachment-preview.cjs").insideRoots(file, roots)) return { roots, attached: [] };
    const { sharedFilePaths, chatFolder } = require("./chat-files.cjs");
    // Search by basename too: a shared link may be relative, URL-encoded or have a line suffix. Unloaded Chats
    // stay unloaded; only candidate rows are read, and the parsed link must name this exact file.
    const name = path.basename(file);
    const needles = [...new Set([JSON.stringify(name).slice(1, -1), encodeURIComponent(name), encodeURI(name)])];
    const attached = [];
    for (const project of scopeStates.projects()) {
      const state = await scopeStates.get(project);
      const messages = await scopeStates.messagesContaining(project, needles);
      const streaming = Object.entries(chats.snapshot().runs)
        .filter(([key]) => projectOfKey(key) === project)
        .map(([key, run]) => Object.assign({}, run, { role: "assistant", session_id: sessionIdFromKey(key) }));
      for (const message of [...(messages || []), ...streaming]) {
        attached.push(...(message.files || []));
        const body = JSON.stringify(message.body || message.text || "");
        if (needles.some((needle) => body.includes(needle)) && sharedFilePaths(message, chatFolder(state, message, project)).has(file)) attached.push(file);
      }
      // One Chat that shared it is enough; the other Projects' saved messages stay unread.
      if (attached.includes(file)) break;
    }
    return { roots, attached };
  }
  commands.handle("attachment:preview", async (_event, file) => {
    const { roots, attached } = await attachmentAccess(file);
    return require("./attachment-preview.cjs").readAttachment(file, roots, attached);
  });
  commands.handle("attachment:read", async (_event, file, offset = 0, version) => {
    const { roots, attached } = await attachmentAccess(file);
    return require("./attachment-download.cjs").readAttachmentChunk(file, offset, version || undefined, roots, attached);
  });
  commands.handle("project:files", async (_event, root, query) => {
    if (!scopeStates.worktreePaths().includes(root) && !scopeStates.workspacePaths().includes(root)) throw new Error("Choose an open project's worktree.");
    if (scopeStates.workspacePaths().includes(root)) {
      const roots = await linkRuntime.workspace(root);
      return (await Promise.all(roots.map(async (member) => (await searchFiles(member.worktreePath, query)).map((file) => `${member.alias}/${file}`)))).flat();
    }
    return searchFiles(root, query);
  });
  // Dictation: the words a Chat's project gives the recognizer, and the AI fix-up of a phone's Apple transcript.
  commands.handle("dictation:context", async (_event, { cwd, chatTitle } = {}) => {
    await knownFolder(cwd);
    return dictationContext({ cwd, chatTitle, listFiles: searchFiles.list });
  });
  commands.handle("dictation:polish", async (_event, { cwd, text, chatTitle, provider } = {}) => {
    await knownFolder(cwd);
    const { terms } = await dictationContext({ cwd, chatTitle, listFiles: searchFiles.list });
    const models =
      options.dictationModels ?? createDictationModels({ cli: async (name) => agentCli(name, await accountScopeForFolder(cwd)), clientVersion: version });
    return polishDictation({ text, terms, chatTitle, provider }, { models });
  });
  // Path-taking commands only serve folders the user opened: an open project, one of its worktrees, or a recent
  // project (the switcher shows their avatars). Any renderer or paired phone script otherwise reaches any folder.
  async function knownFolder(folder) {
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("An absolute Project path is required");
    if (states.has(folder) || scopeStates.worktreePaths().includes(folder) || scopeStates.workspacePaths().includes(folder)) return;
    if ((await recentProjects().list()).some((item) => item.path === folder)) return;
    throw new Error("Open this project in Milagre first.");
  }
  // A null Project lists the user's skills only.
  commands.handle("skills:list", async (_event, projectPath) => {
    if (projectPath !== null) await knownFolder(projectPath);
    return discoverSkills(projectPath);
  });
  commands.handle("skills:read", async (_event, projectPath, file) => {
    if (projectPath !== null) await knownFolder(projectPath);
    return readDiscoveredSkill(projectPath, file);
  });
  commands.handle("project:branches", async (_event, projectPath) => {
    await knownFolder(projectPath);
    return listBranches(projectPath);
  });
  // The avatar lookup runs `gh`, which a Finder launch only finds once the login environment is applied.
  async function projectImage(projectPath) {
    await knownFolder(projectPath);
    const { icon } = await projectSettings().get(projectPath);
    if (icon) return icon;
    await environmentReady;
    return resolveProjectImage(projectPath);
  }
  commands.handle("project:image", (_event, projectPath) => projectImage(projectPath));
  // The icon the user chose in Settings, or null to go back to the repository's own.
  commands.handle("project:set-icon", async (_event, projectPath, icon) => {
    await knownFolder(projectPath);
    await projectSettings().setIcon(projectPath, icon ?? null);
    return projectImage(projectPath);
  });
  // Packaged builds get their release version from electron-builder metadata, not the source package.json.
  commands.handle("app:version", () => version);
  // "Triage an issue" on desktop and phone: the draft of a new Chat that diagnoses this host. `client` names where it started.
  commands.handle("triage:prepare", (_event, client) => require("./triage.cjs").prepareTriage({ dataDir, version, client }));
  // Where Milagre's worktrees live. An unpackaged build can point it elsewhere (live checks use a temporary folder).
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
  // The git calls below wait for the login environment, so they run with the merged PATH.
  commands.handle("worktree:status", async (_event, worktreePath, base) => {
    await knownFolder(worktreePath);
    await environmentReady;
    return worktreeStatus(worktreePath, base);
  });
  // The renderer or the phone sends what the user saw (status, chat) and the project; the daemon re-checks after closing
  // the chat's agent. The path and branch are read from git as they are now, so a branch renamed after creation is found
  // as it is. Whatever the caller sent, only a worktree Milagre made in a project open here goes, and only while no other
  // chat uses it. Two removals of one worktree take turns: the second finds it gone and says so instead of failing.
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
    // The chat being archived must be on this worktree, and no other chat that isn't archived may use it: one may have
    // started there since the user looked, while the archive went through its steps.
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
    // The chats on this worktree go with it, and so do their designs.
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
    // Read again, the project drops the worktree git no longer lists, with its chats.
    if (states.has(projectPath)) await readProject(projectPath);
    if (result.removed) {
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
  // The setup command new worktrees run: the repo's .milagre/worktree.json, else the project's setting.
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
  // Source branch sync: the setting, and one sync at a time per Project and branch.
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
      // Different branches can share upstream refs and FETCH_HEAD, so fetch them in order.
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

  // A Linear issue's current copy, or a thrown error when Linear no longer has the key (nothing is created then).
  // `workspace` is the one the picker showed it from; without it, the workspace that has the key.
  async function readLinearIssue(key, workspace) {
    // Checked before any query, so a Chat that can't reach Linear never creates a Worktree.
    if (!linear.enabled()) throw new Error("Linear is off in Settings › Connections › Linear.");
    if (!linear.workspaces().length) throw new Error("Linear isn't connected.");
    const issue = await linearIssues.readIssue(key, workspace);
    if (!issue) throw new Error(`${key} no longer exists in Linear.`);
    return issue;
  }

  // A new worktree starts on its prompt's first words; a better name replaces its branch's once Haiku
  // picks one, so the chat never waits on it.
  async function nameWorktree(projectPath, created, prompt) {
    // The CLI check waits for the login environment and resolves the path the SDK starts directly (no shell). A
    // missing or broken Claude has no command, and the name stays the prompt's first words.
    const cli = await agentCli("claude", projectPath);
    const slug = await suggestWorktreeName(prompt, { command: cli.problem ? null : cli.command, env: cli.env, timeoutMs: 15_000 });
    if (closing) return;
    const name = await renameWorktreeBranch({ worktreePath: created.path, branch: created.branch, slug });
    if (!name) return;
    await updateProject(projectPath, (state) => renameWorktree(state, { path: created.path, from: created.branch, name }), { chats: [] });
    emit("worktree:renamed", { projectPath, path: created.path, from: created.branch, name });
  }

  commands.handle("worktree:create", async (event, { projectPath, baseBranch, prompt, issueKey, issueWorkspace }) => {
    // Only these fields come from the renderer: the worktree folder and the files copied into it are main's call.
    const request = { projectPath, baseBranch, prompt };
    await ownProject(projectPath);
    await environmentReady;
    // A Chat started from a Linear issue reads the issue again, never the renderer's copy. A missing issue creates nothing.
    if (chatsHome.isHome(projectPath) && (await isFolderChatsHome(projectPath))) {
      if (issueKey) throw new Error("A Chat without a Project cannot be linked to a Linear issue.");
      event?.localMcp?.assertActive();
      const folder = await createFolderChat(projectPath);
      const project = await readProject(projectPath);
      const worktree = Object.values(project.state.worktrees).find((item) => item.path === folder);
      return { project, worktreeId: worktree.id };
    }
    const issue = typeof issueKey === "string" ? await readLinearIssue(issueKey, issueWorkspace) : null;
    const suffix = newSuffix();
    const branch = issue ? await issueBranch({ projectPath, issue, suffix }) : undefined;
    const settings = await projectSettings().get(projectPath);
    // Sync the selected source branch first. A skipped or failed sync never blocks creation.
    const synced = (await projectSettings().getMainSync(projectPath)).enabled ? await syncMain(projectPath, baseBranch) : null;
    // The files are copied into the folder git just made; the rename that follows only changes the branch, so the path holds.
    const created = await createWorktree({
      ...request,
      branch,
      suffix,
      root: worktreeRoot(),
      copyPatterns: settings.filesToCopy,
      // The sync already fetched the source's upstream (or timed out trying): don't wait on it a second time.
      fetched: synced?.branch === baseBranch,
      beforeCreate: event?.localMcp?.assertActive,
    });
    if (created.copy?.notes.length) console.warn("Milagre worktree file copy:", created.copy.notes.join(" "));
    // The setup command runs before the chat's first turn (see agent:start-turn).
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
                  ...(event?.localMcp ? { localMcpOperation: event.localMcp.operationId } : {}),
                  ...(issue ? { linearIssue: issue.key, linearWorkspace: issue.workspace } : {}),
                },
              },
            }
          : latest;
      },
      { chats: [] },
    );
    // The issue moves to In Progress once its Worktree exists, unless that's switched off or the sign-in can only read.
    // Best effort and in the background: the Chat never waits on Linear.
    if (issue && linear.moveToStarted() && linear.canWrite(issue.workspace))
      void track(() => linearIssues.markStarted(issue.key, issue.workspace), background).catch(() => {});
    // A branch named after an issue keeps that name; only a chat named from its prompt gets the Haiku name.
    if (!issue) void track(() => nameWorktree(request.projectPath, created, request.prompt ?? ""), background).catch(() => {});
    return { project: { ...project, state }, worktreeId: listed.id, ...(resolved.note ? { setupNote: resolved.note } : {}) };
  });
  // Links a Worktree that already exists to a Linear issue. A Milagre-named branch that was never pushed and has no PR
  // takes the issue's branch name (the folder keeps its name); any other branch is left alone and only the key is stored.
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
    // Only a Milagre branch is ever checked against git and gh; a branch the user named keeps its name without a lookup.
    // The branch is renamed only when it was never pushed and gh definitely reports no PR in any state.
    let renamable = false;
    if (worktree.name.startsWith("milagre/") && !(await branchPushed(worktree.path, worktree.name))) {
      const lookup = await readPullRequestStateOf(worktree.path).catch(() => ({ known: false, pr: null }));
      renamable = lookup.known && lookup.pr === null;
    }
    if (renamable) {
      // The suffix that tells this worktree's branch apart stays with it when the issue's name is taken.
      const suffix = worktree.name.match(/-([a-z0-9]{4})$/)?.[1] ?? newSuffix();
      const branch = await issueBranch({ projectPath, issue, suffix });
      await moveWorktreeBranch({ worktreePath: worktree.path, from: worktree.name, to: branch });
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
  // An explicit unlink suppresses branch detection too. The branch keeps its name.
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
  // Re-reads some worktrees' diff stats at once, e.g. after a commit from the "Commit and open PR" dialog.
  commands.handle("worktree:refresh-diffs", (_event, projectPath, worktreeIds) => {
    if (!states.has(projectPath) || !Array.isArray(worktreeIds)) return undefined;
    return diffs.refresh(
      projectPath,
      worktreeIds.filter((id) => Number.isInteger(id)),
    );
  });
  const readPullRequestStateOf = options.readPullRequestState ?? readPullRequestState;
  // Branch and Chat PRs are polled here for every client (pull-request-watch.cjs, spec 2026-10-30-daemon-pr-polling):
  // a read answers from the last poll, and `pull-requests:changed` tells clients when a Project's PRs changed. A
  // harness that injects its own readers gets them called directly instead.
  const injectedPullRequests = Boolean(options.readPullRequest || options.readPullRequests);
  const readPullRequest = options.readPullRequest ?? createPullRequestReader();
  const pullRequestWatch = injectedPullRequests
    ? null
    : createPullRequestWatch({
        onChange: (folders) => {
          for (const projectPath of new Set(folders.map((folder) => states.worktreeProject(folder)).filter(Boolean)))
            emit("pull-requests:changed", { projectPath });
        },
      });
  commands.handle("worktree:pull-request", async (_event, worktreePath) => {
    await environmentReady;
    return pullRequestWatch ? pullRequestWatch.branch(worktreePath) : readPullRequest(worktreePath);
  });
  commands.handle("worktree:pull-requests", async (_event, worktreePath, refs) => {
    await environmentReady;
    return pullRequestWatch ? pullRequestWatch.refs(worktreePath, refs) : (options.readPullRequests ?? readPullRequests)(worktreePath, refs);
  });
  // A Project's Worktrees with Chats, and the PRs those Chats named, as the sidebar and the phone's list show them.
  async function pullRequestTargets(projectPath) {
    const state = await states.get(projectPath);
    const byPath = new Map();
    for (const session of Object.values(state.sessions ?? {})) {
      const worktree = !session.archived ? state.worktrees?.[session.worktree_id] : undefined;
      if (!worktree) continue;
      const refs = byPath.get(worktree.path) ?? new Set();
      for (const ref of session.summary?.pullRequests ?? []) if (typeof ref === "string") refs.add(ref);
      if (!session.summary || session.summary.count > 0 || refs.size) byPath.set(worktree.path, refs);
    }
    return [...byPath].map(([folder, refs]) => ({ path: folder, refs: [...refs] }));
  }
  /** Every PR the Project's Worktrees and Chats have, from the last poll: it never waits on GitHub. */
  commands.handle("pull-requests:snapshot", async (_event, projectPath) => {
    if (typeof projectPath !== "string" || !states.has(projectPath)) return { worktrees: {}, chats: {}, pending: false };
    await environmentReady;
    const targets = await pullRequestTargets(projectPath);
    if (pullRequestWatch) return pullRequestWatch.snapshot(targets);
    const worktrees = {};
    const chats = {};
    await Promise.all(
      targets.map(async ({ path: folder, refs }) => {
        worktrees[folder] = await readPullRequest(folder).catch(() => null);
        if (refs.length) {
          const found = await (options.readPullRequests ?? readPullRequests)(folder, refs).catch(() => []);
          chats[folder] = Object.fromEntries(refs.map((ref, index) => [ref, found[index] ?? null]));
        }
      }),
    );
    return { worktrees, chats, pending: false };
  });
  // The Mac stays awake while Milagre runs (the screen can still sleep), so paired devices can reach it.
  // On until the renderer pushes the saved setting.
  const keepAwake = options.keepAwake ?? new KeepAwake({ powerSaveBlocker: { start: () => 0, isStarted: () => true, stop() {} }, enabled: false });
  commands.handle("app:set-keep-awake", (_event, enabled) => keepAwake.setEnabled(enabled === true));

  // Set up with the accounts below; agent events only arrive after start.
  let limitSwitch = null;
  // Set up once the Chats are (below); agent events only arrive after start.
  let routines = null;
  // Opens a Babysit Heartbeat for a PR a Chat creates; set up with the Babysit settings below.
  let babysitWatch = null;
  let chatSecrets = null;
  function publishAgentEvent(chatId, event, state, seq) {
    // First, before anyone hears the event: a heartbeat's "(pass)" marks its turn's end quiet, so no push goes out.
    routines?.observe(chatId, event);
    babysitWatch?.observe(chatId, event);
    if (["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type))
      void track(() => checkpoints.finish(chatId), background).catch((error) => console.warn("Checkpoint end capture failed:", error.message));
    if (["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type)) chatSecrets?.cancel(chatId);
    options.observeAgentEvent?.(chatId, event);
    // A turn the plan's usage limit stopped marks its account, and may move the Chat to another (auto-switch).
    if (event.type === "turn-failed" && event.limit && limitSwitch)
      void Promise.resolve()
        .then(() => limitSwitch.observe(chatId, event))
        .catch((error) => console.warn("Milagre couldn't switch accounts after a usage limit:", error.message));
    void notifyIfWaiting(chatId, event).catch(() => {});
    if (!isLinkScopeKey(projectOfKey(chatId))) diffs.observe(chatId, event);
    // A turn may have opened, pushed to or merged a PR: its Worktree's PRs are read again now, not on the next tick.
    if (pullRequestWatch && isTurnEnd(event) && !isLinkScopeKey(projectOfKey(chatId))) {
      const folder = states.chatWorktreePath(projectOfKey(chatId), sessionIdFromKey(chatId));
      if (folder) pullRequestWatch.poke(folder);
    }
    if (!isLinkScopeKey(projectOfKey(chatId)))
      void track(() => linked.observe(chatId, event), background).catch((error) => console.warn("Milagre couldn't follow a Delegation:", error.message));
    // A turn that just failed on a login problem makes a "ready" picker status out of date.
    if (event.type === "turn-failed" && event.login) {
      for (const name of PROVIDERS) if (event.message === loginMessage(name)) agentCliStatus.invalidate(name);
    }
    if (["turn-completed", "turn-failed", "turn-cancelled", "permission-resolved", "question-resolved"].includes(event.type))
      void advisorDelivery?.drain(chatId).catch((error) => console.warn("Advisor delivery failed:", error.message));
    if (bots && !isLinkScopeKey(projectOfKey(chatId)))
      void track(() => bots.observe(chatId, event), background).catch((error) => console.warn("Milagre couldn't follow a bot:", error.message));
    emit("agent:event", { chatId, event, ...(state ? { state: scopeStates.withPersistence(projectOfKey(chatId), state) } : {}), ...(seq ? { seq } : {}) });
  }

  const agents = new SessionManager({
    createSession:
      options.createSession ??
      ((provider, options) => {
        // Settings › MCP: Everywhere servers and the off list for this provider account (mcp is created further down).
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
    // Bot rules answers for a bot's thread and the Chats it opened (bots is created further down).
    permissionPolicy: (chatId) => bots?.policyFor(chatId),
    onTurnStarted: () => ports.wake(),
    // The host's name and the addresses a phone or a paired Mac reach it on (`hostNetwork`, from the daemon).
    hostInstructions: () => {
      try {
        return hostNetworkInstructions(options.hostNetwork?.() ?? {});
      } catch {
        return "";
      }
    },
    send: (chatId, event) => void chats.receive(chatId, event),
  });

  // The ports each chat's commands listen on, polled while any agent runs or anything it started still does.
  const ports = new PortWatcher({
    isRunning: () => terminals.size > 0 || [...agents.sessions.values()].some((entry) => entry.session.turnActive) || Boolean(advisors?.processes().size),
    roots: () => {
      // A Terminal's shell is a root too: what its commands listen on is the Chat's, like the agent's commands.
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
  // The renderer is untrusted: only a pid the chat's port list shows can be stopped.
  commands.handle("agent:stop-port", (_event, chatId, pid) => (typeof chatId === "string" && Number.isInteger(pid) ? ports.stopPort(chatId, pid) : false));

  // Resolves with what took the message: { turnId, steered }, a null turnId when no turn started, and
  // `cancelled` when quitting or a stopped setup stopped it before it began.
  // What Milagre tells a Chat's agent with its next message and nobody typed, such as files the user undid (a
  // <milagre_note> after the message). Kept in memory: a restart before the next message drops it.
  const agentNotes = new Map();
  async function startAgentTurn(request) {
    if (closing) return { turnId: null, steered: false, cancelled: true };
    const permissionMode = request.permissionMode ?? agents.permissionMode(request.chatId, "ask");
    if (permissionMode !== "full") await advisors?.stopExecution(request.chatId);
    else advisors?.resumeExecution(request.chatId);
    // The linked summary is read while the turn gets ready, so a Chat with Links starts no later than one without.
    const linkedContext = agents.isTurnActive(request.chatId) ? Promise.resolve("") : linked.context(request.chatId);
    const images = decodeImages(request.images);
    // expandSkills: false (the review demo) sends `/skill` as typed: the skills on this Mac are the owner's own.
    const prompt = options.expandSkills === false ? request.prompt : await expandSkillPrompt(request.cwd, request.prompt);
    const cli = agents.activeAccount(request.chatId, request.provider) ?? (await agentCli(request.provider, projectOfKey(request.chatId)));
    // A CLI that is missing, too old or doesn't start fails the turn like any other failure, with its own message.
    if (cli.problem) {
      await chats.receive(request.chatId, failedWith(cli.problem));
      return { turnId: null, steered: false };
    }
    // A new worktree's first turn waits for its setup command; one that failed tells the agent, one that was stopped stops the turn.
    if (closing) return { turnId: null, steered: false, cancelled: true };
    const setupNotes = [];
    for (const cwd of request.workspaceRoots ?? [request.cwd]) {
      const setup = await worktreeSetups.beforeTurn(request.chatId, cwd);
      if (closing || setup.cancelled) {
        await chats.receive(request.chatId, { type: "turn-cancelled" });
        return { turnId: null, steered: false, cancelled: true };
      }
      if (setup.failed) {
        await chats.receive(request.chatId, failedWith(setup.note || "Worktree setup did not finish."));
        return { turnId: null, steered: false };
      }
      if (setup.note) setupNotes.push(setup.note);
    }
    // A new turn carries the summary of the Chat's linked Worktrees after its message (a leading slash command
    // stays first); a message steering a turn doesn't repeat it.
    const context = agents.isTurnActive(request.chatId) ? "" : await linkedContext;
    const reports = agents.isTurnActive(request.chatId) ? null : await linked.reportsForTurn(request.chatId);
    const milagreNotes = agentNotes.get(request.chatId) ?? [];
    agentNotes.delete(request.chatId);
    const mentions = await chatMentionsContext(request, (key) => scopeStates.get(key)).catch(() => "");
    const text = [prompt, ...setupNotes, ...milagreNotes, context, mentions, reports?.text].filter(Boolean).join("\n\n");
    try {
      if (closing) {
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
      });
      if (started?.turnId) await reports?.delivered();
      // A start that began no turn didn't tell the agent: the notes wait for the next one.
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
    contextSettings: () => contextSettings.read(),
    // Undo is a convenience: a Worktree it can't capture still runs the task, with no checkpoint.
    beforeTask: (request) => checkpoints.begin(request).catch((error) => console.warn("Checkpoint start capture failed:", error.message)),
    beforeSend: async (request) => {
      request.images = await mobileUploads.resolveImages(request.projectPath, request.images);
      await mobileUploads.claim(request);
      if (request.sessionId != null && request.context?.kind !== "compaction" && (!request.canStart || request.canStart())) {
        const chatId = chatKey(request.projectPath, request.sessionId);
        const accountId = accounts.selected(request.provider, request.projectPath);
        await agents.releaseLimited(chatId, request.provider, accountId, async () => {
          // Closing a provider stops its work. Fold the final state before ChatHost checks whether a handoff is safe.
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
    // A Delegation queued before a restart keeps its Delegation open: it is followed again once its turn starts.
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
      // Antigravity's children are read from its transcripts in the chat's Account profile: no process starts.
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

  // Heartbeats: the daemon sends a Chat's routine prompt back into it on a schedule (routines/runtime-adapter.cjs).
  let routineHooks = null;
  // A Project's state for a lookup that must change nothing: an open one from memory, another from its saved file. It is
  // never opened, so nothing a quit stopped resumes and no recovery or diff refresh runs (Routines' targets and comment lookups).
  const projectStateReadOnly = (projectPath) => (states.has(projectPath) ? states.get(projectPath) : readRawState(projectPath));
  // The models that name Chats and Runs: the Project's own accounts' CLIs (agentCli is declared further down; read lazily).
  const titleModels = (projectPath) =>
    options.titleModels ?? createChatTitleModels({ cli: (provider) => agentCli(provider, projectPath), clientVersion: version });
  // A scope's state as memory holds it now, without waiting in its queue: a free first look before a queued read or write.
  const heldState = (scope) =>
    isLinkScopeKey(scope) ? (linkStore.has(scopeFromKey(scope).linkId) ? linkStore.cached(scopeFromKey(scope).linkId) : undefined) : states.states.get(scope);
  routines = createRoutines({
    file: path.join(dataDir, "routines.json"),
    chats,
    emit,
    cachedState: heldState,
    // A Project not open yet opens here, as a Delegation's does.
    openState: async (scope, sessionId) => {
      await linkedState(scope);
      return scopeStates.load(scope, [sessionId]);
    },
    isClosing: () => closing,
    // A Run's Worktree goes through the same steps as one the user makes, and only ever leaves when nothing in it is
    // worth keeping (worktree-cleanup.cjs; never forced).
    worktrees: {
      create: async (request) => ({ worktreeId: (await handlers.get("worktree:create")({}, request)).worktreeId }),
      // Tracked, so closing waits for a removal under way rather than leave it half done.
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
      base: async (projectPath) => (await git.resolveBase(projectPath).catch(() => ({ name: "main" }))).name,
      projectWorktree: async (projectPath) => Object.values((await linkedState(projectPath)).worktrees).find((worktree) => worktree.path === projectPath)?.id,
    },
    archiveChat: (chatId) => track(() => archiveChat(projectOfKey(chatId), sessionIdFromKey(chatId)), background),
    // Run Chats: a Heartbeat set on one keeps it, and the sweep (on Project open, and when the store drops Runs) decides
    // the ones saved before `hidden` and archives hidden ones whose Run is gone.
    keepChat: (chatId) => keepRunChat(projectOfKey(chatId), sessionIdFromKey(chatId)),
    chatMessages: (projectPath, sessionIds) => scopeStates.chatMessages(projectPath, sessionIds),
    markRunChats: async (projectPath, decided) => {
      if (!scopeStates.has(projectPath)) return;
      await updateProject(projectPath, (state) => withRunChatsHidden(state, decided, (routine) => routine.hidden === undefined), { chats: [] });
    },
    archiveRunChat: (chatId, runId) => track(() => archiveRunChat(projectOfKey(chatId), sessionIdFromKey(chatId), runId), background),
    // Made further down; read when a Routine first needs them.
    linear: () => linear,
    // Webhook secrets and waiting deliveries, beside routines.json; URLs are on the relay the phone uses.
    hooks: () =>
      (routineHooks ??= { store: createHookStore({ file: path.join(dataDir, "routine-hooks.json") }), relayUrl: options.hookRelayUrl ?? HOOK_RELAY_URL }),
    projects: async () => [...(await projectRegistry().list()), ...(await chatsHomeEntries())],
    // Read only: an open Project's state from memory, another's saved file, never opening it (no resume, no recovery).
    projectState: (projectPath) => projectStateReadOnly(projectPath),
    // Bots are made further down; until then no Chat is a bot's.
    botOf: (chatId) => botRunning(chatId),
    botHome: (projectPath) => Boolean(bots?.isHome(projectPath)),
    // A Run that ends is named from its final reply, with the models that name Chats.
    generateRunTitle: (request) => generateRunTitle(request, { models: titleModels(request.projectPath), isClosing: () => closing }),
    timers: options.routines,
  });
  routines.start();
  // Every computer runs Routines; each Routine's own switch pauses it. Older apps and paired computers still read the
  // computer's switch and may save it (with the AI sharing consent version they had), which changes nothing.
  commands.handle("routines:enabled:read", () => ({ enabled: true }));
  commands.handle("routines:enabled:save", () => ({ enabled: true }));
  // Auto update: the switch, and what a restart to install an update would stop (desktop app-updates.cjs).
  const autoUpdate = createAutoUpdate({ file: path.join(dataDir, "app-update.json"), emit });
  commands.handle("app-update:auto:read", () => autoUpdate.read());
  commands.handle("app-update:auto:save", (_event, value) => autoUpdate.save(value === true));
  const computerResources = createComputerResources({ dataDir, worktreeRoot: worktreeRoot() });
  commands.handle("computer:resources:read", () => computerResources.read());
  // Keybindings: keybindings.json on this computer, read and edited from Settings on the desktop (this Mac and paired ones) and the phone.
  const keybindings = createKeybindings({ file: path.join(dataDir, "keybindings.json"), emit });
  commands.handle("keybindings:read", () => keybindings.read());
  commands.handle("keybindings:set-command", (_event, command, rules) => keybindings.setCommand(command, rules));
  commands.handle("keybindings:reset-command", (_event, command) => keybindings.resetCommand(command));
  commands.handle("keybindings:reset", () => keybindings.resetAll());
  // Babysit PRs: the one global configuration, read and edited from the desktop's Settings and the phone.
  const contextSettings = require("./context-settings.cjs").createContextSettings({ file: path.join(dataDir, "context-settings.json"), emit });
  commands.handle("context:settings:read", () => contextSettings.read());
  commands.handle("context:settings:save", (_event, patch) => contextSettings.save(patch));

  const babysitSettings = createBabysitSettings({ file: path.join(dataDir, "babysit.json"), emit });
  commands.handle("babysit:settings:read", () => babysitSettings.read());
  commands.handle("babysit:settings:save", (_event, patch) => babysitSettings.save(patch));
  babysitWatch = createBabysitWatch({ settings: babysitSettings, routines });
  // Done: how long a Chat stays in the Done list before the sweep below archives it.
  const doneSettings = createDoneSettings({ file: path.join(dataDir, "done.json"), emit });
  commands.handle("done:settings:read", () => doneSettings.read());
  commands.handle("done:settings:save", (_event, patch) => doneSettings.save(patch));
  commands.handle("app-update:activity", () =>
    hostActivity({
      busy: chats.busyChats(),
      scopes: scopeStates.projects().map((key) => ({ key, state: heldState(key) })),
      routines: routines.runningCount(),
    }),
  );
  commands.handle("routines:list", () => routines.list());
  // Create and change check a Routine's target the same way (routineTargets): a listed Project, a Chat that is there.
  commands.handle("routines:update", (_event, id, patch) => routines.update(id, patch));
  commands.handle("routines:delete", (_event, id) => routines.remove(id));
  commands.handle("routines:run-now", (_event, id) => routines.runNow(id));
  // A Routine the user made in the Routines form; routines.create checks its target (a Project Milagre lists).
  commands.handle("routines:create", async (_event, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A Routine needs its settings.");
    const routine = await routines.create(input);
    // A webhook's URL goes to the form that made it; after that, routines:hook reads it.
    return routine.trigger.kind === "webhook" ? { routine, hookUrl: routines.hook(routine.id).url } : { routine };
  });
  commands.handle("routines:hook", (_event, id) => routines.hook(id));
  commands.handle("routines:rotate-hook", (_event, id) => routines.rotateHook(id));
  // Where a Routine can run: each Project Milagre lists, with its latest Chats for a Heartbeat. `within` (a folder, as a
  // confined phone's bridge passes it) keeps to the Projects inside it before any is read.
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

  // A Chat stays in memory while its turn runs or prepares, and while a window shows it.
  busyChat = (chatId) => chats.isBusy(chatId) || Boolean(options.isChatFocused?.(chatId));

  // A setup's steps show in the chat's turn like the agent's own.
  const setupReview = new SetupReview({ read: readSetupCommand, settings: projectSettings, send: (chatId, event) => chats.receive(chatId, event) });
  const worktreeSetups = new WorktreeSetups({
    send: (chatId, event) => void chats.receive(chatId, event),
    file: path.join(dataDir, "worktree-setups.json"),
    review: (request) => setupReview.review(request),
  });

  // Each CLI is found and its version checked once per run; a missing or outdated one is checked again on the next message.
  // Antigravity is downloaded by Milagre into the data directory, not found on PATH.
  const antigravity = options.antigravity ?? createAntigravity({ dataDir });
  // Clears what Antigravity unpacked for Milagre processes that have since exited (crashes, kills).
  void sweepTempDirs(options.antigravityTempRoot ?? antigravityAcp.tempRoot);
  const baseCli = options.agentCli ?? createCliCache({ ready: () => environmentReady, refresh: () => refreshInstallPath(), antigravity });
  const accounts = createAccounts({
    dataDir,
    cli: baseCli,
    ready: () => environmentReady,
    changed(provider) {
      routing.invalidate(provider);
      options.agentCliStatus?.invalidate?.(provider);
      options.agentModels?.invalidate?.(provider);
      emit("accounts:changed", {});
    },
  });
  const routing = createAccountRouting({ accounts, cli: baseCli, clientVersion: version });
  const agentCli = routing.cli;
  agentCli.invalidate = (provider) => baseCli.invalidate?.(provider);
  commands.handle("accounts:list", (_event, refresh) => accounts.list(refresh === true));
  let accountMutation = Promise.resolve();
  for (const method of ["add", "select", "login", "cancel", "remove"])
    commands.handle(`accounts:${method}`, (_event, provider, value) => {
      const pending = accountMutation.then(() => accounts[method](provider, value));
      accountMutation = pending.catch(() => {});
      return pending;
    });
  // Settings › MCP (docs/superpowers/specs/2026-10-09-mcp-settings-design.md): each account's servers and their status.
  // The tab checks every account in parallel; saves, switches and sign-ins go through the same module.
  const mcp = createMcp({
    accounts,
    routing,
    cwd: require("node:os").homedir(),
    clientVersion: version,
    store: createMcpStore(path.join(dataDir, "mcp.json")),
    openUrl: (url) => openInBrowser(url),
    emit,
    // Tests swap in accounts, routing, home and stub checkers, writers and signers.
    ...options.mcp,
  });
  // Phones call these too: `previous` arrives as JSON, so it becomes { name, target } strings or undefined (a new
  // server); mcp.save checks both before anything is read or written, and keeps only the known definition fields.
  const mcpPrevious = (previous) =>
    previous === undefined || previous === null
      ? undefined
      : {
          name: typeof previous?.name === "string" ? previous.name : "",
          target: typeof previous?.target === "string" ? previous.target : "",
        };
  commands.handle("mcp:accounts", () => mcp.accounts());
  commands.handle("mcp:check", (_event, provider, accountId) => mcp.check(String(provider), String(accountId)));
  commands.handle("mcp:definition", (_event, name, target) => mcp.definition(String(name), String(target)));
  commands.handle("mcp:save", (_event, def, target, previous) => mcp.save(def, String(target), mcpPrevious(previous)));
  commands.handle("mcp:saveUrl", (_event, def, target, previous) => mcp.saveUrl(def, String(target), mcpPrevious(previous)));
  commands.handle("mcp:remove", (_event, name, target) => mcp.remove(String(name), String(target)));
  commands.handle("mcp:toggle", (_event, provider, accountId, name, on) => mcp.toggle(String(provider), String(accountId), String(name), on === true));
  commands.handle("mcp:signIn", (_event, name, targets) => mcp.signIn(String(name), Array.isArray(targets) ? targets : []));
  commands.handle("mcp:cancelSignIn", (_event, name) => mcp.cancelSignIn(String(name)));

  // The Mac's Linear connections, one per workspace. Phones read them and the Experimental switch; only the Mac connects (mobile-bridge.cjs).
  const linear = createLinear({
    dataDir,
    // The Mac app opens Add workspace's sign-in in a window of its own; the link reaches it as an event.
    openWindow: (url) => emit("linear:sign-in-window", { url }),
    ...options.linear,
    changed: () => emit("linear:status-changed", linear.status()),
  });
  commands.handle("linear:status", () => linear.status());
  commands.handle("linear:connect", (_event, value) => linear.connect({ window: value?.window === true }));
  commands.handle("linear:cancel", () => linear.cancel());
  commands.handle("linear:disconnect", (_event, value) => linear.disconnect(value?.workspace));
  commands.handle("linear:enabled:read", () => ({ enabled: linear.enabled(), moveToStarted: linear.moveToStarted() }));
  commands.handle("linear:move-to-started:save", (_event, value) => ({ moveToStarted: linear.setMoveToStarted(value === true) }));
  commands.handle("linear:enabled:save", (_event, value) => {
    const enabled = linear.setEnabled(value === true);
    emit("linear:enabled-changed", { enabled });
    return { enabled };
  });
  // Issues are read through the same connection; both answer without throwing (see linear/issues.cjs).
  const linearIssues = createLinearIssues({ linear });
  const linearTools = createLinearTools({ linear, issues: linearIssues });
  // The Routines form's Linear choices: workspaces, teams, and a team's labels and states. Never throws.
  commands.handle("routines:linear-options", (_event, value) => linearIssues.routineOptions({ workspace: value?.workspace, team: value?.team }));
  commands.handle("linear:issues", (_event, value) => linearIssues.list(value?.query, { fresh: value?.fresh === true, workspace: value?.workspace }));
  commands.handle("linear:worktree-issues", async (_event, projectPath) => {
    try {
      await environmentReady;
      const project = await readProject(projectPath);
      return await linearIssues.worktreeIssues(Object.values(project.state.worktrees));
    } catch {
      return {};
    }
  });

  const chatTitles = new ChatTitles({
    states: scopeStates,
    update: updateProject,
    generate: (request) => generateChatTitle(request, { models: titleModels(request.projectPath) }),
  });

  commands.handle("usage:read", async (_event, scope) => {
    scope = await validateAccountScope(scope, true);
    if (options.readUsage) return options.readUsage();
    await environmentReady;
    const usage = usageForAccounts(scope);
    const snapshot = await usageWithAccounts(usage, await usage.read());
    emit("usage:changed", { scopeKey: scope });
    return snapshot;
  });
  commands.handle("usage:cached", async (_event, scope) => {
    scope = await validateAccountScope(scope, true);
    const usage = usageForAccounts(scope);
    return usageWithAccounts(usage, cachedSnapshot(usage.store, Date.now()));
  });

  // Token usage page: every Claude Code and Codex transcript on this computer (the connected CLI accounts' and each
  // Account's folders), priced with LiteLLM's list and credited to the Projects and Chats Milagre knows.
  async function tokenUsageRoots() {
    const roots = [];
    for (const provider of ["claude", "codex"]) {
      const ids = ["default", ...((await accounts.list()).providers.find((group) => group.provider === provider)?.accounts ?? []).map((item) => item.id)];
      for (const id of new Set(ids)) {
        let home;
        try {
          const env = accounts.environment(provider, id);
          home =
            provider === "claude"
              ? env.CLAUDE_CONFIG_DIR || path.join(require("node:os").homedir(), ".claude")
              : env.CODEX_HOME || path.join(require("node:os").homedir(), ".codex");
        } catch {
          continue;
        }
        if (provider === "claude") roots.push({ provider, dir: path.join(home, "projects") });
        else roots.push({ provider, dir: path.join(home, "sessions") }, { provider, dir: path.join(home, "archived_sessions") });
      }
    }
    return roots;
  }
  const tokenUsage =
    options.tokenUsage ??
    createTokenUsage({
      scan: createTokenUsageScan({ cacheFile: path.join(dataDir, "token-usage-cache.json"), roots: tokenUsageRoots }),
      pricing: createTokenPricing({ file: path.join(dataDir, "model-prices.json"), onChange: () => emit("token-usage:changed", {}) }),
      projects: async () =>
        Promise.all(
          (await projectRegistry().list()).map(async (project) => ({
            path: project.path,
            name: chatsHome.isHome(project.path) ? CHATS_ACCOUNT_LABEL : project.name || path.basename(project.path),
            state: await Promise.resolve(projectStateReadOnly(project.path)).catch(() => null),
          })),
        ),
      worktreeRoot: worktreeRoot(),
      emit,
    });
  commands.handle("token-usage:read", (_event, request) => tokenUsage.read(request));

  // The "Commit and open PR" dialog: Milagre runs git and gh itself, in the chat's folder, once the login
  // environment is in (gh from a Finder launch). Its one-shot text call starts the CLI agentCli found.
  registerGitHandlers(commands, {
    cli: async (name, cwd) => agentCli(name, await accountScopeForFolder(cwd)),
    ready: () => environmentReady,
    clientVersion: version,
    knownFolders: () => scopeStates.worktreePaths(),
    // A PR write (merge, ready, a review, a new PR) shows on the next read, not the next tick.
    pullRequestChanged: (folder) => pullRequestWatch?.poke(folder),
  });

  const checkpoints = registerCheckpoints(commands, {
    directory: path.join(dataDir, "checkpoints"),
    states: scopeStates,
    ready: () => environmentReady,
    busy: (chatId) => chats.isBusy(chatId) || agents.isTurnActive(chatId) || Boolean(agents.sessions.get(chatId)?.activeChildren?.size),
    note: (chatId, message) => chats.addNote(chatId, message),
    tell: (chatId, text) => agentNotes.set(chatId, [...(agentNotes.get(chatId) ?? []), text]),
  });

  commands.handle("chat:send", (_event, request) => sendAsUser(request));
  /** A message the user sends to a Chat: from a composer (desktop or phone), a pill, or a comment on a page. */
  async function sendAsUser(request) {
    if (isLinkScopeKey(request?.projectPath) || !scopeStates.has(request?.projectPath)) throw new Error("Open the project before sending to its chats.");
    // A bot's thread always runs in Bot rules on the bot's agent and model, whatever the composer sent. The user's
    // message in a Chat a bot opened makes it theirs: it runs in the mode they sent and the bot stops steering it. Bot
    // rules are the bots' own: a message the user sends anywhere else that asks for them (the composer sends the run's
    // mode) asks instead.
    if (bots.isHome(request.projectPath)) {
      const bot = await bots.beforeThreadSend(request.projectPath, request.sessionId);
      request = { ...request, permissionMode: "bot", provider: bot.provider, model: bot.model };
    } else {
      if (request.sessionId != null && bots.botForChat(chatKey(request.projectPath, request.sessionId))?.role === "chat")
        await bots.takeOver(chatKey(request.projectPath, request.sessionId));
      if (request.permissionMode === "bot") request = { ...request, permissionMode: "ask" };
    }
    // Only Milagre marks a message as coming from another Chat. A PR-blocker pill and a Chat started from a Linear issue
    // are the contexts a renderer can ask for, and Milagre checks them and writes their message and prompt itself.
    const { prAction, linearIssue, compact, ...rest } = request;
    const action = prAction === undefined ? null : pullRequestActionContext(prAction);
    if (prAction !== undefined && !action) throw new Error("That pull request action isn't valid.");
    if (compact && rest.sessionId == null) throw new Error("Open a chat before compacting it.");
    const message = action
      ? { ...rest, body: pullRequestActionBody(action), prompt: pullRequestActionPrompt(action), images: [], files: [], context: action }
      : compact
        ? { ...rest, ...compactionMessage() }
        : linearIssue !== undefined
          ? await linearIssueMessage(rest, linearIssue)
          : { ...rest, context: undefined };
    const { sessionId } = await chats.send(message);
    // A message from a composer, desktop or phone (its bridge calls this command), a PR-action pill or a compact is the
    // user taking a Run Chat over. Milagre's own sends (a Routine's beat, an MCP chat_start, a Delegation) call chats.send
    // directly and never keep one.
    if (rest.sessionId != null) {
      await keepRunChat(rest.projectPath, sessionId).catch((error) => console.warn("Milagre couldn't keep a Run Chat:", error.message));
      await reopenDoneChat(rest.projectPath, sessionId).catch((error) => console.warn("Milagre couldn't reopen a Done Chat:", error.message));
    }
    return { sessionId };
  }
  // The issue is read again here, so the card and prompt are Linear's copy. If Linear can't answer now, the Chat still
  // starts, with the text the renderer sent as a plain message.
  async function linearIssueMessage(rest, request) {
    const ask = linearIssueRequest(request);
    if (!ask) throw new Error("That Linear issue isn't valid.");
    const issue = await readLinearIssue(ask.key, ask.workspace).catch((error) => {
      console.warn(`Milagre couldn't read ${ask.key} for its card:`, error.message);
      return null;
    });
    if (!issue) return { ...rest, context: undefined };
    const files = Array.isArray(rest.files) ? rest.files : [];
    return {
      ...rest,
      body: issueFirstMessage(issue, ask.note),
      prompt: linearIssuePrompt(issue, ask.note) + (files.length ? `\n\nAttached files:\n${files.join("\n")}` : ""),
      context: linearIssueContext(issue, ask.note),
    };
  }
  commands.handle("chat:resume", async (_event, projectPath, sessionId) => {
    if (!scopeStates.has(projectPath)) throw new Error("Open the project before continuing its chats.");
    // Continuing a bot's thread is a message to the bot: refused while it is paused or Bots are off.
    if (bots.isHome(projectPath)) await bots.beforeThreadSend(projectPath, sessionId);
    return chats.resumeChat(projectPath, Number(sessionId));
  });
  // Archiving a Chat stops what runs for it (its Terminals, advisors, heartbeats) and saves the patch. The user's archive
  // and a quiet Routine Run's both come here. The stop starts first, so its fences are up before the save (no heartbeat
  // beat or advisor report lands in the archived Chat), but only the save is waited on: closing the advisors waits on the
  // Chat's queued advisor work and their processes, and held `chat:patch` past its deadline on a busy Mac.
  async function archiveChat(projectPath, sessionId, patch = { archived: true }) {
    if (!scopeStates.has(projectPath)) return;
    const chatId = `${projectPath}#${sessionId}`;
    const stopping = stopChatWork(chatId);
    stopping.catch(() => {});
    await editProject(projectPath, (state) => patchSession(state, sessionId, patch), { chats: [] });
    void track(() => stopping, background).catch((error) => console.warn("Milagre couldn't stop an archived Chat's work:", error.message));
  }
  async function stopChatWork(chatId) {
    terminals.closeChat(chatId);
    routines.chatArchived(chatId);
    // A turn still running stops as Stop stops it, so the questions and approvals it waits on end with it instead of
    // asking from an archived Chat. The clients stop it first, but only when their copy of the runs shows it.
    if (chats.runs[chatId]) return stopChat(chatId);
    await advisorDelivery.stop(chatId);
    await advisors.stopChat(chatId);
  }
  // A hidden Run Chat whose Run left the store (routines' sweepRunChats), archived only while it is still hidden,
  // unarchived and that Run's: checked against the current state first, and again in the change that archives it. What
  // runs for it stops only once that change archived it, so a Chat the user took over in the meantime keeps its
  // Terminals, advisors and Heartbeats.
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
  // The user took a Run Chat over (sent it a message, pinned or renamed it, set a Heartbeat on it): it is a normal Chat
  // from then on, in every list. One saved before Run Chats could be hidden is decided kept too. Any other Chat is left
  // as it is, without a write. Every composer send comes here, so the state in memory is looked at first: only a Run Chat
  // not kept yet waits for the queued read (a kept one never goes back to hidden).
  async function keepRunChat(projectPath, sessionId) {
    if (!scopeStates.has(projectPath)) return;
    const keepable = (session) => isRunChat(session) && session.routine.hidden !== false;
    if (!keepable(heldState(projectPath)?.sessions[sessionId])) return;
    if (!keepable((await scopeStates.get(projectPath)).sessions[sessionId])) return;
    await editProject(projectPath, (state) => withRunChatsHidden(state, { [sessionId]: false }, (routine) => routine.hidden !== false), { chats: [] });
  }
  // `done` marks a Chat Done with this host's clock, so the countdown and the sweep agree whichever client asked; a phone's
  // clock may be off. Reopening it, or bringing it back from the archive, takes it out of the Done list.
  function sessionPatch(patch) {
    if (!patch || typeof patch !== "object") return {};
    const { done, done_at: _clientClock, ...rest } = patch;
    if (done === true) return { ...rest, done_at: Date.now() };
    if (done === false || rest.archived === false) return { ...rest, done_at: undefined };
    return rest;
  }
  async function patchChat(projectPath, sessionId, raw) {
    if (!scopeStates.has(projectPath)) return;
    const patch = sessionPatch(raw);
    if (patch.archived) return archiveChat(projectPath, sessionId, patch);
    await editProject(projectPath, (state) => patchSession(state, sessionId, patch), { chats: [] });
  }
  // Writing to a Done Chat takes it back to the list: the work it was Done with goes on. Only a Done one is written.
  async function reopenDoneChat(projectPath, sessionId) {
    if (!scopeStates.has(projectPath) || !heldState(projectPath)?.sessions[sessionId]?.done_at) return;
    await editProject(projectPath, (state) => patchSession(state, sessionId, { done_at: undefined }), { chats: [] });
  }
  // The sweep's archive of one Done Chat: read again and archived only while it is still due, then its worktree goes the
  // way the archive menu's does (archive.mjs archiveMode): only one Milagre made, no other Chat uses and git says holds
  // nothing unsaved, never forced. Anything else keeps its worktree, as an archive with unsaved work does.
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
  // Pinning, naming or restoring a Chat from the archive is the user taking a Run Chat over (a restored one would be
  // hidden, out of every list, and archived again by the next sweep). An agent's chat_update calls patchChat itself and
  // never keeps one, and nor does a read mark, an unpin or a blank name.
  commands.handle("chat:patch", async (_event, projectPath, sessionId, patch) => {
    await patchChat(projectPath, sessionId, patch);
    if (patch?.pinned === true || patch?.archived === false || (typeof patch?.title === "string" && patch.title.trim() !== ""))
      await keepRunChat(projectPath, sessionId);
  });
  commands.handle("chat:delete", async (_event, projectPath, sessionId) => {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Choose an existing Chat to delete.");
    const chatId = `${projectPath}#${sessionId}`;
    await existingChat("deleting it")(chatId);
    await stopChatWork(chatId);
    await worktreeSetups.cancel(chatId);
    await agents.closeChat(chatId);
    await editProject(projectPath, (state) => deleteSession(state, sessionId), { chats: [sessionId] });
    await artifacts.removeChat(chatId).catch(() => {});
  });
  // Opening a chat reads it. Only on opening: "Mark as unread" on the open chat sticks until it's opened again.
  commands.handle("chat:archive-subagent", (_event, projectPath, sessionId, id, archived) =>
    scopeStates.has(projectPath)
      ? editProject(projectPath, (state) => archiveSubagent(state, sessionId, String(id), archived === true), { chats: [] }).then(() => {})
      : undefined,
  );
  commands.handle("chat:archive-finished-subagents", (_event, projectPath, sessionId) =>
    scopeStates.has(projectPath) ? editProject(projectPath, (state) => archiveFinishedSubagents(state, sessionId), { chats: [] }).then(() => {}) : undefined,
  );
  // What the "Commit and open PR" dialog did, as a line in its chat.
  commands.handle("chat:git-note", (_event, chatId, body) => {
    if (typeof chatId !== "string" || typeof body !== "string" || !scopeStates.has(projectOfKey(chatId))) return undefined;
    return chats.addNote(chatId, { body, context: { kind: "git-action" } });
  });
  /** Reads the chat on screen: on opening it, and when a window regains focus over it. */
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
  // A window that loads (or reloads) mid-turn picks the turns up where they are, cards included.
  commands.handle("chat:runs", () => chats.snapshot());
  commands.handle("chat:inbox", async () => {
    // A bot's thread waits on the user in the Bots sidebar's "Needs you", not in the inbox.
    const scopes = await Promise.all(
      scopeStates
        .projects()
        .filter((key) => !bots.isHome(key))
        .map(async (key) => ({
          path: key,
          name: isLinkScopeKey(key) ? (await linkRuntime.definition(scopeFromKey(key).linkId)).name : projectName(key),
          state: await scopeStates.inboxState(key),
        })),
    );
    return require("@milagre/shared/attention").inboxSnapshot(scopes, chats.snapshot().runs);
  });

  // What the model picker flags per agent: missing, outdated, broken or logged out. A ready CLI is looked at again
  // after 5 minutes, a problem on every call.
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
    // Optional array arguments arrive as null after the daemon's JSON transport.
    targetVersion ??= undefined;
    if (targetVersion !== undefined && !releaseVersion(targetVersion)) throw new Error("Invalid provider version.");
    if (cliUpdates.has(provider)) return cliUpdates.get(provider);
    const pending = (async () => {
      // Antigravity's download takes a while; its phases go out as they happen.
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

  // A message queued behind a turn its provider can't steer (chat-host.cjs): Send now starts it; while a turn runs it
  // is Stop and send, so that turn stops as Stop stops it; Remove drops it unsent.
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

  // Reload: a running turn stops, as Stop does, and the agent's process ends. The Chat's next message starts a new one
  // on the same session, which reads its MCP servers, skills and sign-in again.
  commands.handle("chat:reload", async (_event, chatId) => {
    await existingChat("reloading it")(chatId);
    const state = await scopeStates.get(projectOfKey(chatId));
    const sessionId = sessionIdFromKey(chatId);
    // Background work runs in the agent process Reload ends: the Chat reloads once it finishes (T3 #16000).
    const background = Math.max(agents.backgroundWork(chatId), processWork(state.sessions[sessionId]).length);
    if (background) throw new Error(backgroundBusyMessage("reload", background));
    if (chats.runs[chatId]) await stopChat(chatId);
    // An empty Chat gets no line: it stays the one its Worktree reuses for the next send. An unloaded Chat's messages
    // aren't in the state: its summary counts them.
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

  // The end of a background command's output, for the Chat's background line: what the agent left running in it.
  commands.handle("chat:task-output", async (_event, chatId, taskId) => {
    await existingChat("reading a background task")(chatId);
    if (typeof taskId !== "string" || !taskId || taskId.length > 200) throw new Error("That background task isn't valid.");
    return agents.taskOutput(chatId, taskId);
  });

  async function stopChat(chatId) {
    chatSecrets?.cancel(chatId);
    // Stop the report before advisor cancellation can make an idle parent look complete. Provider teardown can be slow.
    await linked.stop({ chatKey: chatId });
    await advisorDelivery.stop(chatId);
    await advisors.stopChat(chatId);
    // A handoff still writing its brief has no agent to stop: cancelling it is the whole interrupt.
    if (await chats.cancelHandoff(chatId)) return;
    await worktreeSetups.cancel(chatId);
    await agents.interrupt(chatId);
  }

  // A bot's sign-off card answered from its Chat goes through the sign-off (bots.answerCard), so an expired one is denied.
  commands.handle("agent:respond-permission", async (_event, { chatId, requestId, decision }) => {
    if (typeof requestId === "string" && requestId.startsWith("setup-review-")) return setupReview.respond(chatId, requestId, decision);
    const signedOff = await bots.answerCard(chatId, requestId, decision);
    return signedOff ?? agents.respondToPermission(chatId, requestId, decision);
  });

  // The answers show in the chat as the user's message (`summary`), and are taken back if they don't reach the agent.
  // The message is queued before the answers go out, so the agent's next reply lands below it, but the agent doesn't wait
  // for it: the Project's queue holds every Chat's changes, and a busy one kept the card up for seconds.
  commands.handle("agent:answer-question", async (_event, { chatId, requestId, answers, summary } = {}) => {
    // Route even stale secret ids here: a late/replayed value must never reach chat persistence.
    if (require("./chat-secrets.cjs").isSecretRequest(requestId)) return chatSecrets.answer(chatId, requestId, answers);
    const recorded =
      answers && typeof summary === "string" && summary && typeof chatId === "string" && scopeStates.has(projectOfKey(chatId))
        ? chats.recordAnswers(chatId, summary, { requestId, answers }).catch((error) => {
            console.warn("Milagre couldn't show the answers:", error.message);
            return null;
          })
        : Promise.resolve(null);
    let accepted;
    try {
      accepted = await agents.answerQuestion(chatId, requestId, answers);
    } catch (error) {
      const messageId = await recorded;
      if (messageId !== null) await chats.takeBack(chatId, messageId);
      throw error;
    }
    const messageId = await recorded;
    if (!accepted && messageId !== null) await chats.takeBack(chatId, messageId);
    return accepted;
  });

  // The mode picked is the Chat's from now on: its running turn takes it at once, and a heartbeat's next beat runs in it.
  // Saved even when the live session couldn't take it: the next turn and beat start in it. Bot rules are the bots' own:
  // no client sets them, and a bot's thread keeps them. The renderer and Milagre's MCP both come through here, but only
  // the user (`byUser`, Milagre's own command) changes a Chat a bot opened: that takes it over first, which denies its
  // sign-offs, so Full can't allow them. Another Chat's agent or an outside client can't steer a bot's Chat at all.
  async function setPermissionMode(chatId, mode, { byUser = false } = {}) {
    if (mode === "bot") throw new Error("Only a bot's Chats run in Bot rules.");
    if (!PERMISSION_MODES.has(mode)) throw new Error(`Unknown permission mode: ${mode}`);
    const owned = typeof chatId === "string" ? bots.botForChat(chatId) : null;
    if (owned?.role === "thread") throw new Error(`${owned.bot.name}'s thread always runs in Bot rules.`);
    if (owned && !byUser) throw new Error(`${owned.bot.name} runs this Chat; open it in Milagre to take it over.`);
    if (owned) await bots.takeOver(chatId);
    if (mode !== "full") await advisors?.stopExecution(chatId);
    const result = await chats.setPermissionMode(chatId, mode, (id, picked) => agents.setPermissionMode(id, picked));
    if (mode === "full") advisors?.resumeExecution(chatId);
    return result;
  }
  commands.handle("agent:set-permission-mode", (_event, { chatId, mode }) => setPermissionMode(chatId, mode, { byUser: true }));

  async function notifyIfWaiting(chatId, event) {
    const projectPath = projectOfKey(chatId);
    if (!options.notifyWaiting || !scopeStates.has(projectPath) || !("requestId" in event)) return;
    // A Project hidden from the sidebar stays quiet: its chats aren't in any list to answer from.
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
  // Every registered Project's Worktrees.
  async function canvasActiveWorktrees() {
    const projects = await projectRegistry().list();
    return Object.fromEntries(
      await Promise.all(projects.map(async (project) => [project.id, (await registeredWorktrees(project)).map((worktree) => worktree.path)])),
    );
  }
  // Links whose Worktree endpoint went away are dropped, with what was waiting to travel along them.
  async function pruneLinks(active) {
    const removed = await projectRegistry().pruneLinks(active ?? (await canvasActiveWorktrees()));
    for (const link of removed) await linked.linkRemoved(link.id);
    if (removed.length) await linksChanged();
  }
  // The sidebar's Link icons follow Links drawn or removed anywhere: the canvas, the sidebar, the phone.
  async function linksChanged() {
    const links = (await projectRegistry().snapshot()).links;
    emit("canvas:links-changed", { links });
    return links;
  }
  // A linked Project not open yet is opened here (ownership, reconciled Worktrees, interrupted turns), as the
  // canvas opens every Project it shows.
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
  // Whole messages for linked reads, read without loading the Chats (see message-store.cjs). The Project is read first,
  // as linkedState does, so one not open yet opens.
  const linkedMessages = async (projectPath, chatIds) => {
    await linkedState(projectPath);
    return chatIds ? scopeStates.chatMessages(projectPath, chatIds) : scopeStates.allMessages(projectPath);
  };
  // Milagre's own task list and phase tools, the same for every provider (chat-plan-tools.cjs).
  const planTools = require("./chat-plan-tools.cjs").createChatPlanTools({
    read: (chatId) => chats.plan(chatId),
    update: (chatId, change) => chats.updatePlan(chatId, change),
  });
  chatSecrets = require("./chat-secrets.cjs").createChatSecrets({
    directory: path.join(dataDir, "chat-secrets"),
    send: (chatId, event) => chats.receive(chatId, event),
    active: (chatId) => Boolean(chats.runs[chatId]) && !closing,
  });
  // Delegations to another paired computer's Projects (Settings > Experimental, spec 2026-10-23). The daemon supplies its
  // computers (`remoteComputers`): list() -> [{ id, name, online }], invoke(id, method, args), thisMac(), and
  // onEvent(listener) / onOnline(listener) / onRemoved(listener) for their events, their coming back and their removal.
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
    registry: projectRegistry,
    grantedProjects: (chatId) => localMcp.grantedProjects(chatId),
    // A named Link's member Projects, { id, name, path }, for its shared Chats' Delegations.
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
    // Bot rules allow what no gate matches, and gates leave Milagre's tools alone: a bot's thread and the Chats it opened
    // keep only the Milagre tools that stay inside them (isBotRulesTool). A tool a session got before its Chat became
    // a bot's (Claude keeps the list it started with) refuses to run there.
    chatTools: (chatId, tools) =>
      botRunning(chatId)
        ? tools.filter(isBotRulesTool)
        : tools.map((tool) =>
            isBotRulesTool(tool)
              ? tool
              : {
                  ...tool,
                  run: async (input) => {
                    const bot = botRunning(chatId);
                    if (bot) throw new Error(`${bot} runs this Chat, and Bot rules don't offer ${tool.name}.`);
                    return tool.run(input);
                  },
                },
          ),
    botOf: (chatId) => botRunning(chatId),
    pendingAdvisorResults: async (chatId) =>
      (await advisorStore.read(chatId)).some((record) => record.completions?.some((result) => ["pending", "sending"].includes(result.delivery))),
    extraTools: (chatId) => [
      ...planTools.definitions(chatId),
      ...chatSecrets.definitions(chatId),
      ...simulatorToolDefinitions(chatId, simulators),
      ...(simlockSettings.read().enabled
        ? require("./chat-simulators.cjs").simlockToolDefinitions(chatId, {
            models: () => simlock.models(),
            lease: (request) => leaseSimlock({ ...request, chatId }),
            release: (request) => releaseSimlock(request),
            get: (deviceId) => simlock.get(deviceId),
          })
        : []),
      // Experimental: desktop apps on this computer, through agent-desktop.
      ...(computerUseSettings.read().enabled ? computerUse.definitions(chatId) : []),
      ...require("./chat-browsers.cjs").browserToolDefinitions(chatId, browsers),
      ...pageCommentToolDefinitions(chatId, pageComments),
      // Driving the Chat's browser pages; browser_open asks the desktop to open a Browser panel tab (browser-panel:open).
      ...require("./chat-browser-tools.cjs").browserPageToolDefinitions(chatId, browsers, {
        openInPanel: (target, url) => emit("browser-panel:open", { chatId: target, url }),
      }),
      ...(existsSync(path.join(__dirname, "design-mcp-tools.cjs"))
        ? []
        : artifactToolDefinitions(chatId, artifacts).filter((tool) => !["artifact_comments", "artifact_resolve_comment"].includes(tool.name))),
      ...localMcp.agentTools(chatId).filter((tool) => !["artifact_comments", "artifact_resolve_comment"].includes(tool.name)),
      // Files an Artifact page shows come from the Chat's own Worktrees, as a chat_start attachment does.
      ...htmlArtifactToolDefinitions(chatId, artifacts, undefined, {
        roots: () =>
          chatWorktrees(chatId).then(
            (worktrees) => worktrees.map((worktree) => worktree.path),
            () => [],
          ),
      }),
      ...artifactCommentToolDefinitions(chatId, artifacts),
      ...require("./advisor-tools.cjs").advisorToolDefinitions(chatId, advisors),
      ...require("./link-worktree-tools.cjs").linkWorktreeToolDefinitions(chatId, createLinkWorktree),
      // Milagre's own Linear sign-in, so agents don't reach for a Linear MCP or connector.
      ...(linear.enabled() ? linearToolDefinitions(linearTools) : []),
      // Heartbeats on the agent's own Chat (none in a Link's Chats).
      ...routines.definitions(chatId),
      // A bot's thread: its memory and the Chats it opens.
      ...(bots ? bots.toolsFor(chatId) : []),
    ],
    createMcpServer: ({ toolsFor }) => ({ url: (chatId) => localMcp.chatUrl(chatId, toolsFor), close: async () => {} }),
  });
  // Owner clients select an existing Chat. Its agent tools retain their identity, grants and dynamic Bot gates.
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
  // link_worktree_create: a shared Link Chat's Worktree in one Project, made when its agent is about to change it. The
  // running agent owns it at once, the Link's windows show it, and the Project lists it as the shared Chat's. Its setup
  // gets the same review as an ordinary Worktree's, now, before the agent works in it.
  async function createLinkWorktree({ chatId, linkId, sessionId, project }) {
    const made = await linkWorkspaces.addLinkWorktree({ link: await linkRuntime.definition(linkId), chatId: sessionId, project });
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
    // The Chat's own messages give its last model, so it is loaded (see message-store.cjs).
    const state = await scopeStates.load(scope, [id]);
    const session = state.sessions[id];
    if (session.archived) throw new Error("This Chat is archived.");
    const execution = await scopeStates.executionContext(scope, id);
    if (!execution.cwd) throw new Error("This Chat's Worktree is unavailable.");
    // Advisors can compare owned Worktrees with their Project checkouts. Keep those checkout identities when a
    // pending Link Project gains its Worktree, so an in-flight advisor can still deliver its result.
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
      // A queued result already belongs to the Chat. Waiting for its turn would stall later results and shutdown.
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
        // Its system prompt is the advisor's own (events.cjs advisorInstructions): the Chat's writing setting, its read tools.
        tldrEnabled: context.settings?.tldrEnabled !== false,
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
    getSettings: (projectPath) => projectSettings().get(projectPath),
    deferSetup: (request) => worktreeSetups.prepare(request),
  });
  const linkRuntime = registerLinkRuntime({
    commands,
    registry: projectRegistry,
    store: linkStore,
    workspaces: linkWorkspaces,
    chats,
    broadcast: broadcastProjectState,
    titles: chatTitles,
  });
  commands.handle("linked:snapshot", () => linked.snapshot());
  commands.handle("linked:remote-enabled:read", () => ({ enabled: remoteDelegation.enabled() }));
  commands.handle("linked:remote-enabled:save", (_event, value) => {
    const result = remoteDelegation.save(value);
    emit("linked:remote-enabled-changed", result);
    return result;
  });
  // Another computer's Chat delegating to this Mac's Projects (a paired desktop's daemon calls these, spec 2026-10-23).
  commands.handle("delegation:targets", () => linked.hosted.targets());
  commands.handle("delegation:prepare", (_event, request) => linked.hosted.prepare(request));
  commands.handle("delegation:receive", (_event, request) => linked.hosted.receive(request));
  commands.handle("delegation:reports", (_event, request) => linked.hosted.reports(request));
  commands.handle("delegation:collected", (_event, request) => linked.hosted.collected(request));
  // This Mac's Delegations to other computers hear back: a report as it is sent, and the ones missed while away.
  remoteComputers?.onEvent?.((computerId, channel, payload) => {
    if (channel === "delegation:report")
      void linked.remoteFinished(computerId, payload).catch((error) => console.warn("Milagre couldn't take a Delegation report:", error.message));
  });
  remoteComputers?.onOnline?.((computerId) => {
    void linked.catchUp(computerId).catch((error) => console.warn("Milagre couldn't collect Delegation reports:", error.message));
  });
  // A removed computer can't report back: its open Delegations are settled here.
  remoteComputers?.onRemoved?.((computerId) => {
    void linked.computerRemoved(computerId).catch((error) => console.warn("Milagre couldn't settle a removed computer's Delegations:", error.message));
  });
  commands.handle("linked:stop-negotiation", (_event, id) => (typeof id === "string" ? linked.stop({ negotiationId: id }) : undefined));
  // Each Project an open resolved this run, by its path (see openProject).
  const openedIdentities = new Map();
  // Each way a project opens (launch, the folder dialog, a switch) puts it at the top of the recent list.
  // `takeNotice`: this open is a desktop window's, which shows the restored-chats notice. Over the daemon only the
  // desktop asks for it, so the phone's bridge opening the project first doesn't use the notice up.
  // `remember` / `register`: false keeps it off the recent list / out of the registry. The Chats home never goes on
  // either, however it opens (chats:ensure, the phone's project:open, a reconnect opening the window's Project again).
  async function openProject(projectPath, { takeNotice = true, focus = true, remember = true, register = true } = {}) {
    // One look at git gives the Project and its Worktrees, which the read reconciles with. A Project opened before by
    // this path (a switch back to it) keeps the identity read then while its Worktree list still starts at it.
    const known = openedIdentities.get(projectPath);
    const listed = known?.git ? await mainCheckoutWorktrees(projectPath) : null;
    const { identity, worktrees } = listed ? { identity: known, worktrees: listed } : await inspectProject(projectPath);
    openedIdentities.set(identity.path, identity);
    const project = withKind(await readProject(identity.path, { discovered: worktrees }));
    const home = project.kind === "chats";
    if (register && !home) await projectRegistry().add(identity);
    // The identity says what rememberProject would ask git again: its path is a checkout's top folder, or outside Git.
    if (remember && !home) await rememberProject(recentProjects(), identity.path, { plain: async () => !identity.git, topLevel: async () => identity.path });
    if (focus) shownProjectPath = identity.path;
    // The first window to open the project after chats came back says so, once. A read at startup (resuming a turn)
    // or after removing a worktree keeps the notice for it.
    const restored = takeNotice ? restoredChats.get(identity.path) : undefined;
    if (restored) restoredChats.delete(identity.path);
    return restored ? { ...project, restoredChats: restored } : project;
  }

  // editor:open and project:reveal accept a Project folder outside Git only when it is a registered or recent Project,
  // so the renderer still can't point them at "/" or any other folder.
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
    // Onboarding skipped to a Chat without a Project: that Chat opens again, instead of onboarding.
    return (await chatsHome.exists()) ? openProject(chatsHome.path, { remember: false, register: false }) : null;
  });

  // Chats a quit stopped continue on launch in every recent project, not only the one on screen.
  async function resumeRecentProjects() {
    const resolved = new Set();
    // The Chats home isn't recent, and its Chats continue too.
    const homes = (await chatsHome.exists()) ? [chatsHome.path] : [];
    for (const recentPath of [...(await recentProjects().list()).map((entry) => entry.path), ...homes]) {
      let projectPath = recentPath;
      try {
        // An entry from before #117 can name a linked worktree. It is read as its repository, as opening it would be,
        // so its old file is never loaded as a project of its own (whose saves would recreate it after its chats came back).
        projectPath = (await resolveProject(recentPath)).path;
        if (resolved.has(projectPath)) continue;
        resolved.add(projectPath);
        // The raw JSON is enough to find a pending turn; only a project that has one is loaded (and hydrated) in full.
        const stored = states.has(projectPath) ? null : await readRawState(projectPath);
        if (!Object.values(stored?.sessions ?? {}).some((session) => session.resumeTurn || (session.queued?.length && !session.queueHeld))) continue;
        await readProject(projectPath);
      } catch (error) {
        console.warn(`Milagre couldn't resume the chats of ${projectPath}:`, error.message);
      }
    }
  }
  async function accountScopes() {
    const projects = await projectRegistry().list();
    const registry = await projectRegistry().snapshot();
    return [
      ...projects.map((p) => ({
        key: p.path,
        name: p.name || projectName(p.path),
        kind: "project",
        projects: [{ id: p.id, path: p.path, name: p.name || projectName(p.path) }],
      })),
      ...(registry.projectGroups ?? []).map((link) => ({
        key: scopeKey({ kind: "link", linkId: link.id }),
        name: link.name,
        kind: "link",
        projects: link.projectIds
          .map((id) => projects.find((p) => p.id === id))
          .filter(Boolean)
          .map(({ id, path, name }) => ({ id, path, name })),
      })),
      // One choice for every Chat without a Project on this computer: a Project scope, marked so the screens show the
      // Chats mark and not the home repository's picture.
      ...((await chatsHome.exists())
        ? [
            {
              key: chatsHome.path,
              name: CHATS_ACCOUNT_LABEL,
              kind: "project",
              chatsHome: true,
              projects: [{ id: chatsHome.path, path: chatsHome.path, name: CHATS_ACCOUNT_LABEL }],
            },
          ]
        : []),
    ];
  }
  async function validateAccountScope(key, optional = false) {
    if (key === undefined || key === null) {
      if (optional) return undefined;
      throw new Error("Choose a Project or Link.");
    }
    if (typeof key !== "string" || !key) throw new Error("Choose a valid Project or Link.");
    const scopes = await accountScopes();
    if (scopes.some((scope) => scope.key === key)) return key;
    throw new Error("Project or Link is no longer available. Refresh and choose another.");
  }
  async function accountScopeForFolder(cwd) {
    if (!cwd) throw new Error("Choose a Chat folder.");
    for (const key of scopeStates.projects().filter(isLinkScopeKey)) {
      const state = await scopeStates.get(key);
      if (Object.values(state.sessions).some((s) => s.workspacePath === cwd || s.worktrees?.some((m) => m.worktreePath === cwd))) return key;
    }
    return (await resolveProject(cwd)).path;
  }
  commands.handle("accounts:scopes", () => accountScopes());
  function assignAccount(key, provider, id) {
    const pending = accountMutation.then(async () => accounts.assign(await validateAccountScope(key), provider, id));
    accountMutation = pending.catch(() => {});
    return pending;
  }
  limitSwitch = createLimitSwitch({
    file: path.join(dataDir, "limit-switch.json"),
    assign: assignAccount,
    scope: async (key) => accounts.scope(await validateAccountScope(key)),
    chats,
  });
  commands.handle("accounts:scope", async (_event, key, refresh) =>
    limitSwitch.decorate(await accounts.scope(await validateAccountScope(key), refresh === true)),
  );
  commands.handle("accounts:assign", async (_event, key, provider, id) => limitSwitch.decorate(await assignAccount(key, provider, id)));
  // The limit card in a Chat: move its Project to another account, then continue the Chat there.
  commands.handle("chat:limit-switch", (_event, projectPath, sessionId, provider, accountId) => {
    if (!scopeStates.has(projectPath)) throw new Error("Open the project before switching its account.");
    if (typeof accountId !== "string" || !accountId) throw new Error("Choose an account.");
    return limitSwitch.switchTo(projectPath, Number(sessionId), provider, accountId);
  });
  commands.handle("limits:auto-switch:read", () => ({ autoSwitch: limitSwitch.autoSwitch() }));
  commands.handle("limits:auto-switch:save", (_event, value) => ({ autoSwitch: limitSwitch.setAutoSwitch(value === true) }));
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
    return { ...registry, states: statesByPath };
  });
  async function addLink(a, b) {
    const active = await canvasActiveWorktrees();
    const before = new Set((await projectRegistry().snapshot()).links.map((link) => link.id));
    await projectRegistry().addLink(a, b, active);
    const links = await linksChanged();
    // The Chats the new Link reaches each get a line saying so, in the background: a Project Link can reach many.
    const added = links.find((link) => !before.has(link.id));
    if (added) void linked.linkAdded(added, active).catch((error) => console.warn("Milagre couldn't mark the linked Chats:", error.message));
    return links;
  }
  async function removeLink(id) {
    await projectRegistry().removeLink(id);
    await linked.linkRemoved(id);
    return linksChanged();
  }
  commands.handle("canvas:link-add", (_event, a, b) => addLink(a, b));
  commands.handle("canvas:link-remove", (_event, id) => removeLink(id));
  commands.handle("canvas:link-restore", async (_event, link) => {
    await projectRegistry().restoreLink(link, await canvasActiveWorktrees());
    return linksChanged();
  });
  // The Links alone, for the sidebar's and the phone's chat rows, without every Project's state the canvas reads. They
  // ask on every switch: Links whose Worktree went away are looked for (with git, in every registered Project) at most
  // every LINKS_PRUNE_MS, and reads meanwhile share the one running. A Worktree Milagre removes prunes its Links at once.
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
    return (await projectRegistry().snapshot()).links;
  });
  commands.handle("linked:grant", (_event, chatId, linkId) => linked.grant(chatId, linkId));
  commands.handle("canvas:worktree-position", (_event, id, worktreePath, position) => projectRegistry().setWorktreePosition(id, worktreePath, position));
  commands.handle("canvas:open-project", async (_event, requested) => {
    if (!(await projectRegistry().list()).some((project) => project.path === requested)) throw new Error("Project is not in the registry.");
    return openProject(requested);
  });
  // Bots' homes and the Chats home are Projects only to the runtime: no list shows them.
  const withoutHomes = (list) => list.filter((project) => !bots.isHome(project.path) && !chatsHome.isHome(project.path));
  // Each recent Project says whether the user hid it from the sidebar and the phone's list.
  async function withHidden(list) {
    const hidden = await projectSettings().hiddenPaths();
    return list.map((project) => (hidden.has(project.path) ? { ...project, hidden: true } : project));
  }
  // Each Project's Git origin, so a new-chat picker shows one repository cloned on several computers as one Project.
  // Read once per folder while the runtime runs; a folder without Git, or with a local-path remote, has none.
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
  // Every Project this Mac knows (the registry, folders that went away dropped), newest opened first: a new-chat picker
  // offers them all, where the sidebar keeps to the recent ones. Hidden ones too: hiding is the sidebar's, not where a Chat starts.
  commands.handle("project:known", async () => {
    const known = withoutHomes(await projectRegistry().list())
      .map((project) => ({ path: project.path, name: project.name || path.basename(project.path), openedAt: project.openedAt ?? "" }))
      .toSorted((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
    return withOrigins(known);
  });
  // Onboarding offers the folders Claude Code and Codex worked in on this Mac.
  commands.handle("onboarding:agent-folders", async () => withoutHomes(await (options.agentFolders ?? agentFolders)()));
  // A first Project made from onboarding opens at once: a new folder, a clone, or Git set up in a folder without it.
  const onboardingProjects = options.onboardingProjects ?? createOnboardingProjects();
  commands.handle("onboarding:create", async (_event, name) => openProject((await onboardingProjects.create(name)).path));
  commands.handle("onboarding:clone", async (_event, url) => openProject((await onboardingProjects.clone(url)).path));
  commands.handle("onboarding:init-git", async (_event, folder) => openProject((await onboardingProjects.initGit(folder)).path));
  commands.handle("project:set-hidden", async (_event, projectPath, hidden) => {
    await knownFolder(projectPath);
    await projectSettings().setHidden(projectPath, hidden === true);
    return withHidden(await recentProjects().list());
  });
  // Reads a recent Project's chats for the all-Projects sidebar without making it the open one or reordering the list.
  // `{ state: false }`: { path, name, git } alone, for a window that holds the state already and only needs the Project
  // open on this host (the daemon adds the number of the state it last sent, see server.cjs).
  commands.handle("project:read", async (_event, projectPath, read) => {
    const known = chatsHome.isHome(projectPath) ? await chatsHome.exists() : (await recentProjects().list()).some((item) => item.path === projectPath);
    if (!known) throw new Error("Open this project in Milagre first.");
    const project = withKind(await readProject(projectPath));
    if (read?.state !== false) return project;
    const { state: _state, ...rest } = project;
    return rest;
  });
  // A retry only flushes the newest pending state. It never replays a Chat command or sends a message.
  commands.handle("scope:retry-save", async (_event, scope) => {
    if (typeof scope !== "string" || !scopeStates.has(scope)) throw new Error("Open the Project or Link before retrying its save.");
    await scopeStates.retry(scope);
  });
  commands.handle("project:snapshot", async (_event, projectPath) => {
    if (!states.has(projectPath)) throw new Error("Open the project before reading its snapshot.");
    return withKind({ path: projectPath, name: projectName(projectPath), git: projectsWithGit.get(projectPath) ?? true, state: await states.get(projectPath) });
  });
  // One saved message with the tool output its steps keep in a sidecar (see compactDetails), for a step opened on the
  // desktop or the phone. A Project, open already, or a Link (read like link:snapshot does), by scope key.
  commands.handle("chat:message", async (_event, scope, id) => {
    if (typeof scope !== "string" || (!isLinkScopeKey(scope) && !states.has(scope))) throw new Error("Open the Project before reading its messages.");
    // From chats.db when its Chat is unloaded (see message-store.cjs).
    const message = await scopeStates.findMessage(scope, "id", id);
    if (!message) throw new Error("That message is no longer in this Project.");
    return withDetails(scopeStates.storageDirectory(scope), message);
  });
  // A page of one Chat's messages, and search across a Project's Chats, for a client that doesn't hold every message.
  // An open Project, or a Link (read like link:snapshot does). Checked without its state: a read that only needs the
  // check waits behind the scope's queued changes once, in its own read, not twice.
  const checkReadable = (scope) => {
    if (typeof scope !== "string" || (!isLinkScopeKey(scope) && !states.has(scope))) throw new Error("Open the Project before reading its messages.");
  };
  const readScope = async (scope) => {
    checkReadable(scope);
    return scopeStates.get(scope);
  };
  // Every message of a Project or Link, in its order, for a reader that needs them all where a state may leave out an
  // unloaded Chat's (see message-store.cjs): the phone's bridge, for a phone app that doesn't read pages. `marks` gives
  // only { id, session_id, role, outcome, clientMessageId } of each, what a chat list reads, without reading them whole.
  // `withState` answers { state, messages }, both from one read of the state, so they never disagree.
  commands.handle("chat:all-messages", async (_event, scope, options) => {
    checkReadable(scope);
    const read = { withState: options?.withState === true };
    return options?.marks === true ? scopeStates.messageMarks(scope, read) : scopeStates.allMessages(scope, read);
  });
  // A Chat a client pages through is loaded (see message-store.cjs): it is likely to get the next message too. A Chat of a
  // Project this host knows but hasn't opened (another computer's window or the phone opening it, a background copy) is
  // read from its chats.db as it is: opening the Project would hold the read behind Git and resume its stopped turns, and
  // nothing of an unopened Project is held in memory to miss.
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
  // A search reads the bodies of unloaded Chats from chats.db, without loading them.
  commands.handle("chat:search", async (_event, scope, query, options) => {
    const state = await readScope(scope);
    const open = Object.values(state.sessions ?? {})
      .filter((session) => !session.archived)
      .map((session) => session.id);
    return chatSearch(state, query, options ?? {}, await scopeStates.searchableMessages(scope, open));
  });
  // One subagent with its whole transcript, for a client that takes only each transcript's last entries (the panel that
  // shows it). `chatId` is the Chat's number in the scope.
  commands.handle("chat:subagent", async (_event, scope, chatId, agentId) => {
    const agent = (await readScope(scope)).sessions?.[chatId]?.subagents?.find((item) => item.id === agentId);
    if (!agent) throw new Error("That subagent is no longer in this Chat.");
    return agent;
  });
  // What the phone's media check needs, without the whole state.
  commands.handle("project:chat-image", (_event, projectPath, requested) => chats.images.resolve(projectPath, requested));
  commands.handle("project:worktree-paths", async (_event, projectPath) => {
    if (!states.has(projectPath)) throw new Error("Open the project before reading its worktrees.");
    return Object.values((await states.get(projectPath)).worktrees ?? {}).map((worktree) => worktree.path);
  });
  commands.handle("project:switch", async (_event, requested) => {
    // Opening a project-less Chat switches the window to the home, which is on no list for switchTarget to find.
    if (chatsHome.isHome(requested) && (await chatsHome.exists())) return openProject(chatsHome.path, { remember: false, register: false });
    return openProject(await switchTarget(recentProjects(), requested));
  });
  // chats:home only says where this computer's home is; chats:ensure makes it when missing and reads it, never registered
  // or remembered. It leaves the shown Project alone: another computer's window can ask for this home, and the window
  // that moves to it does so with project:switch.
  commands.handle("chats:home", async () => ({ path: chatsHome.path, exists: await chatsHome.exists() }));
  commands.handle("chats:ensure", async () => openProject(await chatsHome.ensure(), { takeNotice: false, focus: false, remember: false, register: false }));
  const realDataDir = realpathSync(dataDir);
  const assertRegistrableProject = (folder) => {
    const relative = path.relative(realDataDir, folder);
    const insideDataDir = !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (bots.isHome(folder) || chatsHome.isHome(folder) || insideDataDir)
      throw Error("That folder belongs to Milagre's internal state and cannot be registered as a Project.");
  };
  commands.handle("project:forget", async (_event, projectPath) => {
    localMcp.forgetProjectGrants(projectPath);
    return withHidden(await recentProjects().forget(projectPath));
  });
  // The phone's project search: Git repositories under the home folder, matched by name (see project-finder.cjs).
  const projectFinder = createProjectFinder(options.projectSearchRoot || require("node:os").homedir());
  commands.handle("project:find", (_event, query) => projectFinder.search(typeof query === "string" ? query.slice(0, 200) : ""));

  // The Designs branch supplies this adapter. An absent adapter grants no design tools.
  const designAdapter = path.join(__dirname, "design-mcp-tools.cjs");
  // The Milagre MCP host's ports; bots open their Chats through the same Worktree and Chat ones.
  const localMcpHost = require("./local-mcp-host.cjs").createLocalMcpHost({
    projects: async () => [...withoutHomes(await projectRegistry().list()), ...(await chatsHomeEntries())],
    readProject,
    scopeStates,
    chats,
    permissionMode: (chatId, fallback) => agents.permissionMode(chatId, fallback),
    createWorktree: (context, request) => handlers.get("worktree:create")(context, request),
    stopChat,
    // Never the user's: on a bot's Chat it is refused rather than taking it over.
    setPermissionMode: (chatId, mode) => setPermissionMode(chatId, mode),
    respondPermission: (chatId, requestId, decision) => handlers.get("agent:respond-permission")(null, { chatId, requestId, decision }),
    answerQuestion: (chatId, requestId, answers, summary) => handlers.get("agent:answer-question")(null, { chatId, requestId, answers, summary }),
    patchChat,
    searchChats: async (projectPath, query, limit) => await handlers.get("chat:search")(null, projectPath, query, { limit }),
    links: { list: async () => (await projectRegistry().snapshot()).links, add: addLink, remove: removeLink },
    activeWorktrees: async (projectPath) => (await activeWorktrees(projectPath)).map((worktree) => worktree.path),
    approve: (chatId, request) => agents.askApproval(chatId, request),
    models: (projectPath) => handlers.get("agent:models")(null, projectPath),
    worktreeStatus,
    removeWorktree: (projectPath, worktreePath) => handlers.get("worktree:remove")(null, worktreePath, { projectPath }),
    assertRegistrableProject,
    registerProject: async (folder) => {
      assertRegistrableProject(folder);
      await openProject(folder, { takeNotice: false, focus: false });
      emit("local-mcp:changed", { projectAdded: true });
    },
    botOf: (chatId) => botRunning(chatId),
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
      // A shared Link Chat manages its Link's member Projects as an ordinary Chat manages its own Project.
      const projectPaths = isLinkScopeKey(projectPath) ? (linkMembers.get(scopeFromKey(projectPath).linkId) ?? []) : [projectPath];
      if (!projectPaths.length) return designGrant;
      // A bot's thread and the Chats it opened reach other Chats and Worktrees only through its own tools (chat_open,
      // chat_send), which keep them in Bot rules: creating, starting or linking one here would run outside its gates.
      const botChat = Boolean(botRunning(chatId));
      return {
        ...designGrant,
        projects: { projectPaths, capabilities: botChat ? ["read"] : ["read", "create"] },
        worktrees: { projectPaths, capabilities: botChat ? ["read"] : ["read", "create"] },
        chats: { projectPaths, capabilities: botChat ? ["read"] : ["read", "create", "start"] },
      };
    },
    host: localMcpHost,
  });
  for (const method of ["status", "create", "update", "rotate", "revoke", "enableClient", "disableClient"])
    commands.handle(`local-mcp:${method}`, (_context, ...args) => localMcp[method](...args));
  // No runtime is started by MCP. This listener belongs to the runtime holding the profile lock.
  void localMcp.resume().catch(() => console.warn("Local MCP could not resume its loopback listener. Open Settings > Milagre MCP to retry."));

  // Bots (Settings › Experimental › Bots; docs/adr/0010-bots-are-hidden-projects.md). A bot's home opens like a Project
  // but never joins the registry or the recent list, and closes again when the bot is deleted.
  async function closeHome(home) {
    if (states.has(home)) {
      for (const id of Object.keys((await states.get(home)).sessions)) {
        const chatId = chatKey(home, Number(id));
        terminals.closeChat(chatId);
        await stopChat(chatId).catch(() => {});
        await agents.closeChat(chatId);
      }
      await states.forget(home);
    }
    readOnce.delete(home);
    resumes.delete(home);
    openedIdentities.delete(home);
    projectsWithGit.delete(home);
    const common = await git.commonDir(home).catch(() => null);
    projectOwners.get(home)?.owner.release();
    projectOwners.delete(home);
    if (common) {
      repositoryOwners.get(common)?.release();
      repositoryOwners.delete(common);
    }
  }
  // What chat_status tells a bot about a Chat it opened, read from the Chat and its Worktree.
  async function botChatDetails(chatId) {
    const scope = projectOfKey(chatId);
    const id = sessionIdFromKey(chatId);
    if (!states.has(scope)) return null;
    const state = await scopeStates.load(scope, [id]);
    const session = state.sessions[id];
    if (!session) return null;
    const worktree = state.worktrees?.[session.worktree_id];
    const reply = state.messages.findLast((message) => message.session_id === id && message.role === "assistant" && message.body && !message.context);
    const status = worktree?.path ? await git.text(worktree.path, ["status", "--porcelain"]).catch(() => "") : "";
    return {
      running: Boolean(chats.runs[chatId]),
      lastReply: reply?.body ?? "",
      ...(reply?.outcome ? { outcome: reply.outcome } : {}),
      ...(worktree ? { branch: worktree.name } : {}),
      pullRequests: session.summary?.pullRequests ?? [],
      changedFiles: status
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3)),
    };
  }
  // Whether a Chat a bot opened runs a turn now, or will when its Project opens (a quit's resume still in its window).
  // A Project not open yet is read from its saved file, without opening it.
  async function botChatContinues(chatId) {
    if (chats.isBusy(chatId)) return true;
    const projectPath = projectOfKey(chatId);
    const sessions = states.has(projectPath)
      ? (await states.get(projectPath)).sessions
      : JSON.parse(await fs.readFile(stateFile(projectPath), "utf8").catch(() => "{}")).sessions;
    const session = sessions?.[sessionIdFromKey(chatId)];
    return chats.willResume(session) || chats.startsQueue(session);
  }
  // A store that can't be opened leaves Bots unavailable, never Milagre: nothing else needs angelo.db.
  let botStore = null;
  try {
    botStore = createBotStore(path.join(dataDir, "angelo.db"));
  } catch (error) {
    console.warn("Milagre couldn't open angelo.db. Bots are unavailable:", error.message);
  }
  bots = botStore
    ? createBots({
        dataDir: realpathSync(dataDir),
        store: botStore,
        chats,
        agents,
        cachedState: (projectPath) => states.states.get(projectPath),
        openHome: readProject,
        closeHome,
        projects: async () => withoutHomes(await projectRegistry().list()),
        host: localMcpHost,
        mainBranch: (projectPath) =>
          git.resolveBase(projectPath).then(
            (base) => base.name,
            () => "main",
          ),
        chatDetails: botChatDetails,
        chatContinues: botChatContinues,
        leaveBotRules: async (chatId) => {
          await chats.leaveBotRules(chatId);
          if (agents.permissionMode(chatId, null) === "bot") await agents.setPermissionMode(chatId, "ask");
        },
        titleChat: (chatId, title) => editProject(projectOfKey(chatId), (state) => patchSession(state, sessionIdFromKey(chatId), { title }), { chats: [] }),
        emit,
        closing: () => closing,
        owner: options.botOwner,
      })
    : unavailableBots();
  commands.handle("bots:enabled:read", () => ({ enabled: bots.enabled() }));
  commands.handle("bots:enabled:save", (_event, value) => bots.setEnabled(value));
  commands.handle("bots:list", () => bots.snapshot());
  commands.handle("bots:templates", () => bots.templates());
  commands.handle("bots:create", (_event, input) => bots.create(input ?? {}));
  commands.handle("bots:update", (_event, id, patch) => bots.update(String(id), patch ?? {}));
  commands.handle("bots:remove", (_event, id) => bots.remove(String(id)));
  // A client sends text only: the contexts that mark a message as Milagre's are written here.
  commands.handle("bots:send", (_event, id, text) => bots.send(String(id), text));
  commands.handle("bots:answer-gate", (_event, chatKey, requestId, choice) => bots.answerGate(String(chatKey), String(requestId), choice));
  commands.handle("bots:revoke-grant", (_event, id) => bots.revokeGrant(String(id)));
  commands.handle("bots:brief:read", (_event, id) => bots.readBrief(String(id)));
  commands.handle("bots:memory:read", (_event, id) => bots.readMemory(String(id)));
  // `base`, the text the profile opened, is optional: without it the save goes through as before.
  commands.handle("bots:memory:save", (_event, id, text, base) => bots.saveMemory(String(id), String(text ?? ""), base == null ? undefined : String(base)));
  void track(() => bots.start(), background).catch((error) => console.warn("Milagre couldn't start its bots:", error.message));

  const sweepUploads = () =>
    track(async () => {
      await attachmentTransfers.sweep();
      await mobileUploads.sweep();
    }, background).catch((error) => console.warn("Attachment cleanup skipped:", error.message));
  const uploadSweepTimer = setInterval(sweepUploads, 24 * 60 * 60 * 1000);
  uploadSweepTimer.unref();
  void sweepUploads();
  // Done Chats past their retention are archived once a minute, in every open Project and Link (bots' homes have none).
  const doneSweep = createDoneSweep({
    settings: doneSettings,
    scopes: () => scopeStates.projects().filter((key) => !bots.isHome(key)),
    heldState,
    archive: (scope, sessionId, retentionHours) => track(() => archiveDoneChat(scope, sessionId, retentionHours), background),
    isClosing: () => closing,
  });
  doneSweep.start();

  function close() {
    clearInterval(uploadSweepTimer);
    chatSecrets?.close();
    void doneSweep.stop();
    closing = true;
    // A comment already on its way goes back to its queue before the rest closes.
    const routinesStopped = routines.stop();
    linked.suspend();
    closed ??= (async () => {
      await routinesStopped;
      await localMcp.close();
      await advisorDelivery.close();
      await advisors.close();
      await advisorMcp.close();
      await advisorStore.close();
      // Ending the Terminals first also answers their pending reads, which the wait for accepted commands includes.
      await Promise.all([simulators.close(), browsers.close(), panelForwarders.closeAll(), artifacts.close(), pageComments.close(), terminals.dispose()]);
      // A waiting Linear sign-in is an accepted command too: end it, or the wait below lasts until its timeout.
      await linear.dispose();
      await Promise.allSettled(active);
      await attachmentTransfers.close();
      accounts.close();
      keybindings.close();
      keepAwake.quit();
      computerResources.close();
      ports.close();
      diffs.close();
      pullRequestWatch?.close();
      if (!states.closed) {
        await chats.suspendRunning();
        // A failed early save must not leave provider processes running. The
        // final flush retries after their cancellation events have been recorded.
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
      bots.close();
      await Promise.all([usageStore.idle(), ...[...accountUsage.values()].map((item) => item.store.idle())]);
      for (const { owner } of projectOwners.values()) owner.release();
      for (const owner of repositoryOwners.values()) owner.release();
      dataOwner.release();
    })().catch((error) => {
      // Retain ownership and unsaved memory until the host reports the error and
      // retries. A rejected Promise must not permanently disable that retry.
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
    /** Runs the Done sweep now instead of at its next minute (tests); resolves with the Chats it archived. */
    sweepDone: () => doneSweep.sweep(),
    /** A bot's thread, or a Chat a bot opened and still runs: its completion tells no one but the bot. */
    isQuietChat: (chatId) => isQuietChat(bots.snapshot(), chatId),
    openProject: (projectPath, options) => accept(() => openProject(projectPath, options)),
    resumeRecentProjects: () => accept(resumeRecentProjects),
    environmentReady,
    isClosing: () => closing,
    // Webhook Routines for the daemon's relay host: the hooks to register, deliveries in, the relay's refusals, owner keys.
    routines: {
      hookIds: () => routines.hookIds(),
      receiveHook: (delivery) => routines.receiveHook(delivery),
      receiveHooks: (deliveries) => routines.receiveHooks(deliveries),
      hooksRefused: (ids) => routines.hooksRefused(ids),
      hookOwners: (ids) => routines.hookOwners(ids),
      // One tick now, and what it set going off the tick: a positive signal for checks that nothing started.
      tick: () => routines.tick(),
      idle: () => routines.idle(),
      // A Run Chat sweep over a Project's state as given (for checks: one read before a change since).
      sweepRunChats: (projectPath, state) => routines.sweepRunChats(projectPath, state),
    },
    // Synchronous capture: the socket serializes this before another event can
    // mutate state, so its event watermark and run sequence describe one instant.
    // The Chats home stays in: a reconnecting window restores its project-less Chats from it, and live activity reads them.
    // Its state is kept by its real path, so one look at that path marks it.
    snapshot: () => {
      const home = chatsHome.path;
      return {
        links: linkStore.ids().map((linkId) => ({ linkId, state: linkStore.has(linkId) ? linkStore.cached(linkId) : undefined })),
        projects: states
          .projects()
          .filter((projectPath) => !bots.isHome(projectPath))
          .map((projectPath) => {
            const project = { path: projectPath, name: projectName(projectPath), state: states.states.get(projectPath) };
            if (projectPath === home) project.kind = "chats";
            return project;
          }),
        runs: chats.snapshot(),
        ports: ports.snapshot(),
      };
    },
    /** The state a Project or Link holds now, without waiting for its queued changes; undefined when it isn't read. */
    stateOf: (scope) => (isLinkScopeKey(scope) ? linkStore.cached(scopeFromKey(scope).linkId) : states.states.get(scope)),
    // A window regains focus over `view` ({ projectPath, chatId }): its Chat is read and its Project's diff stats are
    // read again (edits made outside Milagre), at most every few seconds.
    focused: (view) =>
      accept(() => {
        diffs.focused(view ? view.projectPath : shownProjectPath);
        return readOpenChat(view ? view.chatId : chats.openChat);
      }),
    // A window shows `chatId` now (chat:set-open): it is read, and only its own Worktree's diff stat is read again, at
    // most every few seconds. A switch between Chats never reads a whole Project's Worktrees.
    chatOpened: (chatId) =>
      accept(() => {
        diffs.focusedChat(chatId);
        return readOpenChat(chatId);
      }),
    /** Unloads the idle Chats of every open Project and Link now, as the sweep does every minute (see ProjectStates). */
    unloadIdle: () => Promise.all([states.unloadIdle(), linkStore.unloadIdle()]).then(() => undefined),
    flush: async () => {
      // A waiting Linear sign-in is an accepted command, but its window is gone when this runs on quit: end it.
      await linear.dispose();
      await Promise.allSettled(active);
      await attachmentTransfers.close();
      await scopeStates.flush();
      await usageStore.idle();
    },
    close,
  };
}

module.exports = { createRuntime };
