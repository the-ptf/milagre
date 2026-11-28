// @ts-check
const { createAgentCursor } = require("./agent-cursor.cjs");
const { createQuitHandler } = require("./quit.cjs");
const { createEditorOpener } = require("./editor-open.cjs");
const { createHostMethods } = require("./host-methods.cjs");
const { createMainWindow } = require("./main-window.cjs");
const { registerQuitFlow } = require("./quit-flow.cjs");
const {
  app,
  clipboard,
  ClipboardItem,
  ipcMain: electronIpcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  safeStorage,
  powerMonitor,
  net,
  screen,
  session: electronSession,
} = require("electron");
const path = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const decideSimpleIntro = require("./intro-motion.cjs").createIntroMotionDecision({ app, platform: process.platform });

let openedProjectsBefore;
function hasOpenedProjectsBefore() {
  if (openedProjectsBefore === undefined) {
    try {
      const list = JSON.parse(readFileSync(path.join(app.getPath("userData"), "recent-projects.json"), "utf8"));
      openedProjectsBefore = Array.isArray(list) && list.length > 0;
    } catch {
      openedProjectsBefore = false;
    }
  }
  return openedProjectsBefore;
}
const { pathToFileURL } = require("node:url");
const { connectDesktopRuntime } = require("./daemon-runtime.cjs");
const { ensureDaemon } = require("@milagre/daemon/bootstrap");
const { loadLoginEnvironment } = require("@milagre/core/agents/environment");
const { detectEditors, openInEditor, requireWorktreeRoot } = require("@milagre/core/editors");
const { copyImage, saveImage } = require("./generated-images.cjs");
const { createDictation } = require("./dictation.cjs");
const { handleReveal } = require("./reveal.cjs");
const { applyWindowBackground, OPAQUE_BACKGROUND } = require("./window-background.cjs");
const { guardNavigation } = require("./links.cjs");
const { forwardAppShortcuts, setForwardedRules } = require("./app-shortcuts.cjs");
const { BROWSER_PARTITION, captureBrowserPage, hardenBrowserGuests, hardenBrowserSession } = require("./browser-guests.cjs");
const { clearSignIns, computerPartition, createRemoteBrowserSessions, removeChatPartitions } = require("./browser-remote-sessions.cjs");
const { createBrowserPanelPages } = require("./browser-panel-pages.cjs");
const { createPasskeys, passkeysSupported } = require("./passkeys.cjs");
const { routeBrowserPanelClose } = require("./browser-panel-close.cjs");
const { windowChrome } = require("./window-chrome.cjs");
const { AttentionNotifier } = require("./notifications.cjs");
const { createDeviceNotices } = require("./device-notices.cjs");
const { createMediaHandler } = require("./media.cjs");
const { createComputersLane } = require("./computers-lane.cjs");
const { createBackgroundMode, isBackground } = require("./background-mode.cjs");
const electron = require("electron");
const background = createBackgroundMode({
  enabled: isBackground(process.env),
  platform: process.platform,
  app,
  BrowserWindow: electron.BrowserWindow,
  shell: electron.shell,
  dialog: electron.dialog,
});
const { BrowserWindow, shell, dialog } = background;
const notificationsSupported = () => background.notifications(Notification.isSupported());
protocol.registerSchemesAsPrivileged([
  { scheme: "milagre-artifact", privileges: { standard: true, secure: true, stream: true } },
  { scheme: "milagre-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
/** Turns on passkeys for the Browser panel's own session; returns how to harden a remote Chat's session. */
function startPasskeys() {
  const passkeys = createPasskeys({
    app,
    dialog,
    supported: passkeysSupported({ platform: process.platform, resourcesPath: process.resourcesPath, exists: existsSync }),
    windowForFrame: (frame) => {
      const page = frame && electron.webContents.fromFrame(frame);
      const owner = page?.hostWebContents ?? page;
      return (owner && BrowserWindow.fromWebContents(owner)) || BrowserWindow.getFocusedWindow();
    },
  });
  passkeys.configure();
  passkeys.attach(electronSession.fromPartition(BROWSER_PARTITION));
  /** @param {Electron.Session} session */
  return (session) => {
    hardenBrowserSession(session);
    passkeys.attach(session);
  };
}
async function startDesktop() {
  const hostOptions = {
    dataDir: app.getPath("userData"),
    version: app.getVersion(),
    cwd: process.cwd(),
    worktreeRoot: !app.isPackaged ? process.env.MILAGRE_WORKTREE_ROOT : undefined,
    chatsHome: !app.isPackaged ? process.env.MILAGRE_CHATS_HOME : undefined,
  };
  /** @type {ReturnType<typeof ensureDaemon> | null} */
  let startingHost = ensureDaemon(hostOptions);
  startingHost.catch(() => {});
  /** @type {Electron.BrowserWindow | null} */
  let mainWindow = null;
  let agentCursor = null;
  let runtime;
  let computerUnlock;
  /** @type {ReturnType<typeof createComputersLane> | null} */
  let computersLane = null;
  const nativeCommands = require("./desktop-commands.cjs").createDesktopCommandAdapter({
    ipcMain: electronIpcMain,
    runtime: () => runtime,
    event: () => {
      const contents = () => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Open a Milagre desktop window for this command.");
        return mainWindow.webContents;
      };
      return {
        get sender() {
          return contents();
        },
        get senderFrame() {
          return contents().mainFrame;
        },
      };
    },
  });
  const ipcMain = nativeCommands.ipcMain;
  const indexFile = path.join(__dirname, "../dist/index.html");
  const appUrl = app.isPackaged ? pathToFileURL(indexFile).href : process.env.MILAGRE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const { createFloatingInbox } = require("./floating-inbox.cjs");
  background.start();
  await app.whenReady();
  const preferences = require("./preferences.cjs").createPreferencesStore(path.join(app.getPath("userData"), "preferences.json"));
  const hiddenChats = require("./hidden-chats.cjs").createHiddenChats(preferences);
  /** @type {(() => void) | null} */
  let hiddenChanged = null;
  electronIpcMain.on("preferences:storage", (event, operation, key, value) => {
    try {
      const url = event.senderFrame?.url;
      if (
        event.senderFrame !== event.sender.mainFrame ||
        !url ||
        new URL(url).origin !== new URL(appUrl).origin ||
        (new URL(appUrl).protocol === "file:" && new URL(url).pathname !== new URL(appUrl).pathname)
      ) {
        throw new Error("Only the app can access preferences");
      }
      if (typeof key !== "string" || !/^milagre[.:-]/.test(key)) throw new Error("Invalid preference key");
      if (operation === "get") event.returnValue = { value: preferences.get(key) };
      else if (operation === "set") {
        const previous = preferences.get(key);
        preferences.set(key, value);
        if (previous !== value) {
          if (hiddenChats.affects(key)) hiddenChanged?.();
          for (const window of BrowserWindow.getAllWindows()) {
            if (window.webContents !== event.sender) window.webContents.send("preferences:changed", { key, value });
          }
        }
        event.returnValue = {};
      } else throw new Error("Invalid preference operation");
    } catch (error) {
      event.returnValue = { error: error instanceof Error ? error.message : String(error) };
    }
  });
  const floating = createFloatingInbox({
    BrowserWindow,
    screen,
    positionFile: path.join(app.getPath("userData"), "floating-inbox-position.json"),
    preload: path.join(__dirname, "preload.cjs"),
    load: (window, view) => {
      guardNavigation(window.webContents, { appUrl, openExternal: (url) => shell.openExternal(url).catch(() => {}) });
      const url = new URL(appUrl);
      url.searchParams.set("floating-inbox", view);
      void window.loadURL(url.href);
    },
  });
  ipcMain.handle("browser-panel:capture", (event, contentsId, rect) => captureBrowserPage(event.sender, contentsId, rect));
  ipcMain.handle("settings:floating-inbox", (_event, on) => floating.setEnabled(on === true));
  ipcMain.handle("floating-inbox:toggle", () => floating.toggle());
  ipcMain.handle("floating-inbox:select", (_event, key) => floating.openItem(key));
  ipcMain.handle("floating-inbox:selected", () => floating.selectedKey());
  ipcMain.handle("floating-inbox:is-open", () => floating.isOpen());
  ipcMain.handle("floating-inbox:dock-expanded", (_event, on, reducedMotion) => floating.setDockExpanded(on === true, reducedMotion === true));
  ipcMain.handle("floating-inbox:close", () => floating.close());
  ipcMain.handle("floating-inbox:preview", (_event, key, y) => floating.showPreview(key, y));
  ipcMain.handle("floating-inbox:preview-key", () => floating.previewKey());
  ipcMain.handle("floating-inbox:placement", () => floating.placement());
  ipcMain.handle("floating-inbox:drag-begin", (_event, reducedMotion) => floating.beginDrag(reducedMotion === true));
  ipcMain.handle("floating-inbox:drag-move", () => floating.moveDrag());
  ipcMain.handle("floating-inbox:drag-end", (_event, cancel) => floating.endDrag(cancel === true));
  ipcMain.handle("floating-inbox:drag-overlay", (event) => floating.overlayState(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle("floating-inbox:count", (_event, count) => floating.setCount(Math.max(0, Math.min(12, Number(count) || 0))));
  ipcMain.handle("floating-inbox:height", (_event, height, reducedMotion) => floating.setInboxHeight(height, reducedMotion === true));
  ipcMain.handle("floating-inbox:open-chat", (_event, key) => {
    floating.close();
    if (typeof key === "string") openChatFromNotification(key);
  });
  ipcMain.handle("floating-inbox:settings", () => {
    floating.close();
    openFromNotification("notification:open-experimental");
  });
  const { computerOfKey, LOCAL_COMPUTER, qualifyKey } = require("@milagre/shared/chat-scopes");
  const previews = require("./artifact-preview.cjs").createArtifactPreviews({
    readAsset: (chatId, name, offset, length) => {
      const request = { chatId, name, offset, length };
      const computer = computerOfKey(chatId);
      if (computer === LOCAL_COMPUTER) return runtime.invoke("artifact:asset", [request]);
      if (!computersLane) throw new Error("This computer is not reachable.");
      return computersLane.invoke("computers:invoke", [computer, "artifact:asset", [request]]);
    },
  });
  const previewOwners = new Set();
  ipcMain.handle("artifact-preview:register", (event, html, source) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("Only the app can create a preview.");
    const owner = event.sender.id;
    if (!previewOwners.has(owner)) {
      previewOwners.add(owner);
      event.sender.once("destroyed", () => {
        previews.clear(owner);
        previewOwners.delete(owner);
      });
      event.sender.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) previews.clear(owner);
      });
    }
    return previews.register(owner, html, source);
  });
  ipcMain.handle("artifact-preview:release", (event, url) => {
    if (event.senderFrame === event.sender.mainFrame) previews.release(event.sender.id, url);
  });
  protocol.handle("milagre-artifact", (request) => previews.handle(request));
  const { appIconFile, installAppIcon } = require("./app-icon.cjs");
  const publicDir = path.join(__dirname, "../app/public");
  const appIcons = installAppIcon({
    app,
    ipcMain,
    nativeImage,
    publicDir,
    windows: () => BrowserWindow.getAllWindows(),
    setDockIcon: (image) => background.setDockIcon(image),
  });
  const appIcon = appIcons.store;
  const { createReleaseChannelStore, prepareUpdater } = require("./release-channel.cjs");
  const { createAppUpdates, createAutoInstall, deferUpdater, stageNativeUpdate, watchAppUpdates } = require("./app-updates.cjs");
  const updateLog = require("./update-log.cjs").createUpdateLog(path.join(app.getPath("userData"), "updates.log"));
  const updater = deferUpdater(() => {
    const loaded = require("electron-updater").autoUpdater;
    loaded.logger = updateLog.logger;
    return loaded;
  });
  const releaseChannel = createReleaseChannelStore({ file: path.join(app.getPath("userData"), "release-channel.json") });
  const updates = createAppUpdates({
    updater,
    enabled: app.isPackaged,
    prepare: () => prepareUpdater(updater.loaded(), releaseChannel.get()),
    stage: () => (process.platform === "darwin" ? stageNativeUpdate(updater.loaded(), require("electron").autoUpdater) : Promise.resolve()),
    stopHost: () => runtime.close({ stopHost: true }),
    resumeHost: () => runtime.reopen(),
    prepareQuit: () => prepareQuit(),
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    log: updateLog.line,
    publish: (state) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("update:state", state);
    },
  });
  ipcMain.handle("update:state", () => updates.get());
  ipcMain.handle("update:check", () => updates.check(true));
  const releaseNotes = require("./update-release-notes.cjs").createReleaseNotes();
  ipcMain.handle("update:release-notes", (_event, version) => releaseNotes(version));
  ipcMain.handle("update:channel", () => releaseChannel.get());
  ipcMain.handle("update:set-channel", async (_event, channel) => {
    const next = releaseChannel.set(channel);
    if (updates.get().status === "checking") await updates.check();
    void updates.check(true);
    return next;
  });
  ipcMain.handle("update:install", () => updates.install());
  const readAutoUpdate = () =>
    void runtime
      ?.invoke("app-update:auto:read", [])
      .then((value) => updates.setAuto(value?.autoUpdate === true))
      .catch(() => updates.setAuto(false));
  const panelPages = createBrowserPanelPages({
    fromId: (id) => require("electron").webContents.fromId(id),
    publish: async (request) => {
      if (!runtime) throw new Error("No host");
      const remote = request.pages.filter((page) => computerOfKey(page.chatId) !== LOCAL_COMPUTER);
      const local = request.pages.filter((page) => computerOfKey(page.chatId) === LOCAL_COMPUTER);
      await Promise.all([
        runtime.invoke("browser:panel-pages", [local.length ? { ...request, pages: local } : { pages: [] }]),
        runtime
          .invoke("computers:browser-pages", [
            {
              port: request.port,
              prefix: request.prefix,
              pages: remote.map((page) => ({ id: page.id, chatKey: page.chatId, title: page.title, url: page.url })),
            },
          ])
          .catch((error) => console.warn("Browser pages for other computers:", error.message)),
      ]);
    },
  });
  ipcMain.handle("browser-panel:pages", (event, list) => panelPages.setPages(event.sender, list));
  const remoteBrowserSessions = createRemoteBrowserSessions({
    fromPartition: (partition) => electronSession.fromPartition(partition),
    proxyPort: async (computerId) => {
      if (!runtime) throw new Error("Milagre's host isn't connected yet.");
      return (await runtime.invoke("computers:browser-proxy", [computerId]))?.port;
    },
    harden: startPasskeys(),
  });
  ipcMain.handle("browser-panel:remote-partition", (_event, chatKey) => remoteBrowserSessions.prepare(chatKey));
  ipcMain.handle("browser-panel:clear-sign-ins", async (_event, computerId) => {
    if (typeof computerId !== "string" || !computerId) throw new Error("Expected a computer.");
    const partition = computerId === LOCAL_COMPUTER ? BROWSER_PARTITION : computerPartition(computerId);
    const guests = require("electron")
      .webContents.getAllWebContents()
      .filter((contents) => contents.getType() === "webview");
    await clearSignIns(electronSession.fromPartition(partition), guests);
    return { cleared: true };
  });
  void removeChatPartitions(app.getPath("userData")).catch((error) => console.warn("Browser sessions of single Chats:", error.message));
  const readKeybindings = () =>
    void runtime
      ?.invoke("keybindings:read", [])
      .then((state) => state?.rules && setForwardedRules(state.rules))
      .catch(() => {});
  const autoInstall = createAutoInstall(updates, {
    activity: () => runtime.invoke("app-update:activity", []),
    inputIdleSeconds: () => powerMonitor.getSystemIdleTime(),
  });

  handleReveal(ipcMain, { shell, checkRoot: async (root) => void (await checkEditorRoot(root)) });

  const copyImageFile = (file) =>
    copyImage(file, {
      createFromPath: (target) => nativeImage.createFromPath(target),
      createFromBuffer: (bytes) => nativeImage.createFromBuffer(bytes),
      writeImage: (image) => clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]),
    });
  const saveImageFile = (event, file, name) =>
    saveImage(
      file,
      {
        downloads: app.getPath("downloads"),
        showSaveDialog: (options) =>
          BrowserWindow.fromWebContents(event.sender)
            ? dialog.showSaveDialog(/** @type {Electron.BrowserWindow} */ (BrowserWindow.fromWebContents(event.sender)), options)
            : dialog.showSaveDialog(options),
      },
      name,
    );
  const dictation = createDictation({
    dataDir: app.getPath("userData"),
    onChange: (state) => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("app:dictation-model", state);
    },
  });
  ipcMain.handle("app:dictation-status", () => dictation.status());
  ipcMain.handle("app:dictation-download", (_event, id) => dictation.download(id));
  ipcMain.handle("app:dictation-cancel", (_event, id) => dictation.cancel(id));
  ipcMain.handle("app:dictation-remove", (_event, id) => dictation.remove(id));
  ipcMain.handle("app:dictation-prepare", (_event, id) => dictation.prepare(id));
  ipcMain.handle("app:dictation-transcribe", (_event, request) => dictation.transcribe(request ?? {}));
  ipcMain.handle("app:dictation-open-settings", () =>
    shell.openExternal(
      process.platform === "win32" ? "ms-settings:privacy-microphone" : "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    ),
  );
  ipcMain.handle("image:copy", (_event, file) => copyImageFile(file));
  ipcMain.handle("image:save", (event, file, name) => saveImageFile(event, file, name));
  ipcMain.handle("image:menu", (event, file, name) => {
    if (!background.menus) return;
    Menu.buildFromTemplate([
      { label: "Copy Image", click: () => void copyImageFile(file).catch(() => {}) },
      { label: "Save Image…", click: () => void saveImageFile(event, file, name).catch(() => {}) },
    ]).popup({ window: BrowserWindow.fromWebContents(event.sender) ?? undefined });
  });

  /** @type {Promise<import("@milagre/core/editors").DetectedEditor[]> | null} */
  let editorsFound = null;
  const editors = () =>
    (editorsFound ??= environmentReady
      .then(() => detectEditors())
      .catch((error) => {
        editorsFound = null;
        throw error;
      }));
  ipcMain.handle("editor:list", async () => (await editors()).map(({ id, name }) => ({ id, name })));
  async function checkEditorRoot(root) {
    try {
      return /** @type {string[]} */ (await runtime.invoke("link:workspace-roots", [root]));
    } catch {
      return requireWorktreeRoot(root).catch(() => /** @type {Promise<string[]>} */ (runtime.invoke("project:plain-root", [root])));
    }
  }
  const openEditor = createEditorOpener({ editors, open: background.editorOpener(openInEditor), checkRoot: checkEditorRoot });
  ipcMain.handle("editor:open", (_event, request) => openEditor(request));
  async function checkSkillFile(projectPath, file) {
    const { skills, shadowed = [] } = /** @type {import("@milagre/shared/model").SkillCatalog} */ (await runtime.invoke("skills:list", [projectPath]));
    if (typeof file !== "string" || ![...skills, ...shadowed].some((skill) => skill.path === file))
      throw new Error("That skill is no longer there. Reload the list.");
  }
  const openSkillFile = createEditorOpener({ editors, open: background.editorOpener(openInEditor), checkRoot: async () => {} });
  ipcMain.handle("skills:open", async (_event, { projectPath, file, editor } = {}) => {
    await checkSkillFile(projectPath, file);
    return openSkillFile({ root: path.dirname(file), path: path.basename(file), editor });
  });
  ipcMain.handle("skills:reveal", async (_event, projectPath, file) => {
    await checkSkillFile(projectPath, file);
    shell.showItemInFolder(file);
  });

  function openFromNotification(channel, ...args) {
    const window = mainWindow;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    background.focusApp();
    window.focus();
    window.webContents.send(channel, ...args);
  }
  const openChatFromNotification = (chatId) => openFromNotification("notification:open-chat", chatId);

  const notifier = new AttentionNotifier({
    createNotification: ({ title, subtitle, body, silent }) =>
      new Notification({ title, body, ...(subtitle ? { subtitle } : {}), ...(silent ? { silent } : {}), ...appIcons.notificationOptions() }),
    isAppFocused: () => Boolean(mainWindow?.isFocused()),
    canPlayChime: () => Boolean(mainWindow && !mainWindow.isDestroyed()),
    playChime: (chime) => mainWindow?.webContents.send("notification:play-chime", chime),
    openChat: openChatFromNotification,
    openPhoneSettings: () => openFromNotification("notification:open-phone-settings"),
    setBadge: (value) => background.setBadge(value),
    isHidden: (chatId) => hiddenChats.isHidden(chatId),
  });
  hiddenChanged = () => notifier.hiddenChanged();
  const readHiddenProjects = () =>
    runtime
      ?.invoke("project:recent", [])
      .then((list) => {
        if (!Array.isArray(list)) return;
        const hidden = list.filter((project) => project?.hidden === true && typeof project.path === "string").map((project) => project.path);
        if (hiddenChats.setReported(hidden)) notifier.hiddenChanged();
      })
      .catch((error) => console.warn("Hidden Projects:", error.message));

  let notifyWhenWaiting = true;
  ipcMain.handle("settings:notify-when-waiting", (_event, on) => {
    notifyWhenWaiting = on === true;
  });

  ipcMain.handle("settings:notification-chime", (_event, chime) => notifier.setChime(chime));
  ipcMain.handle("settings:notification-schedule", (_event, schedule) => notifier.setSchedule(schedule));

  ipcMain.handle("notification:state", (_event, state) => {
    if (state && Array.isArray(state.hidden) && hiddenChats.setReported(state.hidden)) notifier.hiddenChanged();
    notifier.sync(state);
  });
  ipcMain.handle("notification:completed", (_event, notice) => (notificationsSupported() ? notifier.notifyCompletion(notice) : false));

  ipcMain.handle("settings:window-background", (event, color) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) applyWindowBackground(window, color);
  });

  let connectionState = { connected: true };
  ipcMain.handle("runtime:connection", () => connectionState);
  const deviceNotices = createDeviceNotices({
    methods: () => (runtime && notificationsSupported() ? runtime.hostMethods() : null),
    invoke: (method, args) => runtime.invoke(method, args),
    notifyPhones: (phones, options) => notifier.notifyPhonesPaired(phones, options),
    notifyDevice: (kind) => notifier.notifyDevicePaired(kind),
  });
  const { createLinearSignInWindow } = require("./linear-sign-in-window.cjs");
  const linearSignIn = createLinearSignInWindow({ BrowserWindow, shell, cancel: () => void runtime?.invoke("linear:cancel", []).catch(() => {}) });
  const linearSignInState = { requested: false, attempt: 0 };
  const { getWindowState, manageWindowState } = require("./window-state.cjs");
  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
  });
  /** @type {() => void} */
  let hostConnected = () => {};
  const hostReady = new Promise((resolve) => {
    hostConnected = () => resolve(undefined);
  });
  electronIpcMain.handle("app:host-ready", () => hostReady);
  protocol.handle(
    "milagre-media",
    createMediaHandler((url, options) => net.fetch(url, options)),
  );
  app.setName("Milagre");
  const simpleIntro = await decideSimpleIntro(hasOpenedProjectsBefore());
  app.on("activate", () => {
    if (floating.owns(BrowserWindow.getFocusedWindow())) return;
    const window = mainWindow;
    if (window) window.show();
    else createWindow();
  });
  createWindow();
  if (process.platform === "darwin" && app.dock) appIcons.show();
  try {
    runtime = await connectDesktopRuntime({
      ...hostOptions,
      requiredCapabilities: ["computer-management-v1"],
      outdatedMessage: "Restart Milagre's background host to enable computer management.",
      startHost: (options) => {
        const started = startingHost;
        startingHost = null;
        return started ?? ensureDaemon(options);
      },
      emit(channel, payload) {
        if (channel === "desktop:request") {
          void nativeCommands.receive(payload);
          return;
        }
        if (channel === "computers:event") {
          if (payload.channel === "agent:event") notifier.observe(payload.payload.chatId, payload.payload.event);
          if (payload.channel === "notification:waiting" && notifyWhenWaiting && notificationsSupported()) notifier.notify(payload.payload);
        }
        routeBrowserPanelClose(channel, payload, {
          closePage: (chatKey, targetId) => panelPages.closePage(chatKey, targetId),
          closeAll: (chatKey) => mainWindow?.webContents.send("browser-panel:close-chat-pages", { chatKey }),
          qualifyKey,
        });
        if (channel === "computers:forgotten") notifier.forgetComputer(payload.computerId);
        if (channel === "agent:event") notifier.observe(payload.chatId, payload.event);
        if (channel === "notification:waiting" && notifyWhenWaiting && notificationsSupported()) notifier.notify(payload);
        if (channel === "phone:paired") void deviceNotices.paired(payload);
        if (channel === "app-update:auto") updates.setAuto(payload?.autoUpdate === true);
        if (channel === "keybindings:changed" && payload?.rules) setForwardedRules(payload.rules);
        if (channel === "computer-use:cursor" && payload && typeof payload === "object") {
          agentCursor ??= createAgentCursor({ BrowserWindow, screen });
          if (payload.hide) agentCursor.hide();
          else agentCursor.show({ bounds: payload.bounds ?? null, label: typeof payload.label === "string" ? payload.label : "" });
        }
        if (channel === "browser-panel:open" && typeof payload?.chatId === "string" && typeof payload?.url === "string" && /^https?:\/\//i.test(payload.url))
          mainWindow?.webContents.send("browser-panel:open-url", { chatKey: payload.chatId, url: payload.url });
        if (channel === "devices:pending" && notificationsSupported()) notifier.notifyComputerWaiting(payload?.requests);
        if (channel === "runtime:connection") {
          connectionState = payload;
          if (payload.connected && runtime) {
            computersLane?.reset();
            registerHostMethods();
            nativeCommands.publish();
            readAutoUpdate();
            readKeybindings();
            panelPages.republish();
            void remoteBrowserSessions.refresh();
            void computerUnlock?.prepare().catch((error) => console.warn("Computer credentials:", error.message));
            void deviceNotices.connected();
            void readHiddenProjects();
          }
        }
        if (channel === "linear:sign-in-window") {
          if (linearSignInState.requested) linearSignIn.open(payload?.url);
          return;
        }
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
        }
      },
    });
  } catch (error) {
    console.error("Milagre cannot open its saved state:", error);
    void app.whenReady().then(() => {
      dialog.showErrorBox("Milagre cannot open its saved state", error instanceof Error ? error.message : String(error));
      quitting = true;
      app.quit();
    });
    return;
  }
  const environmentReady = loadLoginEnvironment({ npmBin: async () => null });
  const lane = createComputersLane({
    dataDir: app.getPath("userData"),
    available: () => connectionState.connected === true,
    fallback: (method, args) => runtime.invoke(method, args),
  });
  computersLane = lane;
  /** @param {string} method @param {unknown[]} args */
  const invokeHost = (method, args) => (lane.handles(method) ? lane.invoke(method, args) : runtime.invoke(method, args));
  const registered = new Set(["app:version"]);
  const { register: registerHostMethods } = createHostMethods({
    runtime,
    ipcMain: electronIpcMain,
    invokeHost,
    registered,
    computerUnlock: () => computerUnlock,
    linearSignIn,
    linearSignInState,
    background,
    BrowserWindow,
  });
  registerHostMethods();
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:open-keybindings-file", async () => {
    const state = await runtime.invoke("keybindings:read", []);
    const failure = await shell.openPath(state.path);
    if (failure) throw new Error(failure);
  });

  computerUnlock = require("./computer-unlock.cjs").createComputerUnlock({
    dataDir: app.getPath("userData"),
    safeStorage,
    invoke: (method, args) => runtime.invoke(method, args),
  });
  void computerUnlock.prepare().catch((error) => console.warn("Computer credentials:", error.message));
  ipcMain.handle("floating-inbox:snapshot", async () => {
    const listed = (computerId) => (item) => !hiddenChats.isHidden(qualifyKey(computerId, item.key));
    const local = await runtime.invoke("chat:inbox", []);
    const remote = await Promise.all(
      (await runtime.invoke("computers:list")).computers
        .filter((computer) => computer.state === "online")
        .map(async (computer) => {
          try {
            const snapshot = await lane.invoke("computers:invoke", [computer.id, "chat:inbox", []]);
            const label = (item) => ({ ...item, computer: computer.name });
            const shown = listed(computer.id);
            return { agents: snapshot.agents.filter(shown).map(label), items: snapshot.items.filter(shown).map(label) };
          } catch {
            return { agents: [], items: [] };
          }
        }),
    );
    const here = listed(LOCAL_COMPUTER);
    return {
      agents: [...local.agents.filter(here), ...remote.flatMap((value) => value.agents)],
      items: [...local.items.filter(here), ...remote.flatMap((value) => value.items)],
    };
  });
  ipcMain.handle("runtime:restart-host", async () => {
    await runtime.restartHost();
    registerHostMethods();
  });
  ipcMain.handle("project:open", async () => {
    const result = await dialog.showOpenDialog({ title: "Open project", properties: ["openDirectory", "createDirectory"] });
    return result.canceled || !result.filePaths[0] ? null : runtime.openProject(result.filePaths[0]);
  });
  ipcMain.handle("project:choose-folder", async (_event, title) => {
    const result = await dialog.showOpenDialog({
      title: typeof title === "string" && title ? title.slice(0, 80) : "Clone into",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  });
  ipcMain.handle("project:open-at", (_event, folder) => runtime.openProject(String(folder)));
  function createWindow() {
    createMainWindow({
      app,
      BrowserWindow,
      shell,
      electronSession,
      electronIpcMain,
      getWindowState,
      manageWindowState,
      windowChrome,
      appIconFile,
      publicDir,
      appIcon,
      OPAQUE_BACKGROUND,
      hasOpenedProjectsBefore,
      simpleIntro,
      floating,
      guardNavigation,
      appUrl,
      hardenBrowserGuests,
      BROWSER_PARTITION,
      remoteBrowserSessions,
      forwardAppShortcuts,
      indexFile,
      mainWindow: () => mainWindow,
      setMainWindow: (window) => {
        mainWindow = window;
      },
      isQuitting: () => quitting,
      confirmQuit: (window) => confirmQuit(window),
    });
  }

  app.whenReady().then(async () => {
    hostConnected();
    void runtime.resumeRecentProjects().catch((error) => console.warn(error.message));
    void deviceNotices.connected();
    void readHiddenProjects();
    if (mainWindow?.isFocused()) void runtime.setFocused(true).catch(() => {});
    app.on("browser-window-focus", (_event, window) => {
      if (floating.owns(window)) return;
      void runtime.setFocused(true).catch(() => {});
    });
    app.on("browser-window-blur", (_event, window) => {
      if (floating.owns(window)) return;
      void runtime.setFocused(false).catch(() => {});
    });
    readAutoUpdate();
    readKeybindings();
    if (app.isPackaged) watchAppUpdates(updates, { app, powerMonitor, autoInstall });
    else void updates.check();
  });

  const { prepareQuit, confirmQuit } = registerQuitFlow({
    app,
    dialog,
    BrowserWindow,
    ipcMain,
    runtime,
    notifier,
    floating,
    createQuitHandler,
    computersLane: () => computersLane,
    setQuitting: (value) => {
      quitting = value;
    },
  });
}
void startDesktop().catch((error) => {
  console.error("Milagre could not start:", error);
  void app.whenReady().then(() => {
    dialog.showErrorBox("Milagre could not start", error.message);
    app.quit();
  });
});
