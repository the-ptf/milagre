// @ts-check
const { createQuitHandler } = require("./quit.cjs");
const { createEditorOpener } = require("./editor-open.cjs");
const {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  protocol,
  safeStorage,
  powerMonitor,
  net,
  screen,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { connectDesktopRuntime } = require("./daemon-runtime.cjs");
const { loadLoginEnvironment } = require("@milagre/core/agents/environment");
const { detectEditors, openInEditor, requireWorktreeRoot } = require("@milagre/core/editors");
const { copyImage, saveImage } = require("./generated-images.cjs");
const { revealFolder } = require("./reveal.cjs");
const { applyWindowBackground, OPAQUE_BACKGROUND } = require("./window-background.cjs");
const { guardNavigation } = require("./links.cjs");
const { forwardAppShortcuts } = require("./app-shortcuts.cjs");
const { windowChrome } = require("./window-chrome.cjs");
const { AttentionNotifier } = require("./notifications.cjs");
const { createDeviceNotices } = require("./device-notices.cjs");
const { createMediaHandler } = require("./media.cjs");
protocol.registerSchemesAsPrivileged([
  { scheme: "milagre-artifact", privileges: { standard: true, secure: true } },
  { scheme: "milagre-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
async function startDesktop() {
  /** @type {Electron.BrowserWindow | null} */
  let mainWindow = null;
  const indexFile = path.join(__dirname, "../dist/index.html");
  const appUrl = app.isPackaged ? pathToFileURL(indexFile).href : process.env.MILAGRE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const { createFloatingInbox } = require("./floating-inbox.cjs");
  await app.whenReady();
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
  const previews = require("./artifact-preview.cjs").createArtifactPreviews();
  const previewOwners = new Set();
  ipcMain.handle("artifact-preview:register", (event, html) => {
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
    return previews.register(owner, html);
  });
  ipcMain.handle("artifact-preview:release", (event, url) => {
    if (event.senderFrame === event.sender.mainFrame) previews.release(event.sender.id, url);
  });
  protocol.handle("milagre-artifact", (request) => previews.handle(request));
  const appIconPath = path.join(__dirname, "../app/public/logo-milagre-image.png");
  const { createReleaseChannelStore, prepareUpdater } = require("./release-channel.cjs");
  const { createAppUpdates, watchAppUpdates } = require("./app-updates.cjs");
  const releaseChannel = createReleaseChannelStore({ file: path.join(app.getPath("userData"), "release-channel.json") });
  const updates = createAppUpdates({
    updater: autoUpdater,
    enabled: app.isPackaged,
    prepare: () => prepareUpdater(autoUpdater, releaseChannel.get()),
    stopHost: async () => {
      await runtime.close({ stopHost: true });
      await prepareQuit();
    },
    publish: (state) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("update:state", state);
    },
  });
  ipcMain.handle("update:state", () => updates.get());
  ipcMain.handle("update:check", () => updates.check(true));
  ipcMain.handle("update:channel", () => releaseChannel.get());
  // Save immediately; an existing download belongs to its original channel until installed.
  ipcMain.handle("update:set-channel", async (_event, channel) => {
    const next = releaseChannel.set(channel);
    if (updates.get().status === "checking") await updates.check();
    void updates.check(true);
    return next;
  });
  ipcMain.handle("update:install", () => updates.install());

  // A project or worktree folder in the file manager; only a checkout's top folder opens (see reveal.cjs).
  ipcMain.handle("project:reveal", (_event, folder) =>
    revealFolder(folder, {
      checkRoot: async (root) => {
        await checkEditorRoot(root);
      },
      open: (target) => shell.openPath(target),
    }),
  );

  // An image in a chat, generated or attached: copied to the clipboard, saved where the user picks, or either from its right-click menu (see generated-images.cjs).
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
  ipcMain.handle("image:copy", (_event, file) => copyImageFile(file));
  ipcMain.handle("image:save", (event, file, name) => saveImageFile(event, file, name));
  ipcMain.handle("image:menu", (event, file, name) => {
    Menu.buildFromTemplate([
      { label: "Copy Image", click: () => void copyImageFile(file).catch(() => {}) },
      { label: "Save Image…", click: () => void saveImageFile(event, file, name).catch(() => {}) },
    ]).popup({ window: BrowserWindow.fromWebContents(event.sender) ?? undefined });
  });

  // Installed editors are looked up once per run.
  /** @type {Promise<import("@milagre/core/editors").DetectedEditor[]> | null} */
  let editorsFound = null;
  // Looked up after the login shell filled in PATH, so CLIs from a Finder launch are found.
  // A failed lookup is not kept, so the next call looks again.
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
      return requireWorktreeRoot(root);
    }
  }
  const openEditor = createEditorOpener({ editors, open: openInEditor, checkRoot: checkEditorRoot });
  ipcMain.handle("editor:open", (_event, request) => openEditor(request));
  // Settings > Skills opens or reveals a SKILL.md wherever it lives (~/.claude/skills is no checkout), but only a file the
  // Project's skill catalog lists, so the renderer can't name any other file.
  async function checkSkillFile(projectPath, file) {
    const { skills, shadowed = [] } = /** @type {import("@milagre/shared/model").SkillCatalog} */ (await runtime.invoke("skills:list", [projectPath]));
    if (typeof file !== "string" || ![...skills, ...shadowed].some((skill) => skill.path === file))
      throw new Error("That skill is no longer there. Reload the list.");
  }
  const openSkillFile = createEditorOpener({ editors, open: openInEditor, checkRoot: async () => {} });
  ipcMain.handle("skills:open", async (_event, { projectPath, file, editor } = {}) => {
    await checkSkillFile(projectPath, file);
    return openSkillFile({ root: path.dirname(file), path: path.basename(file), editor });
  });
  ipcMain.handle("skills:reveal", async (_event, projectPath, file) => {
    await checkSkillFile(projectPath, file);
    shell.showItemInFolder(file);
  });

  // Brings the window back from a notification click and tells it what to open.
  function openFromNotification(channel, ...args) {
    const window = mainWindow;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    if (process.platform === "darwin") app.focus({ steal: true });
    window.focus();
    window.webContents.send(channel, ...args);
  }
  const openChatFromNotification = (chatId) => openFromNotification("notification:open-chat", chatId);

  const notifier = new AttentionNotifier({
    createNotification: ({ title, subtitle, body }) => new Notification({ title, body, ...(subtitle ? { subtitle } : {}) }),
    isAppFocused: () => Boolean(mainWindow?.isFocused()),
    openChat: openChatFromNotification,
    openPhoneSettings: () => openFromNotification("notification:open-phone-settings"),
    setBadge: (value) => app.dock?.setBadge(value),
  });

  // The window reports the "Notify when waiting" setting, kept with its other settings.
  let notifyWhenWaiting = true;
  ipcMain.handle("settings:notify-when-waiting", (_event, on) => {
    notifyWhenWaiting = on === true;
  });

  ipcMain.handle("notification:state", (_event, state) => notifier.sync(state));
  ipcMain.handle("notification:completed", (_event, notice) => (Notification.isSupported() ? notifier.notifyCompletion(notice) : false));

  // The theme's page color, pushed by the renderer whenever its theme resolves.
  ipcMain.handle("settings:window-background", (event, background) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) applyWindowBackground(window, background);
  });

  let connectionState = { connected: true };
  ipcMain.handle("runtime:connection", () => connectionState);
  let runtime;
  // Phones that paired while Milagre was closed are announced once it connects; the host keeps them until then.
  const deviceNotices = createDeviceNotices({
    methods: () => (runtime && Notification.isSupported() ? runtime.hostMethods() : null),
    invoke: (method, args) => runtime.invoke(method, args),
    notifyPhones: (phones, options) => notifier.notifyPhonesPaired(phones, options),
    notifyDevice: (kind) => notifier.notifyDevicePaired(kind),
  });
  const { createLinearSignInWindow } = require("./linear-sign-in-window.cjs");
  // Closing the sign-in window before it finished ends the waiting sign-in, so Settings stops saying it is waiting.
  const linearSignIn = createLinearSignInWindow({ BrowserWindow, shell, cancel: () => void runtime?.invoke("linear:cancel", []).catch(() => {}) });
  let signInRequested = false;
  let signInAttempt = 0; // only the newest connect may close or finish the window
  try {
    runtime = await connectDesktopRuntime({
      dataDir: app.getPath("userData"),
      version: app.getVersion(),
      cwd: process.cwd(),
      worktreeRoot: !app.isPackaged ? process.env.MILAGRE_WORKTREE_ROOT : undefined,
      emit(channel, payload) {
        if (channel === "agent:event") notifier.observe(payload.chatId, payload.event);
        if (channel === "notification:waiting" && notifyWhenWaiting && Notification.isSupported()) notifier.notify(payload);
        if (channel === "phone:paired") void deviceNotices.paired(payload);
        if (channel === "devices:pending" && Notification.isSupported()) notifier.notifyComputerWaiting(payload?.requests);
        if (channel === "runtime:connection") {
          connectionState = payload;
          // A host started again after it went away can be newer, with more commands. (Not yet set during the first connect.)
          if (payload.connected && runtime) {
            registerHostMethods();
            void deviceNotices.connected();
          }
        }
        // Add workspace's sign-in opens in a window of its own, and only when this window asked for one.
        if (channel === "linear:sign-in-window") {
          if (signInRequested) linearSignIn.open(payload?.url);
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
      app.quit();
    });
    return;
  }
  const environmentReady = loadLoginEnvironment();
  // The host's commands. A restarted host can bring more (an older one lacked some), so this runs again after a restart.
  const registered = new Set(["app:version"]);
  function registerHostMethods() {
    for (const method of runtime.methods) {
      if (registered.has(method)) continue;
      registered.add(method);
      ipcMain.handle(method, (event, ...args) => {
        if (method === "linear:connect") {
          // A newer sign-in replaces a waiting one, and its window with it.
          linearSignIn.close();
          signInRequested = args[0]?.window === true;
          signInAttempt++;
        }
        const answer = runtime.invoke(method, args);
        if (method === "linear:connect") {
          const attempt = signInAttempt;
          const newest = () => attempt === signInAttempt;
          void answer.then(
            () => {
              if (newest()) linearSignIn.finish();
              bringBack(event.sender);
            },
            () => {
              if (newest()) linearSignIn.close();
            },
          );
        }
        return answer;
      });
    }
  }
  // A Linear sign-in in the browser ends in a tab that can't close itself, so the window that started it comes back to the front.
  function bringBack(contents) {
    const window = BrowserWindow.fromWebContents(contents);
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    if (process.platform === "darwin") app.focus({ steal: true });
    window.focus();
  }
  registerHostMethods();
  ipcMain.handle("app:version", () => app.getVersion());

  // Other Macs this window drives (Settings › Experimental › Other computers): nothing connects until the window turns
  // the switch on (computers:set-enabled), which it does at launch when it is on.
  const { createComputers } = require("./computers.cjs");
  const { registerComputers } = require("./computers-ipc.cjs");
  const { readOwnHostId } = require("./own-host.cjs");
  const { computerName } = require("@milagre/daemon/mobile-pairing");
  /** @type {string | null} */
  let thisMacName = null;
  /** @type {ReturnType<typeof registerComputers> | null} */
  let computersIpc = null;
  const computers = createComputers({
    dataDir: app.getPath("userData"),
    safeStorage,
    ownHostId: () => readOwnHostId(app.getPath("userData")),
    onChange: () => computersIpc?.changed(),
    emit: (id, channel, payload) => computersIpc?.event(id, channel, payload),
  });
  const { createComputerCaches } = require("./computer-cache.cjs");
  const computerCaches = createComputerCaches({ dir: path.join(app.getPath("userData"), "computers") });
  computersIpc = registerComputers({
    ipcMain,
    computers,
    cache: computerCaches,
    // A computer's chats notify like this Mac's; its turns tell the notifier what completed.
    onRemoteEvent: (_id, channel, payload) => {
      if (channel === "agent:event") notifier.observe(payload.chatId, payload.event);
      if (channel === "notification:waiting" && notifyWhenWaiting && Notification.isSupported()) {
        notifier.notify(payload);
      }
    },
    onForget: (id) => notifier.forgetComputer(id),
    thisMac: () => (thisMacName ??= computerName()),
    send: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
    },
  });
  ipcMain.handle("floating-inbox:snapshot", async () => {
    const local = await runtime.invoke("chat:inbox", []);
    const { qualifyResult } = require("./computer-routing.cjs");
    const remote = await Promise.all(
      computers
        .list()
        .filter((computer) => computer.state === "online")
        .map(async (computer) => {
          try {
            const snapshot = qualifyResult(computer.id, "chat:inbox", await computers.invoke(computer.id, "chat:inbox", []));
            const label = (item) => ({ ...item, computer: computer.name });
            return { agents: snapshot.agents.map(label), items: snapshot.items.map(label) };
          } catch {
            return { agents: [], items: [] };
          }
        }),
    );
    return { agents: [...local.agents, ...remote.flatMap((value) => value.agents)], items: [...local.items, ...remote.flatMap((value) => value.items)] };
  });
  // An older host can't load very large Projects; the window offers to replace it with this desktop's own.
  ipcMain.handle("runtime:restart-host", async () => {
    await runtime.restartHost();
    registerHostMethods();
  });
  ipcMain.handle("project:open", async () => {
    const result = await dialog.showOpenDialog({ title: "Open project", properties: ["openDirectory", "createDirectory"] });
    return result.canceled || !result.filePaths[0] ? null : runtime.openProject(result.filePaths[0]);
  });
  // This Mac's side of openProjectAt; a paired computer's goes through computers:invoke as project:open.
  ipcMain.handle("project:open-at", (_event, folder) => runtime.openProject(String(folder)));
  const { getWindowState, manageWindowState } = require("./window-state.cjs");
  function createWindow() {
    const { state, statePath } = getWindowState();
    const chrome = windowChrome(process.platform, app.commandLine.getSwitchValue("window-decoration") === "overlay");
    const window = new BrowserWindow({
      width: state.width,
      height: state.height,
      x: state.x,
      y: state.y,
      minWidth: 980,
      minHeight: 680,
      title: "Milagre",
      icon: appIconPath,
      backgroundColor: OPAQUE_BACKGROUND,
      ...chrome.options,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [`--milagre-window-controls=${chrome.controls}`],
      },
    });
    mainWindow = window;
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
    manageWindowState(window, statePath);

    // Keep the renderer ready for dock actions on every platform while the floating inbox is enabled.
    window.on("close", (event) => {
      if (quitting || (process.platform !== "darwin" && !floating.isEnabled())) return;
      event.preventDefault();
      // A full-screen window hidden as is leaves a black space behind.
      if (window.isFullScreen()) {
        window.once("leave-full-screen", () => window.hide());
        window.setFullScreen(false);
      } else {
        window.hide();
      }
    });
    guardNavigation(window.webContents, { appUrl, openExternal: (url) => shell.openExternal(url).catch(() => {}) });
    forwardAppShortcuts(window.webContents);
    // A reload keeps every turn running: the main process saves them, and the renderer takes the
    // turns streaming now, with their approval and question cards, from "chat:runs".
    if (!app.isPackaged) {
      window.loadURL(appUrl);
    } else {
      window.loadFile(indexFile);
    }
  }

  app.whenReady().then(async () => {
    protocol.handle(
      "milagre-media",
      createMediaHandler((url, options) => net.fetch(url, options)),
    );
    app.setName("Milagre");
    if (process.platform === "darwin" && app.dock) {
      const appIcon = nativeImage.createFromPath(appIconPath);
      if (!appIcon.isEmpty()) app.dock.setIcon(appIcon);
    }
    createWindow();
    void runtime.resumeRecentProjects().catch((error) => console.warn(error.message));
    void deviceNotices.connected();
    app.on("browser-window-focus", (_event, window) => {
      if (floating.owns(window)) return;
      void runtime.setFocused(true).catch(() => {});
      computers.setFocused(true);
    });
    app.on("browser-window-blur", (_event, window) => {
      if (floating.owns(window)) return;
      void runtime.setFocused(false).catch(() => {});
      computers.setFocused(false);
    });
    if (app.isPackaged) watchAppUpdates(updates, { app, powerMonitor });
    else void updates.check();
    app.on("activate", () => {
      if (floating.owns(BrowserWindow.getFocusedWindow())) return;
      const window = mainWindow;
      if (window) window.show();
      else createWindow();
    });
  });

  // Only a quit closes the last window on macOS; elsewhere closing it quits.
  app.on("window-all-closed", () => {
    // A quit Electron started for a termination signal can end here, windows closed and the app still running.
    if (process.platform !== "darwin" || quitReady) app.quit();
  });

  // Flushes accepted changes and disconnects desktop. The host and agents keep running.
  let quitting = false;
  /** @type {Promise<void> | null} */
  let quitPrepared = null;
  function prepareQuit() {
    quitting = true;
    quitPrepared ??= (async () => {
      notifier.closeAll();
      floating.dispose();
      // Each computer's channels close too; nothing on the other Macs stops.
      try {
        await Promise.all([runtime.close(), computers.close()]);
      } finally {
        computerCaches.close();
      }
    })().catch((error) => {
      quitPrepared = null;
      quitting = false;
      throw error;
    });
    return quitPrepared;
  }

  let quitReady = false;
  const attemptQuit = createQuitHandler({
    prepare: prepareQuit,
    quit: () => {
      quitReady = true;
      app.quit();
    },
    failed: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.show();
          window.webContents.send("app:quit-failed", message);
        }
      }
    },
  });
  ipcMain.handle("app:retry-quit", () => {
    app.quit();
  });
  app.on("before-quit", (event) => {
    quitting = true;
    if (quitReady) return;
    event.preventDefault();
    void attemptQuit();
  });
}
void startDesktop().catch((error) => {
  console.error("Milagre could not start:", error);
  void app.whenReady().then(() => {
    dialog.showErrorBox("Milagre could not start", error.message);
    app.quit();
  });
});
