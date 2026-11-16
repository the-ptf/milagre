// @ts-check
const { webContents } = require("electron");
const { isAppShortcut } = require("./app-shortcuts.cjs");

const BROWSER_PARTITION = "persist:milagre-browser";

const PAGE_PROTOCOLS = new Set(["http:", "https:"]);

function isPageUrl(url) {
  if (url === "about:blank") return true;
  try {
    return PAGE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock"]);

// A two-finger swipe sideways goes back or forward, as in Chrome and Safari. Chromium does that by overscroll, which a
const SWIPE_DISTANCE = 120;
const SWIPE_GAP_MS = 250;
const SWIPE_WORLD = 1201;

/**
 * @param {number} distance
 * @param {number} gap
 */
function swipeTracker(distance, gap) {
  let gesture = { dx: 0, dy: 0, at: -Infinity, over: false };
  /** @param {{ dx: number; dy: number; time: number; pageScrolls: boolean }} wheel */
  return ({ dx, dy, time, pageScrolls }) => {
    if (time - gesture.at > gap) gesture = { dx: 0, dy: 0, at: time, over: false };
    gesture.at = time;
    if (gesture.over) return null;
    if (pageScrolls) {
      gesture.over = true;
      return null;
    }
    gesture.dx += dx;
    gesture.dy += dy;
    if (Math.abs(gesture.dx) < distance || Math.abs(gesture.dx) < 2 * Math.abs(gesture.dy)) return null;
    gesture.over = true;
    return gesture.dx < 0 ? "back" : "forward";
  };
}

const SWIPE_SCRIPT = `(() => {
  const step = (${swipeTracker})(${SWIPE_DISTANCE}, ${SWIPE_GAP_MS});
  const scrolls = (node, dx) => {
    for (let el = node instanceof Element ? node : null; el; el = el.parentElement) {
      const root = el === document.scrollingElement;
      if (!root && !/auto|scroll|overlay/.test(getComputedStyle(el).overflowX)) continue;
      if (el.scrollWidth <= el.clientWidth) continue;
      if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    }
    return false;
  };
  addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.defaultPrevented || event.deltaMode !== 0) return;
    const pageScrolls = Math.abs(event.deltaX) > Math.abs(event.deltaY) && scrolls(event.target, event.deltaX);
    const go = step({ dx: event.deltaX, dy: event.deltaY, time: event.timeStamp, pageScrolls });
    if (go === "back") history.back();
    else if (go === "forward") history.forward();
  }, { passive: true });
})()`;

function hardenBrowserSession(session) {
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

/**
 * Locks down the window's <webview> guests and wires each page to the window's renderer: a new window becomes a tab
 * ("browser-panel:open-tab"), and the app's shortcuts, ⌘L and ⌘R pressed in a page reach the renderer as if pressed
 * there ("app:shortcut", "browser-panel:key").
 * A page of a Chat on another computer attaches in that Chat's own session, once `remoteReady` says its proxy is set
 * (browser-remote-sessions.cjs); every other page in the shared one.
 * @param {Electron.WebContents} host The main window's webContents.
 * @param {{ session: Electron.Session; openExternal: (url: string) => void; platform?: NodeJS.Platform; remoteReady?: (partition: string | undefined) => boolean }} options
 */
function hardenBrowserGuests(host, { session, openExternal, platform = process.platform, remoteReady = () => false }) {
  hardenBrowserSession(session);
  host.on("will-attach-webview", (event, webPreferences, params) => {
    const partition = params.partition === BROWSER_PARTITION || remoteReady(params.partition) ? params.partition : null;
    if (!partition || !isPageUrl(params.src)) {
      event.preventDefault();
      return;
    }
    webPreferences.partition = partition;
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.webviewTag = false;
    webPreferences.transparent = false;
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
  guest.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && /^(file|chrome|devtools|milagre[\w-]*):/i.test(event.url)) event.preventDefault();
  });
  guest.on("dom-ready", () => void guest.executeJavaScriptInIsolatedWorld(SWIPE_WORLD, [{ code: SWIPE_SCRIPT }]).catch(() => {}));
  guest.on("before-input-event", (event, input) => {
    if (isAppShortcut(input, platform)) {
      event.preventDefault();
      host.send("app:shortcut", { key: input.key, code: input.code, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift });
      return;
    }
    const command = platform === "darwin" ? input.meta : input.control;
    const key = input.key.toLowerCase();
    if (input.type !== "keyDown" || !command || input.alt || input.shift) return;
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

module.exports = { BROWSER_PARTITION, captureBrowserPage, hardenBrowserGuests, hardenBrowserSession, isPageUrl, swipeTracker };
