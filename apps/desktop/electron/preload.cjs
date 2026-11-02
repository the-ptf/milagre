// @ts-check
/** @typedef {typeof import("../app/src/electron.d.ts")} BridgeTypes */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// What only this Mac's own window does: its editors and Finder, the folder dialog, the clipboard and image menus,
// notifications, updates, its own host, devices and accounts. A paired computer's bridge refuses them before any IPC,
// and main refuses them again (computer-routing.cjs keeps the same lists; computer-routing.test.cjs compares them).
const NOT_REMOTE = "Not available on a remote computer";
const LOCAL_ONLY = new Set([
  "project:open",
  "project:reveal",
  "project:set-hidden",
  "skills:open",
  "skills:reveal",
  "runtime:connection",
  "runtime:restart-host",
  "accounts:list",
  "accounts:add",
  "accounts:select",
  "accounts:login",
  "accounts:cancel",
  "accounts:remove",
  "chat:limit-switch",
  "agent:update-cli",
  "agent:provider-updates",
  "linear:connect",
  "linear:cancel",
  "linear:disconnect",
  "mcp:save",
  "mcp:signIn",
  "mcp:cancelSignIn",
]);
const LOCAL_ONLY_PREFIXES = [
  "app:",
  "artifact-preview:",
  "bots:",
  "canvas:",
  "computers:",
  "devices:",
  "editor:",
  "image:",
  "floating-inbox:",
  "linked:",
  "notification:",
  "phone:",
  "settings:",
  "update:",
];
/** @param {string} channel */
const isLocalOnly = (channel) => LOCAL_ONLY.has(channel) || LOCAL_ONLY_PREFIXES.some((prefix) => channel.startsWith(prefix));

/**
 * Every call and event the window has, over whatever carries them: this Mac's IPC, or a paired computer's through main.
 * @param {(channel: string, ...args: any[]) => Promise<any>} invoke
 * @param {(channel: string, callback: (payload: any) => void) => () => void} listen
 * @param {(channel: string, ...args: any[]) => void} send
 * @returns {import("../app/src/electron.d.ts").MilagreBridge}
 */
function makeBridge(invoke, listen, send) {
  return {
    simulators: {
      list: (request) => invoke("simulator:list", request),
      attach: (request) => invoke("simulator:attach", request),
      detach: (request) => invoke("simulator:detach", request),
      open: (request) => invoke("simulator:open", request),
      frame: (request) => invoke("simulator:frame", request),
      offer: (request) => invoke("simulator:offer", request),
      status: (request) => invoke("simulator:status", request),
      control: (request) => invoke("simulator:control", request),
      input: (request) => invoke("simulator:input", request),
      repair: (request) => invoke("simulator:repair", request),
      close: (request) => invoke("simulator:close", request),
    },
    computerUse: {
      readSettings: () => invoke("computer-use:settings:read"),
      saveSettings: (patch) => invoke("computer-use:settings:save", patch),
      onSettings: (callback) => listen("computer-use:settings", callback),
      status: () => invoke("computer-use:status"),
      guide: () => invoke("computer-use:guide"),
      frame: (request) => invoke("computer-use:frame", request),
    },
    simlock: {
      readSettings: () => invoke("simlock:settings:read"),
      saveSettings: (patch) => invoke("simlock:settings:save", patch),
      onSettings: (callback) => listen("simlock:settings", callback),
      identity: (request) => invoke("simlock:identity", request),
      models: () => invoke("simlock:models"),
      lease: (request) => invoke("simlock:lease", request),
      release: (request) => invoke("simlock:release", request),
    },
    pageComments: {
      add: (request) => invoke("browser-comments:add", request),
      list: (request) => invoke("browser-comments:list", request),
      sendFromPage: (request) => invoke("browser-comments:send-from-page", request),
    },
    browsers: {
      list: (request) => invoke("browser:list", request),
      attach: (request) => invoke("browser:attach", request),
      detach: (request) => invoke("browser:detach", request),
      open: (request) => invoke("browser:open", request),
      frame: (request) => invoke("browser:frame", request),
      status: (request) => invoke("browser:status", request),
      control: (request) => invoke("browser:control", request),
      input: (request) => invoke("browser:input", request),
      close: (request) => invoke("browser:close", request),
    },
    terminals: {
      profiles: () => invoke("terminal:profiles"),
      setShell: (request) => invoke("terminal:setShell", request),
      list: (request) => invoke("terminal:list", request),
      open: (request) => invoke("terminal:open", request),
      read: (request) => invoke("terminal:read", request),
      input: (request) => invoke("terminal:input", request),
      resize: (request) => invoke("terminal:resize", request),
      close: (request) => invoke("terminal:close", request),
    },
    onTerminalsChanged: (callback) => listen("terminal:changed", callback),
    // ⌘W closes the focused Terminal instead of the window; the main process needs to know where focus is to decide.
    setTerminalFocused: (focused) => send("app:terminal-focused", focused === true),
    onCloseFocusedTerminal: (callback) => listen("app:close-focused-terminal", () => callback()),
    readDesignsEnabled: () => invoke("designs:enabled:read"),
    onDesignsEnabledChanged: (callback) => listen("designs:enabled-changed", callback),
    readBotsEnabled: () => invoke("bots:enabled:read"),
    saveBotsEnabled: (value) => invoke("bots:enabled:save", value),
    onBotsEnabledChanged: (callback) => listen("bots:enabled-changed", callback),
    listBots: () => invoke("bots:list"),
    onBotsChanged: (callback) => listen("bots:changed", callback),
    botTemplates: () => invoke("bots:templates"),
    createBot: (input) => invoke("bots:create", input),
    updateBot: (id, patch) => invoke("bots:update", id, patch),
    removeBot: (id) => invoke("bots:remove", id),
    sendToBot: (id, text) => invoke("bots:send", id, text),
    answerBotGate: (chatKey, requestId, choice) => invoke("bots:answer-gate", chatKey, requestId, choice),
    revokeBotGrant: (id) => invoke("bots:revoke-grant", id),
    readBotBrief: (id) => invoke("bots:brief:read", id),
    readBotMemory: (id) => invoke("bots:memory:read", id),
    saveBotMemory: (id, text, base) => (base === undefined ? invoke("bots:memory:save", id, text) : invoke("bots:memory:save", id, text, base)),
    createArtifactPreview: (html, source) => invoke("artifact-preview:register", html, source),
    releaseArtifactPreview: (url) => invoke("artifact-preview:release", url),
    artifacts: {
      sharingStatus: (request) => invoke("artifact:sharing-status", request),
      allPageShares: () => invoke("artifact:all-page-shares"),
      revokeSavedPageShare: (request) => invoke("artifact:revoke-saved-page-share", request),
      pageShares: (request) => invoke("artifact:page-shares", request),
      sharePage: (request) => invoke("artifact:share-page", request),
      revokePageShare: (request) => invoke("artifact:revoke-page-share", request),
      get: (request) => invoke("artifact:get", request),
      asset: (request) => invoke("artifact:asset", request),
      list: (request) => invoke("artifact:list", request),
      apply: (request) => invoke("artifact:apply", request),
      delete: (request) => invoke("artifact:delete", request),
      addComments: (request) => invoke("artifact:add-comments", request),
      comments: (request) => invoke("artifact:comments", request),
    },
    getRuntimeConnection: () => invoke("runtime:connection"),
    restartHost: () => invoke("runtime:restart-host"),
    onRuntimeConnection: (callback) => listen("runtime:connection", callback),
    onRuntimeSnapshot: (callback) => listen("runtime:snapshot", callback),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    readAttachment: (file) => invoke("attachment:preview", file),
    readAttachmentChunk: (file, offset, version = "") => invoke("attachment:read", file, offset, version),
    searchProjectFiles: (root, query) => invoke("project:files", root, query),
    listSkills: (projectPath) => invoke("skills:list", projectPath),
    readSkill: (projectPath, file) => invoke("skills:read", projectPath, file),
    dictationContext: (request) => invoke("dictation:context", request),
    // The fix-up of a finished take's misheard names, which both apps write over the take in place.
    polishDictation: (request) => invoke("dictation:polish", request),
    openSkill: (request) => invoke("skills:open", request),
    revealSkill: (projectPath, file) => invoke("skills:reveal", projectPath, file),
    listBranches: (projectPath) => invoke("project:branches", projectPath),
    getProjectImage: (projectPath) => invoke("project:image", projectPath),
    setProjectIcon: (projectPath, icon) => invoke("project:set-icon", projectPath, icon),
    getAppVersion: () => invoke("app:version"),
    prepareTriage: (client) => invoke("triage:prepare", client),
    createWorktree: (request) => invoke("worktree:create", request),
    linkWorktreeIssue: (request) => invoke("worktree:link-issue", request),
    unlinkWorktreeIssue: (request) => invoke("worktree:unlink-issue", request),
    getWorktreeRoots: () => invoke("worktree:roots"),
    getWorktreeStatus: (worktreePath, base) => invoke("worktree:status", worktreePath, base),
    removeWorktree: (worktreePath, options) => invoke("worktree:remove", worktreePath, options),
    readFilesToCopy: (projectPath) => invoke("files-to-copy:read", projectPath),
    previewFilesToCopy: (projectPath, patterns) => invoke("files-to-copy:preview", projectPath, patterns),
    saveFilesToCopy: (projectPath, patterns) => invoke("files-to-copy:save", projectPath, patterns),
    readWorktreeSetup: (projectPath) => invoke("worktree-setup:read", projectPath),
    saveWorktreeSetup: (projectPath, command) => invoke("worktree-setup:save", projectPath, command),
    readMainSync: (projectPath) => invoke("main-sync:read", projectPath),
    saveMainSync: (projectPath, override) => invoke("main-sync:save", projectPath, override),
    readMainSyncDefault: () => invoke("main-sync:default:read"),
    saveMainSyncDefault: (value) => invoke("main-sync:default:save", value),
    onMainSyncStatus: (callback) => listen("main-sync:status", callback),
    readLinearStatus: () => invoke("linear:status"),
    connectLinear: (options) => invoke("linear:connect", { window: options?.window === true }),
    disconnectLinear: (workspace) => invoke("linear:disconnect", { workspace }),
    readLinearEnabled: () => invoke("linear:enabled:read"),
    saveLinearEnabled: (value) => invoke("linear:enabled:save", value),
    saveLinearMoveToStarted: (value) => invoke("linear:move-to-started:save", value),
    readLimitAutoSwitch: () => invoke("limits:auto-switch:read"),
    saveLimitAutoSwitch: (value) => invoke("limits:auto-switch:save", value),
    readLimitResumeAtReset: () => invoke("limits:resume-at-reset:read"),
    saveLimitResumeAtReset: (value) => invoke("limits:resume-at-reset:save", value),
    readAutoUpdate: () => invoke("app-update:auto:read"),
    saveAutoUpdate: (value) => invoke("app-update:auto:save", value),
    onAutoUpdate: (callback) => listen("app-update:auto", callback),
    readHostUpdate: () => invoke("app-update:state"),
    checkHostUpdate: () => invoke("app-update:check"),
    installHostUpdate: () => invoke("app-update:install"),
    readComputerResources: () => invoke("computer:resources:read"),
    readKeybindings: () => invoke("keybindings:read"),
    setKeybindingCommand: (command, rules) => invoke("keybindings:set-command", command, rules),
    resetKeybindingCommand: (command) => invoke("keybindings:reset-command", command),
    resetKeybindings: () => invoke("keybindings:reset"),
    onKeybindings: (callback) => listen("keybindings:changed", callback),
    openKeybindingsFile: () => invoke("app:open-keybindings-file"),
    readContextSettings: () => invoke("context:settings:read"),
    saveContextSettings: (patch) => invoke("context:settings:save", patch),
    onContextSettings: (callback) => listen("context:settings", callback),
    readBabysitSettings: () => invoke("babysit:settings:read"),
    saveBabysitSettings: (patch) => invoke("babysit:settings:save", patch),
    onBabysitSettings: (callback) => listen("babysit:settings", callback),
    readDoneSettings: () => invoke("done:settings:read"),
    saveDoneSettings: (patch) => invoke("done:settings:save", patch),
    onDoneSettings: (callback) => listen("done:settings", callback),
    readRoutinesEnabled: () => invoke("routines:enabled:read"),
    listRoutines: () => invoke("routines:list"),
    updateRoutine: (id, patch) => invoke("routines:update", id, patch),
    deleteRoutine: (id) => invoke("routines:delete", id),
    runRoutineNow: (id) => invoke("routines:run-now", id),
    createRoutine: (input) => invoke("routines:create", input),
    routineTargets: () => invoke("routines:targets"),
    routineLinearOptions: (args) => invoke("routines:linear-options", args),
    routineHook: (id) => invoke("routines:hook", id),
    rotateRoutineHook: (id) => invoke("routines:rotate-hook", id),
    onRoutinesChanged: (callback) => listen("routines:changed", callback),
    mcp: {
      accounts: () => invoke("mcp:accounts"),
      check: (provider, accountId) => invoke("mcp:check", provider, accountId),
      definition: (name, target) => invoke("mcp:definition", name, target),
      save: (def, target, previous) => invoke("mcp:save", def, target, previous ?? null),
      saveUrl: (def, target, previous) => invoke("mcp:saveUrl", def, target, previous ?? null),
      remove: (name, target) => invoke("mcp:remove", name, target),
      toggle: (provider, accountId, name, on) => invoke("mcp:toggle", provider, accountId, name, on),
      signIn: (name, accounts) => invoke("mcp:signIn", name, accounts),
      cancelSignIn: (name) => invoke("mcp:cancelSignIn", name),
      onChanged: (callback) => listen("mcp:changed", callback),
    },
    localMcp: {
      status: () => invoke("local-mcp:status"),
      create: (input) => invoke("local-mcp:create", input),
      update: (id, input) => invoke("local-mcp:update", id, input),
      rotate: (id) => invoke("local-mcp:rotate", id),
      revoke: (id) => invoke("local-mcp:revoke", id),
      enableClient: (id, input) => invoke("local-mcp:enableClient", id, input),
      disableClient: (id) => invoke("local-mcp:disableClient", id),
      onChanged: (callback) => listen("local-mcp:changed", callback),
    },
    onLinearStatusChanged: (callback) => listen("linear:status-changed", callback),
    onLinearEnabledChanged: (callback) => listen("linear:enabled-changed", callback),
    listLinearIssues: (query, options) => invoke("linear:issues", { query, fresh: options?.fresh === true, workspace: options?.workspace }),
    readWorktreeLinearIssues: (projectPath) => invoke("linear:worktree-issues", projectPath),
    onWorktreeRenamed: (callback) => listen("worktree:renamed", callback),
    refreshDiffs: (projectPath, worktreeIds) => invoke("worktree:refresh-diffs", projectPath, worktreeIds),
    readPullRequest: (worktreePath) => invoke("worktree:pull-request", worktreePath),
    readPullRequests: (worktreePath, refs) => invoke("worktree:pull-requests", worktreePath, refs),
    readPullRequestSnapshot: (projectPath) => invoke("pull-requests:snapshot", projectPath),
    onPullRequestsChanged: (callback) => listen("pull-requests:changed", callback),
    revealInFolder: (folder) => invoke("project:reveal", folder),
    copyImage: (file) => invoke("image:copy", file),
    saveImage: (file, name) => invoke("image:save", file, name),
    showImageMenu: (file, name) => invoke("image:menu", file, name),
    git: {
      changes: (request) => invoke("git:changes", request),
      history: (request) => invoke("git:history", request),
      diffFiles: (request) => invoke("git:diff-files", request),
      diffFile: (request) => invoke("git:diff-file", request),
      generate: (request) => invoke("git:generate", request),
      commit: (request) => invoke("git:commit", request),
      push: (request) => invoke("git:push", request),
      openPr: (request) => invoke("git:open-pr", request),
    },
    pr: {
      detail: (request) => invoke("pr:detail", request),
      diffFiles: (request) => invoke("pr:diff-files", request),
      diffFile: (request) => invoke("pr:diff-file", request),
      comment: (request) => invoke("pr:comment", request),
      reply: (request) => invoke("pr:reply", request),
      deleteComment: (request) => invoke("pr:delete-comment", request),
      submitReview: (request) => invoke("pr:submit-review", request),
      resolveThread: (request) => invoke("pr:resolve-thread", request),
      merge: (request) => invoke("pr:merge", request),
      ready: (request) => invoke("pr:ready", request),
      image: (request) => invoke("pr:image", request),
      labels: (request) => invoke("pr:labels", request),
      setLabels: (request) => invoke("pr:set-labels", request),
      reviewerCandidates: (request) => invoke("pr:reviewer-candidates", request),
      requestReviewers: (request) => invoke("pr:request-reviewers", request),
    },
    listEditors: () => invoke("editor:list"),
    openInEditor: (request) => invoke("editor:open", request),
    getCurrentProject: () => invoke("project:current"),
    openProject: () => invoke("project:open"),
    /** A folder on this computer, opened as a Project without the folder dialog (the remote folder picker). */
    openProjectAt: (folder) => invoke("project:open-at", folder, { takeNotice: true }),
    listDirs: (request) => invoke("fs:list-dirs", request),
    readMedia: (request) => invoke("media:read", request),
    listRecentProjects: () => invoke("project:recent"),
    /** Every Project the computer knows, for the new-chat picker; the sidebar keeps to the recent ones. */
    listKnownProjects: () => invoke("project:known"),
    listAgentFolders: () => invoke("onboarding:agent-folders"),
    createProject: (name) => invoke("onboarding:create", name),
    cloneProject: (url) => invoke("onboarding:clone", url),
    setUpGit: (folder) => invoke("onboarding:init-git", folder),
    setProjectHidden: (projectPath, hidden) => invoke("project:set-hidden", projectPath, hidden),
    retrySave: (scope) => invoke("scope:retry-save", scope),
    /**
     * `{ state: false }`: the Project opened on its host without its state, `{ path, name, git, version, epoch }`, for a
     * window that already holds the state.
     * @param {string} projectPath
     * @param {{ state?: boolean }} [options]
     */
    readProject: (projectPath, options) => invoke("project:read", projectPath, options),
    chatsHome: () => invoke("chats:home"),
    ensureChatsHome: () => invoke("chats:ensure"),
    listNamedLinks: () => invoke("link:list"),
    createNamedLink: (request) => invoke("link:create", request),
    updateNamedLink: (request) => invoke("link:update", request),
    openNamedLink: (id) => invoke("link:open", id),
    readLink: (id) => invoke("link:snapshot", id),
    sendLinkMessage: (request) => invoke("link:send", request),
    onLinkState: (callback) => listen("link:state", callback),
    listProjects: () => invoke("project:registry"),
    setProjectPosition: (id, position) => invoke("project:position", id, position),
    getCanvas: () => invoke("canvas:snapshot"),
    addLink: (a, b) => invoke("canvas:link-add", a, b),
    removeLink: (id) => invoke("canvas:link-remove", id),
    restoreLink: (link) => invoke("canvas:link-restore", link),
    getLinks: () => invoke("canvas:links"),
    onLinksChanged: (callback) => listen("canvas:links-changed", (payload) => callback(payload.links)),
    grantDelegations: (chatId, linkId) => invoke("linked:grant", chatId, linkId),
    setWorktreePosition: (id, worktreePath, position) => invoke("canvas:worktree-position", id, worktreePath, position),
    openCanvasProject: (projectPath) => invoke("canvas:open-project", projectPath),
    getLinkedWork: () => invoke("linked:snapshot"),
    readRemoteDelegationEnabled: () => invoke("linked:remote-enabled:read"),
    saveRemoteDelegationEnabled: (value) => invoke("linked:remote-enabled:save", value),
    onRemoteDelegationEnabledChanged: (callback) => listen("linked:remote-enabled-changed", callback),
    readDeviceNotesEnabled: () => invoke("device-notes:read"),
    saveDeviceNotesEnabled: (value) => invoke("device-notes:save", value),
    onDeviceNotesEnabledChanged: (callback) => listen("device-notes:changed", callback),
    stopNegotiation: (id) => invoke("linked:stop-negotiation", id),
    onAppShortcut: (callback) => listen("app:shortcut", callback),
    onLinkedWork: (callback) => listen("linked:changed", callback),
    switchProject: (projectPath) => invoke("project:switch", projectPath),
    forgetProject: (projectPath) => invoke("project:forget", projectPath),
    retryQuit: () => invoke("app:retry-quit"),
    onQuitFailed: (callback) => listen("app:quit-failed", callback),
    onProjectState: (callback) => listen("project:state", callback),
    checkpoints: {
      list: (request) => invoke("checkpoint:list", request),
      preview: (request) => invoke("checkpoint:preview", request),
      restore: (request) => invoke("checkpoint:restore", request),
    },
    sendMessage: (request) => invoke("chat:send", request),
    sendStatus: (owner, id) => invoke("chat:send-status", owner, id),
    resumeChat: (projectPath, sessionId) => invoke("chat:resume", projectPath, sessionId),
    reloadChat: (chatId) => invoke("chat:reload", chatId),
    sendQueuedNow: (chatId, id) => invoke("chat:queue-send", chatId, id),
    removeQueued: (chatId, id) => invoke("chat:queue-remove", chatId, id),
    switchAccountAfterLimit: (projectPath, sessionId, provider, accountId) => invoke("chat:limit-switch", projectPath, sessionId, provider, accountId),
    scheduleLimitResume: (projectPath, sessionId, sourceMessageId) => invoke("chat:limit-resume", projectPath, sessionId, sourceMessageId),
    cancelLimitResume: (projectPath, sessionId, sendId) => invoke("chat:limit-resume:cancel", projectPath, sessionId, sendId),
    patchChat: (projectPath, sessionId, patch) => invoke("chat:patch", projectPath, sessionId, patch),
    deleteChat: (projectPath, sessionId) => invoke("chat:delete", projectPath, sessionId),
    archiveSubagent: (projectPath, sessionId, id, archived) => invoke("chat:archive-subagent", projectPath, sessionId, id, archived),
    archiveFinishedSubagents: (projectPath, sessionId) => invoke("chat:archive-finished-subagents", projectPath, sessionId),
    addGitNote: (chatId, body) => invoke("chat:git-note", chatId, body),
    setOpenChat: (chatId) => invoke("chat:set-open", chatId),
    getRuns: () => invoke("chat:runs"),
    getMessage: (scope, id) => invoke("chat:message", scope, id),
    readState: (scope) => invoke("state:read", scope),
    readChatMessages: (scope, chatId, options) => invoke("chat:messages", scope, chatId, options),
    searchChats: (scope, query, options) => invoke("chat:search", scope, query, options),
    readSubagent: (scope, chatId, agentId) => invoke("chat:subagent", scope, chatId, agentId),
    readTaskOutput: (chatId, taskId) => invoke("chat:task-output", chatId, taskId),
    listAccountScopes: () => invoke("accounts:scopes"),
    getProjectAccounts: (scopeKey, refresh) => invoke("accounts:scope", scopeKey, refresh),
    assignProjectAccount: (scopeKey, provider, accountId) => invoke("accounts:assign", scopeKey, provider, accountId),
    getModels: (scopeKey) => invoke("agent:models", scopeKey),
    getCliStatus: (scopeKey) => invoke("agent:cli-status", scopeKey),
    getProviderUpdates: () => invoke("agent:provider-updates"),
    updateCli: (provider, targetVersion) => invoke("agent:update-cli", provider, targetVersion),
    stopAdvisor: (chatId, id) => invoke("advisor:stop", chatId, id),
    retryAdvisor: (chatId, id) => invoke("advisor:retry", chatId, id),
    onCliProgress: (callback) => listen("agent:cli-progress", callback),
    interruptAgent: (chatId) => invoke("agent:interrupt", chatId),
    respondToPermission: (chatId, requestId, decision) => invoke("agent:respond-permission", { chatId, requestId, decision }),
    answerQuestion: (chatId, requestId, answers, summary) => invoke("agent:answer-question", { chatId, requestId, answers, summary }),
    setAgentPermissionMode: (chatId, mode) => invoke("agent:set-permission-mode", { chatId, mode }),
    onAgentEvent: (callback) => listen("agent:event", callback),
    getAgentPorts: () => invoke("agent:ports"),
    stopAgentPort: (chatId, pid) => invoke("agent:stop-port", chatId, pid),
    onAgentPorts: (callback) => listen("agent:ports", callback),
    getUpdateState: () => invoke("update:state"),
    getUpdateReleaseNotes: (version) => invoke("update:release-notes", version),
    checkForUpdates: () => invoke("update:check"),
    getReleaseChannel: () => invoke("update:channel"),
    setReleaseChannel: (channel) => invoke("update:set-channel", channel),
    installUpdate: () => invoke("update:install"),
    onUpdateState: (callback) => listen("update:state", callback),
    getPhoneStatus: () => invoke("phone:status"),
    setPhoneEnabled: (enabled) => invoke("phone:set-enabled", enabled),
    setPhoneLan: (enabled) => invoke("phone:set-lan", enabled),
    resetPhoneAccess: () => invoke("phone:reset"),
    openPhonePairing: () => invoke("phone:open-pairing"),
    listDevices: () => invoke("devices:list"),
    removeDevice: (key) => invoke("devices:remove", key),
    acknowledgeDevices: (keys) => invoke("devices:acknowledge", keys),
    listPendingDevices: () => invoke("devices:pending"),
    allowDevice: (key) => invoke("devices:allow", key),
    denyDevice: (key) => invoke("devices:deny", key),
    onDevicesPending: (callback) => listen("devices:pending", callback),
    onPhoneStatus: (callback) => listen("phone:status", callback),
    listAccounts: (refresh = false) => invoke("accounts:list", refresh),
    accountAction: (action, provider, value) => invoke(`accounts:${action}`, provider, value),
    onAccountsChanged: (callback) => listen("accounts:changed", () => callback()),
    onUsageChanged: (callback) => listen("usage:changed", callback),
    readUsage: (scopeKey) => invoke("usage:read", scopeKey),
    setKeepAwake: (enabled) => invoke("app:set-keep-awake", enabled),
    getCachedUsage: (scopeKey) => invoke("usage:cached", scopeKey),
    readAccountUsage: () => invoke("usage:accounts:read"),
    getCachedAccountUsage: () => invoke("usage:accounts:cached"),
    readTokenUsage: (request) => invoke("token-usage:read", request),
    onTokenUsageChanged: (callback) => listen("token-usage:changed", () => callback()),
    setNotifyWhenWaiting: (on) => invoke("settings:notify-when-waiting", on),
    setNotificationChime: (chime) => invoke("settings:notification-chime", chime),
    setNotificationSchedule: (schedule) => invoke("settings:notification-schedule", schedule),
    onPlayChime: (callback) => listen("notification:play-chime", callback),
    setWindowBackground: (background) => invoke("settings:window-background", background),
    syncNotifications: (state) => invoke("notification:state", state),
    getInbox: () => invoke("floating-inbox:snapshot"),
    setFloatingInbox: (on) => invoke("settings:floating-inbox", on),
    toggleFloatingInbox: () => invoke("floating-inbox:toggle"),
    selectInboxItem: (key) => invoke("floating-inbox:select", key),
    getSelectedInboxItem: () => invoke("floating-inbox:selected"),
    onSelectedInboxItem: (callback) => listen("floating-inbox:selection", callback),
    getFloatingInboxOpen: () => invoke("floating-inbox:is-open"),
    onFloatingInboxOpen: (callback) => listen("floating-inbox:open", callback),
    expandFloatingBar: (on, reducedMotion = false) => invoke("floating-inbox:dock-expanded", on, reducedMotion),
    closeFloatingInbox: () => invoke("floating-inbox:close"),
    resizeFloatingBar: (count) => invoke("floating-inbox:count", count),
    resizeFloatingInbox: (height, reducedMotion) => invoke("floating-inbox:height", height, reducedMotion),
    showInboxPreview: (key, y) => invoke("floating-inbox:preview", key, y),
    getInboxPreviewKey: () => invoke("floating-inbox:preview-key"),
    onInboxPreview: (callback) => listen("floating-inbox:preview", callback),
    getFloatingPlacement: () => invoke("floating-inbox:placement"),
    onFloatingPlacement: (callback) => listen("floating-inbox:placement", callback),
    beginFloatingDrag: (reducedMotion) => invoke("floating-inbox:drag-begin", reducedMotion),
    moveFloatingDrag: () => invoke("floating-inbox:drag-move"),
    endFloatingDrag: (cancel) => invoke("floating-inbox:drag-end", cancel),
    getFloatingDragOverlay: () => invoke("floating-inbox:drag-overlay"),
    onFloatingDragOverlay: (callback) => listen("floating-inbox:drag-overlay", callback),
    openInboxChat: (key) => invoke("floating-inbox:open-chat", key),
    openInboxSettings: () => invoke("floating-inbox:settings"),
    onOpenExperimental: (callback) => listen("notification:open-experimental", callback),
    notifyCompletion: (notice) => invoke("notification:completed", notice),
    onOpenChat: (callback) => listen("notification:open-chat", callback),
    onOpenPhoneSettings: (callback) => listen("notification:open-phone-settings", () => callback()),
    uploadAttachment: (request) => invoke("attachment:upload", request),
  };
}

/** @param {string} channel @param {(payload: any) => void} callback */
function listenHere(channel, callback) {
  /** @param {unknown} _event @param {any} payload */
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** @type {Map<string, Set<(payload: any) => void>>} */
const computerSubscribers = new Map();
/** @type {Set<(event: any) => void>} */
const anyComputerSubscribers = new Set();
/** @param {unknown} _event @param {any} event */
function dispatchComputerEvent(_event, event) {
  // Copies: callbacks can unsubscribe and resubscribe during dispatch.
  for (const callback of Array.from(anyComputerSubscribers)) callback(event);
  const set = computerSubscribers.get(`${event?.computerId}|${event?.channel}`);
  if (set) for (const callback of Array.from(set)) callback(event.payload);
}
/** One ipcRenderer listener serves every computer subscription (many would pass EventEmitter's MaxListeners). */
function syncComputerListener() {
  const wanted = computerSubscribers.size > 0 || anyComputerSubscribers.size > 0;
  ipcRenderer.removeListener("computers:event", dispatchComputerEvent);
  if (wanted) ipcRenderer.on("computers:event", dispatchComputerEvent);
}
/** @param {string} id @param {string} channel @param {(payload: any) => void} callback */
function listenComputer(id, channel, callback) {
  const key = `${id}|${channel}`;
  let set = computerSubscribers.get(key);
  if (!set) computerSubscribers.set(key, (set = new Set()));
  set.add(callback);
  syncComputerListener();
  return () => {
    set.delete(callback);
    if (!set.size && computerSubscribers.get(key) === set) computerSubscribers.delete(key);
    syncComputerListener();
  };
}
/** @param {(event: any) => void} callback */
function listenAnyComputer(callback) {
  anyComputerSubscribers.add(callback);
  syncComputerListener();
  return () => {
    anyComputerSubscribers.delete(callback);
    syncComputerListener();
  };
}

/** This Mac's own IPC. */
const local = makeBridge(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  listenHere,
  (channel, ...args) => ipcRenderer.send(channel, ...args),
);

/** @type {Map<string, import("../app/src/electron.d.ts").MilagreBridge>} */
const remotes = new Map();
// A message for a paired computer's Chat was typed on this one: that Chat's agent is told (packages/core/src/sent-from.cjs).
const SENDS = new Set(["chat:send", "link:send"]);
/**
 * @param {string} channel
 * @param {unknown[]} args
 * @returns {unknown[]}
 */
const sentFromHere = (channel, args) =>
  SENDS.has(channel) && args[0] && typeof args[0] === "object" ? [{ ...args[0], sentFrom: "computer" }, ...args.slice(1)] : args;
/**
 * A paired computer's bridge (spec "Routing"): the same calls, carried by main to that computer (computers-ipc.cjs), and
 * its events, tagged with it. This Mac's own actions refuse with NOT_REMOTE.
 * @param {string} computerId
 */
function remote(computerId) {
  const id = String(computerId);
  if (id === "local") return local;
  let bridge = remotes.get(id);
  if (!bridge) {
    bridge = makeBridge(
      (channel, ...args) =>
        isLocalOnly(channel) ? Promise.reject(new Error(NOT_REMOTE)) : ipcRenderer.invoke("computers:invoke", id, channel, sentFromHere(channel, args)),
      (channel, callback) => listenComputer(id, channel, callback),
      () => {},
    );
    remotes.set(id, bridge);
  }
  return bridge;
}

// A forgotten computer's bridge goes with it, so pairing it again starts clean.
ipcRenderer.on("computers:changed", (_event, snapshot) => {
  const known = new Set((snapshot?.computers ?? []).map((/** @type {{ id: string }} */ computer) => computer.id));
  for (const id of remotes.keys()) if (!known.has(id)) remotes.delete(id);
});

/** @type {Window["milagre"]} */
const bridge = {
  ...local,
  on: remote,
  computers: {
    list: () => ipcRenderer.invoke("computers:list"),
    preview: (link) => ipcRenderer.invoke("computers:preview", link),
    add: (link, options) => ipcRenderer.invoke("computers:add", link, options),
    cancelAdd: () => ipcRenderer.invoke("computers:cancel-add"),
    rename: (id, name) => ipcRenderer.invoke("computers:rename", id, name),
    remove: (id) => ipcRenderer.invoke("computers:remove", id),
    setEnabled: (on) => ipcRenderer.invoke("computers:set-enabled", on),
    invoke: (id, method, args) => ipcRenderer.invoke("computers:invoke", id, method, args),
    remember: (id, entry) => ipcRenderer.invoke("computers:remember", id, entry),
    recall: (id, entry) => ipcRenderer.invoke("computers:recall", id, entry),
    note: (id, line) => ipcRenderer.invoke("computers:note", id, line),
  },
  onComputersChanged: (callback) => listenHere("computers:changed", callback),
  onComputerAddPending: (callback) => listenHere("computers:pending", () => callback()),
  onComputerEvent: (callback) => listenAnyComputer(callback),
  // Dictation records and transcribes on this computer, whichever computer the Chat is on (dictation.cjs).
  dictation: {
    status: () => ipcRenderer.invoke("app:dictation-status"),
    download: (id) => ipcRenderer.invoke("app:dictation-download", id),
    cancel: (id) => ipcRenderer.invoke("app:dictation-cancel", id),
    remove: (id) => ipcRenderer.invoke("app:dictation-remove", id),
    prepare: (id) => ipcRenderer.invoke("app:dictation-prepare", id),
    transcribe: (request) => ipcRenderer.invoke("app:dictation-transcribe", request),
    onModel: (callback) => listenHere("app:dictation-model", callback),
    openSettings: () => ipcRenderer.invoke("app:dictation-open-settings"),
  },
};
// Window decoration belongs to this window, even when its Chat uses a paired computer's bridge.
const controls = process.argv.find((argument) => argument.startsWith("--milagre-window-controls="))?.split("=")[1];
contextBridge.exposeInMainWorld("milagreWindowChrome", { controls: controls === "leading" || controls === "overlay" ? controls : "external" });
contextBridge.exposeInMainWorld("milagre", bridge);

// The Browser panel's pages live in this window, whichever computer is selected: a page asking for a new window, and
// ⌘L, ⌘R and ⌘W pressed inside one (browser-guests.cjs).
contextBridge.exposeInMainWorld("milagreBrowserPanel", {
  partition: "persist:milagre-browser",
  onOpenTab: (callback) => listenHere("browser-panel:open-tab", callback),
  onKey: (callback) => listenHere("browser-panel:key", callback),
  onViewed: (callback) => listenHere("browser-panel:viewed", callback),
  onOpenUrl: (callback) => listenHere("browser-panel:open-url", callback),
  /** @param {{ contentsId: number; chatKey: string }[]} pages */
  setPages: (pages) => ipcRenderer.invoke("browser-panel:pages", pages),
  /** @param {number} contentsId @param {{ x: number; y: number; width: number; height: number }} rect */
  capture: (contentsId, rect) => ipcRenderer.invoke("browser-panel:capture", contentsId, rect),
  /** @param {string} chatKey */
  remotePartition: (chatKey) => ipcRenderer.invoke("browser-panel:remote-partition", chatKey),
  /** @param {string} computerId */
  clearSignIns: (computerId) => ipcRenderer.invoke("browser-panel:clear-sign-ins", computerId),
});

// Kept local to this window, independent of the selected computer or agent host.
contextBridge.exposeInMainWorld("milagrePreferences", {
  get: (key) => ipcRenderer.sendSync("preferences:storage", "get", key),
  set: (key, value) => ipcRenderer.sendSync("preferences:storage", "set", key, value),
  onChanged: (listener) => {
    ipcRenderer.on("preferences:changed", (_event, change) => listener(change));
  },
});
