// @ts-check
// The Browser panel's pages are <webview> guests of the main window. They show any web page, so each is locked down
// before it attaches: no preload, no Node, sandboxed, one sign-in session for every page, and web pages only. A page
// that opens a window gets a new panel tab instead; one that leaves the web (mailto:, an app's own scheme) goes through
// the same external handler as links in replies.
const { webContents } = require("electron");
const { isAppShortcut, isSettingsKey } = require("./app-shortcuts.cjs");

/** The one persistent session every Browser panel page shares, so signing in once lasts. */
const BROWSER_PARTITION = "persist:milagre-browser";

const PAGE_PROTOCOLS = new Set(["http:", "https:"]);

/** Whether a guest may show this URL: web pages, and the blank page a new tab starts on. */
function isPageUrl(url) {
  if (url === "about:blank") return true;
  try {
    return PAGE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// What a page may ask for. Everything else (camera, microphone, location, notifications, MIDI, USB, HID, serial) is
// refused: a page in the panel is a page the agent is building, not an app the user installed.
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock"]);

/**
 * Locks down the window's <webview> guests and wires each page to the window's renderer: a new window becomes a tab
 * ("browser-panel:open-tab"), and the app's shortcuts, ⌘L and ⌘R pressed in a page reach the renderer as if pressed
 * there ("app:shortcut", "browser-panel:key").
 * @param {Electron.WebContents} host The main window's webContents.
 * @param {{ session: Electron.Session; openExternal: (url: string) => void; platform?: NodeJS.Platform }} options
 */
function hardenBrowserGuests(host, { session, openExternal, platform = process.platform }) {
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
  host.on("will-attach-webview", (event, webPreferences, params) => {
    if (params.partition !== BROWSER_PARTITION || !isPageUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.webviewTag = false;
  });
  host.on("did-attach-webview", (_event, guest) => guardGuest(host, guest, { openExternal, platform }));
}

/**
 * @param {Electron.WebContents} host
 * @param {Electron.WebContents} guest
 * @param {{ openExternal: (url: string) => void; platform: NodeJS.Platform }} options
 */
function guardGuest(host, guest, { openExternal, platform }) {
  const leave = (url) => {
    if (/^mailto:/i.test(url)) openExternal(url);
  };
  guest.setWindowOpenHandler(({ url }) => {
    if (isPageUrl(url) && url !== "about:blank") host.send("browser-panel:open-tab", { from: guest.id, url });
    else leave(url);
    return { action: "deny" };
  });
  const stay = (event, url) => {
    if (isPageUrl(url)) return;
    event.preventDefault();
    leave(url);
  };
  guest.on("will-navigate", (event, url) => stay(event, url));
  guest.on("will-redirect", (event, url) => stay(event, url));
  // Frames inside the page may load what the web allows (about:srcdoc, data:, blob:), but never a file or app scheme.
  guest.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && /^(file|chrome|devtools|milagre[\w-]*):/i.test(event.url)) event.preventDefault();
  });
  guest.on("before-input-event", (event, input) => {
    if (isSettingsKey(input, platform)) {
      event.preventDefault();
      host.send("app:shortcut", { key: ",", shift: false });
      return;
    }
    if (isAppShortcut(input, platform)) {
      event.preventDefault();
      host.send("app:shortcut", { key: input.key.toLowerCase(), shift: true });
      return;
    }
    const command = platform === "darwin" ? input.meta : input.control;
    const key = input.key.toLowerCase();
    if (input.type !== "keyDown" || !command || input.alt || input.shift) return;
    // ⌘L to the address bar, ⌘R reloads, ⌘W closes the tab: what a browser does with them, not what the window does.
    if (key === "l" || key === "r" || key === "w") {
      event.preventDefault();
      host.send("browser-panel:key", { from: guest.id, key });
    }
  });
}

/**
 * A PNG of part of one of `host`'s own pages (a picked element, for a page comment), at most 800 pixels wide; null for
 * another window's page or any other webContents.
 * @param {Electron.WebContents} host
 * @param {unknown} contentsId
 * @param {unknown} rect
 */
async function captureBrowserPage(host, contentsId, rect) {
  const guest = Number.isSafeInteger(contentsId) ? webContents.fromId(/** @type {number} */ (contentsId)) : undefined;
  if (!guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== host) return null;
  const area = /** @type {Record<string, unknown>} */ (rect && typeof rect === "object" ? rect : {});
  const x = Math.round(Number(area.x)),
    y = Math.round(Number(area.y)),
    width = Math.round(Number(area.width)),
    height = Math.round(Number(area.height));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  const image = await guest.capturePage({ x: Math.max(0, x), y: Math.max(0, y), width: Math.min(width, 4000), height: Math.min(height, 4000) });
  if (image.isEmpty()) return null;
  return (image.getSize().width > 800 ? image.resize({ width: 800 }) : image).toDataURL();
}

module.exports = { BROWSER_PARTITION, captureBrowserPage, hardenBrowserGuests, isPageUrl };
