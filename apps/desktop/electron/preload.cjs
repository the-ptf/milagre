// @ts-check
/** @typedef {typeof import("../app/src/electron.d.ts")} BridgeTypes */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// What only this Mac's own window does: its editors and Finder, the folder dialog, the clipboard and image menus,
// notifications, updates, its own host, devices and accounts. A paired computer's bridge refuses them before any IPC,
// and main refuses them again (computer-routing.cjs keeps the same lists; computer-routing.test.cjs compares them).
const NOT_REMOTE = "Not available on a remote computer";
const LOCAL_ONLY = [
  "project:open",
  "project:reveal",
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
  "agent:update-cli",
  "linear:connect",
  "linear:cancel",
  "linear:disconnect",
];
const LOCAL_ONLY_PREFIXES = [
  "app:",
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
  "usage:",
];
/** @param {string} channel */
const isLocalOnly = (channel) => LOCAL_ONLY.includes(channel) || LOCAL_ONLY_PREFIXES.some((prefix) => channel.startsWith(prefix));

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
      offer: (request) => invoke("simulator:offer", request),
      status: (request) => invoke("simulator:status", request),
      control: (request) => invoke("simulator:control", request),
      input: (request) => invoke("simulator:input", request),
      repair: (request) => invoke("simulator:repair", request),
      close: (request) => invoke("simulator:close", request),
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
    artifacts: {
      get: (request) => invoke("artifact:get", request),
      list: (request) => invoke("artifact:list", request),
      addComments: (request) => invoke("artifact:add-comments", request),
      comments: (request) => invoke("artifact:comments", request),
    },
    getRuntimeConnection: () => invoke("runtime:connection"),
    restartHost: () => invoke("runtime:restart-host"),
    onRuntimeConnection: (callback) => listen("runtime:connection", callback),
    onRuntimeSnapshot: (callback) => listen("runtime:snapshot", callback),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    readAttachment: (file) => invoke("attachment:preview", file),
    searchProjectFiles: (root, query) => invoke("project:files", root, query),
    listSkills: (projectPath) => invoke("skills:list", projectPath),
    readSkill: (projectPath, file) => invoke("skills:read", projectPath, file),
    openSkill: (request) => invoke("skills:open", request),
    revealSkill: (projectPath, file) => invoke("skills:reveal", projectPath, file),
    listBranches: (projectPath) => invoke("project:branches", projectPath),
    getProjectImage: (projectPath) => invoke("project:image", projectPath),
    setProjectIcon: (projectPath, icon) => invoke("project:set-icon", projectPath, icon),
    getAppVersion: () => invoke("app:version"),
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
    cancelLinearSignIn: () => invoke("linear:cancel"),
    disconnectLinear: (workspace) => invoke("linear:disconnect", { workspace }),
    readLinearEnabled: () => invoke("linear:enabled:read"),
    saveLinearEnabled: (value) => invoke("linear:enabled:save", value),
    saveLinearMoveToStarted: (value) => invoke("linear:move-to-started:save", value),
    mcp: {
      accounts: () => invoke("mcp:accounts"),
      check: (provider, accountId) => invoke("mcp:check", provider, accountId),
    },
    onLinearStatusChanged: (callback) => listen("linear:status-changed", callback),
    onLinearEnabledChanged: (callback) => listen("linear:enabled-changed", callback),
    listLinearIssues: (query, options) => invoke("linear:issues", { query, fresh: options?.fresh === true, workspace: options?.workspace }),
    readWorktreeLinearIssues: (projectPath) => invoke("linear:worktree-issues", projectPath),
    onWorktreeRenamed: (callback) => listen("worktree:renamed", callback),
    refreshDiffs: (projectPath, worktreeIds) => invoke("worktree:refresh-diffs", projectPath, worktreeIds),
    readPullRequest: (worktreePath) => invoke("worktree:pull-request", worktreePath),
    readPullRequests: (worktreePath, refs) => invoke("worktree:pull-requests", worktreePath, refs),
    revealInFolder: (folder) => invoke("project:reveal", folder),
    copyImage: (file) => invoke("image:copy", file),
    saveImage: (file, name) => invoke("image:save", file, name),
    showImageMenu: (file, name) => invoke("image:menu", file, name),
    git: {
      changes: (request) => invoke("git:changes", request),
      diffFiles: (request) => invoke("git:diff-files", request),
      diffFile: (request) => invoke("git:diff-file", request),
      generate: (request) => invoke("git:generate", request),
      commit: (request) => invoke("git:commit", request),
      push: (request) => invoke("git:push", request),
      openPr: (request) => invoke("git:open-pr", request),
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
    setProjectHidden: (projectPath, hidden) => invoke("project:set-hidden", projectPath, hidden),
    readProject: (projectPath) => invoke("project:read", projectPath),
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
    stopNegotiation: (id) => invoke("linked:stop-negotiation", id),
    onAppShortcut: (callback) => listen("app:shortcut", callback),
    onLinkedWork: (callback) => listen("linked:changed", callback),
    switchProject: (projectPath) => invoke("project:switch", projectPath),
    forgetProject: (projectPath) => invoke("project:forget", projectPath),
    retryQuit: () => invoke("app:retry-quit"),
    onQuitFailed: (callback) => listen("app:quit-failed", callback),
    onProjectState: (callback) => listen("project:state", callback),
    sendMessage: (request) => invoke("chat:send", request),
    resumeChat: (projectPath, sessionId) => invoke("chat:resume", projectPath, sessionId),
    patchChat: (projectPath, sessionId, patch) => invoke("chat:patch", projectPath, sessionId, patch),
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
    listAccountScopes: () => invoke("accounts:scopes"),
    getProjectAccounts: (scopeKey, refresh) => invoke("accounts:scope", scopeKey, refresh),
    assignProjectAccount: (scopeKey, provider, accountId) => invoke("accounts:assign", scopeKey, provider, accountId),
    getModels: (scopeKey) => invoke("agent:models", scopeKey),
    getCliStatus: (scopeKey) => invoke("agent:cli-status", scopeKey),
    updateCli: (provider) => invoke("agent:update-cli", provider),
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
    readUsage: (scopeKey) => invoke("usage:read", scopeKey),
    setKeepAwake: (enabled) => invoke("app:set-keep-awake", enabled),
    getCachedUsage: (scopeKey) => invoke("usage:cached", scopeKey),
    setNotifyWhenWaiting: (on) => invoke("settings:notify-when-waiting", on),
    setWindowTranslucent: (on, theme, background) => invoke("settings:window-translucent", { on, theme, background }),
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
  for (const callback of [...anyComputerSubscribers]) callback(event);
  const set = computerSubscribers.get(`${event?.computerId}|${event?.channel}`);
  if (set) for (const callback of [...set]) callback(event.payload);
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
      (channel, ...args) => (isLocalOnly(channel) ? Promise.reject(new Error(NOT_REMOTE)) : ipcRenderer.invoke("computers:invoke", id, channel, args)),
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
  for (const id of [...remotes.keys()]) if (!known.has(id)) remotes.delete(id);
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
  },
  onComputersChanged: (callback) => listenHere("computers:changed", callback),
  onComputerAddPending: (callback) => listenHere("computers:pending", () => callback()),
  onComputerEvent: (callback) => listenAnyComputer(callback),
};
contextBridge.exposeInMainWorld("milagre", bridge);
