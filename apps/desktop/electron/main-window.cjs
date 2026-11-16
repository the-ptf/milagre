const path = require("node:path");

function createMainWindow({
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
  mainWindow,
  setMainWindow,
  isQuitting,
  confirmQuit,
}) {
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
    icon: appIconFile(publicDir, appIcon.get()),
    backgroundColor: OPAQUE_BACKGROUND,
    ...chrome.options,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      additionalArguments: [
        `--milagre-window-controls=${chrome.controls}`,
        `--milagre-opened-projects-before=${hasOpenedProjectsBefore() ? 1 : 0}`,
        `--milagre-simple-intro=${simpleIntro ? 1 : 0}`,
      ],
    },
  });
  setMainWindow(window);
  window.on("closed", () => {
    if (mainWindow() === window) setMainWindow(null);
  });
  manageWindowState(window, statePath);

  window.on("close", (event) => {
    if (isQuitting() || (process.platform !== "darwin" && !floating.isEnabled())) return;
    event.preventDefault();
    if (window.isFullScreen()) {
      window.once("leave-full-screen", () => window.hide());
      window.setFullScreen(false);
    } else {
      window.hide();
    }
  });
  guardNavigation(window.webContents, { appUrl, openExternal: (url) => shell.openExternal(url).catch(() => {}) });
  hardenBrowserGuests(window.webContents, {
    session: electronSession.fromPartition(BROWSER_PARTITION),
    openExternal: (url) => shell.openExternal(url).catch(() => {}),
    remoteReady: remoteBrowserSessions.isReady,
  });
  forwardAppShortcuts(window.webContents, process.platform, electronIpcMain, () => void confirmQuit(window));
  if (!app.isPackaged) {
    window.loadURL(appUrl);
  } else {
    window.loadFile(indexFile);
  }
}

module.exports = { createMainWindow };
