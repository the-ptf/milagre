// @ts-check

/**
 * MILAGRE_BACKGROUND=1: a test copy of the app that never comes on screen. Agents and checks drive it over CDP while
 * the person at this Mac keeps working: no Dock icon, no window shown or focused, no notification, badge, dialog,
 * menu or browser tab. Windows still draw while hidden, so Page.captureScreenshot returns the real UI.
 */

/** @param {NodeJS.ProcessEnv} env */
function isBackground(env) {
  return /^(1|true|yes)$/i.test(String(env.MILAGRE_BACKGROUND ?? "").trim());
}

/**
 * Every window stays hidden and keeps drawing: created hidden, painted while hidden, never throttled, and every way of
 * showing or focusing it does nothing. Each is a real BrowserWindow with those methods replaced: Electron's
 * BrowserWindow.getAllWindows() leaves out instances of a subclass, and main.cjs sends the host's events through it.
 * @template {typeof Electron.BrowserWindow} T
 * @param {T} BrowserWindow
 * @returns {T}
 */
function hiddenWindows(BrowserWindow) {
  /** @param {Electron.BrowserWindowConstructorOptions} [options] */
  function HiddenBrowserWindow(options = {}) {
    const window = new BrowserWindow(hiddenWindowOptions(options));
    for (const method of ["show", "showInactive", "focus", "moveTop"]) Object.defineProperty(window, method, { value: () => {}, configurable: true });
    return window;
  }
  // Statics (getAllWindows, fromWebContents) and instanceof stay Electron's.
  Object.setPrototypeOf(HiddenBrowserWindow, BrowserWindow);
  HiddenBrowserWindow.prototype = BrowserWindow.prototype;
  return /** @type {T} */ (/** @type {unknown} */ (HiddenBrowserWindow));
}

/** @param {Electron.BrowserWindowConstructorOptions} options @returns {Electron.BrowserWindowConstructorOptions} */
function hiddenWindowOptions(options) {
  return { ...options, show: false, paintWhenInitiallyHidden: true, webPreferences: { ...options.webPreferences, backgroundThrottling: false } };
}

/**
 * The parts of `electron` main.cjs uses that can put something on screen, made quiet when `enabled`.
 * @param {{
 *   enabled: boolean;
 *   platform: NodeJS.Platform;
 *   app: Pick<Electron.App, "setActivationPolicy" | "focus"> & { dock?: Pick<Electron.Dock, "hide" | "setBadge" | "setIcon"> };
 *   BrowserWindow: typeof Electron.BrowserWindow;
 *   shell: Pick<Electron.Shell, "openExternal" | "openPath" | "showItemInFolder">;
 *   dialog: Pick<Electron.Dialog, "showErrorBox" | "showMessageBox" | "showOpenDialog" | "showSaveDialog">;
 *   log?: (message: string) => void;
 * }} options
 */
function createBackgroundMode({ enabled, platform, app, BrowserWindow, shell, dialog, log = (message) => console.log(message) }) {
  const skipped = (what) => log(`MILAGRE_BACKGROUND: skipped ${what}`);
  return {
    enabled,
    /** On macOS an accessory app has no Dock icon or menu bar and is never activated. Call before the first window. */
    start() {
      if (!enabled || platform !== "darwin") return;
      app.setActivationPolicy("accessory");
      app.dock?.hide();
    },
    BrowserWindow: enabled ? hiddenWindows(BrowserWindow) : BrowserWindow,
    /** @type {typeof shell} */
    shell: enabled
      ? {
          openExternal: async (url) => skipped(`opening ${url}`),
          openPath: async (target) => {
            skipped(`opening ${target}`);
            return "";
          },
          showItemInFolder: (target) => skipped(`revealing ${target}`),
        }
      : shell,
    /** @type {typeof dialog} */
    dialog: enabled
      ? {
          showErrorBox: (title, content) => console.error(`${title}: ${content}`),
          // Every dialog answers as if cancelled.
          showMessageBox: /** @type {any} */ (
            async (/** @type {any} */ first, /** @type {any} */ second) => {
              const options = second ?? first;
              skipped(`dialog "${options?.message}"`);
              return { response: options?.cancelId ?? 0, checkboxChecked: false };
            }
          ),
          showOpenDialog: /** @type {any} */ (async () => ({ canceled: true, filePaths: [] })),
          showSaveDialog: /** @type {any} */ (async () => ({ canceled: true, filePath: "" })),
        }
      : dialog,
    /**
     * An editor app comes to the front when it opens a file, so in background the request only gets logged.
     * @template {(request: any, options: any) => Promise<string | null>} T
     * @param {T} open
     * @returns {T}
     */
    editorOpener: (open) =>
      enabled ? /** @type {T} */ (/** @type {unknown} */ (async (request) => (skipped(`opening ${request?.path ?? request?.root} in an editor`), null))) : open,
    /** Brings the app to the front; in background it stays behind. */
    focusApp() {
      if (!enabled && platform === "darwin") app.focus({ steal: true });
    },
    /** Notifications, the Dock badge and context menus only outside background. */
    notifications: (supported) => !enabled && supported,
    setBadge(value) {
      if (!enabled) app.dock?.setBadge(value);
    },
    setDockIcon(icon) {
      if (!enabled) app.dock?.setIcon(icon);
    },
    menus: !enabled,
  };
}

module.exports = { isBackground, hiddenWindowOptions, hiddenWindows, createBackgroundMode };
